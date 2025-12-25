import { describe, it, expect } from 'bun:test';

import { createReadSelfUserHandler } from '../src/actions/handlers/readSelfUser';
import { createReadCurrentWorkspaceHandler } from '../src/actions/handlers/readCurrentWorkspace';
import { createEnsureWorkspaceMemberHandler } from '../src/actions/handlers/ensureWorkspaceMember';
import { createMeGetOrCreateHandler } from '../src/actions/handlers/meGetOrCreate';
import { NotFoundError } from '../src/actions/errors';

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

    const handler = createMeGetOrCreateHandler({ dbClient });
    const result = await handler({}, ctx as any);
    expect(result.workspaces).toHaveLength(2);
    expect(result.workspaces[0]).toEqual(
      expect.objectContaining({ id: 'ws-1', name: 'Acme', slug: 'acme', planType: 'free' }),
    );
    expect(result.workspaces[1]).toEqual(
      expect.objectContaining({ id: 'ws-2', name: 'Beta', slug: null, planType: 'pro' }),
    );
  });
});
