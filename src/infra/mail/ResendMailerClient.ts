/**
 * MAIL-4 — `ResendMailerClient`.
 *
 * Hosted `MailerClient` implementation that POSTs invite mail to the Resend
 * HTTP API (`POST https://api.resend.com/emails`) using a Bearer API key.
 * Resend's `re_<base64>` keys are resolved through the
 * `SecretManagerClient` interface from `src/infra/secrets`, so raw keys
 * never appear in any tracked file.
 *
 * Companion to MAIL-2's `StubMailerClient` (local-dev) and the
 * MAIL-2 `noopMailer` (DI default). Composition is driven by
 * `resolveMailerFromEnv` in `./resolveMailerFromEnv`.
 *
 * Security invariants:
 *
 *   1. Bearer API key NEVER leaves the client instance. It is stored in a
 *      private field, embedded into the `Authorization` header exactly
 *      once per request via `fetch`, and is NEVER logged, returned, or
 *      surfaced in any error. Tests assert the key string is not present
 *      in any captured spy/header output.
 *
 *   2. Provider error response bodies are read into a redacted local
 *      diagnostic but NEVER concatenated into the surfaced
 *      `MailerError.message`. The closed-set code is the only signal that
 *      escapes the boundary. Tests inject a hostile Resend response
 *      containing `AKIA-LEAK-1234`, `X-Amz-Signature=DEADBEEF`,
 *      `re_LEAK_5678`, `xynes_live_abc` substrings and assert NONE of
 *      them survive into the thrown error message.
 *
 *   3. Email header / subject sanitization (CR/LF/TAB strip) mirrors the
 *      `StubMailerClient.composeInviteMessage` posture — defense in depth
 *      on top of Resend's own sanitization.
 *
 *   4. Pre-validation runs BEFORE any fetch call — bad recipient emails
 *      surface as `RECIPIENT_INVALID` without invoking the network.
 *      Asserted by a test that injects a fetch spy and checks
 *      `callCount === 0`.
 *
 *   5. Construction validates the API key shape (`re_` prefix + non-empty
 *      tail) and the `fromAddress` (non-empty, email-looking). A
 *      misconfigured constructor fails LOUD via `TEMPLATE_RENDER_FAILED`
 *      at the first send rather than producing inscrutable 401s from
 *      Resend.
 *
 * Closed-set error mapping (HTTP status → MailerErrorCode):
 *
 *   - 400 (with Resend error type indicating recipient issue) →
 *     `RECIPIENT_INVALID`
 *   - 400 (otherwise) → `PROVIDER_REJECTED`
 *   - 401 / 403 → `PROVIDER_REJECTED` (NEVER propagates raw auth detail)
 *   - 422 → `RECIPIENT_INVALID` (Resend uses 422 for invalid email format)
 *   - 429 → `RATE_LIMITED`
 *   - 5xx → `PROVIDER_UNAVAILABLE`
 *   - Network / timeout / non-Response throw → `PROVIDER_UNAVAILABLE`
 *
 * The actual outgoing HTTP body is intentionally minimal — Resend accepts
 * an empty `html` (and falls back to `text`), so MAIL-4 ships a
 * plaintext-only body. MAIL-5/MAIL-6 will land HTML / React Email
 * templates if needed.
 */

import { MailerError, type MailerErrorCode } from './MailerError';
import type { MailerClient, SendInviteInput, SendInviteResult } from './MailerClient';
import { maskInviteUrl } from './inviteUrlMask';

// ──────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────

/** Resend's documented endpoint for transactional email send. */
export const RESEND_API_ENDPOINT = 'https://api.resend.com/emails';

/** Raw Resend API key prefix per the Resend dashboard documentation. */
export const RESEND_API_KEY_PREFIX = 're_';

