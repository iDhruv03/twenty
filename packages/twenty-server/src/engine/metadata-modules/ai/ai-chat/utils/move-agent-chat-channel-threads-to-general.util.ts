import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { isDefined, isNonEmptyArray } from 'twenty-shared/utils';
import { type EntityManager } from 'typeorm';

import { AgentChatChannelEntity } from 'src/engine/metadata-modules/agent-chat-channel/entities/agent-chat-channel.entity';
import { acquireAgentChatChannelGrantLocks } from 'src/engine/metadata-modules/ai/ai-chat/utils/acquire-agent-chat-channel-grant-locks.util';
import { replaceAgentChatChannelRuleGrants } from 'src/engine/metadata-modules/ai/ai-chat/utils/replace-agent-chat-channel-rule-grants.util';
import { FieldMetadataEntity } from 'src/engine/metadata-modules/field-metadata/field-metadata.entity';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { STANDARD_AGENT_CHAT_CHANNEL } from 'src/engine/workspace-manager/twenty-standard-application/constants/standard-agent-chat-channel.constant';

export const moveAgentChatChannelThreadsToGeneral = async ({
  manager,
  workspaceId,
  channelId,
}: {
  manager: Pick<
    EntityManager,
    'query' | 'createQueryBuilder' | 'getRepository'
  >;
  workspaceId: string;
  channelId: string;
}): Promise<void> => {
  const hasChannelField = await manager
    .getRepository(FieldMetadataEntity)
    .existsBy({
      workspaceId,
      universalIdentifier:
        STANDARD_OBJECTS.agentChatThread.fields.channelId.universalIdentifier,
    });

  if (!hasChannelField) {
    return;
  }

  const generalChannel = await manager
    .getRepository(AgentChatChannelEntity)
    .findOne({
      select: { id: true },
      where: {
        workspaceId,
        universalIdentifier:
          STANDARD_AGENT_CHAT_CHANNEL.general.universalIdentifier,
      },
    });

  if (!isDefined(generalChannel)) {
    return;
  }

  const movedThreadsResult = await manager
    .createQueryBuilder()
    .update(`${getWorkspaceSchemaName(workspaceId)}.agentChatThread`)
    .set({ channelId: generalChannel.id, updatedAt: () => 'CURRENT_TIMESTAMP' })
    .where('"channelId" = :channelId', { channelId })
    .returning('id')
    .execute();
  const movedThreads = movedThreadsResult.raw as { id: string }[];

  if (!isNonEmptyArray(movedThreads)) {
    return;
  }

  await acquireAgentChatChannelGrantLocks({
    manager,
    workspaceId,
    channelIds: [channelId, generalChannel.id],
    mode: 'shared',
  });

  await replaceAgentChatChannelRuleGrants({
    manager,
    workspaceId,
    scope: { threadIds: movedThreads.map(({ id }) => id) },
  });
};
