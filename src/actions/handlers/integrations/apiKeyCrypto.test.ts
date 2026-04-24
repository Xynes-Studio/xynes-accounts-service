import { describe, it, expect } from 'bun:test';
import {
  generateWorkspaceApiKey,
  hashWorkspaceApiKey,
  verifyWorkspaceApiKey,
  type GeneratedWorkspaceApiKey,
} from './apiKeyCrypto';

describe('generateWorkspaceApiKey', () => {
  // ─── Key generation ──────────────────────────────────────────

  it('returns the expected GeneratedWorkspaceApiKey shape', async () => {
    const key: GeneratedWorkspaceApiKey = await generateWorkspaceApiKey();
    expect(key).toHaveProperty('rawKey');
    expect(key).toHaveProperty('keyPrefix');
    expect(key).toHaveProperty('keyHash');
    expect(typeof key.rawKey).toBe('string');
    expect(typeof key.keyPrefix).toBe('string');
    expect(typeof key.keyHash).toBe('string');
  });

  it('raw key starts with xynes_live_ prefix', async () => {
    const key = await generateWorkspaceApiKey();
    expect(key.rawKey.startsWith('xynes_live_')).toBe(true);
  });

  it('raw key has sufficient entropy (at least 40 chars total)', async () => {
    const key = await generateWorkspaceApiKey();
    expect(key.rawKey.length).toBeGreaterThanOrEqual(40);
  });

  it('keyPrefix is a non-empty substring suitable for indexed lookup', async () => {
    const key = await generateWorkspaceApiKey();
    expect(key.keyPrefix.length).toBeGreaterThan(0);
    expect(key.keyPrefix.length).toBeLessThanOrEqual(16);
    // prefix should be at the start of the raw key (after stripping the known prefix)
    expect(key.rawKey).toContain(key.keyPrefix);
  });

  it('keyHash is not the raw key (one-way)', async () => {
    const key = await generateWorkspaceApiKey();
    expect(key.keyHash).not.toBe(key.rawKey);
    expect(key.keyHash).not.toContain(key.rawKey);
  });

  it('generates unique keys on successive calls', async () => {
    const [key1, key2] = await Promise.all([generateWorkspaceApiKey(), generateWorkspaceApiKey()]);
    expect(key1.rawKey).not.toBe(key2.rawKey);
    expect(key1.keyPrefix).not.toBe(key2.keyPrefix);
    expect(key1.keyHash).not.toBe(key2.keyHash);
  });
});

describe('hashWorkspaceApiKey', () => {
  it('returns a string that is not the raw key', async () => {
    const key = await generateWorkspaceApiKey();
    const hash = await hashWorkspaceApiKey(key.rawKey);
    expect(typeof hash).toBe('string');
    expect(hash).not.toBe(key.rawKey);
    expect(hash.length).toBeGreaterThan(0);
  });

  it('produces the same hash as generateWorkspaceApiKey when given the same raw key', async () => {
    // Note: if using salted hashes, this test verifies verifyWorkspaceApiKey instead
    // For salted hashes, each call produces a different hash, so we rely on verify
    const key = await generateWorkspaceApiKey();
    // The generated keyHash should be verifiable
    const verified = await verifyWorkspaceApiKey(key.rawKey, key.keyHash);
    expect(verified).toBe(true);
  });

  it('returns different hashes for different raw keys', async () => {
    const [key1, key2] = await Promise.all([generateWorkspaceApiKey(), generateWorkspaceApiKey()]);
    const hash1 = await hashWorkspaceApiKey(key1.rawKey);
    const hash2 = await hashWorkspaceApiKey(key2.rawKey);
    expect(hash1).not.toBe(hash2);
  });
});

describe('verifyWorkspaceApiKey', () => {
  it('succeeds for the original raw key', async () => {
    const key = await generateWorkspaceApiKey();
    const verified = await verifyWorkspaceApiKey(key.rawKey, key.keyHash);
    expect(verified).toBe(true);
  });

  it('succeeds when verifying against a freshly computed hash', async () => {
    const key = await generateWorkspaceApiKey();
    const freshHash = await hashWorkspaceApiKey(key.rawKey);
    const verified = await verifyWorkspaceApiKey(key.rawKey, freshHash);
    expect(verified).toBe(true);
  });

  it('fails for a different raw key', async () => {
    const key = await generateWorkspaceApiKey();
    const otherKey = await generateWorkspaceApiKey();
    const verified = await verifyWorkspaceApiKey(otherKey.rawKey, key.keyHash);
    expect(verified).toBe(false);
  });

  it('fails for a tampered hash', async () => {
    const key = await generateWorkspaceApiKey();
    const tampered = key.keyHash + 'x';
    const verified = await verifyWorkspaceApiKey(key.rawKey, tampered);
    expect(verified).toBe(false);
  });

  it('fails for a completely invalid hash format', async () => {
    const key = await generateWorkspaceApiKey();
    const verified = await verifyWorkspaceApiKey(key.rawKey, 'not-a-valid-hash-at-all');
    expect(verified).toBe(false);
  });

  it('fails for an empty raw key', async () => {
    const key = await generateWorkspaceApiKey();
    const verified = await verifyWorkspaceApiKey('', key.keyHash);
    expect(verified).toBe(false);
  });

  it('fails for an empty hash', async () => {
    const key = await generateWorkspaceApiKey();
    const verified = await verifyWorkspaceApiKey(key.rawKey, '');
    expect(verified).toBe(false);
  });
});

describe('security properties', () => {
  it('keyHash does not contain the raw secret', async () => {
    const key = await generateWorkspaceApiKey();
    // Extract the secret portion after the prefix
    const secret = key.rawKey.replace('xynes_live_', '');
    expect(key.keyHash).not.toContain(secret);
  });

  it('keyPrefix does not reveal the full secret', async () => {
    const key = await generateWorkspaceApiKey();
    const secret = key.rawKey.replace('xynes_live_', '');
    // prefix should be much shorter than the full secret
    expect(key.keyPrefix.length).toBeLessThan(secret.length);
  });
});
