import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { DomainError } from '@xynes/errors';

import { db } from '../../../infra/db';
import { users, workspaceInvites, workspaceMembers, workspaces } from '../../../infra/db/schema';
import { createAuthzClient, type AuthzClient } from '../../../infra/authz/authzClient';
import { generateInviteToken, type InviteTokenPair } from '../../../infra/security/inviteToken';
import { noopMailer, MailerError, isMailerError, type MailerClient } from '../../../infra/mail';
import type { ActionContext } from '../../types';

export type CreateWorkspaceInvitePayload = {
  email: string;
  roleKey: string;
};

export type CreateWorkspaceInviteResult = {
  id: string;
  workspaceId: string;
  email: string;
  roleKey: string;
  status: 'pending';
  expiresAt: string;
  token: string;
};

export type CreateWorkspaceInviteDependencies = {
  dbClient?: typeof db;
  authzClient?: AuthzClient;
  idFactory?: () => string;
  tokenFactory?: () => InviteTokenPair;
  now?: () => Date;
  expiresInDays?: number;
  /**
   * MAIL-2 / MAIL-5 — Mailer used to dispatch the invite email after
   * the row lands. Defaults to the frozen `noopMailer` so legacy
   * callers (and the existing 270-test baseline) see byte-for-byte
   * unchanged behaviour: the invite row is inserted, no mail is sent,
   * and the return shape is preserved.
   *
   * In production, MAIL-4's `resolveMailerFromEnv()` returns either
   * `StubMailerClient` (local-dev → Inbucket / stdout) or
   * `ResendMailerClient` (hosted → Resend HTTP API). Composition wires
   * it in once at service boot.
   *
   * Security contract (MAIL-5):
   *   - When `ctx.actor?.kind === 'api_key'`, dispatch is SKIPPED
   *     entirely (CMS-API-KEY-ACTOR-1 Story C parity). The invite row
   *     still lands; only the side effect is short-circuited.
   *   - On success: `email_sent_at = now()`, `email_attempts += 1`,
   *     `last_email_error_code = NULL` (MAIL-3 columns).
   *   - On `MailerError`: `email_attempts += 1`,
   *     `last_email_error_code = error.code`. `email_sent_at` is NOT
   *     touched.
   *   - On any other thrown error: same as a `PROVIDER_UNAVAILABLE`
   *     `MailerError` — never crashes the handler.
   *   - The return shape is preserved byte-for-byte regardless of
   *     dispatch outcome.
   */
  mailer?: MailerClient;
  /**
   * MAIL-5 — Base URL used to compose the invite link sent to the
   * recipient. The mailer receives the fully-formed
   * `${inviteBaseUrl}/invite/${token}` URL; the raw token never
   * leaves this handler in any other path. Defaults to the
   * `INVITE_BASE_URL` env var, then `http://localhost:3100` for
   * local-dev parity with the auth-app's host port.
   *
   * Trailing slashes are stripped so callers can pass either
   * `https://app.xynes.com` or `https://app.xynes.com/` without
   * double-slashing the URL.
   */
  inviteBaseUrl?: string;
};

/**
 * MAIL-5 — Resolve the canonical auth-app base URL for the invite
 * link. The handler-scope `inviteBaseUrl` dep wins (test seam);
 * `process.env.INVITE_BASE_URL` is next; the local-dev default
 * (`http://localhost:3100`) is the last resort. Trailing slashes are
 * stripped so the composed URL is never `…//invite/…`.
 *
 * Exported for unit tests. Internal API — not part of any public
 * contract.
 */
export function resolveInviteBaseUrl(
  injected: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = injected ?? env.INVITE_BASE_URL ?? 'http://localhost:3100';
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'http://localhost:3100';
  return trimmed.replace(/\/+$/, '');
}

