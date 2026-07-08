// ─────────────────────────────────────────────────────────────────
// SoloForge Agent Core: FIPA-ACL Agent Communication Bus + Gossip
// Path: src/core/agent/communication/agent-communication-bus.ts
//
// v2: 新增 WebSocket 跨进程传输层
//   - 每个实例启动时连接到 WebSocket 中继服务器 (AgentEventHub)
//   - 发送消息: 本地 Map 存储 + WebSocket 广播
//   - 接收消息: WebSocket 消息写入本地 Map
//   - 连接失败时降级为纯进程内模式
//   - 消息去重: 防止本地消息通过 WebSocket 回环
//
// 参考: FIPA-ACL 标准消息格式
// 参考: Google A2A 协议任务发现
// 参考: RepuNet Gossip 机制
// ─────────────────────────────────────────────────────────────────

import { logger } from '../../logger';
import type { RuntimeKernel } from '../../../kernel/runtime-kernel';
import { RuntimeEvent } from '../../events/runtime-events';

/**
 * WebSocket 跨进程传输层配置
 */
export interface CommBusTransportConfig {
  /** WebSocket 中继服务器地址, 默认 ws://localhost:3001/ws/agents */
  relayUrl?: string;
  /** 是否启用跨进程传输, 默认 true */
  enabled?: boolean;
  /** 重连间隔 (ms), 默认 5000 */
  reconnectIntervalMs?: number;
  /** 最大重连次数, 0 = 无限, 默认 0 */
  maxReconnectAttempts?: number;
  /** API token (用于 AgentEventHub 鉴权) */
  token?: string;
}

/**
 * FIPA-ACL 述行语 (Performative) — 参考 FIPA 标准
 */
export type ACLPerformative =
  | 'INFORM'      // 通知信息
  | 'REQUEST'     // 请求执行
  | 'PROPOSE'     // 提议合作
  | 'ACCEPT'      // 接受提议
  | 'REJECT'      // 拒绝提议
  | 'QUERY'       // 查询信息
  | 'DELEGATE'    // 委托任务
  | 'CHALLENGE'   // 挑战/质疑
  | 'GOSSIP';     // 闲谈传播声誉

/**
 * FIPA-ACL 标准消息格式
 */
export interface FIPAACLMessage {
  /** 发送者 Agent ID */
  sender: string;
  /** 接收者 Agent ID */
  receiver: string;
  /** 述行语 (消息意图) */
  performative: ACLPerformative;
  /** 消息内容 */
  content: any;
  /** 本体论 (语义上下文) */
  ontology?: string;
  /** 所属协议 */
  protocol?: string;
  /** 消息 ID */
  messageId: string;
  /** 回复目标 ID */
  replyTo?: string;
  /** 时间戳 */
  timestamp: number;
}

/**
 * Agent 通信总线
 *
 * 设计原则:
 * 1. 基于 FIPA-ACL 标准消息格式
 * 2. 支持点对点和广播通信
 * 3. 支持 Gossip 协议传播间接声誉
 * 4. 消息有 TTL，防止无限堆积
 * 5. v2: 可选 WebSocket 跨进程传输层, 连接失败自动降级
 */
export class AgentCommunicationBus {
  private readonly moduleName = 'AgentCommBus';
  private readonly inboxes = new Map<string, FIPAACLMessage[]>();
  private readonly maxInboxSize = 100;
  private readonly messageTTLms = 30000; // 30 秒 TTL

  // ─── WebSocket 跨进程传输层 ───────────────────────────────────
  private readonly transportConfig: Required<CommBusTransportConfig>;
  private ws: import('ws').WebSocket | null = null;
  private wsConnected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  /** 已发出消息 ID 集合 — 用于去重, 防止 WebSocket 回环 */
  private readonly sentMessageIds = new Set<string>();
  /** 去重集合最大容量 */
  private readonly dedupeSetMaxSize = 5000;

  constructor(
    private readonly kernel?: RuntimeKernel,
    transportConfig?: CommBusTransportConfig,
  ) {
    this.transportConfig = {
      relayUrl: transportConfig?.relayUrl ?? 'ws://localhost:3001/ws/agents',
      enabled: transportConfig?.enabled !== false,
      reconnectIntervalMs: transportConfig?.reconnectIntervalMs ?? 5000,
      maxReconnectAttempts: transportConfig?.maxReconnectAttempts ?? 0,
      token: transportConfig?.token ?? '',
    };
  }

