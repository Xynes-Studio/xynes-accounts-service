import { and, eq } from 'drizzle-orm';
import { DomainError } from '@xynes/errors';
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
    if (!ctx.workspaceId) {
      throw new DomainError('Missing workspaceId in action context', 'MISSING_CONTEXT', 400);
    }
    if (!ctx.userId) {
      throw new DomainError('Missing userId in auth context', 'UNAUTHORIZED', 401);
    }

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

    // Role is accepted but currently ignored; reserved for forward-compat.
    void payload;
    const status = 'active' as const;
    await dbClient.insert(workspaceMembers).values({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      status,
    });

    return { created: true, status };
  };
}

export const ensureWorkspaceMemberHandler = createEnsureWorkspaceMemberHandler();
