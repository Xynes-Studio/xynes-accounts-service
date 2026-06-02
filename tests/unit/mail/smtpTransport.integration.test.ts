/**
 * MAIL-2 — Integration test for the production SMTP dispatcher.
 *
 * Boots an in-process TCP server via `Bun.listen` that speaks just
 * enough of the SMTP dialect to drive `defaultSmtpDispatcher` through
 * its full state machine (banner → EHLO → MAIL FROM → RCPT TO → DATA
 * → body → QUIT). The fake server captures the bytes it received so
 * we can assert what the dispatcher wrote, and replies with scripted
 * codes to exercise the success path AND the 5xx-rejection path
 * without leaving the test process.
 *
 * Why a real socket? `defaultSmtpDispatcher` calls `Bun.connect` and
 * the socket-data callback chain is hard to mock convincingly with a
 * fake. An in-process listener is the cleanest way to cover the
 * production-only code paths (read-buffer, line splitting, multi-line
 * reply termination, connection close).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { defaultSmtpDispatcher, SmtpTransportError } from '../../../src/infra/mail/smtpTransport';

type ServerScript = {
  // Bytes the server writes immediately on connect (banner).
  banner: string;
  // Reply to send after each client request, in order.
  replies: string[];
  // What the server should do once the message body is received.
  // 'reply' uses the next entry in `replies`; 'closeAfterData' simulates
  // a relay that hangs up immediately after DATA terminator.
  afterData?: 'reply' | 'closeAfterData';
  // When set, the server emits an unsolicited final reply DURING the
  // banner instead of the canonical 220. Used by the multi-line test.
  bannerLines?: string[];
};

type ServerHandle = {
  port: number;
  receivedLines: string[];
  receivedBody: string;
  stop: () => void;
};

async function startFakeSmtpServer(script: ServerScript): Promise<ServerHandle> {
  const receivedLines: string[] = [];
  let receivedBody = '';
  // Use `any` for the server reference because `Bun.listen` returns a
  // union of TCPSocketListener | UnixSocketListener and `ReturnType`
  // collapses to the wider type — assigning the TCP-only result to it
  // fails the missing-`unix` property check. We only need `.port` and
  // `.stop()` at the call sites; both are present on the TCP variant.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let serverRef: any = null;
  let resolvePort: (port: number) => void;
  const portPromise = new Promise<number>((r) => {
    resolvePort = r;
  });

  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket): void {
        // Per-connection state machine.
        const state = {
          inData: false,
          buffer: '',
          replyIdx: 0,
          // Track whether we've completed DATA so the next CRLF.CRLF
          // closes the message body.
          dataBody: '',
        };
        (socket as unknown as { _state: typeof state })._state = state;
        // Send banner.
        if (script.bannerLines && script.bannerLines.length > 0) {
          socket.write(script.bannerLines.join('\r\n') + '\r\n');
        } else {
          socket.write(script.banner);
        }
      },
      data(socket, chunk): void {
        const s = (socket as unknown as { _state: ServerStateLike })._state;
        const text = new TextDecoder().decode(chunk);
        s.buffer += text;
        // Process line-by-line in command mode; in DATA mode, accumulate
        // until we see the terminator `\r\n.\r\n`.
        if (!s.inData) {
          let idx: number;
          while ((idx = s.buffer.indexOf('\r\n')) !== -1) {
            const line = s.buffer.slice(0, idx);
            s.buffer = s.buffer.slice(idx + 2);
            receivedLines.push(line);
            if (line === 'DATA') {
              socket.write('354 go ahead\r\n');
              s.inData = true;
              break;
            }
            const reply = script.replies[s.replyIdx];
            s.replyIdx += 1;
            socket.write(reply);
            if (line.startsWith('QUIT')) {
              socket.end();
              return;
            }
          }
        }
        if (s.inData) {
          // Look for the SMTP end-of-data marker.
          const terminator = '\r\n.\r\n';
          const term = s.buffer.indexOf(terminator);
          if (term !== -1) {
            s.dataBody += s.buffer.slice(0, term);
            s.buffer = s.buffer.slice(term + terminator.length);
            receivedBody = s.dataBody;
            s.inData = false;
            if (script.afterData === 'closeAfterData') {
              socket.end();
              return;
            }
            const reply = script.replies[s.replyIdx];
            s.replyIdx += 1;
            socket.write(reply);
          } else {
            // Keep buffering, but move what we have into dataBody so
            // multi-chunk bodies still accumulate.
            s.dataBody += s.buffer;
            s.buffer = '';
          }
        }
      },
      close(): void {},
      error(): void {},
    },
  });
  serverRef = server;
  // Bun.listen returns synchronously with a `.port` accessor.
  resolvePort!(server.port);
  const port = await portPromise;
  return {
    port,
    get receivedLines(): string[] {
      return receivedLines;
    },
    get receivedBody(): string {
      return receivedBody;
    },
    stop(): void {
      serverRef?.stop();
    },
  };
}

type ServerStateLike = {
  inData: boolean;
  buffer: string;
  replyIdx: number;
  dataBody: string;
};

// ──────────────────────────────────────────────────────────────────────────

describe('defaultSmtpDispatcher (MAIL-2, real Bun.connect)', () => {
  let server: ServerHandle | null = null;

  beforeAll(() => {
    // Each test boots its own server.
  });

  afterAll(() => {
    server?.stop();
  });

  it('completes a single EHLO/MAIL/RCPT/DATA handshake against an in-process relay', async () => {
    server = await startFakeSmtpServer({
      banner: '220 fake.test ESMTP ready\r\n',
      replies: [
        '250-fake.test\r\n250 SIZE 10485760\r\n', // EHLO multi-line
        '250 2.0.0 Ok\r\n', // MAIL FROM
        '250 2.0.0 Ok\r\n', // RCPT TO
        '250 2.0.0 Ok: queued as <01HQXTEST123>\r\n', // After DATA body
      ],
    });

    const result = await defaultSmtpDispatcher({
      relayUrl: `smtp://127.0.0.1:${server.port}`,
      envelopeFrom: 'sender@example.com',
      envelopeTo: 'recipient@example.com',
      messageData: 'Subject: hi\r\n\r\nbody',
      timeoutMs: 2_000,
    });

    expect(result.messageId).toBe('01HQXTEST123');
    expect(server.receivedLines[0]).toBe('EHLO localhost');
    expect(server.receivedLines[1]).toBe('MAIL FROM:<sender@example.com>');
    expect(server.receivedLines[2]).toBe('RCPT TO:<recipient@example.com>');
    expect(server.receivedLines[3]).toBe('DATA');
    expect(server.receivedBody).toContain('Subject: hi');
    expect(server.receivedBody).toContain('body');
  });

  it('uses the configured ehloDomain', async () => {
    server = await startFakeSmtpServer({
      banner: '220 fake.test ESMTP\r\n',
      replies: [
        '250 OK\r\n', // EHLO
        '250 OK\r\n', // MAIL FROM
        '250 OK\r\n', // RCPT TO
        '250 OK\r\n', // After body
      ],
    });
    await defaultSmtpDispatcher({
      relayUrl: `smtp://127.0.0.1:${server.port}`,
      envelopeFrom: 'a@b.c',
      envelopeTo: 'd@e.f',
      messageData: 'body',
      ehloDomain: 'custom.domain',
    });
    expect(server.receivedLines[0]).toBe('EHLO custom.domain');
  });

  it('returns null messageId when the relay 250 has no <...> capture', async () => {
    server = await startFakeSmtpServer({
      banner: '220 fake.test\r\n',
      replies: ['250 OK\r\n', '250 OK\r\n', '250 OK\r\n', '250 Ok no id here\r\n'],
    });
    const result = await defaultSmtpDispatcher({
      relayUrl: `smtp://127.0.0.1:${server.port}`,
      envelopeFrom: 'a@b.c',
      envelopeTo: 'd@e.f',
      messageData: 'body',
    });
    expect(result.messageId).toBeNull();
  });

  it('rejects with REJECTED_5XX when the relay replies 550', async () => {
    server = await startFakeSmtpServer({
      banner: '220 fake.test\r\n',
      replies: [
        '250 OK\r\n', // EHLO
        '550 5.1.1 mailbox unavailable\r\n', // MAIL FROM
      ],
    });
    try {
      await defaultSmtpDispatcher({
        relayUrl: `smtp://127.0.0.1:${server.port}`,
        envelopeFrom: 'a@b.c',
        envelopeTo: 'd@e.f',
        messageData: 'body',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SmtpTransportError);
      expect((err as SmtpTransportError).kind).toBe('REJECTED_5XX');
      expect((err as SmtpTransportError).replyCode).toBe(550);
      // Defense in depth: no upstream text leaks into the message.
      expect((err as SmtpTransportError).message).not.toContain('mailbox');
    }
  });

  it('rejects with REJECTED_4XX when the relay replies 421', async () => {
    server = await startFakeSmtpServer({
      banner: '220 fake.test\r\n',
      replies: [
        '421 4.7.0 service shutting down, try later\r\n', // banner-like reply after EHLO
      ],
    });
    try {
      await defaultSmtpDispatcher({
        relayUrl: `smtp://127.0.0.1:${server.port}`,
        envelopeFrom: 'a@b.c',
        envelopeTo: 'd@e.f',
        messageData: 'body',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as SmtpTransportError).kind).toBe('REJECTED_4XX');
      expect((err as SmtpTransportError).replyCode).toBe(421);
    }
  });

  it('rejects with CONNECT_FAILED when the relay address is unreachable', async () => {
    try {
      await defaultSmtpDispatcher({
        // Reserved test port 1 reliably refuses connections.
        relayUrl: 'smtp://127.0.0.1:1',
        envelopeFrom: 'a@b.c',
        envelopeTo: 'd@e.f',
        messageData: 'body',
        timeoutMs: 1_000,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SmtpTransportError);
      expect((err as SmtpTransportError).kind).toBe('CONNECT_FAILED');
    }
  });

  it('rejects with REJECTED_5XX when the body is rejected post-DATA', async () => {
    server = await startFakeSmtpServer({
      banner: '220 fake.test\r\n',
      replies: [
        '250 OK\r\n', // EHLO
        '250 OK\r\n', // MAIL FROM
        '250 OK\r\n', // RCPT TO
        '554 5.7.1 transaction failed\r\n', // body rejected after DATA + body
      ],
    });
    try {
      await defaultSmtpDispatcher({
        relayUrl: `smtp://127.0.0.1:${server.port}`,
        envelopeFrom: 'a@b.c',
        envelopeTo: 'd@e.f',
        messageData: 'body',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as SmtpTransportError).kind).toBe('REJECTED_5XX');
      expect((err as SmtpTransportError).replyCode).toBe(554);
    }
  });

  it('throws TIMEOUT when the relay stops responding mid-handshake', async () => {
    server = await startFakeSmtpServer({
      banner: '220 fake.test\r\n',
      replies: [
        // No reply at all to EHLO — the dispatcher should time out.
      ],
    });
    try {
      await defaultSmtpDispatcher({
        relayUrl: `smtp://127.0.0.1:${server.port}`,
        envelopeFrom: 'a@b.c',
        envelopeTo: 'd@e.f',
        messageData: 'body',
        timeoutMs: 150,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SmtpTransportError);
      expect((err as SmtpTransportError).kind).toBe('TIMEOUT');
    }
  });

  it('throws PROTOCOL_ERROR when the relay closes the socket before any reply arrives', async () => {
    // Server that closes immediately on connect.
    const server2 = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open(sock): void {
          sock.end();
        },
        data(): void {},
        close(): void {},
        error(): void {},
      },
    });
    try {
      try {
        await defaultSmtpDispatcher({
          relayUrl: `smtp://127.0.0.1:${server2.port}`,
          envelopeFrom: 'a@b.c',
          envelopeTo: 'd@e.f',
          messageData: 'body',
          timeoutMs: 500,
        });
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(SmtpTransportError);
        // Either CONNECT_FAILED (socket closes during open) or
        // PROTOCOL_ERROR (socket closes between open and first reply).
        const kind = (err as SmtpTransportError).kind;
        expect(['PROTOCOL_ERROR', 'CONNECT_FAILED']).toContain(kind);
      }
    } finally {
      server2.stop();
    }
  });

  it('parses multi-line EHLO replies (continuation `-` then space-terminator)', async () => {
    server = await startFakeSmtpServer({
      banner: '220 fake.test ESMTP ready\r\n',
      replies: [
        '250-fake.test\r\n250-PIPELINING\r\n250-SIZE 10485760\r\n250 8BITMIME\r\n',
        '250 OK\r\n',
        '250 OK\r\n',
        '250 OK <01HQXMULTI>\r\n',
      ],
    });
    const result = await defaultSmtpDispatcher({
      relayUrl: `smtp://127.0.0.1:${server.port}`,
      envelopeFrom: 'a@b.c',
      envelopeTo: 'd@e.f',
      messageData: 'body',
      timeoutMs: 2_000,
    });
    expect(result.messageId).toBe('01HQXMULTI');
  });
});
