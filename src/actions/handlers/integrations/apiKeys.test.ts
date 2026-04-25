import { describe, it, expect } from 'bun:test';
import { DomainError } from '@xynes/errors';
import {
  createListApiKeysHandler,
  createCreateApiKeyHandler,
  createRevokeApiKeyHandler,
  createReadApiKeyUsageHandler,
  WORKSPACE_API_KEY_PRESETS,
} from './apiKeys';
import type { ActionContext } from '../../types';

// ── Helpers ────────────────────────────────────────────────────

const WORKSPACE_ID = '550e8400-e29b-41d4-a716-446655440000';
const USER_ID = '550e8400-e29b-41d4-a716-446655440001';
const KEY_ID = '550e8400-e29b-41d4-a716-446655440088';

function makeCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    requestId: 'req-test-api-keys',
    user: { email: 'dev@xynes.com' },
    ...overrides,
  };
}

function makeAuthzClient(allowed = true) {
  return {
    checkPermission: async () => allowed,
    assignRole: async () => {},
    listRolesForWorkspace: async () => [],
  };
}

// ── Fake DB helpers ────────────────────────────────────────────

const NOW = new Date('2026-04-24T12:00:00Z');

function makeApiKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: KEY_ID,
    workspaceId: WORKSPACE_ID,
    name: 'My CMS Key',
    keyPrefix: 'a1b2c3d4',
    keyHash: '$argon2id$v=19$m=19456,t=2,p=1$...',
    status: 'active',
    presetKey: 'cms_readonly',
    createdBy: USER_ID,
    createdAt: NOW,
    expiresAt: null,
    revokedAt: null,
    revokedBy: null,
    lastUsedAt: null,
    ...overrides,
  };
}

function makeScopeRow(overrides: Record<string, unknown> = {}) {
  return {
    apiKeyId: KEY_ID,
    actionKey: 'cms.content.listPublished',
    createdAt: NOW,
    ...overrides,
  };
}

type FakeDbConfig = {
  selectRows?: Record<string, unknown>[];
  scopeRows?: Record<string, unknown>[];
  insertSpy?: (row: Record<string, unknown>) => void;
  scopeInsertSpy?: (rows: Record<string, unknown>[]) => void;
  updateSpy?: (values: Record<string, unknown>) => void;
  insertThrow?: Error;
};

/**
 * Minimal fake Drizzle-style DB client.
 * Supports the chaining patterns used by our handlers:
 *   select().from(table).where() -> rows
 *   insert(table).values().returning() -> rows
 *   update(table).set().where().returning() -> rows
 *
 * We track which table is being targeted to separate API key rows from scope rows.
 * Drizzle tables expose their name via table[Symbol.for("drizzle:Name")] or table._.name.
 */
function makeFakeDb({
  selectRows = [],
  scopeRows = [],
  insertSpy,
  scopeInsertSpy,
  updateSpy,
  insertThrow,
}: FakeDbConfig = {}) {
  let insertedValues: Record<string, unknown> | null = null;
  let updatedValues: Record<string, unknown> | null = null;

  function getTableName(table: unknown): string {
    if (!table) return '';
    const t = table as any;
    const symName = t[Symbol.for('drizzle:Name')];
    if (typeof symName === 'string') return symName;
    if (t?._ && typeof t._.name === 'string') return t._.name;
    if (typeof t.name === 'string') return t.name;
    return '';
  }

  function isScopeTable(table: unknown): boolean {
    return getTableName(table) === 'workspace_api_key_scopes';
  }

  const fakeDb: Record<string, any> = {
    select: () => ({
      from: (table: unknown) => {
        const isScope = isScopeTable(table);
        return {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          where: (..._args: unknown[]) => {
            const rows = isScope ? scopeRows : selectRows;
            return {
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              orderBy: (..._o: unknown[]) => Promise.resolve(rows),
              then: (resolve: (v: unknown) => void) => resolve(rows),
              [Symbol.iterator]: function* () {
                yield* rows;
              },
              ...Promise.resolve(rows),
            };
          },
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          orderBy: (..._o: unknown[]) => {
            const rows = isScope ? scopeRows : selectRows;
            return Promise.resolve(rows);
          },
        };
      },
    }),
    insert: (table?: unknown) => {
      const isScope = isScopeTable(table);
      return {
        values: (rowOrRows: Record<string, unknown> | Record<string, unknown>[]) => {
          if (insertThrow) throw insertThrow;

          if (isScope) {
            const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
            scopeInsertSpy?.(rows);
            return {
              returning: async () => rows.map((r) => ({ ...r, createdAt: NOW })),
              then: (resolve: (v: unknown) => void) => resolve(undefined),
              ...Promise.resolve(undefined),
            };
          }

          const row = Array.isArray(rowOrRows) ? rowOrRows[0] : rowOrRows;
          insertedValues = row;
          insertSpy?.(row);
          return {
            returning: async () => [{ ...makeApiKeyRow(), ...row }],
          };
        },
      };
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updatedValues = values;
        updateSpy?.(values);
        return {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          where: (..._args: unknown[]) => ({
            returning: async () => {
              if (selectRows.length === 0) return [];
              return [{ ...selectRows[0], ...values }];
            },
          }),
        };
      },
    }),
    // Drizzle transaction: execute the callback with this same fake client as tx
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      return fn(fakeDb);
    },
    _getInserted: () => insertedValues,
    _getUpdated: () => updatedValues,
  };

  return fakeDb;
}

