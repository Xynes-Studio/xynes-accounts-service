import { DomainError } from '@xynes/errors';

export class PayloadTooLargeError extends DomainError {
  constructor(maxBytes: number) {
    super(`Request body too large (max ${maxBytes} bytes)`, 'PAYLOAD_TOO_LARGE', 413, {
      details: { maxBytes },
    });
  }
}

export class InvalidJsonBodyError extends DomainError {
  constructor() {
    super('Invalid JSON request body', 'INVALID_JSON', 400);
  }
}
