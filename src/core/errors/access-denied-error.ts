import { SoloForgeError } from './base-error';

export class AccessDeniedError extends SoloForgeError {
  constructor(message: string = 'Access denied', context?: Record<string, unknown>) {
    super({ code: 'ERR_SF_6003', message, statusCode: 403, context, isRetryable: false });
  }
}
