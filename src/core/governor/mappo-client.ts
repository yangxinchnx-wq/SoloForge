// ─────────────────────────────────────────────────────────────────
// SoloForge Core Layer: MAPPO Resource Governor Heuristic Client
// Path: src/core/governor/mappo-client.ts
//
// 历史背景:
//   此文件早期曾尝试通过 IPCClient 连 python/marl_service/server.py 的 18765
//   端口做 MAPPO 推理,但实际生产路径上:
//     1) server.py / server_prod.py 监听的是 8765(JSON 行分隔,非 MessagePack)
//     2) 18765 端口从未有 Python 进程监听,IPCClient 连上必超时
//     3) 即使连上,8765 的真实使用方是 shadow-governor-client / training-scheduler
//
//   现已删除:
//     - python/marl_service/ipc/ (IPCServer / MsgPackProtocol / IPCConnection)
//     - python/marl_service/server_optimized.py
//     - src/core/governor/ipc/ (IPCClient)
//
//   本文件简化为纯启发式兜底客户端:
//     - 保留原有公开 API (evaluateMappoResourceVector / evaluateBatch / ...)
//       以兼容已有集成测试 (mappo-ipc.test.ts / system-backbone.test.ts)
//     - 永远走 heuristicFallback,等价于"删除前 useFallback=true"的行为
// ─────────────────────────────────────────────────────────────────

/**
 * 启发式兜底决策映射缓存
 */
interface CacheEntry {
  action: number;
  timestamp: number;
}

interface BatchRequest {
  globalState: number[];
  localObs: number[];
  resolve: (action: number) => void;
  reject: (err: Error) => void;
}

/**
 * MAPPO 资源控流启发式客户端(纯本地,无 IPC)
 *
 * 提供与历史版本兼容的接口,内部统一走 heuristicFallback:
 *   - CPU > 0.95 → 2 (熔断)
 *   - CPU > 0.70 → 1 (降级)
 *   - 其他      → 0 (放行)
 *
 * 历史命名: GeminiMappoResourceGovernorClient (2026-07-02 重命名 → MappoHeuristicGovernor)
 */
export class MappoHeuristicGovernor {
  // ============================================
  // 缓存层(保留以维持外部行为一致)
  // ============================================
  private cache: Map<string, CacheEntry> = new Map();
  private cacheMaxAge: number = 1000; // 缓存有效期 1 秒
  private cacheMaxSize: number = 1000;

  // ============================================
  // 批处理(单进程内同步,纯函数式映射,无 IPC)
  // ============================================
  private batchQueue: BatchRequest[] = [];
  private batchTimeout: number = 5; // 5ms 攒批窗口
  private batchTimer: NodeJS.Timeout | null = null;
  private isProcessingBatch: boolean = false;

  constructor() {
    // 历史上在构造时启动 Python 子进程 + IPC 连接
    // 现已移除:18765 端口从无 Python 监听,启动即失败
  }

  /**
   * 缓存 key: globalState|localObs
   */
  private getCacheKey(globalState: number[], localObs: number[]): string {
    const stateStr = globalState.map(v => v.toFixed(3)).join(',');
    const obsStr = localObs.map(v => v.toFixed(3)).join(',');
    return `${stateStr}|${obsStr}`;
  }

  private getFromCache(key: string): number | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.cacheMaxAge) {
      this.cache.delete(key);
      return null;
    }
    return entry.action;
  }

  private setCache(key: string, action: number): void {
    if (this.cache.size >= this.cacheMaxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { action, timestamp: Date.now() });
  }

  /**
   * 启发式兜底决策(CPU 三档)
   */
  private heuristicFallback(globalState: number[]): number {
    const currentCpu = globalState[0] || 0;
    if (currentCpu > 0.95) return 2;
    if (currentCpu > 0.70) return 1;
    return 0;
  }

  /**
   * 单条评估入口(兼容旧 API)
   */
  public async evaluateMappoResourceVector(
    globalState: number[],
    localObs: number[]
  ): Promise<number> {
    const cacheKey = this.getCacheKey(globalState, localObs);
    const cachedAction = this.getFromCache(cacheKey);
    if (cachedAction !== null) {
      return cachedAction;
    }

    return new Promise<number>((resolve, reject) => {
      this.batchQueue.push({ globalState, localObs, resolve, reject });

      if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => this.processBatch(), this.batchTimeout);
      }

      if (this.batchQueue.length >= 10) {
        if (this.batchTimer) clearTimeout(this.batchTimer);
        this.processBatch();
      }
    }).then((action: number) => {
      this.setCache(cacheKey, action);
      return action;
    });
  }

  /**
   * 批处理:同进程内同步派发,等价于"批 IPC 响应"的语义
   */
  private async processBatch(): Promise<void> {
    if (this.isProcessingBatch || this.batchQueue.length === 0) return;
    this.isProcessingBatch = true;

    const batch = [...this.batchQueue];
    this.batchQueue = [];

    try {
      batch.forEach(req => {
        req.resolve(this.heuristicFallback(req.globalState));
      });
    } finally {
      this.isProcessingBatch = false;

      if (this.batchQueue.length > 0) {
        this.batchTimer = setTimeout(() => this.processBatch(), this.batchTimeout);
      }
    }
  }

  /**
   * 批量评估入口(兼容旧 API)
   */
  public async evaluateBatch(
    requests: Array<{ globalState: number[]; localObs: number[] }>
  ): Promise<number[]> {
    return Promise.all(
      requests.map(req => this.evaluateMappoResourceVector(req.globalState, req.localObs))
    );
  }

  /**
   * 缓存统计(兼容旧 API)
   */
  public getCacheStats(): { size: number; maxSize: number; hitRate: number } {
    return {
      size: this.cache.size,
      maxSize: this.cacheMaxSize,
      hitRate: 0,
    };
  }

  /**
   * 优雅关闭(兼容旧 API;现版本无外部资源,直接清理缓存和定时器)
   */
  public safelyTerminateGovernorContext(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.batchQueue = [];
    this.cache.clear();
  }
}