export function createCreateWorkspaceInviteHandler({
  dbClient = db,
  authzClient,
  idFactory = randomUUID,
  tokenFactory = () => generateInviteToken(32),
  now = () => new Date(),
  expiresInDays = 7,
  // MAIL-5 — `mailer` is now destructured and used to dispatch the
  // invite email after the row insert. Defaults to the frozen
  // `noopMailer` so legacy callers (and the 270-test pre-MAIL-5
  // baseline) see byte-for-byte unchanged behaviour: the invite row
  // is inserted and the return shape is preserved.
  mailer = noopMailer,
  // MAIL-5 — Base URL for composing the invite link. See
  // `resolveInviteBaseUrl` above.
  inviteBaseUrl,
}: CreateWorkspaceInviteDependencies = {}) {
  return async (
    payload: CreateWorkspaceInvitePayload,
    ctx: ActionContext,
  ): Promise<CreateWorkspaceInviteResult> => {
    if (!ctx.workspaceId) {
      throw new DomainError('Missing workspaceId in action context', 'MISSING_CONTEXT', 400);
    }
    if (!ctx.userId) {
      throw new DomainError('Missing userId in auth context', 'UNAUTHORIZED', 401);
    }

    const resolvedAuthzClient = authzClient ?? createAuthzClient();
    const allowed = await resolvedAuthzClient.checkPermission({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      actionKey: 'accounts.invites.create',
    });
    if (!allowed) {
      throw new DomainError('Access denied', 'FORBIDDEN', 403);
    }

    const emailNormalized = payload.email.trim().toLowerCase();

    // BUG-AUTH-8: SELF_INVITE guard.
    // Reject when the invited address matches the authenticated user's own
    // email. Prefer the JWT-derived email on `ctx.user.email` (set by the
    // gateway from the access-token claims), and fall back to a single
    // identity.users lookup when the gateway did not propagate the email —
    // this keeps the guard reliable even if a future upstream change drops
    // the optional `user` field. Both comparisons are trim+lowercase so the
    // guard mirrors the same normalization the invite row uses.
    const ctxEmailNormalized = ctx.user?.email?.trim().toLowerCase() ?? '';
    let actorEmail = ctxEmailNormalized;
    if (!actorEmail) {
      const actorRows = await dbClient
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, ctx.userId))
        .limit(1);
      actorEmail = actorRows[0]?.email?.trim().toLowerCase() ?? '';
    }
    if (actorEmail && actorEmail === emailNormalized) {
      throw new DomainError('Cannot invite yourself to this workspace', 'SELF_INVITE', 400);
    }

    // BUG-AUTH-8: ALREADY_MEMBER guard.
    // Reject when the invited address already has an active membership in
    // this workspace. Resolved by joining identity.users on the normalized
    // email to platform.workspace_members. The query intentionally returns
    // at most one row and never leaks the existing member's userId outside
    // this handler.
    //
    // Case-insensitive comparison: `identity.users.email` is stored as
    // received from the Supabase JWT (`userEmailSchema` in `meGetOrCreate`
    // trims + validates but does NOT lowercase), so a row like
    // `User@Example.com` could otherwise bypass this guard when the inviter
    // submits `user@example.com`. Push the lowercasing down to Postgres
    // with `lower(users.email)` so the equality holds regardless of how the
    // user's email was originally cased in the JWT. The right-hand side is
    // already `.trim().toLowerCase()`-normalized above.
    //
    // Note: there is no `lower(users.email)` functional index today, so this
    // query does a sequential scan over identity.users. Acceptable at MVP
    // scale (a single workspace's member set is small); a follow-up can add
    // `CREATE INDEX users_email_lower_idx ON identity.users (lower(email))`
    // when the workspace count or member count grows.
    const memberRows = await dbClient
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(
        and(
          eq(workspaceMembers.workspaceId, ctx.workspaceId),
          eq(workspaceMembers.status, 'active'),
          eq(sql<string>`lower(${users.email})`, emailNormalized),
        ),
      )
      .limit(1);
    if (memberRows.length > 0) {
      throw new DomainError('This person is already a workspace member', 'ALREADY_MEMBER', 400);
    }

    const inviteId = idFactory();
    const { token, tokenHash } = tokenFactory();

    const expiresAt = new Date(now().getTime() + expiresInDays * 24 * 60 * 60 * 1000);

    await dbClient.insert(workspaceInvites).values({
      id: inviteId,
      workspaceId: ctx.workspaceId,
      email: emailNormalized,
      roleKey: payload.roleKey,
      invitedBy: ctx.userId,
      token: tokenHash,
      status: 'pending',
      expiresAt,
    });

    // ── MAIL-5 — Best-effort mailer dispatch ─────────────────────────
    //
    // The invite row has landed. The mailer is fire-and-forget from the
    // handler's point of view: a thrown `MailerError` (or any other
    // error) MUST NOT undo the row insert, and MUST NOT surface to the
    // HTTP client as a 4xx/5xx envelope. Instead, the closed-set error
    // code is written to `last_email_error_code` (MAIL-3 column) so an
    // operator can re-dispatch via the new `accounts.invites.resend`
    // action later.
    //
    // Skipped paths (kept side-effect-free so the legacy 270-test
    // baseline continues to pass byte-for-byte):
    //   - `mailer === noopMailer` — no real mailer was injected. Skips
    //     the workspace + inviter lookups + the column UPDATE.
    //   - `ctx.actor?.kind === 'api_key'` — API-key actor parity with
    //     CMS-API-KEY-ACTOR-1 Story C. The invite row landed but we
    //     never trigger a side effect on behalf of a machine credential.
    if (mailer !== noopMailer && ctx.actor?.kind !== 'api_key') {
      await dispatchInviteMail({
        dbClient,
        mailer,
        inviteId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        emailNormalized,
        token,
        expiresAt,
        inviteBaseUrl: resolveInviteBaseUrl(inviteBaseUrl),
        now,
      });
    }

    return {
      id: inviteId,
      workspaceId: ctx.workspaceId,
      email: emailNormalized,
      roleKey: payload.roleKey,
      status: 'pending',
      expiresAt: expiresAt.toISOString(),
      token,
    };
  };
}

