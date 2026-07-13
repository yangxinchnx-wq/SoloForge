// ─────────────────────────────────────────────────────────────────
// SoloForge Core Layer: MAPPO Resource Governor Client
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
//   当前行为:
//     - 尝试通过 net.Socket 连接 127.0.0.1:8765 发送 POLICY_QUERY 做真实推理
//       (与 training-scheduler 使用相同的 MARL 服务和 JSON 行分隔协议)
//     - 连接成功则使用返回的 action;连接失败/超时则 fallback 到 heuristicFallback
//     - 通过 marlAvailable 标记 + 冷却期避免反复探测已下线的服务
//     - 保留原有公开 API (evaluateMappoResourceVector / evaluateBatch / ...)
//       以兼容已有集成测试 (mappo-ipc.test.ts / system-backbone.test.ts)
// ─────────────────────────────────────────────────────────────────

import * as net from 'net';

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
 * MAPPO 资源控流客户端(真实推理 + 启发式兜底)
 *
 * 优先尝试通过 net.Socket 连接 127.0.0.1:8765 的 MARL 服务做真实策略推理;
 * 连接失败/超时时 fallback 到 heuristicFallback:
 *   - CPU > 0.95 → 2 (熔断)
 *   - CPU > 0.70 → 1 (降级)
 *   - 其他      → 0 (放行)
 *
 * 历史命名: GeminiMappoResourceGovernorClient → MappoHeuristicGovernor
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

  // ============================================
  // MARL 服务连接层(127.0.0.1:8765)
  // ============================================
  /** null=未探测, true=可用, false=不可用 */
  private marlAvailable: boolean | null = null;
  private marlLastProbeTime: number = 0;
  /** 服务不可用时的重试冷却期 (ms) */
  private marlProbeCooldown: number = 10_000;
  /** 单次 POLICY_QUERY 超时 (ms) */
  private marlQueryTimeout: number = 1000;
  /** TCP 探测超时 (ms) */
  private marlProbeTimeout: number = 500;

  constructor() {
    // 历史上在构造时启动 Python 子进程 + IPC 连接
    // 现已移除:18765 端口从无 Python 监听,启动即失败
    // 当前版本在首次 processBatch 时探测 8765 端口,按需使用 MARL 服务
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

  // ============================================
  // MARL 服务探测与策略查询
  // ============================================

  /**
   * 快速 TCP 探测 8765 端口是否可达
   * 成功连接即认为 MARL 服务可用
   */
  private probeMarlService(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch (_) { /* noop */ }
        resolve(ok);
      };

      const timer = setTimeout(() => finish(false), this.marlProbeTimeout);

      socket.on('error', () => {
        clearTimeout(timer);
        finish(false);
      });

      socket.connect(8765, '127.0.0.1', () => {
        clearTimeout(timer);
        finish(true);
      });
    });
  }

  /**
   * 向 MARL 服务发送单条 POLICY_QUERY 并等待 POLICY_ANSWER
   * 协议与 training-scheduler.queryTrainedPolicy 一致:
   *   发送: { frameId, type:'POLICY_QUERY', payload:{ observation }, timestamp }\n
   *   接收: { type:'POLICY_ANSWER', payload:{ action, confidence, source } }\n
   *
   * 失败/超时返回 null
   */
  private queryMarlPolicy(observation: number[]): Promise<number | null> {
    return new Promise((resolve) => {
      try {
        const client = new net.Socket();
        let buf = '';
        let done = false;
        const finish = (action: number | null) => {
          if (done) return;
          done = true;
          try { client.destroy(); } catch (_) { /* noop */ }
          resolve(action);
        };

        const timer = setTimeout(() => finish(null), this.marlQueryTimeout);

        client.on('error', () => {
          clearTimeout(timer);
          finish(null);
        });

        client.connect(8765, '127.0.0.1', () => {
          const frame = JSON.stringify({
            frameId: `mappo_q_${Date.now()}`,
            type: 'POLICY_QUERY',
            payload: { observation },
            timestamp: Date.now(),
          }) + '\n';
          client.write(frame);
        });

        client.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf-8');
          const idx = buf.indexOf('\n');
          if (idx >= 0) {
            clearTimeout(timer);
            try {
              const ack = JSON.parse(buf.slice(0, idx).trim());
              if (ack.type === 'POLICY_ANSWER' && ack.payload) {
                const action = typeof ack.payload.action === 'number'
                  ? ack.payload.action
                  : null;
                finish(action);
              } else {
                finish(null);
              }
            } catch {
              finish(null);
            }
          }
        });
      } catch {
        resolve(null);
      }
    });
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
        this.batchTimer = setTimeout(() => {
          this.batchTimer = null;
          this.processBatch();
        }, this.batchTimeout);
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
   * 批处理:优先尝试 MARL 服务真实推理,失败则 fallback 到启发式
   *
   * 流程:
   *   1. 检查 marlAvailable 状态,若未探测或冷却期已过则重新探测 8765
   *   2. 若服务可用,对批中每条请求并行发送 POLICY_QUERY
   *   3. 成功的用真实 action 响应,失败的用 heuristicFallback
   *   4. 若服务不可用,全部走 heuristicFallback
   */
  private async processBatch(): Promise<void> {
    if (this.isProcessingBatch || this.batchQueue.length === 0) return;
    this.isProcessingBatch = true;

    const batch = [...this.batchQueue];
    this.batchQueue = [];

    try {
      // 检查 MARL 服务可用性(带冷却期)
      const now = Date.now();
      const needsProbe =
        this.marlAvailable === null ||
        (!this.marlAvailable && now - this.marlLastProbeTime > this.marlProbeCooldown);

      if (needsProbe) {
        this.marlAvailable = await this.probeMarlService();
        this.marlLastProbeTime = now;
      }

      if (this.marlAvailable) {
        // 并行发送 POLICY_QUERY(每条一个 socket,与 training-scheduler 模式一致)
        const observations = batch.map(req => [...req.globalState, ...req.localObs]);
        const results = await Promise.all(
          observations.map(obs => this.queryMarlPolicy(obs))
        );

        let hasFailure = false;
        batch.forEach((req, i) => {
          if (results[i] !== null) {
            req.resolve(results[i]!);
          } else {
            hasFailure = true;
            req.resolve(this.heuristicFallback(req.globalState));
          }
        });

        // 若有查询失败,标记服务不可用以触发下次重新探测
        if (hasFailure) {
          this.marlAvailable = false;
        }
      } else {
        // MARL 服务不可用,全部走启发式兜底
        batch.forEach(req => {
          req.resolve(this.heuristicFallback(req.globalState));
        });
      }
    } catch (err) {
      // 确保异常路径也能 resolve 所有等待中的 Promise
      batch.forEach(req => {
        try { req.resolve(this.heuristicFallback(req.globalState)); } catch (_) {
          req.reject(err as Error);
        }
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
   * 优雅关闭(兼容旧 API)
   * 清理定时器、批队列、缓存,并重置 MARL 连接状态
   */
  public safelyTerminateGovernorContext(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.batchQueue = [];
    this.cache.clear();
    this.marlAvailable = null;
  }
}