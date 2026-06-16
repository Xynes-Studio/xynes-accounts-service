// =============================================================================
// /health controller — H-2 (HEALTHCHECK-CONTRACT.md §2 + §3 + §4 + §7).
//
// Implements the binding contract from
// `xynes-infra/infra/release/HEALTHCHECK-CONTRACT.md` for
// xynes-accounts-service:
//
//   - GET /health
//   - No auth, no rate-limit, no access-log (see hono/logger skip in app.ts).
//   - 200 OK on the happy path; 503 when at least one critical check fails.
//   - Latency budget: ≤ 300 ms p99 per §2.5. Implementation runs a
//     1-second-timeout DB probe + a cheap optional one-hop authz probe.
//   - Failed probes are cached as `"fail"` for 30 s to avoid retry storms
//     per §4 cascade-avoidance rules.
//   - Response body NEVER contains DATABASE_URL, JWT_SECRET, raw API
//     keys, stack traces, or any value that could identify a user or
//     workspace (§2.4 forbidden content / §7.8 defense-in-depth sweep).
//   - Per §3 the declared `checks` keys for accounts-service are `db`
//     (critical — flips top-level `ok`) and `authz` (one-hop probe).
//     `authz` is treated as non-critical per §4 rule 3 because the
//     authz `/health` endpoint is delivered by H-3 which has not landed
//     yet; until `ACCOUNTS_HEALTH_AUTHZ_URL` is wired we report it as
//     `"skipped"` so it does NOT flip the top-level `ok`. The
//     non-critical posture is also the right cascade-avoidance default
//     for a one-hop dependency probe (rules 1 + 3).
//
// The handler accepts injected dependencies so tests can stub the DB
// probe, the authz probe, the clock, and the version reader without
// touching the live registry.
// =============================================================================

import type { Context } from 'hono';
import { checkPostgresReadiness } from '../infra/readiness';
import { config } from '../infra/config';

const SERVICE_NAME = 'xynes-accounts-service';
const DEFAULT_VERSION = 'dev';
const DB_PROBE_TIMEOUT_MS = 1000;
const AUTHZ_PROBE_TIMEOUT_MS = 1000;
const PROBE_FAILURE_CACHE_TTL_MS = 30_000;

export type CheckStatus = 'ok' | 'fail' | 'skipped';

export interface HealthResponseBody {
  ok: boolean;
  service: string;
  version: string;
  uptime_seconds: number;
  checks: {
    db: CheckStatus;
    authz: CheckStatus;
  };
}

export interface HealthControllerDeps {
  /** Database liveness probe. Must reject on failure. */
  pingDb?: () => Promise<void>;
  /**
   * Authz `/health` probe. Reject on non-2xx / network failure / timeout.
   * `null` means "skipped" (no `ACCOUNTS_HEALTH_AUTHZ_URL` configured).
   * Pass `undefined` to use the default env-driven probe builder.
   */
  pingAuthz?: (() => Promise<void>) | null;
  /** Process uptime in seconds (defaults to `process.uptime()`). */
  getUptimeSeconds?: () => number;
  /** Service version string (defaults to `XYNES_BUILD_VERSION` env). */
  getVersion?: () => string;
  /** Monotonic clock for failure-cache TTLs (defaults to `Date.now`). */
  now?: () => number;
}

/**
 * Module-scoped probe failure cache. Cleared when a probe succeeds or
 * the TTL elapses. Survives across handler invocations so a transient
 * downstream outage can't melt the service with retry storms.
 */
let dbProbeFailureAt: number | null = null;
let authzProbeFailureAt: number | null = null;

/**
 * Reset the probe failure cache. ONLY for tests; production callers
 * must never reach for this. Exported so test files can isolate cases.
 */
export function resetHealthControllerCacheForTests(): void {
  dbProbeFailureAt = null;
  authzProbeFailureAt = null;
}

function readDefaultVersion(): string {
  const raw = process.env.XYNES_BUILD_VERSION;
  if (!raw) return DEFAULT_VERSION;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_VERSION;
}

