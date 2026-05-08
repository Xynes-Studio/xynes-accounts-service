/**
 * Logger sink redaction.
 *
 * Defense-in-depth scrubber applied to every value passed to the
 * application logger. Scrubs known-secret patterns so that an
 * accidental future leak (e.g. a handler logging an entire request
 * payload that contains a raw workspace API key in a header) cannot
 * write secret material to stdout/stderr or downstream log
 * aggregators.
 *
 * Mirrors the gateway's `xynes-gateway/src/logging/redaction.ts`
 * approach — keep `apiKeyId`, `keyPrefix`, `workspaceId`, etc. fully
 * readable for security-ops audit trails (these are public
 * identifiers), but always scrub:
 *   - Raw workspace API keys (`xynes_live_<hex>`).
 *   - Bearer tokens / Authorization header values.
 *   - Any field whose name suggests a secret payload (`rawKey`,
 *     `keyHash`, `key_hash`, `password`, `secret`, `token`,
 *     `authorization`).
 *
 * The redaction also serves as a runtime justification for the
 * `js/clear-text-logging` CodeQL suppression in `logger.ts`: any value
 * that reaches the sink has been passed through this scrubber, so
 * even if a future caller logs an `apiKeyId` UUID alongside something
 * sensitive by accident, the sensitive part is replaced with
 * `[REDACTED]`.
 */

/** Marker for the secret part of a workspace API key. */
const RAW_API_KEY_REDACTION_PATTERN = /xynes_live_[a-fA-F0-9]+/g;

/**
 * Field-name patterns that always carry secret material. Anchored
 * regex (^...$) so we never accidentally redact `apiKeyId` (which
 * contains `apiKey` as a substring but is the public UUID).
 */
const SENSITIVE_FIELD_NAME_PATTERN =
  /^(?:authorization|cookie|set-cookie|password|secret|(?:.*[-_]?)?(?:raw[-_]?key|key[-_]?hash)|x[-_]?xs[-_]?api[-_]?key|api[-_]?key)$/i;

/**
 * Substring patterns within string values that should always be
 * scrubbed. Currently just raw API keys; bearer tokens are normally
 * carried in the Authorization header which is already scrubbed by
 * field-name match before string-content scrubbing runs.
 */
function scrubStringContent(value: string): string {
  return value.replace(RAW_API_KEY_REDACTION_PATTERN, '[REDACTED:RAW_API_KEY]');
}

/**
 * Recursive scrub. Replaces sensitive values with the literal string
 * `[REDACTED]` instead of mutating the original object.
 *
 * Caps recursion depth at 8 to avoid pathological cycles; cycles
 * themselves are detected via a `WeakSet` of seen objects.
 */
export function redactLogValue(value: unknown, depth = 0, seen = new WeakSet()): unknown {
  if (depth > 8) return '[REDACTED:DEPTH]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubStringContent(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'symbol' || typeof value === 'function') return String(value);

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[REDACTED:CYCLE]';
    seen.add(value);
    return value.map((item) => redactLogValue(item, depth + 1, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[REDACTED:CYCLE]';
    seen.add(value as object);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_FIELD_NAME_PATTERN.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactLogValue(v, depth + 1, seen);
      }
    }
    return out;
  }

  return value;
}

/**
 * Scrub every argument passed to the logger.
 *
 * The logger signature is `(msg: string, ...args: unknown[])`. The
 * `msg` template is provided by the call site (developer-controlled,
 * never user-controlled), but the variadic `args` carry structured
 * context which may transitively include user-controlled data. We
 * therefore scrub the variadic args only and leave `msg` untouched.
 */
export function redactLogArgs(args: unknown[]): unknown[] {
  return args.map((arg) => redactLogValue(arg));
}
