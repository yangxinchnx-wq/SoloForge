import { SoloForgeError } from './base-error';

export class OptimisticLockError extends SoloForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super({ code: 'ERR_SF_3001', message, statusCode: 409, context, isRetryable: true });
  }
}
