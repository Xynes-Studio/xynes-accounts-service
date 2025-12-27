import { Context } from 'hono';
import { config } from '../infra/config';

/**
 * Health check controller - indicates service is alive.
 * Does NOT check database connectivity (use /ready for that).
 */
export const getHealth = (c: Context) => {
  return c.json({ status: 'ok', service: config.serviceName });
};
