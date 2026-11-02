import { ApplicationRegistrationSourceType } from 'src/engine/core-modules/application/application-registration/enums/application-registration-source-type.enum';
import {
  AuthException,
  AuthExceptionCode,
} from 'src/engine/core-modules/auth/auth.exception';
import { AgentChatSharingService } from 'src/engine/metadata-modules/ai/ai-chat/services/agent-chat-sharing.service';
import { type AgentInboxCallerAuthContext } from 'src/engine/metadata-modules/ai/ai-chat/types/agent-inbox-caller-auth-context.type';
import { AiExceptionCode } from 'src/engine/metadata-modules/ai/ai.exception';

const OAUTH_USER_AUTH_CONTEXT: AgentInboxCallerAuthContext = {
  type: 'user',
  workspace: { id: 'workspace-id' } as never,
  application: {
    id: 'oauth-client-id',
    sourceType: ApplicationRegistrationSourceType.OAUTH_ONLY,
    defaultRoleId: null,
  } as never,
  userWorkspaceId: 'user-workspace-id',
  user: { id: 'user-id' } as never,
  workspaceMemberId: 'workspace-member-id',
  workspaceMember: { id: 'workspace-member-id' } as never,
};

const buildSharingService = () => {
  const userAuthContextService = {
    resolveWorkspaceMember: jest
      .fn()
      .mockResolvedValue(OAUTH_USER_AUTH_CONTEXT),
  };
  const permissionsService = {
    userHasWorkspaceSettingPermission: jest.fn().mockResolvedValue(true),
  };
  const service = new AgentChatSharingService(
    {} as never,
    userAuthContextService as never,
    {} as never,
    {} as never,
    {} as never,
    permissionsService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  return { service, userAuthContextService };
};

describe('AgentChatSharingService caller authentication', () => {
  it('refreshes an OAuth user without requiring an application role', async () => {
    const { service, userAuthContextService } = buildSharingService();

    await expect(
      service.getCallerAuthContextOrThrow(OAUTH_USER_AUTH_CONTEXT),
    ).resolves.toEqual(OAUTH_USER_AUTH_CONTEXT);
    expect(userAuthContextService.resolveWorkspaceMember).toHaveBeenCalledWith({
      workspaceId: 'workspace-id',
      workspaceMemberId: 'workspace-member-id',
      applicationId: undefined,
      agentId: undefined,
    });
  });

  it('rejects a caller whose workspace membership was revoked', async () => {
    const { service, userAuthContextService } = buildSharingService();

    userAuthContextService.resolveWorkspaceMember.mockRejectedValue(
      new AuthException(
        'Workspace member not found',
        AuthExceptionCode.UNAUTHENTICATED,
      ),
    );

    await expect(
      service.getCallerAuthContextOrThrow(OAUTH_USER_AUTH_CONTEXT),
    ).rejects.toMatchObject({ code: AiExceptionCode.THREAD_NOT_FOUND });
  });
});