async function runWithTimeout(
  probe: () => Promise<void>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  try {
    await Promise.race([probe(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Default DB probe. Reuses the existing accounts-service `readiness.ts`
 * helper (already used by `/ready`) but the surrounding `runWithTimeout`
 * caps it at 1 s per §2.5. Read-only `SELECT 1` against the configured
 * DATABASE_URL.
 */
async function defaultPingDb(): Promise<void> {
  await checkPostgresReadiness({
    databaseUrl: config.server.DATABASE_URL,
  });
}

/**
 * Default authz probe factory. Reads `ACCOUNTS_HEALTH_AUTHZ_URL` from
 * the environment ONCE per controller construction (i.e. process
 * lifetime in production). When the env var is unset/blank, returns
 * `null` and the check surfaces as `"skipped"` per §2.2 field-rules
 * table — does NOT flip the top-level `ok`. When set, returns a probe
 * that does a single `GET` and rejects on non-2xx.
 *
 * Per §4 rule 1 ("direct downstream only, no transitive probes"),
 * `ACCOUNTS_HEALTH_AUTHZ_URL` MUST point at the authz `/health` route
 * directly (e.g. `http://authz-service:4300/health`), NOT at the
 * gateway which would chain into a second hop.
 */
function buildDefaultAuthzProbe(): (() => Promise<void>) | null {
  const raw = process.env.ACCOUNTS_HEALTH_AUTHZ_URL;
  if (!raw) return null;
  const url = raw.trim();
  if (url.length === 0) return null;

  return async () => {
    const res = await fetch(url, {
      method: 'GET',
      // No Authorization, no cookies — authz `/health` is unauthenticated
      // per the contract.
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      // Closed-set error — we deliberately do NOT echo the response body
      // which could carry forwarded provider details (§2.4 forbidden
      // content).
      throw new Error('authz probe non-2xx');
    }
  };
}

async function evaluateDbCheck(
  pingDb: () => Promise<void>,
  now: () => number,
): Promise<CheckStatus> {
  // Short-circuit on cached recent failure (§4 cascade avoidance).
  if (dbProbeFailureAt !== null && now() - dbProbeFailureAt < PROBE_FAILURE_CACHE_TTL_MS) {
    return 'fail';
  }

  try {
    await runWithTimeout(pingDb, DB_PROBE_TIMEOUT_MS, 'db probe timeout');
    dbProbeFailureAt = null;
    return 'ok';
  } catch {
    // Cache the failure. We deliberately do NOT log the probe error
    // here (§2.6 — at most one warn/min via a rate-limited logger).
    // Operators see the failure via the `checks.db = "fail"` body + the
    // 503 status surfaced to Caddy / Uptime Kuma.
    dbProbeFailureAt = now();
    return 'fail';
  }
}

async function evaluateAuthzCheck(
  pingAuthz: (() => Promise<void>) | null,
  now: () => number,
): Promise<CheckStatus> {
  if (pingAuthz === null) return 'skipped';

  if (authzProbeFailureAt !== null && now() - authzProbeFailureAt < PROBE_FAILURE_CACHE_TTL_MS) {
    return 'fail';
  }

  try {
    await runWithTimeout(pingAuthz, AUTHZ_PROBE_TIMEOUT_MS, 'authz probe timeout');
    authzProbeFailureAt = null;
    return 'ok';
  } catch {
    authzProbeFailureAt = now();
    return 'fail';
  }
}

/**
 * Compute the top-level `ok` flag from per-check statuses.
 *
 * Per §2.2 field-rules table: `ok` is `true` iff every entry in `checks`
 * is `ok` or `skipped`. Per §4 rule 3, non-critical dependencies flip
 * their own `checks.<dep>` to `"fail"` but MUST NOT flip the top-level
 * `ok`. For accounts-service today, only `db` is critical:
 *
 *   - `db.ok` ∨ `db.skipped` AND any `authz` state → top-level `ok = true`
 *   - `db.fail` → top-level `ok = false` (regardless of authz)
 *
 * When H-3 ships and `authz` is reclassified as critical, this function
 * is the only place that needs to change.
 */
function computeOk(dbStatus: CheckStatus, authzStatus: CheckStatus): boolean {
  if (dbStatus === 'fail') return false;
  // authzStatus is intentionally non-critical for H-2; surfaced in the
  // body but does NOT flip the top-level `ok`.
  void authzStatus;
  return true;
}

/**
 * Create a `/health` controller with injectable dependencies. Production
 * callers should use the default export `getHealth` which is wired
 * against the live deps; tests construct their own via `createGetHealth`.
 */
export function createGetHealth(deps: HealthControllerDeps = {}) {
  const pingDb = deps.pingDb ?? defaultPingDb;
  const pingAuthz = deps.pingAuthz !== undefined ? deps.pingAuthz : buildDefaultAuthzProbe();
  const getUptimeSeconds = deps.getUptimeSeconds ?? (() => Math.floor(process.uptime()));
  const getVersion = deps.getVersion ?? readDefaultVersion;
  const now = deps.now ?? (() => Date.now());

  return async (c: Context) => {
    const [dbStatus, authzStatus] = await Promise.all([
      evaluateDbCheck(pingDb, now),
      evaluateAuthzCheck(pingAuthz, now),
    ]);

    const ok = computeOk(dbStatus, authzStatus);
    const body: HealthResponseBody = {
      ok,
      service: SERVICE_NAME,
      version: getVersion(),
      uptime_seconds: getUptimeSeconds(),
      checks: {
        db: dbStatus,
        authz: authzStatus,
      },
    };

    return c.json(body, ok ? 200 : 503);
  };
}

/** Default singleton wired against live deps. */
export const getHealth = createGetHealth();
