/**
 * SEC-INTERNAL-AUTH-2: Internal Service Authentication Middleware
 *
 * This middleware authenticates internal service-to-service calls.
 * It supports both JWT-based auth (preferred) and legacy static token (transitional).
 *
 * Security considerations:
 * - Token values are NEVER logged
 * - Uses timing-safe comparison for both JWT and legacy tokens
 * - JWT tokens include audience validation to prevent cross-service attacks
 */

import type { Context, Next } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createErrorResponse } from '@xynes/envelope';
import { logger } from '../infra/logger';
import { generateRequestId } from '../infra/http/request-id';
import { verifyInternalJwt, looksLikeJwt, type ServiceKey } from '../infra/security/internal-jwt';

/**
 * Expected service key for this service.
 * Used as the audience claim in JWT verification.
 */
const SERVICE_KEY: ServiceKey = 'accounts-service';

/**
 * Timing-safe token comparison for legacy static tokens.
 */
function tokensMatch(provided: string, expected: string): boolean {
  const key = Buffer.from(expected);
  const providedDigest = createHmac('sha256', key).update(provided).digest();
  const expectedDigest = createHmac('sha256', key).update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * Get the internal auth mode from environment.
 * - 'hybrid': Accept both JWT and legacy token (transitional)
 * - 'jwt': Require JWT only (production target)
 */
function getAuthMode(): 'hybrid' | 'jwt' {
  const mode = process.env.INTERNAL_AUTH_MODE;
  return mode === 'jwt' ? 'jwt' : 'hybrid';
}

export function requireInternalServiceAuth() {
  return async (c: Context, next: Next) => {
    const requestId = c.get('requestId') || generateRequestId();
    c.set('requestId', requestId);

    const jwtSigningKey = process.env.INTERNAL_JWT_SIGNING_KEY;
    const legacyToken = process.env.INTERNAL_SERVICE_TOKEN;
    const authMode = getAuthMode();

    // Mode-specific configuration validation (fail fast on misconfiguration)
    if (authMode === 'jwt' && !jwtSigningKey) {
      logger.error(
        '[InternalAuth] Misconfigured: INTERNAL_AUTH_MODE=jwt but INTERNAL_JWT_SIGNING_KEY is not set',
        {
          requestId,
          path: c.req.path,
          method: c.req.method,
        },
      );
      return c.json(
        createErrorResponse('INTERNAL_ERROR', 'Internal auth misconfigured', requestId),
        500,
      );
    }

    if (authMode === 'hybrid' && !jwtSigningKey && !legacyToken) {
      logger.error('[InternalAuth] Misconfigured: No signing key or token set', {
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
      logger.warn('[InternalAuth] Rejected: missing token header', {
        requestId,
        path: c.req.path,
        method: c.req.method,
      });
      return c.json(
        createErrorResponse('UNAUTHORIZED', 'Missing internal auth token', requestId),
        401,
      );
    }

    // Try JWT verification first if signing key is configured
    if (jwtSigningKey && looksLikeJwt(provided)) {
      const result = verifyInternalJwt(provided, jwtSigningKey, {
        expectedAudience: SERVICE_KEY,
      });

      if (result.valid) {
        // Set request ID from JWT payload for correlation
        if (result.payload?.requestId) {
          c.set('requestId', result.payload.requestId);
        }
        return next();
      }

      // Log verification failure without token value
      logger.warn('[InternalAuth] JWT verification failed', {
        requestId,
        path: c.req.path,
        method: c.req.method,
        reason: result.error,
      });

      // In jwt-only mode, reject immediately
      if (authMode === 'jwt') {
        return c.json(
          createErrorResponse('FORBIDDEN', 'Invalid internal auth token', requestId),
          403,
        );
      }
      // In hybrid mode, fall through to legacy token check
    }

    // Legacy token verification (hybrid mode only)
    if (authMode === 'hybrid' && legacyToken && tokensMatch(provided, legacyToken)) {
      return next();
    }

    // All verification methods failed
    logger.warn('[InternalAuth] Rejected: invalid token', {
      requestId,
      path: c.req.path,
      method: c.req.method,
      authMode,
    });
    return c.json(createErrorResponse('FORBIDDEN', 'Invalid internal auth token', requestId), 403);
  };
}
