import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { DomainError } from '@xynes/errors';

import { db } from '../../../infra/db';
import { users, workspaceInvites, workspaceMembers } from '../../../infra/db/schema';
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

    const emailNormalized = payload.email.trim().toLowerCase();

    // BUG-AUTH-8: SELF_INVITE guard.
    // Reject when the invited address matches the authenticated user's own
    // email. Prefer the JWT-derived email on `ctx.user.email` (set by the
    // gateway from the access-token claims), and fall back to a single
    // identity.users lookup when the gateway did not propagate the email —
    // this keeps the guard reliable even if a future upstream change drops
    // the optional `user` field. Both comparisons are trim+lowercase so the
    // guard mirrors the same normalization the invite row uses.
    const ctxEmailNormalized = ctx.user?.email?.trim().toLowerCase() ?? '';
    let actorEmail = ctxEmailNormalized;
    if (!actorEmail) {
      const actorRows = await dbClient
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, ctx.userId))
        .limit(1);
      actorEmail = actorRows[0]?.email?.trim().toLowerCase() ?? '';
    }
    if (actorEmail && actorEmail === emailNormalized) {
      throw new DomainError('Cannot invite yourself to this workspace', 'SELF_INVITE', 400);
    }

    // BUG-AUTH-8: ALREADY_MEMBER guard.
    // Reject when the invited address already has an active membership in
    // this workspace. Resolved by joining identity.users on the normalized
    // email to platform.workspace_members. The query intentionally returns
    // at most one row and never leaks the existing member's userId outside
    // this handler.
    //
    // Case-insensitive comparison: `identity.users.email` is stored as
    // received from the Supabase JWT (`userEmailSchema` in `meGetOrCreate`
    // trims + validates but does NOT lowercase), so a row like
    // `User@Example.com` could otherwise bypass this guard when the inviter
    // submits `user@example.com`. Push the lowercasing down to Postgres
    // with `lower(users.email)` so the equality holds regardless of how the
    // user's email was originally cased in the JWT. The right-hand side is
    // already `.trim().toLowerCase()`-normalized above.
    //
    // Note: there is no `lower(users.email)` functional index today, so this
    // query does a sequential scan over identity.users. Acceptable at MVP
    // scale (a single workspace's member set is small); a follow-up can add
    // `CREATE INDEX users_email_lower_idx ON identity.users (lower(email))`
    // when the workspace count or member count grows.
    const memberRows = await dbClient
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(
        and(
          eq(workspaceMembers.workspaceId, ctx.workspaceId),
          eq(workspaceMembers.status, 'active'),
          eq(sql<string>`lower(${users.email})`, emailNormalized),
        ),
      )
      .limit(1);
    if (memberRows.length > 0) {
      throw new DomainError('This person is already a workspace member', 'ALREADY_MEMBER', 400);
    }

    const inviteId = idFactory();
    const { token, tokenHash } = tokenFactory();

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
