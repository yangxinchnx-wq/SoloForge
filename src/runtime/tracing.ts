// src/runtime/tracing.ts
import { ulid } from 'ulid';

export enum SpanStatus {
  UNSPECIFIED = 'unspecified',
  OK = 'ok',
  ERROR = 'error'
}

export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

export interface SystemSpan {
  context: SpanContext;
  name: string;
  domain: string;
  startTime: number;
  endTime?: number;
  status: SpanStatus;
  events: Array<{ name: string; timestamp: number; attributes?: any }>;
  attributes: Record<string, any>;
  error?: string;
}

export class TracingManager {
  private readonly MAX_STORED_SPANS = 2000;
  private activeSpans: Map<string, SystemSpan> = new Map();
  private completedSpans: (SystemSpan | null)[] = new Array(2000).fill(null);
  private writeIndex = 0;

  public startSpan(
    name: string,
    domain: string,
    parentContext?: SpanContext | null,
    initialAttributes?: Record<string, any>
  ): SpanContext {
    const traceId = parentContext?.traceId ?? `trc_${ulid()}`;
    const spanId = `spn_${ulid()}`;
    const parentSpanId = parentContext?.spanId;

    const span: SystemSpan = {
      context: { traceId, spanId, parentSpanId },
      name,
      domain,
      startTime: Date.now(),
      status: SpanStatus.UNSPECIFIED,
      events: [],
      attributes: initialAttributes ?? {}
    };

    this.activeSpans.set(spanId, span);
    return { traceId, spanId, parentSpanId };
  }

  public addEvent(spanId: string, eventName: string, attributes?: any): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      span.events.push({ name: eventName, timestamp: Date.now(), attributes });
    }
  }

  public endSpan(spanId: string, status: SpanStatus = SpanStatus.OK, errorException?: any): void {
    const span = this.activeSpans.get(spanId);
    if (!span) return;

    span.endTime = Date.now();
    span.status = status;
    if (errorException) {
      span.status = SpanStatus.ERROR;
      span.error = errorException instanceof Error ? errorException.message : String(errorException);
    }

    this.activeSpans.delete(spanId);

    this.completedSpans[this.writeIndex] = span;
    this.writeIndex = (this.writeIndex + 1) % this.MAX_STORED_SPANS;
  }

  public getTraceTree(traceId: string): SystemSpan[] {
    const tree: SystemSpan[] = [];
    for (let i = 0; i < this.MAX_STORED_SPANS; i++) {
      const s = this.completedSpans[i];
      if (s && s.context.traceId === traceId) {
        tree.push(s);
      }
    }
    return tree;
  }
}
