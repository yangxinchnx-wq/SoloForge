// ─────────────────────────────────────────────────────────────────
// SoloForge Agent Core: FIPA-ACL Agent Communication Bus + Gossip
// Path: src/core/agent/communication/agent-communication-bus.ts
//
// 参考: FIPA-ACL 标准消息格式
// 参考: Google A2A 协议任务发现
// 参考: RepuNet Gossip 机制
// ─────────────────────────────────────────────────────────────────

import { logger } from '../../logger';
import type { RuntimeKernel } from '../../../kernel/runtime-kernel';
import { RuntimeEvent } from '../../events/runtime-events';

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
 */
export class AgentCommunicationBus {
  private readonly moduleName = 'AgentCommBus';
  private readonly inboxes = new Map<string, FIPAACLMessage[]>();
  private readonly maxInboxSize = 100;
  private readonly messageTTLms = 30000; // 30 秒 TTL

  constructor(private readonly kernel?: RuntimeKernel) {}

  /**
   * 发送点对点消息
   */
  send(msg: Omit<FIPAACLMessage, 'messageId' | 'timestamp'>): void {
    const fullMsg: FIPAACLMessage = {
      ...msg,
      messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      timestamp: Date.now(),
    };

    const inbox = this.inboxes.get(msg.receiver) ?? [];
    if (inbox.length >= this.maxInboxSize) {
      inbox.shift(); // FIFO 淘汰
    }
    inbox.push(fullMsg);
    this.inboxes.set(msg.receiver, inbox);

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
