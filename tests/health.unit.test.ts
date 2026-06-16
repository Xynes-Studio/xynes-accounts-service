import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import {
  createGetHealth,
  resetHealthControllerCacheForTests,
  type CheckStatus,
  type HealthResponseBody,
} from '../src/controllers/health.controller';

/**
 * /health contract tests — H-2 (HEALTHCHECK-CONTRACT.md §2 + §7).
 *
 * §7 fixture mandates ≥ 8 cases asserting the contract: 200 + JSON
 * shape, schema field types, `ok === true` happy path, 503 + `ok ===
 * false` degraded path, latency budget, no-auth posture, no auth-leaking
 * response headers, and the §2.4 forbidden-content defense-in-depth
 * body sweep. We also add cache TTL + recovery cases since the
 * implementation has cascade-avoidance state, plus the version-fallback
 * regression guard.
 */

const okPing = () => Promise.resolve();
const failPing = () => Promise.reject(new Error('db down'));

interface BuildAppOptions {
  pingDb?: () => Promise<void>;
  pingAuthz?: (() => Promise<void>) | null;
  uptimeSeconds?: number;
  version?: string;
  now?: () => number;
}

function buildApp(options: BuildAppOptions = {}): Hono {
  const handler = createGetHealth({
    pingDb: options.pingDb ?? okPing,
    pingAuthz: options.pingAuthz !== undefined ? options.pingAuthz : null,
    getUptimeSeconds: () => options.uptimeSeconds ?? 42,
    getVersion: () => options.version ?? 'v0.1.0',
    now: options.now ?? (() => Date.now()),
  });
  const app = new Hono();
  app.get('/health', handler);
  return app;
}

async function readBody(res: Response): Promise<HealthResponseBody> {
  return (await res.json()) as HealthResponseBody;
}

