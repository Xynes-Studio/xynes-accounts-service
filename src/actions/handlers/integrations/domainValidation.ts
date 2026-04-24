import { DomainError } from '@xynes/errors';

// ── Public types ────────────────────────────────────────────────

export type NormalizedDomain = {
  /** Lower-cased, trimmed hostname (e.g. `example.com`). */
  hostname: string;
  /** DNS TXT record name the workspace owner must create for verification. */
  verificationName: string;
};

// ── Constants ───────────────────────────────────────────────────

/** Maximum total hostname length per RFC 1035. */
const MAX_HOSTNAME_LENGTH = 253;

/** Maximum label length per RFC 1035. */
const MAX_LABEL_LENGTH = 63;

/** Characters that indicate the input is not a bare hostname. */
const FORBIDDEN_CHARS = ['://', '/', '?', '#', ':', '*'];

/** Reserved hostnames that must be rejected. */
const RESERVED_HOSTNAMES = new Set(['localhost']);

/** Regex matching bare IPv4 addresses (four decimal octets). */
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Regex matching common IPv6 patterns:
 *  - bracketed `[::1]`
 *  - bare `::1`
 *  - IPv4-mapped `::ffff:x.x.x.x`
 *  - full / compressed hex groups
 */
const IPV6_RE = /^\[?([0-9a-f:]+(?:::\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})?)\]?$/i;

// ── Implementation ──────────────────────────────────────────────

/**
 * Normalise and validate a raw hostname input for use as a
 * workspace verified domain.
 *
 * Rules enforced:
 *  1. Trim and lower-case.
 *  2. Reject empty / whitespace-only strings.
 *  3. Reject IPv4 / IPv6 literals (before forbidden-char check
 *     so IP inputs get a specific error message).
 *  4. Reject strings containing `://`, `/`, `?`, `#`, `:`, or `*`.
 *  5. Reject reserved names (`localhost`).
 *  6. Require at least one dot (TLD must be present).
 *  7. Reject leading / trailing dots.
 *  8. Enforce RFC 1035 length limits (253 total, 63 per label).
 *
 * @throws {DomainError} with code `INVALID_DOMAIN` on any violation.
 */
export function normalizeWorkspaceDomain(input: string): NormalizedDomain {
  const trimmed = input.trim().toLowerCase();

  // ── 1. Empty check ────────────────────────────────────────────
  if (trimmed.length === 0) {
    throw new DomainError('Hostname must not be empty', 'INVALID_DOMAIN', 400);
  }

  // ── 2. IP literal rejection (before forbidden-char check so IPv6 ───
  //        addresses with colons get a specific error message)
  if (IPV4_RE.test(trimmed)) {
    throw new DomainError(
      'IP addresses are not allowed; provide a hostname instead',
      'INVALID_DOMAIN',
      400,
    );
  }

  if (IPV6_RE.test(trimmed)) {
    throw new DomainError(
      'IPv6 addresses are not allowed; provide a hostname instead',
      'INVALID_DOMAIN',
      400,
    );
  }

  // ── 3. Forbidden characters ───────────────────────────────────
  for (const ch of FORBIDDEN_CHARS) {
    if (trimmed.includes(ch)) {
      throw new DomainError(`Hostname must not contain "${ch}"`, 'INVALID_DOMAIN', 400);
    }
  }

  // ── 4. Reserved hostnames ─────────────────────────────────────
  if (RESERVED_HOSTNAMES.has(trimmed)) {
    throw new DomainError(
      `"${trimmed}" is a reserved hostname and cannot be used`,
      'INVALID_DOMAIN',
      400,
    );
  }

  // ── 5. At least one dot (TLD) ─────────────────────────────────
  if (!trimmed.includes('.')) {
    throw new DomainError(
      'Hostname must include at least one dot (e.g. example.com)',
      'INVALID_DOMAIN',
      400,
    );
  }

  // ── 6. Leading / trailing dots ────────────────────────────────
  if (trimmed.startsWith('.') || trimmed.endsWith('.')) {
    throw new DomainError('Hostname must not start or end with a dot', 'INVALID_DOMAIN', 400);
  }

  // ── 7. RFC 1035 total length ──────────────────────────────────
  if (trimmed.length > MAX_HOSTNAME_LENGTH) {
    throw new DomainError(
      `Hostname exceeds the maximum length of ${MAX_HOSTNAME_LENGTH} characters`,
      'INVALID_DOMAIN',
      400,
    );
  }

  // ── 8. RFC 1035 per-label length ──────────────────────────────
  const labels = trimmed.split('.');
  for (const label of labels) {
    if (label.length > MAX_LABEL_LENGTH) {
      throw new DomainError(
        `Label "${label.slice(0, 20)}…" exceeds the maximum label length of ${MAX_LABEL_LENGTH} characters`,
        'INVALID_DOMAIN',
        400,
      );
    }
    if (label.length === 0) {
      throw new DomainError(
        'Hostname contains an empty label (consecutive dots)',
        'INVALID_DOMAIN',
        400,
      );
    }
  }

  return {
    hostname: trimmed,
    verificationName: `_xynes.${trimmed}`,
  };
}
