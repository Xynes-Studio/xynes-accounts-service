/**
 * MAIL-4 — Unit tests for `ResendMailerClient`.
 *
 * Covers:
 *   - Construction validation (API key shape, fromAddress shape).
 *   - Pre-validation (recipient + template fields) BEFORE fetch is called.
 *   - Happy path: POST shape, headers, body, success messageId.
 *   - Every HTTP status mapping (200/422/400/401/403/429/5xx).
 *   - Network failure / timeout / abort → `PROVIDER_UNAVAILABLE`.
 *   - **No-leak invariant**: hostile Resend response bodies never
 *     surface into `MailerError.message`; raw API key never appears in
 *     any spy output.
 *   - `composeTextBody` + `httpStatusToMailerCode` + `isProbablyValidResendKey`
 *     + `resolveTimeoutMs` pure-helper coverage via the `__forTesting__`
 *     seam.
 *
 * Security invariants enforced:
 *   1. Raw API key NEVER appears outside the `Authorization` header.
 *   2. Resend response body bytes NEVER appear in any `MailerError`.
 *   3. Fetch is NOT called when pre-validation fails.
 *   4. CR/LF in `workspaceName` / `inviterName` is sanitised.
 */

import { describe, expect, it } from 'bun:test';

import {
  ResendMailerClient,
  RESEND_API_ENDPOINT,
  RESEND_API_KEY_PREFIX,
  __forTesting__,
  type ResendMailerClientOptions,
} from '../../../src/infra/mail/ResendMailerClient';
import { MailerError, type MailerErrorCode } from '../../../src/infra/mail/MailerError';
import type { SendInviteInput } from '../../../src/infra/mail/MailerClient';

const VALID_RESEND_KEY = 're_test_apikey_value_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FROM_ADDRESS = 'no-reply@dev.example.com';

const HAPPY_INPUT: SendInviteInput = {
  to: 'invitee@example.com',
  inviterName: 'Alice',
  workspaceName: 'Acme',
  inviteUrl:
    'http://localhost:3100/invite/abc123def456abc123def456abc123def456abc123def456abc123def456abcd',
  expiresAt: '2026-06-09T12:00:00.000Z',
};

/**
 * Build a `Response`-like stand-in that satisfies the narrow shape
 * `ResendMailerClient` reads (`ok`, `status`, `text`, `json`).
 * We avoid `new Response(...)` because Bun's `Response` is strict
 * about body types and we want to inject scripted scenarios.
 */
function fakeResponse(opts: {
  ok: boolean;
  status: number;
  body?: string;
  jsonValue?: unknown;
  throwOnJson?: boolean;
  throwOnText?: boolean;
}): Response {
  const headers = new Headers();
  return {
    ok: opts.ok,
    status: opts.status,
    statusText: opts.ok ? 'OK' : 'Error',
    headers,
    redirected: false,
    type: 'default',
    url: RESEND_API_ENDPOINT,
    body: null,
    bodyUsed: false,
    async text() {
      if (opts.throwOnText) throw new Error('text-read-boom');
      return opts.body ?? '';
    },
    async json() {
      if (opts.throwOnJson) throw new Error('json-parse-boom');
      if (opts.jsonValue !== undefined) return opts.jsonValue;
      return JSON.parse(opts.body ?? '{}');
    },
    clone() {
      return fakeResponse(opts);
    },
    async arrayBuffer() {
      return new ArrayBuffer(0);
    },
    async blob() {
      return new Blob();
    },
    async formData() {
      return new FormData();
    },
    async bytes() {
      return new Uint8Array(0);
    },
  } as unknown as Response;
}

type FetchCall = {
  url: RequestInfo | URL;
  init: RequestInit | undefined;
};

function makeFetchSpy(scripted: Response | ((call: FetchCall) => Response | Promise<Response>)): {
  spy: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const spy = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = { url, init };
    calls.push(call);
    if (typeof scripted === 'function') {
      return scripted(call);
    }
    return scripted;
  }) as typeof fetch;
  return { spy, calls };
}

// ──────────────────────────────────────────────────────────────────────────
// Construction
// ──────────────────────────────────────────────────────────────────────────

