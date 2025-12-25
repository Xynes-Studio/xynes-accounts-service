import { and, eq } from 'drizzle-orm';
import { DomainError } from '@xynes/errors';

import { db } from '../../../infra/db';
import { users, workspaceInvites, workspaceMembers } from '../../../infra/db/schema';
import { createAuthzClient, type AuthzClient } from '../../../infra/authz/authzClient';
import { hashInviteToken } from '../../../infra/security/inviteToken';
import { NotFoundError } from '../../errors';
import type { ActionContext } from '../../types';

export type AcceptWorkspaceInvitePayload = {
  token: string;
};

export type AcceptWorkspaceInviteResult = {
  accepted: true;
  workspaceId: string;
  roleKey: string;
  workspaceMemberCreated: boolean;
};

export type AcceptWorkspaceInviteDependencies = {
  dbClient?: typeof db;
  authzClient?: AuthzClient;
  now?: () => Date;
};

export function createAcceptWorkspaceInviteHandler({
  dbClient = db,
  authzClient,
  now = () => new Date(),
}: AcceptWorkspaceInviteDependencies = {}) {
  return async (
    payload: AcceptWorkspaceInvitePayload,
    ctx: ActionContext,
  ): Promise<AcceptWorkspaceInviteResult> => {
    if (!ctx.userId) {
      throw new DomainError('Missing userId in auth context', 'UNAUTHORIZED', 401);
    }
    const resolvedAuthzClient = authzClient ?? createAuthzClient();

    const tokenHash = hashInviteToken(payload.token);

    const inviteRows = await dbClient
      .select({
        id: workspaceInvites.id,
        workspaceId: workspaceInvites.workspaceId,
        email: workspaceInvites.email,
        roleKey: workspaceInvites.roleKey,
        status: workspaceInvites.status,
        expiresAt: workspaceInvites.expiresAt,
      })
      .from(workspaceInvites)
      .where(eq(workspaceInvites.token, tokenHash))
      .limit(1);

    const invite = inviteRows[0];
    if (!invite) {
      throw new DomainError('Workspace invite not found', 'NOT_FOUND', 404);
    }

    const nowDate = now();
    if (invite.status === 'pending' && invite.expiresAt.getTime() <= nowDate.getTime()) {
      await dbClient
        .update(workspaceInvites)
        .set({ status: 'expired' })
        .where(and(eq(workspaceInvites.id, invite.id), eq(workspaceInvites.status, 'pending')));
      throw new DomainError('Invite expired', 'GONE', 410);
    }

    if (invite.status === 'cancelled') {
      throw new DomainError('Invite cancelled', 'GONE', 410);
    }

    if (invite.status !== 'pending') {
      throw new DomainError('Invite is not pending', 'CONFLICT', 409);
    }

    const userRows = await dbClient
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1);
    const user = userRows[0];
    if (!user) {
      throw new NotFoundError('user', ctx.userId);
    }

    const inviteEmail = invite.email.trim().toLowerCase();
    const userEmail = user.email.trim().toLowerCase();
    if (inviteEmail !== userEmail) {
      throw new DomainError('Invite email does not match authenticated user', 'FORBIDDEN', 403);
    }

    // Ensure workspace member exists (track whether we created it to support cleanup on authz failure).
    const existingMember = await dbClient
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, invite.workspaceId),
          eq(workspaceMembers.userId, ctx.userId),
        ),
      )
      .limit(1);

    const workspaceMemberCreated = existingMember.length === 0;
    if (workspaceMemberCreated) {
      await dbClient.insert(workspaceMembers).values({
        workspaceId: invite.workspaceId,
        userId: ctx.userId,
        status: 'active',
      });
    }

    // Mark invite as accepted (race-safe)
    const updated = await dbClient
      .update(workspaceInvites)
      .set({ status: 'accepted' })
      .where(and(eq(workspaceInvites.id, invite.id), eq(workspaceInvites.status, 'pending')))
      .returning({ id: workspaceInvites.id });

    if (updated.length === 0) {
      throw new DomainError('Invite already processed', 'CONFLICT', 409);
    }

    try {
      await resolvedAuthzClient.assignRole({
        userId: ctx.userId,
        workspaceId: invite.workspaceId,
        roleKey: invite.roleKey,
      });
    } catch {
      // Best-effort cleanup to avoid granting membership without RBAC.
      try {
        await dbClient
          .update(workspaceInvites)
          .set({ status: 'pending' })
          .where(eq(workspaceInvites.id, invite.id));
      } catch {
        // ignore
      }

      if (workspaceMemberCreated) {
        try {
          await dbClient
            .delete(workspaceMembers)
            .where(
              and(
                eq(workspaceMembers.workspaceId, invite.workspaceId),
                eq(workspaceMembers.userId, ctx.userId),
              ),
            );
        } catch {
          // ignore
        }
      }

      throw new DomainError('Failed to assign role via authz service', 'BAD_GATEWAY', 502);
    }

    return {
      accepted: true,
      workspaceId: invite.workspaceId,
      roleKey: invite.roleKey,
      workspaceMemberCreated,
    };
  };
}

export const acceptWorkspaceInviteHandler = createAcceptWorkspaceInviteHandler();
