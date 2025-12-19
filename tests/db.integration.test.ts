import { describe, it, expect } from 'bun:test';
import { checkPostgresReadiness } from '../src/infra/readiness';
import { config } from '../src/infra/config';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'Database readiness (integration)',
  () => {
    it('connects and finds identity schema', async () => {
      await expect(
        checkPostgresReadiness({ databaseUrl: config.server.DATABASE_URL, schemaName: 'identity' }),
      ).resolves.toBeUndefined();
    });
  },
);
