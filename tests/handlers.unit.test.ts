import { describe, it, expect } from 'bun:test';

import { createReadSelfUserHandler } from '../src/actions/handlers/readSelfUser';
import { createReadCurrentWorkspaceHandler } from '../src/actions/handlers/readCurrentWorkspace';
import { createEnsureWorkspaceMemberHandler } from '../src/actions/handlers/ensureWorkspaceMember';
import { createMeGetOrCreateHandler } from '../src/actions/handlers/meGetOrCreate';
import { createListWorkspacesForUserHandler } from '../src/actions/handlers/workspaces/listForUser';
import { createCreateWorkspaceHandler } from '../src/actions/handlers/workspaces/create';
import { NotFoundError } from '../src/actions/errors';
import { DomainError } from '@xynes/errors';
import { workspaces, workspaceMembers } from '../src/infra/db/schema';

const ctx = {
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  userId: '550e8400-e29b-41d4-a716-446655440001',
  requestId: 'req-test',
  user: {
    email: 'a@b.com',
    name: 'Alice',
    avatarUrl: 'https://example.com/a.png',
  },
};

describe('Action handlers (unit, DI)', () => {
  it('readSelfUser returns user when present', async () => {
    const dbClient: any = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: ctx.userId, email: 'a@b.com' }],
          }),
        }),
      }),
    };

    const handler = createReadSelfUserHandler({ dbClient });
    const result = await handler({}, ctx);
    expect(result.email).toBe('a@b.com');
  });

  it('readSelfUser throws NotFoundError when absent', async () => {
    const dbClient: any = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    };

    const handler = createReadSelfUserHandler({ dbClient });
    await expect(handler({}, ctx)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('readCurrentWorkspace returns workspace when present', async () => {
    const dbClient: any = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: ctx.workspaceId, name: 'Acme' }],
          }),
        }),
      }),
    };

    const handler = createReadCurrentWorkspaceHandler({ dbClient });
    const result = await handler({}, ctx);
    expect(result.name).toBe('Acme');
  });

  it('ensureWorkspaceMember returns created=false when existing row found', async () => {
    const dbClient: any = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ status: 'active' }],
          }),
        }),
      }),
      insert: () => ({
        values: async () => {
          throw new Error('should not insert');
        },
      }),
    };

    const handler = createEnsureWorkspaceMemberHandler({ dbClient });
    const result = await handler({ role: 'member' }, ctx);
    expect(result).toEqual({ created: false, status: 'active' });
  });

  it('ensureWorkspaceMember inserts when missing and returns created=true', async () => {
    const inserted: any[] = [];
    const dbClient: any = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
      insert: () => ({
        values: async (row: any) => {
          inserted.push(row);
          return undefined;
        },
      }),
    };

    const handler = createEnsureWorkspaceMemberHandler({ dbClient });
    const result = await handler({ role: 'admin' }, ctx);
    expect(result.created).toBe(true);
    expect(inserted[0]).toMatchObject({ workspaceId: ctx.workspaceId, userId: ctx.userId });
  });

  it('meGetOrCreate upserts user and returns empty workspaces when none', async () => {
    const calls: any[] = [];

    let selectCall = 0;

    const dbClient: any = {
      insert: () => ({
        values: (row: any) => {
          calls.push({ type: 'insert', row });
          return {
            onConflictDoUpdate: async (conflict: any) => {
              calls.push({ type: 'upsert', conflict });
              return undefined;
            },
          };
        },
      }),
      select: () => {
        selectCall += 1;
        if (selectCall === 1) {
          return {
            from: () => ({
              where: () => ({
                limit: async () => [
                  {
                    id: ctx.userId,
                    email: ctx.user.email,
                    displayName: ctx.user.name,
                    avatarUrl: ctx.user.avatarUrl,
                  },
                ],
              }),
            }),
          };
        }

        return {
          from: () => ({
            innerJoin: () => ({
              where: async () => [],
            }),
          }),
        };
      },
    };

    const handler = createMeGetOrCreateHandler({ dbClient });
    const result = await handler({}, ctx as any);

    expect(result.user).toEqual(
      expect.objectContaining({
        id: ctx.userId,
        email: ctx.user.email,
        displayName: ctx.user.name,
        avatarUrl: ctx.user.avatarUrl,
      }),
    );
    expect(result.workspaces).toEqual([]);
    expect(calls.find((c) => c.type === 'insert')).toBeDefined();
    expect(calls.find((c) => c.type === 'upsert')).toBeDefined();
  });

  it('meGetOrCreate returns workspaces for active memberships', async () => {
    let selectCall = 0;

    const dbClient: any = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: async () => undefined,
        }),
      }),
      select: () => {
        selectCall += 1;
        if (selectCall === 1) {
          return {
            from: () => ({
              where: () => ({
                limit: async () => [
                  {
                    id: ctx.userId,
                    email: ctx.user.email,
                    displayName: ctx.user.name,
                    avatarUrl: ctx.user.avatarUrl,
                  },
                ],
              }),
            }),
          };
        }

        return {
          from: () => ({
            innerJoin: () => ({
              where: async () => [
                {
                  id: 'ws-1',
                  name: 'Acme',
                  slug: 'acme',
                  planType: 'free',
                },
                {
                  id: 'ws-2',
                  name: 'Beta',
                  slug: null,
                  planType: 'pro',
                },
              ],
            }),
          }),
        };
      },
    };

    const authzClient: any = {
      listRolesForWorkspace: async ({ workspaceId }: { workspaceId: string }) => {
        if (workspaceId === 'ws-1') {
          return [{ userId: ctx.userId, roleKey: 'workspace_owner' }];
        }
        return [{ userId: ctx.userId, roleKey: 'workspace_member' }];
      },
    };

    const handler = createMeGetOrCreateHandler({ dbClient, authzClient });
    const result = await handler({}, ctx as any);
    expect(result.workspaces).toHaveLength(2);
    expect(result.workspaces[0]).toEqual(
      expect.objectContaining({
        id: 'ws-1',
        name: 'Acme',
        slug: 'acme',
        planType: 'free',
        role: 'workspace_owner',
      }),
    );
    expect(result.workspaces[1]).toEqual(
      expect.objectContaining({
        id: 'ws-2',
        name: 'Beta',
        slug: null,
        planType: 'pro',
        role: 'workspace_member',
      }),
    );
  });

  it('listWorkspacesForUser returns active membership workspaces', async () => {
    const dbClient: any = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: async () => [
              { id: 'ws-1', name: 'Acme', slug: 'acme', planType: 'free' },
              { id: 'ws-2', name: 'Beta', slug: null, planType: 'pro' },
            ],
          }),
        }),
      }),
    };

    const authzClient: any = {
      listRolesForWorkspace: async ({ workspaceId }: { workspaceId: string }) => {
        if (workspaceId === 'ws-1') {
          return [{ userId: ctx.userId, roleKey: 'workspace_owner' }];
        }
        return [];
      },
    };

    const handler = createListWorkspacesForUserHandler({ dbClient, authzClient });
    const result = await handler({}, ctx as any);

    expect(result.workspaces).toHaveLength(2);
    expect(result.workspaces[0]).toEqual(
      expect.objectContaining({
        id: 'ws-1',
        name: 'Acme',
        slug: 'acme',
        planType: 'free',
        role: 'workspace_owner',
      }),
    );
    expect(result.workspaces[1]).toEqual(
      expect.objectContaining({
        id: 'ws-2',
        name: 'Beta',
        slug: null,
        planType: 'pro',
        role: 'workspace_member',
      }),
    );
  });

  it('createWorkspace inserts workspace + membership and assigns workspace_owner role', async () => {
    const insertedWorkspaces: any[] = [];
    const insertedMembers: any[] = [];
    const authzCalls: any[] = [];

    const tx: any = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
      insert: (table: any) => ({
        values: async (row: any) => {
          if (table === workspaces) insertedWorkspaces.push(row);
          if (table === workspaceMembers) insertedMembers.push(row);
          return undefined;
        },
      }),
    };

    const dbClient: any = {
      transaction: async (fn: any) => fn(tx),
    };

    const authzClient: any = {
      assignRole: async (req: any) => {
        authzCalls.push(req);
      },
    };

    const handler = createCreateWorkspaceHandler({
      dbClient,
      authzClient,
      idFactory: () => 'ws-123',
    });

    const result = await handler({ name: 'Acme Inc', slug: 'acme' }, ctx as any);

    expect(result).toEqual(
      expect.objectContaining({
        id: 'ws-123',
        name: 'Acme Inc',
        slug: 'acme',
        planType: 'free',
        createdBy: ctx.userId,
      }),
    );

    expect(insertedWorkspaces[0]).toMatchObject({
      id: 'ws-123',
      name: 'Acme Inc',
      slug: 'acme',
      createdBy: ctx.userId,
    });
    expect(insertedMembers[0]).toMatchObject({
      workspaceId: 'ws-123',
      userId: ctx.userId,
      status: 'active',
    });
    expect(authzCalls[0]).toEqual({
      userId: ctx.userId,
      workspaceId: 'ws-123',
      roleKey: 'workspace_owner',
    });
  });

  it('createWorkspace rejects duplicate slug with CONFLICT', async () => {
    const uniqueViolation: any = new Error('duplicate key value violates unique constraint');
    uniqueViolation.code = '23505';
    uniqueViolation.constraint_name = 'workspaces_slug_unique';

    const tx: any = {
      insert: () => ({
        values: async () => {
          throw uniqueViolation;
        },
      }),
    };

    const dbClient: any = {
      transaction: async (fn: any) => fn(tx),
    };

    const authzClient: any = {
      assignRole: async () => {
        throw new Error('should not assign role');
      },
    };

    const handler = createCreateWorkspaceHandler({
      dbClient,
      authzClient,
      idFactory: () => 'ws-123',
    });

    try {
      await handler({ name: 'Acme Inc', slug: 'acme' }, ctx as any);
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e).toBeInstanceOf(DomainError);
      expect(e.code).toBe('CONFLICT');
    }
  });
});
