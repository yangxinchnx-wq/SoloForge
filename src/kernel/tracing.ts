// ─────────────────────────────────────────────────────────────────
// SoloForge Kernel Layer: Distributed Tracing Manager
// Path: src/kernel/tracing.ts
// ─────────────────────────────────────────────────────────────────

import { kernel } from './runtime-kernel';
import { ComponentRegistry } from './registry';
import { PressureLevel } from './backpressure';
import { RuntimeEvent } from '../core/events/runtime-events';
import { logger } from '../core/logger';
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
  private static instance: TracingManager;

  private readonly MAX_STORED_SPANS = 2000;
  private activeSpans: Map<string, SystemSpan> = new Map();
  private completedSpans: (SystemSpan | null)[] = new Array(2000).fill(null);
  private writeIndex = 0;

  public static getInstance(): TracingManager {
    if (!TracingManager.instance) {
      TracingManager.instance = new TracingManager();
    }
    return TracingManager.instance;
  }

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

  public addSpanEvent(spanId: string, eventName: string, attributes?: any): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      span.events.push({ name: eventName, timestamp: Date.now(), attributes });
    }
  }

  public setSpanAttribute(spanId: string, key: string, value: any): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      span.attributes[key] = value;
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

    if (span.status === SpanStatus.ERROR) {
      logger.error('Tracing', `❌ Trace Span 异常断裂: [${span.name}] (Domain: ${span.domain})`, {
        traceId: span.context.traceId,
        error: span.error
      });
    }

    try {
      const bpManager = ComponentRegistry.getInstance().getBackpressureManager();
      const currentPressure = bpManager.getMetrics().pressureLevel;

      if (currentPressure === PressureLevel.CRITICAL) {
        return;
      }

      if (currentPressure === PressureLevel.HIGH && span.status === SpanStatus.OK) {
        if (Math.random() > 0.5) return;
      }

      if (kernel?.eventBus) {
        kernel.eventBus.emit(RuntimeEvent.SpanRecorded, span);
        kernel.eventBus.emit(RuntimeEvent.AuditRecorded, {
          type: 'SPAN_COMPLETED',
          name: span.name,
          domain: span.domain,
          duration: span.endTime - span.startTime,
          context: span.context,
          status: span.status
        });
      }
    } catch (err) {
      // Silently ignore tracing failures
    }
  }

  public injectToRustCarrier(context: SpanContext): string {
    try {
      return JSON.stringify({
        t_id: context.traceId,
        s_id: context.spanId,
        p_id: context.parentSpanId,
        trace_id: context.traceId,
        span_id: context.spanId,
        parent_span_id: context.parentSpanId
      });
    } catch { return ''; }
  }

  public extractFromRustCarrier(carrierStr: string): SpanContext | null {
    if (!carrierStr) return null;
    try {
      const parsed = JSON.parse(carrierStr);
      const traceId = parsed.t_id ?? parsed.trace_id ?? parsed.traceId;
      const spanId = parsed.s_id ?? parsed.span_id ?? parsed.spanId;
      const parentSpanId = parsed.p_id ?? parsed.parent_span_id ?? parsed.parentSpanId;

      if (!traceId || !spanId) return null;

      return { traceId, spanId, parentSpanId };
    } catch {
      return null;
    }
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

  public clear(): void {
    this.activeSpans.clear();
    this.completedSpans.fill(null);
    this.writeIndex = 0;
  }
}
