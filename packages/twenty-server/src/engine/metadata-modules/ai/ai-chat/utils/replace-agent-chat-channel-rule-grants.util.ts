import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { isDefined, isNonEmptyArray } from 'twenty-shared/utils';
import { type EntityManager } from 'typeorm';

import { AgentChatChannelRoleEntity } from 'src/engine/metadata-modules/agent-chat-channel/entities/agent-chat-channel-role.entity';
import { AgentChatChannelEntity } from 'src/engine/metadata-modules/agent-chat-channel/entities/agent-chat-channel.entity';
import { ObjectMetadataEntity } from 'src/engine/metadata-modules/object-metadata/object-metadata.entity';
import { RoleEntity } from 'src/engine/metadata-modules/role/role.entity';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

type AgentChatChannelGrantScope =
  | { threadIds: string[] }
  | { channelId: string };

type ChannelRuleGrant = {
  objectMetadataId: string;
  recordId: string;
  principalId: string;
  sourceId: string;
};

const CHANNEL_RULE_GRANT_INSERT_BATCH_SIZE = 1000;

export const replaceAgentChatChannelRuleGrants = async ({
  manager,
  workspaceId,
  scope,
}: {
  manager: Pick<EntityManager, 'createQueryBuilder'>;
  workspaceId: string;
  scope: AgentChatChannelGrantScope;
}): Promise<void> => {
  const schema = getWorkspaceSchemaName(workspaceId);
  const isThreadScope = 'threadIds' in scope;

  if (isThreadScope && !isNonEmptyArray(scope.threadIds)) {
    return;
  }

  const scopeParameters = isThreadScope
    ? { threadIds: scope.threadIds }
    : { channelId: scope.channelId };
  const channelRuleGrantsQuery = manager
    .createQueryBuilder()
    .select('thread_object.id', 'objectMetadataId')
    .addSelect('thread.id', 'recordId')
    .addSelect('workspace_role.id', 'principalId')
    .addSelect('thread."channelId"', 'sourceId')
    .from(`${schema}.agentChatThread`, 'thread')
    .innerJoin(
      AgentChatChannelEntity,
      'channel',
      'channel.id = thread."channelId" AND channel."workspaceId" = :workspaceId',
    )
    .innerJoin(
      ObjectMetadataEntity,
      'thread_object',
      'thread_object."workspaceId" = :workspaceId AND thread_object."universalIdentifier" = :threadObjectUniversalIdentifier',
    )
    .innerJoin(
      RoleEntity,
      'workspace_role',
      'workspace_role."workspaceId" = :workspaceId',
    )
    .leftJoin(
      AgentChatChannelRoleEntity,
      'channel_role',
      'channel_role."workspaceId" = :workspaceId AND channel_role."channelId" = thread."channelId" AND channel_role."roleId" = workspace_role.id',
    )
    .where(
      isThreadScope
        ? 'thread.id = ANY(:threadIds::uuid[])'
        : 'thread."channelId" = :channelId',
      scopeParameters,
    )
    .andWhere(
      '(workspace_role."canAccessAllAgentChatChannels" = true OR channel_role.id IS NOT NULL)',
    )
    .andWhere('thread."channelId" IS NOT NULL')
    .setParameters({
      workspaceId,
      threadObjectUniversalIdentifier:
        STANDARD_OBJECTS.agentChatThread.universalIdentifier,
    });
  const matchingGrantQuery = channelRuleGrantsQuery
    .clone()
    .select('1')
    .andWhere('thread.id = record_share."recordId"')
    .andWhere('thread."channelId" = record_share."sourceId"')
    .andWhere('workspace_role.id = record_share."principalId"')
    .andWhere('record_share."deletedAt" IS NULL');
  const obsoleteGrantIdsQuery = manager
    .createQueryBuilder()
    .select('record_share.id')
    .from(`${schema}.recordShare`, 'record_share')
    .innerJoin(
      ObjectMetadataEntity,
      'thread_object',
      'thread_object."workspaceId" = :workspaceId AND thread_object."universalIdentifier" = :threadObjectUniversalIdentifier AND record_share."objectMetadataId" = thread_object.id',
    )
    .where('record_share."rowCause" = :rowCause', { rowCause: 'RULE' })
    .andWhere(
      isThreadScope
        ? 'record_share."recordId" = ANY(:threadIds::uuid[])'
        : 'record_share."sourceId" = :channelId',
    )
    .andWhere(`NOT EXISTS (${matchingGrantQuery.getQuery()})`)
    .setParameters(matchingGrantQuery.getParameters());

  await manager
    .createQueryBuilder()
    .delete()
    .from(`${schema}.recordShare`)
    .where(`id IN (${obsoleteGrantIdsQuery.getQuery()})`)
    .setParameters(obsoleteGrantIdsQuery.getParameters())
    .execute();

  let lastChannelRuleGrant: ChannelRuleGrant | undefined;

  while (true) {
    const channelRuleGrantBatchQuery = channelRuleGrantsQuery
      .clone()
      .orderBy('thread.id')
      .addOrderBy('workspace_role.id')
      .limit(CHANNEL_RULE_GRANT_INSERT_BATCH_SIZE);

    if (isDefined(lastChannelRuleGrant)) {
      channelRuleGrantBatchQuery.andWhere(
        '(thread.id > :lastThreadId OR (thread.id = :lastThreadId AND workspace_role.id > :lastRoleId))',
        {
          lastThreadId: lastChannelRuleGrant.recordId,
          lastRoleId: lastChannelRuleGrant.principalId,
        },
      );
    }

    const channelRuleGrantBatch =
      await channelRuleGrantBatchQuery.getRawMany<ChannelRuleGrant>();

    if (!isNonEmptyArray(channelRuleGrantBatch)) {
      return;
    }

    await manager
      .createQueryBuilder()
      .insert()
      .into(`${schema}.recordShare`, [
        'objectMetadataId',
        'recordId',
        'principalId',
        'sourceId',
        'principalType',
        'accessLevel',
        'rowCause',
      ])
      .values(
        channelRuleGrantBatch.map(
          ({ objectMetadataId, recordId, principalId, sourceId }) => ({
            objectMetadataId,
            recordId,
            principalId,
            sourceId,
            principalType: 'ROLE',
            accessLevel: 'READ_WRITE',
            rowCause: 'RULE',
          }),
        ),
      )
      .orIgnore()
      .execute();

    lastChannelRuleGrant =
      channelRuleGrantBatch[channelRuleGrantBatch.length - 1];
  }
};
