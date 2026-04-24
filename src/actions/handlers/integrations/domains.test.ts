import { describe, it, expect } from 'bun:test';
import { DomainError } from '@xynes/errors';
import {
  createListDomainsHandler,
  createCreateDomainHandler,
  createVerifyDomainHandler,
  createDeleteDomainHandler,
} from './domains';
import type { ActionContext } from '../../types';

// ── Helpers ────────────────────────────────────────────────────

const WORKSPACE_ID = '550e8400-e29b-41d4-a716-446655440000';
const USER_ID = '550e8400-e29b-41d4-a716-446655440001';
const DOMAIN_ID = '550e8400-e29b-41d4-a716-446655440099';

function makeCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    requestId: 'req-test-domains',
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

const NOW = new Date('2026-04-24T10:00:00Z');

function makeDomainRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DOMAIN_ID,
    workspaceId: WORKSPACE_ID,
    hostname: 'example.com',
    status: 'pending',
    verificationMethod: 'dns_txt',
    verificationName: '_xynes.example.com',
    verificationValueHash: 'hashed-value',
    lastCheckedAt: null,
    verifiedAt: null,
    createdBy: USER_ID,
    createdAt: NOW,
    updatedAt: NOW,
    failureCode: null,
    failureMessage: null,
    ...overrides,
  };
}

type FakeDbConfig = {
  selectRows?: Record<string, unknown>[];
  insertSpy?: (row: Record<string, unknown>) => void;
  updateSpy?: (values: Record<string, unknown>) => void;
};

/**
 * Minimal fake Drizzle-style DB client.
 * Supports the chaining patterns used by our handlers:
 *   select().from().where() -> rows
 *   insert().values().returning() -> rows
 *   update().set().where().returning() -> rows
 */
function makeFakeDb({ selectRows = [], insertSpy, updateSpy }: FakeDbConfig = {}) {
  let insertedValues: Record<string, unknown> | null = null;
  let updatedValues: Record<string, unknown> | null = null;

  return {
    select: () => ({
      from: () => ({
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        where: (..._args: unknown[]) => ({
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          orderBy: (..._o: unknown[]) => Promise.resolve(selectRows),
          then: (resolve: (v: unknown) => void) => resolve(selectRows),
          [Symbol.iterator]: function* () {
            yield* selectRows;
          },
          // Allow direct await
          ...Promise.resolve(selectRows),
        }),
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        insertedValues = row;
        insertSpy?.(row);
        return {
          returning: async () => [{ ...makeDomainRow(), ...row }],
        };
      },
    }),
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
    _getInserted: () => insertedValues,
    _getUpdated: () => updatedValues,
  };
}

// ── DNS resolver stub ──────────────────────────────────────────

function makeDnsResolver(records: string[] | null) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return async (_name: string, _type: string) => {
    if (records === null) throw new Error('DNS lookup failed');
    return records;
  };
}

// ═════════════════════════════════════════════════════════════════
// platform.domains.list
// ═════════════════════════════════════════════════════════════════

describe('platform.domains.list', () => {
  it('throws UNAUTHORIZED when userId is missing', async () => {
    const handler = createListDomainsHandler({
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
    const handler = createListDomainsHandler({
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
    const handler = createListDomainsHandler({
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

  it('returns only domains for the current workspace', async () => {
    const rows = [
      makeDomainRow({ hostname: 'alpha.com' }),
      makeDomainRow({ id: 'other-id', hostname: 'beta.com' }),
    ];
    const handler = createListDomainsHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: rows }) as any,
    });
    const result = await handler({}, makeCtx());
    expect(result.domains).toHaveLength(2);
    expect(result.domains[0].hostname).toBe('alpha.com');
    expect(result.domains[1].hostname).toBe('beta.com');
  });

  it('does not leak verification_value_hash in response', async () => {
    const rows = [makeDomainRow()];
    const handler = createListDomainsHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: rows }) as any,
    });
    const result = await handler({}, makeCtx());
    const domain = result.domains[0];
    expect(domain).not.toHaveProperty('verificationValueHash');
    expect(JSON.stringify(domain)).not.toContain('hashed-value');
  });

  it('returns an empty array when no domains exist', async () => {
    const handler = createListDomainsHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: [] }) as any,
    });
    const result = await handler({}, makeCtx());
    expect(result.domains).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════
// platform.domains.create
// ═════════════════════════════════════════════════════════════════

