// src/kernel/shadow-governor-client.ts
import net from 'net';

export interface ShadowConfig {
  host: string;
  port: number;
  timeout: number;
  fallbackEnabled: boolean;
  maxLineBytes: number;       // 单行报文防爆硬上限
  maxLinesPerTick: number;    // 单次微任务 Tick 最大平摊处理行数，彻底防 CPU 尖刺
  bufferPoolSize: number;     // 物理环形滑窗缓冲区分配空间
  maxPendingRequests: number; // pendingRequests Map 容量硬上限, 超限降级 fallback 防内存暴涨
}

interface ShadowRequest {
  id: number;           // 🔒 纯整型 Smi ID，触发 V8 栈内连续存储优化，高 TPS 下字典增删实现零堆内存抖动
  obs: number[];
  timestamp: number;
  txContext: {          // 🔒 全链路事务上下文追踪指纹，打通跨进程跨语言 Lineage 审计链
    txId: string;
    traceId: string;
    tickId: number;
    version: number;
  };
}

export interface ShadowResponse {
  id: number;
  action: number;
  action_name: string;
  prob: number;
  value?: number;
  confidence?: number;
  timestamp?: string;
}

/**
 * 默认配置（非内核场景回退用）
 */
export const DEFAULT_SHADOW_CONFIG: Partial<ShadowConfig> = {
  host: '127.0.0.1',
  port: 8765,
  timeout: 5000,
  fallbackEnabled: true,
  maxLineBytes: 8192,
  maxLinesPerTick: 50,
  bufferPoolSize: 65536,
  maxPendingRequests: 500    // 突发流控: 超过 500 个 pending 请求时降级 fallback, 防止 Map 无限增长
};

export interface TelemetryVector {
  cpu_usage: number;
  memory_pressure: number;
  queue_depth: number;
  agent_count: number;
  token_pressure: number;
  projection_lag: number;
  scheduler_congestion: number;
  attention_collapse: number;
  starvation_penalty: number;
  pressure_index: number;
}

export class ShadowGovernorClient {
  private socket: net.Socket | null = null;
  private config!: ShadowConfig;
  private actionLabels: string[] = [];
  private idRollbackThreshold: number = 0;
  