// ── Fake API key generator ─────────────────────────────────────

function makeFakeKeyGenerator() {
  return async () => ({
    rawKey: 'xynes_live_aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222',
    keyPrefix: 'aaaa1111',
    keyHash: '$argon2id$v=19$m=19456,t=2,p=1$fakesalt$fakehash',
  });
}

// ═════════════════════════════════════════════════════════════════
// platform.api_keys.list
// ═════════════════════════════════════════════════════════════════

describe('platform.api_keys.list', () => {
  it('throws UNAUTHORIZED when userId is missing', async () => {
    const handler = createListApiKeysHandler({
      authzClient: makeAuthzClient(),
    });
    await expect(handler({}, makeCtx({ userId: null }))).rejects.toThrow(DomainError);
    try {
      await handler({}, makeCtx({ userId: null }));
    } catch (err) {
      expect((err as DomainError).code).toBe('UNAUTHORIZED');
    }
  });

  it('throws MISSING_CONTEXT when workspaceId is missing', async () => {
    const handler = createListApiKeysHandler({
      authzClient: makeAuthzClient(),
    });
    await expect(handler({}, makeCtx({ workspaceId: null }))).rejects.toThrow(DomainError);
    try {
      await handler({}, makeCtx({ workspaceId: null }));
    } catch (err) {
      expect((err as DomainError).code).toBe('MISSING_CONTEXT');
    }
  });

  it('throws FORBIDDEN when authz denies permission', async () => {
    const handler = createListApiKeysHandler({
      authzClient: makeAuthzClient(false),
      dbClient: makeFakeDb() as any,
    });
    await expect(handler({}, makeCtx())).rejects.toThrow(DomainError);
    try {
      await handler({}, makeCtx());
    } catch (err) {
      expect((err as DomainError).code).toBe('FORBIDDEN');
    }
  });

  it('returns API keys for the current workspace', async () => {
    const rows = [
      makeApiKeyRow({ name: 'Key A' }),
      makeApiKeyRow({ id: 'other-key-id', name: 'Key B' }),
    ];
    const handler = createListApiKeysHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: rows }) as any,
    });
    const result = await handler({}, makeCtx());
    expect(result.apiKeys).toHaveLength(2);
    expect(result.apiKeys[0].name).toBe('Key A');
    expect(result.apiKeys[1].name).toBe('Key B');
  });

  it('never returns raw key or key hash in list response', async () => {
    const rows = [makeApiKeyRow()];
    const handler = createListApiKeysHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: rows }) as any,
    });
    const result = await handler({}, makeCtx());
    const key = result.apiKeys[0];
    expect(key).not.toHaveProperty('keyHash');
    expect(key).not.toHaveProperty('rawKey');
    const serialized = JSON.stringify(key);
    expect(serialized).not.toContain('argon2id');
    expect(serialized).not.toContain('xynes_live_');
  });

  it('returns keyPrefix for display purposes', async () => {
    const rows = [makeApiKeyRow({ keyPrefix: 'xk_abcd' })];
    const handler = createListApiKeysHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: rows }) as any,
    });
    const result = await handler({}, makeCtx());
    expect(result.apiKeys[0].keyPrefix).toBe('xk_abcd');
  });

  it('returns an empty array when no API keys exist', async () => {
    const handler = createListApiKeysHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: [] }) as any,
    });
    const result = await handler({}, makeCtx());
    expect(result.apiKeys).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════
