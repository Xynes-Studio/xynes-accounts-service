import { Context } from 'hono';
import { config } from '../infra/config';
import { checkPostgresReadiness } from '../infra/readiness';
import { logger } from '../infra/logger';

export type ReadyDependencies = {
  getDatabaseUrl?: () => string;
  check?: typeof checkPostgresReadiness;
  schemaName?: string;
};

/**
 * Creates a ready check handler with injectable dependencies for testing.
 * Checks database connectivity and schema existence.
 */
export function createGetReady({
  getDatabaseUrl = () => config.server.DATABASE_URL,
  check = checkPostgresReadiness,
  schemaName = 'identity',
}: ReadyDependencies = {}) {
  return async (c: Context) => {
    try {
      const databaseUrl = getDatabaseUrl();
      await check({ databaseUrl, schemaName });
      return c.json({ status: 'ready' }, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Readiness check failed:', { error: message });
      return c.json({ status: 'not_ready', error: 'service not ready' }, 503);
    }
  };
}

export const getReady = createGetReady();
