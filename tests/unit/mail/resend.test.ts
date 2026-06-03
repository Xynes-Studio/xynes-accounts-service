import { describe, it, expect } from 'bun:test';
import { DomainError } from '@xynes/errors';

import {
  createResendWorkspaceInviteHandler,
  resolveMaxAttempts,
} from '../../../src/actions/handlers/invites/resend';
import { workspaceInvites, workspaces, users } from '../../../src/infra/db/schema';
import { MailerError, type MailerClient } from '../../../src/infra/mail';

/**
 * MAIL-5 — Tests for the `accounts.invites.resend` action.
 *
 * Covers:
 *   - Happy path: token rotation, mailer dispatch, MAIL-3 column
 *     updates, return shape.
 *   - Failure paths: MailerError mapping, non-MailerError fallback,
 *     authz denial.
 *   - Guard paths: api_key actor rejection, workspace mismatch
 *     (cross-workspace probe), non-pending status, expired invite,
 *     rate-limit, missing workspace name.
 *   - Idempotency: two rapid calls each bump email_attempts.
 *   - Security invariants: raw token never written to UPDATE patch,
 *     cross-workspace probes return the same envelope as truly-
 *     unknown ids.
 */

const authedCtx = {
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  userId: '550e8400-e29b-41d4-a716-446655440001',
  requestId: 'req-test-resend',
  user: { email: 'inviter@example.com', name: 'Alice' },
};

function makeAuthz(allow = true): any {
  return {
    checkPermission: async () => allow,
  };
}

/**
 * Build a dbClient mock for the resend handler.
 *
 * `inviteRow` controls the SELECT result for the invite lookup.
 * Pass `null` for "row not found" or `undefined` to use the default
 * pending row.
 *
 * `workspaceRow` / `inviterRow` follow the same nullability rule.
 *
 * `update` returns the patch + the row-shape returned by `.returning()`.
 */
function makeDbClient(opts?: {
  inviteRow?: {
    id: string;
    workspaceId: string;
    email: string;
    roleKey: string;
    invitedBy: string;
    status: string;
    expiresAt: Date;
    emailAttempts: number;
  } | null;
  workspaceRow?: { name: string } | null;
  inviterRow?: { displayName: string | null } | null;
  // Override the row returned by UPDATE...RETURNING. Defaults to
  // a fresh row that mirrors the patch.
  updatedRow?: {
    emailSentAt: Date | null;
    emailAttempts: number;
    lastEmailErrorCode: string | null;
  } | null;
}) {
  const defaultInvite = {
    id: 'invite-1',
    workspaceId: authedCtx.workspaceId,
    email: 'invitee@example.com',
    roleKey: 'workspace_member',
    invitedBy: authedCtx.userId,
    status: 'pending',
    expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    emailAttempts: 0,
  };
  const inviteRow = opts && 'inviteRow' in opts ? opts.inviteRow : defaultInvite;
  const workspaceRow = opts && 'workspaceRow' in opts ? opts.workspaceRow : { name: 'Acme' };
  const inviterRow = opts && 'inviterRow' in opts ? opts.inviterRow : { displayName: 'Alice' };
  const updatedRow =
    opts && 'updatedRow' in opts
      ? opts.updatedRow
      : {
          emailSentAt: new Date('2025-06-01T00:00:00.000Z'),
          emailAttempts: 1,
          lastEmailErrorCode: null,
        };

  const updates: any[] = [];

  const dbClient: any = {
    select: () => {
      let currentFromTable: unknown = null;
      const chain = {
        from: (table: unknown) => {
          currentFromTable = table;
          return chain;
        },
        where: () => ({
          limit: async () => {
            if (currentFromTable === workspaceInvites) {
              return inviteRow === null ? [] : [inviteRow];
            }
            if (currentFromTable === workspaces) {
              return workspaceRow === null ? [] : [workspaceRow];
            }
            if (currentFromTable === users) {
              return inviterRow === null ? [] : [inviterRow];
            }
            return [];
          },
        }),
      };
      return chain;
    },
    update: () => ({
      set: (patch: any) => ({
        where: () => ({
          returning: async () => {
            updates.push(patch);
            return updatedRow === null ? [] : [updatedRow];
          },
        }),
      }),
    }),
  };
  return { dbClient, updates };
}

