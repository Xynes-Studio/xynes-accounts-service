import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { DomainError } from '@xynes/errors';

import { db } from '../../../infra/db';
import { logger } from '../../../infra/logger';
import { workspaceDomains } from '../../../infra/db/schema';
import { createAuthzClient, type AuthzClient } from '../../../infra/authz/authzClient';
import { normalizeWorkspaceDomain } from './domainValidation';
import type { ActionContext } from '../../types';

// ── Public types ────────────────────────────────────────────────

/** Safe DTO returned to callers — never includes raw hashes. */
export type DomainDto = {
  id: string;
  workspaceId: string;
  hostname: string;
  status: string;
  verificationMethod: string;
  verificationName: string;
  lastCheckedAt: string | null;
  verifiedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  failureCode: string | null;
  failureMessage: string | null;
};

/** Extended DTO returned only from the create action. */
export type CreateDomainResultDto = DomainDto & {
  /** Raw verification value the user needs to set as a DNS TXT record. Shown once. */
  verificationValue: string;
};

export type ListDomainsResult = {
  domains: DomainDto[];
};

// ── Dependency injection types ──────────────────────────────────

export type DnsResolver = (name: string, type: string) => Promise<string[]>;

export type DomainHandlerDependencies = {
  dbClient?: typeof db;
  authzClient?: AuthzClient;
  idFactory?: () => string;
  dnsResolver?: DnsResolver;
};

// ── Helpers ─────────────────────────────────────────────────────

function requireUserId(ctx: ActionContext): string {
  if (!ctx.userId) {
    throw new DomainError('Missing userId in auth context', 'UNAUTHORIZED', 401);
  }
  return ctx.userId;
}

function requireWorkspaceId(ctx: ActionContext): string {
  if (!ctx.workspaceId) {
    throw new DomainError('Missing workspaceId in action context', 'MISSING_CONTEXT', 400);
  }
  return ctx.workspaceId;
}

async function requirePermission(
  authzClient: AuthzClient,
  ctx: ActionContext,
  actionKey: string,
): Promise<void> {
  const allowed = await authzClient.checkPermission({
    userId: ctx.userId!,
    workspaceId: ctx.workspaceId,
    actionKey,
  });
  if (!allowed) {
    throw new DomainError('You do not have permission to perform this action', 'FORBIDDEN', 403);
  }
}

/** Map a DB row to a safe DTO (strips verification_value_hash). */
function toDto(row: typeof workspaceDomains.$inferSelect): DomainDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    hostname: row.hostname,
    status: row.status,
    verificationMethod: row.verificationMethod,
    verificationName: row.verificationName,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
  };
}

/**
 * Generate a cryptographically secure verification value and its hash.
 * The raw value is shown once to the user; only the hash is persisted.
 */
