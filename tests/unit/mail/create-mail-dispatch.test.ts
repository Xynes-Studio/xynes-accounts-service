import { describe, it, expect } from 'bun:test';

import {
  createCreateWorkspaceInviteHandler,
  resolveInviteBaseUrl,
} from '../../../src/actions/handlers/invites/create';
import { workspaceInvites, workspaces } from '../../../src/infra/db/schema';
import { MailerError, type MailerClient } from '../../../src/infra/mail';

/**
 * MAIL-5 — Tests for the create-invite handler's best-effort mailer
 * dispatch.
 *
 * The pre-MAIL-5 baseline lives in `tests/invites.unit.test.ts` and
 * `tests/unit/mail/create-mailer-di.test.ts`. Those tests assert the
 * return shape + the no-mailer/noopMailer short-circuit. This file
 * focuses on the new behaviour:
 *
 *   - Happy path: workspace + inviter lookups happen, mailer is
 *     invoked with the correct shape, MAIL-3 columns are updated.
 *   - Failure paths: MailerError mapping, non-MailerError fallback,
 *     DB write resilience.
 *   - Skip paths: api_key actor.
 *   - Invariants: return shape preserved, raw token never leaked
 *     into the row UPDATE.
 *   - URL composition: env / dep / default resolution.
 */

const authedCtx = {
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  userId: '550e8400-e29b-41d4-a716-446655440001',
  requestId: 'req-test-mail5',
  user: { email: 'inviter@example.com', name: 'Alice' },
};

/**
 * Build a dbClient mock that records all DB writes for assertions.
 * The `select.from(...).where(...).limit()` chain supports BOTH the
 * pre-existing ALREADY_MEMBER innerJoin path AND the new MAIL-5
 * workspace+user lookups.
 */
function makeDbClient(opts?: {
  workspaceRow?: { name: string } | null;
  inviterRow?: { displayName: string | null } | null;
  updateThrows?: boolean;
}) {
  const inserted: any[] = [];
  const updates: any[] = [];
  const selectsByTable = new Map<unknown, any>();

  // NB: `null` is a legitimate "row not found" signal — DO NOT collapse it
  // with `??` to the default. Use a key-presence check instead.
  const workspaceRow = opts && 'workspaceRow' in opts ? opts.workspaceRow : { name: 'Acme' };
  const inviterRow = opts && 'inviterRow' in opts ? opts.inviterRow : { displayName: 'Alice' };

  const dbClient: any = {
    select: () => {
      let currentFromTable: unknown = null;
      const fromChain = {
        from: (table: unknown) => {
          currentFromTable = table;
          return chain;
        },
      };
      const chain = {
        innerJoin: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
        where: () => ({
          limit: async () => {
            // Return value depends on which table the SELECT targets.
            if (currentFromTable === workspaces) {
              selectsByTable.set(workspaces, true);
              return workspaceRow === null ? [] : [workspaceRow];
            }
            // identity.users path — also has a where().limit() chain.
            // The pre-existing SELF_INVITE / ALREADY_MEMBER fallbacks
            // use where().limit() too; for these tests we never trip
            // them (the invitee email is always distinct from the
            // inviter's), so the lookup matches the MAIL-5 inviter
            // path.
            return inviterRow === null ? [] : [inviterRow];
          },
        }),
      };
      return fromChain;
    },
    insert: (table: any) => ({
      values: async (row: any) => {
        expect(table).toBe(workspaceInvites);
        inserted.push(row);
        return undefined;
      },
    }),
    update: (table: any) => ({
      set: (patch: any) => ({
        where: async () => {
          if (opts?.updateThrows) {
            throw new Error('simulated DB UPDATE failure');
          }
          expect(table).toBe(workspaceInvites);
          updates.push(patch);
          return undefined;
        },
      }),
    }),
  };
  return { dbClient, inserted, updates, selectsByTable };
}

function makeAuthz(allow = true): any {
  return {
    checkPermission: async () => allow,
  };
}

