import { and, eq } from 'drizzle-orm';
import { db } from '../../infra/db';
import { workspaceMembers } from '../../infra/db/schema';
import type { ActionContext } from '../types';

export type EnsureWorkspaceMemberPayload = {
  role?: 'member' | 'admin';
};

export type EnsureWorkspaceMemberDependencies = {
  dbClient?: typeof db;
};

export function createEnsureWorkspaceMemberHandler({
  dbClient = db,
}: EnsureWorkspaceMemberDependencies = {}) {
  return async (payload: EnsureWorkspaceMemberPayload, ctx: ActionContext) => {
    const existing = await dbClient
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, ctx.workspaceId),
          eq(workspaceMembers.userId, ctx.userId),
        ),
      )
      .limit(1);

    if (existing[0]) {
      return { created: false, status: existing[0].status };
    }

    // Role is accepted but currently mapped to status only; kept for forward-compat.
    const status = payload.role === 'admin' ? 'active' : 'active';
    await dbClient.insert(workspaceMembers).values({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      status,
    });

    return { created: true, status };
  };
}

export const ensureWorkspaceMemberHandler = createEnsureWorkspaceMemberHandler();