describe('platform.domains.create', () => {
  it('throws UNAUTHORIZED when userId is missing', async () => {
    const handler = createCreateDomainHandler({
      authzClient: makeAuthzClient(),
    });
    await expect(handler({ hostname: 'test.com' }, makeCtx({ userId: null }))).rejects.toThrow(
      DomainError,
    );
    try {
      await handler({ hostname: 'test.com' }, makeCtx({ userId: null }));
    } catch (err) {
      expect((err as DomainError).code).toBe('UNAUTHORIZED');
    }
  });

  it('throws MISSING_CONTEXT when workspaceId is missing', async () => {
    const handler = createCreateDomainHandler({
      authzClient: makeAuthzClient(),
    });
    await expect(handler({ hostname: 'test.com' }, makeCtx({ workspaceId: null }))).rejects.toThrow(
      DomainError,
    );
    try {
      await handler({ hostname: 'test.com' }, makeCtx({ workspaceId: null }));
    } catch (err) {
      expect((err as DomainError).code).toBe('MISSING_CONTEXT');
    }
  });

  it('throws FORBIDDEN when authz denies permission', async () => {
    const handler = createCreateDomainHandler({
      authzClient: makeAuthzClient(false),
      dbClient: makeFakeDb() as any,
    });
    await expect(handler({ hostname: 'test.com' }, makeCtx())).rejects.toThrow(DomainError);
    try {
      await handler({ hostname: 'test.com' }, makeCtx());
    } catch (err) {
      expect((err as DomainError).code).toBe('FORBIDDEN');
    }
  });

  it('normalizes hostname before persisting', async () => {
    let insertedRow: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      insertSpy: (row) => {
        insertedRow = row;
      },
    });
    const handler = createCreateDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
    });
    await handler({ hostname: '  Example.COM  ' }, makeCtx());
    expect(insertedRow).not.toBeNull();
    expect(insertedRow!.hostname).toBe('example.com');
    expect(insertedRow!.verificationName).toBe('_xynes.example.com');
  });

  it('rejects invalid hostnames (e.g. protocol prefix)', async () => {
    const handler = createCreateDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb() as any,
    });
    await expect(handler({ hostname: 'https://example.com' }, makeCtx())).rejects.toThrow(
      DomainError,
    );
    try {
      await handler({ hostname: 'https://example.com' }, makeCtx());
    } catch (err) {
      expect((err as DomainError).code).toBe('INVALID_DOMAIN');
    }
  });

  it('stores only hashed verification value, not the raw secret', async () => {
    let insertedRow: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      insertSpy: (row) => {
        insertedRow = row;
      },
    });
    const handler = createCreateDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
    });
    const result = await handler({ hostname: 'secure.example.com' }, makeCtx());
    expect(insertedRow).not.toBeNull();
    // The raw verification value should be returned to caller for DNS setup...
    expect(result.verificationValue).toBeDefined();
    expect(typeof result.verificationValue).toBe('string');
    expect(result.verificationValue.length).toBeGreaterThan(0);
    // ...but the DB insert must store a hash, not the raw value
    expect(insertedRow!.verificationValueHash).toBeDefined();
    expect(insertedRow!.verificationValueHash).not.toBe(result.verificationValue);
  });

  it('sets createdBy from context userId', async () => {
    let insertedRow: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      insertSpy: (row) => {
        insertedRow = row;
      },
    });
    const handler = createCreateDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
    });
    await handler({ hostname: 'test.com' }, makeCtx());
    expect(insertedRow!.createdBy).toBe(USER_ID);
  });

  it('sets workspaceId from context', async () => {
    let insertedRow: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      insertSpy: (row) => {
        insertedRow = row;
      },
    });
    const handler = createCreateDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
    });
    await handler({ hostname: 'test.com' }, makeCtx());
    expect(insertedRow!.workspaceId).toBe(WORKSPACE_ID);
  });

  it('returns the DNS verification instruction to the caller', async () => {
    const handler = createCreateDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb() as any,
    });
    const result = await handler({ hostname: 'mysite.com' }, makeCtx());
    expect(result.verificationName).toBe('_xynes.mysite.com');
    expect(result.verificationValue).toBeDefined();
    expect(result.hostname).toBe('mysite.com');
    expect(result.status).toBe('pending');
  });

  it('returns CONFLICT when hostname is already registered for workspace', async () => {
    const db = makeFakeDb({
      insertSpy: () => {
        const error = new Error('unique violation') as Error & {
          code: string;
          constraint_name: string;
        };
        error.code = '23505';
        error.constraint_name = 'workspace_domains_workspace_hostname_uidx';
        throw error;
      },
    });
    const handler = createCreateDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
    });
    await expect(handler({ hostname: 'duplicate.com' }, makeCtx())).rejects.toThrow(DomainError);
    try {
      await handler({ hostname: 'duplicate.com' }, makeCtx());
    } catch (err) {
      expect((err as DomainError).code).toBe('CONFLICT');
    }
  });
});

