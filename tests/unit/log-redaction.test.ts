import { describe, it, expect } from 'bun:test';
import { redactLogValue, redactLogArgs } from '../../src/infra/log-redaction';

const RAW_KEY = 'xynes_live_aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222';

describe('redactLogValue — primitive passthrough', () => {
  it('returns null and undefined unchanged', () => {
    expect(redactLogValue(null)).toBeNull();
    expect(redactLogValue(undefined)).toBeUndefined();
  });

  it('returns numbers, booleans, and bigints unchanged', () => {
    expect(redactLogValue(42)).toBe(42);
    expect(redactLogValue(true)).toBe(true);
    expect(redactLogValue(123n)).toBe(123n);
  });

  it('returns ordinary strings unchanged', () => {
    expect(redactLogValue('hello world')).toBe('hello world');
    expect(redactLogValue('')).toBe('');
  });

  it('serialises symbols and functions to strings', () => {
    const sym = Symbol('test');
    expect(typeof redactLogValue(sym)).toBe('string');
    expect(typeof redactLogValue(() => 1)).toBe('string');
  });
});

describe('redactLogValue — raw API keys in string content', () => {
  it('scrubs a bare raw API key from a string', () => {
    expect(redactLogValue(RAW_KEY)).toBe('[REDACTED:RAW_API_KEY]');
  });

  it('scrubs a raw API key embedded in surrounding text', () => {
    const out = redactLogValue(`Authorization: Bearer ${RAW_KEY} was used`);
    expect(out).toContain('[REDACTED:RAW_API_KEY]');
    expect(out as string).not.toContain('xynes_live_');
  });

  it('scrubs multiple raw API keys in the same string', () => {
    const a = 'xynes_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const b = 'xynes_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const out = redactLogValue(`first=${a} second=${b}`) as string;
    expect(out).not.toContain('xynes_live_');
    const matches = out.match(/\[REDACTED:RAW_API_KEY\]/g);
    expect(matches?.length).toBe(2);
  });

  it('preserves the public apiKeyId UUID format unchanged', () => {
    // apiKeyId is a public identifier and must NOT be redacted by
    // string-content scrubbing. The 11-character `xynes_live_` marker
    // is required for the raw-key pattern to match.
    const apiKeyId = '550e8400-e29b-41d4-a716-446655440099';
    expect(redactLogValue(apiKeyId)).toBe(apiKeyId);
  });
});

describe('redactLogValue — sensitive field names', () => {
  it('redacts the value of a field named `authorization`', () => {
    const out = redactLogValue({ authorization: `Bearer ${RAW_KEY}` }) as Record<string, unknown>;
    expect(out.authorization).toBe('[REDACTED]');
  });

  it('redacts the value of a field named `password`', () => {
    expect((redactLogValue({ password: 'p4ss' }) as any).password).toBe('[REDACTED]');
  });

  it('redacts the value of a field named `secret`', () => {
    expect((redactLogValue({ secret: 'shh' }) as any).secret).toBe('[REDACTED]');
  });

  it('redacts the value of a field named `rawKey` / `raw_key`', () => {
    expect((redactLogValue({ rawKey: RAW_KEY }) as any).rawKey).toBe('[REDACTED]');
    expect((redactLogValue({ raw_key: RAW_KEY }) as any).raw_key).toBe('[REDACTED]');
  });

  it('redacts the value of a field named `keyHash` / `key_hash`', () => {
    expect((redactLogValue({ keyHash: 'argon2id$...' }) as any).keyHash).toBe('[REDACTED]');
    expect((redactLogValue({ key_hash: 'argon2id$...' }) as any).key_hash).toBe('[REDACTED]');
  });

  it('redacts the value of a field named exactly `apiKey`', () => {
    expect((redactLogValue({ apiKey: RAW_KEY }) as any).apiKey).toBe('[REDACTED]');
    expect((redactLogValue({ api_key: RAW_KEY }) as any).api_key).toBe('[REDACTED]');
  });

  it('redacts the value of an `x-xs-api-key` header field', () => {
    expect((redactLogValue({ 'x-xs-api-key': RAW_KEY }) as any)['x-xs-api-key']).toBe('[REDACTED]');
  });

  it('PRESERVES `apiKeyId` (public UUID) — anchored regex must not match', () => {
    const apiKeyId = '550e8400-e29b-41d4-a716-446655440099';
    expect((redactLogValue({ apiKeyId }) as any).apiKeyId).toBe(apiKeyId);
  });

  it('PRESERVES `keyPrefix` (public 8-hex audit identifier)', () => {
    expect((redactLogValue({ keyPrefix: 'a1b2c3d4' }) as any).keyPrefix).toBe('a1b2c3d4');
  });

  it('PRESERVES `presetKey` (public preset name)', () => {
    expect((redactLogValue({ presetKey: 'cms_readonly' }) as any).presetKey).toBe('cms_readonly');
  });

  it('PRESERVES `workspaceId`, `userId`, `requestId`', () => {
    const ctx = {
      workspaceId: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440001',
      requestId: 'req-abc',
    };
    expect(redactLogValue(ctx)).toEqual(ctx);
  });
});

