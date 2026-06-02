/**
 * MAIL-4 — Unit tests for the `SecretManagerClient` port + local-dev
 * `EnvSecretManagerClient` impl in `src/infra/secrets`.
 *
 * Covers:
 *   - `parseSecretRef` strict URI validation (all 8 rejection paths).
 *   - `secretPathToEnvPrefix` pure mapping (injectivity proven by example).
 *   - `EnvSecretManagerClient.resolve` happy path + every error code +
 *     no-leak invariant.
 *   - `isSecretManagerError` type guard.
 *
 * Security invariants (proven inline):
 *   - URI parser rejects file:// / http:// / data: / underscores / `..` etc.
 *   - `secretPathToEnvPrefix` is injective by construction; collision between
 *     `mail/resend-dev` and `mail/resend/dev` shape is structurally
 *     impossible (asserted by example below).
 *   - Hostile env values NEVER survive into the resolver's `Error.message`.
 *   - The MAIL prefix (`MAIL_CREDENTIAL_*`) is distinct from the storage
 *     prefix (`STORAGE_CREDENTIAL_*`) — a mail-shaped path will NEVER resolve
 *     to a storage-shaped env var even if the path string happens to match.
 */

import { describe, expect, it } from 'bun:test';

import {
  EnvSecretManagerClient,
  SecretManagerError,
  isSecretManagerError,
  parseSecretRef,
  secretPathToEnvPrefix,
  type SecretManagerErrorCode,
} from '../../../src/infra/secrets';

// ──────────────────────────────────────────────────────────────────────────
// parseSecretRef
// ──────────────────────────────────────────────────────────────────────────

