/**
 * MAIL-2 — Frozen no-op `MailerClient` singleton.
 *
 * The DI default for any handler that has not been wired through to a
 * real mailer yet (including `accounts.invites.create` until MAIL-5
 * lands). Mirrors the storage-service's `noopMalwareScanner` pattern:
 *
 *   - Object.frozen at module load so a test or rogue caller cannot
 *     monkey-patch the implementation to add side effects.
 *   - Resolves to `{ messageId: null }` — the same shape a real
 *     mailer returns when the underlying provider does not surface a
 *     message id. Keeps downstream branching uniform.
 *   - No side effects: no stdout, no SMTP, no logger call. A handler
 *     that depends on `noopMailer` looks behaviourally identical to
 *     the pre-MAIL-2 code path that did not call a mailer at all,
 *     preserving the existing 270-test accounts-service baseline.
 */

import type { MailerClient, SendInviteResult } from './MailerClient';

const NOOP_RESULT: SendInviteResult = Object.freeze({ messageId: null });

export const noopMailer: MailerClient = Object.freeze({
  async sendInvite(): Promise<SendInviteResult> {
    return NOOP_RESULT;
  },
});