  // ============================================================
  // 生命周期 — WebSocket 连接
  // ============================================================

  /**
   * 异步初始化: 尝试连接 WebSocket 中继服务器
   * 连接失败时降级为纯进程内模式 (不影响现有行为)
   */
  async connect(): Promise<void> {
    if (!this.transportConfig.enabled) {
      logger.info(this.moduleName, 'WebSocket transport disabled, running in-process only');
      return;
    }

    try {
      await this.initWebSocket();
      logger.info(this.moduleName, `WebSocket transport connected to ${this.transportConfig.relayUrl}`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(this.moduleName, `WebSocket connect failed, degraded to in-process mode: ${errMsg}`);
      this.scheduleReconnect();
    }
  }

  /**
   * 关闭 WebSocket 连接并清理资源
   */
  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(1001, 'bus shutdown'); } catch { /* ignore */ }
      this.ws = null;
    }
    this.wsConnected = false;
    this.sentMessageIds.clear();
    logger.info(this.moduleName, 'WebSocket transport closed');
  }

  /**
   * 当前是否处于跨进程模式
   */
  isTransportConnected(): boolean {
    return this.wsConnected;
  }

  // ─── 内部: WebSocket 初始化 ──────────────────────────────────

  private async initWebSocket(): Promise<void> {
    // 动态导入 ws (避免在浏览器/测试环境硬性依赖)
    const { default: WsModule } = await import('ws');
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const url = this.transportConfig.token
        ? `${this.transportConfig.relayUrl}?token=${encodeURIComponent(this.transportConfig.token)}`
        : this.transportConfig.relayUrl;

      const socket: import('ws').WebSocket = new WsModule(url);

      const onOpen = () => {
        cleanup();
        this.ws = socket;
        this.wsConnected = true;
        this.reconnectAttempts = 0;
        this.attachSocketListeners(socket);
        if (!settled) { settled = true; resolve(); }
      };

      const onError = (err: Error) => {
        cleanup();
        if (!settled) { settled = true; reject(err); }
      };

      const cleanup = () => {
        socket.removeListener('open', onOpen);
        socket.removeListener('error', onError);
      };

      socket.once('open', onOpen);
      socket.once('error', onError);

      // 连接超时 5s
      setTimeout(() => {
        if (!settled) {
          cleanup();
          try { socket.close(); } catch { /* ignore */ }
          settled = true;
          reject(new Error('WebSocket connection timeout (5s)'));
        }
      }, 5000);
    });
  }

  private attachSocketListeners(socket: import('ws').WebSocket): void {
    socket.on('message', (raw) => {
      try {
        const envelope = JSON.parse(raw.toString());
        if (envelope?.type === 'fiaacl.relay') {
          this.handleIncomingRelayMessage(envelope.payload as FIPAACLMessage);
        }
      } catch { /* ignore non-JSON or malformed */ }
    });

    socket.on('close', () => {
      this.wsConnected = false;
      this.ws = null;
      logger.info(this.moduleName, 'WebSocket disconnected, scheduling reconnect');
      this.scheduleReconnect();
    });

    socket.on('error', (err: Error) => {
      logger.debug(this.moduleName, `WebSocket error: ${err.message}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const max = this.transportConfig.maxReconnectAttempts;
    if (max > 0 && this.reconnectAttempts >= max) {
      logger.warn(this.moduleName, `Max reconnect attempts (${max}) reached, staying in-process mode`);
      return;
    }
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      logger.debug(this.moduleName, `Reconnect attempt #${this.reconnectAttempts}`);
      try {
        await this.initWebSocket();
        logger.info(this.moduleName, 'WebSocket reconnected successfully');
      } catch {
        this.scheduleReconnect();
      }
    }, this.transportConfig.reconnectIntervalMs);
  }

  // ─── 内部: 消息去重 & 中继 ──────────────────────────────────

  /**
   * 将本地发出的消息通过 WebSocket 广播给其他进程
   */
  private relayToRemote(msg: FIPAACLMessage): void {
    if (!this.wsConnected || !this.ws) return;
    try {
      const envelope = JSON.stringify({ type: 'fiaacl.relay', payload: msg });
      this.ws.send(envelope);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.debug(this.moduleName, `WebSocket relay failed: ${errMsg}`);
    }
  }

  /**
   * 处理从 WebSocket 收到的远端消息
   * 去重: 如果 messageId 已在本地发出集合中, 说明是回环消息, 跳过
   */
  private handleIncomingRelayMessage(msg: FIPAACLMessage): void {
    if (!msg?.messageId || !msg?.receiver) return;

    // 去重: 该消息是本进程之前发出的, WebSocket 回环
    if (this.sentMessageIds.has(msg.messageId)) {
      this.sentMessageIds.delete(msg.messageId); // 一次性消费
      return;
    }

    // 写入本地 inbox
    const inbox = this.inboxes.get(msg.receiver) ?? [];
    if (inbox.length >= this.maxInboxSize) {
      inbox.shift();
    }
    inbox.push(msg);
    this.inboxes.set(msg.receiver, inbox);

    logger.debug(this.moduleName, `[REMOTE] [${msg.performative}] ${msg.sender} → ${msg.receiver}`);
  }

  /**
   * 记录已发出的 messageId 并维护去重集合大小
   */
  private trackSentMessage(messageId: string): void {
    this.sentMessageIds.add(messageId);
    // 防止无限增长: 超过阈值时清除最旧的一半
    if (this.sentMessageIds.size > this.dedupeSetMaxSize) {
      const iter = this.sentMessageIds.values();
      for (let i = 0; i < this.dedupeSetMaxSize / 2; i++) {
        const val = iter.next().value;
        if (val !== undefined) this.sentMessageIds.delete(val);
      }
    }
  }

  // ============================================================
  // 公共 API (接口不变)
  // ============================================================

  /**
   * 发送点对点消息
   */
  send(msg: Omit<FIPAACLMessage, 'messageId' | 'timestamp'>): void {
    const fullMsg: FIPAACLMessage = {
      ...msg,
      messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      timestamp: Date.now(),
    };

    // 1. 写入本地 inbox
    const inbox = this.inboxes.get(msg.receiver) ?? [];
    if (inbox.length >= this.maxInboxSize) {
      inbox.shift(); // FIFO 淘汰
    }
    inbox.push(fullMsg);
    this.inboxes.set(msg.receiver, inbox);

    // 2. 记录 messageId 用于去重, 然后中继到远端
    this.trackSentMessage(fullMsg.messageId);
    this.relayToRemote(fullMsg);

    logger.debug(this.moduleName, `[${msg.performative}] ${msg.sender} → ${msg.receiver}`);
  }

  /**
   * 广播消息给所有已注册 Agent
   */
  broadcast(sender: string, performative: ACLPerformative, content: any, receivers: string[]): void {
    for (const receiver of receivers) {
      if (receiver !== sender) {
        this.send({ sender, receiver, performative, content });
      }
    }
  }

  /**
   * 轮询接收消息 (Agent 主循环调用)
   */
  poll(agentId: string): FIPAACLMessage[] {
    const messages = this.inboxes.get(agentId) ?? [];
    this.inboxes.set(agentId, []);

    // 过滤过期消息
    const now = Date.now();
    return messages.filter(msg => now - msg.timestamp < this.messageTTLms);
  }

  /**
   * 发送 Gossip 消息 — 间接声誉传播
   * 参考 RepuNet: Agent 选择性地向其他 Agent 传播关于某 Agent 的评价
   */
  gossip(sender: string, aboutAgentId: string, evaluation: any, receivers: string[]): void {
    for (const receiver of receivers) {
      if (receiver !== sender && receiver !== aboutAgentId) {
        this.send({
          sender,
          receiver,
          performative: 'GOSSIP',
          content: { aboutAgentId, evaluation },
          protocol: 'gossip-reputation',
        });
      }
    }
  }

  /**
   * 注册 Agent 的收件箱
   */
  register(agentId: string): void {
    if (!this.inboxes.has(agentId)) {
      this.inboxes.set(agentId, []);
    }
  }

  /**
   * 注销 Agent
   */
  unregister(agentId: string): void {
    this.inboxes.delete(agentId);
  }

  /**
   * 获取已注册 Agent 列表
   */
  getRegisteredAgents(): string[] {
    return Array.from(this.inboxes.keys());
  }
}
