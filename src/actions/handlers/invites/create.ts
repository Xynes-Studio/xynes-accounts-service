import { randomUUID } from 'node:crypto';
import { DomainError } from '@xynes/errors';

import { db } from '../../../infra/db';
import { workspaceInvites } from '../../../infra/db/schema';
import { createAuthzClient, type AuthzClient } from '../../../infra/authz/authzClient';
import { generateInviteToken, type InviteTokenPair } from '../../../infra/security/inviteToken';
import type { ActionContext } from '../../types';

export type CreateWorkspaceInvitePayload = {
  email: string;
  roleKey: string;
};

export type CreateWorkspaceInviteResult = {
  id: string;
  workspaceId: string;
  email: string;
  roleKey: string;
  status: 'pending';
  expiresAt: string;
  token: string;
};

export type CreateWorkspaceInviteDependencies = {
  dbClient?: typeof db;
  authzClient?: AuthzClient;
  idFactory?: () => string;
  tokenFactory?: () => InviteTokenPair;
  now?: () => Date;
  expiresInDays?: number;
};

export function createCreateWorkspaceInviteHandler({
  dbClient = db,
  authzClient,
  idFactory = randomUUID,
  tokenFactory = () => generateInviteToken(32),
  now = () => new Date(),
  expiresInDays = 7,
}: CreateWorkspaceInviteDependencies = {}) {
  return async (
    payload: CreateWorkspaceInvitePayload,
    ctx: ActionContext,
  ): Promise<CreateWorkspaceInviteResult> => {
    if (!ctx.workspaceId) {
      throw new DomainError('Missing workspaceId in action context', 'MISSING_CONTEXT', 400);
    }
    if (!ctx.userId) {
      throw new DomainError('Missing userId in auth context', 'UNAUTHORIZED', 401);
    }

    const resolvedAuthzClient = authzClient ?? createAuthzClient();
    const allowed = await resolvedAuthzClient.checkPermission({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      actionKey: 'accounts.invites.create',
    });
    if (!allowed) {
      throw new DomainError('Access denied', 'FORBIDDEN', 403);
    }

    const inviteId = idFactory();
    const { token, tokenHash } = tokenFactory();

    const emailNormalized = payload.email.trim().toLowerCase();
    const expiresAt = new Date(now().getTime() + expiresInDays * 24 * 60 * 60 * 1000);

    await dbClient.insert(workspaceInvites).values({
      id: inviteId,
      workspaceId: ctx.workspaceId,
      email: emailNormalized,
      roleKey: payload.roleKey,
      invitedBy: ctx.userId,
      token: tokenHash,
      status: 'pending',
      expiresAt,
    });

    return {
      id: inviteId,
      workspaceId: ctx.workspaceId,
      email: emailNormalized,
      roleKey: payload.roleKey,
      status: 'pending',
      expiresAt: expiresAt.toISOString(),
      token,
    };
  };
}

export const createWorkspaceInviteHandler = createCreateWorkspaceInviteHandler();
