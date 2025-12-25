import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DomainError } from '@xynes/errors';

import { db } from '../../../infra/db';
import { workspaceMembers, workspaces } from '../../../infra/db/schema';
import { createAuthzClient, type AuthzClient } from '../../../infra/authz/authzClient';
import type { ActionContext } from '../../types';

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
    await dbClient.transaction(async (tx) => {
      const existing = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.slug, payload.slug))
        .limit(1);

      if (existing[0]) {
        throw new DomainError('Workspace slug already exists', 'CONFLICT', 409);
      }

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

    try {
      await resolvedAuthzClient.assignRole({
        userId: ctx.userId,
        workspaceId,
        roleKey: 'workspace_owner',
      });
    } catch {
      try {
        await dbClient.transaction(async (tx) => {
          await tx.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId));
          await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));
        });
      } catch {
        // Best-effort cleanup only.
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
