import { Context } from 'hono';
import { DomainError } from '@xynes/errors';
import { createErrorResponse, ApiErrorDetails } from '@xynes/envelope';
import { logger } from '../infra/logger';
import { generateRequestId } from '../infra/http/request-id';

export const errorHandler = async (err: Error, c: Context) => {
  const requestId = c.get('requestId') || generateRequestId();

  if (err instanceof DomainError) {
    logger.warn(`DomainError: ${err.message}`, { code: err.code, requestId });

    return c.json(
      createErrorResponse(
        err.code,
        err.message,
        requestId,
        err.details ? (err.details as ApiErrorDetails) : undefined,
      ),
      (err.statusCode || 400) as any,
    );
  }

  logger.error(`Unhandled Error: ${err.message}`, { requestId, error: err });
  return c.json(createErrorResponse('INTERNAL_ERROR', 'Internal server error', requestId), 500);
};
