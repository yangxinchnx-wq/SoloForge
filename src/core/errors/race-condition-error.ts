import { SoloForgeError } from './base-error';

export class RaceConditionError extends SoloForgeError {
  constructor(code: string, message: string, context?: Record<string, unknown>) {
    super({ code, message, statusCode: 409, context, isRetryable: true });
  }
}
