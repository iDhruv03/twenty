import { PermissionFlagType } from 'twenty-shared/constants';
import { IsNull } from 'typeorm';

import { ApplicationRegistrationSourceType } from 'src/engine/core-modules/application/application-registration/enums/application-registration-source-type.enum';
import {
  AuthException,
  AuthExceptionCode,
} from 'src/engine/core-modules/auth/auth.exception';
import { isUserAuthContext } from 'src/engine/core-modules/auth/guards/is-user-auth-context.guard';
import { AgentChatInboxAction } from 'src/engine/metadata-modules/ai/ai-chat/enums/agent-chat-inbox-action.enum';
import { AgentChatSharingService } from 'src/engine/metadata-modules/ai/ai-chat/services/agent-chat-sharing.service';
import { AgentChatThreadTriageService } from 'src/engine/metadata-modules/ai/ai-chat/services/agent-chat-thread-triage.service';
import { type AgentInboxCallerAuthContext } from 'src/engine/metadata-modules/ai/ai-chat/types/agent-inbox-caller-auth-context.type';
import { AiExceptionCode } from 'src/engine/metadata-modules/ai/ai.exception';

const WORKSPACE_ID = 'workspace-id';
const THREAD_ID = 'thread-id';
const APPLICATION_ID = 'application-id';
const OAUTH_CLIENT_ID = 'oauth-client-id';
const USER_WORKSPACE_ID = 'user-workspace-id';
const WORKSPACE_MEMBER_ID = 'workspace-member-id';
const AGENT_ID = 'agent-id';

const APPLICATION_AUTH_CONTEXT: AgentInboxCallerAuthContext = {
  type: 'application',
  workspace: { id: WORKSPACE_ID } as never,
  application: { id: APPLICATION_ID } as never,
  agentId: AGENT_ID,
};

const USER_AUTH_CONTEXT: AgentInboxCallerAuthContext = {
  type: 'user',
  workspace: { id: WORKSPACE_ID } as never,
  application: { id: APPLICATION_ID } as never,
  userWorkspaceId: USER_WORKSPACE_ID,
  user: { id: 'user-id' } as never,
  workspaceMemberId: WORKSPACE_MEMBER_ID,
  workspaceMember: { id: WORKSPACE_MEMBER_ID } as never,
  agentId: AGENT_ID,
};

const THREAD = { id: THREAD_ID, channelId: 'channel-id' };

const buildSharingService = () => {
  const refreshedUserAuthContext = {
    ...USER_AUTH_CONTEXT,
    agentId: undefined,
    workspaceMember: {
      id: WORKSPACE_MEMBER_ID,
      name: { firstName: 'Current', lastName: 'Member' },
    },
  };
  const userAuthContextService = {
    resolveWorkspaceMember: jest
      .fn()
      .mockResolvedValue(refreshedUserAuthContext),
  };
  const threadRepository = {
    findOne: jest.fn().mockResolvedValue(THREAD),
  };
  const agentMessageRepository = {
    existsBy: jest.fn().mockResolvedValue(false),
  };
  const permissionsService = {
    userHasWorkspaceSettingPermission: jest.fn().mockResolvedValue(true),
  };
  const permissionRepository = {
    findRecordIdsAllowedForOperation: jest.fn().mockResolvedValue([THREAD_ID]),
  };
  const workspaceOrmManager = {
    executeInWorkspaceContext: jest
      .fn()
      .mockImplementation((operation: () => Promise<void>) => operation()),
    getRepositoryWithContextPermissions: jest
      .fn()
      .mockReturnValue(permissionRepository),
  };

  const service = new AgentChatSharingService(
    threadRepository as never,
    userAuthContextService as never,
    {} as never,
    {} as never,
    {} as never,
    permissionsService as never,
    workspaceOrmManager as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    agentMessageRepository as never,
  );

  return {
    service,
    threadRepository,
    permissionsService,
    permissionRepository,
    workspaceOrmManager,
    userAuthContextService,
    refreshedUserAuthContext,
    agentMessageRepository,
  };
};

