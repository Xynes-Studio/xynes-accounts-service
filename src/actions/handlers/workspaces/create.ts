import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DomainError } from '@xynes/errors';

import { db } from '../../../infra/db';
import { logger } from '../../../infra/logger';
import { workspaceMembers, workspaces } from '../../../infra/db/schema';
import { createAuthzClient, type AuthzClient } from '../../../infra/authz/authzClient';
import type { ActionContext } from '../../types';

function isUniqueViolationForConstraints(err: unknown, constraintNames: string[]): boolean {
  const e = err as { code?: unknown; constraint_name?: unknown };
  return (
    e?.code === '23505' &&
    typeof e.constraint_name === 'string' &&
    constraintNames.includes(e.constraint_name)
  );
}

export type CreateWorkspacePayload = {
  name: string;
  slug: string;
};

export type CreateWorkspaceResult = {
  id: string;
  name: string;
  slug: string;
  planType: string;
  createdBy: string;
};

export type CreateWorkspaceDependencies = {
  dbClient?: typeof db;
  authzClient?: AuthzClient;
  idFactory?: () => string;
};

export function createCreateWorkspaceHandler({
  dbClient = db,
  authzClient,
  idFactory = randomUUID,
}: CreateWorkspaceDependencies = {}) {
  return async (
    payload: CreateWorkspacePayload,
    ctx: ActionContext,
  ): Promise<CreateWorkspaceResult> => {
    const workspaceId = idFactory();

    const resolvedAuthzClient = authzClient ?? createAuthzClient();

    // Insert DB state first (short transaction), then assign role.
    // If role assignment fails, rollback with best-effort cleanup.
    try {
      await dbClient.transaction(async (tx) => {
        await tx.insert(workspaces).values({
          id: workspaceId,
          name: payload.name,
          slug: payload.slug,
          createdBy: ctx.userId,
        });

        await tx.insert(workspaceMembers).values({
          workspaceId,
          userId: ctx.userId,
          status: 'active',
        });
      });
    } catch (err) {
      if (err instanceof DomainError) throw err;

      if (
        isUniqueViolationForConstraints(err, [
          'workspaces_slug_unique',
          'workspaces_slug_unique_idx',
        ])
      ) {
        throw new DomainError('Workspace slug already exists', 'CONFLICT', 409);
      }

      throw err;
    }

    try {
      await resolvedAuthzClient.assignRole({
        userId: ctx.userId,
        workspaceId,
        roleKey: 'workspace_owner',
      });
    } catch {
      logger.error('[WorkspacesCreate] Failed to assign workspace_owner role', {
        requestId: ctx.requestId,
        workspaceId,
        userId: ctx.userId,
      });

      try {
        await dbClient.transaction(async (tx) => {
          await tx.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId));
          await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));
        });
      } catch (cleanupErr) {
        logger.error('[WorkspacesCreate] Cleanup failed after authz role assignment failure', {
          requestId: ctx.requestId,
          workspaceId,
          userId: ctx.userId,
          error: cleanupErr,
        });
      }

      throw new DomainError('Failed to assign workspace_owner role', 'BAD_GATEWAY', 502);
    }

    return {
      id: workspaceId,
      name: payload.name,
      slug: payload.slug,
      planType: 'free',
      createdBy: ctx.userId,
    };
  };
}

export const createWorkspaceHandler = createCreateWorkspaceHandler();
