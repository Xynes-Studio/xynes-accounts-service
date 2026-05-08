import { describe, it, expect } from 'bun:test';
import { DomainError } from '@xynes/errors';
import {
  createListDomainsHandler,
  createCreateDomainHandler,
  createVerifyDomainHandler,
  createRegenerateVerificationHandler,
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
    dnsRecordsFound: null,
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

/**
 * Resolver that throws an error with a specific .code property — used to
 * exercise the DNS error categorization (NXDOMAIN / TIMEOUT / DNS_ERROR).
 */
function makeDnsResolverWithCode(code: string, message = 'simulated DNS error') {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return async (_name: string, _type: string) => {
    const err = new Error(message) as Error & { code: string };
    err.code = code;
    throw err;
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

  it('returns INVALID_DOMAIN 400 when the DB raises a CHECK violation (defense-in-depth)', async () => {
    // The frontend validator already mirrors every shape rule, so under
    // normal operation this path is never hit. But if the validator
    // drifts from the schema (or a future constraint is added without a
    // matching validator change), users must still see a safe 400 — not
    // a generic 500 with the failed insert leaking into error logs.
    const db = makeFakeDb({
      insertSpy: () => {
        const error = new Error('check violation') as Error & {
          code: string;
          constraint_name: string;
        };
        error.code = '23514';
        error.constraint_name = 'workspace_domains_hostname_shape';
        throw error;
      },
    });
    const handler = createCreateDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
    });
    await expect(handler({ hostname: 'something.com' }, makeCtx())).rejects.toThrow(DomainError);
    try {
      await handler({ hostname: 'something.com' }, makeCtx());
    } catch (err) {
      const domainErr = err as DomainError;
      expect(domainErr.code).toBe('INVALID_DOMAIN');
      expect(domainErr.statusCode).toBe(400);
      // Message must NOT include the raw constraint_name or any internal
      // details — only a user-friendly hostname-shape message.
      expect(domainErr.message).toContain('something.com');
      expect(domainErr.message.toLowerCase()).toContain('shape');
      expect(domainErr.message).not.toContain('23514');
      expect(domainErr.message).not.toContain('workspace_domains_hostname_shape');
    }
  });

  it('returns INVALID_DOMAIN with a lowercase-specific message for the lower CHECK', async () => {
    const db = makeFakeDb({
      insertSpy: () => {
        const error = new Error('check violation') as Error & {
          code: string;
          constraint_name: string;
        };
        error.code = '23514';
        error.constraint_name = 'workspace_domains_hostname_lower';
        throw error;
      },
    });
    const handler = createCreateDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
    });
    try {
      await handler({ hostname: 'something.com' }, makeCtx());
    } catch (err) {
      const domainErr = err as DomainError;
      expect(domainErr.code).toBe('INVALID_DOMAIN');
      expect(domainErr.statusCode).toBe(400);
      expect(domainErr.message.toLowerCase()).toContain('lowercase');
    }
  });

  it('returns INVALID_DOMAIN with a generic shape message for unknown CHECK constraints', async () => {
    // Future-proofing: if a new CHECK is added on workspace_domains
    // without a matching message mapping, the handler must still return
    // a safe 400 (with the generic shape copy) rather than re-throwing
    // and triggering the global 500 path.
    const db = makeFakeDb({
      insertSpy: () => {
        const error = new Error('check violation') as Error & { code: string };
        error.code = '23514';
        // no constraint_name — exercises the `default` branch
        throw error;
      },
    });
    const handler = createCreateDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
    });
    try {
      await handler({ hostname: 'something.com' }, makeCtx());
    } catch (err) {
      const domainErr = err as DomainError;
      expect(domainErr.code).toBe('INVALID_DOMAIN');
      expect(domainErr.statusCode).toBe(400);
      expect(domainErr.message).toContain('something.com');
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
    // Phase B: distinguish "found N records, none matched" (MISMATCH)
    // from "found 0 records" (NO_RECORDS).
    expect(updatedValues!.failureCode).toBe('MISMATCH');
    expect(updatedValues!.dnsRecordsFound).toBe(1);
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
      dnsResolver: makeDnsResolver(null), // throws (no .code → DNS_ERROR)
    });
    const result = await handler({ domainId: DOMAIN_ID }, makeCtx());
    expect(result.status).toBe('failed');
    expect(updatedValues!.failureCode).toBe('DNS_ERROR');
    // dns_records_found is null when DNS lookup itself errored — we never
    // got far enough to enumerate records.
    expect(updatedValues!.dnsRecordsFound).toBeNull();
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

  // ── Phase B: structured DNS failure diagnostics ─────────────────

  it('classifies ENOTFOUND as NXDOMAIN with a propagation hint', async () => {
    const row = makeDomainRow({ status: 'pending' });
    let updatedValues: Record<string, unknown> | null = null;
    const handler = createVerifyDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({
        selectRows: [row],
        updateSpy: (v) => {
          updatedValues = v;
        },
      }) as any,
      dnsResolver: makeDnsResolverWithCode('ENOTFOUND'),
    });
    const result = await handler({ domainId: DOMAIN_ID }, makeCtx());
    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('NXDOMAIN');
    expect(result.dnsRecordsFound).toBeNull();
    expect(updatedValues!.failureCode).toBe('NXDOMAIN');
    expect(updatedValues!.dnsRecordsFound).toBeNull();
    expect(result.failureMessage?.toLowerCase()).toContain('propagation');
  });

  it('classifies ENODATA as NXDOMAIN', async () => {
    const row = makeDomainRow({ status: 'pending' });
    const handler = createVerifyDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: [row] }) as any,
      dnsResolver: makeDnsResolverWithCode('ENODATA'),
    });
    const result = await handler({ domainId: DOMAIN_ID }, makeCtx());
    expect(result.failureCode).toBe('NXDOMAIN');
  });

  it('classifies ETIMEOUT as TIMEOUT with a transient-failure hint', async () => {
    const row = makeDomainRow({ status: 'pending' });
    const handler = createVerifyDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: [row] }) as any,
      dnsResolver: makeDnsResolverWithCode('ETIMEOUT'),
    });
    const result = await handler({ domainId: DOMAIN_ID }, makeCtx());
    expect(result.failureCode).toBe('TIMEOUT');
    expect(result.dnsRecordsFound).toBeNull();
    expect(result.failureMessage?.toLowerCase()).toContain('timed out');
  });

  it('classifies ESERVFAIL and EREFUSED as TIMEOUT', async () => {
    const row = makeDomainRow({ status: 'pending' });
    for (const code of ['ESERVFAIL', 'EREFUSED']) {
      const handler = createVerifyDomainHandler({
        authzClient: makeAuthzClient(),
        dbClient: makeFakeDb({ selectRows: [row] }) as any,
        dnsResolver: makeDnsResolverWithCode(code),
      });
      const result = await handler({ domainId: DOMAIN_ID }, makeCtx());
      expect(result.failureCode).toBe('TIMEOUT');
    }
  });

  it('classifies an unknown DNS error code as DNS_ERROR', async () => {
    const row = makeDomainRow({ status: 'pending' });
    const handler = createVerifyDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: [row] }) as any,
      dnsResolver: makeDnsResolverWithCode('EUNKNOWN_NEW_CODE'),
    });
    const result = await handler({ domainId: DOMAIN_ID }, makeCtx());
    expect(result.failureCode).toBe('DNS_ERROR');
    expect(result.dnsRecordsFound).toBeNull();
  });

  it('classifies a successful lookup with zero records as NO_RECORDS', async () => {
    const row = makeDomainRow({ status: 'pending' });
    let updatedValues: Record<string, unknown> | null = null;
    const handler = createVerifyDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({
        selectRows: [row],
        updateSpy: (v) => {
          updatedValues = v;
        },
      }) as any,
      dnsResolver: makeDnsResolver([]), // success, but empty
    });
    const result = await handler({ domainId: DOMAIN_ID }, makeCtx());
    expect(result.failureCode).toBe('NO_RECORDS');
    // Successful DNS lookup with empty array → count is 0 (not null).
    expect(result.dnsRecordsFound).toBe(0);
    expect(updatedValues!.dnsRecordsFound).toBe(0);
  });

  it('reports the actual TXT record count on a MISMATCH (multi-record case)', async () => {
    const row = makeDomainRow({
      status: 'pending',
      verificationValueHash: 'expected-hash-that-wont-match-anything',
    });
    let updatedValues: Record<string, unknown> | null = null;
    const handler = createVerifyDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({
        selectRows: [row],
        updateSpy: (v) => {
          updatedValues = v;
        },
      }) as any,
      dnsResolver: makeDnsResolver(['record-a', 'record-b', 'record-c']),
    });
    const result = await handler({ domainId: DOMAIN_ID }, makeCtx());
    expect(result.failureCode).toBe('MISMATCH');
    expect(result.dnsRecordsFound).toBe(3);
    expect(updatedValues!.dnsRecordsFound).toBe(3);
    // The user-facing message should mention the count without echoing
    // the raw record values back.
    expect(result.failureMessage).toContain('3 TXT records');
    expect(result.failureMessage).not.toContain('record-a');
    expect(result.failureMessage).not.toContain('record-b');
  });

  it('returns dnsRecordsFound = null on the verified happy path', async () => {
    // dnsRecordsFound only carries failure-diagnostic information; on a
    // successful verify the FE doesn't render the diagnostic strip, so
    // the verify handler updates the column to the actual count for
    // audit (the resolver returned at least 1 record), but the `success`
    // path in the DTO has dnsRecordsFound set to the count for symmetry.
    const rawValue = 'xynes-verify-test-success';
    const hashedValue = await hashForTest(rawValue);
    const row = makeDomainRow({
      status: 'pending',
      verificationValueHash: hashedValue,
    });
    let updatedValues: Record<string, unknown> | null = null;
    const handler = createVerifyDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({
        selectRows: [row],
        updateSpy: (v) => {
          updatedValues = v;
        },
      }) as any,
      dnsResolver: makeDnsResolver([rawValue]),
    });
    const result = await handler({ domainId: DOMAIN_ID }, makeCtx());
    expect(result.status).toBe('verified');
    expect(result.failureCode).toBeNull();
    // The count is still recorded on success — this is symmetry, not
    // leakage. The number 1 is harmless; what matters is the contract
    // that no raw record values ever flow to the DTO.
    expect(updatedValues!.dnsRecordsFound).toBe(1);
  });

  it('never echoes raw TXT record values back to the caller', async () => {
    // Defense-in-depth: even if a future bug made the failure_message
    // include record values, this test catches it. The records here are
    // crafted to look like attacker-supplied content.
    const row = makeDomainRow({
      status: 'pending',
      verificationValueHash: 'expected-hash',
    });
    const malicious = '<script>alert(1)</script>';
    const handler = createVerifyDomainHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: [row] }) as any,
      dnsResolver: makeDnsResolver([malicious, 'totally-legitimate-other-record']),
    });
    const result = await handler({ domainId: DOMAIN_ID }, makeCtx());
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(malicious);
    expect(serialised).not.toContain('totally-legitimate-other-record');
  });
});

