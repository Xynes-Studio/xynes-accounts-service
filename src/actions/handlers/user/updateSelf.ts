import { eq } from 'drizzle-orm';
import { DomainError } from '@xynes/errors';

import { db } from '../../../infra/db';
import { users } from '../../../infra/db/schema';
import { NotFoundError } from '../../errors';
import type { ActionContext } from '../../types';

export type UpdateSelfPayload = {
  displayName: string;
};

export type UpdateSelfResult = {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
};

export type UpdateSelfDependencies = {
  dbClient?: typeof db;
};

export function createUpdateSelfHandler({ dbClient = db }: UpdateSelfDependencies = {}) {
  return async (payload: UpdateSelfPayload, ctx: ActionContext): Promise<UpdateSelfResult> => {
    if (!ctx.userId) {
      throw new DomainError('Missing userId in auth context', 'UNAUTHORIZED', 401);
    }

    const displayName = payload.displayName.trim();
    if (!displayName) {
      throw new DomainError('displayName is required', 'VALIDATION_ERROR', 400);
    }
    if (displayName.length > 200) {
      throw new DomainError('displayName must be at most 200 characters', 'VALIDATION_ERROR', 400);
    }

    const rows = await dbClient
      .update(users)
      .set({ displayName })
      .where(eq(users.id, ctx.userId))
      .returning({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      });

    const user = rows[0];
    if (!user) {
      throw new NotFoundError('user', ctx.userId);
    }

    return user;
  };
}

export const updateSelfHandler = createUpdateSelfHandler();
