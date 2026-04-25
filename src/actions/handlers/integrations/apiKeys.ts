import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { DomainError } from '@xynes/errors';

import { db } from '../../../infra/db';
import { logger } from '../../../infra/logger';
import { workspaceApiKeys, workspaceApiKeyScopes } from '../../../infra/db/schema';
import type { AuthzClient } from '../../../infra/authz/authzClient';
import { generateWorkspaceApiKey } from './apiKeyCrypto';
import type { ActionContext } from '../../types';
import {
  requireUserId,
  requireWorkspaceId,
  requirePermission,
  resolveAuthzClient,
} from '../../guards';

// ── Preset Mapping ──────────────────────────────────────────────

/**
 * MVP preset → action-key scope mapping.
 *
 * Each preset defines a curated set of action keys that an API key
 * created with that preset will be allowed to invoke.
 *
 * Security note: `workspace_admin` intentionally excludes
 * `platform.api_keys.create` and `platform.api_keys.revoke`
 * to prevent privilege escalation via API key self-management.
 */
export const WORKSPACE_API_KEY_PRESETS = {
  cms_readonly: [
    'cms.content.listPublished',
    'cms.content.getPublishedBySlug',
    'cms.blog_entry.listPublished',
    'cms.blog_entry.getPublishedBySlug',
  ],
  cms_authoring: [
    'cms.entry.create',
    'cms.entry.update',
    'cms.entry.getById',
    'cms.entry.listByDirectory',
  ],
  cms_publisher: [
    'cms.entry.create',
    'cms.entry.update',
    'cms.entry.getById',
    'cms.entry.listByDirectory',
    'cms.entry.publish',
    'cms.entry.status.set',
  ],
  telemetry_read: ['telemetry.events.listRecentForWorkspace', 'telemetry.stats.summaryByRoute'],
  workspace_admin: [
    'platform.domains.list',
    'platform.api_keys.list',
    'platform.api_keys.usage.read',
  ],
} as const;

export type PresetKey = keyof typeof WORKSPACE_API_KEY_PRESETS;

// ── Public types ────────────────────────────────────────────────

/** Safe DTO returned to callers — never includes raw key or key hash. */
export type ApiKeyDto = {
  id: string;
  workspaceId: string;
  name: string;
  keyPrefix: string;
  status: string;
  presetKey: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  lastUsedAt: string | null;
};

/** Extended DTO returned only from the create action — includes the raw key shown once. */
export type CreateApiKeyResultDto = ApiKeyDto & {
  /** Raw API key shown exactly once. Never stored or logged. */
  rawKey: string;
  /** Action-key scopes assigned to this key. */
  scopes: string[];
};

export type ListApiKeysResult = {
  apiKeys: ApiKeyDto[];
};

export type ApiKeyUsageResult = {
  keyId: string;
  name: string;
  status: string;
  lastUsedAt: string | null;
  createdAt: string;
  scopes: string[];
};

// ── Dependency injection types ──────────────────────────────────

export type KeyGenerator = () => Promise<{
  rawKey: string;
  keyPrefix: string;
  keyHash: string;
}>;

export type ApiKeyHandlerDependencies = {
  dbClient?: typeof db;
  authzClient?: AuthzClient;
  idFactory?: () => string;
  keyGenerator?: KeyGenerator;
};

// ── Helpers ─────────────────────────────────────────────────────

/** Map a DB row to a safe DTO (strips keyHash). */
function toDto(row: typeof workspaceApiKeys.$inferSelect): ApiKeyDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    keyPrefix: row.keyPrefix,
    status: row.status,
    presetKey: row.presetKey,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedBy: row.revokedBy,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

/**
 * Validate that a preset key is recognized.
 * Throws INVALID_PRESET with a safe message on unknown presets.
 */
function validatePresetKey(presetKey: string): asserts presetKey is PresetKey {
  if (!(presetKey in WORKSPACE_API_KEY_PRESETS)) {
    throw new DomainError(`Unknown API key preset: "${presetKey}"`, 'INVALID_PRESET', 400);
  }
}

// ═════════════════════════════════════════════════════════════════
// Handler factories (DI-friendly)
// ═════════════════════════════════════════════════════════════════

// ── LIST ────────────────────────────────────────────────────────

export type ListApiKeysPayload = Record<string, never>;

export function createListApiKeysHandler({
  dbClient = db,
  authzClient,
}: ApiKeyHandlerDependencies = {}) {
  return async (_payload: ListApiKeysPayload, ctx: ActionContext): Promise<ListApiKeysResult> => {
    requireUserId(ctx);
    const workspaceId = requireWorkspaceId(ctx);
    const resolvedAuthz = resolveAuthzClient(authzClient);

    await requirePermission(resolvedAuthz, ctx, 'platform.api_keys.list');

    const rows = await dbClient
      .select()
      .from(workspaceApiKeys)
      .where(eq(workspaceApiKeys.workspaceId, workspaceId))
      .orderBy(workspaceApiKeys.createdAt);

    return { apiKeys: rows.map(toDto) };
  };
}

// ── CREATE ──────────────────────────────────────────────────────

export type CreateApiKeyPayload = {
  name: string;
  presetKey: string;
  expiresAt?: string;
};

