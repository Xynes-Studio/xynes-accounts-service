import { Context } from 'hono';
import { DomainError } from '@xynes/errors';
import { createErrorResponse, ApiErrorDetails } from '@xynes/envelope';
import { logger } from '../infra/logger';
import { generateRequestId } from '../infra/http/request-id';

function toErrorLogObject(value: unknown) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return { value };
  }

  const err = value as any;

  return {
    name: typeof err.name === 'string' ? err.name : undefined,
    message: typeof err.message === 'string' ? err.message : undefined,
    stack: typeof err.stack === 'string' ? err.stack : undefined,
    // drizzle-orm error fields
    query: typeof err.query === 'string' ? err.query : undefined,
    params: Array.isArray(err.params) ? err.params : undefined,
    // postgres-js error fields (when available)
    code: typeof err.code === 'string' ? err.code : undefined,
    detail: typeof err.detail === 'string' ? err.detail : undefined,
    schema: typeof err.schema === 'string' ? err.schema : undefined,
    table: typeof err.table === 'string' ? err.table : undefined,
    constraint: typeof err.constraint === 'string' ? err.constraint : undefined,
    routine: typeof err.routine === 'string' ? err.routine : undefined,
  };
}

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

  const anyErr = err as any;
  const cause = anyErr?.cause ?? anyErr?.originalError ?? undefined;

  logger.error(`Unhandled Error: ${err.message}`, {
    requestId,
    error: toErrorLogObject(err),
    cause: cause ? toErrorLogObject(cause) : undefined,
  });
  return c.json(createErrorResponse('INTERNAL_ERROR', 'Internal server error', requestId), 500);
};
