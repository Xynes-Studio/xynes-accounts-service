/**
 * MAIL-2 — Closed-set mailer error surface.
 *
 * Every `MailerClient` implementation MUST throw a `MailerError` (and
 * never a raw provider error) so callers can branch on a stable code
 * without leaking provider-specific diagnostic text.
 *
 * Mirrors the redaction posture of `xynes-storage-service`'s
 * `SecretManagerError` and the gateway's `ProviderAdapterError`:
 *
 *   - Closed-set `code` and `statusHint` — no string interpolation
 *     of upstream error text into the message.
 *   - Typed `retryable` flag so the MAIL-5 resend handler can pick
 *     between "log + bump `email_attempts`" (retryable) and
 *     "log + mark `last_email_error_code` permanently" (non-retryable)
 *     without reading the code string.
 *   - The class is intentionally NOT a subclass of `DomainError`. A
 *     mailer failure must NEVER surface to the HTTP layer as a 4xx /
 *     5xx envelope — `accounts.invites.create` is fire-and-forget
 *     w.r.t. mail dispatch (the invite row already landed). MAIL-5 is
 *     responsible for catching `MailerError` locally inside the
 *     handler and writing it to `last_email_error_code` instead.
 */

/**
 * Closed set of mailer error codes.
 *
 *   - `RECIPIENT_INVALID`     — the `to` address failed validation
 *                               (empty, malformed, or rejected by the
 *                               provider's 400-class response).
 *                               Non-retryable.
 *   - `PROVIDER_UNAVAILABLE`  — transient transport failure (network
 *                               error, SMTP 5xx, HTTP 5xx). Retryable.
 *   - `RATE_LIMITED`          — the provider rejected the send because
 *                               we're over its per-domain or per-API-key
 *                               quota. Retryable (after backoff).
 *   - `TEMPLATE_RENDER_FAILED` — the in-process template renderer threw
 *                                (e.g. a required field was missing
 *                                from the dispatch input). Non-retryable.
 *   - `PROVIDER_REJECTED`     — the provider rejected the message for a
 *                               permanent reason that's not the
 *                               recipient itself (e.g. suspended sender
 *                               domain, blocked content). Non-retryable.
 */
export type MailerErrorCode =
  | 'RECIPIENT_INVALID'
  | 'PROVIDER_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'TEMPLATE_RENDER_FAILED'
  | 'PROVIDER_REJECTED';

/**
 * Suggested HTTP status code if a caller chooses to surface the
 * mailer error to a client (for example, MAIL-5's
 * `accounts.invites.resend` action returning `429 RATE_LIMITED`).
 * Callers are not required to use this — the field is a hint, not a
 * contract — but the values match the standard HTTP semantics for
 * each closed-set code.
 */
const STATUS_HINT_BY_CODE: Readonly<Record<MailerErrorCode, number>> = Object.freeze({
  RECIPIENT_INVALID: 400,
  PROVIDER_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  TEMPLATE_RENDER_FAILED: 500,
  PROVIDER_REJECTED: 502,
});

/**
 * Whether a given error code is safe to retry. Used by MAIL-5 to
 * decide between "bump `email_attempts` and let the operator click
 * Resend later" (retryable) and "record `last_email_error_code` so
 * the operator can fix the underlying issue" (non-retryable).
 */
const RETRYABLE_BY_CODE: Readonly<Record<MailerErrorCode, boolean>> = Object.freeze({
  RECIPIENT_INVALID: false,
  PROVIDER_UNAVAILABLE: true,
  RATE_LIMITED: true,
  TEMPLATE_RENDER_FAILED: false,
  PROVIDER_REJECTED: false,
});

/**
 * Fixed, redacted messages keyed off the closed-set code. Mailer
 * implementations MUST NOT interpolate upstream provider text into
 * the surfaced message — they may attach an opaque `diagnosticTag`
 * (see below) for operator log correlation, but the message itself
 * is always one of these strings.
 */
const MESSAGE_BY_CODE: Readonly<Record<MailerErrorCode, string>> = Object.freeze({
  RECIPIENT_INVALID: 'Invite recipient address is not a valid email',
  PROVIDER_UNAVAILABLE: 'Mail provider is temporarily unavailable',
  RATE_LIMITED: 'Mail provider rate limit exceeded',
  TEMPLATE_RENDER_FAILED: 'Failed to render invite email template',
  PROVIDER_REJECTED: 'Mail provider rejected the message',
});

export type MailerErrorOptions = {
  /**
   * Optional opaque correlation tag for operator log search. MUST NOT
   * contain raw provider error text, recipient PII, or any secret
   * material — implementations should pass through identifiers like
   * a Resend `request_id` or the local UUID assigned to the dispatch
   * attempt. Defense-in-depth: even when set, the tag is NEVER
   * concatenated into `message`.
   */
  diagnosticTag?: string;
};

export class MailerError extends Error {
  public readonly name = 'MailerError';
  public readonly code: MailerErrorCode;
  public readonly statusHint: number;
  public readonly retryable: boolean;
  public readonly diagnosticTag?: string;

  constructor(code: MailerErrorCode, options: MailerErrorOptions = {}) {
    // Use the fixed, sanitized message — NEVER an upstream error string.
    super(MESSAGE_BY_CODE[code]);
    this.code = code;
    this.statusHint = STATUS_HINT_BY_CODE[code];
    this.retryable = RETRYABLE_BY_CODE[code];
    this.diagnosticTag = options.diagnosticTag;
    // Preserve `instanceof MailerError` across realms (matches
    // `DomainError` posture in `src/libs/xynes/errors/index.ts`).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Type guard for callers that don't want to import the class. */
export function isMailerError(value: unknown): value is MailerError {
  return value instanceof MailerError;
}