describe('redactLogValue — recursion + arrays', () => {
  it('redacts sensitive fields nested inside objects', () => {
    const out = redactLogValue({
      ctx: { workspaceId: 'ws-1', authorization: `Bearer ${RAW_KEY}` },
    }) as any;
    expect(out.ctx.authorization).toBe('[REDACTED]');
    expect(out.ctx.workspaceId).toBe('ws-1');
  });

  it('redacts raw keys nested inside string values of arrays', () => {
    const out = redactLogValue([`token=${RAW_KEY}`]) as string[];
    expect(out[0]).toContain('[REDACTED:RAW_API_KEY]');
    expect(out[0]).not.toContain('xynes_live_');
  });

  it('does not mutate the input object', () => {
    const input = { authorization: 'Bearer secret' };
    redactLogValue(input);
    expect(input.authorization).toBe('Bearer secret');
  });

  it('handles cyclic structures without throwing', () => {
    const a: any = { name: 'a' };
    a.self = a;
    const out = redactLogValue(a) as any;
    expect(out.name).toBe('a');
    expect(out.self).toBe('[REDACTED:CYCLE]');
  });

  it('caps recursion depth on pathologically deep input', () => {
    let deep: any = { leaf: true };
    for (let i = 0; i < 20; i += 1) deep = { next: deep };
    const out = redactLogValue(deep) as any;
    // Walk down the chain — eventually we hit the depth marker.
    let cur = out;
    let hops = 0;
    while (cur && typeof cur === 'object' && cur.next) {
      cur = cur.next;
      hops += 1;
      if (hops > 10) break;
    }
    expect(typeof cur === 'string' || cur === '[REDACTED:DEPTH]' || cur?.leaf === true).toBe(true);
  });
});

