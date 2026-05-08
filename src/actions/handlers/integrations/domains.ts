import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { DomainError } from '@xynes/errors';

import { db } from '../../../infra/db';
import { logger } from '../../../infra/logger';
import { workspaceDomains } from '../../../infra/db/schema';
import type { AuthzClient } from '../../../infra/authz/authzClient';
import { normalizeWorkspaceDomain } from './domainValidation';
import type { ActionContext } from '../../types';
import {
  requireUserId,
  requireWorkspaceId,
  requirePermission,
  resolveAuthzClient,
} from '../../guards';

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
  /**
   * Count-only diagnostic surfaced by the verify handler. NEVER carries
   * raw TXT record values (those could be attacker-supplied content from
   * a hostile DNS zone). NULL when no verify attempt has been made or
   * DNS lookup itself errored before any records were enumerated.
   */
  dnsRecordsFound: number | null;
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
    dnsRecordsFound: row.dnsRecordsFound ?? null,
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
 * Defense-in-depth: detect a Postgres CHECK-constraint violation (SQLSTATE
 * `23514`). The frontend `normalizeWorkspaceDomain` validator already
 * mirrors every shape/lowercase/length rule expressed as a CHECK on
 * `platform.workspace_domains`, so we should never reach here for valid
 * input — but if the validator drifts from the DB schema (or a future
 * constraint is added without a matching validator change), we want users
 * to see a safe `INVALID_DOMAIN` 400 instead of a generic `INTERNAL_ERROR`
 * 500. This also prevents the global `errorHandler` middleware from
 * logging the failed insert (which carries `verification_value_hash` in
 * its `params`) at error level for a known-validation failure.
 *
 * Maps the constraint name (when available) to a user-friendly message
 * that matches what `normalizeWorkspaceDomain` would have said.
 */
function isCheckViolation(err: unknown): err is { code: '23514'; constraint_name?: string } {
  const e = err as { code?: unknown };
  return e?.code === '23514';
}

function checkViolationMessage(constraintName: string | undefined, hostname: string): string {
  switch (constraintName) {
    case 'workspace_domains_hostname_lower':
      return `Hostname "${hostname}" must be lowercase`;
    case 'workspace_domains_hostname_shape':
      return `Hostname "${hostname}" is not in a valid shape`;
    case 'workspace_domains_hostname_not_blank':
      return 'Hostname must not be empty';
    default:
      return `Hostname "${hostname}" is not in a valid shape`;
  }
}