// platform.api_keys.create
// ═════════════════════════════════════════════════════════════════

describe('platform.api_keys.create', () => {
  it('throws UNAUTHORIZED when userId is missing', async () => {
    const handler = createCreateApiKeyHandler({
      authzClient: makeAuthzClient(),
    });
    const payload = { name: 'Test Key', presetKey: 'cms_readonly' as const };
    await expect(handler(payload, makeCtx({ userId: null }))).rejects.toThrow(DomainError);
    try {
      await handler(payload, makeCtx({ userId: null }));
    } catch (err) {
      expect((err as DomainError).code).toBe('UNAUTHORIZED');
    }
  });

  it('throws MISSING_CONTEXT when workspaceId is missing', async () => {
    const handler = createCreateApiKeyHandler({
      authzClient: makeAuthzClient(),
    });
    const payload = { name: 'Test Key', presetKey: 'cms_readonly' as const };
    await expect(handler(payload, makeCtx({ workspaceId: null }))).rejects.toThrow(DomainError);
    try {
      await handler(payload, makeCtx({ workspaceId: null }));
    } catch (err) {
      expect((err as DomainError).code).toBe('MISSING_CONTEXT');
    }
  });

  it('throws FORBIDDEN when authz denies permission', async () => {
    const handler = createCreateApiKeyHandler({
      authzClient: makeAuthzClient(false),
      dbClient: makeFakeDb() as any,
      keyGenerator: makeFakeKeyGenerator(),
    });
    const payload = { name: 'Test Key', presetKey: 'cms_readonly' as const };
    await expect(handler(payload, makeCtx())).rejects.toThrow(DomainError);
    try {
      await handler(payload, makeCtx());
    } catch (err) {
      expect((err as DomainError).code).toBe('FORBIDDEN');
    }
  });

  it('returns raw key exactly once in create response', async () => {
    const handler = createCreateApiKeyHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb() as any,
      keyGenerator: makeFakeKeyGenerator(),
    });
    const payload = { name: 'My Key', presetKey: 'cms_readonly' as const };
    const result = await handler(payload, makeCtx());
    expect(result.rawKey).toBeDefined();
    expect(result.rawKey).toContain('xynes_live_');
    expect(typeof result.rawKey).toBe('string');
    expect(result.rawKey.length).toBeGreaterThan(20);
  });

  it('maps preset to action-key scopes correctly', async () => {
    let insertedScopes: Record<string, unknown>[] = [];
    const db = makeFakeDb({
      scopeInsertSpy: (rows) => {
        insertedScopes = rows;
      },
    });
    const handler = createCreateApiKeyHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
      keyGenerator: makeFakeKeyGenerator(),
    });
    const payload = { name: 'CMS Read Key', presetKey: 'cms_readonly' as const };
    await handler(payload, makeCtx());
    const expectedScopes = WORKSPACE_API_KEY_PRESETS.cms_readonly;
    expect(insertedScopes).toHaveLength(expectedScopes.length);
    const insertedActionKeys = insertedScopes.map((s) => s.actionKey);
    for (const scope of expectedScopes) {
      expect(insertedActionKeys).toContain(scope);
    }
  });

  it('rejects invalid preset with a safe error', async () => {
    const handler = createCreateApiKeyHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb() as any,
      keyGenerator: makeFakeKeyGenerator(),
    });
    const payload = { name: 'Bad Key', presetKey: 'nonexistent_preset' as any };
    await expect(handler(payload, makeCtx())).rejects.toThrow(DomainError);
    try {
      await handler(payload, makeCtx());
    } catch (err) {
      expect((err as DomainError).code).toBe('INVALID_PRESET');
    }
  });

  it('stores only the key hash, never the raw key', async () => {
    let insertedRow: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      insertSpy: (row) => {
        insertedRow = row;
      },
    });
    const handler = createCreateApiKeyHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
      keyGenerator: makeFakeKeyGenerator(),
    });
    const payload = { name: 'Secure Key', presetKey: 'cms_readonly' as const };
    await handler(payload, makeCtx());
    expect(insertedRow).not.toBeNull();
    expect(insertedRow!.keyHash).toBeDefined();
    expect(insertedRow!.keyHash).not.toContain('xynes_live_');
    expect(insertedRow!).not.toHaveProperty('rawKey');
  });

  it('sets createdBy from context userId', async () => {
    let insertedRow: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      insertSpy: (row) => {
        insertedRow = row;
      },
    });
    const handler = createCreateApiKeyHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
      keyGenerator: makeFakeKeyGenerator(),
    });
    const payload = { name: 'My Key', presetKey: 'cms_readonly' as const };
    await handler(payload, makeCtx());
    expect(insertedRow!.createdBy).toBe(USER_ID);
  });

  it('sets workspaceId from context', async () => {
    let insertedRow: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      insertSpy: (row) => {
        insertedRow = row;
      },
    });
    const handler = createCreateApiKeyHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
      keyGenerator: makeFakeKeyGenerator(),
    });
    const payload = { name: 'My Key', presetKey: 'cms_readonly' as const };
    await handler(payload, makeCtx());
    expect(insertedRow!.workspaceId).toBe(WORKSPACE_ID);
  });

  it('stores the presetKey for audit trail', async () => {
    let insertedRow: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      insertSpy: (row) => {
        insertedRow = row;
      },
    });
    const handler = createCreateApiKeyHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
      keyGenerator: makeFakeKeyGenerator(),
    });
    const payload = { name: 'My Key', presetKey: 'cms_authoring' as const };
    await handler(payload, makeCtx());
    expect(insertedRow!.presetKey).toBe('cms_authoring');
  });

  it('stores expiresAt when provided', async () => {
    let insertedRow: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      insertSpy: (row) => {
        insertedRow = row;
      },
    });
    const handler = createCreateApiKeyHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
      keyGenerator: makeFakeKeyGenerator(),
    });
    const expiresAt = '2027-01-01T00:00:00Z';
    const payload = { name: 'Expiring Key', presetKey: 'cms_readonly' as const, expiresAt };
    await handler(payload, makeCtx());
    expect(insertedRow!.expiresAt).toBeDefined();
  });

  it('does not include key hash in response DTO', async () => {
    const handler = createCreateApiKeyHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb() as any,
      keyGenerator: makeFakeKeyGenerator(),
    });
    const payload = { name: 'My Key', presetKey: 'cms_readonly' as const };
    const result = await handler(payload, makeCtx());
    expect(result).not.toHaveProperty('keyHash');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('argon2id');
  });

  it('maps each preset to the expected scope count', () => {
    // Validate preset mapping structure
    expect(WORKSPACE_API_KEY_PRESETS.cms_readonly.length).toBe(4);
    expect(WORKSPACE_API_KEY_PRESETS.cms_authoring.length).toBe(4);
    expect(WORKSPACE_API_KEY_PRESETS.cms_publisher.length).toBe(6);
    expect(WORKSPACE_API_KEY_PRESETS.telemetry_read.length).toBe(2);
    expect(WORKSPACE_API_KEY_PRESETS.workspace_admin.length).toBe(3);
  });

  it('workspace_admin preset does NOT include api_keys.create or api_keys.revoke', () => {
    const adminScopes = WORKSPACE_API_KEY_PRESETS.workspace_admin;
    expect(adminScopes).not.toContain('platform.api_keys.create');
    expect(adminScopes).not.toContain('platform.api_keys.revoke');
  });
});

