import { eq } from 'drizzle-orm';
import { DomainError } from '@xynes/errors';
import { db } from '../../infra/db';
import { workspaces } from '../../infra/db/schema';
import { NotFoundError } from '../errors';
import type { ActionContext } from '../types';

export type ReadCurrentWorkspaceDependencies = {
  dbClient?: typeof db;
};

export function createReadCurrentWorkspaceHandler({
  dbClient = db,
}: ReadCurrentWorkspaceDependencies = {}) {
  return async (_payload: unknown, ctx: ActionContext) => {
    void _payload;

    if (!ctx.workspaceId) {
      throw new DomainError('Missing workspaceId in action context', 'MISSING_CONTEXT', 400);
    }

    const row = await dbClient
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .limit(1);
    const workspace = row[0];
    if (!workspace) {
      throw new NotFoundError('workspace', ctx.workspaceId);
    }
    return workspace;
  };
}

export const readCurrentWorkspaceHandler = createReadCurrentWorkspaceHandler();