/**
 * Default DNS resolver using the Bun/Node dns module.
 * Resolves TXT records and returns flat string array.
 * Each TXT record may be split into 255-byte chunks by the DNS protocol;
 * we join each record's chunks back into a single string.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function defaultDnsResolver(name: string, _type: string): Promise<string[]> {
  const { promises: dns } = await import('node:dns');
  const records = await dns.resolveTxt(name);
  // resolveTxt returns string[][] — each inner array is one TXT record
  // split into ≤255-byte chunks. Join chunks to reconstruct full values.
  return records.map((chunks) => chunks.join(''));
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
    const resolvedAuthz = resolveAuthzClient(authzClient);

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
    const resolvedAuthz = resolveAuthzClient(authzClient);

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
      if (isCheckViolation(err)) {
        // Defense-in-depth: surface CHECK-constraint failures as a safe
        // 400 INVALID_DOMAIN instead of falling through to the global
        // error handler (which would log the failed insert + its
        // verification_value_hash at error level and return 500).
        const constraintName = (err as { constraint_name?: unknown }).constraint_name as
          | string
          | undefined;
        logger.warn('[DomainsCreate] DB CHECK violation', {
          requestId: ctx.requestId,
          workspaceId,
          hostname,
          constraintName,
        });
        throw new DomainError(
          checkViolationMessage(constraintName, hostname),
          'INVALID_DOMAIN',
          400,
        );
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
    const resolvedAuthz = resolveAuthzClient(authzClient);

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
    // Categorized error class for the FE diagnostic strip. We capture the
    // resolver-side class once and feed it into the failure-code mapping
    // below so we never have to re-parse a raw error string.
    let dnsErrorClass: 'NXDOMAIN' | 'TIMEOUT' | 'DNS_ERROR' | null = null;

    try {
      dnsRecords = await dnsResolver(domain.verificationName, 'TXT');
    } catch (err) {
      dnsError = err instanceof Error ? err.message : 'Unknown DNS error';
      // Node/Bun dns module surfaces these as `error.code` strings. We
      // classify the common ones; everything else falls through to the
      // generic DNS_ERROR bucket. Never echo the raw error to the caller —
      // it can carry resolver-internal hostnames or stack frames that
      // would only confuse a workspace owner reading the failure message.
      const code = (err as { code?: unknown }).code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') {
        dnsErrorClass = 'NXDOMAIN';
      } else if (code === 'ETIMEOUT' || code === 'ESERVFAIL' || code === 'EREFUSED') {
        dnsErrorClass = 'TIMEOUT';
      } else {
        dnsErrorClass = 'DNS_ERROR';
      }
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
      // Phase B: surface a count-only diagnostic. Null when DNS lookup
      // errored before records could be enumerated; 0 when the lookup
      // succeeded but returned no TXT records (NXDOMAIN-with-empty,
      // unconfigured zone, etc.); ≥1 otherwise. NEVER stores raw values.
      dnsRecordsFound: dnsError ? null : dnsRecords.length,
    };

    if (dnsError) {
      updateValues.status = 'failed';
      updateValues.failureCode = dnsErrorClass ?? 'DNS_ERROR';
      // Log raw DNS error server-side for debugging; return safe message to caller
      logger.warn('[DomainsVerify] DNS resolution failed', {
        requestId: ctx.requestId,
        domainId: payload.domainId,
        rawError: dnsError,
        failureCode: updateValues.failureCode,
      });
      // User-facing message intentionally short and neutral. The
      // detailed diagnostic strip on the FE drives the conversation.
      updateValues.failureMessage =
        dnsErrorClass === 'NXDOMAIN'
          ? 'No DNS record found at the verification name yet. DNS propagation can take up to 24h.'
          : dnsErrorClass === 'TIMEOUT'
            ? 'DNS lookup timed out. Try again in a moment.'
            : 'DNS resolution failed for the verification name';
    } else if (verified) {
      updateValues.status = 'verified';
      updateValues.verifiedAt = now;
      updateValues.failureCode = null;
      updateValues.failureMessage = null;
    } else if (dnsRecords.length === 0) {
      // NXDOMAIN-ish path where the resolver returns successfully but
      // with no TXT records under the name (different from ENOTFOUND
      // depending on resolver implementation). Surface as a separate
      // code so the FE can distinguish "DNS lookup worked but the
      // record isn't there yet" from "nothing matched".
      updateValues.status = 'failed';
      updateValues.failureCode = 'NO_RECORDS';
      updateValues.failureMessage =
        'No TXT records found at the verification name. DNS propagation can take up to 24h.';
    } else {
      updateValues.status = 'failed';
      updateValues.failureCode = 'MISMATCH';
      updateValues.failureMessage =
        dnsRecords.length === 1
          ? 'Found 1 TXT record at the verification name, but its value did not match.'
          : `Found ${dnsRecords.length} TXT records at the verification name, but none matched.`;
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

    // Guard against TOCTOU race: if the row was modified/removed between
    // SELECT and UPDATE, the update may match zero rows.
    if (!updated) {
      throw new DomainError('Domain not found', 'NOT_FOUND', 404);
    }

    logger.info('[DomainsVerify] Verification attempt', {
      requestId: ctx.requestId,
      domainId: payload.domainId,
      status: updateValues.status,
    });

    return toDto(updated);
  };
}

// ── REGENERATE VERIFICATION ─────────────────────────────────────

export type RegenerateVerificationPayload = {
  domainId: string;
};

/**
 * Issue a fresh DNS TXT verification token for an existing
 * pending/failed domain row. The user clicks "Get new value" when they
 * have lost the original one-time reveal — the server stores ONLY the
 * SHA-256 hash of the verification value (per the workspace-admin-
 * integrations epic invariant), so recopying an already-revealed value
 * is impossible by design. This handler is the supported recovery path.
 *
 * Permission contract: gated by `platform.domains.regenerateVerification`,
 * a permission key in the authz catalog with the SAME effective grants
 * as `platform.domains.create` (both are catalog-derived for
 * workspace_owner / super_admin; explicit-allowlist lower-tier roles
 * receive neither). Modeled as its own key (not a re-use of the create
 * key) so the gateway's "route action_key === permission key" invariant
 * holds without permission-lookup substitution.
 *
 * State contract:
 *  - Allowed only when status IN ('pending', 'failed').
 *  - Forbids `verified` (a verified domain has no need for a fresh
 *    token; regenerating would silently revoke verification) → 409 CONFLICT.
 *  - Forbids `disabled` (the soft-deleted state must remain inert) →
 *    409 CONFLICT.
 *
 * Side effects on success:
 *  - `verification_value_hash` swapped atomically.
 *  - `status` set to `pending` (reset from `failed`).
 *  - `failure_code`, `failure_message`, `last_checked_at` reset to NULL.
 *  - `updated_at` set to now().
 *  - `verified_at` is intentionally NOT touched (it should still be NULL
 *    in either of the allowed source states; if it isn't, the row was
 *    tampered with externally and we'd rather preserve the audit trail).
 *  - `dns_records_found` (Phase B) is reset to NULL — the previous
 *    diagnostic counter applied to the previous secret.
 *
 * Returns the same shape as `platform.domains.create` so the FE can use
 * the same one-time reveal slot.
 */
