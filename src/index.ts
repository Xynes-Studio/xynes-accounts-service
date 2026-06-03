import app from './app';
import { config } from './infra/config';
import { logger } from './infra/logger';
import { resolveMailerFromEnv } from './infra/mail';
import { registerAccountsActions } from './actions/register';

const port = parseInt(config.server.PORT, 10);

// MAIL-5 follow-up (Codex P1 fix) — Composition root.
//
// Resolve the configured mailer from environment variables BEFORE
// registering action handlers. `resolveMailerFromEnv()` returns:
//
//   - A `ResendMailerClient` when `MAIL_PROVIDER=resend` + the secret
//     ref resolves correctly (hosted).
//   - A `StubMailerClient` when `MAIL_PROVIDER=stub` (local-dev /
//     Inbucket).
//   - `noopMailer` when `MAIL_PROVIDER` is unset or unrecognised
//     (fail-open per MAIL-4 contract — invite rows still land).
//
// In the `MAIL_PROVIDER=resend` misconfigured path the resolver throws
// a closed-set `MailerError` (no upstream message text). We catch it
// to log a single audit-safe line and fall back to `noopMailer` so
// the service still boots — the invariant is "creating an invite
// must never fail because mail is misconfigured". A subsequent
// `accounts.invites.resend` call by an operator will still hit
// `noopMailer` — that's the right posture for a misconfigured deploy:
// the operator sees `lastEmailErrorCode` populated and knows to fix
// the config, no token gets rotated on a healthy invite link.
//
// IMPORTANT: this top-level await ONLY runs in production startup
// (when Bun loads this file via `bun src/index.ts`). Tests that
// import individual handlers or call `registerAccountsActions()`
// directly bypass this path and continue to use the no-arg
// (= noopMailer) default.
const mailer = await resolveMailerFromEnv().catch((err: unknown) => {
  // Closed-set MailerError — never echo upstream message text.
  const code =
    err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
      ? err.code
      : 'UNKNOWN';
  logger.warn(
    `Mail dispatch is misconfigured (code=${code}); invite emails will not be sent until fixed. ` +
      `Invite rows will still be created; the new accounts.invites.resend action will accept calls ` +
      `but no email will be delivered until MAIL_PROVIDER + MAIL_RESEND_SECRET_REF are wired correctly.`,
  );
  return undefined; // signals "use the noopMailer default"
});

if (mailer) {
  registerAccountsActions({ mailer });
  logger.info('Mailer wired into accounts.invites.create + accounts.invites.resend handlers');
} else {
  registerAccountsActions();
  logger.info(
    'Accounts actions registered without an injected mailer; invite handlers fall back to noopMailer',
  );
}

logger.info(`Server is starting on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};