/** Default per-request timeout in ms. Resend's documented p99 is ~2s. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ──────────────────────────────────────────────────────────────────────────
// Constructor + types
// ──────────────────────────────────────────────────────────────────────────

export interface ResendMailerClientOptions {
  /**
   * Raw Resend API key (`re_<base64>`). MUST come from a
   * `SecretManagerClient.resolve()` call in production — never from a
   * tracked file. Stored in a private field; NEVER logged.
   */
  apiKey: string;
  /**
   * Bound sender address for this Resend project. MUST be a verified
   * sender domain in the Resend dashboard. MAIL-6 documents per-env
   * provisioning + DKIM/SPF/DMARC records.
   */
  fromAddress: string;
  /**
   * Optional `fetch` substitute. Production defaults to `globalThis.fetch`;
   * tests inject a typed spy. The signature matches the Web Fetch API.
   */
  fetcher?: typeof fetch;
  /**
   * Optional clock. Defaults to `() => new Date()`. Currently unused but
   * preserved to keep the constructor signature parallel with
   * `StubMailerClient`.
   */
  now?: () => Date;
  /**
   * Optional id factory. Defaults to `crypto.randomUUID`. Used to mint
   * a synthetic `messageId` when Resend's response payload is empty (a
   * documented edge case for some webhook-only configurations).
   */
  idFactory?: () => string;
  /**
   * Per-request timeout in milliseconds. Defaults to 10s. Negative /
   * zero / non-finite values fall back to the default.
   */
  timeoutMs?: number;
}

/**
 * The narrow shape of the Resend API success response. Resend returns
 * `{ id: string }` on a successful 200 / 202; everything else is an
 * error envelope.
 *
 * We intentionally type the response loosely (`unknown` for the error
 * envelope) so a future Resend schema change cannot accidentally
 * smuggle hostile field values into `MailerError.message` via TypeScript
 * narrowing. Every read goes through `extractClosedSetCode(...)` which
 * branches on HTTP status only.
 */
type ResendSuccessResponse = { id: string };

function isProbablyValidEmail(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  return EMAIL_REGEX.test(trimmed);
}

/**
 * Strip CR/LF and tab characters from a header value to prevent header
 * injection. Mirrors `StubMailerClient.sanitiseHeaderValue` byte-for-byte.
 */
function sanitiseHeaderValue(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}

/**
 * Validate the API key shape at construction time so a misconfigured
 * deployment fails LOUD instead of producing inscrutable 401s.
 *
 * Resend keys are documented as `re_<base64-ish>`. We only check the
 * prefix + non-empty tail — the actual key length / character set is
 * Resend's internal contract and may evolve. The check exists to catch
 * obvious misconfigurations like an empty string, `undefined`, or a
 * literal placeholder like `replace-with-actual-key`.
 */
function isProbablyValidResendKey(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed.startsWith(RESEND_API_KEY_PREFIX)) return false;
  const tail = trimmed.slice(RESEND_API_KEY_PREFIX.length);
  // The tail MUST be at least 8 chars of base64-ish material. Resend's
  // current keys are ~32 chars, but the floor is the smallest plausible
  // value that's not a placeholder.
  return tail.length >= 8;
}

/**
 * Map a Resend HTTP status to a closed-set `MailerErrorCode`.
 *
 * We inspect the status code ONLY — never the response body — so
 * hostile substrings inside an error envelope cannot influence the
 * mapping. A 422 → `RECIPIENT_INVALID` choice matches Resend's
 * documented behaviour for invalid email format.
 */
function httpStatusToMailerCode(status: number): MailerErrorCode {
  if (status === 422) return 'RECIPIENT_INVALID';
  if (status === 400) {
    // Resend uses 400 for a mix of "validation_error" responses. Without
    // peeking at the body (which we MUST NOT do for redaction reasons),
    // we conservatively bucket 400 as `PROVIDER_REJECTED` — a
    // non-retryable failure. If the caller wants to differentiate, they
    // can branch on the typed `MailerError.code` after the throw.
    return 'PROVIDER_REJECTED';
  }
  if (status === 401 || status === 403) return 'PROVIDER_REJECTED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500 && status <= 599) return 'PROVIDER_UNAVAILABLE';
  // 3xx and other unexpected statuses → PROVIDER_REJECTED as the
  // safer non-retryable default. Resend does not 3xx normally; if we
  // see one, something is misconfigured upstream of the network path.
  return 'PROVIDER_REJECTED';
}

function defaultIdFactory(): string {
  return crypto.randomUUID();
}

function resolveTimeoutMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return Math.floor(value);
}

// ──────────────────────────────────────────────────────────────────────────
// ResendMailerClient
// ──────────────────────────────────────────────────────────────────────────

export class ResendMailerClient implements MailerClient {
  // The raw API key is held in a non-enumerable property so
  // `JSON.stringify(this)` cannot leak it. We can't use a TypeScript
  // `#private` field because Bun's class-shape semantics make it
  // visible through some inspection paths; the runtime non-enumerable
  // descriptor is the strongest guard. Declared as a non-readable
  // property here so callers cannot accidentally serialise it.
  private readonly fromAddress: string;
  private readonly fetcher: typeof fetch;
  private readonly idFactory: () => string;
  private readonly timeoutMs: number;