export function createRegenerateVerificationHandler({
  dbClient = db,
  authzClient,
}: DomainHandlerDependencies = {}) {
  return async (
    payload: RegenerateVerificationPayload,
    ctx: ActionContext,
  ): Promise<CreateDomainResultDto> => {
    requireUserId(ctx);
    const workspaceId = requireWorkspaceId(ctx);
    const resolvedAuthz = resolveAuthzClient(authzClient);

    // Gated by `platform.domains.regenerateVerification` — see the
    // contract note above the factory for why this is a separate
    // permission key (not a re-use of `platform.domains.create`).
    await requirePermission(resolvedAuthz, ctx, 'platform.domains.regenerateVerification');

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

    if (domain.status !== 'pending' && domain.status !== 'failed') {
      throw new DomainError(
        `Cannot regenerate verification for a ${domain.status} domain`,
        'CONFLICT',
        409,
      );
    }

    // Generate a fresh one-time verification secret
    const { rawValue, hashedValue } = await generateVerificationSecret();

    const now = new Date();
    const [updated] = await dbClient
      .update(workspaceDomains)
      .set({
        status: 'pending',
        verificationValueHash: hashedValue,
        failureCode: null,
        failureMessage: null,
        lastCheckedAt: null,
        // The previous diagnostic counter applied to the previous secret
        // (a different `verificationValueHash`); the count is meaningless
        // for the freshly-issued token. Reset to NULL so the FE diagnostic
        // strip shows the correct "no verify attempt yet" state.
        dnsRecordsFound: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(workspaceDomains.id, payload.domainId),
          eq(workspaceDomains.workspaceId, workspaceId),
        ),
      )
      .returning();

    // TOCTOU guard — see verify/delete handlers.
    if (!updated) {
      throw new DomainError('Domain not found', 'NOT_FOUND', 404);
    }

    logger.info('[DomainsRegenerateVerification] Verification token reissued', {
      requestId: ctx.requestId,
      workspaceId,
      domainId: payload.domainId,
      previousStatus: domain.status,
    });

    return {
      ...toDto(updated),
      verificationValue: rawValue,
    };
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
    const resolvedAuthz = resolveAuthzClient(authzClient);

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

    // Guard against TOCTOU race: if the row was modified/removed between
    // SELECT and UPDATE, the update may match zero rows.
    if (!updated) {
      throw new DomainError('Domain not found', 'NOT_FOUND', 404);
    }

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
export const regenerateVerificationHandler = createRegenerateVerificationHandler();
export const deleteDomainHandler = createDeleteDomainHandler();

// ── Internal utility ────────────────────────────────────────────

async function hashValue(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Categorized failure codes surfaced by the verify handler.
 *
 * The frontend translates these into a 3-step diagnostic strip:
 *
 *   - DNS lookup    → ✗ on NXDOMAIN | TIMEOUT | DNS_ERROR; ✓ otherwise
 *   - TXT records   → "N records" (✗ when 0 → NO_RECORDS; ✓ when ≥1)
 *   - Value match   → ✗ on MISMATCH; ✓ on verified
 *
 * Codes are stable contract; the user-facing `failure_message` text is
 * advisory and may change without breaking the FE.
 *
 * Security: codes never echo the resolver's raw error string back; the
 * raw error is logged server-side for debugging only.
 */
export type DomainFailureCode = 'NXDOMAIN' | 'TIMEOUT' | 'DNS_ERROR' | 'NO_RECORDS' | 'MISMATCH';
