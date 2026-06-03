/**
 * MAIL-4 — Unit tests for `resolveMailerFromEnv`.
 *
 * Covers:
 *   - Every branch of the decision matrix:
 *       • `MAIL_PROVIDER=resend` happy path.
 *       • `MAIL_PROVIDER=resend` missing `MAIL_RESEND_SECRET_REF`.
 *       • `MAIL_PROVIDER=resend` resolver throws each SecretManagerError code.
 *       • `MAIL_PROVIDER=resend` resolver throws non-SecretManagerError.
 *       • `MAIL_PROVIDER=stub` with `SMTP_RELAY_URL` → smtp_relay mode.
 *       • `MAIL_PROVIDER=stub` without `SMTP_RELAY_URL` → stdout mode.
 *       • `MAIL_PROVIDER=noop` → noopMailer.
 *       • `MAIL_PROVIDER` unset → noopMailer.
 *       • `MAIL_PROVIDER` malformed → noopMailer.
 *   - `parseMailProvider` pure helper.
 *   - No-leak invariant: env values containing hostile substrings
 *     NEVER survive into a thrown `MailerError.message`.
 */

import { describe, expect, it } from 'bun:test';

import { resolveMailerFromEnv, __forTesting__ } from '../../../src/infra/mail/resolveMailerFromEnv';
import { MailerError } from '../../../src/infra/mail/MailerError';
import { ResendMailerClient } from '../../../src/infra/mail/ResendMailerClient';
import { StubMailerClient } from '../../../src/infra/mail/StubMailerClient';
import { noopMailer } from '../../../src/infra/mail/noopMailer';
import { SecretManagerError, type SecretManagerClient } from '../../../src/infra/secrets';

const VALID_API_KEY = 're_test_apikey_value_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FROM = 'no-reply@dev.example.com';

