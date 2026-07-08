# SoloForge OpenTelemetry 集成方案

**版本**: 1.0.0
**日期**: 2026-07-09
**状态**: 最小可用实现 (MVP)

---

## 1. 当前可观测性状态分析

### 1.1 已有能力

| 支柱 | 状态 | 实现位置 | 说明 |
|------|------|----------|------|
| **Metrics** | 已实现 | `src/observability/metrics.ts` | 自研轻量级 Counter/Gauge/Histogram，兼容 Prometheus text format |
| **Metrics** | 已实现 | `src/kernel/observability/telemetry-exporter.ts` | TelemetryMetricExporter，内核级指标聚合，9090 端口 /metrics 端点 |
| **Metrics** | 已实现 | `src/observability/metrics.ts` → `PrometheusExporter` | 标准 Prometheus 文本导出器 |
| **Traces** | **缺失** | - | 无分布式追踪能力 |
| **Logs** | 部分 | `src/core/logger/index.ts` | 自研日志器，已预留 `traceId` 字段但无 OTel 上下文注入 |
| **Error Tracking** | 已实现 | `src/observability/sentryAdapter.ts` | Sentry HTTP API 适配器（无需 SDK） |
| **白皮书** | 已实现 | `src/observability/governance-whitepaper-exporter.ts` | 演化治理审计报告导出 |

### 1.2 关键差距

1. **无分布式追踪**: 跨模块调用链无法追踪，难以定位性能瓶颈
2. **日志与追踪脱节**: `SoloForgeLogger` 已有 `traceId` 字段，但未与任何追踪上下文关联
3. **指标体系碎片化**: `src/observability/metrics.ts` 和 `TelemetryMetricExporter` 是两套独立系统

### 1.3 现有指标体系兼容性分析

- `src/observability/metrics.ts`: 自研 `MetricsRegistry` + `PrometheusExporter`，用于 LLM 流式代理和 HTTP 请求指标
- `TelemetryMetricExporter`: 内核级指标，记录治理/社会/共识等业务指标
- 两者**互不冲突**，OpenTelemetry 集成**不替换**任何一方

---

## 2. OpenTelemetry 三支柱集成方案

### 2.1 总体架构

```
┌─────────────────────────────────────────────────────────┐
│                    SoloForge Process                     │
│                                                          │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  Traces   │  │   Metrics    │  │      Logs         │  │
│  │  (新增)   │  │  (复用现有)  │  │    (渐进式)       │  │
│  └────┬─────┘  └──────┬───────┘  └────────┬──────────┘  │
│       │               │                    │             │
│  ┌────▼─────┐  ┌──────▼───────┐  ┌────────▼──────────┐  │
│  │ Console  │  │  Prometheus  │  │    Console        │  │
│  │ Span     │  │  (现有9090)  │  │    Log            │  │
│  │ Exporter │  │  + OTel桥接  │  │    Exporter       │  │
│  └──────────┘  └──────────────┘  └───────────────────┘  │
│       │               │                    │             │
└───────┼───────────────┼────────────────────┼─────────────┘
        ▼               ▼                    ▼
   stdout/OTLP     Prometheus          stdout/OTLP
   (开发环境)      Scrape端点          (开发环境)
```

### 2.2 Traces（分布式追踪）— 优先级 P0

**目标**: 为关键操作链路建立端到端追踪

**方案**:
- 使用 `@opentelemetry/sdk-trace-node` 初始化 NodeTracerProvider
- 默认使用 `ConsoleSpanExporter`（stdout 输出，零外部依赖）
- 可通过环境变量 `OTEL_EXPORTER_OTLP_ENDPOINT` 切换为 OTLP 导出
- 自动注入 W3C TraceContext 传播头

**关键 Span 命名约定**:
```
soloforge.kernel.boot          // 内核启动
soloforge.agent.decision       // Agent 决策
soloforge.court.adjudication   // 法庭裁决
soloforge.governance.intervention // 治理干预
soloforge.llm.stream           // LLM 流式请求
soloforge.raft.consensus       // Raft 共识
```

**与现有 Logger 集成**:
- `SoloForgeLogger.formatLog()` 已读取 `(global as any).__CURRENT_TRACE_ID`
- OpenTelemetry SDK 激活后，通过 `context.active()` 自动注入 traceId/spanId
- 在 `otel-init.ts` 中注册 `ContextManager`，使 logger 自动获取当前 trace 上下文

### 2.3 Metrics（指标）— 复用现有，渐进桥接

**目标**: 不破坏现有指标体系，通过 OTel API 桥接

**方案**:
- **Phase 1（当前）**: 不替换现有 `MetricsRegistry` 和 `TelemetryMetricExporter`
- **Phase 2（后续）**: 创建 `OTelMetricBridge`，将 OTel MeterProvider 的指标桥接到现有 Prometheus 端点
- 现有 9090 端口 `/metrics` 端点**保持不变**

