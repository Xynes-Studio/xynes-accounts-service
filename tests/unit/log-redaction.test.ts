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
