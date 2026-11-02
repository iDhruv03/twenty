import { DataSource, EntityMetadata } from 'typeorm';

import { lockAgentChatChannelForThreadWriteInTestOrThrow } from 'test/integration/ai/utils/lock-agent-chat-channel-for-thread-write-in-test-or-throw.util';

const WORKSPACE_ID = '20202020-0000-4000-8000-000000000001';
const CHANNEL_ID = '20202020-0000-4000-8000-00000000000a';

describe('lockAgentChatChannelForThreadWriteInTestOrThrow', () => {
  it('locks the channel using the entity registered by the application', async () => {
    class AgentChatChannelEntity {}

    const dataSource = new DataSource({ type: 'postgres' });
    const channelMetadata = new EntityMetadata({
      connection: dataSource,
      args: {
        target: AgentChatChannelEntity,
        name: 'agentChatChannel',
        type: 'regular',
      },
    });

    channelMetadata.build();
    dataSource.entityMetadatas.push(channelMetadata);
    dataSource.entityMetadatasMap.set(AgentChatChannelEntity, channelMetadata);

    const manager = dataSource.createEntityManager();

    jest.spyOn(manager, 'query').mockResolvedValue([{ isLocked: true }]);

    const findOne = jest
      .spyOn(manager, 'findOne')
      .mockResolvedValue({ id: CHANNEL_ID });

    await lockAgentChatChannelForThreadWriteInTestOrThrow({
      manager,
      workspaceId: WORKSPACE_ID,
      channelId: CHANNEL_ID,
    });

    expect(findOne).toHaveBeenCalledWith(AgentChatChannelEntity, {
      select: { id: true },
      where: { id: CHANNEL_ID, workspaceId: WORKSPACE_ID },
      lock: { mode: 'for_key_share' },
    });
  });
});
