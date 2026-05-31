// ─────────────────────────────────────────────────────────────────
// SoloForge Core Layer: Python MAPPO Governor IPC Client
// Path: src/core/governor/mappo-client.ts
//
// 优化版本: 缓存 + 批量处理 + 模型预热
// ─────────────────────────────────────────────────────────────────

import path from 'path';
import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { IPCClient } from './ipc';

/**
 * 推理缓存条目
 */
interface CacheEntry {
  action: number;
  timestamp: number;
}

/**
 * 批量请求
 */
interface BatchRequest {
  globalState: number[];
  localObs: number[];
  resolve: (action: number) => void;
  reject: (err: Error) => void;
}

/**
 * 🐍 顶置资源控流 Python MAPPO 神经网络 IPC 客户端
 *
 * 优化特性:
 * 1. 推理缓存 - 相同状态向量直接返回缓存结果
 * 2. 批量处理 - 合并多个请求减少 IPC 往返
 * 3. 模型预热 - 启动时发送预热请求加速冷启动
 */
export class GeminiMappoResourceGovernorClient {
  private ipcClient: IPCClient | null = null;
  private pythonProcess: ChildProcess | null = null;
  private useFallback: boolean = true;
  private isWindows: boolean = process.platform === 'win32';

  // ============================================
  // 优化 1: 推理缓存
  // ============================================
  private cache: Map<string, CacheEntry> = new Map();
  private cacheMaxAge: number = 1000; // 缓存有效期 1秒
  private cacheMaxSize: number = 1000; // 最大缓存条目数

  // ============================================
  // 优化 2: 批量处理
  // ============================================
  private batchQueue: BatchRequest[] = [];
  private batchTimeout: number = 5; // 5ms 批次窗口
  private batchTimer: NodeJS.Timeout | null = null;
  private isProcessingBatch: boolean = false;

  // ============================================
  // 优化 3: 预热状态
  // ============================================
  private isWarmedUp: boolean = false;
  private warmupPromises: Promise<void>[] = [];

  constructor() {
    this.bootPythonGovernorContext();
  }

  /**
   * 获取 Python 服务路径
   */
  private getPythonScriptPath(): string | null {
    const baseWorkspace = process.cwd();
    const primaryPath = path.join(baseWorkspace, 'python', 'marl_service', 'server.py');
    if (fs.existsSync(primaryPath)) {
      return primaryPath;
    }
    const legacyPath = path.join(baseWorkspace, 'infra', 'mappo_governor.py');
    if (fs.existsSync(legacyPath)) {
      console.warn(`[MAPPO] ⚠️  使用旧版脚本 [${legacyPath}]`);
      return legacyPath;
    }
    return null;
  }

