import { Hono } from 'hono';
import { z } from 'zod';
import { requireInternalServiceAuth } from '../middleware/internal-service-auth';
import {
  createSuccessResponse,
  createErrorResponse,
  createValidationErrorResponse,
} from '@xynes/envelope';
import { config } from '../infra/config';
import { parseJsonBodyWithLimit } from '../infra/http/parse-json-body';
import { generateRequestId } from '../infra/http/request-id';
import { logger } from '../infra/logger';
import { executeAccountsAction } from '../actions/execute';
import { AccountsActionKey } from '../actions/types';
import { UnknownActionError } from '../actions/errors';
import {
  pingPayloadSchema,
  readCurrentWorkspacePayloadSchema,
  readSelfUserPayloadSchema,
  updateSelfUserPayloadSchema,
  ensureWorkspaceMemberPayloadSchema,
  meGetOrCreatePayloadSchema,
  listWorkspacesForUserPayloadSchema,
  listWorkspaceMembersPayloadSchema,
  createWorkspacePayloadSchema,
  createWorkspaceInvitePayloadSchema,
  resolveWorkspaceInvitePayloadSchema,
  acceptWorkspaceInvitePayloadSchema,
  platformDomainsListPayloadSchema,
  platformDomainsCreatePayloadSchema,
  platformDomainsVerifyPayloadSchema,
  platformDomainsRegenerateVerificationPayloadSchema,
  platformDomainsDeletePayloadSchema,
  platformApiKeysListPayloadSchema,
  platformApiKeysCreatePayloadSchema,
  platformApiKeysRevokePayloadSchema,
  platformApiKeysUsageReadPayloadSchema,
} from '../actions/schemas';
import type { ActionActor } from '../actions/types';

const internalRoute = new Hono();
internalRoute.use('*', requireInternalServiceAuth());

const actionRequestSchema = z
  .object({
    actionKey: z.string(),
    payload: z.unknown(),
  })
  .strict();

const uuidHeader = z.string().uuid();
// PFU-1 — gateway emits `X-XS-API-Key-Prefix` as the first 8 hex chars
// of the secret portion of `xynes_live_<hex>` (see
// `xynes-gateway/src/security/apiKeyAuth.ts` API_KEY_LOOKUP_PREFIX_LENGTH).
// We validate the shape defensively so a malformed prefix never reaches
// downstream audit logs.
const apiKeyPrefixHeader = z.string().regex(/^[a-f0-9]{8}$/, 'must be 8 hex chars');
// PFU-1 — Recognised actor kinds. Gateway emits exactly these values.
const ACTOR_KINDS = new Set(['user', 'api_key']);

const NON_WORKSPACE_ACTION_KEYS = new Set<AccountsActionKey>([
  'accounts.me.getOrCreate',
  'accounts.user.updateSelf',
  'accounts.workspaces.listForUser',
  'accounts.workspaces.create',
  'accounts.invites.resolve',
  'accounts.invites.accept',
]);

const PUBLIC_ACTION_KEYS = new Set<AccountsActionKey>(['accounts.invites.resolve']);

