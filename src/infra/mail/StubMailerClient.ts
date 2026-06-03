/**
 * MAIL-2 — `StubMailerClient`.
 *
 * Local-dev `MailerClient` implementation with two behaviours behind
 * one class:
 *
 *   - **stdout mode** (default): writes a single-line JSON record
 *     to stdout describing the dispatch. Used when no SMTP relay is
 *     configured AND `MAILER_LOG_TO_STDOUT === 'true'` is set (or
 *     when neither env var is set — fail-open to operator-visible
 *     dispatch).
 *
 *   - **SMTP relay mode**: connects to the configured relay URL
 *     (typically `smtp://127.0.0.1:54325` for the MAIL-1 Inbucket
 *     inbox) and delivers an RFC-5322 message via the minimal SMTP
 *     transport in `./smtpTransport`. Returns the relay's
 *     `Message-Id` when surfaced, `null` otherwise.
 *
 * Mode selection is purely by constructor config — the `resolveMailerFromEnv`
 * helper in MAIL-4 will inspect `MAIL_PROVIDER`, `SMTP_RELAY_URL`, and
 * `MAILER_LOG_TO_STDOUT` and choose the appropriate `StubMailerClient`
 * configuration (or `ResendMailerClient`). MAIL-2 only ships the
 * class and its DI seams.
 *
 * Security invariants:
 *
 *   1. Raw invite tokens NEVER appear in stdout. The stdout JSON
 *      record carries `inviteUrlMasked` (`maskInviteUrl(input.inviteUrl)`),
 *      not the full URL. The SMTP path delivers the full URL to the
 *      recipient (as is the point of an invite email), but that path
 *      writes to a TCP socket, NOT stdout / logger.
 *
 *   2. Provider errors (SMTP 4xx / 5xx, socket failures, timeouts)
 *      are caught at the transport boundary and translated into
 *      closed-set `MailerError` instances. The original
 *      `SmtpTransportError.message` is consulted ONLY to decide the
 *      target `MailerErrorCode` — it is NEVER concatenated into the
 *      surfaced `MailerError.message`.
 *
 *   3. The stdout JSON record carries `to`, `workspaceName`, and the
 *      masked URL but nothing else. The inviter's name is dropped to
 *      minimise PII exposure in dev logs.
 *
 *   4. RFC-822 header injection: `subject`, `from`, `to`,
 *      `inviterName`, and `workspaceName` are sanitised for CR/LF
 *      before being inserted into the SMTP DATA block. A hostile
 *      `workspaceName` value cannot inject a `Bcc:` header.
 */

import { MailerError, type MailerErrorCode } from './MailerError';
import type { MailerClient, SendInviteInput, SendInviteResult } from './MailerClient';
import { maskInviteUrl } from './inviteUrlMask';
import { SmtpTransportError, defaultSmtpDispatcher, type SmtpDispatcher } from './smtpTransport';

/**
 * Closed-set discriminator for the stub's mode. Used both at
 * construction (the caller picks one) and inside this module (the
 * dispatch path branches on it).
 */
export type StubMailerMode = 'stdout' | 'smtp_relay';

export type StubMailerOptions =
  | {
      mode: 'stdout';
      fromAddress?: string;
      /**
       * Optional sink for the stdout JSON record. Defaults to
       * `console.log`. Tests inject a spy.
       */
      stdoutSink?: (line: string) => void;
      /** Optional id factory; defaults to `crypto.randomUUID`. */
      idFactory?: () => string;
      /** Optional `now()`; defaults to `() => new Date()`. */
      now?: () => Date;
    }
  | {
      mode: 'smtp_relay';
      relayUrl: string;
      fromAddress: string;
      /**
       * Optional SMTP dispatcher. Production wires the
       * `defaultSmtpDispatcher` over `Bun.connect`; tests inject a
       * fake that captures the input and returns a scripted reply.
       */
      smtpDispatcher?: SmtpDispatcher;
      /**
       * Read timeout for each SMTP step. Forwarded into the
       * dispatcher; defaults to 5_000 there.
       */
      timeoutMs?: number;
      /** Optional id factory; defaults to `crypto.randomUUID`. */
      idFactory?: () => string;
      /** Optional `now()`; defaults to `() => new Date()`. */
      now?: () => Date;
    };

