export class SoloForgeError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly context: Record<string, unknown>;
  public readonly isRetryable: boolean;

  constructor(options: {
    code: string;
    message: string;
    statusCode?: number;
    context?: Record<string, unknown>;
    isRetryable?: boolean;
    cause?: Error;
  }) {
    super(options.message, { cause: options.cause });
    this.name = this.constructor.name;
    this.code = options.code;
    this.statusCode = options.statusCode ?? 500;
    this.context = options.context ?? {};
    this.isRetryable = options.isRetryable ?? false;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      context: this.context,
      isRetryable: this.isRetryable,
    };
  }
}
