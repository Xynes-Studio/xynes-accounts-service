/**
 * MAIL-2 — `MailerClient` port.
 *
 * Vendor-neutral contract for delivering a workspace invite email.
 * Implementations:
 *
 *   - `StubMailerClient` (`./StubMailerClient`) — local-dev,
 *     stdout JSON or SMTP relay to Supabase Inbucket.
 *   - `ResendMailerClient` (MAIL-4) — hosted, HTTP POST to the Resend
 *     API behind `SecretManagerClient`.
 *   - `noopMailer` (`./noopMailer`) — frozen no-op singleton, the DI
 *     default for handler code that has not been migrated. Preserves
 *     the pre-MAIL-2 `accounts.invites.create` behaviour byte-for-byte.
 *
 * The port deliberately surfaces a SINGLE method, `sendInvite`. A
 * future story can add `sendXxx` siblings (welcome email, audit
 * digest, …) without breaking existing implementations — but per the
 * plan §3 non-goals, that future story is OUT OF SCOPE here.
 */

import type { MailerError } from './MailerError';

/**
 * Payload for a single invite-mail dispatch attempt.
 *
 * Fields are intentionally narrow and string-typed so:
 *   - The template renderer cannot reach into the database row.
 *   - The mailer cannot accidentally serialise the full
 *     `CreateWorkspaceInviteResult` (which still carries the raw
 *     `token`) into a log line.
 *   - Adding a new field requires an explicit port-shape change.
 *
 * Security invariants:
 *   - `inviteUrl` is the fully-formed URL the recipient will click
 *     (e.g. `${INVITE_BASE_URL}/invite/${token}`). The raw token is
 *     embedded in the URL and MUST NEVER appear anywhere else in
 *     logs / metadata / response objects. The mailer's logging
 *     redaction (`maskInviteUrl`, see `StubMailerClient`) masks the
 *     URL before it reaches stdout.
 *   - `expiresAt` is the ISO-8601 string the body's "expires in N
 *     days" copy will render against.
 *   - `inviterName` is `string | null` because some legacy users may
 *     not have a name set in `identity.users`; the template MUST
 *     render a sensible fallback (e.g. "Someone at <workspace>") in
 *     that case.
 */
export type SendInviteInput = {
  to: string;
  inviterName: string | null;
  workspaceName: string;
  inviteUrl: string;
  expiresAt: string;
};

/**
 * Result of a single dispatch attempt.
 *
 *   - `messageId` is the provider-issued identifier (Resend's `id`,
 *     the SMTP relay's `Message-Id` header, or a synthetic UUID for
 *     the stdout-mode stub). Callers MUST treat the value as opaque
 *     — never display it to end users.
 *   - `null` is permitted when the underlying provider does not
 *     surface a message id (e.g. a misconfigured SMTP relay that
 *     responds 250 without a `Message-Id` header). The handler still
 *     bumps `email_attempts` and clears `last_email_error_code` in
 *     this case — successful 250 is the contract, not the id.
 */
export type SendInviteResult = {
  messageId: string | null;
};

/**
 * The mailer port. Every implementation MUST:
 *
 *   - Resolve successfully or throw a `MailerError` (see
 *     `./MailerError`). Raw provider errors (network exceptions,
 *     SMTP response strings, HTTP response bodies) MUST be caught
 *     at the implementation boundary and replaced with a closed-set
 *     `MailerError` whose `message` is the fixed sanitized string
 *     from the error table — never an upstream substring.
 *   - Treat `sendInvite` as fire-and-forget from the handler's
 *     point of view: a successful return does NOT guarantee
 *     delivery (the recipient's mailbox may bounce later); a thrown
 *     `MailerError` does NOT undo any database row the handler
 *     already wrote.
 *   - Be safe to call from a `try` / `catch` inside the create-invite
 *     handler — neither path mutates handler-scope state.
 *
 * @throws MailerError — closed-set error surface.
 */
export interface MailerClient {
  sendInvite(input: SendInviteInput): Promise<SendInviteResult>;
}

// Re-export so callers can `import { MailerClient, MailerError } from
// '../infra/mail/MailerClient'` for type-only narrowing.
export type { MailerError };