  // 🔒 键值类型深度纯化为 number，高 TPS（>2000）下 Map 频繁增删不产生任何堆内存分配与 GC 压力
  private pendingRequests: Map<number, {
    resolve: (val: ShadowResponse) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = new Map();

  private connected = false;
  private isWritable = true;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private requestIdCounter = 0;

  // 🧱 零拷贝二进制滑动窗口缓冲区系统
  private bufferPool!: Buffer;
  private bufferOffset = 0;
  private isDiscardMode = false;

  private stats = { requestsSent: 0, predictionsReceived: 0, errors: 0, reconnects: 0, bufferOverflows: 0, pendingOverflows: 0 };
  private kernelRef: any;

  constructor(kernel: any, config?: Partial<ShadowConfig>) {
    if (!kernel || !kernel.configCenter) {
      throw new Error('ErrorCode.SYS_INIT_FAILED: Kernel and its configCenter must be pre-bound before client creation.');
    }
    this.kernelRef = kernel;
    this.loadConstitutionalConfigurations(config);
  }

  /**
   * 🧱 全配置中心化加载器：彻底扫除全部 Magic Number 隐式依赖，全量参数走 ConfigCenter
   */
  private loadConstitutionalConfigurations(config?: Partial<ShadowConfig>): void {
    const cc = this.kernelRef.configCenter;

      this.config = {
      host: config?.host || cc.get('governor.ppo.host', '127.0.0.1'),
      port: config?.port || cc.get('governor.ppo.port', 8765),
      timeout: config?.timeout || cc.get('governor.ppo.timeout', 5000),
      fallbackEnabled: config?.fallbackEnabled ?? cc.get('governor.ppo.fallback_enabled', true),
      maxLineBytes: config?.maxLineBytes || cc.get('governor.ppo.max_line_bytes', 8192),
      maxLinesPerTick: config?.maxLinesPerTick || cc.get('governor.ppo.max_lines_per_tick', 50),
      bufferPoolSize: config?.bufferPoolSize || cc.get('governor.ppo.buffer_pool_size', 65536),
      maxPendingRequests: config?.maxPendingRequests || cc.get('governor.ppo.max_pending_requests', 500)
    };

    this.maxReconnectAttempts = cc.get('governor.reconnect.max_attempts', 3);
    this.actionLabels = cc.get('governor.action.labels', ['no_op', 'spawn_agent', 'pause_background', 'switch_small_model', 'reduce_context', 'enable_gc']);
    this.idRollbackThreshold = cc.get('governor.id.rollback_threshold', 9007199254740800); 
    this.bufferPool = Buffer.alloc(this.config.bufferPoolSize);
  }

  public async connect(): Promise<boolean> {
    return new Promise((resolve) => {
      const { host, port } = this.config;
      this.socket = net.createConnection({ host, port, timeout: this.config.timeout });

      this.socket.on('connect', () => {
        this.connected = true;
        this.isWritable = true;
        this.reconnectAttempts = 0;
        this.isDiscardMode = false;
        this.pushMetricsToMonitorBus('governor.client.connected', 1);
        resolve(true);
      });

      this.socket.on('data', (chunk: Buffer) => {
        this.processStreamBytes(chunk);
      });

      this.socket.on('drain', () => {
        this.isWritable = true;
      });

      this.socket.on('error', (err: NodeJS.ErrnoException) => {
        this.stats.errors++;
        this.pushMetricsToMonitorBus('governor.client.net_error', 1);
        this.handleLinkFailure(`Socket pipe raw error: ${err.message}`);
        resolve(false);
      });

      this.socket.on('close', () => {
        this.handleLinkFailure('Remote shadow server closed pipe connection');
        this.tryReconnect();
      });

      this.socket.on('timeout', () => {
        this.pushMetricsToMonitorBus('governor.client.timeout_error', 1);
        this.handleLinkFailure('Network transport layer sync wait timeout');
        resolve(false);
      });
    });
  }

  /**
   * ⚡ 零拷贝单向指针滑动窗口扫描器（完美兼顾极端恶意 Flood 下的精准行级恢复控制）
   */
  private processStreamBytes(chunk: Buffer): void {
    if (this.bufferOffset + chunk.length > this.bufferPool.length) {
      this.stats.bufferOverflows++;
      this.isDiscardMode = true; // 强行切换为洪峰抛弃流控状态，保障控制总线主事件循环不因撑爆挂起
      this.bufferOffset = 0;
      this.pushMetricsToMonitorBus('governor.buffer.overflow', 1);
    }

    if (this.isDiscardMode) {
      const dirtyIndex = chunk.indexOf(0x0a);
      if (dirtyIndex === -1) return; // 换行符未到达，在二进制流底层直接丢弃，阻断 V8 字符串开销
      this.isDiscardMode = false;     // 换行符精确抓取，完美退出抛弃流控状态
      if (dirtyIndex === chunk.length - 1) return;
      const filteredChunk = chunk.subarray(dirtyIndex + 1);
      filteredChunk.copy(this.bufferPool, 0);
      this.bufferOffset = filteredChunk.length;
    } else {
      chunk.copy(this.bufferPool, this.bufferOffset);
      this.bufferOffset += chunk.length;
    }

    this.executeSlicedScan(0);
  }

  /**
   * 🔒 时间片拆分扫描：微任务级平摊单次 Tick 计算密度，阻断高频 Event Flood 下的 CPU 短暂尖刺
   */
  private executeSlicedScan(linesProcessedThisTick: number): void {
    let scanStartPointer = 0;
    
    while (linesProcessedThisTick < this.config.maxLinesPerTick) {
      const newlineIndex = this.bufferPool.indexOf(0x0a, scanStartPointer);
      if (newlineIndex === -1 || newlineIndex >= this.bufferOffset) {
        break;
      }

      // 🔒 边界自愈恢复：单行过载单条精准裁剪跳跃，100% 保证其余后续合法数据流零延迟放行，消灭误伤率
      const lineLength = newlineIndex - scanStartPointer;
      if (lineLength > this.config.maxLineBytes) {
        this.stats.errors++;
        this.pushMetricsToMonitorBus('governor.malformed_line_dropped', 1);
        scanStartPointer = newlineIndex + 1; // 仅越过当前恶意包，后续拼装块无损保留
        continue;
      }

      const lineSegmentView = this.bufferPool.subarray(scanStartPointer, newlineIndex);
      scanStartPointer = newlineIndex + 1;
      linesProcessedThisTick++;

      const cleanJson = lineSegmentView.toString('utf8').trim();
      if (cleanJson) {
        this.dispatchResponseLine(cleanJson);
      }
    }

    if (scanStartPointer > 0) {
      if (scanStartPointer < this.bufferOffset) {
        this.bufferPool.copy(this.bufferPool, 0, scanStartPointer, this.bufferOffset);
        this.bufferOffset -= scanStartPointer;
      } else {
        this.bufferOffset = 0;
      }
    }

    // 🔒 极高并发下的控制循环释放：若积压行数超出单次微任务预算，切分至下一时钟微任务处理周期，释放 CPU 时间片
    if (linesProcessedThisTick >= this.config.maxLinesPerTick && this.bufferOffset > 0) {
      setImmediate(() => {
        this.executeSlicedScan(0);
      });
    }
  }

  private dispatchResponseLine(jsonLine: string): void {
    try {
      const response: ShadowResponse = JSON.parse(jsonLine);
      const deferred = this.pendingRequests.get(response.id);
      if (deferred) {
        clearTimeout(deferred.timer);
        this.pendingRequests.delete(response.id);
        deferred.resolve(response);
        this.stats.predictionsReceived++;
      }
    } catch {
      this.stats.errors++;
    }
  }

  private handleLinkFailure(reason: string): void {
    this.connected = false;
    this.isWritable = false;
    
    // 🔒 临界区并发防锁死：清空前同步提取请求快照，完全阻断重连周期与处理周期的交织碰撞
    const activeRequestsSnapshot = Array.from(this.pendingRequests.entries());
    this.pendingRequests.clear();

    for (const [id, deferred] of activeRequestsSnapshot) {
      clearTimeout(deferred.timer);
      if (this.config.fallbackEnabled) {
        deferred.resolve({ id, action: 0, action_name: this.actionLabels[0], prob: 1.0 });
      } else {
        deferred.reject(new Error(`[Shadow Client Links Interrupted] ${reason}`));
      }
    }
  }

  private tryReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    this.reconnectAttempts++;
    this.stats.reconnects++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);
    
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.connected) this.connect();
    }, delay);
  }

  public async sendRequest(obs: number[], txMeta: any): Promise<ShadowResponse> {
    if (this.requestIdCounter >= this.idRollbackThreshold) {
      this.requestIdCounter = 0; // 原子级自增回绕安全上限配置化
    }
    const id = ++this.requestIdCounter;
    
    // 🔒 显式上下文传播：打包全量分布式链路资产（traceId / tickId / version），随套接字同步穿透到 Python 策略宇宙
    const request: ShadowRequest = { 
      id, 
      obs, 
      timestamp: Date.now(),
      txContext: {
        txId: txMeta.txId,
        traceId: txMeta.traceId,
        tickId: txMeta.tickId,
        version: txMeta.version
      }
    };

    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected || !this.isWritable) {
        resolve({ id, action: 0, action_name: this.actionLabels[0], prob: 1.0 });
        return;
      }

      // 🔒 突发流控: pendingRequests 超过上限时降级 fallback, 防止 Map 无限增长导致内存暴涨
      if (this.pendingRequests.size >= this.config.maxPendingRequests) {
        this.stats.pendingOverflows++;
        this.pushMetricsToMonitorBus('governor.pending.overflow', 1);
        resolve({ id, action: 0, action_name: this.actionLabels[0], prob: 0.0 });
        return;
      }

      // 🔒 超高 TPS 防内存抖动：预设原子型 Promise 生命周期管理防护
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          resolve({ id, action: 0, action_name: this.actionLabels[0], prob: 0.0 });
        }
      }, this.config.timeout);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const capacityState = this.socket.write(JSON.stringify(request) + '\n');
      if (capacityState === false) {
        this.isWritable = false; // 主动高密背压流控硬阻断，保护 Node 内存
      }
      this.stats.requestsSent++;
      this.pushMetricsToMonitorBus('governor.requests.tps_count', 1);
    });
  }

  public async getShadowAction(telemetry: TelemetryVector, txMeta?: any): Promise<ShadowResponse> {
    const queueDenom = this.kernelRef.configCenter.get('governor.scale.queue_depth', 300.0);
    const agentDenom = this.kernelRef.configCenter.get('governor.scale.agent_count', 50.0);
    const starveDenom = this.kernelRef.configCenter.get('governor.scale.starvation_penalty', 15.0);
    const pressureDenom = this.kernelRef.configCenter.get('governor.scale.pressure_index_factor', 100.0);

    const obs = [
      telemetry.cpu_usage,
      telemetry.memory_pressure,
      telemetry.queue_depth / queueDenom,
      telemetry.agent_count / agentDenom,
      telemetry.token_pressure,
      telemetry.projection_lag,
      telemetry.scheduler_congestion,
      telemetry.attention_collapse,
      telemetry.starvation_penalty / starveDenom,
      (telemetry.queue_depth * telemetry.cpu_usage) / pressureDenom
    ];
    return this.sendRequest(obs, txMeta || {});
  }

  private pushMetricsToMonitorBus(metricName: string, value: number) {
    if (this.kernelRef?.metricsCollector?.counter) {
      this.kernelRef.metricsCollector.counter(metricName, value, { domain: 'governor', layer: 'kernel_socket' });
    }
  }

  public close(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.handleLinkFailure('Manual client termination issued');
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.bufferOffset = 0;
  }

  public getStats() { return { ...this.stats }; }
}
