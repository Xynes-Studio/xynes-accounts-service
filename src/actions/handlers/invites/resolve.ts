import { and, eq } from 'drizzle-orm';
import { DomainError } from '@xynes/errors';

import { db } from '../../../infra/db';
import { users, workspaceInvites, workspaces } from '../../../infra/db/schema';
import { hashInviteToken } from '../../../infra/security/inviteToken';
import type { ActionContext } from '../../types';

export type ResolveWorkspaceInvitePayload = {
  token: string;
};

export type ResolveWorkspaceInviteResult = {
  id: string;
  workspaceId: string;
  workspaceSlug: string | null;
  workspaceName: string;
  inviterName: string | null;
  inviterEmail: string | null;
  inviteeEmail: string;
  role: string;
  roleKey: string;
  status: string;
  expiresAt: string;
  createdAt: string;
};

export type ResolveWorkspaceInviteDependencies = {
  dbClient?: typeof db;
  now?: () => Date;
};

export function createResolveWorkspaceInviteHandler({
  dbClient = db,
  now = () => new Date(),
}: ResolveWorkspaceInviteDependencies = {}) {
  return async (
    payload: ResolveWorkspaceInvitePayload,
    _ctx: ActionContext,
  ): Promise<ResolveWorkspaceInviteResult> => {
    void _ctx;
    const tokenHash = hashInviteToken(payload.token);

    const rows = await dbClient
      .select({
        id: workspaceInvites.id,
        workspaceId: workspaceInvites.workspaceId,
        workspaceSlug: workspaces.slug,
        workspaceName: workspaces.name,
        inviterName: users.displayName,
        inviterEmail: users.email,
        inviteeEmail: workspaceInvites.email,
        roleKey: workspaceInvites.roleKey,
        status: workspaceInvites.status,
        expiresAt: workspaceInvites.expiresAt,
        createdAt: workspaceInvites.createdAt,
        inviteId: workspaceInvites.id,
      })
      .from(workspaceInvites)
      .innerJoin(workspaces, eq(workspaceInvites.workspaceId, workspaces.id))
      .leftJoin(users, eq(workspaceInvites.invitedBy, users.id))
      .where(eq(workspaceInvites.token, tokenHash))
      .limit(1);

    const invite = rows[0];
    if (!invite) {
      throw new DomainError('Workspace invite not found', 'NOT_FOUND', 404);
    }

    let status = invite.status;
    const nowDate = now();
    if (status === 'pending' && invite.expiresAt.getTime() <= nowDate.getTime()) {
      status = 'expired';
      try {
        await dbClient
          .update(workspaceInvites)
          .set({ status: 'expired' })
          .where(
            and(eq(workspaceInvites.id, invite.inviteId), eq(workspaceInvites.status, 'pending')),
          );
      } catch {
        // best-effort; don't leak DB errors through a public endpoint
      }
    }

    if (typeof invite.workspaceName !== 'string' || invite.workspaceName.length === 0) {
      throw new DomainError('Invalid workspace invite state', 'INTERNAL_ERROR', 500);
    }

    return {
      id: invite.id,
      workspaceId: invite.workspaceId,
      workspaceSlug: invite.workspaceSlug ?? null,
      workspaceName: invite.workspaceName,
      inviterName: invite.inviterName ?? null,
      inviterEmail: invite.inviterEmail ?? null,
      inviteeEmail: invite.inviteeEmail,
      role: invite.roleKey,
      roleKey: invite.roleKey,
      status,
      expiresAt: invite.expiresAt.toISOString(),
      createdAt: invite.createdAt.toISOString(),
    };
  };
}

export const resolveWorkspaceInviteHandler = createResolveWorkspaceInviteHandler();