// ═════════════════════════════════════════════════════════════════
// platform.domains.verify
// ═════════════════════════════════════════════════════════════════

describe('platform.domains.verify', () => {
  it('throws UNAUTHORIZED when userId is missing', async () => {
    const handler = createVerifyDomainHandler({
      authzClient: makeAuthzClient(),
    });
    await expect(handler({ domainId: DOMAIN_ID }, makeCtx({ userId: null }))).rejects.toThrow(
      DomainError,
    );
    try {
      await handler({ domainId: DOMAIN_ID }, makeCtx({ userId: null }));
    } catch (err) {
      expect((err as DomainError).code).toBe('UNAUTHORIZED');
    }
  });

  it('throws MISSING_CONTEXT when workspaceId is missing', async () => {
    const handler = createVerifyDomainHandler({
      authzClient: makeAuthzClient(),
    });
    await expect(handler({ domainId: DOMAIN_ID }, makeCtx({ workspaceId: null }))).rejects.toThrow(
      DomainError,
    );
    try {
      await handler({ domainId: DOMAIN_ID }, makeCtx({ workspaceId: null }));
    } catch (err) {
      expect((err as DomainError).code).toBe('MISSING_CONTEXT');
    }
  });

  it('throws FORBIDDEN when authz denies permission', async () => {
    const row = makeDomainRow({ status: 'pending' });
    const handler = createVerifyDomainHandler({
      authzClient: makeAuthzClient(false),
      dbClient: makeFakeDb({ selectRows: [row] }) as any,
    });
    await expect(handler({ domainId: DOMAIN_ID }, makeCtx())).rejects.toThrow(DomainError);
    try {
      await handler({ domainId: DOMAIN_ID }, makeCtx());
    } catch (err) {
      expect((err as DomainError).code).toBe('FORBIDDEN');
    }
  });

  it('throws NOT_FOUND when domain does not exist', async () => {
    const handler = createVerifyDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: [] }) as any,
    });
    await expect(handler({ domainId: DOMAIN_ID }, makeCtx())).rejects.toThrow(DomainError);
    try {
      await handler({ domainId: DOMAIN_ID }, makeCtx());
    } catch (err) {
      expect((err as DomainError).code).toBe('NOT_FOUND');
    }
  });

  it('updates status to verified when DNS check succeeds', async () => {
    const rawValue = 'xynes-verify-abc123';
    const hashedValue = await hashForTest(rawValue);
    const row = makeDomainRow({
      status: 'pending',
      verificationName: '_xynes.example.com',
      verificationValueHash: hashedValue,
    });

    let updatedValues: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      selectRows: [row],
      updateSpy: (values) => {
        updatedValues = values;
      },
    });

    const handler = createVerifyDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
      dnsResolver: makeDnsResolver([rawValue]),
    });
    const result = await handler({ domainId: DOMAIN_ID }, makeCtx());
    expect(result.status).toBe('verified');
    expect(updatedValues).not.toBeNull();
    expect(updatedValues!.status).toBe('verified');
    expect(updatedValues!.lastCheckedAt).toBeDefined();
    expect(updatedValues!.verifiedAt).toBeDefined();
  });

  it('updates status to failed when DNS check finds no matching record', async () => {
    const rawValue = 'xynes-verify-abc123';
    const hashedValue = await hashForTest(rawValue);
    const row = makeDomainRow({
      status: 'pending',
      verificationName: '_xynes.example.com',
      verificationValueHash: hashedValue,
    });

    let updatedValues: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      selectRows: [row],
      updateSpy: (values) => {
        updatedValues = values;
      },
    });

    const handler = createVerifyDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
      dnsResolver: makeDnsResolver(['wrong-value']),
    });
    const result = await handler({ domainId: DOMAIN_ID }, makeCtx());
    expect(result.status).toBe('failed');
    expect(updatedValues).not.toBeNull();
    expect(updatedValues!.status).toBe('failed');
    expect(updatedValues!.lastCheckedAt).toBeDefined();
    expect(updatedValues!.failureCode).toBe('DNS_MISMATCH');
  });

  it('updates status to failed when DNS lookup errors', async () => {
    const row = makeDomainRow({ status: 'pending' });

    let updatedValues: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      selectRows: [row],
      updateSpy: (values) => {
        updatedValues = values;
      },
    });

    const handler = createVerifyDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
      dnsResolver: makeDnsResolver(null), // throws
    });
    const result = await handler({ domainId: DOMAIN_ID }, makeCtx());
    expect(result.status).toBe('failed');
    expect(updatedValues!.failureCode).toBe('DNS_ERROR');
  });

  it('does not leak raw DNS error details in the failure message', async () => {
    const row = makeDomainRow({ status: 'pending' });

    const db = makeFakeDb({
      selectRows: [row],
    });

    const handler = createVerifyDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
      dnsResolver: makeDnsResolver(null), // throws Error('DNS lookup failed')
    });
    const result = await handler({ domainId: DOMAIN_ID }, makeCtx());
    // The raw error message should NOT appear in the response DTO
    expect(result.failureMessage).not.toContain('DNS lookup failed');
    // It should contain a generic safe message instead
    expect(result.failureMessage).toBe('DNS resolution failed for the verification name');
  });

  it('updates lastCheckedAt on every verification attempt', async () => {
    const row = makeDomainRow({ status: 'pending' });

    let updatedValues: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      selectRows: [row],
      updateSpy: (values) => {
        updatedValues = values;
      },
    });

    const handler = createVerifyDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
      dnsResolver: makeDnsResolver([]),
    });
    await handler({ domainId: DOMAIN_ID }, makeCtx());
    expect(updatedValues!.lastCheckedAt).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════
