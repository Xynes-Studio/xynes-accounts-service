import { and, eq } from 'drizzle-orm';
import { db } from '../../../infra/db';
import { workspaceMembers, workspaces } from '../../../infra/db/schema';
import type { ActionContext } from '../../types';

export type ListWorkspacesForUserResult = {
  workspaces: Array<{
    id: string;
    name: string;
    slug: string | null;
    planType: string;
  }>;
};

export type ListWorkspacesForUserDependencies = {
  dbClient?: typeof db;
};

export function createListWorkspacesForUserHandler({
  dbClient = db,
}: ListWorkspacesForUserDependencies = {}) {
  return async (_payload: unknown, ctx: ActionContext): Promise<ListWorkspacesForUserResult> => {
    void _payload;

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

    return {
      workspaces: rows.map((w) => ({
        id: w.id,
        name: w.name,
        slug: w.slug ?? null,
        planType: w.planType,
      })),
    };
  };
}

export const listWorkspacesForUserHandler = createListWorkspacesForUserHandler();