describe('/health (HEALTHCHECK-CONTRACT.md §2 + §7)', () => {
  beforeEach(() => {
    resetHealthControllerCacheForTests();
  });

  it('§7.1 returns 200 + application/json with the contract shape', async () => {
    const app = buildApp();
    const res = await app.request('/health');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/i);

    const body = await readBody(res);
    expect(body).toEqual({
      ok: true,
      service: 'xynes-accounts-service',
      version: 'v0.1.0',
      uptime_seconds: 42,
      checks: { db: 'ok', authz: 'skipped' },
    });
  });

  it('§7.2 body matches the schema (field types)', async () => {
    const app = buildApp();
    const res = await app.request('/health');
    const body = await readBody(res);

    expect(typeof body.ok).toBe('boolean');
    expect(typeof body.service).toBe('string');
    expect(typeof body.version).toBe('string');
    expect(typeof body.uptime_seconds).toBe('number');
    expect(typeof body.checks).toBe('object');
    expect(Object.keys(body.checks).sort()).toEqual(['authz', 'db']);
    const validStatuses: CheckStatus[] = ['ok', 'fail', 'skipped'];
    expect(validStatuses).toContain(body.checks.db);
    expect(validStatuses).toContain(body.checks.authz);
  });

  it('§7.3 ok === true when every check passes (db ok, authz skipped)', async () => {
    const app = buildApp({ pingDb: okPing });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await readBody(res);
    expect(body.ok).toBe(true);
    expect(body.checks.db).toBe('ok');
    expect(body.checks.authz).toBe('skipped');
  });

  it('§7.4 returns 503 with ok=false when the DB probe fails', async () => {
    const app = buildApp({ pingDb: failPing });
    const res = await app.request('/health');
    expect(res.status).toBe(503);
    const body = await readBody(res);
    expect(body.ok).toBe(false);
    expect(body.checks.db).toBe('fail');
  });

  it('§7.5 handler completes well within the 50 ms hot-path budget on mocks', async () => {
    const app = buildApp({ pingDb: okPing });
    const start = Date.now();
    const res = await app.request('/health');
    const elapsedMs = Date.now() - start;
    expect(res.status).toBe(200);
    // Loose ceiling per HEALTHCHECK-CONTRACT.md §7.5 ("test-machine
    // dependent — set to ≤ 200 ms with a generous margin").
    expect(elapsedMs).toBeLessThan(200);
  });

  it('§7.6 no authentication is required (no Authorization, no cookies)', async () => {
    const app = buildApp();
    const res = await app.request('/health', {
      headers: {
        // Empty: explicitly NO Authorization, no Cookie, no
        // X-Internal-Service-Token, no X-XS-API-Key.
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
  });

  it('§7.7 response carries no Authorization-leaking response headers', async () => {
    const app = buildApp();
    const res = await app.request('/health');
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(res.headers.get('Authorization')).toBeNull();
    for (const [name] of res.headers.entries()) {
      expect(name.toLowerCase().startsWith('x-xs-')).toBe(false);
    }
  });

  it('§7.8 body does NOT leak DATABASE_URL / JWT_SECRET / raw API key markers / stack traces', async () => {
    const app = buildApp({
      pingDb: () =>
        Promise.reject(
          new Error(
            // The handler must NOT echo this string back even when the
            // probe rejects with it — only the closed-set check value
            // surfaces.
            'connect ECONNREFUSED postgres://leak:s3cret@db.internal:5432/postgres; JWT_SECRET=super-secret; xynes_live_aabbccdd11223344',
          ),
        ),
    });
    const res = await app.request('/health');
    const raw = await res.text();
    expect(raw).not.toMatch(/postgres:\/\//);
    expect(raw).not.toMatch(/JWT_SECRET/);
    expect(raw).not.toMatch(/xynes_live_/i);
    expect(raw).not.toMatch(/DATABASE_URL/);
    expect(raw).not.toMatch(/ECONNREFUSED/);
    // No `at Object.<anonymous> (/app/src/…)` style stack frames either.
    expect(raw).not.toMatch(/\s+at\s+/);
  });

  it('caches DB probe failures for the documented TTL window (§4 cascade avoidance)', async () => {
    let pingCalls = 0;
    let nowMs = 1_000_000;
    const app = buildApp({
      pingDb: async () => {
        pingCalls += 1;
        throw new Error('transient db blip');
      },
      now: () => nowMs,
    });

    // First call fires the probe and caches the failure.
    const first = await app.request('/health');
    expect(first.status).toBe(503);
    expect(pingCalls).toBe(1);

    // Second call within the TTL must reuse the cached "fail" without
    // re-probing — defends against healthcheck-driven retry storms.
    nowMs += 5_000; // 5 s later, well inside the 30 s TTL
    const second = await app.request('/health');
    expect(second.status).toBe(503);
    expect(pingCalls).toBe(1);

    // After the TTL elapses, the next call re-probes.
    nowMs += 30_000; // 35 s after the original failure
    const third = await app.request('/health');
    expect(third.status).toBe(503);
    expect(pingCalls).toBe(2);
  });

  it('recovers from a cached failure as soon as the probe succeeds', async () => {
    let nowMs = 1_000_000;
    let nextResult: 'ok' | 'fail' = 'fail';
    const app = buildApp({
      pingDb: () =>
        nextResult === 'ok' ? Promise.resolve() : Promise.reject(new Error('transient')),
      now: () => nowMs,
    });

    const failed = await app.request('/health');
    expect(failed.status).toBe(503);

    // TTL elapses; next probe succeeds; cache MUST clear.
    nowMs += 60_000;
    nextResult = 'ok';
    const recovered = await app.request('/health');
    expect(recovered.status).toBe(200);

    // Subsequent successful call must NOT re-probe-and-fail (cache cleared).
    const stillHealthy = await app.request('/health');
    expect(stillHealthy.status).toBe(200);
  });

  it('falls back to a sane default version when XYNES_BUILD_VERSION is blank', async () => {
    const originalVersion = process.env.XYNES_BUILD_VERSION;
    process.env.XYNES_BUILD_VERSION = '   '; // whitespace-only
    try {
      const handler = createGetHealth({ pingDb: okPing, pingAuthz: null });
      const app = new Hono();
      app.get('/health', handler);
      const res = await app.request('/health');
      const body = await readBody(res);
      expect(body.version).toBe('dev');
    } finally {
      if (originalVersion === undefined) {
        delete process.env.XYNES_BUILD_VERSION;
      } else {
        process.env.XYNES_BUILD_VERSION = originalVersion;
      }
    }
  });

  it('uses XYNES_BUILD_VERSION when set to a non-blank value', async () => {
    const originalVersion = process.env.XYNES_BUILD_VERSION;
    process.env.XYNES_BUILD_VERSION = 'v9.9.9';
    try {
      const handler = createGetHealth({ pingDb: okPing, pingAuthz: null });
      const app = new Hono();
      app.get('/health', handler);
      const res = await app.request('/health');
      const body = await readBody(res);
      expect(body.version).toBe('v9.9.9');
    } finally {
      if (originalVersion === undefined) {
        delete process.env.XYNES_BUILD_VERSION;
      } else {
        process.env.XYNES_BUILD_VERSION = originalVersion;
      }
    }
  });

  it('DB probe is bounded by the 1 s timeout (no infinite hang)', async () => {
    // A probe that never resolves should be killed by the internal
    // timeout and surface as `checks.db = "fail"` within the handler's
    // latency budget. We give a generous 2 s ceiling here.
    const neverResolves = () =>
      new Promise<void>(() => {
        /* never resolves */
      });
    const app = buildApp({ pingDb: neverResolves });
    const start = Date.now();
    const res = await app.request('/health');
    const elapsedMs = Date.now() - start;
    expect(res.status).toBe(503);
    const body = await readBody(res);
    expect(body.checks.db).toBe('fail');
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('uptime_seconds is a non-negative integer (Math.floor of process.uptime())', async () => {
    const handler = createGetHealth({
      pingDb: okPing,
      pingAuthz: null,
      getUptimeSeconds: undefined, // exercise the default branch
      getVersion: () => 'v0.0.0',
    });
    const app = new Hono();
    app.get('/health', handler);
    const res = await app.request('/health');
    const body = await readBody(res);
    expect(Number.isInteger(body.uptime_seconds)).toBe(true);
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  it('authz check reports "ok" when the probe succeeds and is non-critical for ok flag', async () => {
    const app = buildApp({
      pingDb: okPing,
      pingAuthz: okPing,
    });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await readBody(res);
    expect(body.checks.authz).toBe('ok');
    expect(body.checks.db).toBe('ok');
    expect(body.ok).toBe(true);
  });

  it('authz check reports "fail" but DOES NOT flip the top-level ok (non-critical per §4 rule 3)', async () => {
    const app = buildApp({
      pingDb: okPing,
      pingAuthz: failPing,
    });
    const res = await app.request('/health');
    // Top-level ok stays true even though authz is fail, because db
    // (the only critical dep today) is ok.
    expect(res.status).toBe(200);
    const body = await readBody(res);
    expect(body.ok).toBe(true);
    expect(body.checks.db).toBe('ok');
    expect(body.checks.authz).toBe('fail');
  });

  it('caches authz probe failures independently from db (§4 cascade avoidance)', async () => {
    let authzCalls = 0;
    let nowMs = 1_000_000;
    const app = buildApp({
      pingDb: okPing,
      pingAuthz: async () => {
        authzCalls += 1;
        throw new Error('authz down');
      },
      now: () => nowMs,
    });

    const first = await app.request('/health');
    expect(first.status).toBe(200); // authz is non-critical
    expect(authzCalls).toBe(1);

    nowMs += 5_000;
    const second = await app.request('/health');
    expect(second.status).toBe(200);
    expect(authzCalls).toBe(1); // reused cached fail

    nowMs += 30_000;
    const third = await app.request('/health');
    expect(third.status).toBe(200);
    expect(authzCalls).toBe(2); // re-probed
  });

  it('authz reports "skipped" by default (ACCOUNTS_HEALTH_AUTHZ_URL unset)', async () => {
    // The default factory reads ACCOUNTS_HEALTH_AUTHZ_URL at construction
    // time. Drop the env, build a fresh handler, expect "skipped".
    const originalUrl = process.env.ACCOUNTS_HEALTH_AUTHZ_URL;
    delete process.env.ACCOUNTS_HEALTH_AUTHZ_URL;
    try {
      const handler = createGetHealth({ pingDb: okPing });
      const app = new Hono();
      app.get('/health', handler);
      const res = await app.request('/health');
      const body = await readBody(res);
      expect(body.checks.authz).toBe('skipped');
      expect(body.ok).toBe(true);
    } finally {
      if (originalUrl === undefined) {
        delete process.env.ACCOUNTS_HEALTH_AUTHZ_URL;
      } else {
        process.env.ACCOUNTS_HEALTH_AUTHZ_URL = originalUrl;
      }
    }
  });

  it('authz reports "skipped" when ACCOUNTS_HEALTH_AUTHZ_URL is whitespace-only', async () => {
    const originalUrl = process.env.ACCOUNTS_HEALTH_AUTHZ_URL;
    process.env.ACCOUNTS_HEALTH_AUTHZ_URL = '   ';
    try {
      const handler = createGetHealth({ pingDb: okPing });
      const app = new Hono();
      app.get('/health', handler);
      const res = await app.request('/health');
      const body = await readBody(res);
      expect(body.checks.authz).toBe('skipped');
    } finally {
      if (originalUrl === undefined) {
        delete process.env.ACCOUNTS_HEALTH_AUTHZ_URL;
      } else {
        process.env.ACCOUNTS_HEALTH_AUTHZ_URL = originalUrl;
      }
    }
  });
});

describe('Ready endpoint (unit)', () => {
  it('GET /ready returns 200 when DB is healthy', async () => {
    // Mock the readiness check to succeed
    const mockCheck = mock(() => Promise.resolve());

    const { createGetReady } = await import('../src/controllers/ready.controller');
    const getReady = createGetReady({
      getDatabaseUrl: () => 'postgres://test:test@localhost:5432/test',
      check: mockCheck,
      schemaName: 'identity',
    });

    const app = new Hono();
    app.get('/ready', getReady);

    const res = await app.request('/ready');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ready');
    expect(mockCheck).toHaveBeenCalled();
  });

  it('GET /ready returns 503 when DB check fails', async () => {
    // Mock the readiness check to fail
    const mockCheck = mock(() => Promise.reject(new Error('Connection refused')));

    const { createGetReady } = await import('../src/controllers/ready.controller');
    const getReady = createGetReady({
      getDatabaseUrl: () => 'postgres://test:test@localhost:5432/test',
      check: mockCheck,
      schemaName: 'identity',
    });

    const app = new Hono();
    app.get('/ready', getReady);

    const res = await app.request('/ready');

    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('not_ready');
  });

  it('GET /ready checks identity schema by default', async () => {
    const mockCheck = mock(() => Promise.resolve());

    const { createGetReady } = await import('../src/controllers/ready.controller');
    const getReady = createGetReady({
      getDatabaseUrl: () => 'postgres://test',
      check: mockCheck,
    });

    const app = new Hono();
    app.get('/ready', getReady);

    await app.request('/ready');

    expect(mockCheck).toHaveBeenCalledWith({
      databaseUrl: 'postgres://test',
      schemaName: 'identity',
    });
  });
});
