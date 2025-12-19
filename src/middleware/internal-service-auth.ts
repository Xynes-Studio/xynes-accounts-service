import type { Context, Next } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createErrorResponse } from '@xynes/envelope';
import { logger } from '../infra/logger';
import { generateRequestId } from '../infra/http/request-id';

function tokensMatch(provided: string, expected: string): boolean {
  const key = Buffer.from(expected);
  const providedDigest = createHmac('sha256', key).update(provided).digest();
  const expectedDigest = createHmac('sha256', key).update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export function requireInternalServiceAuth() {
  return async (c: Context, next: Next) => {
    const requestId = c.get('requestId') || generateRequestId();
    c.set('requestId', requestId);

    const expected = process.env.INTERNAL_SERVICE_TOKEN;
    if (!expected) {
      logger.error('[InternalAuth] Misconfigured: INTERNAL_SERVICE_TOKEN is not set', {
        requestId,
        path: c.req.path,
        method: c.req.method,
      });
      return c.json(
        createErrorResponse('INTERNAL_ERROR', 'Internal auth misconfigured', requestId),
        500,
      );
    }

    const provided = c.req.header('X-Internal-Service-Token');
    if (!provided) {
      logger.warn('[InternalAuth] Rejected: missing X-Internal-Service-Token', {
        requestId,
        path: c.req.path,
        method: c.req.method,
      });
      return c.json(
        createErrorResponse('UNAUTHORIZED', 'Missing internal auth token', requestId),
        401,
      );
    }

    if (!tokensMatch(provided, expected)) {
      logger.warn('[InternalAuth] Rejected: invalid X-Internal-Service-Token', {
        requestId,
        path: c.req.path,
        method: c.req.method,
      });
      return c.json(
        createErrorResponse('FORBIDDEN', 'Invalid internal auth token', requestId),
        403,
      );
    }

    return next();
  };
}