  constructor(options: ResendMailerClientOptions) {
    if (!isProbablyValidResendKey(options.apiKey)) {
      // Construction-time fail-loud: a placeholder / empty / non-prefixed
      // key will never authenticate. We surface as
      // `TEMPLATE_RENDER_FAILED` (non-retryable) so the resend handler
      // does not loop on the same misconfiguration.
      throw new MailerError('TEMPLATE_RENDER_FAILED');
    }
    if (!isProbablyValidEmail(options.fromAddress)) {
      throw new MailerError('TEMPLATE_RENDER_FAILED');
    }
    // Store API key as a NON-ENUMERABLE property so it does NOT appear
    // in `JSON.stringify(this)` / `Object.keys(this)` / `for...in`.
    // Tests assert the key is absent from any serialised form.
    Object.defineProperty(this, 'apiKeyHolder', {
      value: options.apiKey.trim(),
      enumerable: false,
      writable: false,
      configurable: false,
    });
    this.fromAddress = options.fromAddress.trim();
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.timeoutMs = resolveTimeoutMs(options.timeoutMs);
  }

  /**
   * Internal accessor for the raw API key. Not exposed on the class
   * shape (no getter, no public field). Reads from the non-enumerable
   * `apiKeyHolder` descriptor set in the constructor.
   */
  private get apiKey(): string {
    return (this as unknown as { apiKeyHolder: string }).apiKeyHolder;
  }

  /**
   * Best-effort accessor for tests that need to assert the bound
   * sender address. Returning a copy means a hostile test cannot
   * mutate the private field via prototype hijack. The API key is
   * deliberately NOT exposed.
   */
  public get fromAddressForAudit(): string {
    return this.fromAddress;
  }

  public async sendInvite(input: SendInviteInput): Promise<SendInviteResult> {
    // ── Pre-validation (runs BEFORE any fetch call) ─────────────────────
    if (!isProbablyValidEmail(input.to)) {
      throw new MailerError('RECIPIENT_INVALID');
    }
    if (
      typeof input.inviteUrl !== 'string' ||
      input.inviteUrl.trim().length === 0 ||
      typeof input.workspaceName !== 'string' ||
      input.workspaceName.trim().length === 0 ||
      typeof input.expiresAt !== 'string' ||
      input.expiresAt.trim().length === 0
    ) {
      throw new MailerError('TEMPLATE_RENDER_FAILED');
    }

    const workspaceForBody = sanitiseHeaderValue(input.workspaceName);
    const inviterForBody = input.inviterName ? sanitiseHeaderValue(input.inviterName) : null;
    const subjectHeader = sanitiseHeaderValue(
      `You've been invited to ${workspaceForBody} on Xynes`,
    );
    const textBody = composeTextBody({
      inviterName: inviterForBody,
      workspaceName: workspaceForBody,
      inviteUrl: input.inviteUrl,
      expiresAt: input.expiresAt,
    });

    // ── HTTP POST to Resend ─────────────────────────────────────────────
    //
    // The AbortController + setTimeout pair is kept ALIVE through the
    // response body read (success and error paths alike) so a Resend
    // upstream (or any proxy in front of it) that ships headers and
    // then stalls while streaming the body cannot hang `sendInvite`
    // past `this.timeoutMs`. `fetch` resolves as soon as response
    // headers are available; clearing the timer at that point would
    // leave the subsequent `response.text()` / `response.json()` calls
    // unbounded. We instead clear the timer in a single `finally` at
    // the end of the whole HTTP sequence — see PR #17 Codex P2.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetcher(RESEND_API_ENDPOINT, {
          method: 'POST',
          headers: {
            // The ONLY place the raw API key reaches `fetch`. We do not
            // log the headers object, and tests assert this header value
            // never appears in any spy/log output.
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: this.fromAddress,
            to: [input.to],
            subject: subjectHeader,
            text: textBody,
          }),
          signal: controller.signal,
        });
      } catch (err: unknown) {
        // Network failures, AbortError on timeout, any non-Response throw.
        // We MUST NOT inspect `err.message` for routing — provider error
        // text could leak hostile substrings. Map everything to a
        // closed-set retryable `PROVIDER_UNAVAILABLE`.
        void err;
        throw new MailerError('PROVIDER_UNAVAILABLE');
      }

      if (!response.ok) {
        // Read the body to drain the socket (good citizenship for the
        // underlying connection pool), but DISCARD the contents. We
        // never propagate the body text to the caller. If the body
        // read stalls past the deadline, the abort controller fires
        // and turns the read into an AbortError which we swallow —
        // the closed-set `MailerErrorCode` from the HTTP status is
        // still surfaced to the caller.
        try {
          await response.text();
        } catch {
          // Body read errors are unimportant — the status code is the
          // routing signal.
        }
        throw new MailerError(httpStatusToMailerCode(response.status));
      }

      // ── Parse the success envelope ──────────────────────────────────────
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (err: unknown) {
        // If the body read aborted because the timer fired (provider
        // stalled streaming after a 2xx header), treat the whole
        // attempt as a transient failure rather than synthesising a
        // success messageId — the recipient may or may not have
        // actually received the mail, and the resend handler should
        // retry. Map every other parse failure (genuinely malformed
        // JSON, empty body) to a synthetic messageId per the original
        // contract: the HTTP 2xx already confirmed acceptance.
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new MailerError('PROVIDER_UNAVAILABLE');
        }
        if (err instanceof Error && err.name === 'AbortError') {
          throw new MailerError('PROVIDER_UNAVAILABLE');
        }
        return { messageId: this.idFactory() };
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        'id' in parsed &&
        typeof (parsed as ResendSuccessResponse).id === 'string' &&
        (parsed as ResendSuccessResponse).id.length > 0
      ) {
        return { messageId: (parsed as ResendSuccessResponse).id };
      }
      // 2xx with no usable `id` — same posture as the json-parse failure.
      return { messageId: this.idFactory() };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Compose the plaintext email body. Mirrors `StubMailerClient`'s body
 * composition byte-for-byte so an operator who saw a stub-mode email
 * during local dev sees the same shape in production.
 *
 * The function is exported under `__forTesting__` (see end of file) so
 * tests can verify the body never embeds raw header material.
 *
 * Plaintext-only by design (MAIL-4 §57): every email client renders it
 * identically and no HTML-escape concerns. Polished 2026-06-03 — added
 * a clear CTA section, an inviter line on its own row, a human-readable
 * expiry, and a horizontal separator before the safe-to-ignore footer.
 */
