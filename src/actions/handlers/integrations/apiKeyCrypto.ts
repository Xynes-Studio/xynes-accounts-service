import { randomBytes } from 'node:crypto';

// ── Public types ────────────────────────────────────────────────

export type GeneratedWorkspaceApiKey = {
  /** The full raw API key shown exactly once to the user. Never store or log this. */
  rawKey: string;
  /** Short, non-secret prefix used for indexed lookup (e.g. `xk_a1b2c3d4`). */
  keyPrefix: string;
  /** One-way salted hash of the raw key, safe to store in DB. */
  keyHash: string;
};

// ── Constants ───────────────────────────────────────────────────

/** Human-readable prefix identifying platform live keys. */
const KEY_PREFIX_MARKER = 'xynes_live_';

/** Number of random bytes for the secret portion of the key. */
const SECRET_BYTES = 32;

/**
 * Length of the lookup prefix extracted from the hex-encoded secret.
 * 8 hex chars = 4 bytes of entropy — sufficient for a prefix index
 * while not revealing the full secret.
 */
const LOOKUP_PREFIX_LENGTH = 8;

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Generate cryptographically secure random bytes and return
 * a hex-encoded string.
 */
function secureRandomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

// ── Implementation ──────────────────────────────────────────────

/**
 * Generate a new workspace API key.
 *
 * The raw key is formatted as `xynes_live_<hex>` and must be shown
 * to the user exactly once. Only the `keyHash` (Argon2id) and
 * `keyPrefix` are safe to persist.
 *
 * Security properties:
 *  - Uses `crypto.randomBytes` (CSPRNG).
 *  - 32 bytes of entropy in the secret portion.
 *  - One-way Argon2id hash (salted internally by Bun.password).
 *  - Prefix is the first 8 hex chars — enough for lookup, not enough
 *    to reconstruct the key.
 */
export async function generateWorkspaceApiKey(): Promise<GeneratedWorkspaceApiKey> {
  const secret = secureRandomHex(SECRET_BYTES);
  const rawKey = `${KEY_PREFIX_MARKER}${secret}`;

  const keyPrefix = secret.slice(0, LOOKUP_PREFIX_LENGTH);
  const keyHash = await hashWorkspaceApiKey(rawKey);

  return { rawKey, keyPrefix, keyHash };
}

/**
 * Hash a raw API key using Argon2id (via Bun.password).
 *
 * Each call produces a unique salt, so the output differs even for
 * the same input. Use {@link verifyWorkspaceApiKey} for comparison.
 *
 * @returns Argon2id hash string (includes salt + params).
 */
export async function hashWorkspaceApiKey(rawKey: string): Promise<string> {
  return Bun.password.hash(rawKey, {
    algorithm: 'argon2id',
    memoryCost: 19456, // ~19 MiB — OWASP minimum recommendation
    timeCost: 2,
  });
}

/**
 * Verify a raw API key against a stored Argon2id hash.
 *
 * @returns `true` if the raw key matches the hash, `false` otherwise.
 *          Returns `false` (never throws) on malformed inputs.
 */
export async function verifyWorkspaceApiKey(rawKey: string, keyHash: string): Promise<boolean> {
  if (!rawKey || !keyHash) return false;

  try {
    return await Bun.password.verify(rawKey, keyHash);
  } catch {
    // Malformed hash string or other crypto error — treat as mismatch.
    return false;
  }
}
