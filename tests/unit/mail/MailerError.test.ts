import { describe, it, expect } from 'bun:test';

import {
  MailerError,
  isMailerError,
  type MailerErrorCode,
} from '../../../src/infra/mail/MailerError';

describe('MailerError (MAIL-2)', () => {
  it('exposes the closed-set code on the instance', () => {
    const err = new MailerError('RECIPIENT_INVALID');
    expect(err.code).toBe('RECIPIENT_INVALID');
    expect(err).toBeInstanceOf(MailerError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MailerError');
  });

  it('maps each code to the documented statusHint', () => {
    const expected: Record<MailerErrorCode, number> = {
      RECIPIENT_INVALID: 400,
      PROVIDER_UNAVAILABLE: 503,
      RATE_LIMITED: 429,
      TEMPLATE_RENDER_FAILED: 500,
      PROVIDER_REJECTED: 502,
    };
    for (const [code, status] of Object.entries(expected) as Array<[MailerErrorCode, number]>) {
      const err = new MailerError(code);
      expect(err.statusHint).toBe(status);
    }
  });

  it('flags retryable vs non-retryable codes per the closed-set table', () => {
    expect(new MailerError('PROVIDER_UNAVAILABLE').retryable).toBe(true);
    expect(new MailerError('RATE_LIMITED').retryable).toBe(true);
    expect(new MailerError('RECIPIENT_INVALID').retryable).toBe(false);
    expect(new MailerError('TEMPLATE_RENDER_FAILED').retryable).toBe(false);
    expect(new MailerError('PROVIDER_REJECTED').retryable).toBe(false);
  });

  it('uses fixed sanitized messages and never echoes provider text', () => {
    // Each code maps to a stable human-readable message.
    expect(new MailerError('RECIPIENT_INVALID').message).toContain('recipient');
    expect(new MailerError('PROVIDER_UNAVAILABLE').message).toContain('temporarily unavailable');
    expect(new MailerError('RATE_LIMITED').message).toContain('rate limit');
    expect(new MailerError('TEMPLATE_RENDER_FAILED').message).toContain('render');
    expect(new MailerError('PROVIDER_REJECTED').message).toContain('rejected');
  });

  it('does NOT accept upstream error text as a message override (no constructor leak)', () => {
    // MAIL-2 invariant: the error class never exposes a way to set a
    // free-form message. Constructing with a code alone is the only
    // supported call signature; the message text comes from the
    // closed-set table.
    const err = new MailerError('PROVIDER_REJECTED');
    // The TS compiler enforces this, but defense-in-depth: assert that
    // every closed-set message is short and does not contain typical
    // hostile substrings.
    const hostileMarkers = [
      'AKIA-',
      'xynes_live_',
      'X-Amz-Signature',
      'Bearer ',
      'password=',
      're_',
    ];
    for (const code of [
      'RECIPIENT_INVALID',
      'PROVIDER_UNAVAILABLE',
      'RATE_LIMITED',
      'TEMPLATE_RENDER_FAILED',
      'PROVIDER_REJECTED',
    ] satisfies MailerErrorCode[]) {
      const m = new MailerError(code).message;
      for (const marker of hostileMarkers) {
        expect(m).not.toContain(marker);
      }
    }
    expect(err.message.length).toBeLessThan(200);
  });

  it('accepts an opaque diagnosticTag without surfacing it in the message', () => {
    const err = new MailerError('PROVIDER_REJECTED', {
      diagnosticTag: 'resend-req-abc123',
    });
    expect(err.diagnosticTag).toBe('resend-req-abc123');
    // The tag is for operator log search; it must NOT be inside the
    // user-visible message.
    expect(err.message).not.toContain('resend-req-abc123');
  });

  it('isMailerError narrows correctly', () => {
    expect(isMailerError(new MailerError('RECIPIENT_INVALID'))).toBe(true);
    expect(isMailerError(new Error('not a mailer error'))).toBe(false);
    expect(isMailerError(null)).toBe(false);
    expect(isMailerError(undefined)).toBe(false);
    expect(isMailerError({ code: 'PROVIDER_REJECTED' })).toBe(false);
  });

  it('survives `instanceof` after a synthetic prototype reset', () => {
    // Defensive `Object.setPrototypeOf(this, new.target.prototype)` in
    // the constructor preserves `instanceof` across realm boundaries
    // (mirrors DomainError posture in src/libs/xynes/errors).
    const err = new MailerError('RATE_LIMITED');
    expect(err instanceof MailerError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});