describe('AgentChatSharingService caller access', () => {
  it.each([
    {
      caller: 'application',
      authContext: APPLICATION_AUTH_CONTEXT,
      userWorkspaceId: undefined,
    },
    {
      caller: 'application acting for a user',
      authContext: USER_AUTH_CONTEXT,
      userWorkspaceId: USER_WORKSPACE_ID,
    },
  ])(
    'checks $caller permissions in its own context',
    async ({ authContext, userWorkspaceId }) => {
      const {
        service,
        permissionsService,
        permissionRepository,
        workspaceOrmManager,
        userAuthContextService,
        refreshedUserAuthContext,
      } = buildSharingService();

      await expect(
        service.getCallerThreadWithAccess({
          authContext,
          threadId: THREAD_ID,
          operationType: 'update',
        }),
      ).resolves.toBe(THREAD);

      expect(
        permissionsService.userHasWorkspaceSettingPermission,
      ).toHaveBeenCalledWith({
        workspaceId: WORKSPACE_ID,
        userWorkspaceId,
        applicationId: APPLICATION_ID,
        agentId: AGENT_ID,
        setting: PermissionFlagType.AI,
      });
      expect(
        permissionRepository.findRecordIdsAllowedForOperation,
      ).toHaveBeenCalledWith({
        recordIds: [THREAD_ID],
        operationType: 'update',
        withDeleted: true,
      });

      const queryAuthContext =
        workspaceOrmManager.executeInWorkspaceContext.mock.calls[0][1];

      if (isUserAuthContext(authContext)) {
        expect(
          userAuthContextService.resolveWorkspaceMember,
        ).toHaveBeenCalledWith({
          workspaceId: WORKSPACE_ID,
          workspaceMemberId: WORKSPACE_MEMBER_ID,
          applicationId: APPLICATION_ID,
          agentId: AGENT_ID,
        });
        expect(queryAuthContext).toEqual({
          ...refreshedUserAuthContext,
          agentId: AGENT_ID,
        });

        return;
      }

      expect(queryAuthContext).toBe(authContext);
      expect(
        userAuthContextService.resolveWorkspaceMember,
      ).not.toHaveBeenCalled();
    },
  );

  it('keeps the user context for an OAuth client without an application role', async () => {
    const {
      service,
      userAuthContextService,
      refreshedUserAuthContext,
      permissionsService,
      workspaceOrmManager,
    } = buildSharingService();
    const oauthClient = {
      id: OAUTH_CLIENT_ID,
      sourceType: ApplicationRegistrationSourceType.OAUTH_ONLY,
      defaultRoleId: null,
    };
    const oauthUserAuthContext: AgentInboxCallerAuthContext = {
      ...USER_AUTH_CONTEXT,
      application: oauthClient as never,
      agentId: undefined,
    };
    const refreshedOAuthContext = {
      ...refreshedUserAuthContext,
      application: oauthClient,
    };

    userAuthContextService.resolveWorkspaceMember.mockResolvedValue(
      refreshedOAuthContext,
    );

    await expect(
      service.getCallerThreadWithAccess({
        authContext: oauthUserAuthContext,
        threadId: THREAD_ID,
        operationType: 'update',
      }),
    ).resolves.toBe(THREAD);
    expect(userAuthContextService.resolveWorkspaceMember).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      workspaceMemberId: WORKSPACE_MEMBER_ID,
      applicationId: undefined,
      agentId: undefined,
    });
    expect(
      permissionsService.userHasWorkspaceSettingPermission,
    ).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      userWorkspaceId: USER_WORKSPACE_ID,
      applicationId: OAUTH_CLIENT_ID,
      agentId: undefined,
      setting: PermissionFlagType.AI,
    });
    expect(
      workspaceOrmManager.executeInWorkspaceContext.mock.calls[0][1],
    ).toEqual(refreshedOAuthContext);
  });

  it('hides a thread from an application without AI permission', async () => {
    const {
      service,
      permissionsService,
      threadRepository,
      agentMessageRepository,
    } = buildSharingService();

    permissionsService.userHasWorkspaceSettingPermission.mockResolvedValue(
      false,
    );
    agentMessageRepository.existsBy.mockResolvedValue(true);

    await expect(
      service.getCallerThreadWithAccess({
        authContext: APPLICATION_AUTH_CONTEXT,
        threadId: THREAD_ID,
        operationType: 'update',
      }),
    ).rejects.toMatchObject({ code: AiExceptionCode.THREAD_NOT_FOUND });
    expect(threadRepository.findOne).not.toHaveBeenCalled();
    expect(agentMessageRepository.existsBy).not.toHaveBeenCalled();
  });

  it.each(['select', 'update'] as const)(
    'allows a participating application to %s without a role grant',
    async (operationType) => {
      const {
        service,
        agentMessageRepository,
        permissionRepository,
        workspaceOrmManager,
      } = buildSharingService();

      agentMessageRepository.existsBy.mockResolvedValue(true);
      permissionRepository.findRecordIdsAllowedForOperation.mockResolvedValue(
        [],
      );

      await expect(
        service.getCallerThreadWithAccess({
          authContext: APPLICATION_AUTH_CONTEXT,
          threadId: THREAD_ID,
          operationType,
        }),
      ).resolves.toBe(THREAD);
      expect(agentMessageRepository.existsBy).toHaveBeenCalledWith(
        WORKSPACE_ID,
        {
          threadId: THREAD_ID,
          senderApplicationId: APPLICATION_ID,
          senderWorkspaceMemberId: IsNull(),
        },
      );
      expect(
        workspaceOrmManager.executeInWorkspaceContext,
      ).not.toHaveBeenCalled();
    },
  );

  it('denies deleting a thread based only on application participation', async () => {
    const { service, agentMessageRepository, permissionRepository } =
      buildSharingService();

    agentMessageRepository.existsBy.mockResolvedValue(true);
    permissionRepository.findRecordIdsAllowedForOperation.mockResolvedValue([]);

    await expect(
      service.getCallerThreadWithAccess({
        authContext: APPLICATION_AUTH_CONTEXT,
        threadId: THREAD_ID,
        operationType: 'delete',
      }),
    ).rejects.toMatchObject({ code: AiExceptionCode.THREAD_NOT_FOUND });
  });

  it('hides a thread when the acting user is no longer a workspace member', async () => {
    const {
      service,
      userAuthContextService,
      permissionsService,
      threadRepository,
    } = buildSharingService();

    userAuthContextService.resolveWorkspaceMember.mockRejectedValue(
      new AuthException(
        'Workspace member not found',
        AuthExceptionCode.UNAUTHENTICATED,
      ),
    );

    await expect(
      service.getCallerThreadWithAccess({
        authContext: USER_AUTH_CONTEXT,
        threadId: THREAD_ID,
        operationType: 'update',
      }),
    ).rejects.toMatchObject({ code: AiExceptionCode.THREAD_NOT_FOUND });
    expect(
      permissionsService.userHasWorkspaceSettingPermission,
    ).not.toHaveBeenCalled();
    expect(threadRepository.findOne).not.toHaveBeenCalled();
  });

  it.each(['missing', 'inaccessible'])(
    'hides a %s thread from an application',
    async (threadState) => {
      const { service, threadRepository, permissionRepository } =
        buildSharingService();

      threadRepository.findOne.mockResolvedValue(
        threadState === 'missing' ? null : THREAD,
      );
      permissionRepository.findRecordIdsAllowedForOperation.mockResolvedValue(
        [],
      );

      await expect(
        service.getCallerThreadWithAccess({
          authContext: APPLICATION_AUTH_CONTEXT,
          threadId: THREAD_ID,
          operationType: 'update',
        }),
      ).rejects.toMatchObject({ code: AiExceptionCode.THREAD_NOT_FOUND });
    },
  );
});

