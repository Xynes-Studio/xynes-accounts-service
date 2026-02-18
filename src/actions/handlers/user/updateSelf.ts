import { eq } from 'drizzle-orm';
import { DomainError } from '@xynes/errors';

import { db } from '../../../infra/db';
import { users } from '../../../infra/db/schema';
import { logger } from '../../../infra/logger';
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
  auditLogger?: Pick<typeof logger, 'info'>;
};

const CONTROL_CHAR_REGEX = /[\p{C}]/u;

export function createUpdateSelfHandler({
  dbClient = db,
  auditLogger = logger,
}: UpdateSelfDependencies = {}) {
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
    if (CONTROL_CHAR_REGEX.test(displayName)) {
      throw new DomainError(
        'displayName contains invalid control characters',
        'VALIDATION_ERROR',
        400,
      );
    }

    const existingRows = await dbClient
      .select({
        id: users.id,
        displayName: users.displayName,
      })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1);

    const existingUser = existingRows[0];
    if (!existingUser) {
      throw new NotFoundError('user', ctx.userId);
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

    const changedFields: string[] = [];
    if ((existingUser.displayName ?? null) !== (user.displayName ?? null)) {
      changedFields.push('displayName');
    }

    auditLogger.info('[UserUpdateSelf] Profile update processed', {
      requestId: ctx.requestId,
      userId: ctx.userId,
      changedFields,
      before: {
        displayNamePresent: existingUser.displayName !== null,
        displayNameLength: existingUser.displayName?.length ?? 0,
      },
      after: {
        displayNamePresent: user.displayName !== null,
        displayNameLength: user.displayName?.length ?? 0,
      },
    });

    return user;
  };
}

export const updateSelfHandler = createUpdateSelfHandler();
