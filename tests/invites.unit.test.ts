import { describe, it, expect } from 'bun:test';
import { DomainError } from '@xynes/errors';

import { createCreateWorkspaceInviteHandler } from '../src/actions/handlers/invites/create';
import { createResolveWorkspaceInviteHandler } from '../src/actions/handlers/invites/resolve';
import { createAcceptWorkspaceInviteHandler } from '../src/actions/handlers/invites/accept';
import { workspaceInvites, workspaceMembers } from '../src/infra/db/schema';

const authedCtx = {
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  userId: '550e8400-e29b-41d4-a716-446655440001',
  requestId: 'req-test',
  user: {
    email: 'user@example.com',
    name: 'Alice',
  },
};

describe('Workspace invites (unit, DI)', () => {
  it('create stores hashed token but returns raw token', async () => {
    const inserted: any[] = [];

    const dbClient: any = {
      // BUG-AUTH-8: the create handler now runs an ALREADY_MEMBER pre-check
      // that joins workspace_members on users.email. Return an empty
      // membership list for the happy path so the insert still fires.
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: async () => [],
            }),
          }),
        }),
      }),
      insert: (table: any) => ({
        values: async (row: any) => {
          expect(table).toBe(workspaceInvites);
          inserted.push(row);
          return undefined;
        },
      }),
    };

    const authzClient: any = {
      checkPermission: async (req: any) => {
        expect(req).toEqual({
          userId: authedCtx.userId,
          workspaceId: authedCtx.workspaceId,
          actionKey: 'accounts.invites.create',
        });
        return true;
      },
    };

    const handler = createCreateWorkspaceInviteHandler({
      dbClient,
      authzClient,
      idFactory: () => 'invite-1',
      tokenFactory: () => ({ token: 'raw-token', tokenHash: 'hashed-token' }),
      now: () => new Date('2025-01-01T00:00:00.000Z'),
      expiresInDays: 7,
    });

    const result = await handler(
      // BUG-AUTH-8: use an address different from authedCtx.user.email so the
      // SELF_INVITE guard does not fire on the happy path.
      { email: 'COLLEAGUE@EXAMPLE.COM', roleKey: 'workspace_member' },
      authedCtx as any,
    );

    expect(result).toEqual(
      expect.objectContaining({
        id: 'invite-1',
        workspaceId: authedCtx.workspaceId,
        email: 'colleague@example.com',
        roleKey: 'workspace_member',
        status: 'pending',
        token: 'raw-token',
      }),
    );

    expect(inserted[0]).toMatchObject({
      id: 'invite-1',
      workspaceId: authedCtx.workspaceId,
      email: 'colleague@example.com',
      roleKey: 'workspace_member',
      invitedBy: authedCtx.userId,
      token: 'hashed-token',
      status: 'pending',
    });
  });

  it('create rejects when authz denies', async () => {
    const dbClient: any = {
      insert: () => ({
        values: async () => {
          throw new Error('should not insert');
        },
      }),
    };

    const authzClient: any = {
      checkPermission: async () => false,
    };

    const handler = createCreateWorkspaceInviteHandler({ dbClient, authzClient });
    await expect(
      handler({ email: 'user@example.com', roleKey: 'workspace_member' }, authedCtx as any),
    ).rejects.toBeInstanceOf(DomainError);
  });

  // ── BUG-AUTH-8: SELF_INVITE + ALREADY_MEMBER guards ────────────────

  it('create rejects SELF_INVITE when invitee email matches ctx.user.email (case-insensitive)', async () => {
    const dbClient: any = {
      insert: () => ({
        values: async () => {
          throw new Error('should not insert on SELF_INVITE');
        },
      }),
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: async () => {
                throw new Error('SELF_INVITE must fire before membership check');
              },
            }),
          }),
        }),
      }),
    };
    const authzClient: any = { checkPermission: async () => true };

    const handler = createCreateWorkspaceInviteHandler({ dbClient, authzClient });

    let caught: unknown;
    try {
      await handler({ email: 'USER@EXAMPLE.COM', roleKey: 'workspace_member' }, authedCtx as any);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DomainError);
    const domain = caught as DomainError;
    expect(domain.code).toBe('SELF_INVITE');
    expect(domain.statusCode).toBe(400);
  });

  it('create rejects SELF_INVITE via users-table fallback when ctx.user.email is missing', async () => {
    // Simulate gateway not propagating ctx.user.email — handler must look up
    // identity.users by ctx.userId and still detect the self-invite.
    let usersLookupCount = 0;
    const dbClient: any = {
      insert: () => ({
        values: async () => {
          throw new Error('should not insert on SELF_INVITE');
        },
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              usersLookupCount += 1;
              return [{ email: 'fallback@example.com' }];
            },
          }),
          // Membership-check fallback (won't be reached on SELF_INVITE)
          innerJoin: () => ({
            where: () => ({
              limit: async () => {
                throw new Error('membership check must not run when SELF_INVITE fires');
              },
            }),
          }),
        }),
      }),
    };
    const authzClient: any = { checkPermission: async () => true };

    const ctxWithoutUserEmail = {
      ...authedCtx,
      user: undefined,
    };

    const handler = createCreateWorkspaceInviteHandler({ dbClient, authzClient });
    let caught: unknown;
    try {
      await handler(
        { email: 'FALLBACK@example.com', roleKey: 'workspace_member' },
        ctxWithoutUserEmail as any,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe('SELF_INVITE');
    expect(usersLookupCount).toBe(1);
  });

  it('create rejects ALREADY_MEMBER when invitee already has an active membership', async () => {
    const dbClient: any = {
      insert: () => ({
        values: async () => {
          throw new Error('should not insert on ALREADY_MEMBER');
        },
      }),
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: async () => [
                // Only the userId is selected; never leak email/displayName.
                { userId: 'existing-member-user-id' },
              ],
            }),
          }),
        }),
      }),
    };
    const authzClient: any = { checkPermission: async () => true };

    const handler = createCreateWorkspaceInviteHandler({ dbClient, authzClient });
    let caught: unknown;
    try {
      await handler(
        { email: 'colleague@example.com', roleKey: 'workspace_member' },
        authedCtx as any,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DomainError);
    const domain = caught as DomainError;
    expect(domain.code).toBe('ALREADY_MEMBER');
    expect(domain.statusCode).toBe(400);
    // Defense in depth: error message must not leak the existing member's userId.
    expect(domain.message).not.toContain('existing-member-user-id');
  });

  it('create ALREADY_MEMBER guard compares emails case-insensitively (lower(users.email))', async () => {
    // Codex P2 (PR #14): identity.users.email is stored as received from
    // the Supabase JWT, so an existing user row could legitimately hold
    // a mixed-case email like User@Example.com. The fix pushes a
    // lower(users.email) expression into the WHERE clause; this test
    // captures the .where() argument, renders it through Drizzle's
    // PgDialect, and asserts (1) lower(...email...) appears in the SQL,
    // (2) the bind value is the lowercased invitee email, and (3) the
    // un-normalised email is NEVER interpolated as a SQL literal.
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const dialect = new PgDialect();

    let capturedWhere: unknown;
    const dbClient: any = {
      insert: () => ({
        values: async () => {
          throw new Error('should not insert');
        },
      }),
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: (whereExpr: unknown) => {
              capturedWhere = whereExpr;
              return {
                limit: async () => [{ userId: 'existing-member-user-id' }],
              };
            },
          }),
        }),
      }),
    };
    const authzClient: any = { checkPermission: async () => true };

    const handler = createCreateWorkspaceInviteHandler({ dbClient, authzClient });
    try {
      // Distinct from authedCtx.user.email so the SELF_INVITE guard does NOT
      // fire — we want the ALREADY_MEMBER pre-check to run and capture the
      // WHERE expression.
      await handler(
        { email: 'Colleague@Example.COM', roleKey: 'workspace_member' },
        authedCtx as any,
      );
    } catch {
      // ALREADY_MEMBER throw is expected; we only need the WHERE shape.
    }

    expect(capturedWhere).toBeDefined();
    const rendered = dialect.sqlToQuery((capturedWhere as any).getSQL());
    expect(rendered.sql).toContain('lower("identity"."users"."email")');
    expect(rendered.params).toContain('colleague@example.com');
    expect(rendered.sql).not.toContain('Colleague@Example.COM');
    expect(rendered.sql).not.toContain('colleague@example.com');
  });

  it('resolve marks pending invites as expired when past expiresAt', async () => {
    const selectRow = {
      id: 'invite-1',
      workspaceId: 'workspace-1',
      workspaceSlug: 'acme',
      workspaceName: 'Acme',
      inviterName: 'Owner',
      inviterEmail: 'owner@acme.com',
      inviteeEmail: 'invitee@acme.com',
      roleKey: 'workspace_member',
      status: 'pending',
      expiresAt: new Date('2025-01-01T00:00:00.000Z'),
      createdAt: new Date('2024-12-31T00:00:00.000Z'),
      inviteId: 'invite-1',
    };

    let updated = false;

    const dbClient: any = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            leftJoin: () => ({
              where: () => ({
                limit: async () => [selectRow],
              }),
            }),
          }),
        }),
      }),
      update: (table: any) => ({
        set: (patch: any) => {
          expect(table).toBe(workspaceInvites);
          expect(patch).toEqual({ status: 'expired' });
          return {
            where: async () => {
              updated = true;
              return undefined;
            },
          };
        },
      }),
    };

    const handler = createResolveWorkspaceInviteHandler({
      dbClient,
      now: () => new Date('2025-01-02T00:00:00.000Z'),
    });

    const result = await handler({ token: 'raw-token' }, {
      userId: null,
      workspaceId: null,
    } as any);
    expect(result.id).toBe('invite-1');
    expect(result.workspaceId).toBe('workspace-1');
    expect(result.workspaceSlug).toBe('acme');
    expect(result.workspaceName).toBe('Acme');
    expect(result.inviterName).toBe('Owner');
    expect(result.inviterEmail).toBe('owner@acme.com');
    expect(result.inviteeEmail).toBe('invitee@acme.com');
    expect(result.role).toBe('workspace_member');
    expect(result.roleKey).toBe('workspace_member');
    expect(result.createdAt).toBe('2024-12-31T00:00:00.000Z');
    expect(result.status).toBe('expired');
    expect(result.expiresAt).toBe('2025-01-01T00:00:00.000Z');
    expect(updated).toBe(true);
  });

  it('accept assigns role from invite and creates membership when missing', async () => {
    const invite = {
      id: 'invite-1',
      workspaceId: authedCtx.workspaceId,
      email: 'user@example.com',
      roleKey: 'workspace_member',
      status: 'pending',
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    let selectCall = 0;
    const insertedMembers: any[] = [];
    const authzCalls: any[] = [];

    const dbClient: any = {
      select: () => {
        selectCall += 1;
        if (selectCall === 1) {
          return {
            from: () => ({
              where: () => ({
                limit: async () => [invite],
              }),
            }),
          };
        }
        if (selectCall === 2) {
          return {
            from: () => ({
              where: () => ({
                limit: async () => [{ email: 'user@example.com' }],
              }),
            }),
          };
        }
        if (selectCall === 3) {
          return {
            from: () => ({
              where: () => ({
                limit: async () => [],
              }),
            }),
          };
        }
        if (selectCall === 4) {
          return {
            from: () => ({
              where: () => ({
                limit: async () => [
                  {
                    id: authedCtx.workspaceId,
                    name: 'Acme',
                    slug: 'acme',
                    planType: 'free',
                  },
                ],
              }),
            }),
          };
        }
        throw new Error(`Unexpected select call #${selectCall}`);
      },
      insert: (table: any) => ({
        values: async (row: any) => {
          expect(table).toBe(workspaceMembers);
          insertedMembers.push(row);
          return undefined;
        },
      }),
      update: (table: any) => ({
        set: () => ({
          where: () => ({
            returning: async () => {
              expect(table).toBe(workspaceInvites);
              return [{ id: 'invite-1' }];
            },
          }),
        }),
      }),
      delete: () => ({
        where: async () => undefined,
      }),
    };

    const authzClient: any = {
      assignRole: async (req: any) => {
        authzCalls.push(req);
      },
    };

    const handler = createAcceptWorkspaceInviteHandler({
      dbClient,
      authzClient,
      now: () => new Date('2025-01-01T00:00:00.000Z'),
    });
    const result = await handler({ token: 'raw-token' }, authedCtx as any);

    expect(result.accepted).toBe(true);
    expect(result.workspaceId).toBe(authedCtx.workspaceId);
    expect(result.roleKey).toBe('workspace_member');
    expect(result.workspaceMemberCreated).toBe(true);
    expect(result.workspace).toEqual({
      id: authedCtx.workspaceId,
      name: 'Acme',
      slug: 'acme',
      planType: 'free',
      role: 'workspace_member',
    });

    expect(insertedMembers[0]).toMatchObject({
      workspaceId: authedCtx.workspaceId,
      userId: authedCtx.userId,
      status: 'active',
    });
    expect(authzCalls[0]).toEqual({
      userId: authedCtx.userId,
      workspaceId: authedCtx.workspaceId,
      roleKey: 'workspace_member',
    });
  });
});