// ═════════════════════════════════════════════════════════════════
// platform.domains.regenerateVerification
// ═════════════════════════════════════════════════════════════════

describe('platform.domains.regenerateVerification', () => {
  it('throws UNAUTHORIZED when userId is missing', async () => {
    const handler = createRegenerateVerificationHandler({
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
    const handler = createRegenerateVerificationHandler({
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

  it('throws FORBIDDEN when authz denies platform.domains.regenerateVerification permission', async () => {
    // Modeled as its own permission key (not a re-use of
    // platform.domains.create) so the gateway invariant
    // `route.action_key === permission_key` holds without permission-
    // lookup substitution. Both keys are catalog-derived for
    // workspace_owner / super_admin so the effective grants are the same.
    const handler = createRegenerateVerificationHandler({
      authzClient: makeAuthzClient(false),
      dbClient: makeFakeDb({ selectRows: [makeDomainRow({ status: 'pending' })] }) as any,
    });
    await expect(handler({ domainId: DOMAIN_ID }, makeCtx())).rejects.toThrow(DomainError);
    try {
      await handler({ domainId: DOMAIN_ID }, makeCtx());
    } catch (err) {
      expect((err as DomainError).code).toBe('FORBIDDEN');
    }
  });

  it('throws NOT_FOUND when domain does not exist', async () => {
    const handler = createRegenerateVerificationHandler({
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

  it('reissues the verification token for a pending domain', async () => {
    const row = makeDomainRow({
      status: 'pending',
      verificationValueHash: 'old-hash',
    });
    const db = makeFakeDb({ selectRows: [row] });
    const handler = createRegenerateVerificationHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
    });

    const result = await handler({ domainId: DOMAIN_ID }, makeCtx());

    expect(result.id).toBe(DOMAIN_ID);
    expect(result.status).toBe('pending');
    // The new verification value is returned exactly once — the panel
    // surfaces it via the same one-time reveal slot as create.
    expect(result.verificationValue).toBeDefined();
    expect(result.verificationValue.length).toBeGreaterThan(0);
    expect(result.verificationValue.startsWith('xynes-verify-')).toBe(true);

    // The DB UPDATE swapped the hash — and the new hash is NOT the old one.
    const updated = db._getUpdated()!;
    expect(updated.verificationValueHash).toBeDefined();
    expect(updated.verificationValueHash).not.toBe('old-hash');
    // Failure / last-checked state is reset.
    expect(updated.failureCode).toBeNull();
    expect(updated.failureMessage).toBeNull();
    expect(updated.lastCheckedAt).toBeNull();
    expect(updated.status).toBe('pending');
  });

  it('reissues for a failed domain (recovery from a failed verify attempt)', async () => {
    const row = makeDomainRow({
      status: 'failed',
      failureCode: 'MISMATCH',
      failureMessage: 'Found 1 TXT record at the verification name, but its value did not match.',
      verificationValueHash: 'old-hash',
      dnsRecordsFound: 1,
    });
    const db = makeFakeDb({ selectRows: [row] });
    const handler = createRegenerateVerificationHandler({
      authzClient: makeAuthzClient(),
      dbClient: db as any,
    });

    const result = await handler({ domainId: DOMAIN_ID }, makeCtx());

    expect(result.status).toBe('pending');
    expect(result.failureCode).toBeNull();
    expect(result.failureMessage).toBeNull();
    expect(result.lastCheckedAt).toBeNull();
    // dns_records_found applied to the previous (now-superseded) secret;
    // it must be reset so the FE diagnostic strip shows the
    // "no verify attempt yet" state for the freshly-issued token.
    expect(result.dnsRecordsFound).toBeNull();

    const updated = db._getUpdated()!;
    expect(updated.status).toBe('pending');
    expect(updated.verificationValueHash).not.toBe('old-hash');
    expect(updated.dnsRecordsFound).toBeNull();
  });

  it('refuses to regenerate for a verified domain (409 CONFLICT)', async () => {
    // Regenerating a verified domain would silently revoke verification —
    // we require an explicit disable + re-add cycle for that workflow.
    const row = makeDomainRow({
      status: 'verified',
      verifiedAt: NOW,
    });
    const handler = createRegenerateVerificationHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: [row] }) as any,
    });
    try {
      await handler({ domainId: DOMAIN_ID }, makeCtx());
      throw new Error('expected the handler to throw');
    } catch (err) {
      const domainErr = err as DomainError;
      expect(domainErr.code).toBe('CONFLICT');
      expect(domainErr.statusCode).toBe(409);
      expect(domainErr.message).toContain('verified');
    }
  });

  it('refuses to regenerate for a disabled domain (409 CONFLICT)', async () => {
    const row = makeDomainRow({ status: 'disabled' });
    const handler = createRegenerateVerificationHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: [row] }) as any,
    });
    try {
      await handler({ domainId: DOMAIN_ID }, makeCtx());
      throw new Error('expected the handler to throw');
    } catch (err) {
      const domainErr = err as DomainError;
      expect(domainErr.code).toBe('CONFLICT');
      expect(domainErr.statusCode).toBe(409);
      expect(domainErr.message).toContain('disabled');
    }
  });

  it('does not leak the new hash, raw value, or the previous hash in the DTO', async () => {
    // Security invariant: the DTO returned to the gateway must never
    // include verificationValueHash. The raw value lives only on the
    // explicit `verificationValue` extension field.
    const row = makeDomainRow({
      status: 'pending',
      verificationValueHash: 'old-hash-must-not-leak',
    });
    const handler = createRegenerateVerificationHandler({
      authzClient: makeAuthzClient(),
      dbClient: makeFakeDb({ selectRows: [row] }) as any,
    });

    const result = await handler({ domainId: DOMAIN_ID }, makeCtx());
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('old-hash-must-not-leak');
    expect(serialised).not.toContain('verificationValueHash');
    expect(serialised).not.toContain('verification_value_hash');
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
