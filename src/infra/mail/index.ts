/**
 * MAIL-2 + MAIL-4 — Public barrel for `infra/mail`.
 *
 * Re-exports the port (`MailerClient`), the closed-set error surface
 * (`MailerError` / `MailerErrorCode` / `isMailerError`), the local-dev
 * implementation (`StubMailerClient`), the hosted Resend implementation
 * (`ResendMailerClient`), the composition helper (`resolveMailerFromEnv`),
 * and the DI default (`noopMailer`).
 */

export type { MailerClient, SendInviteInput, SendInviteResult } from './MailerClient';

export {
  MailerError,
  isMailerError,
  type MailerErrorCode,
  type MailerErrorOptions,
} from './MailerError';

export { StubMailerClient, type StubMailerMode, type StubMailerOptions } from './StubMailerClient';

export { noopMailer } from './noopMailer';

export { maskInviteUrl } from './inviteUrlMask';

export {
  SmtpTransportError,
  defaultSmtpDispatcher,
  parseRelayUrl,
  parseMessageIdFromReply,
  dotStuffMessage,
  classifyReply,
  type SmtpDispatcher,
  type SmtpDispatchInput,
  type SmtpDispatchResult,
  type SmtpSocketReply,
} from './smtpTransport';

// MAIL-4 — Resend mailer + composition helper.
export {
  ResendMailerClient,
  RESEND_API_ENDPOINT,
  RESEND_API_KEY_PREFIX,
  type ResendMailerClientOptions,
} from './ResendMailerClient';

export {
  resolveMailerFromEnv,
  type MailProvider,
  type ResolveMailerFromEnvDeps,
} from './resolveMailerFromEnv';
