export interface DomainErrorOptions {
  cause?: unknown;
  details?: unknown;
}

export class DomainError extends Error {
  public statusCode: number;
  public code: string;
  public details?: unknown;
  public override readonly cause?: unknown;

  constructor(
    message: string,
    code: string = 'DOMAIN_ERROR',
    statusCode: number = 400,
    options: DomainErrorOptions = {},
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = options.details;
    this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