describe('MAIL-5 — createCreateWorkspaceInviteHandler mail dispatch', () => {
  describe('resolveInviteBaseUrl', () => {
    it('returns the injected value when provided', () => {
      expect(resolveInviteBaseUrl('https://app.test.example', {})).toBe('https://app.test.example');
    });

    it('strips trailing slashes from the injected value', () => {
      expect(resolveInviteBaseUrl('https://app.test.example/', {})).toBe(
        'https://app.test.example',
      );
      expect(resolveInviteBaseUrl('https://app.test.example///', {})).toBe(
        'https://app.test.example',
      );
    });

    it('falls back to INVITE_BASE_URL env var', () => {
      expect(
        resolveInviteBaseUrl(undefined, {
          INVITE_BASE_URL: 'https://env.example.com/',
        } as NodeJS.ProcessEnv),
      ).toBe('https://env.example.com');
    });

    it('falls back to localhost:3100 when nothing is set', () => {
      expect(resolveInviteBaseUrl(undefined, {})).toBe('http://localhost:3100');
    });

    it('falls back to localhost:3100 when injected is whitespace-only', () => {
      expect(resolveInviteBaseUrl('   ', {})).toBe('http://localhost:3100');
    });
  });

  describe('happy path', () => {
    it('invokes the mailer with the correctly-composed input and updates MAIL-3 columns', async () => {
      const { dbClient, inserted, updates } = makeDbClient();
      const mailerCalls: any[] = [];
      const mailer: MailerClient = {
        sendInvite: async (input) => {
          mailerCalls.push(input);
          return { messageId: 'msg-123' };
        },
      };
      const handler = createCreateWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        idFactory: () => 'invite-happy',
        tokenFactory: () => ({ token: 'raw-token-happy', tokenHash: 'hash' }),
        now: () => new Date('2025-01-01T00:00:00.000Z'),
        expiresInDays: 7,
        mailer,
        inviteBaseUrl: 'https://app.test.example',
      });
      const result = await handler(
        { email: 'invitee@example.com', roleKey: 'workspace_member' },
        authedCtx as any,
      );
      // Return shape preserved byte-for-byte.
      expect(result).toEqual({
        id: 'invite-happy',
        workspaceId: authedCtx.workspaceId,
        email: 'invitee@example.com',
        roleKey: 'workspace_member',
        status: 'pending',
        expiresAt: '2025-01-08T00:00:00.000Z',
        token: 'raw-token-happy',
      });
      // Mailer was invoked exactly once with the canonical shape.
      expect(mailerCalls).toHaveLength(1);
      expect(mailerCalls[0]).toEqual({
        to: 'invitee@example.com',
        inviterName: 'Alice',
        workspaceName: 'Acme',
        inviteUrl: 'https://app.test.example/invite/raw-token-happy',
        expiresAt: '2025-01-08T00:00:00.000Z',
      });
      // Insert + UPDATE both fired.
      expect(inserted).toHaveLength(1);
      expect(updates).toHaveLength(1);
      // UPDATE patch carries the dispatch state.
      expect(updates[0]).toHaveProperty('emailSentAt');
      expect(updates[0]).toHaveProperty('emailAttempts');
      expect(updates[0].lastEmailErrorCode).toBe(null);
    });

    it('passes inviterName=null when the inviter has no displayName', async () => {
      const { dbClient, updates } = makeDbClient({
        inviterRow: { displayName: null },
      });
      const mailerCalls: any[] = [];
      const mailer: MailerClient = {
        sendInvite: async (input) => {
          mailerCalls.push(input);
          return { messageId: null };
        },
      };
      const handler = createCreateWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        idFactory: () => 'invite-no-name',
        tokenFactory: () => ({ token: 'raw', tokenHash: 'hash' }),
        now: () => new Date('2025-01-01T00:00:00.000Z'),
        mailer,
        inviteBaseUrl: 'https://app.test.example',
      });
      await handler(
        { email: 'invitee@example.com', roleKey: 'workspace_member' },
        authedCtx as any,
      );
      expect(mailerCalls[0].inviterName).toBe(null);
      // Success path still bumps the columns.
      expect(updates).toHaveLength(1);
      expect(updates[0].lastEmailErrorCode).toBe(null);
    });
  });

  describe('failure paths', () => {
    it('records the closed-set MailerError.code on MailerError', async () => {
      const { dbClient, updates } = makeDbClient();
      const mailer: MailerClient = {
        sendInvite: async () => {
          throw new MailerError('RECIPIENT_INVALID');
        },
      };
      const handler = createCreateWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        idFactory: () => 'invite-fail',
        tokenFactory: () => ({ token: 'raw', tokenHash: 'hash' }),
        now: () => new Date('2025-01-01T00:00:00.000Z'),
        mailer,
        inviteBaseUrl: 'https://app.test.example',
      });
      const result = await handler(
        { email: 'invitee@example.com', roleKey: 'workspace_member' },
        authedCtx as any,
      );
      // Return shape preserved even on failure.
      expect(result.id).toBe('invite-fail');
      expect(result.token).toBe('raw');
      // UPDATE recorded the failure code.
      expect(updates).toHaveLength(1);
      expect(updates[0].lastEmailErrorCode).toBe('RECIPIENT_INVALID');
      // Failure path does NOT stamp emailSentAt.
      expect(updates[0]).not.toHaveProperty('emailSentAt');
    });

    it('maps non-MailerError thrown values to PROVIDER_UNAVAILABLE', async () => {
      const { dbClient, updates } = makeDbClient();
      const mailer: MailerClient = {
        sendInvite: async () => {
          // Throw a non-MailerError (e.g. a raw network exception).
          throw new Error('connection refused — should NOT leak into the column');
        },
      };
      const handler = createCreateWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        idFactory: () => 'invite-net',
        tokenFactory: () => ({ token: 'raw', tokenHash: 'hash' }),
        now: () => new Date('2025-01-01T00:00:00.000Z'),
        mailer,
      });
      await handler(
        { email: 'invitee@example.com', roleKey: 'workspace_member' },
        authedCtx as any,
      );
      expect(updates).toHaveLength(1);
      expect(updates[0].lastEmailErrorCode).toBe('PROVIDER_UNAVAILABLE');
    });

    it('uses TEMPLATE_RENDER_FAILED when the workspace row is missing', async () => {
      const { dbClient, updates } = makeDbClient({ workspaceRow: null });
      const mailerCalls: any[] = [];
      const mailer: MailerClient = {
        sendInvite: async (input) => {
          mailerCalls.push(input);
          return { messageId: null };
        },
      };
      const handler = createCreateWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        idFactory: () => 'invite-no-ws',
        tokenFactory: () => ({ token: 'raw', tokenHash: 'hash' }),
        now: () => new Date('2025-01-01T00:00:00.000Z'),
        mailer,
      });
      await handler(
        { email: 'invitee@example.com', roleKey: 'workspace_member' },
        authedCtx as any,
      );
      // Mailer was NOT invoked (we threw inside dispatch before sending).
      expect(mailerCalls).toHaveLength(0);
      // The failure-path UPDATE recorded the closed-set code.
      expect(updates).toHaveLength(1);
      expect(updates[0].lastEmailErrorCode).toBe('TEMPLATE_RENDER_FAILED');
    });

    it('swallows DB UPDATE failures so the handler never crashes', async () => {
      const { dbClient } = makeDbClient({ updateThrows: true });
      const mailer: MailerClient = {
        sendInvite: async () => {
          throw new MailerError('RATE_LIMITED');
        },
      };
      const handler = createCreateWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        idFactory: () => 'invite-dbfail',
        tokenFactory: () => ({ token: 'raw', tokenHash: 'hash' }),
        now: () => new Date('2025-01-01T00:00:00.000Z'),
        mailer,
      });
      // Even though the failure-path UPDATE itself throws, the handler
      // returns the canonical shape.
      const result = await handler(
        { email: 'invitee@example.com', roleKey: 'workspace_member' },
        authedCtx as any,
      );
      expect(result.id).toBe('invite-dbfail');
    });
  });

  describe('actor-kind gating (api_key parity)', () => {
    it('skips dispatch entirely when ctx.actor.kind === "api_key"', async () => {
      const { dbClient, updates } = makeDbClient();
      let mailerCalls = 0;
      const mailer: MailerClient = {
        sendInvite: async () => {
          mailerCalls += 1;
          return { messageId: 'should-not-fire' };
        },
      };
      const handler = createCreateWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        idFactory: () => 'invite-apikey',
        tokenFactory: () => ({ token: 'raw', tokenHash: 'hash' }),
        now: () => new Date('2025-01-01T00:00:00.000Z'),
        mailer,
      });
      const apiKeyCtx = {
        ...authedCtx,
        actor: {
          kind: 'api_key' as const,
          apiKeyId: '00000000-0000-0000-0000-00000000aaaa',
          keyPrefix: 'deadbeef',
        },
      };
      const result = await handler(
        { email: 'invitee@example.com', roleKey: 'workspace_member' },
        apiKeyCtx as any,
      );
      // Invite still landed.
      expect(result.id).toBe('invite-apikey');
      // Mailer was NEVER called.
      expect(mailerCalls).toBe(0);
      // No MAIL-3 column updates (since dispatch was skipped).
      expect(updates).toHaveLength(0);
    });
  });

  describe('security invariants', () => {
    it('the UPDATE patch never contains the raw token', async () => {
      const { dbClient, updates } = makeDbClient();
      const mailer: MailerClient = {
        sendInvite: async () => ({ messageId: 'ok' }),
      };
      const handler = createCreateWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        idFactory: () => 'invite-sec',
        tokenFactory: () => ({ token: 'SUPER-SECRET-RAW-TOKEN', tokenHash: 'hash' }),
        now: () => new Date('2025-01-01T00:00:00.000Z'),
        mailer,
      });
      await handler(
        { email: 'invitee@example.com', roleKey: 'workspace_member' },
        authedCtx as any,
      );
      expect(updates).toHaveLength(1);
      // The UPDATE patch carries an `emailAttempts` Drizzle SQL fragment
      // (cyclic), so we sweep each scalar field instead of stringifying
      // the whole patch.
      const patch = updates[0];
      // Scan all string-valued fields for the raw token. The Drizzle
      // `sql` template column reference is on `emailAttempts` and is
      // safe to skip (it carries the table+column reference only, not
      // any user-controlled token).
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'emailAttempts') continue; // sql`` fragment — cyclic
        if (typeof value === 'string') {
          expect(value).not.toContain('SUPER-SECRET-RAW-TOKEN');
        }
      }
      // Defense in depth — the patch keys themselves never include the
      // token (we explicitly check we never accidentally use it as a
      // dynamic field name).
      expect(Object.keys(patch).join('|')).not.toContain('SUPER-SECRET-RAW-TOKEN');
    });
  });
});
