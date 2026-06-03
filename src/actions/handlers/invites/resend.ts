import { eq, sql } from 'drizzle-orm';
import { DomainError } from '@xynes/errors';

import { db } from '../../../infra/db';
import { users, workspaceInvites, workspaces } from '../../../infra/db/schema';
import { createAuthzClient, type AuthzClient } from '../../../infra/authz/authzClient';
import { generateInviteToken, type InviteTokenPair } from '../../../infra/security/inviteToken';
import { noopMailer, isMailerError, type MailerClient } from '../../../infra/mail';
import { resolveInviteBaseUrl } from './create';
import type { ActionContext } from '../../types';

/**
 * MAIL-5 — `accounts.invites.resend` action.
 *
 * Re-dispatches the invitation email for a still-pending invite row.
 *
 * **Design note — token rotation on resend.**
 *
 * The original raw token is hash-only in the DB (see
 * `inviteToken.ts`); we cannot recover it. Two designs were
 * considered (the trade-off is documented in the plan §9 verification
 * block):
 *
 *   (A) "Original token stays valid" — require the caller to supply
 *       the raw token in the action payload. Matches the plan §9.4
 *       "no token regenerated" line but contradicts the plan §9.2
 *       payload shape `{ inviteId: string }` and MAIL-6's
 *       `AccountsClient.resendWorkspaceInvite(inviteId)` signature.
 *       Forces the client to retain the raw token in memory beyond
 *       the create call, which is itself an anti-pattern.
 *   (B) "Issue a fresh token, old link dies" — generate a new
 *       token pair, store the new hash, dispatch the new URL. Matches
 *       the plan §9.2 payload shape and §3's hash-only storage
 *       invariant, but contradicts §9.4's "not regenerated" line.
 *
 * **We chose (B).** Rationale:
 *
 *   - §3 ("no raw token persistence") is the stronger constraint —
 *     design (A) would push raw tokens into client memory or session
 *     storage long after the create call. The hash-only DB invariant
 *     was the whole point of the original `inviteToken.ts` design.
 *   - Invalidating the old emailed link on resend is a security
 *     POSITIVE: the operator's mental model is "the recipient never
 *     got the previous mail — issue a fresh attempt." Stale links
 *     should die so a forwarded/leaked old link cannot be used.
 *   - The new token has the SAME `expiresAt` as the original — we
 *     do NOT extend the lifetime on resend. The operator must
 *     create a fresh invite if they want a renewed expiry window.
 *   - The token rotation + dispatch-state UPDATE land in a single
 *     atomic SQL UPDATE so a crash between the two cannot leave the
 *     row in an inconsistent state.
 *
 * Security contract:
 *
 *   - api_key actors are rejected with `FORBIDDEN_ACTOR_KIND` (403).
 *     The gateway already enforces this because
 *     `accounts.invites.resend` is not in any MVP API-key preset,
 *     but the handler-level guard is defense-in-depth.
 *   - `requirePermission('accounts.invites.resend')`: the authz
 *     catalog grants this permission to `workspace_owner` +
 *     `super_admin` only (matches `accounts.invites.create`).
 *   - The raw token is only in handler-local scope — same posture
 *     as `create.ts`. The new hash overwrites the old; old links
 *     resolve to 404.
 *   - Workspace scoping at the SQL layer: lookup filters on both
 *     `id` AND `workspaceId`. Cross-workspace probes return the
 *     same `NOT_FOUND` envelope as truly-unknown ids (no
 *     enumeration oracle).
 *
 * Rate-limit:
 *
 *   - `email_attempts` includes both successes and failures (MAIL-3
 *     contract). The cap of `MAIL_RESEND_MAX_ATTEMPTS` (default 5)
 *     applies to the lifetime of the invite row — beyond it, the
 *     handler returns `429 RATE_LIMITED` without invoking the
 *     mailer AND without rotating the token. The cap is env-driven
 *     so an operator can relax it for support workflows.
 *
 * Idempotency:
 *
 *   - The rate-limit check IS read-before-update, so two concurrent
 *     calls right at the boundary could both pass the check and
 *     both fire the mailer. Acceptable: at the boundary we'd
 *     dispatch one extra mail, never permanently unlock the cap.
 *     The second concurrent call would also rotate the token —
 *     fine, because only ONE of the dispatched mails carries the
 *     last-rotated token (the other is already dead).
 */