// ═════════════════════════════════════════════════════════════════
// platform.api_keys.revoke
// ═════════════════════════════════════════════════════════════════

describe('platform.api_keys.revoke', () => {
  it('throws UNAUTHORIZED when userId is missing', async () => {
    const handler = createRevokeApiKeyHandler({
      authzClient: makeAuthzClient(),
    });
    await expect(handler({ keyId: KEY_ID }, makeCtx({ userId: null }))).rejects.toThrow(
      DomainError,
    );
    try {
      await handler({ keyId: KEY_ID }, makeCtx({ userId: null }));
    } catch (err) {
      expect((err as DomainError).code).toBe('UNAUTHORIZED');
    }
  });

  it('throws MISSING_CONTEXT when workspaceId is missing', async () => {
    const handler = createRevokeApiKeyHandler({
      authzClient: makeAuthzClient(),
    });
    await expect(handler({ keyId: KEY_ID }, makeCtx({ workspaceId: null }))).rejects.toThrow(
      DomainError,
    );
    try {
      await handler({ keyId: KEY_ID }, makeCtx({ workspaceId: null }));
    } catch (err) {
      expect((err as DomainError).code).toBe('MISSING_CONTEXT');
    }
  });

  it('throws FORBIDDEN when authz denies permission', async () => {
    const row = makeApiKeyRow({ status: 'active' });
    const handler = createRevokeApiKeyHandler({
      authzClient: makeAuthzClient(false),
      dbClient: makeFakeDb({ selectRows: [row] }) as any,
    });
    await expect(handler({ keyId: KEY_ID }, makeCtx())).rejects.toThrow(DomainError);
    try {
      await handler({ keyId: KEY_ID }, makeCtx());
    } catch (err) {
      expect((err as DomainError).code).toBe('FORBIDDEN');
    }
  });

  it('throws NOT_FOUND when API key does not exist', async () => {
    const handler = createRevokeApiKeyHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: [] }) as any,
    });
    await expect(handler({ keyId: KEY_ID }, makeCtx())).rejects.toThrow(DomainError);
    try {
      await handler({ keyId: KEY_ID }, makeCtx());
    } catch (err) {
      expect((err as DomainError).code).toBe('NOT_FOUND');
    }
  });

  it('throws ALREADY_REVOKED when API key is already revoked', async () => {
    const row = makeApiKeyRow({ status: 'revoked' });
    const handler = createRevokeApiKeyHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: [row] }) as any,
    });
    await expect(handler({ keyId: KEY_ID }, makeCtx())).rejects.toThrow(DomainError);
    try {
      await handler({ keyId: KEY_ID }, makeCtx());
    } catch (err) {
      expect((err as DomainError).code).toBe('ALREADY_REVOKED');
    }
  });

  it('changes status to revoked', async () => {
    const row = makeApiKeyRow({ status: 'active' });
    let updatedValues: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      selectRows: [row],
      updateSpy: (values) => {
        updatedValues = values;
      },
    });
    const handler = createRevokeApiKeyHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
    });
    const result = await handler({ keyId: KEY_ID }, makeCtx());
    expect(result.status).toBe('revoked');
    expect(updatedValues).not.toBeNull();
    expect(updatedValues!.status).toBe('revoked');
  });

  it('records revokedBy as the requesting user', async () => {
    const row = makeApiKeyRow({ status: 'active' });
    let updatedValues: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      selectRows: [row],
      updateSpy: (values) => {
        updatedValues = values;
      },
    });
    const handler = createRevokeApiKeyHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
    });
    await handler({ keyId: KEY_ID }, makeCtx());
    expect(updatedValues!.revokedBy).toBe(USER_ID);
  });

  it('records revokedAt timestamp', async () => {
    const row = makeApiKeyRow({ status: 'active' });
    let updatedValues: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      selectRows: [row],
      updateSpy: (values) => {
        updatedValues = values;
      },
    });
    const handler = createRevokeApiKeyHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
    });
    await handler({ keyId: KEY_ID }, makeCtx());
    expect(updatedValues!.revokedAt).toBeDefined();
    expect(updatedValues!.revokedAt).toBeInstanceOf(Date);
  });

  it('does not leak key hash in revoke response', async () => {
    const row = makeApiKeyRow({ status: 'active' });
    const db = makeFakeDb({ selectRows: [row] });
    const handler = createRevokeApiKeyHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
    });
    const result = await handler({ keyId: KEY_ID }, makeCtx());
    expect(result).not.toHaveProperty('keyHash');
    expect(JSON.stringify(result)).not.toContain('argon2id');
  });
});

