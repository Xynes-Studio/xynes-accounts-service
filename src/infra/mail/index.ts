/**
 * MAIL-2 — Public barrel for `infra/mail`.
 *
 * Re-exports the port (`MailerClient`), the closed-set error surface
 * (`MailerError` / `MailerErrorCode` / `isMailerError`), the local-dev
 * implementation (`StubMailerClient`), and the DI default
 * (`noopMailer`). MAIL-4 will add `ResendMailerClient` and the
 * `resolveMailerFromEnv` composition helper.
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
