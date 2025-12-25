import { and, eq } from 'drizzle-orm';
import { DomainError } from '@xynes/errors';
import { z } from 'zod';
import { db } from '../../infra/db';
import { users, workspaceMembers, workspaces } from '../../infra/db/schema';
import type { ActionContext } from '../types';

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
  }>;
};

export type MeGetOrCreateDependencies = {
  dbClient?: typeof db;
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

export function createMeGetOrCreateHandler({ dbClient = db }: MeGetOrCreateDependencies = {}) {
  return async (_payload: unknown, ctx: ActionContext): Promise<MeGetOrCreateResult> => {
    void _payload;

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

    return {
      user: {
        id: userRow.id,
        email: userRow.email,
        displayName: userRow.displayName ?? null,
        avatarUrl: userRow.avatarUrl ?? null,
      },
      workspaces: workspaceRows.map((w) => ({
        id: w.id,
        name: w.name,
        slug: w.slug ?? null,
        planType: w.planType,
      })),
    };
  };
}

export const meGetOrCreateHandler = createMeGetOrCreateHandler();
