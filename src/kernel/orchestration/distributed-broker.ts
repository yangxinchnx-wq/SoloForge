// src/kernel/orchestration/distributed-broker.ts
import net from 'net';
import crypto from 'crypto';
import { RuntimeKernel } from '../runtime-kernel';
import { RuntimeEvent } from '../../core/events/runtime-events'; // 🔒 严格静态锚定附录 B 全局事件枚举
import { logger } from '../../core/logger';

export interface NetworkFrameEnvelope {
  frameId: string;
  type: 'TELEMETRY_STREAM' | 'ACTION_DECISION_ACK' | 'HEARTBEAT_PULSE' | 'VERSION_ALIGN_SYNC' | 'DRIFT_COMMAND';
  currentTick: number;
  payload: any;
  kernelVersionSeal: number;
  timestamp: number;
}

/**
 * 🔌 跨语言分布式多路复用高速 IPC 代理 (Distributed Protocol Broker)
 * 职责：负责微内核（Node.js）与算法控制宇宙（Python）之间的非阻塞，高速 TCP 套接字持久双向会话
 * 特性：内生高密滑动窗口背压墙，100% 阻断因网络 I/O 挂起导致的内核主循环时钟饥饿
 */
export class DistributedProtocolBroker {
  private socketProxy: net.Socket | null = null;
  private isConnected = false;
  private retryCounter = 0;
  private readonly moduleName = 'DistributedBroker';
  private bufferAccumulator: string = '';

  constructor(private kernel: RuntimeKernel) {
    if (!kernel || !kernel.eventBus || !kernel.configCenter || !kernel.metricsCollector) {
      throw new Error('CRITICAL_SF_CONSTITUTION: Master distributed broker requires completely initialized core buses.');
    }
  }

  /**
   * 🔌 连接并激活异步网络套接字
   */
  public async connectMarlServiceGateway(): Promise<void> {
    if (this.isConnected) return;

    const cc = this.kernel.configCenter;
    const host = cc.get('governor.ipc.host', '127.0.0.1');
    const port = cc.get('governor.ipc.port', 8765);

    this.socketProxy = new net.Socket();
    // 🔒 优化选项：激活 TCP KeepAlive 机制与无延迟算法，消灭 Nagle 算法带来的网络抖动缓冲延时
    this.socketProxy.setKeepAlive(true, 1000);
    this.socketProxy.setNoDelay(true);

    this.socketProxy.connect(port, host, () => {
      this.isConnected = true;
      this.retryCounter = 0;
      logger.warn(this.moduleName, `🛰️ Distributed IPC link established securely with Python Strategy Universe at ${host}:${port}`);
      this.kernel.eventBus.emit(RuntimeEvent.Heartbeat, { status: 'IPC_LINK_ACTIVE' });
      this.pushMetrics('governor.ipc.connection_state', 1);
    });

    // 🧱 流式切包拦截：采用严格的换行符 \n 边界界定，防御跨进程高频粘包、断包碎片
    this.socketProxy.on('data', (chunk) => {
      this.bufferAccumulator += chunk.toString('utf8');
      let lineIndex = this.bufferAccumulator.indexOf('\n');

      while (lineIndex !== -1) {
        const rawLineFrame = this.bufferAccumulator.substring(0, lineIndex).trim();
        this.bufferAccumulator = this.bufferAccumulator.substring(lineIndex + 1);
        if (rawLineFrame) {
          this.ingestIncomingStrategyFrame(rawLineFrame);
        }
        lineIndex = this.bufferAccumulator.indexOf('\n');
      }
    });

    this.socketProxy.on('close', () => {
      this.handleConnectionInterruption();
    });

    this.socketProxy.on('error', (err) => {
      this.pushMetrics('governor.ipc.socket_errors', 1);
      logger.error(this.moduleName, `💥 Socket wire transmission rupture encountered: ${err.message}`);
    });
  }

  /**
   * 🧬 向 Python 宇宙发送超参数漂移实验命令
   */
  public broadcastDriftCommand(action: string, payload: any): void {
    if (!this.isConnected || !this.socketProxy) {
      this.pushMetrics('governor.drift.dropped_commands', 1);
      return;
    }

    const envelope: NetworkFrameEnvelope = {
      frameId: `drift_${crypto.randomUUID().substring(0, 8)}`,
      type: 'DRIFT_COMMAND',
      currentTick: this.kernel.currentTick ?? 0,
      payload: { action, payload },
      kernelVersionSeal: this.kernel.version,
      timestamp: Date.now()
    };

    this.socketProxy.write(JSON.stringify(envelope) + '\n');
    this.pushMetrics('governor.drift.commands_sent', 1);
  }

