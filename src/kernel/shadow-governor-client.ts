// ─────────────────────────────────────────────────────────────────
// SoloForge Kernel Layer: Shadow Governor TCP Socket Client
// Path: src/kernel/shadow-governor-client.ts
//
// 功能：连接到 Python Shadow Server，获取 PPO action
// 模式：Shadow Governor - 只观察，不执行
// 兼容性：支持 Windows 和 Linux
// ─────────────────────────────────────────────────────────────────

import net from 'net';
import crypto from 'crypto';

/**
 * Shadow Governor 配置
 */
interface ShadowConfig {
  host: string;
  port: number;
  timeout: number;
  fallbackEnabled: boolean;
}

/**
 * Shadow Governor 请求
 */
interface ShadowRequest {
  id: string;
  obs: number[];
  timestamp: number;
}

/**
 * Shadow Governor 响应
 */
interface ShadowResponse {
  id: string;
  action: number;
  action_name: string;
  prob: number;
  value?: number;
}

/**
 * Shadow Governor 错误
 */
interface ShadowError {
  error: string;
  message: string;
}

/**
 * 遥测数据结构（10 维）
 */
interface TelemetryVector {
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

/**
 * Shadow Governor 动作名称
 */
const ACTION_NAMES = [
  'no_op',
  'spawn_agent',
  'pause_background',
  'switch_small_model',
  'reduce_context',
  'enable_gc'
];

/**
 * Shadow Governor TCP Socket 客户端
 *
 * 职责：
 * 1. 连接 Python Shadow Server
 * 2. 发送 telemetry 向量
 * 3. 接收 PPO action（不执行）
 * 4. 记录 Shadow vs Rule 对比数据
 */
export class ShadowGovernorClient {
  private socket: net.Socket | null = null;
  private config: ShadowConfig;
  private pendingRequests: Map<string, {
    resolve: (val: ShadowResponse) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = new Map();

  private connected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;

  // 统计
  private stats = {
    requestsSent: 0,
    predictionsReceived: 0,
    errors: 0,
    reconnects: 0
  };

  constructor(config?: Partial<ShadowConfig>) {
    this.config = {
      host: config?.host || '127.0.0.1',
      port: config?.port || 8765,
      timeout: config?.timeout || 5000,
      fallbackEnabled: config?.fallbackEnabled ?? true
    };
  }

  /**
   * 连接到 Python Shadow Server
   */
  public async connect(): Promise<boolean> {
    return new Promise((resolve) => {
      const { host, port } = this.config;

      this.socket = net.createConnection({ host, port, timeout: this.config.timeout });

      this.socket.on('connect', () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        console.log(`[Shadow Governor] 已连接: ${host}:${port}`);
        resolve(true);
      });

      this.socket.on('data', (data: Buffer) => {
        this.handleResponse(data.toString());
      });

      this.socket.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNREFUSED') {
          console.warn(`[Shadow Governor] 连接被拒绝 ${host}:${port}，Shadow 模式使用 fallback`);
        } else {
          console.error(`[Shadow Governor] 连接错误: ${err.message}`);
        }
        this.stats.errors++;
        this.connected = false;
        resolve(false);
      });

      this.socket.on('close', () => {
        this.connected = false;
        console.log(`[Shadow Governor] 连接关闭`);
        this.tryReconnect();
      });

      this.socket.on('timeout', () => {
        console.warn(`[Shadow Governor] 连接超时，Shadow 模式使用 fallback`);
        this.connected = false;
        resolve(false);
      });

      // 超时处理
      setTimeout(() => {
        if (!this.connected) {
          console.warn(`[Shadow Governor] 连接超时，Shadow 模式使用 fallback`);
          resolve(false);
        }
      }, this.config.timeout);
    });
  }

  /**
   * 尝试重连
   */
  private tryReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn(`[Shadow Governor] 重连次数超限，停止重连`);
      return;
    }

    this.reconnectAttempts++;
    this.stats.reconnects++;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);
    console.log(`[Shadow Governor] ${delay}ms 后重连...`);

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * 处理响应
   */
  private handleResponse(data: string): void {
    const lines = data.split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const response: ShadowResponse | ShadowError = JSON.parse(line);

        if ('error' in response) {
          console.error(`[Shadow Governor] 错误: ${response.message}`);
          this.stats.errors++;
          continue;
        }

        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(response.id);
          pending.resolve(response);
          this.stats.predictionsReceived++;
        }
      } catch (e) {
        // 忽略无效行
      }
    }
  }

  /**
   * 发送请求
   */
  private async sendRequest(obs: number[]): Promise<ShadowResponse> {
    const id = crypto.randomUUID();
    const request: ShadowRequest = {
      id,
      obs,
      timestamp: Date.now()
    };

    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        // Fallback: 随机策略
        const action = Math.floor(Math.random() * 6);
        resolve({
          id,
          action,
          action_name: ACTION_NAMES[action],
          prob: 0.17
        });
        return;
      }

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        // 超时 fallback
        const action = Math.floor(Math.random() * 6);
        resolve({
          id,
          action,
          action_name: ACTION_NAMES[action],
          prob: 0.0
        });
      }, this.config.timeout);

      this.pendingRequests.set(id, { resolve, reject, timer });

      this.socket!.write(JSON.stringify(request) + '\n');
      this.stats.requestsSent++;
    });
  }

  /**
   * 获取 PPO action（Shadow 模式，不执行）
   *
   * @param telemetry 遥测数据
   * @returns PPO action
   */
  public async getShadowAction(telemetry: TelemetryVector): Promise<ShadowResponse> {
    // 构造 10 维特征向量
    const obs = this.buildObservationVector(telemetry);

    return this.sendRequest(obs);
  }

  /**
   * 构造 10 维特征向量
   */
  private buildObservationVector(telemetry: TelemetryVector): number[] {
    return [
      telemetry.cpu_usage,
      telemetry.memory_pressure,
      telemetry.queue_depth / 300.0,
      telemetry.agent_count / 50.0,
      telemetry.token_pressure,
      telemetry.projection_lag,
      telemetry.scheduler_congestion,
      telemetry.attention_collapse,
      telemetry.starvation_penalty / 15.0,
      (telemetry.queue_depth * telemetry.cpu_usage) / 100.0
    ];
  }

  /**
   * 获取统计信息
   */
  public getStats(): typeof this.stats {
    return { ...this.stats };
  }

  /**
   * 检查是否连接
   */
  public isConnected(): boolean {
    return this.connected;
  }

  /**
   * 关闭连接
   */
  public close(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.pendingRequests.clear();
    console.log(`[Shadow Governor] 已关闭`);
  }
}

// 导出默认配置
export const DEFAULT_SHADOW_CONFIG: ShadowConfig = {
  host: '127.0.0.1',
  port: 8765,
  timeout: 5000,
  fallbackEnabled: true
};
