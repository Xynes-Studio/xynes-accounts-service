import type { Context, Next } from 'hono';
import { generateRequestId } from '../infra/http/request-id';

export function requestIdMiddleware() {
  return async (c: Context, next: Next) => {
    const existing = c.get('requestId');
    if (!existing) {
      c.set('requestId', generateRequestId());
    }
    return next();
  };
}
