import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { logger as honoLogger } from 'hono/logger';

/**
 * /health + /ready access-log skip — H-2 (HEALTHCHECK-CONTRACT.md §2.6).
 *
 * `/health` and `/ready` MUST NOT generate per-request structured logs.
 * The full skip behaviour lives in `src/app.ts`; we re-build the same
 * mounting pattern here so we can assert the skip without booting the
 * full app (which would also wire DB-touching internal routes).
 *
 * The contract enforced:
 *   - GET /health → 0 honoLogger console.log calls
 *   - GET /ready  → 0 honoLogger console.log calls
 *   - GET /any-other-path → ≥ 1 honoLogger console.log call (regression
 *     guard so an over-broad future skip doesn't silently swallow real
 *     traffic).
 */
describe('app — /health + /ready access-log skip (HEALTHCHECK-CONTRACT.md §2.6)', () => {
  const ACCESS_LOG_SKIP_PATHS = new Set<string>(['/health', '/ready']);
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.use('*', async (c, next) => {
      if (ACCESS_LOG_SKIP_PATHS.has(c.req.path)) {
        return next();
      }
      return honoLogger()(c, next);
    });
    app.get('/health', (c) => c.json({ ok: true }));
    app.get('/ready', (c) => c.json({ status: 'ready' }));
    app.get('/me', (c) => c.json({ userId: 'fake' }));
    app.get('/healthcheck-imposter', (c) => c.json({ ok: true }));

    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  function honoLogLinesFor(path: string): unknown[][] {
    return consoleLogSpy.mock.calls.filter((args: unknown[]) => {
      const first = args[0];
      return typeof first === 'string' && first.includes(path);
    });
  }

  it('GET /health does NOT produce a honoLogger access-log line', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(honoLogLinesFor('/health')).toHaveLength(0);
  });

  it('GET /ready does NOT produce a honoLogger access-log line', async () => {
    const res = await app.request('/ready');
    expect(res.status).toBe(200);
    expect(honoLogLinesFor('/ready')).toHaveLength(0);
  });

  it('GET /me DOES produce a honoLogger access-log line (regression guard)', async () => {
    const res = await app.request('/me');
    expect(res.status).toBe(200);
    // honoLogger emits at least one console.log line per request (one
    // for "-->" start and one for "<--" end on supported versions).
    expect(honoLogLinesFor('/me').length).toBeGreaterThan(0);
  });

  it('GET /healthcheck-imposter is NOT silently excluded (exact-match contract)', async () => {
    const res = await app.request('/healthcheck-imposter');
    expect(res.status).toBe(200);
    // The skip set is exact-match. A path that merely starts with
    // `/health` (but isn't exactly `/health`) must still be access-logged.
    expect(honoLogLinesFor('/healthcheck-imposter').length).toBeGreaterThan(0);
  });
});
