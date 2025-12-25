import { eq } from 'drizzle-orm';
import { DomainError } from '@xynes/errors';
import { db } from '../../infra/db';
import { users } from '../../infra/db/schema';
import { NotFoundError } from '../errors';
import type { ActionContext } from '../types';

export type ReadSelfUserDependencies = {
  dbClient?: typeof db;
};

export function createReadSelfUserHandler({ dbClient = db }: ReadSelfUserDependencies = {}) {
  return async (_payload: unknown, ctx: ActionContext) => {
    void _payload;
    if (!ctx.userId) {
      throw new DomainError('Missing userId in auth context', 'UNAUTHORIZED', 401);
    }
    const row = await dbClient.select().from(users).where(eq(users.id, ctx.userId)).limit(1);
    const user = row[0];
    if (!user) {
      throw new NotFoundError('user', ctx.userId);
    }
    return user;
  };
}

export const readSelfUserHandler = createReadSelfUserHandler();
