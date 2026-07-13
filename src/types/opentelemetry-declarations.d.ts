/**
 * OpenTelemetry Type Declarations (Graceful Degradation)
 *
 * otel-init.ts uses dynamic import() for @opentelemetry/* packages,
 * which may not be installed in all environments.
 * These declarations allow tsc --noEmit to pass without requiring
 * the actual @opentelemetry packages to be present.
 *
 * Install real types when OTEL is enabled:
 *   npm install -D @opentelemetry/sdk-node @opentelemetry/api @opentelemetry/resources
 *   npm install -D @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-logs-otlp-http
 *   npm install -D @opentelemetry/sdk-trace-node @opentelemetry/sdk-logs
 */

declare module '@opentelemetry/sdk-node' {
  export class NodeSDK {
    constructor(config: any);
    start(): void;
    shutdown(): Promise<void>;
  }
}

declare module '@opentelemetry/resources' {
  export class Resource {
    constructor(attributes: Record<string, string>);
  }
}

declare module '@opentelemetry/api' {
  // Minimal API surface — only what's statically referenced
}

declare module '@opentelemetry/exporter-trace-otlp-http' {
  export class OTLPTraceExporter {
    constructor(opts?: { url?: string });
  }
}

declare module '@opentelemetry/exporter-logs-otlp-http' {
  export class OTLPLogExporter {
    constructor(opts?: { url?: string });
  }
}

declare module '@opentelemetry/sdk-trace-node' {
  export class ConsoleSpanExporter {}
  export class SimpleSpanProcessor {
    constructor(exporter: any);
  }
}

declare module '@opentelemetry/sdk-logs' {
  export class ConsoleLogRecordExporter {}
}