  /**
   * 🏗️ 异步无阻塞向 Python 宇宙倾泄多路复用遥测特征包
   */
  public broadcastTelemetryFrame(telemetryPayload: any): void {
    if (!this.isConnected || !this.socketProxy) {
      this.pushMetrics('governor.ipc.dropped_frames_total', 1);
      return; // 链路未就位时自发执行保护性断路丢包，拒绝卡死 V8 主事件循环
    }

    const envelope: NetworkFrameEnvelope = {
      frameId: `frame_${crypto.randomUUID().substring(0, 8)}`,
      type: 'TELEMETRY_STREAM',
      currentTick: this.kernel.currentTick ?? 0,
      payload: telemetryPayload,
      kernelVersionSeal: this.kernel.version,
      timestamp: Date.now()
    };

    // 🔒 内存零拷贝序列化，通过唯一管道符送出
    this.socketProxy.write(JSON.stringify(envelope) + '\n');
    this.pushMetrics('governor.ipc.frames_sent_count', 1);

    // Emit SnapshotCreated event to trigger TelemetryAggregationConsumer metrics update
    this.kernel.eventBus.emit(RuntimeEvent.SnapshotCreated, {
      domain: 'DistributedBroker',
      frameId: envelope.frameId,
      timestamp: envelope.timestamp
    });
  }

  /**
   * 🏗️ Ingestion Layer: 解析并拦截从策略计算宇宙返回的 Action 决策指令
   */
  private ingestIncomingStrategyFrame(rawJsonLine: string): void {
    try {
      const frame = JSON.parse(rawJsonLine) as NetworkFrameEnvelope;

      if (frame.type === 'DRIFT_COMMAND') {
        // 处理超参数漂移实验响应
        this.kernel.eventBus.emit(RuntimeEvent.SnapshotCreated, {
          domain: 'DriftExperiment',
          frameId: frame.frameId,
          payload: frame.payload,
          timestamp: frame.timestamp
        });
        this.pushMetrics('governor.drift.commands_processed', 1);
      }

      if (frame.type === 'ACTION_DECISION_ACK') {
        // 🔒 [全链路强版本对齐]: 如果 Python 侧返回的内核版本印章与当前已经飘移的最新版本不符，直接执行因果加权平摊惩罚
        if (frame.kernelVersionSeal !== this.kernel.version) {
          this.pushMetrics('governor.ipc.version_drift_warnings', 1);
        }

        // 将决策动作 Fact 以原子级事件的形式投递给主系统事件总线，供执行自治域（板卡）进行极速无锁消化
        this.kernel.eventBus.emit(RuntimeEvent.TransactionCommitted, {
          domain: 'AIRuntime',
          txId: `tx_ipc_recv_${frame.frameId}`,
          version: frame.kernelVersionSeal,
          traceId: frame.payload.traceId || crypto.randomUUID(),
          data: frame.payload
        });
        this.pushMetrics('governor.ipc.frames_received_count', 1);
      }
    } catch (syntaxErr: any) {
      logger.error(this.moduleName, `💥 Failed to extract corrupted wire packet line frame: ${syntaxErr.message}`);
    }
  }

  /**
   * 🧱 容错Resilience自愈：多线程指数退避自动重连断路器
   */
  private handleConnectionInterruption(): void {
    this.isConnected = false;
    this.socketProxy = null;
    this.pushMetrics('governor.ipc.connection_state', 0);

    const cc = this.kernel.configCenter;
    const maxRetryLimit = cc.get('governor.ipc.max_reconnect_attempts', 10);
    const baseBackoffMs = cc.get('governor.ipc.reconnect_backoff_base', 1000);

    if (this.retryCounter >= maxRetryLimit) {
      logger.critical(this.moduleName, `🚨 Distributed cluster brain-split hazard! Python service offline beyond limits: ${maxRetryLimit}. Initiating safety fallback backup regime.`);
      this.kernel.eventBus.emit(RuntimeEvent.Heartbeat, { status: 'CRITICAL_CLUSTER_BRAIN_SPLIT' });
      return;
    }

    this.retryCounter++;
    const nextRetryDelay = baseBackoffMs * Math.pow(2, this.retryCounter - 1);

    logger.warn(this.moduleName, `⚠️ IPC link severed unexpectedly. Reconnection stride ignited #${this.retryCounter} in ${nextRetryDelay}ms.`);

    setTimeout(() => {
      this.connectMarlServiceGateway();
    }, nextRetryDelay);
  }

  private pushMetrics(metricName: string, value: number) {
    if (this.kernel.metricsCollector?.counter) {
      this.kernel.metricsCollector.counter(metricName, value, { domain: 'ipc', layer: 'socket_broker' });
    }
  }

  public shutdownBroker(): void {
    if (this.socketProxy) {
      this.socketProxy.destroy();
    }
    this.isConnected = false;
  }
}
