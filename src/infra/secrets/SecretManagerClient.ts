/**
 * MAIL-4 — Secret-manager interface for resolving the raw mail-provider
 * credentials referenced by `MAIL_RESEND_SECRET_REF`.
 *
 * Mirrors the storage-service's `STORAGE-FU-3 SecretManagerClient` interface
 * (`xynes-storage-service/src/infra/providers/secret-manager.ts`) byte-for-byte
 * on the URI-parsing rules + closed-set error codes, but returns a
 * mail-provider-shaped credential bundle instead of the storage-shaped
 * `{ accessKeyId, secretAccessKey }`.
 *
 * Plan §13 Q1 (the `SecretManagerClient` package location decision):
 *
 *   "For MAIL-4 we either (a) extract it into `xynes-platform-contracts` and
 *    re-import in both services, or (b) copy the minimal interface +
 *    `EnvSecretManagerClient` impl into `accounts-service/src/infra/secrets/`.
 *    Option (b) is the lower-risk start (mirrors the storage repo's mirror
 *    posture); option (a) is the right end state. Recommend (b) for MAIL-4
 *    with a follow-up to land (a) post-epic."
 *
 * MAIL-4 ships option (b). The shape rules below MUST stay in sync with the
 * storage-service mirror; a future shared-contract extraction will deduplicate.
 *
 * Security invariants enforced here:
 *   - Raw secrets NEVER touch Postgres.
 *   - Raw secrets NEVER appear in error messages or logs.
 *   - The closed-set `SecretManagerErrorCode` lets the resolver wrap backend
 *     failures into a redacted envelope without leaking the underlying error
 *     text, the URI, or the secret-manager path.
 *   - URI parsing rejects anything that is not `secret://<path>` so a hostile
 *     `MAIL_RESEND_SECRET_REF` cannot smuggle a `file://` / `http://` /
 *     `?query=` payload through to the backend.
 */

/**
 * The shape every secret-manager backend resolves to for the mail provider.
 *
 * For Resend (MAIL-4 MVP):
 *   - `apiKey` is the raw Resend API key (format: `re_<base64>`).
 *   - `fromAddress` is the sender address bound to the Resend project (e.g.
 *     `no-reply@dev.xynes.com`). MAIL-6 documents per-env value provisioning.
 *
 * Adding a new mail provider in the future just adds fields to this DTO;
 * the resolver and the interface stay stable.
 */
export interface MailProviderCredentialMaterial {
  readonly apiKey: string;
  readonly fromAddress: string;
}

/**
 * Closed-set error codes returned by a `SecretManagerClient`. The mailer
 * composition (`resolveMailerFromEnv`) wraps these into a closed-set
 * `MailerError` envelope so callers never see the raw backend error.
 *
 * - `NOT_FOUND`         — backend has no entry for the path.
 * - `BACKEND_UNAVAILABLE` — transient backend failure (retryable).
 * - `MATERIAL_INVALID`  — entry exists but is missing required fields or
 *                        contains blank values. Defense-in-depth so a
 *                        malformed env block is detected at resolve time
 *                        rather than at the Resend HTTP boundary.
 * - `URI_INVALID`       — `credentialRef` is not a parseable `secret://<path>`
 *                        URI.
 */
export type SecretManagerErrorCode =
  | 'NOT_FOUND'
  | 'BACKEND_UNAVAILABLE'
  | 'MATERIAL_INVALID'
  | 'URI_INVALID';

