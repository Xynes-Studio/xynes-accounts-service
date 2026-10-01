import type { Context, Next } from 'hono';
import {
  internalRequestOperation,
  loadInternalRequestTrust,
  readInternalRequestBody,
  verifyInternalRequest,
} from '../infra/security/internal-request';
import { createErrorResponse } from '@xynes/envelope';
import { generateRequestId } from '../infra/http/request-id';
import { config } from '../infra/config';

export function requireInternalServiceAuth() {
  return async (c: Context, next: Next) => {
    const requestId = c.req.header('X-Request-Id') || generateRequestId();
    const token = c.req.header('X-Internal-Service-Token');
    if (!token)
      return c.json(
        createErrorResponse('UNAUTHORIZED', 'Missing internal auth token', requestId),
        401,
      );

    let trust: ReturnType<typeof loadInternalRequestTrust>;
    try {
      trust = loadInternalRequestTrust();
    } catch {
      return c.json(
        createErrorResponse('INTERNAL_ERROR', 'Internal auth misconfigured', requestId),
        500,
      );
    }
    let body: Uint8Array;
    try {
      body = await readInternalRequestBody(
        c.req.raw,
        Number.parseInt(config.server.MAX_JSON_BODY_BYTES, 10) || 1048576,
      );
    } catch {
      return c.json(
        createErrorResponse('PAYLOAD_TOO_LARGE', 'Request body too large', requestId),
        413,
      );
    }
    const operation = internalRequestOperation('accounts-service', c.req.path, body);
    if (!operation) {
      try {
        JSON.parse(Buffer.from(body).toString('utf8'));
      } catch {
        return c.json(
          createErrorResponse('INVALID_JSON', 'Invalid JSON request body', requestId),
          400,
        );
      }
      return c.json(
        createErrorResponse('VALIDATION_ERROR', 'Invalid request body', requestId),
        400,
      );
    }
    if (
      !verifyInternalRequest(
        token,
        {
          audience: 'accounts-service',
          operation,
          url: c.req.url,
          method: c.req.method,
          headers: c.req.raw.headers,
          body,
        },
        trust,
      )
    ) {
      return c.json(
        createErrorResponse('FORBIDDEN', 'Invalid internal request identity or context', requestId),
        403,
      );
    }
    c.set('requestId', c.req.header('X-Request-Id'));
    // Reuse only the bounded, verified bytes in the existing route parser.
    c.req.raw = new Request(c.req.raw, { body: Buffer.from(body), duplex: 'half' });
    return next();
  };
}
