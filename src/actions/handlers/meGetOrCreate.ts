import { and, eq } from 'drizzle-orm';
import { DomainError } from '@xynes/errors';
import { z } from 'zod';
import { db } from '../../infra/db';
import { users, workspaceMembers, workspaces } from '../../infra/db/schema';
import { createAuthzClient, type AuthzClient } from '../../infra/authz/authzClient';
import type { ActionContext } from '../types';
import { resolveWorkspaceRoleForUser, type WorkspaceRole } from './workspaces/resolveWorkspaceRole';

export type MeGetOrCreateResult = {
  user: {
    id: string;
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  workspaces: Array<{
    id: string;
    name: string;
    slug: string | null;
    planType: string;
    role: WorkspaceRole;
  }>;
};

export type MeGetOrCreateDependencies = {
  dbClient?: typeof db;
  authzClient?: AuthzClient;
};

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

function normalizeOptionalStringWithMaxLen(value: unknown, maxLen: number): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return undefined;
  if (normalized.length > maxLen) return undefined;
  return normalized;
}

const userEmailSchema = z.string().trim().email().max(320);

export function createMeGetOrCreateHandler({
  dbClient = db,
  authzClient,
}: MeGetOrCreateDependencies = {}) {
  return async (_payload: unknown, ctx: ActionContext): Promise<MeGetOrCreateResult> => {
    void _payload;

    if (!ctx.userId) {
      throw new DomainError('Missing userId in auth context', 'UNAUTHORIZED', 401);
    }

    const emailResult = userEmailSchema.safeParse(ctx.user?.email);
    if (!emailResult.success) {
      throw new DomainError('Missing or invalid user email in auth context', 'UNAUTHORIZED', 401);
    }
    const email = emailResult.data;

    const displayName = normalizeOptionalStringWithMaxLen(ctx.user?.name, 200);
    const avatarUrl = normalizeOptionalStringWithMaxLen(ctx.user?.avatarUrl, 2048);

    const insertValues: typeof users.$inferInsert = {
      id: ctx.userId,
      email,
      displayName: displayName ?? undefined,
      avatarUrl: avatarUrl ?? undefined,
    };

    const updateSet: Record<string, unknown> = { email };
    if (displayName) updateSet.displayName = displayName;
    if (avatarUrl) updateSet.avatarUrl = avatarUrl;

    await dbClient.insert(users).values(insertValues).onConflictDoUpdate({
      target: users.id,
      set: updateSet,
    });

    const userRows = await dbClient
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1);

    const userRow = userRows[0];
    if (!userRow) {
      throw new DomainError('Failed to load user after upsert', 'INTERNAL_ERROR', 500);
    }

    const workspaceRows = await dbClient
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        planType: workspaces.planType,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(and(eq(workspaceMembers.userId, ctx.userId), eq(workspaceMembers.status, 'active')));

    let workspacesWithRoles: MeGetOrCreateResult['workspaces'] = [];
    if (workspaceRows.length > 0) {
      const resolvedAuthzClient = authzClient ?? createAuthzClient();
      workspacesWithRoles = await Promise.all(
        workspaceRows.map(async (workspace) => {
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
    }

    return {
      user: {
        id: userRow.id,
        email: userRow.email,
        displayName: userRow.displayName ?? null,
        avatarUrl: userRow.avatarUrl ?? null,
      },
      workspaces: workspacesWithRoles,
    };
  };
}

export const meGetOrCreateHandler = createMeGetOrCreateHandler();