// ═════════════════════════════════════════════════════════════════
// platform.api_keys.usage.read
// ═════════════════════════════════════════════════════════════════

describe('platform.api_keys.usage.read', () => {
  it('throws UNAUTHORIZED when userId is missing', async () => {
    const handler = createReadApiKeyUsageHandler({
      authzClient: makeAuthzClient(),
    });
    await expect(handler({ keyId: KEY_ID }, makeCtx({ userId: null }))).rejects.toThrow(
      DomainError,
    );
    try {
      await handler({ keyId: KEY_ID }, makeCtx({ userId: null }));
    } catch (err) {
      expect((err as DomainError).code).toBe('UNAUTHORIZED');
    }
  });

  it('throws MISSING_CONTEXT when workspaceId is missing', async () => {
    const handler = createReadApiKeyUsageHandler({
      authzClient: makeAuthzClient(),
    });
    await expect(handler({ keyId: KEY_ID }, makeCtx({ workspaceId: null }))).rejects.toThrow(
      DomainError,
    );
    try {
      await handler({ keyId: KEY_ID }, makeCtx({ workspaceId: null }));
    } catch (err) {
      expect((err as DomainError).code).toBe('MISSING_CONTEXT');
    }
  });

  it('throws FORBIDDEN when authz denies permission', async () => {
    const row = makeApiKeyRow();
    const handler = createReadApiKeyUsageHandler({
      authzClient: makeAuthzClient(false),
      dbClient: makeFakeDb({ selectRows: [row] }) as any,
    });
    await expect(handler({ keyId: KEY_ID }, makeCtx())).rejects.toThrow(DomainError);
    try {
      await handler({ keyId: KEY_ID }, makeCtx());
    } catch (err) {
      expect((err as DomainError).code).toBe('FORBIDDEN');
    }
  });

  it('throws NOT_FOUND when API key does not exist', async () => {
    const handler = createReadApiKeyUsageHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: [] }) as any,
    });
    await expect(handler({ keyId: KEY_ID }, makeCtx())).rejects.toThrow(DomainError);
    try {
      await handler({ keyId: KEY_ID }, makeCtx());
    } catch (err) {
      expect((err as DomainError).code).toBe('NOT_FOUND');
    }
  });

  it('returns usage summary with lastUsedAt', async () => {
    const lastUsed = new Date('2026-04-23T08:00:00Z');
    const row = makeApiKeyRow({ lastUsedAt: lastUsed });
    const handler = createReadApiKeyUsageHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: [row] }) as any,
    });
    const result = await handler({ keyId: KEY_ID }, makeCtx());
    expect(result.keyId).toBe(KEY_ID);
    expect(result.lastUsedAt).toBe(lastUsed.toISOString());
  });

  it('returns scopes associated with the API key', async () => {
    const row = makeApiKeyRow();
    const scopes = [
      makeScopeRow({ actionKey: 'cms.content.listPublished' }),
      makeScopeRow({ actionKey: 'cms.content.getPublishedBySlug' }),
    ];
    const handler = createReadApiKeyUsageHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: [row], scopeRows: scopes }) as any,
    });
    const result = await handler({ keyId: KEY_ID }, makeCtx());
    expect(result.scopes).toHaveLength(2);
    expect(result.scopes).toContain('cms.content.listPublished');
    expect(result.scopes).toContain('cms.content.getPublishedBySlug');
  });

  it('does not leak key hash in usage response', async () => {
    const row = makeApiKeyRow();
    const handler = createReadApiKeyUsageHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: [row] }) as any,
    });
    const result = await handler({ keyId: KEY_ID }, makeCtx());
    expect(result).not.toHaveProperty('keyHash');
    expect(JSON.stringify(result)).not.toContain('argon2id');
  });
});