const DEFAULT_FROM = 'no-reply@xynes.local';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isProbablyValidEmail(value: string): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  return EMAIL_REGEX.test(trimmed);
}

/**
 * Strip CR/LF and tab characters from a header value to prevent
 * header injection. SMTP servers treat a bare CRLF inside a header
 * as a header-end marker — a hostile `workspaceName` like
 * `Acme\r\nBcc: attacker@example.com` could otherwise leak the
 * invite to an unintended recipient. We replace any CR/LF/TAB with
 * a single space; the resulting string may look uglier than the
 * original but never injects a new header.
 */
function sanitiseHeaderValue(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}

function defaultNow(): Date {
  return new Date();
}

function defaultId(): string {
  return crypto.randomUUID();
}

/**
 * Map an `SmtpTransportError` to a closed-set `MailerErrorCode`.
 *
 *   - 4xx SMTP / transient transport failures → `PROVIDER_UNAVAILABLE`
 *     (retryable). Inbucket itself never emits 4xx, but a misconfigured
 *     local relay (e.g. an over-quota Mailpit) can; treating them as
 *     retryable matches the SMTP RFC.
 *   - 5xx SMTP → split: 550 / 553 (mailbox / address rejected) →
 *     `RECIPIENT_INVALID`; everything else → `PROVIDER_REJECTED`.
 *   - Connect failures / timeouts → `PROVIDER_UNAVAILABLE`.
 *   - Protocol errors → `PROVIDER_REJECTED` (non-retryable; the relay
 *     is misconfigured, retrying won't help).
 */
function smtpErrorToMailerCode(err: SmtpTransportError): MailerErrorCode {
  switch (err.kind) {
    case 'CONNECT_FAILED':
    case 'TIMEOUT':
      return 'PROVIDER_UNAVAILABLE';
    case 'REJECTED_4XX':
      return 'PROVIDER_UNAVAILABLE';
    case 'REJECTED_5XX':
      if (err.replyCode === 550 || err.replyCode === 553) {
        return 'RECIPIENT_INVALID';
      }
      return 'PROVIDER_REJECTED';
    case 'PROTOCOL_ERROR':
      return 'PROVIDER_REJECTED';
    default:
      // Defensive fallback — exhaustive switch + closed set means
      // this branch is unreachable but the `MailerErrorCode` type
      // makes the result explicit.
      return 'PROVIDER_REJECTED';
  }
}

/**
 * Compose the canonical RFC-5322 message block. Headers are all
 * sanitised through `sanitiseHeaderValue` so user input cannot
 * inject extra headers.
 */
