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
  workspaceName: string;
  inviterName: string | null;
  roleKey: string;
  status: string;
  expiresAt: string;
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
        workspaceName: workspaces.name,
        inviterName: users.displayName,
        roleKey: workspaceInvites.roleKey,
        status: workspaceInvites.status,
        expiresAt: workspaceInvites.expiresAt,
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
      workspaceName: invite.workspaceName,
      inviterName: invite.inviterName ?? null,
      roleKey: invite.roleKey,
      status,
      expiresAt: invite.expiresAt.toISOString(),
    };
  };
}

export const resolveWorkspaceInviteHandler = createResolveWorkspaceInviteHandler();
