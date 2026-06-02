import { describe, it, expect } from 'bun:test';

import { maskInviteUrl } from '../../../src/infra/mail/inviteUrlMask';

describe('maskInviteUrl (MAIL-2)', () => {
  it('masks the token segment to the last 8 chars only', () => {
    const url =
      'http://localhost:3100/invite/abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const masked = maskInviteUrl(url);
    expect(masked).toContain('http://localhost:3100/invite/***');
    expect(masked).not.toContain(
      'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    );
    // Last 8 chars of the token are revealed for operator spot-checks.
    expect(masked).toEndWith('23456789');
  });

  it('preserves query strings and fragments after the token', () => {
    const url = 'http://localhost:3100/invite/abc1234567890def?utm=mail#top';
    const masked = maskInviteUrl(url);
    expect(masked).toEndWith('?utm=mail#top');
    expect(masked).toContain('/invite/***');
    expect(masked).not.toContain('abc1234567890def');
  });

  it('passes through URLs that do not match the /invite/<token> shape', () => {
    expect(maskInviteUrl('http://localhost:3100/login')).toBe('http://localhost:3100/login');
    expect(maskInviteUrl('http://localhost:3100/invite/')).toBe('http://localhost:3100/invite/');
  });

  it('returns a marker for invalid inputs without crashing', () => {
    expect(maskInviteUrl('')).toBe('[REDACTED:INVALID_URL]');
    // @ts-expect-error — intentionally testing hostile input.
    expect(maskInviteUrl(null)).toBe('[REDACTED:INVALID_URL]');
    // @ts-expect-error — intentionally testing hostile input.
    expect(maskInviteUrl(undefined)).toBe('[REDACTED:INVALID_URL]');
  });

  it('keeps short tokens fully visible (token <= 8 chars)', () => {
    // Edge case: a short token (degenerate but possible if a future
    // story shortens tokens) reveals the entire token. The mask still
    // gates against the structural form — at minimum, the `***` prefix
    // appears so callers can identify masked output.
    const masked = maskInviteUrl('http://l/invite/short');
    expect(masked).toBe('http://l/invite/***short');
  });

  it('never includes a raw 64-hex token after masking', () => {
    const longHex = 'a'.repeat(64);
    const masked = maskInviteUrl(`http://localhost:3100/invite/${longHex}`);
    expect(masked).not.toContain(longHex);
  });
});
