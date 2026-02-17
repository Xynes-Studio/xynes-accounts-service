import { describe, expect, it, vi, afterEach } from 'bun:test';
import { DomainError } from '@xynes/errors';

import { logger } from '../../../infra/logger';
import { resolveWorkspaceRoleForUser } from './resolveWorkspaceRole';

describe('resolveWorkspaceRoleForUser', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns highest-priority role when multiple assignments exist', async () => {
    const authzClient = {
      listRolesForWorkspace: vi.fn().mockResolvedValue([
        { userId: 'user-1', roleKey: 'workspace_member' },
        { userId: 'user-1', roleKey: 'workspace_admin' },
      ]),
    };

    const role = await resolveWorkspaceRoleForUser(authzClient as any, 'ws-1', 'user-1');

    expect(role).toBe('workspace_admin');
    expect(authzClient.listRolesForWorkspace).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      userIds: ['user-1'],
    });
  });

  it('falls back to workspace_member and logs context on recoverable lookup errors', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const authzClient = {
      listRolesForWorkspace: vi
        .fn()
        .mockRejectedValue(new DomainError('timeout', 'GATEWAY_TIMEOUT', 504)),
    };

    const role = await resolveWorkspaceRoleForUser(authzClient as any, 'ws-2', 'user-2');

    expect(role).toBe('workspace_member');
    expect(warnSpy).toHaveBeenCalledWith(
      '[ResolveWorkspaceRole] Failed to resolve role from authz, using fallback role',
      expect.objectContaining({
        workspaceId: 'ws-2',
        userId: 'user-2',
        fallbackRole: 'workspace_member',
        errorCode: 'GATEWAY_TIMEOUT',
      }),
    );
  });

  it('rethrows critical domain errors', async () => {
    const authzClient = {
      listRolesForWorkspace: vi
        .fn()
        .mockRejectedValue(new DomainError('misconfigured authz', 'INTERNAL_ERROR', 500)),
    };

    await expect(
      resolveWorkspaceRoleForUser(authzClient as any, 'ws-3', 'user-3'),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });
});
