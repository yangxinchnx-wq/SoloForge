// ─────────────────────────────────────────────────────────────────
// SoloForge Observability: Distributed Tracing Utility
// Path: src/observability/tracing.ts
//
// Phase 4: 为关键操作链路提供 Span 创建工具
//
// 关键 Span 命名约定 (来自 OPENTELEMETRY_PLAN.md):
//   soloforge.agent.decision       — Agent 决策
//   soloforge.court.adjudication   — 法庭裁决
//   soloforge.governance.intervention — 治理干预
//   soloforge.llm.stream           — LLM 流式请求
//   soloforge.raft.consensus       — Raft 共识
// ─────────────────────────────────────────────────────────────────

/**
 * Span 属性接口
 */
export interface SpanAttributes {
  [key: string]: string | number | boolean;
}

/**
 * OTel tracer 缓存（延迟加载，避免循环依赖）
 */
let cachedTracer: unknown = null;
let tracerReady = false;

/**
 * 获取 OTel Tracer（延迟加载）
 * 如果 @opentelemetry/api 不可用，返回 null
 */
async function getTracer(): Promise<unknown | null> {
  if (tracerReady) return cachedTracer;

  try {
    const { trace } = await import('@opentelemetry/api');
    cachedTracer = trace.getTracer('soloforge-core');
    tracerReady = true;
    return cachedTracer;
  } catch {
    tracerReady = true;
    return null;
  }
}

/**
 * Span 结果包装
 */
interface SpanResult<T> {
  result: T;
  spanId?: string;
  traceId?: string;
}

/**
 * 在 Span 中执行一个异步函数
 *
 * 用法:
 *   const result = await withSpan(
 *     'soloforge.agent.decision',
 *     async (span) => {
 *       span.setAttribute('agent.id', agentId);
 *       return await processDecision(payload);
 *     },
 *     { 'agent.id': agentId, 'decision.type': 'racer' }
 * );
 *
 * @param name Span 名称（遵循 soloforge.xxx.yyy 约定）
 * @param fn 要在 Span 中执行的函数，接收一个 SpanHandle 用于设置属性
 * @param attributes 初始 Span 属性
 */
export async function withSpan<T>(
  name: string,
  fn: (span: SpanHandle) => Promise<T>,
  attributes?: SpanAttributes,
): Promise<T> {
  const tracer = await getTracer();
  if (!tracer) {
    // OTel 不可用 — 直接执行，不创建 Span
    return fn(noopSpan);
  }

  const { SpanStatusCode } = await import('@opentelemetry/api');
  const realTracer = tracer as {
    startActiveSpan: (
      name: string,
      options: Record<string, unknown>,
      fn: (span: SpanHandle) => Promise<T>,
    ) => Promise<T>;
  };

  return realTracer.startActiveSpan(name, { attributes }, async (span: SpanHandle) => {
    // 设置初始属性
    if (attributes) {
      for (const [k, v] of Object.entries(attributes)) {
        span.setAttribute(k, v);
      }
    }

    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Span 句柄接口
 */
export interface SpanHandle {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  recordException(error: unknown): void;
  end(): void;
}

/**
 * No-op Span（OTel 不可用时使用）
 */
const noopSpan: SpanHandle = {
  setAttribute() {},
  setStatus() {},
  recordException() {},
  end() {},
};

/**
 * 检查 Tracing 是否可用
 */
export async function isTracingAvailable(): Promise<boolean> {
  const tracer = await getTracer();
  return tracer !== null;
}