describe('MAIL-5 — accounts.invites.resend', () => {
  describe('resolveMaxAttempts', () => {
    it('returns the injected value when a positive integer', () => {
      expect(resolveMaxAttempts(3, {})).toBe(3);
      expect(resolveMaxAttempts(100, {})).toBe(100);
    });

    it('falls back to MAIL_RESEND_MAX_ATTEMPTS env var when injected is missing', () => {
      expect(
        resolveMaxAttempts(undefined, { MAIL_RESEND_MAX_ATTEMPTS: '7' } as NodeJS.ProcessEnv),
      ).toBe(7);
    });

    it('falls back to default 5 when neither is set', () => {
      expect(resolveMaxAttempts(undefined, {})).toBe(5);
    });

    it('rejects zero/negative/NaN/float injected', () => {
      expect(resolveMaxAttempts(0, {})).toBe(5);
      expect(resolveMaxAttempts(-1, {})).toBe(5);
      expect(resolveMaxAttempts(Number.NaN, {})).toBe(5);
      expect(resolveMaxAttempts(2.5, {})).toBe(5);
    });

    it('rejects zero/negative/non-numeric env values', () => {
      expect(
        resolveMaxAttempts(undefined, { MAIL_RESEND_MAX_ATTEMPTS: '0' } as NodeJS.ProcessEnv),
      ).toBe(5);
      expect(
        resolveMaxAttempts(undefined, { MAIL_RESEND_MAX_ATTEMPTS: '-3' } as NodeJS.ProcessEnv),
      ).toBe(5);
      expect(
        resolveMaxAttempts(undefined, { MAIL_RESEND_MAX_ATTEMPTS: 'abc' } as NodeJS.ProcessEnv),
      ).toBe(5);
      expect(
        resolveMaxAttempts(undefined, { MAIL_RESEND_MAX_ATTEMPTS: '   ' } as NodeJS.ProcessEnv),
      ).toBe(5);
    });
  });

  describe('happy path', () => {
    it('dispatches mailer, rotates the token, updates MAIL-3 columns, returns canonical shape', async () => {
      const { dbClient, updates } = makeDbClient();
      const mailerCalls: any[] = [];
      const mailer: MailerClient = {
        sendInvite: async (input) => {
          mailerCalls.push(input);
          return { messageId: 'resent-msg-1' };
        },
      };
      const handler = createResendWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        mailer,
        inviteBaseUrl: 'https://app.test.example',
        now: () => new Date('2025-06-01T00:00:00.000Z'),
        tokenFactory: () => ({ token: 'rotated-raw-token', tokenHash: 'rotated-hash' }),
      });
      const result = await handler({ inviteId: 'invite-1' }, authedCtx as any);
      // Mailer received the canonical shape with the NEW rotated token URL.
      expect(mailerCalls).toHaveLength(1);
      expect(mailerCalls[0]).toEqual({
        to: 'invitee@example.com',
        inviterName: 'Alice',
        workspaceName: 'Acme',
        inviteUrl: 'https://app.test.example/invite/rotated-raw-token',
        expiresAt: '2026-01-01T00:00:00.000Z',
      });
      // UPDATE included the token rotation + dispatch state.
      expect(updates).toHaveLength(1);
      expect(updates[0].token).toBe('rotated-hash');
      expect(updates[0]).toHaveProperty('emailSentAt');
      expect(updates[0].lastEmailErrorCode).toBe(null);
      // Return shape.
      expect(result.inviteId).toBe('invite-1');
      expect(result.emailAttempts).toBe(1);
      expect(result.lastEmailErrorCode).toBe(null);
      expect(typeof result.emailSentAt).toBe('string');
    });
  });

  describe('failure paths', () => {
    it('rotates the token AND records MailerError.code on dispatch failure', async () => {
      const { dbClient, updates } = makeDbClient({
        updatedRow: {
          emailSentAt: null,
          emailAttempts: 1,
          lastEmailErrorCode: 'RECIPIENT_INVALID',
        },
      });
      const mailer: MailerClient = {
        sendInvite: async () => {
          throw new MailerError('RECIPIENT_INVALID');
        },
      };
      const handler = createResendWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        mailer,
        now: () => new Date('2025-06-01T00:00:00.000Z'),
        tokenFactory: () => ({ token: 'raw', tokenHash: 'hash' }),
      });
      const result = await handler({ inviteId: 'invite-1' }, authedCtx as any);

      // Codex P2 fix: persist-before-send means we issue TWO updates
      // on the failure path. updates[0] is the optimistic UPDATE that
      // rotated the token + stamped emailSentAt; updates[1] is the
      // compensating UPDATE that records the closed-set code AND
      // clears emailSentAt back to NULL.
      expect(updates).toHaveLength(2);

      // updates[0] — optimistic: rotated token, stamped emailSentAt,
      // cleared any previous lastEmailErrorCode.
      expect(updates[0].token).toBe('hash');
      expect(updates[0]).toHaveProperty('emailSentAt');
      expect(updates[0].lastEmailErrorCode).toBe(null);

      // updates[1] — compensating: closed-set code recorded, emailSentAt
      // cleared, token NOT touched (already rotated above), email_attempts
      // NOT bumped again (already bumped on the optimistic UPDATE so the
      // rate-limit counter stays correct).
      expect(updates[1].lastEmailErrorCode).toBe('RECIPIENT_INVALID');
      expect(updates[1].emailSentAt).toBe(null);
      expect(updates[1]).not.toHaveProperty('token');
      expect(updates[1]).not.toHaveProperty('emailAttempts');

      // Caller-facing result reflects the compensated state.
      expect(result.lastEmailErrorCode).toBe('RECIPIENT_INVALID');
      expect(result.emailSentAt).toBe(null);
    });

    it('maps non-MailerError thrown values to PROVIDER_UNAVAILABLE', async () => {
      const { dbClient, updates } = makeDbClient({
        updatedRow: {
          emailSentAt: null,
          emailAttempts: 1,
          lastEmailErrorCode: 'PROVIDER_UNAVAILABLE',
        },
      });
      const mailer: MailerClient = {
        sendInvite: async () => {
          throw new Error('network reset by peer — should NOT leak');
        },
      };
      const handler = createResendWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        mailer,
        now: () => new Date('2025-06-01T00:00:00.000Z'),
        tokenFactory: () => ({ token: 'raw', tokenHash: 'hash' }),
      });
      const result = await handler({ inviteId: 'invite-1' }, authedCtx as any);

      // Codex P2 fix: failure path runs the compensating UPDATE.
      // updates[0] is optimistic (lastEmailErrorCode === null);
      // updates[1] is the compensating UPDATE carrying the closed-set
      // code.
      expect(updates).toHaveLength(2);
      expect(updates[0].lastEmailErrorCode).toBe(null);
      expect(updates[1].lastEmailErrorCode).toBe('PROVIDER_UNAVAILABLE');
      expect(result.lastEmailErrorCode).toBe('PROVIDER_UNAVAILABLE');
    });

    it('returns NOT_FOUND when the UPDATE row vanishes between SELECT and UPDATE', async () => {
      const { dbClient } = makeDbClient({ updatedRow: null });
      // Codex P2 regression guard: when the optimistic UPDATE returns
      // 0 rows (row vanished), the mailer MUST NOT be called.
      // Otherwise the recipient would hold a fresh invite URL whose
      // hash is not in the DB (the persist-after-send anti-pattern
      // that the Codex P2 finding flagged).
      let mailerCallCount = 0;
      const mailer: MailerClient = {
        sendInvite: async () => {
          mailerCallCount += 1;
          return { messageId: 'should-not-fire' };
        },
      };
      const handler = createResendWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        mailer,
        now: () => new Date('2025-06-01T00:00:00.000Z'),
        tokenFactory: () => ({ token: 'raw', tokenHash: 'hash' }),
      });
      let caught: unknown;
      try {
        await handler({ inviteId: 'invite-1' }, authedCtx as any);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('NOT_FOUND');
      // Codex P2 regression guard: the mailer MUST NOT be called when
      // the optimistic UPDATE returns 0 rows. No leaked URL.
      expect(mailerCallCount).toBe(0);
    });
  });

  describe('guard paths', () => {
    it('rejects api_key actors with FORBIDDEN_ACTOR_KIND (403)', async () => {
      const { dbClient } = makeDbClient();
      const handler = createResendWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        now: () => new Date('2025-06-01T00:00:00.000Z'),
      });
      const apiKeyCtx = {
        ...authedCtx,
        actor: {
          kind: 'api_key' as const,
          apiKeyId: '00000000-0000-0000-0000-00000000aaaa',
          keyPrefix: 'deadbeef',
        },
      };
      let caught: unknown;
      try {
        await handler({ inviteId: 'invite-1' }, apiKeyCtx as any);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('FORBIDDEN_ACTOR_KIND');
      expect((caught as DomainError).statusCode).toBe(403);
    });

    it('rejects when authz denies', async () => {
      const { dbClient } = makeDbClient();
      const handler = createResendWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(false),
        now: () => new Date('2025-06-01T00:00:00.000Z'),
      });
      let caught: unknown;
      try {
        await handler({ inviteId: 'invite-1' }, authedCtx as any);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('FORBIDDEN');
    });

    it('returns NOT_FOUND for cross-workspace probes (no enumeration oracle)', async () => {
      // The invite lookup returns a row owned by workspace B; the
      // caller's ctx.workspaceId is workspace A. The handler MUST
      // return NOT_FOUND with the same envelope as a truly-unknown id.
      const { dbClient } = makeDbClient({
        inviteRow: {
          id: 'invite-other-ws',
          workspaceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          email: 'invitee@other.example',
          roleKey: 'workspace_member',
          invitedBy: authedCtx.userId,
          status: 'pending',
          expiresAt: new Date('2026-01-01T00:00:00.000Z'),
          emailAttempts: 0,
        },
      });
      const handler = createResendWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        now: () => new Date('2025-06-01T00:00:00.000Z'),
      });
      let caught: unknown;
      try {
        await handler({ inviteId: 'invite-other-ws' }, authedCtx as any);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('NOT_FOUND');
    });

    it('returns NOT_FOUND when the invite row does not exist', async () => {
      const { dbClient } = makeDbClient({ inviteRow: null });
      const handler = createResendWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        now: () => new Date('2025-06-01T00:00:00.000Z'),
      });
      let caught: unknown;
      try {
        await handler({ inviteId: 'unknown-id' }, authedCtx as any);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('NOT_FOUND');
    });

    it('returns INVALID_STATE (409) for non-pending invites', async () => {
      const { dbClient } = makeDbClient({
        inviteRow: {
          id: 'invite-1',
          workspaceId: authedCtx.workspaceId,
          email: 'invitee@example.com',
          roleKey: 'workspace_member',
          invitedBy: authedCtx.userId,
          status: 'accepted',
          expiresAt: new Date('2026-01-01T00:00:00.000Z'),
          emailAttempts: 1,
        },
      });
      const handler = createResendWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        now: () => new Date('2025-06-01T00:00:00.000Z'),
      });
      let caught: unknown;
      try {
        await handler({ inviteId: 'invite-1' }, authedCtx as any);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('INVALID_STATE');
      expect((caught as DomainError).statusCode).toBe(409);
    });

    it('returns GONE (410) when the invite expiresAt has passed', async () => {
      const { dbClient } = makeDbClient({
        inviteRow: {
          id: 'invite-1',
          workspaceId: authedCtx.workspaceId,
          email: 'invitee@example.com',
          roleKey: 'workspace_member',
          invitedBy: authedCtx.userId,
          status: 'pending',
          expiresAt: new Date('2025-01-01T00:00:00.000Z'),
          emailAttempts: 1,
        },
      });
      const handler = createResendWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        now: () => new Date('2025-06-01T00:00:00.000Z'),
      });
      let caught: unknown;
      try {
        await handler({ inviteId: 'invite-1' }, authedCtx as any);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('GONE');
    });

    it('returns RATE_LIMITED (429) when email_attempts >= cap', async () => {
      const { dbClient, updates } = makeDbClient({
        inviteRow: {
          id: 'invite-1',
          workspaceId: authedCtx.workspaceId,
          email: 'invitee@example.com',
          roleKey: 'workspace_member',
          invitedBy: authedCtx.userId,
          status: 'pending',
          expiresAt: new Date('2026-01-01T00:00:00.000Z'),
          emailAttempts: 5, // at default cap
        },
      });
      let mailerCalled = false;
      const mailer: MailerClient = {
        sendInvite: async () => {
          mailerCalled = true;
          return { messageId: 'should-not-fire' };
        },
      };
      const handler = createResendWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        mailer,
        now: () => new Date('2025-06-01T00:00:00.000Z'),
      });
      let caught: unknown;
      try {
        await handler({ inviteId: 'invite-1' }, authedCtx as any);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('RATE_LIMITED');
      expect((caught as DomainError).statusCode).toBe(429);
      // Mailer was NOT called.
      expect(mailerCalled).toBe(false);
      // Token was NOT rotated (no UPDATE).
      expect(updates).toHaveLength(0);
    });

    it('honors a custom maxAttempts cap below the default', async () => {
      const { dbClient } = makeDbClient({
        inviteRow: {
          id: 'invite-1',
          workspaceId: authedCtx.workspaceId,
          email: 'invitee@example.com',
          roleKey: 'workspace_member',
          invitedBy: authedCtx.userId,
          status: 'pending',
          expiresAt: new Date('2026-01-01T00:00:00.000Z'),
          emailAttempts: 2, // at custom cap=2
        },
      });
      const handler = createResendWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        now: () => new Date('2025-06-01T00:00:00.000Z'),
        maxAttempts: 2,
      });
      let caught: unknown;
      try {
        await handler({ inviteId: 'invite-1' }, authedCtx as any);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('RATE_LIMITED');
    });

    it('returns NOT_FOUND when the workspace row is missing', async () => {
      const { dbClient } = makeDbClient({ workspaceRow: null });
      const handler = createResendWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        now: () => new Date('2025-06-01T00:00:00.000Z'),
      });
      let caught: unknown;
      try {
        await handler({ inviteId: 'invite-1' }, authedCtx as any);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('NOT_FOUND');
    });

    it('rejects when ctx.workspaceId is missing', async () => {
      const { dbClient } = makeDbClient();
      const handler = createResendWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        now: () => new Date('2025-06-01T00:00:00.000Z'),
      });
      const noWsCtx = { ...authedCtx, workspaceId: null };
      let caught: unknown;
      try {
        await handler({ inviteId: 'invite-1' }, noWsCtx as any);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('MISSING_CONTEXT');
    });

    it('rejects when ctx.userId is missing (after passing actor check)', async () => {
      const { dbClient } = makeDbClient();
      const handler = createResendWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        now: () => new Date('2025-06-01T00:00:00.000Z'),
      });
      const noUserCtx = { ...authedCtx, userId: null };
      let caught: unknown;
      try {
        await handler({ inviteId: 'invite-1' }, noUserCtx as any);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('UNAUTHORIZED');
    });
  });

  describe('inviter display name fallback', () => {
    it('passes inviterName=null when the inviter has no displayName', async () => {
      const { dbClient } = makeDbClient({ inviterRow: { displayName: null } });
      const mailerCalls: any[] = [];
      const mailer: MailerClient = {
        sendInvite: async (input) => {
          mailerCalls.push(input);
          return { messageId: 'ok' };
        },
      };
      const handler = createResendWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        mailer,
        now: () => new Date('2025-06-01T00:00:00.000Z'),
        tokenFactory: () => ({ token: 'raw', tokenHash: 'hash' }),
      });
      await handler({ inviteId: 'invite-1' }, authedCtx as any);
      expect(mailerCalls[0].inviterName).toBe(null);
    });
  });

  describe('security invariants', () => {
    it('the UPDATE patch never contains the raw token', async () => {
      const { dbClient, updates } = makeDbClient();
      const mailer: MailerClient = {
        sendInvite: async () => ({ messageId: 'ok' }),
      };
      const handler = createResendWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        mailer,
        now: () => new Date('2025-06-01T00:00:00.000Z'),
        tokenFactory: () => ({
          token: 'SUPER-SECRET-RAW-RESEND-TOKEN',
          tokenHash: 'rotated-hash',
        }),
      });
      await handler({ inviteId: 'invite-1' }, authedCtx as any);
      expect(updates).toHaveLength(1);
      const patch = updates[0];
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'emailAttempts') continue; // sql`` fragment — cyclic
        if (typeof value === 'string') {
          expect(value).not.toContain('SUPER-SECRET-RAW-RESEND-TOKEN');
        }
      }
      expect(Object.keys(patch).join('|')).not.toContain('SUPER-SECRET-RAW-RESEND-TOKEN');
      // The stored token field is the new HASH, not the raw token.
      expect(patch.token).toBe('rotated-hash');
    });

    it('two rapid back-to-back calls each bump email_attempts via independent UPDATEs', async () => {
      // Idempotency contract — at the rate-limit boundary, two
      // concurrent calls can both pass and both dispatch. Each call
      // builds its own UPDATE patch with `emailAttempts + 1` so the
      // database-side counter advances monotonically.
      const { dbClient, updates } = makeDbClient();
      const mailer: MailerClient = {
        sendInvite: async () => ({ messageId: 'ok' }),
      };
      const handler = createResendWorkspaceInviteHandler({
        dbClient,
        authzClient: makeAuthz(true),
        mailer,
        now: () => new Date('2025-06-01T00:00:00.000Z'),
        tokenFactory: () => ({ token: 'raw', tokenHash: 'hash' }),
      });
      await handler({ inviteId: 'invite-1' }, authedCtx as any);
      await handler({ inviteId: 'invite-1' }, authedCtx as any);
      expect(updates).toHaveLength(2);
      // Each update carries the emailAttempts SQL expression — they
      // are not coalesced into a single bump.
      expect(updates[0]).toHaveProperty('emailAttempts');
      expect(updates[1]).toHaveProperty('emailAttempts');
    });
  });
});
