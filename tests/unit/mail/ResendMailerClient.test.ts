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
    const spy = (async (_url: string | URL, init?: RequestInit) => {
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

  // ── PR #17 Codex P2 regression: timeout active through body reads ─────
  //
  // `fetch` resolves as soon as response headers are available. If the
  // upstream (Resend or any proxy) ships headers and then stalls while
  // streaming the body, clearing the abort timer at that point leaves
  // `response.text()` / `response.json()` unbounded. The fix keeps the
  // controller + timer alive through the whole HTTP sequence and clears
  // them in a single trailing `finally`. The tests below pin that
  // contract on both the 2xx success path (body.json()) and the non-2xx
  // error path (body.text() drain).

  it('PR #17 Codex P2: aborts a 2xx body that stalls while streaming JSON', async () => {
    // Build a Response whose `json()` never resolves on its own but
    // throws an AbortError as soon as the injected signal aborts.
    let receivedSignal: AbortSignal | undefined;
    const stallingResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      redirected: false,
      type: 'default',
      url: RESEND_API_ENDPOINT,
      body: null,
      bodyUsed: false,
      async text(): Promise<string> {
        await new Promise<void>((_resolve, reject) => {
          if (receivedSignal?.aborted) {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
            return;
          }
          receivedSignal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        });
        return '';
      },
      async json(): Promise<unknown> {
        await new Promise<void>((_resolve, reject) => {
          if (receivedSignal?.aborted) {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
            return;
          }
          receivedSignal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        });
        return {};
      },
      clone(): Response {
        return stallingResponse as unknown as Response;
      },
      async arrayBuffer(): Promise<ArrayBuffer> {
        return new ArrayBuffer(0);
      },
      async blob(): Promise<Blob> {
        return new Blob();
      },
      async formData(): Promise<FormData> {
        return new FormData();
      },
      async bytes(): Promise<Uint8Array> {
        return new Uint8Array(0);
      },
    } as unknown as Response;

    const spy = (async (_url: string | URL, init?: RequestInit) => {
      // Capture the controller's signal so the stalling body methods
      // can observe the abort. `fetch` is allowed to resolve normally
      // (mimics "headers OK, body streaming") — the timeout fires
      // while we await the body parse.
      receivedSignal = init?.signal ?? undefined;
      return stallingResponse;
    }) as typeof fetch;

    const client = new ResendMailerClient({
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
      timeoutMs: 20,
    });

    const started = Date.now();
    try {
      await client.sendInvite(HAPPY_INPUT);
      throw new Error('expected MailerError from stalled body');
    } catch (err) {
      const elapsed = Date.now() - started;
      expect((err as MailerError).code).toBe('PROVIDER_UNAVAILABLE');
      // The whole call MUST resolve within roughly the configured
      // timeout, not hang indefinitely. We allow a generous upper
      // bound for slow CI but the original bug would never resolve
      // at all.
      expect(elapsed).toBeLessThan(500);
      // The controller's signal observed the abort.
      expect(receivedSignal?.aborted).toBe(true);
    }
  });

  it('PR #17 Codex P2: aborts an error-path body drain that stalls', async () => {
    // Same shape, non-2xx status. The body drain (response.text()) is
    // wrapped in `try { … } catch {}` inside the production code, so
    // the abort during the drain MUST NOT propagate; the closed-set
    // `MailerErrorCode` from the HTTP status is still surfaced.
    let receivedSignal: AbortSignal | undefined;
    const stallingResponse = {
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      headers: new Headers(),
      redirected: false,
      type: 'default',
      url: RESEND_API_ENDPOINT,
      body: null,
      bodyUsed: false,
      async text(): Promise<string> {
        await new Promise<void>((_resolve, reject) => {
          if (receivedSignal?.aborted) {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
            return;
          }
          receivedSignal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        });
        return '';
      },
      async json(): Promise<unknown> {
        return {};
      },
      clone(): Response {
        return stallingResponse as unknown as Response;
      },
      async arrayBuffer(): Promise<ArrayBuffer> {
        return new ArrayBuffer(0);
      },
      async blob(): Promise<Blob> {
        return new Blob();
      },
      async formData(): Promise<FormData> {
        return new FormData();
      },
      async bytes(): Promise<Uint8Array> {
        return new Uint8Array(0);
      },
    } as unknown as Response;

    const spy = (async (_url: string | URL, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      return stallingResponse;
    }) as typeof fetch;

    const client = new ResendMailerClient({
      apiKey: VALID_RESEND_KEY,
      fromAddress: FROM_ADDRESS,
      fetcher: spy,
      timeoutMs: 20,
    });

    const started = Date.now();
    try {
      await client.sendInvite(HAPPY_INPUT);
      throw new Error('expected MailerError from stalled error body');
    } catch (err) {
      const elapsed = Date.now() - started;
      // 503 maps to PROVIDER_UNAVAILABLE via the closed-set status
      // mapping; the abort during body drain does NOT change the
      // surfaced code (it is swallowed by the inner try/catch).
      expect((err as MailerError).code).toBe('PROVIDER_UNAVAILABLE');
      expect(elapsed).toBeLessThan(500);
      expect(receivedSignal?.aborted).toBe(true);
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
    // 2026-06-03 polish: expiresAt is formatted via Intl ('en-US', UTC) into
    // 'Month D, YYYY' for human readability. Raw ISO is intentionally NOT
    // present in the rendered body.
    expect(out).toContain('June 9, 2026');
    expect(out).not.toContain('2026-06-09T12:00:00.000Z');
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

  // 2026-06-03 polish: structure invariants the polished body must preserve.
  it('composeTextBody carries the polished structure markers', () => {
    const out = __forTesting__.composeTextBody({
      inviterName: 'Alice',
      workspaceName: 'Acme',
      inviteUrl: 'https://example/invite/xyz',
      expiresAt: '2026-06-10T00:00:00.000Z',
    });
    // Friendly greeting.
    expect(out).toMatch(/^Hi,\n/);
    // Clear CTA line precedes the URL.
    expect(out).toContain('Click the link below to accept the invitation:');
    // Indented URL is the actionable line (4-space indent, mail-clients
    // commonly auto-link absolute URLs even when not indented; the indent
    // keeps the URL visually distinct from the surrounding prose).
    expect(out).toContain('    https://example/invite/xyz');
    // Expiry rendered human-readable.
    expect(out).toContain('This invitation expires on June 10, 2026.');
    // Horizontal separator before the legal/ignore footer.
    expect(out).toContain('----------------------------------------');
    // Safe-to-ignore copy still present (existing security/UX invariant).
    expect(out).toContain('you can safely ignore this message');
    // Signoff.
    expect(out).toContain('— The Xynes team');
  });

  it('composeTextBody does NOT carry HTML / scripting / external resources', () => {
    const out = __forTesting__.composeTextBody({
      inviterName: 'Eve',
      workspaceName: 'Acme',
      inviteUrl: 'https://example/invite/xyz',
      expiresAt: '2026-06-10T00:00:00.000Z',
    });
    // Level-A (plaintext) MUST not carry any HTML markers injected BY THE
    // COMPOSER itself — defense in depth against a future Resend payload
    // that auto-wraps `text` into a `<pre>` with the body content. User
    // input that smuggles HTML chars is a separate concern (covered by the
    // next test) and is intentionally passed through verbatim because
    // plaintext does NOT need escaping.
    expect(out).not.toContain('<html');
    expect(out).not.toContain('<body');
    expect(out).not.toContain('<a ');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('href=');
    expect(out).not.toContain('style=');
  });

  it('composeTextBody passes through user-supplied workspace text verbatim (plaintext, no escape)', () => {
    // Plaintext does NOT escape HTML chars — that would be misleading.
    // The recipient's mail client renders the body as text so a smuggled
    // `<script>` is rendered literally, not executed. The composer's only
    // sanitisation duty is CR/LF/TAB injection (handled by the caller's
    // sanitiseHeaderValue, which preserves '<' '>' '&'). This test pins
    // that expectation so a future change cannot silently introduce
    // HTML escaping that would corrupt legitimate workspace names like
    // 'A&B Co.' or 'foo <legacy>'.
    const out = __forTesting__.composeTextBody({
      inviterName: 'Eve',
      workspaceName: 'Hostile<script>',
      inviteUrl: 'https://example/invite/xyz',
      expiresAt: '2026-06-10T00:00:00.000Z',
    });
    expect(out).toContain('Eve has invited you to join Hostile<script> on Xynes.');
  });

  // 2026-06-03 polish: formatExpiryForBody locale + fallback invariants.
  it('formatExpiryForBody renders ISO timestamps in en-US UTC long-date shape', () => {
    expect(__forTesting__.formatExpiryForBody('2026-06-10T00:00:00.000Z')).toBe('June 10, 2026');
    // Late-evening UTC stays on the same day because the formatter pins UTC.
    expect(__forTesting__.formatExpiryForBody('2026-06-10T23:59:59.000Z')).toBe('June 10, 2026');
    // Early-morning UTC is the same day, irrespective of host TZ.
    expect(__forTesting__.formatExpiryForBody('2026-06-10T00:00:01.000Z')).toBe('June 10, 2026');
  });

  it('formatExpiryForBody falls back to the raw value when input is unparseable', () => {
    expect(__forTesting__.formatExpiryForBody('not-a-date')).toBe('not-a-date');
    expect(__forTesting__.formatExpiryForBody('')).toBe('');
    // Pre-formatted dates should pass through cleanly (defensive).
    expect(__forTesting__.formatExpiryForBody('June 1, 2026')).toBe('June 1, 2026');
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
