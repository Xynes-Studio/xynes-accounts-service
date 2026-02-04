import { describe, it, expect } from 'bun:test';
import { DomainError } from '@xynes/errors';
import { createListWorkspaceMembersHandler } from './listMembers';

class FakeDb {
  constructor(
    private rows: Array<{
      userId: string;
      email: string;
      displayName: string | null;
      avatarUrl: string | null;
      status: string;
      joinedAt: Date;
    }>,
  ) {}

  select() {
    return {
      from: () => ({
        innerJoin: () => ({
          where: async () => this.rows,
        }),
      }),
    };
  }
}

describe('listWorkspaceMembers handler', () => {
  it('throws when userId is missing', async () => {
    const handler = createListWorkspaceMembersHandler();

    await expect(
      handler({}, { workspaceId: 'w1', userId: null, requestId: 'req-1' }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('throws when workspaceId is missing', async () => {
    const handler = createListWorkspaceMembersHandler();

    await expect(
      handler({}, { workspaceId: null, userId: 'u1', requestId: 'req-1' }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('throws when permission is denied', async () => {
    const handler = createListWorkspaceMembersHandler({
      authzClient: {
        checkPermission: async () => false,
        listRolesForWorkspace: async () => [],
      },
    });

    await expect(
      handler({}, { workspaceId: 'w1', userId: 'u1', requestId: 'req-1' }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('returns members with roles', async () => {
    const rows = [
      {
        userId: 'user-1',
        email: 'ada@xynes.com',
        displayName: 'Ada Lovelace',
        avatarUrl: null,
        status: 'active',
        joinedAt: new Date('2025-01-01'),
      },
      {
        userId: 'user-2',
        email: 'grace@xynes.com',
        displayName: 'Grace Hopper',
        avatarUrl: null,
        status: 'active',
        joinedAt: new Date('2025-01-02'),
      },
    ];
    const handler = createListWorkspaceMembersHandler({
      dbClient: new FakeDb(rows) as unknown as typeof import('../../../infra/db').db,
      authzClient: {
        checkPermission: async () => true,
        listRolesForWorkspace: async () => [
          { userId: 'user-1', roleKey: 'workspace_owner' },
          { userId: 'user-2', roleKey: 'workspace_member' },
        ],
      },
    });

    const result = await handler(
      {},
      {
        workspaceId: 'workspace-1',
        userId: 'user-1',
        requestId: 'req-1',
      },
    );

    expect(result.members).toHaveLength(2);
    expect(result.members[0]).toMatchObject({
      userId: 'user-1',
      roleKey: 'workspace_owner',
    });
  });
});
