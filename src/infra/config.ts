import { createEnv } from '@xynes/config';
import { name } from '../../package.json';

export const config = createEnv({
  server: {
    PORT: process.env.PORT || '4203',
    DATABASE_URL: process.env.DATABASE_URL || 'postgres://localhost:5432/xynes_accounts',
    NODE_ENV: process.env.NODE_ENV || 'development',
    MAX_JSON_BODY_BYTES: process.env.MAX_JSON_BODY_BYTES || '1048576',
  },
  client: {},
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
  serviceName: name,
});