export type ResendWorkspaceInvitePayload = {
  inviteId: string;
};

export type ResendWorkspaceInviteResult = {
  inviteId: string;
  emailAttempts: number;
  emailSentAt: string | null;
  lastEmailErrorCode: string | null;
};

export type ResendWorkspaceInviteDependencies = {
  dbClient?: typeof db;
  authzClient?: AuthzClient;
  mailer?: MailerClient;
  /**
   * Optional injection point — defaults to `resolveInviteBaseUrl`.
   * Mirrors the field on `CreateWorkspaceInviteDependencies`.
   */
  inviteBaseUrl?: string;
  now?: () => Date;
  /**
   * Maximum total `email_attempts` (success + failure) before the
   * handler returns `429 RATE_LIMITED`. Defaults to the value of
   * the `MAIL_RESEND_MAX_ATTEMPTS` env var, then `5`.
   */
  maxAttempts?: number;
  /**
   * Token factory — injection seam for tests. Defaults to the same
   * `generateInviteToken(32)` used by `create.ts`.
   */
  tokenFactory?: () => InviteTokenPair;
};

const DEFAULT_MAX_ATTEMPTS = 5;

/** Resolve the per-row attempts cap. Exported for unit tests. */
export function resolveMaxAttempts(
  injected: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (typeof injected === 'number' && Number.isInteger(injected) && injected > 0) {
    return injected;
  }
  const raw = env.MAIL_RESEND_MAX_ATTEMPTS;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_MAX_ATTEMPTS;
}

