/**
 * MAIL-2 — Invite-URL masking helper.
 *
 * The mailer dispatch path takes an `inviteUrl` like
 * `https://app.xynes.com/invite/${rawToken64hex}`. The raw token is
 * security-sensitive — a recipient (or anyone who fishes it out of a
 * log) can use it to accept the invite. The `StubMailerClient`
 * stdout-mode writes a JSON record to stdout for operator debugging,
 * but we MUST NOT include the full token in that record.
 *
 * `maskInviteUrl(url)` returns the same URL with the path segment
 * after `/invite/` replaced by `***<last8chars>` — enough for the
 * operator to spot-check which invite a log line refers to, but not
 * enough to reconstruct the token. URLs that don't match the
 * `/invite/<token>` shape are returned unchanged: the function is a
 * best-effort mask, not a parser, and the underlying URL format is
 * the responsibility of the caller (MAIL-5).
 */

/**
 * Mask the token segment of an invite URL for safe logging.
 *
 * @example
 *   maskInviteUrl('http://localhost:3100/invite/abcdef0123456789...')
 *     // → 'http://localhost:3100/invite/***56789abc'
 *   maskInviteUrl('http://localhost:3100/something-else')
 *     // → 'http://localhost:3100/something-else'  (unchanged)
 */
export function maskInviteUrl(url: string): string {
  if (typeof url !== 'string' || url.length === 0) {
    return '[REDACTED:INVALID_URL]';
  }
  // Look for `/invite/` followed by a token segment up to `?` / `#` / end.
  const match = url.match(/^(.*\/invite\/)([^/?#]+)(.*)$/);
  if (!match) {
    return url;
  }
  const [, prefix, token, suffix] = match;
  // Keep last 8 chars only — same trailing-prefix convention the
  // gateway uses for the public `keyPrefix` audit handle.
  const tail = token.length <= 8 ? token : token.slice(-8);
  return `${prefix}***${tail}${suffix}`;
}