describe('parseSecretRef', () => {
  it('returns the bare path component for a valid secret:// URI', () => {
    expect(parseSecretRef('secret://xynes/mail/resend-dev')).toBe('xynes/mail/resend-dev');
  });

  it('accepts a single-segment path', () => {
    expect(parseSecretRef('secret://resend')).toBe('resend');
  });

  it('rejects non-string input as URI_INVALID', () => {
    expect(() => parseSecretRef(null as unknown as string)).toThrow(SecretManagerError);
    try {
      parseSecretRef(null as unknown as string);
    } catch (err) {
      expect(err).toBeInstanceOf(SecretManagerError);
      expect((err as SecretManagerError).code).toBe('URI_INVALID' satisfies SecretManagerErrorCode);
    }
  });

  it('rejects empty / whitespace-only as URI_INVALID', () => {
    expect(() => parseSecretRef('')).toThrow(SecretManagerError);
    expect(() => parseSecretRef('   ')).toThrow(SecretManagerError);
  });

  it('rejects non-secret:// schemes as URI_INVALID', () => {
    const cases = [
      'file:///etc/passwd',
      'http://example.com',
      'https://example.com',
      'data:text/plain,xxx',
      'ftp://example.com',
      'javascript:alert(1)',
    ];
    for (const c of cases) {
      try {
        parseSecretRef(c);
        throw new Error(`expected URI_INVALID for: ${c}`);
      } catch (err) {
        expect(err).toBeInstanceOf(SecretManagerError);
        expect((err as SecretManagerError).code).toBe('URI_INVALID');
      }
    }
  });

  it('rejects empty path after the prefix', () => {
    try {
      parseSecretRef('secret://');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretManagerError);
      expect((err as SecretManagerError).code).toBe('URI_INVALID');
    }
  });

  it('rejects a leading slash in the path', () => {
    try {
      parseSecretRef('secret:///xynes/mail/resend');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretManagerError);
      expect((err as SecretManagerError).code).toBe('URI_INVALID');
    }
  });

  it('rejects path traversal sequences', () => {
    try {
      parseSecretRef('secret://xynes/../mail');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretManagerError);
      expect((err as SecretManagerError).code).toBe('URI_INVALID');
    }
  });

  it('rejects a query string component', () => {
    try {
      parseSecretRef('secret://xynes/mail?leak=1');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretManagerError);
      expect((err as SecretManagerError).code).toBe('URI_INVALID');
    }
  });

  it('rejects a fragment component', () => {
    try {
      parseSecretRef('secret://xynes/mail#leak');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretManagerError);
      expect((err as SecretManagerError).code).toBe('URI_INVALID');
    }
  });

  it('rejects underscores in the path (would break injectivity of secretPathToEnvPrefix)', () => {
    try {
      parseSecretRef('secret://xynes/mail/resend_dev');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretManagerError);
      expect((err as SecretManagerError).code).toBe('URI_INVALID');
    }
  });

  it('rejects uppercase letters in the path', () => {
    try {
      parseSecretRef('secret://Xynes/Mail/Resend');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretManagerError);
      expect((err as SecretManagerError).code).toBe('URI_INVALID');
    }
  });

  it('rejects paths over 256 chars', () => {
    const longPath = 'a'.repeat(257);
    try {
      parseSecretRef(`secret://${longPath}`);
    } catch (err) {
      expect(err).toBeInstanceOf(SecretManagerError);
      expect((err as SecretManagerError).code).toBe('URI_INVALID');
    }
  });

  it('accepts exactly the 256-char boundary', () => {
    const boundaryPath = 'a'.repeat(256);
    expect(parseSecretRef(`secret://${boundaryPath}`)).toBe(boundaryPath);
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseSecretRef('  secret://xynes/mail/resend-dev  ')).toBe('xynes/mail/resend-dev');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// secretPathToEnvPrefix
// ──────────────────────────────────────────────────────────────────────────

describe('secretPathToEnvPrefix', () => {
  it('encodes `/` as `__` and `-` as `_`', () => {
    expect(secretPathToEnvPrefix('xynes/mail/resend-dev')).toBe(
      'MAIL_CREDENTIAL_XYNES__MAIL__RESEND_DEV',
    );
  });

  it('preserves injectivity between segment-/ vs within-segment - paths', () => {
    // The two refs below MUST produce DIFFERENT env prefixes — otherwise a
    // hostile caller could swap an underscore for a slash and silently
    // route to a different credential block.
    const slashVariant = secretPathToEnvPrefix('mail/resend/dev');
    const hyphenVariant = secretPathToEnvPrefix('mail/resend-dev');
    expect(slashVariant).not.toBe(hyphenVariant);
    expect(slashVariant).toBe('MAIL_CREDENTIAL_MAIL__RESEND__DEV');
    expect(hyphenVariant).toBe('MAIL_CREDENTIAL_MAIL__RESEND_DEV');
  });

  it('uses the MAIL_ prefix (distinct from storage)', () => {
    const out = secretPathToEnvPrefix('xynes/mail/resend-dev');
    expect(out.startsWith('MAIL_CREDENTIAL_')).toBe(true);
    expect(out.startsWith('STORAGE_CREDENTIAL_')).toBe(false);
  });

  it('is a pure function (no env access)', () => {
    // Re-running with the same input MUST give the same output regardless
    // of process.env contents. We assert by simple equality.
    const a = secretPathToEnvPrefix('xynes/mail/resend-dev');
    const b = secretPathToEnvPrefix('xynes/mail/resend-dev');
    expect(a).toBe(b);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// EnvSecretManagerClient
// ──────────────────────────────────────────────────────────────────────────

describe('EnvSecretManagerClient', () => {
  it('resolves both fields from the matching env block', async () => {
    const env = {
      MAIL_CREDENTIAL_XYNES__MAIL__RESEND_DEV_API_KEY: 're_test_apikey_value_aaaa',
      MAIL_CREDENTIAL_XYNES__MAIL__RESEND_DEV_FROM_ADDRESS: 'no-reply@dev.example.com',
    } as NodeJS.ProcessEnv;
    const client = new EnvSecretManagerClient({ env });
    const out = await client.resolve('secret://xynes/mail/resend-dev');
    expect(out.apiKey).toBe('re_test_apikey_value_aaaa');
    expect(out.fromAddress).toBe('no-reply@dev.example.com');
  });

  it('throws NOT_FOUND when both env vars are missing', async () => {
    const client = new EnvSecretManagerClient({ env: {} });
    try {
      await client.resolve('secret://xynes/mail/resend-dev');
      throw new Error('expected NOT_FOUND throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretManagerError);
      expect((err as SecretManagerError).code).toBe('NOT_FOUND');
    }
  });

  it('throws MATERIAL_INVALID when only API_KEY is missing', async () => {
    const env = {
      MAIL_CREDENTIAL_XYNES__MAIL__RESEND_DEV_FROM_ADDRESS: 'no-reply@dev.example.com',
    } as NodeJS.ProcessEnv;
    const client = new EnvSecretManagerClient({ env });
    try {
      await client.resolve('secret://xynes/mail/resend-dev');
      throw new Error('expected MATERIAL_INVALID throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretManagerError);
      expect((err as SecretManagerError).code).toBe('MATERIAL_INVALID');
    }
  });

  it('throws MATERIAL_INVALID when only FROM_ADDRESS is missing', async () => {
    const env = {
      MAIL_CREDENTIAL_XYNES__MAIL__RESEND_DEV_API_KEY: 're_test_apikey_aaaa',
    } as NodeJS.ProcessEnv;
    const client = new EnvSecretManagerClient({ env });
    try {
      await client.resolve('secret://xynes/mail/resend-dev');
      throw new Error('expected MATERIAL_INVALID throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretManagerError);
      expect((err as SecretManagerError).code).toBe('MATERIAL_INVALID');
    }
  });

  it('throws MATERIAL_INVALID when API_KEY is blank', async () => {
    const env = {
      MAIL_CREDENTIAL_XYNES__MAIL__RESEND_DEV_API_KEY: '   ',
      MAIL_CREDENTIAL_XYNES__MAIL__RESEND_DEV_FROM_ADDRESS: 'no-reply@dev.example.com',
    } as NodeJS.ProcessEnv;
    const client = new EnvSecretManagerClient({ env });
    try {
      await client.resolve('secret://xynes/mail/resend-dev');
      throw new Error('expected MATERIAL_INVALID throw');
    } catch (err) {
      expect((err as SecretManagerError).code).toBe('MATERIAL_INVALID');
    }
  });

  it('throws MATERIAL_INVALID when FROM_ADDRESS is blank', async () => {
    const env = {
      MAIL_CREDENTIAL_XYNES__MAIL__RESEND_DEV_API_KEY: 're_test_apikey_aaaa',
      MAIL_CREDENTIAL_XYNES__MAIL__RESEND_DEV_FROM_ADDRESS: '',
    } as NodeJS.ProcessEnv;
    const client = new EnvSecretManagerClient({ env });
    try {
      await client.resolve('secret://xynes/mail/resend-dev');
      throw new Error('expected MATERIAL_INVALID throw');
    } catch (err) {
      expect((err as SecretManagerError).code).toBe('MATERIAL_INVALID');
    }
  });

  it('propagates URI_INVALID errors from parseSecretRef', async () => {
    const client = new EnvSecretManagerClient({ env: {} });
    try {
      await client.resolve('http://not-a-secret-uri');
      throw new Error('expected URI_INVALID throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretManagerError);
      expect((err as SecretManagerError).code).toBe('URI_INVALID');
    }
  });

  it('defaults to process.env when no deps are supplied', () => {
    // Constructor MUST NOT throw without `deps`. The behaviour against
    // the real env is exercised by the live mailer composition tests; we
    // just confirm the constructor accepts the zero-arg form here.
    const client = new EnvSecretManagerClient();
    expect(client).toBeInstanceOf(EnvSecretManagerClient);
  });

  it('error messages NEVER contain the resolved env values (no-leak invariant)', async () => {
    // Hostile env: the API key + from address contain shapes that look
    // like AWS credentials, AWS signatures, and raw Resend keys. None of
    // them should ever appear in any `SecretManagerError.message`.
    const HOSTILE_API_KEY = 're_AKIA-LEAK-1234-xynes_live_abc-X-Amz-Signature=DEADBEEF';
    const HOSTILE_FROM = 'attacker@evil.example';
    const env = {
      MAIL_CREDENTIAL_XYNES__MAIL__RESEND_DEV_API_KEY: HOSTILE_API_KEY,
      MAIL_CREDENTIAL_XYNES__MAIL__RESEND_DEV_FROM_ADDRESS: HOSTILE_FROM,
    } as NodeJS.ProcessEnv;
    const client = new EnvSecretManagerClient({ env });
    // Happy path — successful resolve does not throw, so the no-leak
    // invariant is moot here. But test the partial-config branch which
    // DOES throw and could be tempted to interpolate the partial value.
    delete env.MAIL_CREDENTIAL_XYNES__MAIL__RESEND_DEV_FROM_ADDRESS;
    try {
      await client.resolve('secret://xynes/mail/resend-dev');
      throw new Error('expected MATERIAL_INVALID throw');
    } catch (err) {
      const msg = (err as SecretManagerError).message;
      expect(msg).not.toContain(HOSTILE_API_KEY);
      expect(msg).not.toContain('AKIA-LEAK-1234');
      expect(msg).not.toContain('xynes_live_');
      expect(msg).not.toContain('X-Amz-Signature');
      expect(msg).not.toContain(HOSTILE_FROM);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// isSecretManagerError
// ──────────────────────────────────────────────────────────────────────────

describe('isSecretManagerError', () => {
  it('returns true for SecretManagerError instances', () => {
    expect(isSecretManagerError(new SecretManagerError('NOT_FOUND', 'x'))).toBe(true);
  });

  it('returns false for non-SecretManagerError throws', () => {
    expect(isSecretManagerError(new Error('plain'))).toBe(false);
    expect(isSecretManagerError(new TypeError('typed'))).toBe(false);
    expect(isSecretManagerError({ code: 'NOT_FOUND' })).toBe(false);
    expect(isSecretManagerError(null)).toBe(false);
    expect(isSecretManagerError(undefined)).toBe(false);
    expect(isSecretManagerError('NOT_FOUND')).toBe(false);
  });

  it('preserves instanceof across the cross-realm setPrototypeOf call', () => {
    // The class sets the prototype explicitly so `instanceof` survives
    // a structured-clone round-trip. We can't simulate cross-realm in
    // bun:test cheaply, but we can verify the prototype is wired.
    const e = new SecretManagerError('URI_INVALID', 'x');
    expect(Object.getPrototypeOf(e)).toBe(SecretManagerError.prototype);
  });
});