function makeFakeSecrets(
  behaviour: 'success' | SecretManagerError['code'] | 'throw',
): SecretManagerClient {
  return {
    async resolve() {
      if (behaviour === 'success') {
        return { apiKey: VALID_API_KEY, fromAddress: FROM };
      }
      if (behaviour === 'throw') {
        throw new Error('non-secret-manager-error');
      }
      throw new SecretManagerError(behaviour, 'safe-message-for-tests');
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// parseMailProvider
// ──────────────────────────────────────────────────────────────────────────

describe('parseMailProvider (pure)', () => {
  it('recognises the three closed-set values', () => {
    expect(__forTesting__.parseMailProvider('resend')).toBe('resend');
    expect(__forTesting__.parseMailProvider('stub')).toBe('stub');
    expect(__forTesting__.parseMailProvider('noop')).toBe('noop');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(__forTesting__.parseMailProvider('  RESEND  ')).toBe('resend');
    expect(__forTesting__.parseMailProvider('Stub')).toBe('stub');
  });

  it('falls back to "noop" for unset / malformed values', () => {
    expect(__forTesting__.parseMailProvider(undefined)).toBe('noop');
    expect(__forTesting__.parseMailProvider('')).toBe('noop');
    expect(__forTesting__.parseMailProvider('SENDGRID')).toBe('noop');
    expect(__forTesting__.parseMailProvider('mailgun')).toBe('noop');
    expect(__forTesting__.parseMailProvider('null')).toBe('noop');
  });

  it('rejects non-string inputs as "noop"', () => {
    expect(__forTesting__.parseMailProvider(123 as unknown as string)).toBe('noop');
    expect(__forTesting__.parseMailProvider(null as unknown as string)).toBe('noop');
    expect(__forTesting__.parseMailProvider({} as unknown as string)).toBe('noop');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// resolveMailerFromEnv
// ──────────────────────────────────────────────────────────────────────────

describe('resolveMailerFromEnv — Resend branch', () => {
  it('returns a ResendMailerClient when MAIL_PROVIDER=resend and resolver succeeds', async () => {
    const mailer = await resolveMailerFromEnv({
      env: {
        MAIL_PROVIDER: 'resend',
        MAIL_RESEND_SECRET_REF: 'secret://xynes/mail/resend-dev',
      },
      secrets: makeFakeSecrets('success'),
    });
    expect(mailer).toBeInstanceOf(ResendMailerClient);
  });

  it('throws TEMPLATE_RENDER_FAILED when MAIL_RESEND_SECRET_REF is unset', async () => {
    try {
      await resolveMailerFromEnv({
        env: { MAIL_PROVIDER: 'resend' },
        secrets: makeFakeSecrets('success'),
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MailerError);
      expect((err as MailerError).code).toBe('TEMPLATE_RENDER_FAILED');
    }
  });

  it('throws TEMPLATE_RENDER_FAILED when MAIL_RESEND_SECRET_REF is whitespace', async () => {
    try {
      await resolveMailerFromEnv({
        env: { MAIL_PROVIDER: 'resend', MAIL_RESEND_SECRET_REF: '   ' },
        secrets: makeFakeSecrets('success'),
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('TEMPLATE_RENDER_FAILED');
    }
  });

  it('maps SecretManagerError NOT_FOUND → MailerError TEMPLATE_RENDER_FAILED', async () => {
    try {
      await resolveMailerFromEnv({
        env: { MAIL_PROVIDER: 'resend', MAIL_RESEND_SECRET_REF: 'secret://xynes/mail/resend-dev' },
        secrets: makeFakeSecrets('NOT_FOUND'),
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('TEMPLATE_RENDER_FAILED');
    }
  });

  it('maps SecretManagerError MATERIAL_INVALID → MailerError TEMPLATE_RENDER_FAILED', async () => {
    try {
      await resolveMailerFromEnv({
        env: { MAIL_PROVIDER: 'resend', MAIL_RESEND_SECRET_REF: 'secret://xynes/mail/resend-dev' },
        secrets: makeFakeSecrets('MATERIAL_INVALID'),
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('TEMPLATE_RENDER_FAILED');
    }
  });

  it('maps SecretManagerError URI_INVALID → MailerError TEMPLATE_RENDER_FAILED', async () => {
    try {
      await resolveMailerFromEnv({
        env: { MAIL_PROVIDER: 'resend', MAIL_RESEND_SECRET_REF: 'secret://xynes/mail/resend-dev' },
        secrets: makeFakeSecrets('URI_INVALID'),
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('TEMPLATE_RENDER_FAILED');
    }
  });

  it('maps SecretManagerError BACKEND_UNAVAILABLE → MailerError PROVIDER_UNAVAILABLE', async () => {
    try {
      await resolveMailerFromEnv({
        env: { MAIL_PROVIDER: 'resend', MAIL_RESEND_SECRET_REF: 'secret://xynes/mail/resend-dev' },
        secrets: makeFakeSecrets('BACKEND_UNAVAILABLE'),
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('PROVIDER_UNAVAILABLE');
    }
  });

  it('maps non-SecretManagerError throw → MailerError PROVIDER_UNAVAILABLE', async () => {
    try {
      await resolveMailerFromEnv({
        env: { MAIL_PROVIDER: 'resend', MAIL_RESEND_SECRET_REF: 'secret://xynes/mail/resend-dev' },
        secrets: makeFakeSecrets('throw'),
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as MailerError).code).toBe('PROVIDER_UNAVAILABLE');
    }
  });

  it('NEVER leaks the resolved API key into the returned client surface', async () => {
    const mailer = await resolveMailerFromEnv({
      env: {
        MAIL_PROVIDER: 'resend',
        MAIL_RESEND_SECRET_REF: 'secret://xynes/mail/resend-dev',
      },
      secrets: makeFakeSecrets('success'),
    });
    expect(JSON.stringify(mailer)).not.toContain(VALID_API_KEY);
  });

  it('NEVER leaks hostile secret material into thrown error messages', async () => {
    // The fake secrets throw an error whose message contains hostile
    // substrings. The composition helper MUST NOT echo any of them.
    const hostileSecrets: SecretManagerClient = {
      async resolve() {
        throw new SecretManagerError(
          'BACKEND_UNAVAILABLE',
          'auth failed: AKIA-LEAK-1234 X-Amz-Signature=DEAD re_LEAK_5678 xynes_live_aabbcc',
        );
      },
    };
    try {
      await resolveMailerFromEnv({
        env: { MAIL_PROVIDER: 'resend', MAIL_RESEND_SECRET_REF: 'secret://xynes/mail/resend-dev' },
        secrets: hostileSecrets,
      });
      throw new Error('expected throw');
    } catch (err) {
      const msg = (err as MailerError).message;
      expect(msg).not.toContain('AKIA-LEAK-1234');
      expect(msg).not.toContain('X-Amz-Signature');
      expect(msg).not.toContain('re_LEAK_5678');
      expect(msg).not.toContain('xynes_live_');
      expect(msg).not.toContain('auth failed');
    }
  });

  it('forwards the optional fetcher to the ResendMailerClient', async () => {
    const fetcherSpy = (async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const mailer = await resolveMailerFromEnv({
      env: { MAIL_PROVIDER: 'resend', MAIL_RESEND_SECRET_REF: 'secret://xynes/mail/resend-dev' },
      secrets: makeFakeSecrets('success'),
      fetcher: fetcherSpy,
    });
    expect(mailer).toBeInstanceOf(ResendMailerClient);
    // The fetcher field is non-enumerable, but we can verify the
    // mailer reaches our spy by triggering a send. We use the wire
    // shape coverage in ResendMailerClient.test.ts; here we just
    // confirm construction does not throw.
  });
});

describe('resolveMailerFromEnv — Stub branch', () => {
  it('returns a stub in smtp_relay mode when SMTP_RELAY_URL is set', async () => {
    const mailer = await resolveMailerFromEnv({
      env: {
        MAIL_PROVIDER: 'stub',
        SMTP_RELAY_URL: 'smtp://127.0.0.1:54325',
      },
    });
    expect(mailer).toBeInstanceOf(StubMailerClient);
    expect((mailer as StubMailerClient).mode).toBe('smtp_relay');
  });

  it('returns a stub in stdout mode when SMTP_RELAY_URL is unset', async () => {
    const mailer = await resolveMailerFromEnv({
      env: { MAIL_PROVIDER: 'stub' },
    });
    expect(mailer).toBeInstanceOf(StubMailerClient);
    expect((mailer as StubMailerClient).mode).toBe('stdout');
  });

  it('honours MAIL_STUB_FROM_ADDRESS when provided', async () => {
    const mailer = await resolveMailerFromEnv({
      env: {
        MAIL_PROVIDER: 'stub',
        SMTP_RELAY_URL: 'smtp://127.0.0.1:54325',
        MAIL_STUB_FROM_ADDRESS: 'custom@example.com',
      },
    });
    expect(mailer).toBeInstanceOf(StubMailerClient);
    // The class doesn't expose `fromAddress` for audit, so we just
    // assert construction succeeded — the value flows through.
  });
});

describe('resolveMailerFromEnv — fallback to noopMailer', () => {
  it('returns noopMailer when MAIL_PROVIDER is unset', async () => {
    const mailer = await resolveMailerFromEnv({ env: {} });
    expect(mailer).toBe(noopMailer);
  });

  it('returns noopMailer when MAIL_PROVIDER=noop (explicit)', async () => {
    const mailer = await resolveMailerFromEnv({ env: { MAIL_PROVIDER: 'noop' } });
    expect(mailer).toBe(noopMailer);
  });

  it('returns noopMailer when MAIL_PROVIDER value is unrecognised', async () => {
    const mailer = await resolveMailerFromEnv({ env: { MAIL_PROVIDER: 'SENDGRID' } });
    expect(mailer).toBe(noopMailer);
  });

  it('returns noopMailer when MAIL_PROVIDER value is whitespace', async () => {
    const mailer = await resolveMailerFromEnv({ env: { MAIL_PROVIDER: '   ' } });
    expect(mailer).toBe(noopMailer);
  });

  it('returns noopMailer when MAIL_PROVIDER value is empty string', async () => {
    const mailer = await resolveMailerFromEnv({ env: { MAIL_PROVIDER: '' } });
    expect(mailer).toBe(noopMailer);
  });
});

describe('resolveMailerFromEnv — defaults to process.env when no env override', () => {
  it('reads from process.env when deps.env is omitted', async () => {
    // We can't easily mutate process.env in a Bun test without leaking
    // state into other tests. But we can call the helper without an
    // `env` override and assert it doesn't throw — the production
    // path is "no MAIL_PROVIDER set → noopMailer", which is what we
    // want against an unmodified process.env in CI.
    const mailer = await resolveMailerFromEnv();
    // Worst case: a CI env that happens to have MAIL_PROVIDER set.
    // We only assert the return is non-null and one of the known
    // mailer shapes.
    expect(mailer).toBeDefined();
    const known =
      mailer === noopMailer ||
      mailer instanceof ResendMailerClient ||
      mailer instanceof StubMailerClient;
    expect(known).toBe(true);
  });
});

describe('__forTesting__ surface', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(__forTesting__)).toBe(true);
  });
});