// platform.domains.delete
// ═════════════════════════════════════════════════════════════════

describe('platform.domains.delete', () => {
  it('throws UNAUTHORIZED when userId is missing', async () => {
    const handler = createDeleteDomainHandler({
      authzClient: makeAuthzClient(),
    });
    await expect(handler({ domainId: DOMAIN_ID }, makeCtx({ userId: null }))).rejects.toThrow(
      DomainError,
    );
    try {
      await handler({ domainId: DOMAIN_ID }, makeCtx({ userId: null }));
    } catch (err) {
      expect((err as DomainError).code).toBe('UNAUTHORIZED');
    }
  });

  it('throws MISSING_CONTEXT when workspaceId is missing', async () => {
    const handler = createDeleteDomainHandler({
      authzClient: makeAuthzClient(),
    });
    await expect(handler({ domainId: DOMAIN_ID }, makeCtx({ workspaceId: null }))).rejects.toThrow(
      DomainError,
    );
    try {
      await handler({ domainId: DOMAIN_ID }, makeCtx({ workspaceId: null }));
    } catch (err) {
      expect((err as DomainError).code).toBe('MISSING_CONTEXT');
    }
  });

  it('throws FORBIDDEN when authz denies permission', async () => {
    const row = makeDomainRow();
    const handler = createDeleteDomainHandler({
      authzClient: makeAuthzClient(false),
      dbClient: makeFakeDb({ selectRows: [row] }) as any,
    });
    await expect(handler({ domainId: DOMAIN_ID }, makeCtx())).rejects.toThrow(DomainError);
    try {
      await handler({ domainId: DOMAIN_ID }, makeCtx());
    } catch (err) {
      expect((err as DomainError).code).toBe('FORBIDDEN');
    }
  });

  it('throws NOT_FOUND when domain does not exist', async () => {
    const handler = createDeleteDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: [] }) as any,
    });
    await expect(handler({ domainId: DOMAIN_ID }, makeCtx())).rejects.toThrow(DomainError);
    try {
      await handler({ domainId: DOMAIN_ID }, makeCtx());
    } catch (err) {
      expect((err as DomainError).code).toBe('NOT_FOUND');
    }
  });

  it('soft-deletes by setting status to disabled (preserves audit history)', async () => {
    const row = makeDomainRow({ status: 'verified' });

    let updatedValues: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      selectRows: [row],
      updateSpy: (values) => {
        updatedValues = values;
      },
    });

    const handler = createDeleteDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
    });
    const result = await handler({ domainId: DOMAIN_ID }, makeCtx());
    expect(result.status).toBe('disabled');
    expect(updatedValues).not.toBeNull();
    expect(updatedValues!.status).toBe('disabled');
  });

  it('does not physically delete the database row', async () => {
    const row = makeDomainRow({ status: 'verified' });

    let deleteCalled = false;
    const db = makeFakeDb({
      selectRows: [row],
    });
    // Ensure no .delete() chain exists
    (db as any).delete = () => {
      deleteCalled = true;
      return { where: async () => {} };
    };

    const handler = createDeleteDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
    });
    await handler({ domainId: DOMAIN_ID }, makeCtx());
    expect(deleteCalled).toBe(false);
  });

  it('returns the disabled domain DTO', async () => {
    const row = makeDomainRow({ status: 'verified', hostname: 'archive.example.com' });

    const db = makeFakeDb({
      selectRows: [row],
    });

    const handler = createDeleteDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
    });
    const result = await handler({ domainId: DOMAIN_ID }, makeCtx());
    expect(result.hostname).toBe('archive.example.com');
    expect(result.status).toBe('disabled');
    expect(result).not.toHaveProperty('verificationValueHash');
  });
});

// ── Test-only hash utility ─────────────────────────────────────

async function hashForTest(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