export function createResendWorkspaceInviteHandler({
  dbClient = db,
  authzClient,
  mailer = noopMailer,
  inviteBaseUrl,
  now = () => new Date(),
  maxAttempts,
  tokenFactory = () => generateInviteToken(32),
}: ResendWorkspaceInviteDependencies = {}) {
  return async (
    payload: ResendWorkspaceInvitePayload,
    ctx: ActionContext,
  ): Promise<ResendWorkspaceInviteResult> => {
    if (!ctx.workspaceId) {
      throw new DomainError('Missing workspaceId in action context', 'MISSING_CONTEXT', 400);
    }
    // MAIL-5 — api_key actors are rejected. The gateway already
    // enforces this (the action key is not in any MVP preset), but
    // we keep the handler-side guard as defense-in-depth.
    if (ctx.actor?.kind === 'api_key') {
      throw new DomainError(
        'This action requires a user identity and cannot be invoked via a workspace API key',
        'FORBIDDEN_ACTOR_KIND',
        403,
      );
    }
    if (!ctx.userId) {
      throw new DomainError('Missing userId in auth context', 'UNAUTHORIZED', 401);
    }

    const resolvedAuthzClient = authzClient ?? createAuthzClient();
    const allowed = await resolvedAuthzClient.checkPermission({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      actionKey: 'accounts.invites.resend',
    });
    if (!allowed) {
      throw new DomainError('Access denied', 'FORBIDDEN', 403);
    }

    // Look up the invite. We deliberately filter by BOTH `id` and
    // `workspaceId` so a caller cannot resend an invite that belongs
    // to a different workspace — the workspaceId from the gateway's
    // route param is authoritative.
    const inviteRows = await dbClient
      .select({
        id: workspaceInvites.id,
        workspaceId: workspaceInvites.workspaceId,
        email: workspaceInvites.email,
        roleKey: workspaceInvites.roleKey,
        invitedBy: workspaceInvites.invitedBy,
        status: workspaceInvites.status,
        expiresAt: workspaceInvites.expiresAt,
        emailAttempts: workspaceInvites.emailAttempts,
      })
      .from(workspaceInvites)
      .where(eq(workspaceInvites.id, payload.inviteId))
      .limit(1);
    const invite = inviteRows[0];
    if (!invite || invite.workspaceId !== ctx.workspaceId) {
      // Same envelope as truly-unknown id so we don't leak whether
      // an invite exists in another workspace.
      throw new DomainError('Workspace invite not found', 'NOT_FOUND', 404);
    }

    if (invite.status !== 'pending') {
      throw new DomainError('Invite is not in a pending state', 'INVALID_STATE', 409);
    }

    // Defense in depth — never resend an expired invite even if the
    // status row hasn't been reaped yet.
    if (invite.expiresAt.getTime() <= now().getTime()) {
      throw new DomainError('Invite has expired', 'GONE', 410);
    }

    // Rate-limit check. `email_attempts` is the lifetime counter
    // (success + failure). Once the cap is hit, no further mailer
    // dispatches will fire for this row AND the token is NOT
    // rotated — the operator must create a fresh invite.
    const cap = resolveMaxAttempts(maxAttempts);
    if (invite.emailAttempts >= cap) {
      throw new DomainError('Too many resend attempts for this invite', 'RATE_LIMITED', 429);
    }

    // Resolve workspace name + inviter display name for the template.
    const workspaceRows = await dbClient
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .limit(1);
    const workspaceName = workspaceRows[0]?.name;
    if (typeof workspaceName !== 'string' || workspaceName.length === 0) {
      throw new DomainError('Workspace not found', 'NOT_FOUND', 404);
    }

    const inviterRows = await dbClient
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, invite.invitedBy))
      .limit(1);
    const inviterName = inviterRows[0]?.displayName ?? null;

    // Issue a fresh token pair. The new hash replaces the old one
    // atomically with the dispatch state UPDATE below; the old link
    // becomes invalid (resolves to 404). See the file header for
    // the design-decision rationale.
    const { token, tokenHash } = tokenFactory();
    const baseUrl = resolveInviteBaseUrl(inviteBaseUrl);
    const inviteUrl = `${baseUrl}/invite/${token}`;

    // Best-effort mailer dispatch. We bump `email_attempts` on BOTH
    // paths (success and failure) so the rate-limit counter cannot
    // be defeated by a permanently-failing recipient address.
    let resultCode: string | null = null;
    try {
      await mailer.sendInvite({
        to: invite.email,
        inviterName,
        workspaceName,
        inviteUrl,
        expiresAt: invite.expiresAt.toISOString(),
      });
    } catch (error) {
      // Closed-set `MailerError.code` only — never raw provider text.
      resultCode = isMailerError(error) ? error.code : 'PROVIDER_UNAVAILABLE';
    }

    // Atomic UPDATE: rotate the token hash AND record the dispatch
    // state. If the mailer succeeded, stamp `email_sent_at` and
    // clear the error code; if it failed, record the closed-set
    // code but still rotate the token (the old hash is destroyed
    // regardless so old links die).
    const updatePatch =
      resultCode === null
        ? {
            token: tokenHash,
            emailSentAt: now(),
            emailAttempts: sql`${workspaceInvites.emailAttempts} + 1`,
            lastEmailErrorCode: null,
          }
        : {
            token: tokenHash,
            emailAttempts: sql`${workspaceInvites.emailAttempts} + 1`,
            lastEmailErrorCode: resultCode,
          };

    const updatedRows = await dbClient
      .update(workspaceInvites)
      .set(updatePatch)
      .where(eq(workspaceInvites.id, invite.id))
      .returning({
        emailSentAt: workspaceInvites.emailSentAt,
        emailAttempts: workspaceInvites.emailAttempts,
        lastEmailErrorCode: workspaceInvites.lastEmailErrorCode,
      });

    const updated = updatedRows[0];
    if (!updated) {
      // The row vanished between SELECT and UPDATE (e.g. concurrent
      // expiration sweep). Treat as not found so we don't expose a
      // 5xx for a benign race.
      throw new DomainError('Workspace invite not found', 'NOT_FOUND', 404);
    }

    return {
      inviteId: invite.id,
      emailAttempts: updated.emailAttempts,
      emailSentAt: updated.emailSentAt ? updated.emailSentAt.toISOString() : null,
      lastEmailErrorCode: updated.lastEmailErrorCode,
    };
  };
}

export const resendWorkspaceInviteHandler = createResendWorkspaceInviteHandler();
