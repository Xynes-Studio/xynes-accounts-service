import postgres from 'postgres';

export type PostgresClientFactory = typeof postgres;

export interface PostgresReadinessCheckOptions {
  databaseUrl: string;
  schemaName?: string;
  clientFactory?: PostgresClientFactory;
}

export async function checkPostgresReadiness({
  databaseUrl,
  schemaName,
  clientFactory,
}: PostgresReadinessCheckOptions): Promise<void> {
  const sql = (clientFactory ?? postgres)(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 2,
    idle_timeout: 2,
    onnotice: () => {},
  });

  try {
    if (schemaName) {
      const result = await sql`SELECT 1 FROM pg_namespace WHERE nspname = ${schemaName}`;
      if (result.length === 0) {
        throw new Error(`Schema '${schemaName}' does not exist`);
      }
    } else {
      await sql`SELECT 1`;
    }
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}