function composeInviteMessage(args: {
  messageId: string;
  date: Date;
  from: string;
  to: string;
  subject: string;
  inviterName: string | null;
  workspaceName: string;
  inviteUrl: string;
  expiresAt: string;
}): string {
  const fromHeader = sanitiseHeaderValue(args.from);
  const toHeader = sanitiseHeaderValue(args.to);
  const subjectHeader = sanitiseHeaderValue(args.subject);
  const workspaceForBody = sanitiseHeaderValue(args.workspaceName);
  const inviterForBody = args.inviterName ? sanitiseHeaderValue(args.inviterName) : null;
  const inviterLine = inviterForBody
    ? `${inviterForBody} has invited you to join ${workspaceForBody} on Xynes.`
    : `You've been invited to join ${workspaceForBody} on Xynes.`;
  // Mirror `ResendMailerClient.composeTextBody` byte-for-byte so the
  // local Inbucket/Mailpit preview matches what Resend dispatches in
  // production. Polished 2026-06-03.
  const expiresHuman = formatExpiryForBody(args.expiresAt);
  const body = [
    'Hi,',
    '',
    inviterLine,
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
  ].join('\r\n');
  // Wrap the message id in angle brackets per RFC-5322 §3.6.4.
  const messageIdHeader = `<${args.messageId}@xynes.local>`;
  const headers = [
    `Message-Id: ${messageIdHeader}`,
    `Date: ${args.date.toUTCString()}`,
    `From: ${fromHeader}`,
    `To: ${toHeader}`,
    `Subject: ${subjectHeader}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ].join('\r\n');
  return `${headers}\r\n\r\n${body}`;
}

/**
 * Format the ISO-8601 `expiresAt` string into a human-readable date for
 * the body. Mirrors `ResendMailerClient.formatExpiryForBody` byte-for-byte
 * so the local Mailpit preview matches what Resend dispatches in production.
 *
 * Falls back to the raw input when the value does not parse as a Date,
 * so a hostile / unparseable upstream value never throws inside compose.
 */
function formatExpiryForBody(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  try {
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });
  } catch {
    return d.toISOString();
  }
}

export class StubMailerClient implements MailerClient {
  private readonly options: StubMailerOptions;

  constructor(options: StubMailerOptions) {
    this.options = options;
  }

  public get mode(): StubMailerMode {
    return this.options.mode;
  }

  public async sendInvite(input: SendInviteInput): Promise<SendInviteResult> {
    // Pre-validate inputs. The mailer is the LAST line of defense — a
    // malformed input means the handler is buggy, so we fail loud
    // with a closed-set code rather than letting the SMTP relay
    // surface a cryptic 5xx.
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

    if (this.options.mode === 'stdout') {
      return this.sendInviteViaStdout(input);
    }
    return this.sendInviteViaSmtp(input);
  }

  // ── stdout mode ────────────────────────────────────────────────────────

  private async sendInviteViaStdout(input: SendInviteInput): Promise<SendInviteResult> {
    if (this.options.mode !== 'stdout') {
      // Unreachable — narrowing for TS only.
      throw new MailerError('TEMPLATE_RENDER_FAILED');
    }
    const idFactory = this.options.idFactory ?? defaultId;
    const now = this.options.now ?? defaultNow;
    const sink = this.options.stdoutSink ?? ((line: string) => console.log(line));
    const messageId = idFactory();
    const record = {
      ts: now().toISOString(),
      event: 'mail.invite.dispatched',
      mode: 'stub:stdout',
      messageId,
      to: input.to,
      workspaceName: sanitiseHeaderValue(input.workspaceName),
      inviteUrlMasked: maskInviteUrl(input.inviteUrl),
      expiresAt: input.expiresAt,
    };
    try {
      sink(JSON.stringify(record));
    } catch {
      // A sink that throws is operator misconfiguration — surface as
      // a retryable failure so the invite row still lands and the
      // operator can fix the sink + click Resend (MAIL-5).
      throw new MailerError('PROVIDER_UNAVAILABLE');
    }
    return { messageId };
  }

  // ── SMTP relay mode ────────────────────────────────────────────────────

  private async sendInviteViaSmtp(input: SendInviteInput): Promise<SendInviteResult> {
    if (this.options.mode !== 'smtp_relay') {
      // Unreachable — narrowing for TS only.
      throw new MailerError('TEMPLATE_RENDER_FAILED');
    }
    const dispatch = this.options.smtpDispatcher ?? defaultSmtpDispatcher;
    const idFactory = this.options.idFactory ?? defaultId;
    const now = this.options.now ?? defaultNow;
    const fromAddress = this.options.fromAddress ?? DEFAULT_FROM;
    const messageId = idFactory();
    const messageData = composeInviteMessage({
      messageId,
      date: now(),
      from: fromAddress,
      to: input.to,
      subject: `You've been invited to ${input.workspaceName} on Xynes`,
      inviterName: input.inviterName,
      workspaceName: input.workspaceName,
      inviteUrl: input.inviteUrl,
      expiresAt: input.expiresAt,
    });

    let result;
    try {
      result = await dispatch({
        relayUrl: this.options.relayUrl,
        envelopeFrom: fromAddress,
        envelopeTo: input.to,
        messageData,
        timeoutMs: this.options.timeoutMs,
      });
    } catch (err: unknown) {
      if (err instanceof SmtpTransportError) {
        throw new MailerError(smtpErrorToMailerCode(err));
      }
      // Defense-in-depth: a non-transport throw means a bug
      // somewhere in the dispatcher. Surface as the safest
      // retryable code — no upstream message text leaks.
      throw new MailerError('PROVIDER_UNAVAILABLE');
    }
    // If the relay surfaced a Message-Id, prefer it over the locally
    // synthesised one — Inbucket and other relays may rewrite the
    // header, and using the server-issued id keeps the value
    // consistent with what appears in the inbox UI.
    return { messageId: result.messageId ?? messageId };
  }
}
