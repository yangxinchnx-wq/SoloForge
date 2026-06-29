/**
 * perfMonitor.ts — 性能监控（FPS / streaming latency / 慢操作检测）
 *
 * 设计原则（backend-patterns: Logging & Monitoring）：
 *   - 集中所有 perf metric 的收集
 *   - 不直接耦合 console / Sentry / Prometheus
 *   - 通过 listeners 暴露（订阅者自行决定如何上报）
 *
 * 4 类指标：
 *   1. FPS（rAF 帧率）
 *   2. streaming latency（首字节 / 完整 payload）
 *   3. slow query（耗时 > threshold 的操作）
 *   4. memory（performance.memory，Chromium only）
 */

export interface FPSSample {
  fps: number;
  timestamp: number;
}

export interface LatencySample {
  /** 操作名 */
  op: string;
  /** 首字节耗时（ms） */
  ttfb: number;
  /** 总耗时（ms） */
  total: number;
  /** 字节数 */
  bytes?: number;
  timestamp: number;
}

export interface SlowOpSample {
  op: string;
  durationMs: number;
  thresholdMs: number;
  timestamp: number;
}

export interface MemorySample {
  /** 已用 JS heap（MB） */
  usedJSHeapMB: number;
  /** 总 JS heap（MB） */
  totalJSHeapMB?: number;
  timestamp: number;
}

export type PerfSample = FPSSample | LatencySample | SlowOpSample | MemorySample;

type Listener = (sample: PerfSample) => void;
const listeners = new Set<Listener>();

export function onPerfSample(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(sample: PerfSample): void {
  for (const l of listeners) {
    try {
      l(sample);
    } catch {
      /* ignore */
    }
  }
}

// ───────────────────── FPS 监测 ─────────────────────

export class FPSCounter {
  private lastFrameTs = 0;
  private frameCount = 0;
  private rafId: number | null = null;
  private currentFps = 0;
  private onUpdate: (fps: number) => void;

  constructor(onUpdate: (fps: number) => void) {
    this.onUpdate = onUpdate;
  }

  start(): void {
    if (this.rafId !== null) return;
    if (typeof requestAnimationFrame === 'undefined') return; // SSR / Node 安全
    this.lastFrameTs = performance.now();
    this.frameCount = 0;
    const tick = (ts: number) => {
      this.frameCount++;
      const elapsed = ts - this.lastFrameTs;
      if (elapsed >= 1000) {
        this.currentFps = Math.round((this.frameCount * 1000) / elapsed);
        this.onUpdate(this.currentFps);
        emit({ fps: this.currentFps, timestamp: Date.now() });
        this.lastFrameTs = ts;
        this.frameCount = 0;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.rafId !== null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  getFps(): number {
    return this.currentFps;
  }
}

// ───────────────────── Streaming Latency ─────────────────────

export class StreamingLatencyTracker {
  private startTs = 0;
  private firstChunkTs = 0;
  private bytesReceived = 0;
  private opName = '';

  start(opName: string): void {
    this.opName = opName;
    this.startTs = performance.now();
    this.firstChunkTs = 0;
    this.bytesReceived = 0;
  }

  recordChunk(bytes: number): void {
    if (this.firstChunkTs === 0) {
      this.firstChunkTs = performance.now();
    }
    this.bytesReceived += bytes;
  }

  finish(): LatencySample {
    const now = performance.now();
    const sample: LatencySample = {
      op: this.opName,
      ttfb: this.firstChunkTs === 0 ? 0 : this.firstChunkTs - this.startTs,
      total: now - this.startTs,
      bytes: this.bytesReceived,
      timestamp: Date.now(),
    };
    emit(sample);
    return sample;
  }
}

// ───────────────────── Slow Query Detector ─────────────────────

export interface SlowQueryOptions {
  /** 阈值（ms），默认 100 */
  thresholdMs?: number;
  /** 仅 log 还是也 emit（默认仅 emit） */
  alsoLog?: boolean;
}

/**
 * 包装一个异步函数，自动检测慢操作
 *
 * @example
 *   const data = await trackSlow('parseAST', () => parser.parse(raw));
 */
export async function trackSlow<T>(
  opName: string,
  fn: () => Promise<T>,
  options: SlowQueryOptions = {},
): Promise<T> {
  const { thresholdMs = 100, alsoLog = false } = options;
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const durationMs = performance.now() - start;
    if (durationMs >= thresholdMs) {
      const sample: SlowOpSample = { op: opName, durationMs, thresholdMs, timestamp: Date.now() };
      emit(sample);
      if (alsoLog) {
        // eslint-disable-next-line no-console
        console.warn(`[perf] slow op: ${opName} took ${durationMs.toFixed(1)}ms (threshold ${thresholdMs}ms)`);
      }
    }
  }
}

// ───────────────────── Memory ─────────────────────

/**
 * 取当前 JS heap 用量（Chromium-based 浏览器 / Electron）
 * 不支持时返回 null
 */
export function sampleMemory(): MemorySample | null {
  // performance.memory 是非标准 API，仅 Chromium 有
  const perfMem = (performance as any).memory;
  if (!perfMem) return null;
  const sample: MemorySample = {
    usedJSHeapMB: Math.round((perfMem.usedJSHeapSize / 1024 / 1024) * 10) / 10,
    totalJSHeapMB: perfMem.totalJSHeapSize
      ? Math.round((perfMem.totalJSHeapSize / 1024 / 1024) * 10) / 10
      : undefined,
    timestamp: Date.now(),
  };
  emit(sample);
  return sample;
}

// ───────────────────── 全局聚合器 ─────────────────────

export interface PerfSnapshot {
  fps: number;
  /** 最近 1 分钟内平均 streaming latency */
  avgLatencyMs: number;
  /** 最近 1 分钟内慢操作次数 */
  slowOpCount: number;
  /** 最近一次内存采样 */
  memory?: MemorySample;
}

/** 简易聚合器（生产应替换为 Prometheus / Sentry） */
export class PerfAggregator {
  private fpsCounter: FPSCounter | null = null;
  private latencies: number[] = [];
  private slowOps = 0;

  constructor() {
    onPerfSample((sample) => {
      if ('total' in sample) {
        this.latencies.push(sample.total);
        // 只保留最近 100 个
        if (this.latencies.length > 100) this.latencies.shift();
      }
      if ('durationMs' in sample) {
        this.slowOps++;
      }
    });
  }

  startFps(onUpdate: (fps: number) => void): FPSCounter {
    this.fpsCounter = new FPSCounter(onUpdate);
    this.fpsCounter.start();
    return this.fpsCounter;
  }

  snapshot(): PerfSnapshot {
    const avg = this.latencies.length === 0 ? 0 : this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length;
    return {
      fps: this.fpsCounter?.getFps() ?? 0,
      avgLatencyMs: Math.round(avg * 10) / 10,
      slowOpCount: this.slowOps,
      memory: sampleMemory() ?? undefined,
    };
  }

  reset(): void {
    this.latencies = [];
    this.slowOps = 0;
  }
}

// 测试用
export function _resetPerfListeners(): void {
  listeners.clear();
}
