import { DomainError } from '@xynes/errors';

export class UnknownActionError extends DomainError {
  constructor(actionKey: string) {
    super(`Unknown action: ${actionKey}`, 'UNKNOWN_ACTION', 400);
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id: string) {
    super(`${resource} not found with id ${id}`, 'NOT_FOUND', 404);
  }
}
