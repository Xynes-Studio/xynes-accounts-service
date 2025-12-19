import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config';
import * as schema from './schema';

const client = postgres(config.server.DATABASE_URL, {
  max: process.env.NODE_ENV === 'test' ? 1 : 10,
  prepare: false,
  connect_timeout: 2,
  idle_timeout: 2,
  onnotice: () => {},
});

export const db = drizzle(client, { schema });