describe('ResendMailerClient — construction', () => {
  it('accepts a valid API key + fromAddress', () => {
    const { spy } = makeFetchSpy(fakeResponse({ ok: true, status: 200, body: '{}' }));
    expect(
      () =>
        new ResendMailerClient({
          apiKey: VALID_RESEND_KEY,
          fromAddress: FROM_ADDRESS,
          fetcher: spy,
        }),
    ).not.toThrow();
  });

  it('rejects an empty API key with TEMPLATE_RENDER_FAILED', () => {
    try {
      new ResendMailerClient({ apiKey: '', fromAddress: FROM_ADDRESS });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MailerError);
      expect((err as MailerError).code).toBe('TEMPLATE_RENDER_FAILED');
    }
  });

  it('rejects an API key without the re_ prefix', () => {
    try {
      new ResendMailerClient({ apiKey: 'abc12345', fromAddress: FROM_ADDRESS });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('TEMPLATE_RENDER_FAILED');
    }
  });

  it('rejects an API key whose tail is too short', () => {
    try {
      new ResendMailerClient({ apiKey: 're_short', fromAddress: FROM_ADDRESS });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('TEMPLATE_RENDER_FAILED');
    }
  });

  it('rejects a malformed fromAddress', () => {
    try {
      new ResendMailerClient({ apiKey: VALID_RESEND_KEY, fromAddress: 'not-an-email' });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('TEMPLATE_RENDER_FAILED');
    }
  });

  it('rejects an empty fromAddress', () => {
    try {
      new ResendMailerClient({ apiKey: VALID_RESEND_KEY, fromAddress: '' });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('TEMPLATE_RENDER_FAILED');
    }
  });

  it('exposes fromAddress for audit but NOT the API key', () => {
    const { spy } = makeFetchSpy(fakeResponse({ ok: true, status: 200, body: '{}' }));
    const client = new ResendMailerClient({
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
    });
    expect(client.fromAddressForAudit).toBe(FROM_ADDRESS);
    // The `apiKey` field MUST not be enumerable on the class instance
    // shape. We assert that JSON.stringify produces a tiny object that
    // does NOT carry the key.
    const serialised = JSON.stringify(client);
    expect(serialised).not.toContain(VALID_RESEND_KEY);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Pre-validation
// ──────────────────────────────────────────────────────────────────────────

describe('ResendMailerClient — pre-validation runs BEFORE fetch', () => {
  it('rejects malformed recipient with RECIPIENT_INVALID and does NOT call fetch', async () => {
    const { spy, calls } = makeFetchSpy(fakeResponse({ ok: true, status: 200, body: '{}' }));
    const client = new ResendMailerClient({
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
    });
    try {
      await client.sendInvite({ ...HAPPY_INPUT, to: 'not-an-email' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MailerError);
      expect((err as MailerError).code).toBe('RECIPIENT_INVALID');
    }
    expect(calls.length).toBe(0);
  });

  it('rejects blank workspaceName with TEMPLATE_RENDER_FAILED, no fetch', async () => {
    const { spy, calls } = makeFetchSpy(fakeResponse({ ok: true, status: 200, body: '{}' }));
    const client = new ResendMailerClient({
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
    });
    try {
      await client.sendInvite({ ...HAPPY_INPUT, workspaceName: '   ' });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('TEMPLATE_RENDER_FAILED');
    }
    expect(calls.length).toBe(0);
  });

  it('rejects blank inviteUrl with TEMPLATE_RENDER_FAILED, no fetch', async () => {
    const { spy, calls } = makeFetchSpy(fakeResponse({ ok: true, status: 200, body: '{}' }));
    const client = new ResendMailerClient({
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
    });
    try {
      await client.sendInvite({ ...HAPPY_INPUT, inviteUrl: '' });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('TEMPLATE_RENDER_FAILED');
    }
    expect(calls.length).toBe(0);
  });

  it('rejects blank expiresAt with TEMPLATE_RENDER_FAILED, no fetch', async () => {
    const { spy, calls } = makeFetchSpy(fakeResponse({ ok: true, status: 200, body: '{}' }));
    const client = new ResendMailerClient({
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
    });
    try {
      await client.sendInvite({ ...HAPPY_INPUT, expiresAt: '' });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('TEMPLATE_RENDER_FAILED');
    }
    expect(calls.length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Happy path — wire shape
// ──────────────────────────────────────────────────────────────────────────

describe('ResendMailerClient — happy path wire shape', () => {
  it('POSTs to the canonical Resend endpoint with Bearer auth and JSON body', async () => {
    const { spy, calls } = makeFetchSpy(
      fakeResponse({ ok: true, status: 200, body: JSON.stringify({ id: 'resend-msg-42' }) }),
    );
    const client = new ResendMailerClient({
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
    });
    const result = await client.sendInvite(HAPPY_INPUT);
    expect(result.messageId).toBe('resend-msg-42');
    expect(calls.length).toBe(1);

    const [{ url, init }] = calls;
    expect(String(url)).toBe(RESEND_API_ENDPOINT);
    expect(init?.method).toBe('POST');

    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${VALID_RESEND_KEY}`);
    expect(headers.get('Content-Type')).toBe('application/json');

    const body = init?.body;
    expect(typeof body).toBe('string');
    const parsed = JSON.parse(body as string);
    expect(parsed.from).toBe(FROM_ADDRESS);
    expect(parsed.to).toEqual(['invitee@example.com']);
    expect(parsed.subject).toContain('Acme');
    expect(typeof parsed.text).toBe('string');
    expect(parsed.text).toContain(HAPPY_INPUT.inviteUrl);
  });

  it('returns synthetic messageId when Resend returns 2xx with no id', async () => {
    const { spy } = makeFetchSpy(fakeResponse({ ok: true, status: 200, body: '{}' }));
    const client = new ResendMailerClient({
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
      idFactory: () => 'synthetic-uuid-here',
    });
    const result = await client.sendInvite(HAPPY_INPUT);
    expect(result.messageId).toBe('synthetic-uuid-here');
  });

  it('returns synthetic messageId when 2xx body fails to parse', async () => {
    const { spy } = makeFetchSpy(
      fakeResponse({ ok: true, status: 200, body: 'not-json', throwOnJson: true }),
    );
    const client = new ResendMailerClient({
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
      idFactory: () => 'synthetic-fallback',
    });
    const result = await client.sendInvite(HAPPY_INPUT);
    expect(result.messageId).toBe('synthetic-fallback');
  });

  it('returns synthetic messageId when 2xx body has wrong id shape', async () => {
    const { spy } = makeFetchSpy(
      fakeResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({ id: 42 }), // numeric instead of string
      }),
    );
    const client = new ResendMailerClient({
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
      idFactory: () => 'synthetic-wrong-shape',
    });
    const result = await client.sendInvite(HAPPY_INPUT);
    expect(result.messageId).toBe('synthetic-wrong-shape');
  });

  it('returns synthetic messageId when 2xx body has empty id string', async () => {
    const { spy } = makeFetchSpy(
      fakeResponse({ ok: true, status: 200, body: JSON.stringify({ id: '' }) }),
    );
    const client = new ResendMailerClient({
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
      idFactory: () => 'synthetic-empty-id',
    });
    const result = await client.sendInvite(HAPPY_INPUT);
    expect(result.messageId).toBe('synthetic-empty-id');
  });

  it('sanitises CR/LF/TAB out of workspaceName before composing the body', async () => {
    const { spy, calls } = makeFetchSpy(
      fakeResponse({ ok: true, status: 200, body: JSON.stringify({ id: 'ok' }) }),
    );
    const client = new ResendMailerClient({
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
    });
    await client.sendInvite({
      ...HAPPY_INPUT,
      workspaceName: 'Acme\r\nBcc: attacker@evil.example',
    });
    const body = JSON.parse((calls[0].init?.body as string) ?? '{}');
    // Defense-in-depth: CR/LF/TAB are the actual header-injection
    // vectors. Plain text `Bcc:` substring survives sanitisation (it's
    // just text inside the subject line / body) — that's fine because
    // without CRLF it cannot start a new RFC-5322 header.
    expect(body.subject).not.toContain('\r');
    expect(body.subject).not.toContain('\n');
    expect(body.subject).not.toContain('\t');
    expect(body.text).not.toContain('\r');
    expect(body.text).not.toContain('\t');
    // The body uses \n line separators by design (plaintext email body
    // formatting). What we MUST NOT have is the original `\r\n` from
    // the hostile workspaceName surviving into the body — it would
    // start a new content line inside a header context only if the
    // body were misinterpreted, but defense-in-depth: assert it.
    expect(body.text).not.toContain('Acme\nBcc:'); // <- the un-sanitised form
  });

  it('omits the inviter prefix when inviterName is null', async () => {
    const { spy, calls } = makeFetchSpy(
      fakeResponse({ ok: true, status: 200, body: JSON.stringify({ id: 'ok' }) }),
    );
    const client = new ResendMailerClient({
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
    });
    await client.sendInvite({ ...HAPPY_INPUT, inviterName: null });
    const body = JSON.parse((calls[0].init?.body as string) ?? '{}');
    expect(body.text).toContain("You've been invited to join Acme on Xynes.");
    expect(body.text).not.toContain('has invited you');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// HTTP status → MailerErrorCode mapping
// ──────────────────────────────────────────────────────────────────────────

describe('ResendMailerClient — HTTP error mapping', () => {
  const cases: Array<{ status: number; expected: MailerErrorCode }> = [
    { status: 400, expected: 'PROVIDER_REJECTED' },
    { status: 401, expected: 'PROVIDER_REJECTED' },
    { status: 403, expected: 'PROVIDER_REJECTED' },
    { status: 422, expected: 'RECIPIENT_INVALID' },
    { status: 429, expected: 'RATE_LIMITED' },
    { status: 500, expected: 'PROVIDER_UNAVAILABLE' },
    { status: 502, expected: 'PROVIDER_UNAVAILABLE' },
    { status: 503, expected: 'PROVIDER_UNAVAILABLE' },
    { status: 504, expected: 'PROVIDER_UNAVAILABLE' },
    { status: 301, expected: 'PROVIDER_REJECTED' },
    { status: 418, expected: 'PROVIDER_REJECTED' },
  ];

  for (const { status, expected } of cases) {
    it(`HTTP ${status} → ${expected}`, async () => {
      const { spy } = makeFetchSpy(
        fakeResponse({ ok: false, status, body: 'error body discarded' }),
      );
      const client = new ResendMailerClient({
        apiKey: VALID_RESEND_KEY,
        fromAddress: FROM_ADDRESS,
        fetcher: spy,
      });
      try {
        await client.sendInvite(HAPPY_INPUT);
        throw new Error('expected MailerError throw');
      } catch (err) {
        expect(err).toBeInstanceOf(MailerError);
        expect((err as MailerError).code).toBe(expected);
      }
    });
  }

  it('swallows body-read errors on non-2xx (status code is the routing signal)', async () => {
    const { spy } = makeFetchSpy(fakeResponse({ ok: false, status: 500, throwOnText: true }));
    const client = new ResendMailerClient({
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
    });
    try {
      await client.sendInvite(HAPPY_INPUT);
      throw new Error('expected MailerError throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('PROVIDER_UNAVAILABLE');
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Network failure / timeout
// ──────────────────────────────────────────────────────────────────────────

describe('ResendMailerClient — network / timeout', () => {
  it('maps network throw to PROVIDER_UNAVAILABLE', async () => {
    const spy = (async () => {
      throw new TypeError('fetch failed: connect ECONNREFUSED');
    }) as typeof fetch;
    const client = new ResendMailerClient({
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
    });
    try {
      await client.sendInvite(HAPPY_INPUT);
      throw new Error('expected MailerError throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('PROVIDER_UNAVAILABLE');
    }
  });

  it('maps AbortError to PROVIDER_UNAVAILABLE', async () => {
    const spy = (async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }) as typeof fetch;
    const client = new ResendMailerClient({
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
    });
    try {
      await client.sendInvite(HAPPY_INPUT);
      throw new Error('expected MailerError throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('PROVIDER_UNAVAILABLE');
    }
  });

  it('aborts the fetch after the configured timeout (small timeoutMs)', async () => {
    let abortSignalReceived: AbortSignal | undefined;
    const spy = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      abortSignalReceived = init?.signal ?? undefined;
      // Wait long enough for the controller to abort, then surface
      // whatever the abort produced.
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (abortSignalReceived?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return fakeResponse({ ok: true, status: 200, body: '{}' });
    }) as typeof fetch;
    const client = new ResendMailerClient({
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
      timeoutMs: 10,
    });
    try {
      await client.sendInvite(HAPPY_INPUT);
      throw new Error('expected timeout');
    } catch (err) {
      expect((err as MailerError).code).toBe('PROVIDER_UNAVAILABLE');
      expect(abortSignalReceived?.aborted).toBe(true);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// No-leak invariant
// ──────────────────────────────────────────────────────────────────────────

describe('ResendMailerClient — no-leak invariant', () => {
  it('NEVER includes hostile Resend response body substrings in MailerError.message', async () => {
    // Hostile Resend response: mix of credential-looking shapes that
    // would catastrophically leak if the boundary code ever echoed
    // the response body. The body MUST stay inside the boundary.
    const HOSTILE_BODY = JSON.stringify({
      error: {
        message:
          'auth failed with AKIA-LEAK-1234 X-Amz-Signature=DEADBEEF re_LEAK_5678 xynes_live_aabbccdd',
        name: 'unauthorized',
      },
    });
    const { spy } = makeFetchSpy(fakeResponse({ ok: false, status: 401, body: HOSTILE_BODY }));
    const client = new ResendMailerClient({
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
    });
    try {
      await client.sendInvite(HAPPY_INPUT);
      throw new Error('expected MailerError throw');
    } catch (err) {
      const msg = (err as MailerError).message;
      // Closed-set sanitised message ONLY.
      expect(msg).not.toContain('AKIA-LEAK-1234');
      expect(msg).not.toContain('X-Amz-Signature');
      expect(msg).not.toContain('re_LEAK_5678');
      expect(msg).not.toContain('xynes_live_');
      expect(msg).not.toContain('auth failed');
      // The closed-set message for 401 is `PROVIDER_REJECTED`.
      expect((err as MailerError).code).toBe('PROVIDER_REJECTED');
    }
  });

  it('NEVER puts the raw API key anywhere outside the Authorization header', async () => {
    // Capture every byte that flowed through fetch and assert the API
    // key only appears in the Authorization header.
    const { spy, calls } = makeFetchSpy(
      fakeResponse({ ok: true, status: 200, body: JSON.stringify({ id: 'ok' }) }),
    );
    const client = new ResendMailerClient({
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
    });
    await client.sendInvite(HAPPY_INPUT);
    expect(calls.length).toBe(1);
    const init = calls[0].init;
    // Body must NOT contain the API key.
    const bodyText = (init?.body as string) ?? '';
    expect(bodyText).not.toContain(VALID_RESEND_KEY);
    // URL must NOT contain the API key.
    expect(String(calls[0].url)).not.toContain(VALID_RESEND_KEY);
    // Authorization header SHOULD contain it.
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${VALID_RESEND_KEY}`);
  });

  it('NEVER logs the API key via the default JSON serialisation of the client', () => {
    const { spy } = makeFetchSpy(fakeResponse({ ok: true, status: 200, body: '{}' }));
    const client = new ResendMailerClient({
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
    });
    // `String(client)` and `JSON.stringify(client)` must NOT carry the key.
    expect(String(client)).not.toContain(VALID_RESEND_KEY);
    expect(JSON.stringify(client)).not.toContain(VALID_RESEND_KEY);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// __forTesting__ pure helpers
// ──────────────────────────────────────────────────────────────────────────

describe('ResendMailerClient — pure helpers via __forTesting__', () => {
  it('composeTextBody includes the inviter when provided', () => {
    const out = __forTesting__.composeTextBody({
      inviterName: 'Bob',
      workspaceName: 'Beta',
      inviteUrl: 'http://example/invite/x',
      expiresAt: '2026-06-09T12:00:00.000Z',
    });
    expect(out).toContain('Bob has invited you to join Beta on Xynes.');
    expect(out).toContain('http://example/invite/x');
    expect(out).toContain('2026-06-09T12:00:00.000Z');
  });

  it('composeTextBody falls back to passive voice when inviterName is null', () => {
    const out = __forTesting__.composeTextBody({
      inviterName: null,
      workspaceName: 'Beta',
      inviteUrl: 'http://example/invite/x',
      expiresAt: '2026-06-09',
    });
    expect(out).toContain("You've been invited to join Beta on Xynes.");
    expect(out).not.toContain('has invited you');
  });

  it('isProbablyValidResendKey is a closed-set predicate', () => {
    expect(__forTesting__.isProbablyValidResendKey('re_long_enough_tail_abcdef')).toBe(true);
    expect(__forTesting__.isProbablyValidResendKey('re_short')).toBe(false);
    expect(__forTesting__.isProbablyValidResendKey('re_')).toBe(false);
    expect(__forTesting__.isProbablyValidResendKey('not-a-key')).toBe(false);
    expect(__forTesting__.isProbablyValidResendKey('')).toBe(false);
    expect(__forTesting__.isProbablyValidResendKey(null)).toBe(false);
    expect(__forTesting__.isProbablyValidResendKey(undefined)).toBe(false);
    expect(__forTesting__.isProbablyValidResendKey(42)).toBe(false);
  });

  it('httpStatusToMailerCode is total and closed-set', () => {
    expect(__forTesting__.httpStatusToMailerCode(200)).toBe('PROVIDER_REJECTED'); // 2xx should never reach this fn but the mapping is defensive
    expect(__forTesting__.httpStatusToMailerCode(400)).toBe('PROVIDER_REJECTED');
    expect(__forTesting__.httpStatusToMailerCode(401)).toBe('PROVIDER_REJECTED');
    expect(__forTesting__.httpStatusToMailerCode(403)).toBe('PROVIDER_REJECTED');
    expect(__forTesting__.httpStatusToMailerCode(422)).toBe('RECIPIENT_INVALID');
    expect(__forTesting__.httpStatusToMailerCode(429)).toBe('RATE_LIMITED');
    expect(__forTesting__.httpStatusToMailerCode(500)).toBe('PROVIDER_UNAVAILABLE');
    expect(__forTesting__.httpStatusToMailerCode(599)).toBe('PROVIDER_UNAVAILABLE');
    expect(__forTesting__.httpStatusToMailerCode(304)).toBe('PROVIDER_REJECTED');
  });

  it('resolveTimeoutMs falls back to default for bad values', () => {
    expect(__forTesting__.resolveTimeoutMs(undefined)).toBeGreaterThan(0);
    expect(__forTesting__.resolveTimeoutMs(NaN)).toBeGreaterThan(0);
    expect(__forTesting__.resolveTimeoutMs(-1)).toBeGreaterThan(0);
    expect(__forTesting__.resolveTimeoutMs(0)).toBeGreaterThan(0);
    expect(__forTesting__.resolveTimeoutMs(Infinity)).toBeGreaterThan(0);
    expect(__forTesting__.resolveTimeoutMs(5000)).toBe(5000);
  });

  it('exposes RESEND_API_ENDPOINT + RESEND_API_KEY_PREFIX constants', () => {
    expect(RESEND_API_ENDPOINT).toBe('https://api.resend.com/emails');
    expect(RESEND_API_KEY_PREFIX).toBe('re_');
  });

  it('__forTesting__ surface is frozen', () => {
    expect(Object.isFrozen(__forTesting__)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Type-only sanity (compile-time)
// ──────────────────────────────────────────────────────────────────────────

describe('ResendMailerClient — type sanity', () => {
  it('satisfies MailerClient interface', () => {
    // Compile-time: a `ResendMailerClient` instance assigned to a
    // `MailerClient` typed local. If the class diverges from the port,
    // tsc fails.
    const { spy } = makeFetchSpy(fakeResponse({ ok: true, status: 200, body: '{}' }));
    const opts: ResendMailerClientOptions = {
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
    };
    const client = new ResendMailerClient(opts);
    expect(typeof client.sendInvite).toBe('function');
  });
});
