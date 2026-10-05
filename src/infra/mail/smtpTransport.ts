/**
 * MAIL-2 — Minimal SMTP transport for the local Inbucket relay.
 *
 * Hand-rolled SMTP client targeting Supabase's built-in Inbucket
 * inbox (`127.0.0.1:54325` per MAIL-1). Deliberately minimal:
 *
 *   - No TLS / STARTTLS. Inbucket is local-dev only; SSL handshakes
 *     against `127.0.0.1` add complexity without value.
 *   - No SMTP authentication. Inbucket does not require AUTH.
 *   - No connection pooling. One TCP connection per dispatch.
 *   - No HELO/EHLO capability parsing — we send EHLO and ignore the
 *     capability list (we only need the bare verbs).
 *
 * Why hand-rolled instead of `nodemailer`?
 *
 *   - Avoids pulling a 5 MB dependency tree into accounts-service for
 *     a single-purpose local-dev-only transport.
 *   - `nodemailer` is built around the Node.js `net` API; in Bun we
 *     get the same primitives through `Bun.connect` directly.
 *   - MAIL-4's hosted dispatch uses `fetch` against the Resend HTTP
 *     API — no SMTP at all. The transport here only needs to satisfy
 *     Inbucket's relaxed SMTP dialect.
 *
 * Errors are normalised to a stable shape so `StubMailerClient` can
 * map them to closed-set `MailerError` codes without touching raw
 * provider strings.
 */

export type SmtpSocketReply = {
  /** Numeric SMTP reply code, e.g. 220, 250, 354, 421, 550. */
  code: number;
  /** Raw single-line text of the reply, with the leading code stripped. */
  text: string;
};

export type SmtpDispatchInput = {
  /** SMTP relay URL, e.g. `smtp://127.0.0.1:54325`. */
  relayUrl: string;
  /** RFC-5321 envelope `from` (MAIL FROM). */
  envelopeFrom: string;
  /** Single RFC-5321 envelope `to` (RCPT TO). */
  envelopeTo: string;
  /**
   * RFC-5322 message data block. Lines must use CRLF line endings.
   * The transport DOES NOT validate or modify the headers — the
   * caller is responsible for `From:`, `To:`, `Subject:`,
   * `Message-Id:`, etc. The transport applies the SMTP `<CRLF>.<CRLF>`
   * terminator and dot-stuffing per RFC-5321 §4.5.2.
   */
  messageData: string;
  /**
   * EHLO domain to announce. Defaults to `localhost`. Inbucket
   * accepts anything so this is cosmetic.
   */
  ehloDomain?: string;
  /**
   * Per-step read timeout in milliseconds. Defaults to 5_000.
   * Generous enough to survive a slow Inbucket boot but small enough
   * that a misconfigured relay does not hang the request thread.
   */
  timeoutMs?: number;
};

export type SmtpDispatchResult = {
  /**
   * `Message-Id` header parsed out of the relay's 250 response, if
   * the relay surfaces one. Inbucket replies `250 2.0.0 OK <message-id>`
   * — we extract everything after the last `OK` token.
   * `null` when the relay does not surface an id (still a successful
   * dispatch).
   */
  messageId: string | null;
};

/**
 * SMTP-specific transport error. Surfaced ONLY inside this module
 * and `StubMailerClient` — the public mailer surface translates
 * these into closed-set `MailerError` instances.
 */
export class SmtpTransportError extends Error {
  public readonly name = 'SmtpTransportError';
  public readonly kind:
    | 'CONNECT_FAILED'
    | 'TIMEOUT'
    | 'PROTOCOL_ERROR'
    | 'REJECTED_4XX'
    | 'REJECTED_5XX';
  public readonly replyCode: number | null;