  /**
   * 点火：启动 Python 服务并建立 IPC 连接
   */
  private async bootPythonGovernorContext(): Promise<void> {
    const scriptPath = this.getPythonScriptPath();

    if (!scriptPath) {
      console.warn(`[MAPPO] ⚠️  未找到 Python MAPPO 服务脚本`);
      console.warn(`[MAPPO] 🔌 使用【本地内存决策桩】`);
      return;
    }

    console.log(`[MAPPO] 🐍 发现 Python 服务: ${scriptPath}`);

    const pythonExecutable = this.isWindows ? 'python' : 'python3';

    this.pythonProcess = spawn(pythonExecutable, [scriptPath], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.pythonProcess.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        if (line) console.log(`[PYTHON] ${line}`);
      }
    });

    this.pythonProcess.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        if (line) console.error(`[PYTHON ERROR] ${line}`);
      }
    });

    this.pythonProcess.on('error', (err) => {
      console.warn(`[MAPPO] ⚠️  无法启动 Python 服务: ${err.message}`);
    });

    this.pythonProcess.on('exit', (code) => {
      console.warn(`[MAPPO] ⚠️  Python 服务退出，code=${code}`);
      this.useFallback = true;
      this.isWarmedUp = false;
    });

    await this.connectToPythonService();
    if (!this.useFallback) {
      await this.warmupModel(); // 模型预热
    }
  }

  /**
   * 连接到 Python IPC 服务
   */
  private async connectToPythonService(): Promise<void> {
    await this.sleep(500);

    try {
      this.ipcClient = new IPCClient({
        autoReconnect: true,
        requestTimeout: 3000,
        connectTimeout: 5000,
      });

      this.ipcClient.onConnected(() => {
        this.useFallback = false;
        console.log('[MAPPO] ✅ MAPPO 神经网络已激活');
      });

      this.ipcClient.onDisconnected(() => {
        this.useFallback = true;
        console.warn('[MAPPO] ⚠️ MAPPO 降级为启发式决策');
      });

      await this.ipcClient.connect();
      this.useFallback = false;
      console.log('[MAPPO] ✅ MAPPO 神经网络已激活');
    } catch (err) {
      console.warn(`[MAPPO] ⚠️ IPC 连接失败: ${(err as Error).message}`);
      console.warn(`[MAPPO] 🔌 使用【本地内存决策桩】`);
      this.useFallback = true;
    }
  }

  /**
   * 优化 3: 模型预热
   * 发送多个典型状态向量，加速冷启动
   */
  private async warmupModel(): Promise<void> {
    if (this.isWarmedUp) return;

    console.log('[MAPPO] 🔥 模型预热中...');

    const warmupStates = [
      [0.1, 0.2, 0.2],  // 正常负载
      [0.5, 0.3, 0.3],  // 中等负载
      [0.8, 0.5, 0.4],  // 高负载
    ];

    // 并发发送预热请求
    const warmupPromises = warmupStates.map(state =>
      this.sendToPython(state, [0, 0]).catch(() => { })
    );

    await Promise.all(warmupPromises);
    this.isWarmedUp = true;
    console.log('[MAPPO] ✅ 模型预热完成');
  }

  /**
   * 优化 1: 生成缓存 key
   */
  private getCacheKey(globalState: number[], localObs: number[]): string {
    const stateStr = globalState.map(v => v.toFixed(3)).join(',');
    const obsStr = localObs.map(v => v.toFixed(3)).join(',');
    return `${stateStr}|${obsStr}`;
  }

  /**
   * 优化 1: 检查缓存
   */
  private getFromCache(key: string): number | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // 检查是否过期
    if (Date.now() - entry.timestamp > this.cacheMaxAge) {
      this.cache.delete(key);
      return null;
    }

    return entry.action;
  }

  /**
   * 优化 1: 设置缓存
   */
  private setCache(key: string, action: number): void {
    // 缓存满了，删除最老的条目
    if (this.cache.size >= this.cacheMaxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      action,
      timestamp: Date.now()
    });
  }

  /**
   * 优化 2: 批量发送请求
   */
  private async processBatch(): Promise<void> {
    if (this.isProcessingBatch || this.batchQueue.length === 0) return;
    if (!this.ipcClient?.isConnected()) return;

    this.isProcessingBatch = true;

    // 取出所有等待的请求
    const batch = [...this.batchQueue];
    this.batchQueue = [];

    try {
      // 批量发送
      const response = await this.ipcClient.send({
        batch: batch.map(req => ({
          globalState: req.globalState,
          localObs: req.localObs,
        })),
        timestamp: Date.now(),
      }) as { results: number[] };

      // 分发结果
      batch.forEach((req, index) => {
        const action = response.results?.[index] ?? this.heuristicFallback(req.globalState);
        req.resolve(action);
      });
    } catch (err) {
      // 批量失败，降级到启发式
      batch.forEach(req => {
        req.resolve(this.heuristicFallback(req.globalState));
      });
    } finally {
      this.isProcessingBatch = false;

      // 还有新请求，继续处理
      if (this.batchQueue.length > 0) {
        this.batchTimer = setTimeout(() => this.processBatch(), this.batchTimeout);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 启发式 fallback
   */
  private heuristicFallback(globalState: number[]): number {
    const currentCpu = globalState[0] || 0;
    if (currentCpu > 0.95) return 2;
    if (currentCpu > 0.70) return 1;
    return 0;
  }

  /**
   * 发送单个请求到 Python
   */
  private async sendToPython(globalState: number[], localObs: number[]): Promise<number> {
    if (!this.ipcClient?.isConnected()) {
      return this.heuristicFallback(globalState);
    }

    const response = await this.ipcClient.send({
      globalState,
      localObs,
      timestamp: Date.now(),
    }) as Record<string, unknown>;

    return response.action as number;
  }

  /**
   * ⚡ 优化版推理: 缓存 → 批量 → IPC
   */
  public async evaluateMappoResourceVector(
    globalState: number[],
    localObs: number[]
  ): Promise<number> {
    // Fallback 模式
    if (this.useFallback || !this.ipcClient?.isConnected()) {
      return this.heuristicFallback(globalState);
    }

    // 优化 1: 检查缓存
    const cacheKey = this.getCacheKey(globalState, localObs);
    const cachedAction = this.getFromCache(cacheKey);
    if (cachedAction !== null) {
      return cachedAction;
    }

    // 优化 2: 加入批量队列
    return new Promise((resolve, reject) => {
      this.batchQueue.push({
        globalState,
        localObs,
        resolve,
        reject,
      });

      // 启动批次处理定时器
      if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => this.processBatch(), this.batchTimeout);
      }

      // 队列太长，直接处理
      if (this.batchQueue.length >= 10) {
        clearTimeout(this.batchTimer!);
        this.processBatch();
      }
    }).then(action => {
      this.setCache(cacheKey, action);
      return action;
    });
  }

  /**
   * 批量推理（显式批量接口）
   */
  public async evaluateBatch(
    requests: Array<{ globalState: number[]; localObs: number[] }>
  ): Promise<number[]> {
    return Promise.all(
      requests.map(req => this.evaluateMappoResourceVector(req.globalState, req.localObs))
    );
  }

  /**
   * 获取缓存统计
   */
  public getCacheStats(): { size: number; maxSize: number; hitRate: number } {
    return {
      size: this.cache.size,
      maxSize: this.cacheMaxSize,
      hitRate: 0, // TODO: 实现命中率统计
    };
  }

  /**
   * 优雅关闭
   */
  public safelyTerminateGovernorContext(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }

    if (this.ipcClient) {
      this.ipcClient.disconnect();
      this.ipcClient = null;
    }

    if (this.pythonProcess) {
      this.pythonProcess.kill();
      this.pythonProcess = null;
    }

    this.cache.clear();
    console.log('[MAPPO] 🔒 Python 强化学习控流常驻句柄已回收');
  }
}
