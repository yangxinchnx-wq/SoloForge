import { SoloForgeError } from './base-error';

export class LlmError extends SoloForgeError {
  public readonly provider?: string;
  public readonly model?: string;

  constructor(options: {
    code?: string;
    message: string;
    statusCode?: number;
    provider?: string;
    model?: string;
    context?: Record<string, unknown>;
    isRetryable?: boolean;
    cause?: Error;
  }) {
    super({
      code: options.code ?? 'ERR_SF_7001',
      message: options.message,
      statusCode: options.statusCode ?? 502,
      context: { ...options.context, provider: options.provider, model: options.model },
      isRetryable: options.isRetryable,
      cause: options.cause,
    });
    this.provider = options.provider;
    this.model = options.model;
  }
}
