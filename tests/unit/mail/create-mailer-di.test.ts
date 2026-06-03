import { describe, it, expect } from 'bun:test';

import { createCreateWorkspaceInviteHandler } from '../../../src/actions/handlers/invites/create';
import { workspaceInvites } from '../../../src/infra/db/schema';
import type { MailerClient } from '../../../src/infra/mail';

const authedCtx = {
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  userId: '550e8400-e29b-41d4-a716-446655440001',
  requestId: 'req-test',
  user: { email: 'user@example.com', name: 'Alice' },
};

function makeDbClient(): { dbClient: any; inserted: any[] } {
  const inserted: any[] = [];
  const dbClient: any = {
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
  return { dbClient, inserted };
}

function makeAuthz(allow = true): any {
  return {
    checkPermission: async () => allow,
  };
}

describe('createCreateWorkspaceInviteHandler — MAIL-2 DI hook', () => {
  it('accepts an injected MailerClient without changing return shape', async () => {
    const { dbClient, inserted } = makeDbClient();
    const fakeMailer: MailerClient = {
      sendInvite: async () => ({ messageId: 'should-not-be-called' }),
    };
    const handler = createCreateWorkspaceInviteHandler({
      dbClient,
      authzClient: makeAuthz(true),
      idFactory: () => 'invite-mail2',
      tokenFactory: () => ({ token: 'raw-token', tokenHash: 'hashed-token' }),
      now: () => new Date('2025-01-01T00:00:00.000Z'),
      expiresInDays: 7,
      mailer: fakeMailer,
    });
    const result = await handler(
      { email: 'COLLEAGUE@EXAMPLE.COM', roleKey: 'workspace_member' },
      authedCtx as any,
    );
    // Return shape MUST be byte-for-byte identical to the pre-MAIL-2
    // contract (the §4 backward-compat invariant).
    expect(result).toEqual({
      id: 'invite-mail2',
      workspaceId: authedCtx.workspaceId,
      email: 'colleague@example.com',
      roleKey: 'workspace_member',
      status: 'pending',
      expiresAt: '2025-01-08T00:00:00.000Z',
      token: 'raw-token',
    });
    expect(inserted).toHaveLength(1);
  });

  it('does NOT call mailer.sendInvite when mailer is the default noopMailer (MAIL-5 short-circuit)', async () => {
    // MAIL-5 — when the legacy code path passes a real mailer in but
    // omits one (the pre-MAIL-2 baseline shape), the dispatch block
    // short-circuits because `mailer === noopMailer`. The mailer is
    // never invoked. Real callers must explicitly pass a non-noop
    // mailer (or rely on the production composition root to inject
    // one). See `create.ts` MAIL-5 dispatch block for the gate.
    const { dbClient } = makeDbClient();
    const handler = createCreateWorkspaceInviteHandler({
      dbClient,
      authzClient: makeAuthz(true),
      idFactory: () => 'invite-id',
      tokenFactory: () => ({ token: 'raw', tokenHash: 'hash' }),
      now: () => new Date('2025-01-01T00:00:00.000Z'),
      // mailer intentionally omitted — defaults to noopMailer.
    });
    // The mock dbClient only mocks `select(...).from(...).innerJoin(...)`
    // for the ALREADY_MEMBER check and `insert(...).values(...)`. The
    // MAIL-5 dispatch block needs `select(...).from(workspaces)...`
    // (no innerJoin) plus an UPDATE on workspaceInvites — but because
    // `mailer === noopMailer` here, the dispatch block short-circuits
    // and the additional chains are never reached. This is the
    // backward-compat invariant that keeps the 270-test pre-MAIL-5
    // baseline passing byte-for-byte.
    const result = await handler(
      { email: 'COLLEAGUE@EXAMPLE.COM', roleKey: 'workspace_member' },
      authedCtx as any,
    );
    expect(result.id).toBe('invite-id');
    expect(result.token).toBe('raw');
  });

  it('omitting the mailer dep preserves the legacy code path (no errors)', async () => {
    const { dbClient } = makeDbClient();
    const handler = createCreateWorkspaceInviteHandler({
      dbClient,
      authzClient: makeAuthz(true),
      idFactory: () => 'no-mailer',
      tokenFactory: () => ({ token: 'raw', tokenHash: 'hash' }),
      now: () => new Date('2025-01-01T00:00:00.000Z'),
      // mailer intentionally omitted — the field is optional and the
      // pre-MAIL-2 baseline did not pass one.
    });
    const result = await handler(
      { email: 'colleague@example.com', roleKey: 'workspace_member' },
      authedCtx as any,
    );
    expect(result.id).toBe('no-mailer');
    expect(result.token).toBe('raw');
  });
});