async function generateVerificationSecret(): Promise<{
  rawValue: string;
  hashedValue: string;
}> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const rawValue = `xynes-verify-${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;

  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawValue));
  const hashedValue = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return { rawValue, hashedValue };
}

function isUniqueViolation(err: unknown, constraintNames: string[]): boolean {
  const e = err as { code?: unknown; constraint_name?: unknown };
  return (
    e?.code === '23505' &&
    typeof e.constraint_name === 'string' &&
    constraintNames.includes(e.constraint_name)
  );
}

/**
 * Default DNS resolver using the Bun/Node dns module.
 * Resolves TXT records and returns flat string array.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function defaultDnsResolver(name: string, _type: string): Promise<string[]> {
  const { promises: dns } = await import('node:dns');
  const records = await dns.resolveTxt(name);
  // resolveTxt returns string[][] — flatten to string[]
  return records.flat();
}

// ═════════════════════════════════════════════════════════════════
// Handler factories (DI-friendly)
// ═════════════════════════════════════════════════════════════════

// ── LIST ────────────────────────────────────────────────────────

export type ListDomainsPayload = Record<string, never>;

export function createListDomainsHandler({
  dbClient = db,
  authzClient,
}: DomainHandlerDependencies = {}) {
  return async (_payload: ListDomainsPayload, ctx: ActionContext): Promise<ListDomainsResult> => {
    requireUserId(ctx);
    const workspaceId = requireWorkspaceId(ctx);
    const resolvedAuthz = authzClient ?? createAuthzClient();

    await requirePermission(resolvedAuthz, ctx, 'platform.domains.list');

    const rows = await dbClient
      .select()
      .from(workspaceDomains)
      .where(eq(workspaceDomains.workspaceId, workspaceId))
      .orderBy(workspaceDomains.createdAt);

    return { domains: rows.map(toDto) };
  };
}

// ── CREATE ──────────────────────────────────────────────────────

export type CreateDomainPayload = {
  hostname: string;
};

export function createCreateDomainHandler({
  dbClient = db,
  authzClient,
  idFactory = randomUUID,
}: DomainHandlerDependencies = {}) {
  return async (
    payload: CreateDomainPayload,
    ctx: ActionContext,
  ): Promise<CreateDomainResultDto> => {
    const userId = requireUserId(ctx);
    const workspaceId = requireWorkspaceId(ctx);
    const resolvedAuthz = authzClient ?? createAuthzClient();

    await requirePermission(resolvedAuthz, ctx, 'platform.domains.create');

    // Validate and normalize hostname (throws INVALID_DOMAIN on bad input)
    const { hostname, verificationName } = normalizeWorkspaceDomain(payload.hostname);

    // Generate one-time verification secret
    const { rawValue, hashedValue } = await generateVerificationSecret();

    const domainId = idFactory();

    try {
      const [inserted] = await dbClient
        .insert(workspaceDomains)
        .values({
          id: domainId,
          workspaceId,
          hostname,
          status: 'pending',
          verificationMethod: 'dns_txt',
          verificationName,
          verificationValueHash: hashedValue,
          createdBy: userId,
        })
        .returning();

      logger.info('[DomainsCreate] Domain registered', {
        requestId: ctx.requestId,
        workspaceId,
        hostname,
      });

      return {
        ...toDto(inserted),
        verificationValue: rawValue,
      };
    } catch (err) {
      if (
        isUniqueViolation(err, [
          'workspace_domains_active_hostname_uidx',
          'workspace_domains_workspace_hostname_uidx',
        ])
      ) {
        throw new DomainError(`Hostname "${hostname}" is already registered`, 'CONFLICT', 409);
      }
      throw err;
    }
  };
}

// ── VERIFY ──────────────────────────────────────────────────────

export type VerifyDomainPayload = {
  domainId: string;
};

export function createVerifyDomainHandler({
  dbClient = db,
  authzClient,
  dnsResolver = defaultDnsResolver,
}: DomainHandlerDependencies = {}) {
  return async (payload: VerifyDomainPayload, ctx: ActionContext): Promise<DomainDto> => {
    requireUserId(ctx);
    const workspaceId = requireWorkspaceId(ctx);
    const resolvedAuthz = authzClient ?? createAuthzClient();

    await requirePermission(resolvedAuthz, ctx, 'platform.domains.verify');

    // Fetch domain — must belong to the requesting workspace
    const rows = await dbClient
      .select()
      .from(workspaceDomains)
      .where(
        and(
          eq(workspaceDomains.id, payload.domainId),
          eq(workspaceDomains.workspaceId, workspaceId),
        ),
      );

    const domain = rows[0];
    if (!domain) {
      throw new DomainError('Domain not found', 'NOT_FOUND', 404);
    }

    const now = new Date();

    // Attempt DNS verification
    let dnsRecords: string[] = [];
    let dnsError: string | null = null;

    try {
      dnsRecords = await dnsResolver(domain.verificationName, 'TXT');
    } catch (err) {
      dnsError = err instanceof Error ? err.message : 'Unknown DNS error';
    }

    // Check if any TXT record matches the stored hash
    let verified = false;
    if (!dnsError && dnsRecords.length > 0) {
      for (const record of dnsRecords) {
        const recordHash = await hashValue(record);
        if (recordHash === domain.verificationValueHash) {
          verified = true;
          break;
        }
      }
    }

    // Build update payload
    const updateValues: Record<string, unknown> = {
      lastCheckedAt: now,
      updatedAt: now,
    };

    if (dnsError) {
      updateValues.status = 'failed';
      updateValues.failureCode = 'DNS_ERROR';
      // Log raw DNS error server-side for debugging; return safe message to caller
      logger.warn('[DomainsVerify] DNS resolution failed', {
        requestId: ctx.requestId,
        domainId: payload.domainId,
        rawError: dnsError,
      });
      updateValues.failureMessage = 'DNS resolution failed for the verification name';
    } else if (verified) {
      updateValues.status = 'verified';
      updateValues.verifiedAt = now;
      updateValues.failureCode = null;
      updateValues.failureMessage = null;
    } else {
      updateValues.status = 'failed';
      updateValues.failureCode = 'DNS_MISMATCH';
      updateValues.failureMessage = 'No matching TXT record found for the verification name';
    }

    const [updated] = await dbClient
      .update(workspaceDomains)
      .set(updateValues)
      .where(
        and(
          eq(workspaceDomains.id, payload.domainId),
          eq(workspaceDomains.workspaceId, workspaceId),
        ),
      )
      .returning();

    logger.info('[DomainsVerify] Verification attempt', {
      requestId: ctx.requestId,
      domainId: payload.domainId,
      status: updateValues.status,
    });

    return toDto(updated);
  };
}

// ── DELETE (soft) ───────────────────────────────────────────────

export type DeleteDomainPayload = {
  domainId: string;
};

export function createDeleteDomainHandler({
  dbClient = db,
  authzClient,
}: DomainHandlerDependencies = {}) {
  return async (payload: DeleteDomainPayload, ctx: ActionContext): Promise<DomainDto> => {
    requireUserId(ctx);
    const workspaceId = requireWorkspaceId(ctx);
    const resolvedAuthz = authzClient ?? createAuthzClient();

    await requirePermission(resolvedAuthz, ctx, 'platform.domains.delete');

    // Fetch domain — must belong to the requesting workspace
    const rows = await dbClient
      .select()
      .from(workspaceDomains)
      .where(
        and(
          eq(workspaceDomains.id, payload.domainId),
          eq(workspaceDomains.workspaceId, workspaceId),
        ),
      );

    const domain = rows[0];
    if (!domain) {
      throw new DomainError('Domain not found', 'NOT_FOUND', 404);
    }

    // Soft-delete: set status to 'disabled' to preserve audit history.
    // The DB unique index on (hostname) WHERE status <> 'disabled'
    // allows the same hostname to be re-registered later.
    const now = new Date();
    const [updated] = await dbClient
      .update(workspaceDomains)
      .set({
        status: 'disabled',
        updatedAt: now,
      })
      .where(
        and(
          eq(workspaceDomains.id, payload.domainId),
          eq(workspaceDomains.workspaceId, workspaceId),
        ),
      )
      .returning();

    logger.info('[DomainsDelete] Domain soft-deleted', {
      requestId: ctx.requestId,
      domainId: payload.domainId,
      hostname: domain.hostname,
    });

    return toDto(updated);
  };
}

// ── Default handler instances ───────────────────────────────────

export const listDomainsHandler = createListDomainsHandler();
export const createDomainHandler = createCreateDomainHandler();
export const verifyDomainHandler = createVerifyDomainHandler();
export const deleteDomainHandler = createDeleteDomainHandler();

// ── Internal utility ────────────────────────────────────────────

async function hashValue(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
