import { describe, it, expect } from 'bun:test';

import { StubMailerClient } from '../../../src/infra/mail/StubMailerClient';
import { MailerError, isMailerError } from '../../../src/infra/mail/MailerError';
import {
  SmtpTransportError,
  type SmtpDispatchInput,
  type SmtpDispatchResult,
  type SmtpDispatcher,
} from '../../../src/infra/mail/smtpTransport';
import type { SendInviteInput } from '../../../src/infra/mail/MailerClient';

const VALID_INPUT: SendInviteInput = {
  to: 'invitee@example.com',
  inviterName: 'Alice',
  workspaceName: 'Acme',
  inviteUrl:
    'http://localhost:3100/invite/abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  expiresAt: '2026-12-31T00:00:00.000Z',
};

const FIXED_NOW = (): Date => new Date('2026-06-02T12:00:00.000Z');
const FIXED_ID = 'msg-fixed-uuid-0001';

// ──────────────────────────────────────────────────────────────────────────
// stdout mode
// ──────────────────────────────────────────────────────────────────────────

describe('StubMailerClient — stdout mode (MAIL-2)', () => {
  it('writes a single JSON line to the configured sink and returns the messageId', async () => {
    const lines: string[] = [];
    const client = new StubMailerClient({
      mode: 'stdout',
      stdoutSink: (line) => lines.push(line),
      idFactory: () => FIXED_ID,
      now: FIXED_NOW,
    });
    const result = await client.sendInvite(VALID_INPUT);
    expect(result).toEqual({ messageId: FIXED_ID });
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({
      ts: '2026-06-02T12:00:00.000Z',
      event: 'mail.invite.dispatched',
      mode: 'stub:stdout',
      messageId: FIXED_ID,
      to: 'invitee@example.com',
      workspaceName: 'Acme',
      expiresAt: '2026-12-31T00:00:00.000Z',
    });
  });

  it('masks the invite token in the stdout record (token NEVER leaks)', async () => {
    const lines: string[] = [];
    const client = new StubMailerClient({
      mode: 'stdout',
      stdoutSink: (line) => lines.push(line),
      idFactory: () => FIXED_ID,
      now: FIXED_NOW,
    });
    await client.sendInvite(VALID_INPUT);
    const raw = lines[0];
    // Regression guard: the full token never appears anywhere in the
    // stdout JSON. The masked field is the only acceptable surface.
    expect(raw).not.toContain('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
    const record = JSON.parse(raw);
    expect(record.inviteUrlMasked).toContain('***');
    expect(record.inviteUrlMasked).toContain('/invite/***');
    // The last 8 chars of the token are revealed for operator spot-checks.
    expect(record.inviteUrlMasked).toEndWith('23456789');
  });

  it('omits the inviterName (PII minimisation in dev logs)', async () => {
    const lines: string[] = [];
    const client = new StubMailerClient({
      mode: 'stdout',
      stdoutSink: (line) => lines.push(line),
      idFactory: () => FIXED_ID,
      now: FIXED_NOW,
    });
    await client.sendInvite({
      ...VALID_INPUT,
      inviterName: 'Alice Sensitive',
    });
    const record = JSON.parse(lines[0]);
    expect(record).not.toHaveProperty('inviterName');
    // Defense-in-depth: full string sweep.
    expect(lines[0]).not.toContain('Alice Sensitive');
  });

  it('reports `mode = "stdout"` on the public mode accessor', () => {
    const client = new StubMailerClient({ mode: 'stdout' });
    expect(client.mode).toBe('stdout');
  });

  it('defaults to console.log when no sink is supplied', async () => {
    // Replace console.log for the duration of the test only.
    const originalLog = console.log;
    const captured: unknown[][] = [];
    console.log = (...args: unknown[]) => captured.push(args);
    try {
      const client = new StubMailerClient({
        mode: 'stdout',
        idFactory: () => FIXED_ID,
        now: FIXED_NOW,
      });
      const result = await client.sendInvite(VALID_INPUT);
      expect(result).toEqual({ messageId: FIXED_ID });
      expect(captured).toHaveLength(1);
      // Each call to the default sink passes a single string.
      expect(typeof captured[0][0]).toBe('string');
      const parsed = JSON.parse(captured[0][0] as string);
      expect(parsed.messageId).toBe(FIXED_ID);
    } finally {
      console.log = originalLog;
    }
  });

  it('throws RECIPIENT_INVALID for malformed email addresses', async () => {
    const client = new StubMailerClient({
      mode: 'stdout',
      stdoutSink: () => {
        /* should never fire */
      },
    });
    for (const bad of ['', '   ', 'no-at-sign', 'no@domain', '@no-local']) {
      try {
        await client.sendInvite({ ...VALID_INPUT, to: bad });
        throw new Error(`expected throw for ${bad}`);
      } catch (err) {
        expect(isMailerError(err)).toBe(true);
        expect((err as MailerError).code).toBe('RECIPIENT_INVALID');
      }
    }
  });

  it('throws TEMPLATE_RENDER_FAILED for missing required fields', async () => {
    const client = new StubMailerClient({ mode: 'stdout' });
    const sinks = [
      { ...VALID_INPUT, inviteUrl: '' },
      { ...VALID_INPUT, inviteUrl: '   ' },
      { ...VALID_INPUT, workspaceName: '' },
      { ...VALID_INPUT, expiresAt: '' },
    ];
    for (const input of sinks) {
      try {
        await client.sendInvite(input);
        throw new Error('expected throw');
      } catch (err) {
        expect(isMailerError(err)).toBe(true);
        expect((err as MailerError).code).toBe('TEMPLATE_RENDER_FAILED');
      }
    }
  });

  it('surfaces PROVIDER_UNAVAILABLE if the stdout sink throws', async () => {
    const client = new StubMailerClient({
      mode: 'stdout',
      stdoutSink: () => {
        throw new Error('disk is full or whatever');
      },
    });
    try {
      await client.sendInvite(VALID_INPUT);
      throw new Error('expected throw');
    } catch (err) {
      expect(isMailerError(err)).toBe(true);
      expect((err as MailerError).code).toBe('PROVIDER_UNAVAILABLE');
      // No upstream sink-error text in the surfaced message.
      expect((err as MailerError).message).not.toContain('disk is full');
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// SMTP relay mode
// ──────────────────────────────────────────────────────────────────────────

type CapturedDispatch = {
  input: SmtpDispatchInput;
};

function makeFakeDispatcher(
  reply: SmtpDispatchResult | SmtpTransportError | Error,
  captureSink?: CapturedDispatch[],
): SmtpDispatcher {
  return async (input): Promise<SmtpDispatchResult> => {
    captureSink?.push({ input });
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  };
}

describe('StubMailerClient — SMTP relay mode (MAIL-2)', () => {
  it('routes through the injected dispatcher and forwards envelope + headers', async () => {
    const captured: CapturedDispatch[] = [];
    const dispatcher = makeFakeDispatcher({ messageId: 'inbucket-msg-001' }, captured);
    const client = new StubMailerClient({
      mode: 'smtp_relay',
      relayUrl: 'smtp://127.0.0.1:54325',
      fromAddress: 'no-reply@xynes.local',
      smtpDispatcher: dispatcher,
      idFactory: () => FIXED_ID,
      now: FIXED_NOW,
    });

    const result = await client.sendInvite(VALID_INPUT);
    expect(result).toEqual({ messageId: 'inbucket-msg-001' });

    expect(captured).toHaveLength(1);
    const sent = captured[0].input;
    expect(sent.relayUrl).toBe('smtp://127.0.0.1:54325');
    expect(sent.envelopeFrom).toBe('no-reply@xynes.local');
    expect(sent.envelopeTo).toBe('invitee@example.com');

    // Headers are present and well-formed.
    expect(sent.messageData).toContain('From: no-reply@xynes.local');
    expect(sent.messageData).toContain('To: invitee@example.com');
    expect(sent.messageData).toContain("Subject: You've been invited to Acme on Xynes");
    expect(sent.messageData).toContain(`Message-Id: <${FIXED_ID}@xynes.local>`);
    expect(sent.messageData).toContain('MIME-Version: 1.0');
    expect(sent.messageData).toContain('Content-Type: text/plain; charset=utf-8');
    // Body carries the inviter + workspace + full invite URL.
    expect(sent.messageData).toContain('Alice has invited you to join Acme');
    expect(sent.messageData).toContain(VALID_INPUT.inviteUrl);
    // 2026-06-03 polish: expiresAt is rendered via Intl ('en-US', UTC) into
    // 'Month D, YYYY' to match `ResendMailerClient.composeTextBody`. The raw
    // ISO is intentionally NOT present in the rendered body.
    expect(sent.messageData).toContain('December 31, 2026');
    expect(sent.messageData).not.toContain(VALID_INPUT.expiresAt);
  });

  it('prefers the server-issued messageId over the locally synthesised one', async () => {
    const dispatcher = makeFakeDispatcher({
      messageId: 'server-issued-id-42',
    });
    const client = new StubMailerClient({
      mode: 'smtp_relay',
      relayUrl: 'smtp://127.0.0.1:54325',
      fromAddress: 'from@example.com',
      smtpDispatcher: dispatcher,
      idFactory: () => 'local-id-99',
    });
    const result = await client.sendInvite(VALID_INPUT);
    expect(result).toEqual({ messageId: 'server-issued-id-42' });
  });

  it('falls back to the locally synthesised id when the relay does not surface one', async () => {
    const dispatcher = makeFakeDispatcher({ messageId: null });
    const client = new StubMailerClient({
      mode: 'smtp_relay',
      relayUrl: 'smtp://127.0.0.1:54325',
      fromAddress: 'from@example.com',
      smtpDispatcher: dispatcher,
      idFactory: () => 'local-id-99',
    });
    const result = await client.sendInvite(VALID_INPUT);
    expect(result).toEqual({ messageId: 'local-id-99' });
  });

  it('uses the documented fallback inviter copy when inviterName is null', async () => {
    const captured: CapturedDispatch[] = [];
    const dispatcher = makeFakeDispatcher({ messageId: null }, captured);
    const client = new StubMailerClient({
      mode: 'smtp_relay',
      relayUrl: 'smtp://127.0.0.1:54325',
      fromAddress: 'from@example.com',
      smtpDispatcher: dispatcher,
    });
    await client.sendInvite({ ...VALID_INPUT, inviterName: null });
    expect(captured[0].input.messageData).toContain("You've been invited to join Acme on Xynes");
    expect(captured[0].input.messageData).not.toContain('null');
  });

  it('sanitises CRLF / tab header injection in workspaceName', async () => {
    const captured: CapturedDispatch[] = [];
    const dispatcher = makeFakeDispatcher({ messageId: null }, captured);
    const client = new StubMailerClient({
      mode: 'smtp_relay',
      relayUrl: 'smtp://127.0.0.1:54325',
      fromAddress: 'from@example.com',
      smtpDispatcher: dispatcher,
    });
    await client.sendInvite({
      ...VALID_INPUT,
      workspaceName: 'Acme\r\nBcc: attacker@example.com',
    });
    const message = captured[0].input.messageData;
    // SECURITY INVARIANT: the hostile CRLF must be replaced so no
    // new header line can appear in the headers block. workspaceName
    // is interpolated into the Subject header, so the hostile string
    // may collapse into the Subject line as plain text (ugly but
    // harmless — an attacker cannot make `Bcc:` a real header). The
    // body block also interpolates workspaceName for the invite copy.
    const headersBlock = message.split('\r\n\r\n')[0];
    // No CR/LF inside the headers block — every header is on its own
    // line and the block ends with the blank-line separator that we
    // already split on.
    const headerLines = headersBlock.split('\r\n');
    // Every line must match the well-formed header pattern
    // `<token>:<rest>` — no smuggled raw text masquerading as a header.
    for (const line of headerLines) {
      expect(line).toMatch(/^[A-Za-z0-9-]+:/);
    }
    // Defense-in-depth: no header LINE starts with `Bcc:` (the
    // injection target). The Subject line still includes the
    // hostile literal as plain text within its value, which is
    // cosmetic only and cannot be parsed as a separate header.
    const bccLines = headerLines.filter((l) => /^Bcc:/i.test(l));
    expect(bccLines).toHaveLength(0);
  });

  it('sanitises CRLF injection in the inviterName', async () => {
    const captured: CapturedDispatch[] = [];
    const dispatcher = makeFakeDispatcher({ messageId: null }, captured);
    const client = new StubMailerClient({
      mode: 'smtp_relay',
      relayUrl: 'smtp://127.0.0.1:54325',
      fromAddress: 'from@example.com',
      smtpDispatcher: dispatcher,
    });
    await client.sendInvite({
      ...VALID_INPUT,
      inviterName: 'Alice\r\nReply-To: evil@example.com',
    });
    const message = captured[0].input.messageData;
    const headersBlock = message.split('\r\n\r\n')[0];
    // SECURITY INVARIANT: no new header line gets injected. The
    // sanitiser replaces the CRLF with a space so the hostile string
    // collapses into a single line of body text — never a header.
    expect(headersBlock).not.toMatch(/^Reply-To:/im);
    expect(headersBlock).not.toContain('evil@example.com');
  });

  it('reports `mode = "smtp_relay"` on the public mode accessor', () => {
    const client = new StubMailerClient({
      mode: 'smtp_relay',
      relayUrl: 'smtp://127.0.0.1:54325',
      fromAddress: 'from@example.com',
      smtpDispatcher: makeFakeDispatcher({ messageId: null }),
    });
    expect(client.mode).toBe('smtp_relay');
  });

  // ── error mapping ─────────────────────────────────────────────────────

  it('maps CONNECT_FAILED to PROVIDER_UNAVAILABLE (retryable)', async () => {
    const dispatcher = makeFakeDispatcher(
      new SmtpTransportError('CONNECT_FAILED', null, 'connection refused'),
    );
    const client = new StubMailerClient({
      mode: 'smtp_relay',
      relayUrl: 'smtp://127.0.0.1:54325',
      fromAddress: 'from@example.com',
      smtpDispatcher: dispatcher,
    });
    try {
      await client.sendInvite(VALID_INPUT);
      throw new Error('expected throw');
    } catch (err) {
      expect(isMailerError(err)).toBe(true);
      expect((err as MailerError).code).toBe('PROVIDER_UNAVAILABLE');
      expect((err as MailerError).retryable).toBe(true);
      // Defense-in-depth: no upstream "connection refused" text.
      expect((err as MailerError).message).not.toContain('connection refused');
    }
  });

  it('maps TIMEOUT to PROVIDER_UNAVAILABLE (retryable)', async () => {
    const dispatcher = makeFakeDispatcher(
      new SmtpTransportError('TIMEOUT', null, 'smtp read timeout'),
    );
    const client = new StubMailerClient({
      mode: 'smtp_relay',
      relayUrl: 'smtp://127.0.0.1:54325',
      fromAddress: 'from@example.com',
      smtpDispatcher: dispatcher,
    });
    try {
      await client.sendInvite(VALID_INPUT);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('PROVIDER_UNAVAILABLE');
      expect((err as MailerError).retryable).toBe(true);
    }
  });

  it('maps REJECTED_4XX to PROVIDER_UNAVAILABLE (retryable)', async () => {
    const dispatcher = makeFakeDispatcher(new SmtpTransportError('REJECTED_4XX', 421, 'try later'));
    const client = new StubMailerClient({
      mode: 'smtp_relay',
      relayUrl: 'smtp://127.0.0.1:54325',
      fromAddress: 'from@example.com',
      smtpDispatcher: dispatcher,
    });
    try {
      await client.sendInvite(VALID_INPUT);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('PROVIDER_UNAVAILABLE');
    }
  });

  it('maps SMTP 550 to RECIPIENT_INVALID (non-retryable)', async () => {
    const dispatcher = makeFakeDispatcher(
      new SmtpTransportError('REJECTED_5XX', 550, 'mailbox unavailable'),
    );
    const client = new StubMailerClient({
      mode: 'smtp_relay',
      relayUrl: 'smtp://127.0.0.1:54325',
      fromAddress: 'from@example.com',
      smtpDispatcher: dispatcher,
    });
    try {
      await client.sendInvite(VALID_INPUT);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('RECIPIENT_INVALID');
      expect((err as MailerError).retryable).toBe(false);
    }
  });

  it('maps SMTP 553 (address rejected) to RECIPIENT_INVALID', async () => {
    const dispatcher = makeFakeDispatcher(
      new SmtpTransportError('REJECTED_5XX', 553, 'address rejected'),
    );
    const client = new StubMailerClient({
      mode: 'smtp_relay',
      relayUrl: 'smtp://127.0.0.1:54325',
      fromAddress: 'from@example.com',
      smtpDispatcher: dispatcher,
    });
    try {
      await client.sendInvite(VALID_INPUT);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('RECIPIENT_INVALID');
    }
  });

  it('maps other 5xx codes to PROVIDER_REJECTED (non-retryable)', async () => {
    const dispatcher = makeFakeDispatcher(
      new SmtpTransportError('REJECTED_5XX', 554, 'transaction failed'),
    );
    const client = new StubMailerClient({
      mode: 'smtp_relay',
      relayUrl: 'smtp://127.0.0.1:54325',
      fromAddress: 'from@example.com',
      smtpDispatcher: dispatcher,
    });
    try {
      await client.sendInvite(VALID_INPUT);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('PROVIDER_REJECTED');
      expect((err as MailerError).retryable).toBe(false);
    }
  });

  it('maps PROTOCOL_ERROR to PROVIDER_REJECTED', async () => {
    const dispatcher = makeFakeDispatcher(
      new SmtpTransportError('PROTOCOL_ERROR', null, 'unexpected reply'),
    );
    const client = new StubMailerClient({
      mode: 'smtp_relay',
      relayUrl: 'smtp://127.0.0.1:54325',
      fromAddress: 'from@example.com',
      smtpDispatcher: dispatcher,
    });
    try {
      await client.sendInvite(VALID_INPUT);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('PROVIDER_REJECTED');
    }
  });

  it('catches a non-SmtpTransportError from the dispatcher and maps it to PROVIDER_UNAVAILABLE without leaking upstream text', async () => {
    const hostile = new Error('AKIA-LEAK-1234 X-Amz-Signature=DEADBEEF xynes_live_abc');
    const dispatcher = makeFakeDispatcher(hostile);
    const client = new StubMailerClient({
      mode: 'smtp_relay',
      relayUrl: 'smtp://127.0.0.1:54325',
      fromAddress: 'from@example.com',
      smtpDispatcher: dispatcher,
    });
    try {
      await client.sendInvite(VALID_INPUT);
      throw new Error('expected throw');
    } catch (err) {
      expect(isMailerError(err)).toBe(true);
      expect((err as MailerError).code).toBe('PROVIDER_UNAVAILABLE');
      // CRITICAL: hostile substrings must NOT survive into the
      // surfaced error message.
      expect((err as MailerError).message).not.toContain('AKIA-LEAK-1234');
      expect((err as MailerError).message).not.toContain('X-Amz-Signature=DEADBEEF');
      expect((err as MailerError).message).not.toContain('xynes_live_abc');
    }
  });

  it('pre-validates email BEFORE invoking the dispatcher (no socket on bad input)', async () => {
    const captured: CapturedDispatch[] = [];
    const dispatcher = makeFakeDispatcher({ messageId: null }, captured);
    const client = new StubMailerClient({
      mode: 'smtp_relay',
      relayUrl: 'smtp://127.0.0.1:54325',
      fromAddress: 'from@example.com',
      smtpDispatcher: dispatcher,
    });
    try {
      await client.sendInvite({ ...VALID_INPUT, to: 'not-an-email' });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('RECIPIENT_INVALID');
    }
    expect(captured).toHaveLength(0);
  });

  it('forwards the configured timeoutMs to the dispatcher', async () => {
    const captured: CapturedDispatch[] = [];
    const dispatcher = makeFakeDispatcher({ messageId: null }, captured);
    const client = new StubMailerClient({
      mode: 'smtp_relay',
      relayUrl: 'smtp://127.0.0.1:54325',
      fromAddress: 'from@example.com',
      smtpDispatcher: dispatcher,
      timeoutMs: 1234,
    });
    await client.sendInvite(VALID_INPUT);
    expect(captured[0].input.timeoutMs).toBe(1234);
  });
});