export function createCreateApiKeyHandler({
  dbClient = db,
  authzClient,
  idFactory = randomUUID,
  keyGenerator = generateWorkspaceApiKey,
}: ApiKeyHandlerDependencies = {}) {
  return async (
    payload: CreateApiKeyPayload,
    ctx: ActionContext,
  ): Promise<CreateApiKeyResultDto> => {
    const userId = requireUserId(ctx);
    const workspaceId = requireWorkspaceId(ctx);
    const resolvedAuthz = resolveAuthzClient(authzClient);

    await requirePermission(resolvedAuthz, ctx, 'platform.api_keys.create');

    // Validate preset key
    validatePresetKey(payload.presetKey);
    const scopes = WORKSPACE_API_KEY_PRESETS[payload.presetKey];

    // Generate cryptographic key material
    const { rawKey, keyPrefix, keyHash } = await keyGenerator();

    const apiKeyId = idFactory();

    // Wrap key + scope inserts in a single transaction so a partial failure
    // never leaves an active key without scopes (undefined security state).
    const inserted = await dbClient.transaction(async (tx) => {
      const [row] = await tx
        .insert(workspaceApiKeys)
        .values({
          id: apiKeyId,
          workspaceId,
          name: payload.name.trim(),
          keyPrefix,
          keyHash,
          status: 'active',
          presetKey: payload.presetKey,
          createdBy: userId,
          expiresAt: payload.expiresAt ? new Date(payload.expiresAt) : null,
        })
        .returning();

      // Insert scope rows within the same transaction
      if (scopes.length > 0) {
        const scopeRows = scopes.map((actionKey) => ({
          apiKeyId,
          actionKey,
        }));
        await tx.insert(workspaceApiKeyScopes).values(scopeRows);
      }

      return row;
    });

    logger.info('[ApiKeysCreate] API key created', {
      requestId: ctx.requestId,
      workspaceId,
      apiKeyId,
      presetKey: payload.presetKey,
      scopeCount: scopes.length,
    });

    return {
      ...toDto(inserted),
      rawKey,
      scopes: [...scopes],
    };
  };
}

// ── REVOKE ──────────────────────────────────────────────────────

export type RevokeApiKeyPayload = {
  keyId: string;
};

export function createRevokeApiKeyHandler({
  dbClient = db,
  authzClient,
}: ApiKeyHandlerDependencies = {}) {
  return async (payload: RevokeApiKeyPayload, ctx: ActionContext): Promise<ApiKeyDto> => {
    const userId = requireUserId(ctx);
    const workspaceId = requireWorkspaceId(ctx);
    const resolvedAuthz = resolveAuthzClient(authzClient);

    await requirePermission(resolvedAuthz, ctx, 'platform.api_keys.revoke');

    // Fetch API key — must belong to the requesting workspace
    const rows = await dbClient
      .select()
      .from(workspaceApiKeys)
      .where(
        and(eq(workspaceApiKeys.id, payload.keyId), eq(workspaceApiKeys.workspaceId, workspaceId)),
      );

    const apiKey = rows[0];
    if (!apiKey) {
      throw new DomainError('API key not found', 'NOT_FOUND', 404);
    }

    if (apiKey.status === 'revoked') {
      throw new DomainError('API key has already been revoked', 'ALREADY_REVOKED', 409);
    }

    const now = new Date();
    const [updated] = await dbClient
      .update(workspaceApiKeys)
      .set({
        status: 'revoked',
        revokedAt: now,
        revokedBy: userId,
      })
      .where(
        and(
          eq(workspaceApiKeys.id, payload.keyId),
          eq(workspaceApiKeys.workspaceId, workspaceId),
          eq(workspaceApiKeys.status, 'active'),
        ),
      )
      .returning();

    // Atomic guard: if the UPDATE matched zero rows, a concurrent request
    // already revoked the key between our SELECT and UPDATE.
    if (!updated) {
      throw new DomainError('API key has already been revoked', 'ALREADY_REVOKED', 409);
    }

    logger.info('[ApiKeysRevoke] API key revoked', {
      requestId: ctx.requestId,
      workspaceId,
      apiKeyId: payload.keyId,
      revokedBy: userId,
    });

    return toDto(updated);
  };
}

// ── USAGE READ ──────────────────────────────────────────────────

export type ReadApiKeyUsagePayload = {
  keyId: string;
};

export function createReadApiKeyUsageHandler({
  dbClient = db,
  authzClient,
}: ApiKeyHandlerDependencies = {}) {
  return async (
    payload: ReadApiKeyUsagePayload,
    ctx: ActionContext,
  ): Promise<ApiKeyUsageResult> => {
    requireUserId(ctx);
    const workspaceId = requireWorkspaceId(ctx);
    const resolvedAuthz = resolveAuthzClient(authzClient);

    await requirePermission(resolvedAuthz, ctx, 'platform.api_keys.usage.read');

    // Fetch API key — must belong to the requesting workspace
    const rows = await dbClient
      .select()
      .from(workspaceApiKeys)
      .where(
        and(eq(workspaceApiKeys.id, payload.keyId), eq(workspaceApiKeys.workspaceId, workspaceId)),
      );

    const apiKey = rows[0];
    if (!apiKey) {
      throw new DomainError('API key not found', 'NOT_FOUND', 404);
    }

    // Fetch scopes for this key
    const scopeRows = await dbClient
      .select()
      .from(workspaceApiKeyScopes)
      .where(eq(workspaceApiKeyScopes.apiKeyId, payload.keyId));

    return {
      keyId: apiKey.id,
      name: apiKey.name,
      status: apiKey.status,
      lastUsedAt: apiKey.lastUsedAt?.toISOString() ?? null,
      createdAt: apiKey.createdAt.toISOString(),
      scopes: scopeRows.map((s: typeof workspaceApiKeyScopes.$inferSelect) => s.actionKey),
    };
  };
}

// ── Default handler instances ───────────────────────────────────

export const listApiKeysHandler = createListApiKeysHandler();
export const createApiKeyHandler = createCreateApiKeyHandler();
export const revokeApiKeyHandler = createRevokeApiKeyHandler();
export const readApiKeyUsageHandler = createReadApiKeyUsageHandler();
