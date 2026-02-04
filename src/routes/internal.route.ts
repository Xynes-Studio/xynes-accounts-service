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
  ensureWorkspaceMemberPayloadSchema,
  meGetOrCreatePayloadSchema,
  listWorkspacesForUserPayloadSchema,
  listWorkspaceMembersPayloadSchema,
  createWorkspacePayloadSchema,
  createWorkspaceInvitePayloadSchema,
  resolveWorkspaceInvitePayloadSchema,
  acceptWorkspaceInvitePayloadSchema,
} from '../actions/schemas';

const internalRoute = new Hono();
internalRoute.use('*', requireInternalServiceAuth());

const actionRequestSchema = z
  .object({
    actionKey: z.string(),
    payload: z.unknown(),
  })
  .strict();

const uuidHeader = z.string().uuid();

const NON_WORKSPACE_ACTION_KEYS = new Set<AccountsActionKey>([
  'accounts.me.getOrCreate',
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
  const userRequired = !PUBLIC_ACTION_KEYS.has(key);
  const rawUserId = c.req.header('X-XS-User-Id');
  if (userRequired && !rawUserId) {
    return c.json(
      createErrorResponse('UNAUTHORIZED', 'X-XS-User-Id header is required', requestId),
      401,
    );
  }
  const userIdResult = rawUserId ? uuidHeader.safeParse(rawUserId) : null;
  if (userRequired && (!userIdResult || !userIdResult.success)) {
    return c.json(
      createErrorResponse('INVALID_HEADER', 'X-XS-User-Id must be a UUID', requestId),
      400,
    );
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
    userId: userIdResult && userIdResult.success ? userIdResult.data : null,
    requestId,
    user: {
      email: c.req.header('X-XS-User-Email') ?? undefined,
      name: c.req.header('X-XS-User-Name') ?? undefined,
      avatarUrl: c.req.header('X-XS-User-Avatar-Url') ?? undefined,
    },
  };

  logger.info(`Received internal action: ${actionKey}`, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
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
      default:
        throw new UnknownActionError(actionKey);
    }

    const actionResult = await executeAccountsAction(key, validatedPayload, ctx);
    const status =
      key === 'accounts.workspaceMember.ensure' ||
      key === 'accounts.workspaces.create' ||
      key === 'accounts.invites.create' ||
      key === 'accounts.invites.accept'
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