describe('redactLogArgs — variadic logger args', () => {
  it('scrubs each arg independently', () => {
    const out = redactLogArgs([
      'plain string',
      { authorization: `Bearer ${RAW_KEY}` },
      `embedded ${RAW_KEY}`,
    ]);
    expect(out[0]).toBe('plain string');
    expect((out[1] as any).authorization).toBe('[REDACTED]');
    expect(out[2] as string).not.toContain('xynes_live_');
  });

  it('returns an empty array for no args', () => {
    expect(redactLogArgs([])).toEqual([]);
  });

  it('preserves non-sensitive structured context unchanged', () => {
    const ctx = {
      requestId: 'req-1',
      workspaceId: '550e8400-e29b-41d4-a716-446655440000',
      apiKeyId: '550e8400-e29b-41d4-a716-446655440099',
      keyPrefix: 'a1b2c3d4',
      presetKey: 'workspace_admin',
      actorType: 'api_key',
    };
    const [out] = redactLogArgs([ctx]);
    expect(out).toEqual(ctx);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// MAIL-4 — Resend API key redaction
// ──────────────────────────────────────────────────────────────────────────

describe('redactLogValue — MAIL-4 Resend API key string-content scrubbing', () => {
  const RESEND_KEY = 're_aabbccddee_eeff00112233';

  it('scrubs a bare Resend API key from a string', () => {
    const out = redactLogValue(RESEND_KEY) as string;
    expect(out).toBe('[REDACTED:RESEND_API_KEY]');
  });

  it('scrubs a Resend API key embedded in a Bearer header string', () => {
    const out = redactLogValue(`Authorization: Bearer ${RESEND_KEY}`) as string;
    expect(out).toContain('[REDACTED:RESEND_API_KEY]');
    expect(out).not.toContain('re_aabbccddee');
  });

  it('scrubs multiple Resend keys from the same string', () => {
    const a = 're_aaaaaaaa_bbbbbbbb';
    const b = 're_cccccccc_dddddddd';
    const out = redactLogValue(`first=${a} second=${b}`) as string;
    const matches = out.match(/\[REDACTED:RESEND_API_KEY\]/g);
    expect(matches?.length).toBe(2);
    expect(out).not.toMatch(/re_[a-zA-Z0-9_]{8}/);
  });

  it('does NOT scrub the literal "re_" prefix when followed by too few chars', () => {
    // A 7-char tail would be ambiguous with regular text; the pattern
    // requires at least 8 chars. The string `re_short` is harmless.
    const out = redactLogValue('the prefix re_short stays') as string;
    expect(out).toBe('the prefix re_short stays');
  });

  it('does NOT scrub `regex`, `repeat`, `redirect`, or other re-prefixed words', () => {
    // The pattern is `re_<X>` not `re<X>` so words without an
    // underscore should pass through untouched.
    const out = redactLogValue('regex repeats redirect representation reverse') as string;
    expect(out).toBe('regex repeats redirect representation reverse');
  });

  it('redacts both Resend and Xynes raw keys when both appear', () => {
    const out = redactLogValue(`xyn=${RAW_KEY} rs=${RESEND_KEY}`) as string;
    expect(out).toContain('[REDACTED:RAW_API_KEY]');
    expect(out).toContain('[REDACTED:RESEND_API_KEY]');
    expect(out).not.toContain('xynes_live_');
    expect(out).not.toContain('re_aabbccddee');
  });
});

describe('redactLogValue — MAIL-4 Resend field-name redaction', () => {
  it('redacts the value of a field named `resendApiKey`', () => {
    const out = redactLogValue({ resendApiKey: 're_secret_value_long_enough' });
    expect((out as Record<string, unknown>).resendApiKey).toBe('[REDACTED]');
  });

  it('redacts the value of a field named `resend_api_key`', () => {
    const out = redactLogValue({ resend_api_key: 're_secret_value_long_enough' });
    expect((out as Record<string, unknown>).resend_api_key).toBe('[REDACTED]');
  });

  it('redacts the value of a field named `resend-api-key`', () => {
    const out = redactLogValue({ 'resend-api-key': 're_secret_value_long_enough' });
    expect((out as Record<string, unknown>)['resend-api-key']).toBe('[REDACTED]');
  });

  it('PRESERVES `resendMessageId` (public audit identifier)', () => {
    // The Resend response carries an `id` field which we surface
    // publicly as `messageId`. It is a public audit handle — NOT a
    // secret — and MUST remain readable in operator logs.
    const out = redactLogValue({ messageId: 'resend-msg-abc-123' });
    expect((out as Record<string, unknown>).messageId).toBe('resend-msg-abc-123');
  });

  it('PRESERVES the literal string "resend" when used as a non-secret value', () => {
    // E.g. logging `{ provider: 'resend' }` is just metadata; we
    // shouldn't redact it.
    const out = redactLogValue({ provider: 'resend' });
    expect((out as Record<string, unknown>).provider).toBe('resend');
  });
});
