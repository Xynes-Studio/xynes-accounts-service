import { describe, it, expect } from 'bun:test';
import { normalizeWorkspaceDomain, type NormalizedDomain } from './domainValidation';

describe('normalizeWorkspaceDomain', () => {
  // ─── Happy-path normalization ────────────────────────────────

  it('accepts a valid domain and normalizes to lowercase', () => {
    const result = normalizeWorkspaceDomain('Example.com');
    expect(result.hostname).toBe('example.com');
  });

  it('trims whitespace from input', () => {
    const result = normalizeWorkspaceDomain('  example.com  ');
    expect(result.hostname).toBe('example.com');
  });

  it('accepts multi-level subdomains', () => {
    const result = normalizeWorkspaceDomain('blog.staging.example.com');
    expect(result.hostname).toBe('blog.staging.example.com');
  });

  it('returns correct verificationName format', () => {
    const result = normalizeWorkspaceDomain('example.com');
    expect(result.verificationName).toBe('_xynes.example.com');
  });

  it('returns type-safe NormalizedDomain shape', () => {
    const result: NormalizedDomain = normalizeWorkspaceDomain('example.com');
    expect(result).toHaveProperty('hostname');
    expect(result).toHaveProperty('verificationName');
    expect(typeof result.hostname).toBe('string');
    expect(typeof result.verificationName).toBe('string');
  });

  // ─── Rejection: protocols ────────────────────────────────────

  it('rejects input with https:// protocol', () => {
    expect(() => normalizeWorkspaceDomain('https://example.com')).toThrow();
  });

  it('rejects input with http:// protocol', () => {
    expect(() => normalizeWorkspaceDomain('http://example.com')).toThrow();
  });

  it('rejects input with ftp:// protocol', () => {
    expect(() => normalizeWorkspaceDomain('ftp://example.com')).toThrow();
  });

  // ─── Rejection: paths & query strings ────────────────────────

  it('rejects input with a path', () => {
    expect(() => normalizeWorkspaceDomain('example.com/blog')).toThrow();
  });

  it('rejects input with query string', () => {
    expect(() => normalizeWorkspaceDomain('example.com?key=val')).toThrow();
  });

  it('rejects input with fragment', () => {
    expect(() => normalizeWorkspaceDomain('example.com#section')).toThrow();
  });

  // ─── Rejection: ports ────────────────────────────────────────

  it('rejects input with a port', () => {
    expect(() => normalizeWorkspaceDomain('example.com:8080')).toThrow();
  });

  // ─── Rejection: wildcards ────────────────────────────────────

  it('rejects wildcard domains', () => {
    expect(() => normalizeWorkspaceDomain('*.example.com')).toThrow();
  });

  it('rejects embedded wildcard', () => {
    expect(() => normalizeWorkspaceDomain('sub.*.example.com')).toThrow();
  });

  // ─── Rejection: localhost ────────────────────────────────────

  it('rejects localhost', () => {
    expect(() => normalizeWorkspaceDomain('localhost')).toThrow();
  });

  it('rejects LOCALHOST (case-insensitive)', () => {
    expect(() => normalizeWorkspaceDomain('LOCALHOST')).toThrow();
  });

  // ─── Rejection: IP addresses ─────────────────────────────────

  it('rejects IPv4 literal', () => {
    expect(() => normalizeWorkspaceDomain('192.168.1.1')).toThrow();
  });

  it('rejects IPv4 loopback', () => {
    expect(() => normalizeWorkspaceDomain('127.0.0.1')).toThrow();
  });

  it('rejects IPv6 literal (bracketed)', () => {
    expect(() => normalizeWorkspaceDomain('[::1]')).toThrow();
  });

  it('rejects IPv6 literal (bare)', () => {
    expect(() => normalizeWorkspaceDomain('::1')).toThrow();
  });

  it('rejects IPv4-mapped IPv6', () => {
    expect(() => normalizeWorkspaceDomain('::ffff:192.168.1.1')).toThrow();
  });

  // ─── Rejection: missing TLD / no dots ────────────────────────

  it('rejects single-label hostnames (no dot)', () => {
    expect(() => normalizeWorkspaceDomain('intranet')).toThrow();
  });

  // ─── Rejection: empty / whitespace ───────────────────────────

  it('rejects empty string', () => {
    expect(() => normalizeWorkspaceDomain('')).toThrow();
  });

  it('rejects whitespace-only string', () => {
    expect(() => normalizeWorkspaceDomain('   ')).toThrow();
  });

  // ─── Edge cases ──────────────────────────────────────────────

  it('accepts hyphenated subdomains', () => {
    const result = normalizeWorkspaceDomain('my-site.example.com');
    expect(result.hostname).toBe('my-site.example.com');
  });

  it('rejects trailing dot (FQDN notation)', () => {
    expect(() => normalizeWorkspaceDomain('example.com.')).toThrow();
  });

  it('rejects leading dot', () => {
    expect(() => normalizeWorkspaceDomain('.example.com')).toThrow();
  });

  it('rejects domains exceeding 253 characters', () => {
    const longLabel = 'a'.repeat(63);
    // 63 + 1 + 63 + 1 + 63 + 1 + 63 + 1 + 3 = 259 chars (> 253)
    const longDomain = `${longLabel}.${longLabel}.${longLabel}.${longLabel}.com`;
    expect(() => normalizeWorkspaceDomain(longDomain)).toThrow();
  });

  it('rejects labels exceeding 63 characters', () => {
    const longLabel = 'a'.repeat(64);
    expect(() => normalizeWorkspaceDomain(`${longLabel}.com`)).toThrow();
  });
});
