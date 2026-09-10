import { SoloForgeError } from './base-error';

export class ConstitutionError extends SoloForgeError {
  constructor(code: string, message: string, context?: Record<string, unknown>) {
    super({ code, message, statusCode: 503, context, isRetryable: false });
  }
}
