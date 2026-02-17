import { and, eq } from 'drizzle-orm';
import { DomainError } from '@xynes/errors';
import { db } from '../../../infra/db';
import { workspaceMembers, workspaces } from '../../../infra/db/schema';
import { createAuthzClient, type AuthzClient } from '../../../infra/authz/authzClient';
import type { ActionContext } from '../../types';
import { resolveWorkspaceRoleForUser, type WorkspaceRole } from './resolveWorkspaceRole';

export type ListWorkspacesForUserResult = {
  workspaces: Array<{
    id: string;
    name: string;
    slug: string | null;
    planType: string;
    role: WorkspaceRole;
  }>;
};

export type ListWorkspacesForUserDependencies = {
  dbClient?: typeof db;
  authzClient?: AuthzClient;
};

export function createListWorkspacesForUserHandler({
  dbClient = db,
  authzClient,
}: ListWorkspacesForUserDependencies = {}) {
  return async (_payload: unknown, ctx: ActionContext): Promise<ListWorkspacesForUserResult> => {
    void _payload;

    if (!ctx.userId) {
      throw new DomainError('Missing userId in auth context', 'UNAUTHORIZED', 401);
    }

    const rows = await dbClient
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        planType: workspaces.planType,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(and(eq(workspaceMembers.userId, ctx.userId), eq(workspaceMembers.status, 'active')));

    if (rows.length === 0) {
      return { workspaces: [] };
    }

    const resolvedAuthzClient = authzClient ?? createAuthzClient();
    const workspacesWithRoles = await Promise.all(
      rows.map(async (workspace) => {
        const role = await resolveWorkspaceRoleForUser(
          resolvedAuthzClient,
          workspace.id,
          ctx.userId as string,
        );
        return {
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug ?? null,
          planType: workspace.planType,
          role,
        };
      }),
    );

    return {
      workspaces: workspacesWithRoles,
    };
  };
}

export const listWorkspacesForUserHandler = createListWorkspacesForUserHandler();
