// Logger sink for accounts-service.
//
// All values forwarded to `console.*` are scrubbed by `redactLogArgs`
// (defined in `./log-redaction`) which:
//   - Replaces raw workspace API keys (`xynes_live_<hex>`) with
//     `[REDACTED:RAW_API_KEY]` anywhere in string content.
//   - Replaces values of fields whose names match a sensitive-name
//     allowlist (`authorization`, `cookie`, `password`, `secret`,
//     `rawKey`, `keyHash`, `apiKey` exact-match) with `[REDACTED]`.
//
// Public identifiers like `apiKeyId` (UUID) and `keyPrefix` (8 hex
// chars) are deliberately readable in logs — they're the audit trail
// security ops uses to attribute behavior back to an issued key. This
// mirrors the gateway's `xynes-gateway/src/logging/redaction.ts`
// posture. The CodeQL `js/clear-text-logging` rule flags identifier
// names that match secret heuristics (e.g. anything containing
// `apiKey`); it cannot infer from names alone that `apiKeyId` is a
// public UUID, so we suppress the rule on this sink with the
// justification that the redaction layer enforces the actual contract
// at runtime.
//
// codeql[js/clear-text-logging]
import { redactLogArgs } from './log-redaction';

export const logger = {
  info: (msg: string, ...args: unknown[]) =>
    // codeql[js/clear-text-logging]
    console.log(`[INFO] ${msg}`, ...redactLogArgs(args)),
  error: (msg: string, ...args: unknown[]) =>
    // codeql[js/clear-text-logging]
    console.error(`[ERROR] ${msg}`, ...redactLogArgs(args)),
  warn: (msg: string, ...args: unknown[]) =>
    // codeql[js/clear-text-logging]
    console.warn(`[WARN] ${msg}`, ...redactLogArgs(args)),
  debug: (msg: string, ...args: unknown[]) =>
    // codeql[js/clear-text-logging]
    console.debug(`[DEBUG] ${msg}`, ...redactLogArgs(args)),
};