  constructor(kind: SmtpTransportError['kind'], replyCode: number | null, message: string) {
    super(message);
    this.kind = kind;
    this.replyCode = replyCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Parse the trailing `<message-id>` token out of a 250 response.
 * Returns `null` when the reply does not contain a `<...>` capture.
 *
 * Inbucket's 250 line is typically:
 *   `250 2.0.0 Ok: queued as <01HQX...>`
 * GoTrue's bundled SMTP server is similar. We greedy-match the LAST
 * `<...>` block on the line so future relays that prefix multiple
 * tags still resolve to the message id.
 */
export function parseMessageIdFromReply(text: string): string | null {
  const matches = text.match(/<([^<>]+)>/g);
  if (!matches || matches.length === 0) return null;
  const last = matches[matches.length - 1];
  // Strip the angle brackets.
  return last.slice(1, -1);
}

/**
 * Parse a `smtp://host:port` URL into `{ host, port }`.
 *
 * Throws `SmtpTransportError('PROTOCOL_ERROR', ...)` on a malformed
 * URL — defense-in-depth so an env-injected typo fails loud before
 * we open a socket to an unintended destination.
 */
export function parseRelayUrl(url: string): { host: string; port: number } {
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw new SmtpTransportError(
      'PROTOCOL_ERROR',
      null,
      'SMTP relay URL must be a non-empty string',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new SmtpTransportError('PROTOCOL_ERROR', null, 'SMTP relay URL is not a valid URL');
  }
  if (parsed.protocol !== 'smtp:') {
    throw new SmtpTransportError(
      'PROTOCOL_ERROR',
      null,
      'SMTP relay URL must use the smtp:// scheme',
    );
  }
  const host = parsed.hostname;
  // URL parses an empty port to ''; default the SMTP port to 25 if
  // the operator omitted it, but the canonical local-dev value is
  // 54325 (Inbucket).
  const port = parsed.port.length === 0 ? 25 : Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) {
    throw new SmtpTransportError('PROTOCOL_ERROR', null, 'SMTP relay URL port is out of range');
  }
  return { host, port };
}

/**
 * Apply RFC-5321 §4.5.2 dot-stuffing to a message body and append
 * the `<CRLF>.<CRLF>` terminator.
 *
 * Any line that starts with `.` is escaped to `..` so the SMTP
 * end-of-data marker is unambiguous. Idempotent on inputs that
 * never start a line with a dot.
 */
export function dotStuffMessage(messageData: string): string {
  // Normalise CRLF then escape leading dots line-by-line. We do NOT
  // perform header / body splitting — the caller is responsible for
  // ensuring the message is well-formed.
  const normalised = messageData.replace(/\r?\n/g, '\r\n');
  const stuffed = normalised.replace(/(^|\r\n)\./g, '$1..');
  return `${stuffed}\r\n.\r\n`;
}

/**
 * DI seam for the SMTP transport. Tests inject a fake that captures
 * the request and returns a scripted reply, so we never open a real
 * TCP socket in `bun test`.
 */
export type SmtpDispatcher = (input: SmtpDispatchInput) => Promise<SmtpDispatchResult>;

// ──────────────────────────────────────────────────────────────────────────
// Production dispatcher: minimal SMTP client over Bun.connect.
// ──────────────────────────────────────────────────────────────────────────

type BunSocketLike = {
  write: (chunk: string) => number;
  end: () => void;
};

/**
 * Read-line buffer over Bun's binary socket data events. SMTP servers
 * emit one or more `\r\n`-terminated lines per reply; multi-line
 * replies carry `<code>-<text>` for intermediate lines and `<code> <text>`
 * for the terminator. We buffer until we see a terminator line.
 */
function makeReplyReader(): {
  push: (chunk: Uint8Array) => void;
  read: (timeoutMs: number) => Promise<SmtpSocketReply>;
  fail: (err: SmtpTransportError) => void;
  end: () => void;
} {
  let buffer = '';
  let pending: {
    resolve: (reply: SmtpSocketReply) => void;
    reject: (err: SmtpTransportError) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  let closed = false;
  let fatalError: SmtpTransportError | null = null;

  function tryDeliver(): void {
    if (!pending) return;
    // Look for a terminator line: `<3 digits> <text>` (space, not '-')
    // optionally followed by more text.
    const lines = buffer.split('\r\n');
    // Keep the trailing fragment (no CRLF yet) in `buffer`.
    buffer = lines.pop() ?? '';
    let lastReply: SmtpSocketReply | null = null;
    let terminatorIdx = -1;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const m = line.match(/^(\d{3})([ -])(.*)$/);
      if (!m) continue;
      const code = Number.parseInt(m[1], 10);
      const sep = m[2];
      const text = m[3];
      if (sep === ' ') {
        lastReply = { code, text };
        terminatorIdx = i;
        break;
      }
    }
    if (lastReply !== null) {
      // Put any lines AFTER the terminator back into the buffer so
      // the next read picks them up.
      const leftover = lines.slice(terminatorIdx + 1).join('\r\n');
      buffer = leftover.length > 0 ? `${leftover}\r\n${buffer}` : buffer;
      clearTimeout(pending.timer);
      const p = pending;
      pending = null;
      p.resolve(lastReply);
    }
  }

  return {
    push(chunk: Uint8Array): void {
      buffer += new TextDecoder().decode(chunk);
      tryDeliver();
    },
    read(timeoutMs: number): Promise<SmtpSocketReply> {
      return new Promise<SmtpSocketReply>((resolve, reject) => {
        if (fatalError !== null) {
          reject(fatalError);
          return;
        }
        if (closed) {
          reject(new SmtpTransportError('PROTOCOL_ERROR', null, 'SMTP socket closed before reply'));
          return;
        }
        const timer = setTimeout(() => {
          if (pending) {
            pending = null;
            reject(new SmtpTransportError('TIMEOUT', null, 'SMTP read timed out'));
          }
        }, timeoutMs);
        pending = { resolve, reject, timer };
        tryDeliver();
      });
    },
    fail(err: SmtpTransportError): void {
      fatalError = err;
      if (pending) {
        clearTimeout(pending.timer);
        const p = pending;
        pending = null;
        p.reject(err);
      }
    },
    end(): void {
      closed = true;
      if (pending) {
        clearTimeout(pending.timer);
        const p = pending;
        pending = null;
        p.reject(new SmtpTransportError('PROTOCOL_ERROR', null, 'SMTP socket closed before reply'));
      }
    },
  };
}

/**
 * Map an SMTP reply code to a transport-level error kind, or `null`
 * if the code indicates success. 4xx codes are transient (retryable
 * at the MailerError layer); 5xx codes are permanent. Anything
 * outside [200, 600) is a protocol error.
 */
export function classifyReply(reply: SmtpSocketReply): SmtpTransportError | null {
  if (reply.code >= 200 && reply.code < 400) {
    return null;
  }
  if (reply.code >= 400 && reply.code < 500) {
    return new SmtpTransportError(
      'REJECTED_4XX',
      reply.code,
      `SMTP server returned a 4xx reply (${reply.code})`,
    );
  }
  if (reply.code >= 500 && reply.code < 600) {
    return new SmtpTransportError(
      'REJECTED_5XX',
      reply.code,
      `SMTP server returned a 5xx reply (${reply.code})`,
    );
  }
  return new SmtpTransportError(
    'PROTOCOL_ERROR',
    reply.code,
    `SMTP server returned an unexpected reply code (${reply.code})`,
  );
}

/**
 * Production SMTP dispatcher backed by `Bun.connect`. Performs the
 * minimal HELO/EHLO → MAIL → RCPT → DATA → QUIT handshake against
 * the configured relay.
 */
export const defaultSmtpDispatcher: SmtpDispatcher = async (
  input: SmtpDispatchInput,
): Promise<SmtpDispatchResult> => {
  const { host, port } = parseRelayUrl(input.relayUrl);
  const timeoutMs = input.timeoutMs ?? 5_000;
  const ehloDomain = input.ehloDomain ?? 'localhost';
  const reader = makeReplyReader();

  // Bun.connect is the lowest-level Bun TCP API and is the cleanest
  // way to drive an SMTP conversation without pulling Node's `net`
  // module into the runtime path.
  const socket = await Bun.connect({
    hostname: host,
    port,
    socket: {
      data(_sock, data): void {
        reader.push(data);
      },
      close(): void {
        reader.end();
      },
      error(_sock, err): void {
        reader.fail(
          new SmtpTransportError('CONNECT_FAILED', null, `SMTP socket error: ${err.name}`),
        );
      },
      connectError(_sock, err): void {
        reader.fail(
          new SmtpTransportError('CONNECT_FAILED', null, `SMTP connect failed: ${err.name}`),
        );
      },
    },
  }).catch((err: unknown) => {
    // `Bun.connect` rejects on synchronous DNS / refused-connection
    // failures. Normalise so the caller sees one error shape.
    const name = err instanceof Error ? err.name : 'UnknownError';
    throw new SmtpTransportError('CONNECT_FAILED', null, `SMTP connect failed: ${name}`);
  });

  const sock: BunSocketLike = socket as BunSocketLike;

  try {
    // Banner.
    const banner = await reader.read(timeoutMs);
    const bannerError = classifyReply(banner);
    if (bannerError) throw bannerError;

    // EHLO.
    sock.write(`EHLO ${ehloDomain}\r\n`);
    const ehlo = await reader.read(timeoutMs);
    const ehloError = classifyReply(ehlo);
    if (ehloError) throw ehloError;

    // MAIL FROM.
    sock.write(`MAIL FROM:<${input.envelopeFrom}>\r\n`);
    const mail = await reader.read(timeoutMs);
    const mailError = classifyReply(mail);
    if (mailError) throw mailError;

    // RCPT TO.
    sock.write(`RCPT TO:<${input.envelopeTo}>\r\n`);
    const rcpt = await reader.read(timeoutMs);
    const rcptError = classifyReply(rcpt);
    if (rcptError) throw rcptError;

    // DATA — server should reply 354 "go ahead".
    sock.write('DATA\r\n');
    const data = await reader.read(timeoutMs);
    if (data.code !== 354) {
      const dataError = classifyReply(data);
      throw (
        dataError ??
        new SmtpTransportError(
          'PROTOCOL_ERROR',
          data.code,
          `Expected 354 after DATA, got ${data.code}`,
        )
      );
    }

    // Body + terminator.
    sock.write(dotStuffMessage(input.messageData));
    const finalReply = await reader.read(timeoutMs);
    const finalError = classifyReply(finalReply);
    if (finalError) throw finalError;

    const messageId = parseMessageIdFromReply(finalReply.text);

    // QUIT — best-effort; we don't read the 221 reply because we
    // already have the success signal.
    try {
      sock.write('QUIT\r\n');
    } catch {
      /* ignore — connection might already be closing */
    }

    return { messageId };
  } finally {
    try {
      sock.end();
    } catch {
      /* already closed */
    }
  }
};