export class SecretManagerError extends Error {
  public readonly name = 'SecretManagerError';
  public readonly code: SecretManagerErrorCode;
  constructor(code: SecretManagerErrorCode, message: string) {
    // Note: the `message` MUST be safe to surface — the resolver inspects
    // only `code`. We keep a short human-readable message here for direct
    // local-dev debugging, but `resolveMailerFromEnv` will wrap the throw
    // into a closed-set `MailerError` whose message is fixed and sanitized.
    super(message);
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Vendor-neutral secret-manager contract. The mailer composition helper
 * depends on this interface, not on any specific backend.
 *
 * Implementations MUST:
 *   - Accept a `credentialRef` URI of the form `secret://<path>` where
 *     `<path>` is a non-empty, slash-delimited identifier (e.g.
 *     `secret://xynes/mail/resend-dev`, `secret://aws/secrets-manager/mail`).
 *   - Reject any other scheme with `URI_INVALID`.
 *   - Return `MailProviderCredentialMaterial` whose fields are non-empty
 *     strings.
 *   - NEVER include the raw secret in error messages — error text MUST be
 *     safe to log.
 */
export interface SecretManagerClient {
  /**
   * Resolve `credentialRef` to raw mail-provider credentials.
   *
   * Throws `SecretManagerError` on failure. The composition helper
   * translates those throws into a closed-set `MailerError` envelope.
   */
  resolve(credentialRef: string): Promise<MailProviderCredentialMaterial>;
}

/**
 * Strict parser for the `secret://<path>` URI. Returns the path component
 * without the scheme prefix. Throws `SecretManagerError('URI_INVALID', ...)`
 * on any malformed input.
 *
 * Rules (defense-in-depth, mirrors the storage-service parser byte-for-byte
 * on the character class so the two parsers cannot drift):
 *   - Must start with the literal `secret://`.
 *   - Path after the prefix MUST be non-empty (1..256 chars).
 *   - No URL query string, no fragment, no `..`, no leading slash.
 *   - Allowed chars: lowercase letters, digits, `-`, `/`. Underscores are
 *     DELIBERATELY forbidden so the `secretPathToEnvPrefix` mapping below
 *     stays injective — `/` maps to `__` and `-` maps to `_`. If `_` were a
 *     legal path char, `resend_dev` and `resend-dev` would collapse to the
 *     same env prefix and route a hostile caller to the wrong credential
 *     block. See the storage-service PR-11 Codex P2 review for the original
 *     collision report.
 */
export function parseSecretRef(credentialRef: string): string {
  if (typeof credentialRef !== 'string') {
    throw new SecretManagerError('URI_INVALID', 'credentialRef must be a string');
  }
  const trimmed = credentialRef.trim();
  if (trimmed.length === 0) {
    throw new SecretManagerError('URI_INVALID', 'credentialRef must not be empty');
  }
  const prefix = 'secret://';
  if (!trimmed.startsWith(prefix)) {
    throw new SecretManagerError('URI_INVALID', 'credentialRef must use the secret:// scheme');
  }
  const path = trimmed.slice(prefix.length);
  if (path.length === 0) {
    throw new SecretManagerError('URI_INVALID', 'credentialRef path must not be empty');
  }
  if (path.length > 256) {
    throw new SecretManagerError(
      'URI_INVALID',
      'credentialRef path exceeds the 256-character limit',
    );
  }
  if (path.startsWith('/')) {
    throw new SecretManagerError('URI_INVALID', 'credentialRef path must not start with "/"');
  }
  if (path.includes('..')) {
    throw new SecretManagerError('URI_INVALID', 'credentialRef path must not contain ".."');
  }
  if (path.includes('?') || path.includes('#')) {
    throw new SecretManagerError(
      'URI_INVALID',
      'credentialRef must not contain query or fragment components',
    );
  }
  if (!/^[a-z0-9/-]+$/.test(path)) {
    throw new SecretManagerError('URI_INVALID', 'credentialRef path contains forbidden characters');
  }
  return path;
}

/**
 * Maps a `secret://` path to an env-var prefix using an INJECTIVE encoding
 * so two distinct credential refs can NEVER collide on the same env block:
 *
 *   `secret://xynes/mail/resend-dev`  →  `MAIL_CREDENTIAL_XYNES__MAIL__RESEND_DEV`
 *   `secret://xynes/mail/resend/dev`  →  `MAIL_CREDENTIAL_XYNES__MAIL__RESEND__DEV`
 *
 * Encoding rules:
 *   - `/` (path segment separator) → `__` (double underscore)
 *   - `-` (within-segment hyphen)  → `_`  (single underscore)
 *   - `_` is NOT a legal path char (rejected by `parseSecretRef`), so no
 *     third producer of `_` exists in the output. The mapping is therefore
 *     injective by construction.
 *
 * Note: the prefix is `MAIL_CREDENTIAL_` (not `STORAGE_CREDENTIAL_`) to keep
 * the two env namespaces distinct. A `secret://xynes/mail/resend-dev` ref
 * will NEVER resolve to a `STORAGE_CREDENTIAL_*` env var, even if a future
 * developer accidentally points the mailer at a storage-shaped path.
 *
 * Pure function so tests can assert the mapping without touching env.
 */
export function secretPathToEnvPrefix(path: string): string {
  const sanitised = path.replace(/\//g, '__').replace(/-/g, '_').toUpperCase();
  return `MAIL_CREDENTIAL_${sanitised}`;
}

/**
 * Local-dev `SecretManagerClient` that reads credentials from the process
 * environment. Keeps `bun run dev` runnable on a clean laptop without a
 * hosted secret manager. Hosted environments wire AWS Secrets Manager /
 * Doppler / Vault implementations of the same interface in their composition
 * root — each is a separate per-environment follow-up story per the
 * MAIL-4 plan §13 Q1.
 *
 * For each `secret://<path>` the client reads two env vars:
 *   - `MAIL_CREDENTIAL_<UPPERCASE_PATH>_API_KEY`        (the Resend API key)
 *   - `MAIL_CREDENTIAL_<UPPERCASE_PATH>_FROM_ADDRESS`   (the bound sender)
 *
 * Missing env vars surface as `NOT_FOUND`; partial / blank values surface
 * as `MATERIAL_INVALID`. The split lets the composition helper distinguish
 * "no secret manager wired" (NOT_FOUND → fail-soft to `noopMailer`) from
 * "secret manager wired but misconfigured" (MATERIAL_INVALID → fail-loud
 * with a closed-set error). See `resolveMailerFromEnv` for the mapping.
 */
export interface EnvSecretManagerClientDeps {
  /** Defaults to `process.env`. Tests inject a frozen object. */
  readonly env?: NodeJS.ProcessEnv;
}

export class EnvSecretManagerClient implements SecretManagerClient {
  private readonly env: NodeJS.ProcessEnv;
  constructor(deps: EnvSecretManagerClientDeps = {}) {
    this.env = deps.env ?? process.env;
  }

  async resolve(credentialRef: string): Promise<MailProviderCredentialMaterial> {
    const path = parseSecretRef(credentialRef);
    const prefix = secretPathToEnvPrefix(path);
    const apiKey = this.env[`${prefix}_API_KEY`];
    const fromAddress = this.env[`${prefix}_FROM_ADDRESS`];

    // `NOT_FOUND` vs `MATERIAL_INVALID`:
    //   - Both env vars missing entirely  → NOT_FOUND
    //   - One present, the other missing  → MATERIAL_INVALID (partial)
    //   - Both present but blank          → MATERIAL_INVALID
    if (apiKey === undefined && fromAddress === undefined) {
      throw new SecretManagerError(
        'NOT_FOUND',
        'No env-backed mail credential found for the requested credentialRef',
      );
    }
    if (apiKey === undefined || fromAddress === undefined) {
      throw new SecretManagerError(
        'MATERIAL_INVALID',
        'Env-backed mail credential is partially configured',
      );
    }
    if (apiKey.trim().length === 0 || fromAddress.trim().length === 0) {
      throw new SecretManagerError(
        'MATERIAL_INVALID',
        'Env-backed mail credential contains blank fields',
      );
    }

    return { apiKey, fromAddress };
  }
}

/** Type guard for callers that don't want to import the class. */
export function isSecretManagerError(value: unknown): value is SecretManagerError {
  return value instanceof SecretManagerError;
}