**兼容性保证**:
- `TelemetryMetricExporter` 继续独立运行
- `src/observability/metrics.ts` 中的 `defaultRegistry` 继续独立运行
- OTel metrics 作为**增量补充**，不替代任何现有系统

### 2.4 Logs（结构化日志）— 渐进式

**目标**: 将现有 `SoloForgeLogger` 与 OTel Logs SDK 集成

**方案**:
- Phase 1（当前）: 仅初始化 `LoggerProvider` + `ConsoleLogRecordExporter`
- Phase 2（后续）: 创建 `OTelLoggerBridge`，将 `SoloForgeLogger` 的输出同时发送到 OTel Logs Pipeline
- 自动注入 `traceId` 和 `spanId`，实现日志-追踪关联

---

## 3. npm 依赖列表

### 3.1 核心依赖（必须）

```json
{
  "@opentelemetry/api": "^1.9.0",
  "@opentelemetry/sdk-node": "^0.57.0",
  "@opentelemetry/sdk-trace-node": "^1.30.0",
  "@opentelemetry/sdk-trace-base": "^1.30.0",
  "@opentelemetry/sdk-metrics": "^1.30.0",
  "@opentelemetry/sdk-logs": "^0.57.0",
  "@opentelemetry/resources": "^1.30.0",
  "@opentelemetry/semantic-conventions": "^1.28.0"
}
```

### 3.2 可选依赖（按需）

```json
{
  "@opentelemetry/exporter-trace-otlp-http": "^0.57.0",
  "@opentelemetry/exporter-logs-otlp-http": "^0.57.0",
  "@opentelemetry/exporter-metrics-otlp-http": "^0.57.0"
}
```

### 3.3 安装命令

```bash
# 核心（必须）
npm install @opentelemetry/api @opentelemetry/sdk-node \
  @opentelemetry/sdk-trace-node @opentelemetry/sdk-trace-base \
  @opentelemetry/sdk-metrics @opentelemetry/sdk-logs \
  @opentelemetry/resources @opentelemetry/semantic-conventions

# 可选：OTLP 导出器（需要外部 Collector）
npm install @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-logs-otlp-http \
  @opentelemetry/exporter-metrics-otlp-http
```

---

## 4. 配置代码示例

### 4.1 环境变量配置

```bash
# 服务标识
OTEL_SERVICE_NAME=soloforge
OTEL_SERVICE_VERSION=1.0.0

# Traces 导出器（默认 console，可选 otlp）
OTEL_TRACES_EXPORTER=console
# OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# Logs 导出器（默认 console）
OTEL_LOGS_EXPORTER=console

# Metrics（保持现有 Prometheus 端点，OTel metrics 暂不导出）
OTEL_METRICS_EXPORTER=none

# 采样率（开发环境 100%，生产环境建议 0.1）
OTEL_TRACES_SAMPLER=parentbased_always_on
# OTEL_TRACES_SAMPLER_ARG=0.1
```

### 4.2 初始化代码

见 `src/observability/otel-init.ts`

### 4.3 使用示例

```typescript
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('soloforge-core');

// 在关键操作中创建 Span
async function handleAgentDecision(agentId: string, payload: any) {
  return tracer.startActiveSpan('soloforge.agent.decision', (span) => {
    span.setAttribute('agent.id', agentId);
    span.setAttribute('decision.type', payload.type);
    try {
      const result = processDecision(payload);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}
```

---

## 5. 实施路线图

### Phase 1: 最小可用实现（当前）
- [x] 创建 `otel-init.ts`，初始化 OTel SDK
- [x] Console Span Exporter（stdout 输出 traces）
- [x] Logger Provider 初始化（Console）
- [x] 在 `src/index.ts` 中调用 `initOpenTelemetry()`
- [ ] 安装 npm 依赖

### Phase 2: Logger 桥接
- [ ] 修改 `SoloForgeLogger`，自动注入 OTel traceId/spanId
- [ ] 创建 `OTelLoggerBridge`，将日志同时发送到 OTel Logs Pipeline

### Phase 3: Metrics 桥接
- [ ] 创建 `OTelMetricBridge`，将 OTel Meter 指标桥接到现有 Prometheus 端点
- [ ] 统一 `MetricsRegistry` 和 OTel MeterProvider

### Phase 4: 生产化
- [ ] 配置 OTLP Exporter（对接 Jaeger/Grafana Tempo）
- [ ] 配置采样策略（生产环境 10% 采样）
- [ ] 添加关键操作的 Span（Agent 决策、法庭裁决、治理干预等）

---

## 6. 风险评估

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| 依赖冲突 | 低 | OTel 包独立，不与现有依赖冲突 |
| 性能影响 | 低 | Console exporter 开销极小；生产环境可配置采样率 |
| 现有系统破坏 | 无 | 纯增量添加，不修改任何现有文件（除 index.ts 入口） |
| 内存泄漏 | 低 | SDK 内置 span 生命周期管理，graceful shutdown 时 flush |

---

*文档生成: SoloForge OpenTelemetry Integration Plan v1.0.0*
