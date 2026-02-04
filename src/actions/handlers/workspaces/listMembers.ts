import { eq } from 'drizzle-orm';
import { DomainError } from '@xynes/errors';
import { db } from '../../../infra/db';
import { users, workspaceMembers } from '../../../infra/db/schema';
import { createAuthzClient, type AuthzClient } from '../../../infra/authz/authzClient';
import type { ActionContext } from '../../types';

export type ListWorkspaceMembersResult = {
  members: Array<{
    userId: string;
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
    status: string;
    joinedAt: string;
    roleKey: string;
  }>;
};

export type ListWorkspaceMembersDependencies = {
  dbClient?: typeof db;
  authzClient?: AuthzClient;
};

const DEFAULT_ROLE = 'workspace_member';
const OWNER_ROLE = 'workspace_owner';

export function createListWorkspaceMembersHandler({
  dbClient = db,
  authzClient,
}: ListWorkspaceMembersDependencies = {}) {
  return async (_payload: unknown, ctx: ActionContext): Promise<ListWorkspaceMembersResult> => {
    void _payload;

    if (!ctx.userId) {
      throw new DomainError('Missing userId in auth context', 'UNAUTHORIZED', 401);
    }
    if (!ctx.workspaceId) {
      throw new DomainError('Missing workspaceId in action context', 'MISSING_CONTEXT', 400);
    }

    const resolvedAuthzClient = authzClient ?? createAuthzClient();

    const allowed = await resolvedAuthzClient.checkPermission({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      actionKey: 'accounts.workspace_members.listForWorkspace',
    });

    if (!allowed) {
      throw new DomainError(
        'You do not have permission to list workspace members',
        'FORBIDDEN',
        403,
      );
    }

    const rows = await dbClient
      .select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        status: workspaceMembers.status,
        joinedAt: workspaceMembers.joinedAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(eq(workspaceMembers.workspaceId, ctx.workspaceId));

    const userIds = rows.map((row) => row.userId);
    const roleAssignments = await resolvedAuthzClient.listRolesForWorkspace({
      workspaceId: ctx.workspaceId,
      userIds,
    });

    const rolesByUser = new Map<string, string[]>();
    for (const assignment of roleAssignments) {
      const list = rolesByUser.get(assignment.userId) ?? [];
      list.push(assignment.roleKey);
      rolesByUser.set(assignment.userId, list);
    }

    const resolveRole = (userId: string) => {
      const roles = rolesByUser.get(userId) ?? [];
      if (roles.includes(OWNER_ROLE)) return OWNER_ROLE;
      return roles[0] ?? DEFAULT_ROLE;
    };

    return {
      members: rows.map((row) => ({
        userId: row.userId,
        email: row.email,
        displayName: row.displayName ?? null,
        avatarUrl: row.avatarUrl ?? null,
        status: row.status,
        joinedAt: row.joinedAt.toISOString(),
        roleKey: resolveRole(row.userId),
      })),
    };
  };
}

export const listWorkspaceMembersHandler = createListWorkspaceMembersHandler();
