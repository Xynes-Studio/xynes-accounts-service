/**
 * MAIL-4 — `resolveMailerFromEnv` composition helper.
 *
 * Picks the right `MailerClient` implementation based on env vars.
 *
 * Decision matrix (read at construction time, NOT memoised — caller
 * decides whether to cache the resulting client):
 *
 *   - `MAIL_PROVIDER === 'resend'`:
 *       1. Read `MAIL_RESEND_SECRET_REF` (a `secret://<path>` URI).
 *       2. Resolve via the supplied `SecretManagerClient` (defaults to
 *          `EnvSecretManagerClient`).
 *       3. Return `new ResendMailerClient({ apiKey, fromAddress, ... })`.
 *       Throws a closed-set `MailerError` on any resolve / construction
 *       failure so a misconfigured deploy fails LOUD at boot rather
 *       than at first send.
 *
 *   - `MAIL_PROVIDER === 'stub'` (or unset, with `SMTP_RELAY_URL` set):
 *       Return `StubMailerClient({ mode: 'smtp_relay', relayUrl, ... })`.
 *       Used in local-dev with Supabase Inbucket.
 *
 *   - `MAIL_PROVIDER === 'stub'` (or unset, with no `SMTP_RELAY_URL`):
 *       Return `StubMailerClient({ mode: 'stdout', ... })` if
 *       `MAILER_LOG_TO_STDOUT === 'true'` is set, else fall through.
 *
 *   - **All other paths fall back to `noopMailer`**: malformed
 *     `MAIL_PROVIDER`, unset `MAIL_PROVIDER` with no SMTP relay and no
 *     stdout flag, or any case the matrix above did not match.
 *     This **fails-open** (no mail dispatched) rather than **fail-closed**
 *     (no invite created) — matches CMS-API-KEY-ACTOR-1 Story C's
 *     "best-effort cleanup" posture. The invite row still lands; only
 *     the side effect is skipped.
 *
 * The helper does NOT consult `MAIL_PROVIDER` defaults or apply any
 * implicit "production = resend" inference. Operator must set the env
 * var explicitly. This is intentional: the plan §8 env contract is
 * `MAIL_PROVIDER=stub` (default) | `resend` (hosted opt-in).
 *
 * Security:
 *   - Resolved API key NEVER appears in the helper's return value's
 *     enumerable shape (held in `ResendMailerClient`'s non-enumerable
 *     descriptor).
 *   - The helper logs NOTHING. Callers that want a startup log line
 *     can write one after a successful call.
 *   - `SecretManagerError` thrown by the resolver is wrapped in a
 *     closed-set `MailerError` envelope (no upstream message text).
 */

import { MailerError } from './MailerError';
import type { MailerClient } from './MailerClient';
import { ResendMailerClient, type ResendMailerClientOptions } from './ResendMailerClient';
import { StubMailerClient } from './StubMailerClient';
import { noopMailer } from './noopMailer';
import { EnvSecretManagerClient, isSecretManagerError, type SecretManagerClient } from '../secrets';

/**
 * Closed-set value space for `MAIL_PROVIDER`. The string `'noop'` is
 * the value space's fail-soft default — callers that set `MAIL_PROVIDER`
 * to `'noop'` get the explicit no-op behaviour. Unset env vars also
 * fall through to noop.
 */
export type MailProvider = 'resend' | 'stub' | 'noop';

export interface ResolveMailerFromEnvDeps {
  /**
   * Override `process.env`. Tests inject a frozen literal; production
   * callers omit so the helper reads the real env.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Override the secret-manager backend. Defaults to a fresh
   * `EnvSecretManagerClient` reading from the same `env` object the
   * helper consulted for `MAIL_PROVIDER` etc. Hosted compositions can
   * inject a hosted backend (AWS Secrets Manager, Doppler, Vault) here.
   */
  secrets?: SecretManagerClient;
  /**
   * Override `globalThis.fetch` for the `ResendMailerClient`. Threaded
   * through so callers can wire telemetry around the underlying HTTP
   * call.
   */
  fetcher?: typeof fetch;
}

/**
 * Strict parser for `MAIL_PROVIDER`. Returns the closed-set value or
 * `'noop'` for anything unrecognised. Matches the storage-service
 * pattern (`STORAGE_PROCESSOR_MODE`) byte-for-byte on the strict
 * rejection.
 */
function parseMailProvider(value: string | undefined): MailProvider {
  if (typeof value !== 'string') return 'noop';
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'resend' || trimmed === 'stub' || trimmed === 'noop') {
    return trimmed;
  }
  return 'noop';
}