describe('AgentChatThreadTriageService application caller', () => {
  it('archives the shared copy without changing any member inbox', async () => {
    const threadAfter = {
      ...THREAD,
      channelArchivedAt: '2026-11-02T12:00:00Z',
    };
    const transaction = {
      manager: { query: jest.fn().mockResolvedValue([threadAfter]) },
      table: jest.fn().mockReturnValue('agentChatThread'),
    };
    const threadRepository = {
      query: jest
        .fn()
        .mockImplementation(
          (
            ...[, write]: [
              string,
              (context: typeof transaction) => Promise<void>,
            ]
          ) => write(transaction),
        ),
    };
    const sharingService = {
      getCallerThreadWithAccess: jest.fn().mockResolvedValue(THREAD),
    };
    const participantService = {
      isFollowing: jest.fn(),
      updateInboxState: jest.fn(),
    };
    const threadRecordEventService = { emitThreadsUpdated: jest.fn() };
    const service = new AgentChatThreadTriageService(
      threadRepository as never,
      sharingService as never,
      participantService as never,
      threadRecordEventService as never,
      {} as never,
    );

    await service.applyToChannelCopy({
      authContext: APPLICATION_AUTH_CONTEXT,
      threadId: THREAD_ID,
      change: { action: AgentChatInboxAction.ARCHIVE },
    });

    expect(transaction.manager.query).toHaveBeenCalledWith(expect.any(String), [
      THREAD_ID,
      true,
      null,
      null,
      false,
    ]);
    expect(participantService.isFollowing).not.toHaveBeenCalled();
    expect(participantService.updateInboxState).not.toHaveBeenCalled();
    expect(threadRecordEventService.emitThreadsUpdated).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      threads: [{ before: THREAD, after: threadAfter }],
    });
  });
});