internalRoute.post('/accounts-actions', async (c) => {
  const requestId = c.get('requestId') || generateRequestId();
  c.set('requestId', requestId);

  const maxBytes = Number.parseInt(config.server.MAX_JSON_BODY_BYTES, 10) || 1048576;
  const body = await parseJsonBodyWithLimit(c.req.raw, maxBytes);
  const result = actionRequestSchema.safeParse(body);

  if (!result.success) {
    return c.json(
      createValidationErrorResponse(result.error, requestId, 'Invalid request body'),
      400,
    );
  }

  const { actionKey, payload: rawPayload } = result.data;

  const key = actionKey as AccountsActionKey;
  const isPublicAction = PUBLIC_ACTION_KEYS.has(key);

  // PFU-1 — Resolve the actor from gateway-emitted internal headers.
  //
  // Contract (mirrors xynes-gateway `buildInternalHeaders`):
  //   - `X-XS-Actor-Type`: 'user' | 'api_key' | absent (defaults to 'user'
  //                         to preserve pre-PFU-1 behaviour byte-for-byte).
  //   - User actor:    requires `X-XS-User-Id` (UUID).
  //   - API-key actor: requires `X-XS-API-Key-Id` (UUID) +
  //                    `X-XS-API-Key-Prefix` (8 hex chars).
  //
  // Public actions (PUBLIC_ACTION_KEYS) bypass actor resolution entirely
  // — they may be invoked anonymously.
  const rawActorType = c.req.header('X-XS-Actor-Type');
  if (rawActorType && !ACTOR_KINDS.has(rawActorType)) {
    return c.json(
      createErrorResponse(
        'INVALID_HEADER',
        'X-XS-Actor-Type must be one of: user, api_key',
        requestId,
      ),
      400,
    );
  }
  const actorType: 'user' | 'api_key' = rawActorType === 'api_key' ? 'api_key' : 'user';

  let actor: ActionActor | undefined;
  let resolvedUserId: string | null = null;

  if (!isPublicAction) {
    if (actorType === 'api_key') {
      const rawApiKeyId = c.req.header('X-XS-API-Key-Id');
      if (!rawApiKeyId) {
        return c.json(
          createErrorResponse(
            'INVALID_HEADER',
            'X-XS-API-Key-Id header is required for api_key actor',
            requestId,
          ),
          400,
        );
      }
      const apiKeyIdResult = uuidHeader.safeParse(rawApiKeyId);
      if (!apiKeyIdResult.success) {
        return c.json(
          createErrorResponse('INVALID_HEADER', 'X-XS-API-Key-Id must be a UUID', requestId),
          400,
        );
      }
      const rawApiKeyPrefix = c.req.header('X-XS-API-Key-Prefix');
      if (!rawApiKeyPrefix) {
        return c.json(
          createErrorResponse(
            'INVALID_HEADER',
            'X-XS-API-Key-Prefix header is required for api_key actor',
            requestId,
          ),
          400,
        );
      }
      const apiKeyPrefixResult = apiKeyPrefixHeader.safeParse(rawApiKeyPrefix);
      if (!apiKeyPrefixResult.success) {
        return c.json(
          createErrorResponse(
            'INVALID_HEADER',
            'X-XS-API-Key-Prefix must be 8 hex chars',
            requestId,
          ),
          400,
        );
      }
      actor = {
        kind: 'api_key',
        apiKeyId: apiKeyIdResult.data,
        keyPrefix: apiKeyPrefixResult.data,
      };
      // resolvedUserId stays null — api_key actors carry no user identity.
    } else {
      // user actor (default)
      const rawUserId = c.req.header('X-XS-User-Id');
      if (!rawUserId) {
        return c.json(
          createErrorResponse('UNAUTHORIZED', 'X-XS-User-Id header is required', requestId),
          401,
        );
      }
      const userIdResult = uuidHeader.safeParse(rawUserId);
      if (!userIdResult.success) {
        return c.json(
          createErrorResponse('INVALID_HEADER', 'X-XS-User-Id must be a UUID', requestId),
          400,
        );
      }
      resolvedUserId = userIdResult.data;
      actor = { kind: 'user', userId: userIdResult.data };
    }
  } else {
    // Public action — actor is optional. If a user id was forwarded by
    // the gateway anyway, capture it for audit purposes.
    const rawUserId = c.req.header('X-XS-User-Id');
    if (rawUserId) {
      const userIdResult = uuidHeader.safeParse(rawUserId);
      if (userIdResult.success) {
        resolvedUserId = userIdResult.data;
        actor = { kind: 'user', userId: userIdResult.data };
      }
    }
  }

  const workspaceRequired = !NON_WORKSPACE_ACTION_KEYS.has(key);

  const rawWorkspaceId = c.req.header('X-Workspace-Id');
  if (workspaceRequired && !rawWorkspaceId) {
    return c.json(
      createErrorResponse('MISSING_HEADER', 'X-Workspace-Id header is required', requestId),
      400,
    );
  }

  let workspaceId: string | null = null;
  if (rawWorkspaceId) {
    const workspaceIdResult = uuidHeader.safeParse(rawWorkspaceId);
    if (!workspaceIdResult.success) {
      return c.json(
        createErrorResponse('INVALID_HEADER', 'X-Workspace-Id must be a UUID', requestId),
        400,
      );
    }
    workspaceId = workspaceIdResult.data;
  }

  const ctx = {
    workspaceId,
    userId: resolvedUserId,
    requestId,
    user: {
      email: c.req.header('X-XS-User-Email') ?? undefined,
      name: c.req.header('X-XS-User-Name') ?? undefined,
      avatarUrl: c.req.header('X-XS-User-Avatar-Url') ?? undefined,
    },
    actor,
  };

  logger.info(`Received internal action: ${actionKey}`, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    actorType: actor?.kind ?? 'anonymous',
    apiKeyId: actor?.kind === 'api_key' ? actor.apiKeyId : undefined,
    requestId,
  });

  try {
    let validatedPayload: unknown;

    switch (key) {
      case 'accounts.ping':
        validatedPayload = pingPayloadSchema.parse(rawPayload);
        break;
      case 'accounts.user.readSelf':
        validatedPayload = readSelfUserPayloadSchema.parse(rawPayload);
        break;
      case 'accounts.user.updateSelf':
        validatedPayload = updateSelfUserPayloadSchema.parse(rawPayload);
        break;
      case 'accounts.workspace.readCurrent':
        validatedPayload = readCurrentWorkspacePayloadSchema.parse(rawPayload);
        break;
      case 'accounts.workspaceMember.ensure':
        validatedPayload = ensureWorkspaceMemberPayloadSchema.parse(rawPayload);
        break;
      case 'accounts.me.getOrCreate':
        validatedPayload = meGetOrCreatePayloadSchema.parse(rawPayload);
        break;
      case 'accounts.workspaces.listForUser':
        validatedPayload = listWorkspacesForUserPayloadSchema.parse(rawPayload);
        break;
      case 'accounts.workspace_members.listForWorkspace':
        validatedPayload = listWorkspaceMembersPayloadSchema.parse(rawPayload);
        break;
      case 'accounts.workspaces.create':
        validatedPayload = createWorkspacePayloadSchema.parse(rawPayload);
        break;
      case 'accounts.invites.create':
        validatedPayload = createWorkspaceInvitePayloadSchema.parse(rawPayload);
        break;
      case 'accounts.invites.resolve':
        validatedPayload = resolveWorkspaceInvitePayloadSchema.parse(rawPayload);
        break;
      case 'accounts.invites.accept':
        validatedPayload = acceptWorkspaceInvitePayloadSchema.parse(rawPayload);
        break;
      case 'platform.domains.list':
        validatedPayload = platformDomainsListPayloadSchema.parse(rawPayload);
        break;
      case 'platform.domains.create':
        validatedPayload = platformDomainsCreatePayloadSchema.parse(rawPayload);
        break;
      case 'platform.domains.verify':
        validatedPayload = platformDomainsVerifyPayloadSchema.parse(rawPayload);
        break;
      case 'platform.domains.regenerateVerification':
        validatedPayload = platformDomainsRegenerateVerificationPayloadSchema.parse(rawPayload);
        break;
      case 'platform.domains.delete':
        validatedPayload = platformDomainsDeletePayloadSchema.parse(rawPayload);
        break;
      case 'platform.api_keys.list':
        validatedPayload = platformApiKeysListPayloadSchema.parse(rawPayload);
        break;
      case 'platform.api_keys.create':
        validatedPayload = platformApiKeysCreatePayloadSchema.parse(rawPayload);
        break;
      case 'platform.api_keys.revoke':
        validatedPayload = platformApiKeysRevokePayloadSchema.parse(rawPayload);
        break;
      case 'platform.api_keys.usage.read':
        validatedPayload = platformApiKeysUsageReadPayloadSchema.parse(rawPayload);
        break;
      default:
        throw new UnknownActionError(actionKey);
    }

    const actionResult = await executeAccountsAction(key, validatedPayload, ctx);
    const status =
      key === 'accounts.workspaceMember.ensure' ||
      key === 'accounts.workspaces.create' ||
      key === 'accounts.invites.create' ||
      key === 'accounts.invites.accept' ||
      key === 'platform.domains.create' ||
      key === 'platform.domains.regenerateVerification' ||
      key === 'platform.api_keys.create'
        ? 201
        : 200;
    return c.json(createSuccessResponse(actionResult, requestId), status);
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return c.json(
        createValidationErrorResponse(err, requestId, 'Payload validation failed'),
        400,
      );
    }
    throw err;
  }
});

export { internalRoute };