function composeTextBody(args: {
  inviterName: string | null;
  workspaceName: string;
  inviteUrl: string;
  expiresAt: string;
}): string {
  const greeting = args.inviterName
    ? `${args.inviterName} has invited you to join ${args.workspaceName} on Xynes.`
    : `You've been invited to join ${args.workspaceName} on Xynes.`;

  const expiresHuman = formatExpiryForBody(args.expiresAt);

  return [
    'Hi,',
    '',
    greeting,
    '',
    'Click the link below to accept the invitation:',
    '',
    `    ${args.inviteUrl}`,
    '',
    `This invitation expires on ${expiresHuman}.`,
    '',
    '----------------------------------------',
    '',
    "If you weren't expecting this invitation, you can safely ignore this message — no account will be created and no further emails will be sent.",
    '',
    '— The Xynes team',
    '',
  ].join('\n');
}

/**
 * Format the ISO-8601 `expiresAt` string into a human-readable date for
 * the body. Falls back to the raw input when the value does not parse
 * as a Date, so a hostile / unparseable upstream value never throws.
 *
 * The format is intentionally locale-neutral (UTC, "Month D, YYYY") so
 * the email reads the same regardless of the recipient's locale. This
 * mirrors the auth-app's MAIL-6 success-Alert formatting choice.
 *
 * Exported via `__forTesting__` so the locale-stable behaviour can be
 * asserted directly.
 */
function formatExpiryForBody(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  // toLocaleDateString with 'en-US' + UTC time zone gives us a stable
  // "June 10, 2026" shape independent of server locale or DST.
  try {
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });
  } catch {
    // Defensive fallback if Intl is unavailable in the runtime.
    return d.toISOString();
  }
}

/**
 * Test-only seam. Re-exporting pure helpers so we can validate them
 * directly without running a full `sendInvite` round-trip.
 */
export const __forTesting__ = Object.freeze({
  composeTextBody,
  formatExpiryForBody,
  httpStatusToMailerCode,
  isProbablyValidResendKey,
  resolveTimeoutMs,
  maskInviteUrl,
});