/**
 * MAIL-5 — Internal helper that resolves workspace + inviter
 * metadata, calls `mailer.sendInvite`, and writes the MAIL-3 dispatch
 * state columns. Factored out so the create handler stays readable
 * and the test suite can target the dispatch logic in isolation.
 *
 * Never throws. Errors are caught locally and recorded in
 * `last_email_error_code` — the invite row must remain usable for the
 * caller, who still has the raw `token` for manual sharing.
 */
async function dispatchInviteMail(params: {
  dbClient: typeof db;
  mailer: MailerClient;
  inviteId: string;
  workspaceId: string;
  userId: string;
  emailNormalized: string;
  token: string;
  expiresAt: Date;
  inviteBaseUrl: string;
  now: () => Date;
}): Promise<void> {
  const {
    dbClient,
    mailer,
    inviteId,
    workspaceId,
    userId,
    emailNormalized,
    token,
    expiresAt,
    inviteBaseUrl,
    now,
  } = params;
  try {
    // Resolve the workspace name + inviter display name in a single
    // round-trip. The values feed the rendered template; missing rows
    // surface as `TEMPLATE_RENDER_FAILED` (non-retryable) because we
    // cannot send a meaningful invite without them.
    const workspaceRows = await dbClient
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const workspaceName = workspaceRows[0]?.name;
    if (typeof workspaceName !== 'string' || workspaceName.length === 0) {
      throw new MailerError('TEMPLATE_RENDER_FAILED');
    }

    const inviterRows = await dbClient
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    // `displayName` is nullable in identity.users — pass null through
    // so the mailer template can render a sensible fallback (e.g.
    // "Someone at <workspace>"). See `SendInviteInput.inviterName`.
    const inviterName = inviterRows[0]?.displayName ?? null;

    const inviteUrl = `${inviteBaseUrl}/invite/${token}`;

    await mailer.sendInvite({
      to: emailNormalized,
      inviterName,
      workspaceName,
      inviteUrl,
      expiresAt: expiresAt.toISOString(),
    });

    // Success path — bump email_attempts and stamp email_sent_at,
    // clear any previous error code.
    await dbClient
      .update(workspaceInvites)
      .set({
        emailSentAt: now(),
        emailAttempts: sql`${workspaceInvites.emailAttempts} + 1`,
        lastEmailErrorCode: null,
      })
      .where(eq(workspaceInvites.id, inviteId));
  } catch (error) {
    // Failure path — record the closed-set `MailerError.code` on the
    // row so the resend handler / operator can branch on it. The raw
    // provider error text NEVER reaches this column (MAIL-2 contract:
    // every implementation throws a `MailerError` with a fixed,
    // sanitized message; any other thrown value is bucketed as a
    // retryable `PROVIDER_UNAVAILABLE`).
    const code = isMailerError(error) ? error.code : 'PROVIDER_UNAVAILABLE';
    try {
      await dbClient
        .update(workspaceInvites)
        .set({
          emailAttempts: sql`${workspaceInvites.emailAttempts} + 1`,
          lastEmailErrorCode: code,
        })
        .where(eq(workspaceInvites.id, inviteId));
    } catch {
      // Best-effort: a DB hiccup on the failure-path UPDATE must not
      // crash the handler. The invite row is still usable; the next
      // `accounts.invites.resend` will re-attempt and update the
      // column at that point.
    }
  }
}

export const createWorkspaceInviteHandler = createCreateWorkspaceInviteHandler();