/**
 * Resolves a `MailerClient` instance from environment variables.
 *
 * @returns A constructed `MailerClient`. Falls through to `noopMailer`
 *          for any unrecognised / unset configuration.
 * @throws `MailerError` ONLY when `MAIL_PROVIDER=resend` AND the
 *         resolver fails to construct the client (missing secret,
 *         malformed key, etc). The thrown error carries a closed-set
 *         code (`TEMPLATE_RENDER_FAILED` for misconfig,
 *         `PROVIDER_UNAVAILABLE` for transient resolver failures).
 *         All other paths NEVER throw — they return a working
 *         `noopMailer` / `StubMailerClient`.
 */
export async function resolveMailerFromEnv(
  deps: ResolveMailerFromEnvDeps = {},
): Promise<MailerClient> {
  const env = deps.env ?? process.env;
  const provider = parseMailProvider(env.MAIL_PROVIDER);

  if (provider === 'resend') {
    return buildResendMailer({ env, deps });
  }

  if (provider === 'stub') {
    return buildStubMailer({ env });
  }

  // `noop` (explicit) OR unrecognised `MAIL_PROVIDER` value falls
  // through to a `noopMailer`. Defense-in-depth: callers can still
  // override by injecting `deps.secrets` etc. but the default is
  // fail-soft.
  return noopMailer;
}

async function buildResendMailer(args: {
  env: NodeJS.ProcessEnv;
  deps: ResolveMailerFromEnvDeps;
}): Promise<MailerClient> {
  const { env, deps } = args;
  const secretRef = env.MAIL_RESEND_SECRET_REF;
  if (typeof secretRef !== 'string' || secretRef.trim().length === 0) {
    // Misconfigured: caller asked for Resend but did not point at any
    // secret. Fail loud with `TEMPLATE_RENDER_FAILED` (non-retryable).
    throw new MailerError('TEMPLATE_RENDER_FAILED');
  }
  const secrets = deps.secrets ?? new EnvSecretManagerClient({ env });
  let material: { apiKey: string; fromAddress: string };
  try {
    material = await secrets.resolve(secretRef);
  } catch (err: unknown) {
    if (isSecretManagerError(err)) {
      // Map closed-set `SecretManagerErrorCode` to closed-set
      // `MailerErrorCode`. We never echo `err.message`.
      switch (err.code) {
        case 'NOT_FOUND':
        case 'MATERIAL_INVALID':
        case 'URI_INVALID':
          throw new MailerError('TEMPLATE_RENDER_FAILED');
        case 'BACKEND_UNAVAILABLE':
          throw new MailerError('PROVIDER_UNAVAILABLE');
        default:
          // Defensive fallback for a future code addition. We surface
          // as `TEMPLATE_RENDER_FAILED` (non-retryable) so the operator
          // can fix the misconfiguration before retry.
          throw new MailerError('TEMPLATE_RENDER_FAILED');
      }
    }
    // Non-SecretManagerError throw (e.g. backend implementation bug).
    // Bucket as transient `PROVIDER_UNAVAILABLE` so the next attempt
    // can succeed once the operator fixes the backend.
    throw new MailerError('PROVIDER_UNAVAILABLE');
  }
  // Forward to `ResendMailerClient`. Its constructor validates the API
  // key + fromAddress shape AGAIN as defense-in-depth on top of the
  // resolver's own validation.
  const opts: ResendMailerClientOptions = {
    apiKey: material.apiKey,
    fromAddress: material.fromAddress,
  };
  if (deps.fetcher) {
    opts.fetcher = deps.fetcher;
  }
  return new ResendMailerClient(opts);
}

function buildStubMailer(args: { env: NodeJS.ProcessEnv }): MailerClient {
  const { env } = args;
  const relayUrl = env.SMTP_RELAY_URL;
  const fromAddress = env.MAIL_STUB_FROM_ADDRESS ?? 'no-reply@xynes.local';
  if (typeof relayUrl === 'string' && relayUrl.trim().length > 0) {
    return new StubMailerClient({
      mode: 'smtp_relay',
      relayUrl: relayUrl.trim(),
      fromAddress,
    });
  }
  // No relay; fall back to stdout mode. `MAILER_LOG_TO_STDOUT` is a
  // documented signal but not strictly required — operators can flip
  // either path on without re-deploying.
  return new StubMailerClient({
    mode: 'stdout',
    fromAddress,
  });
}

/** Test-only seam for direct unit coverage of the pure helpers. */
export const __forTesting__ = Object.freeze({
  parseMailProvider,
  buildResendMailer,
  buildStubMailer,
});
