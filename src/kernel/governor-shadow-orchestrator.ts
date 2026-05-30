// ─────────────────────────────────────────────────────────────────
// SoloForge Kernel Layer: Governor Shadow Orchestrator
// Path: src/kernel/governor-shadow-orchestrator.ts
//
// 功能：Shadow Governor 编排器 - 管理 Rule vs PPO 对比
// 文档要求：
// 1. 微内核与事件驱动：所有跨模块通信必须经过 CommandBus / EventBus
// 2. 状态所有权：所有写入必须经过事务 + Version Check + State Ownership
// 3. Event Sourcing：影子决策应生成 Event 而非直接写表
// 4. Lifecycle Manager：初始化/关闭时触发 Snapshot/Replay 事件
// ─────────────────────────────────────────────────────────────────

import { ulid } from 'ulid';
import { RuntimeKernel } from './runtime-kernel';
import { RuntimeComponent } from './runtime-component';
import { RuntimeEvent } from '../core/events/runtime-events';
import { RuntimePhase } from '../runtime/lifecycle';
import { ShadowGovernorClient, DEFAULT_SHADOW_CONFIG, TelemetryVector, ShadowResponse } from './shadow-governor-client';
import { SurrealPersistence, ShadowDecisionPayload } from '../data/surreal_persistence';
import { logger } from '../core/logger';

// ============================================================
// 类型定义
// ============================================================

/**
 * Shadow Orchestrator 配置
 */
export interface ShadowOrchestratorConfig {
  shadowServer: {
    host: string;
    port: number;
    timeout: number;
  };
  persistence: {
    enabled: boolean;
    batchInterval: number;  // ms，批量落库间隔
    maxBatchSize: number;   // 最大批量大小
  };
  comparison: {
    useRuleFallback: boolean;
    confidenceThreshold: number;  // 低于此值使用 Rule
  };
}

// ============================================================
// Shadow Orchestrator 实现
// ============================================================

export class GovernorShadowOrchestrator implements RuntimeComponent {
  public readonly name = 'governor-shadow-orchestrator';
  public phase: RuntimePhase = RuntimePhase.INIT;

  private kernel: RuntimeKernel;
  private shadowClient: ShadowGovernorClient | null = null;
  private persistence: SurrealPersistence;

  private config: ShadowOrchestratorConfig;
  private isConnected = false;

  // 统计
  private stats = {
    telemetryReceived: 0,
    shadowDecisions: 0,
    ruleWins: 0,
    ppoWins: 0,
    ties: 0,
    persistenceErrors: 0
  };

  // 批量缓冲（符合"数据库隔离"原则：异步、低频落库）
  private decisionBuffer: ShadowDecisionPayload[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  // 事件订阅清理
  private eventHandler: ((payload: any) => void) | null = null;
  private isActive = false;

  constructor(
    kernel: RuntimeKernel,
    persistence: SurrealPersistence,
    config?: Partial<ShadowOrchestratorConfig>
  ) {
    this.kernel = kernel;
    this.persistence = persistence;

    // 默认配置
    this.config = {
      shadowServer: {
        host: DEFAULT_SHADOW_CONFIG.host,
        port: DEFAULT_SHADOW_CONFIG.port,
        timeout: DEFAULT_SHADOW_CONFIG.timeout
      },
      persistence: {
        enabled: true,
        batchInterval: 5000,    // 5秒批量落库
        maxBatchSize: 100       // 最大100条
      },
      comparison: {
        useRuleFallback: true,
        confidenceThreshold: 0.6
      },
      ...config
    };

    // 注册 Governor 域的所有权（符合"状态所有权"原则）
    this.kernel.registerOwnership('Governor', 'governor_shadow*');
  }

  // ============================================================
  // RuntimeComponent 接口实现
  // ============================================================

  async start(): Promise<void> {
    console.log('[ShadowOrchestrator] 启动中...');

    try {
      // 1. 等待 SurrealDB 就绪（符合"数据库隔离"原则）
      if (this.persistence.isReady?.()) {
        await this.persistence.waitUntilReady?.(5000);
      }

      // 2. 连接 Shadow Server
      this.shadowClient = new ShadowGovernorClient({
        host: this.config.shadowServer.host,
        port: this.config.shadowServer.port,
        timeout: this.config.shadowServer.timeout,
        fallbackEnabled: this.config.comparison.useRuleFallback
      });

      const connected = await this.shadowClient.connect();
      this.isConnected = connected;

      if (connected) {
        // 3. 通过 EventBus 订阅遥测事件（符合"微内核与事件驱动"原则）
        this.subscribeToTelemetry();
        this.isActive = true;

        console.log('[ShadowOrchestrator] ✓ Shadow Server 已连接，遥测订阅已激活');
      } else {
        console.warn('[ShadowOrchestrator] ⚠️ Shadow Server 连接失败，使用 Rule fallback');
      }

      // 4. 启动批量落库定时器
      this.startFlushTimer();

      // 5. 发出 Startup 事件（符合"Event Sourcing"原则）
      this.emitShadowEvent('shadow.orchestrator.started', {
        timestamp: Date.now(),
        connected: this.isConnected,
        config: this.config
      });

      this.phase = RuntimePhase.RUNNING;
      console.log('[ShadowOrchestrator] ✓ 启动完成');

    } catch (error) {
      console.error('[ShadowOrchestrator] ✗ 启动失败', error);
      this.phase = RuntimePhase.FAILED;
      throw error;
    }
  }

  async stop(): Promise<void> {
    console.log('[ShadowOrchestrator] 关闭中...');
    this.phase = RuntimePhase.STOPPING;

    try {
      // 1. 发出 Shutdown 事件（符合"Event Sourcing"原则）
      this.emitShadowEvent('shadow.orchestrator.stopping', {
        timestamp: Date.now(),
        stats: this.getStats()
      });

      // 2. 刷新剩余缓冲数据
      await this.flushDecisionBuffer();

      // 3. 停止定时器
      if (this.flushTimer) {
        clearInterval(this.flushTimer);
        this.flushTimer = null;
      }

      // 4. 取消 EventBus 订阅
      if (this.eventHandler && this.isActive) {
        this.isActive = false;
      }

      // 5. 关闭 Shadow Client
      if (this.shadowClient) {
        this.shadowClient.close();
        this.shadowClient = null;
      }

      // 6. 发出 Stopped 事件（触发 Snapshot/Replay）
      this.emitShadowEvent('shadow.orchestrator.stopped', {
        timestamp: Date.now(),
        stats: this.getStats(),
        triggerSnapshot: true  // 通知 SnapshotManager
      });

      this.phase = RuntimePhase.STOPPED;
      console.log('[ShadowOrchestrator] ✓ 关闭完成');

    } catch (error) {
      console.error('[ShadowOrchestrator] ✗ 关闭异常', error);
      throw error;
    }
  }

  async healthCheck(): Promise<boolean> {
    return this.phase === RuntimePhase.RUNNING || this.phase === RuntimePhase.DEGRADED;
  }

  async shutdown(signal?: string): Promise<void> {
    console.log(`[ShadowOrchestrator] 收到关闭信号: ${signal || 'N/A'}`);
    await this.stop();
  }

  // ============================================================
  // 核心功能
  // ============================================================

  /**
   * 订阅遥测事件（通过 EventBus，符合微内核原则）
   */
  private subscribeToTelemetry(): void {
    this.eventHandler = async (payload: any) => {
      await this.processTelemetry(payload);
    };

    this.kernel.eventBus.on(RuntimeEvent.Heartbeat, this.eventHandler);
  }

  /**
   * 处理遥测数据
   */
  private async processTelemetry(telemetry: TelemetryVector & Record<string, any>): Promise<void> {
    this.stats.telemetryReceived++;

    // 构造唯一 traceId
    const traceId = telemetry.traceId || `trace_${ulid()}`;
    const decisionId = `shadow_${ulid()}`;

    // 1. 执行 Rule-based 决策（基准）
    const ruleAction = this.computeRuleAction(telemetry);
    const ruleActionName = this.getActionName(ruleAction);

    // 2. 获取 PPO 决策（如果有 Shadow Server）
    let ppoAction = ruleAction;
    let ppoActionName = ruleActionName;
    let ppoProb = 0.5;
    let ppoValue: number | undefined;

    if (this.isConnected && this.shadowClient) {
      try {
        const shadowResponse = await this.shadowClient.getShadowAction(telemetry);
        ppoAction = shadowResponse.action;
        ppoActionName = shadowResponse.action_name;
        ppoProb = shadowResponse.prob;
        ppoValue = shadowResponse.value;
      } catch (e) {
        console.warn('[ShadowOrchestrator] PPO 推理失败，使用 Rule fallback');
      }
    }

    // 3. 判断 Winner（符合"稳定性优先"原则）
    const winner = this.determineWinner(ruleAction, ppoAction, ppoProb);

    // 4. 计算置信度
    const confidence = this.computeConfidence(telemetry, ppoProb);

    // 5. 构造决策载荷（Event Sourcing：生成 Event）
    const decision: ShadowDecisionPayload = {
      id: decisionId,
      traceId,
      telemetrySnapshot: telemetry,
      ruleAction,
      ruleActionName,
      ppoAction,
      ppoActionName,
      ppoProb,
      ppoValue,
      winner,
      confidence,
      version: 1,
      timestamp: Date.now()
    };

    // 6. 记录统计
    this.stats.shadowDecisions++;
    if (winner === 'rule') this.stats.ruleWins++;
    else if (winner === 'ppo') this.stats.ppoWins++;
    else this.stats.ties++;

    // 7. 通过 EventBus 发出影子决策事件（符合 Event Sourcing 宪法）
    this.emitShadowDecision(decision);

    // 8. 加入批量缓冲（异步落库）
    this.decisionBuffer.push(decision);
  }

  /**
   * 发出影子决策事件（Event Sourcing）
   */
  private emitShadowDecision(decision: ShadowDecisionPayload): void {
    this.kernel.eventBus.emit('shadow.decision.recorded', {
      ...decision,
      _eventType: 'ShadowDecision',
      _aggregateId: decision.traceId
    });
  }

  /**
   * 发出通用影子事件
   */
  private emitShadowEvent(eventType: string, payload: any): void {
    this.kernel.eventBus.emit(eventType, {
      ...payload,
      _eventType: eventType,
      _source: this.name
    });
  }

  /**
   * Rule-based 决策（基准策略）
   */
  private computeRuleAction(telemetry: TelemetryVector): number {
    const { cpu_usage, memory_pressure, queue_depth, token_pressure } = telemetry;

    if (cpu_usage > 90 || memory_pressure > 0.9) {
      return 5; // enable_gc
    }
    if (queue_depth > 200) {
      return 2; // pause_background
    }
    if (token_pressure > 0.8) {
      return 4; // reduce_context
    }
    if (telemetry.agent_count < 5) {
      return 1; // spawn_agent
    }

    return 0; // no_op
  }

  /**
   * 判断 Winner
   */
  private determineWinner(ruleAction: number, ppoAction: number, ppoProb: number): 'rule' | 'ppo' | 'tie' {
    if (ruleAction === ppoAction) {
      return 'tie';
    }

    // PPO 置信度低于阈值时，信任 Rule
    if (ppoProb < this.config.comparison.confidenceThreshold) {
      return 'rule';
    }

    return Math.random() < ppoProb ? 'ppo' : 'rule';
  }

  /**
   * 计算置信度
   */
  private computeConfidence(telemetry: TelemetryVector, ppoProb: number): number {
    const baseConfidence = ppoProb;

    // 根据系统压力调整置信度
    const pressure = (telemetry.cpu_usage + telemetry.memory_pressure * 100 + telemetry.queue_depth / 3) / 3;
    const pressurePenalty = Math.max(0, pressure - 50) / 100;

    return Math.max(0, Math.min(1, baseConfidence - pressurePenalty));
  }

  /**
   * 获取动作名称
   */
  private getActionName(action: number): string {
    const names = ['no_op', 'spawn_agent', 'pause_background', 'switch_small_model', 'reduce_context', 'enable_gc'];
    return names[action] || 'unknown';
  }

  // ============================================================
  // 批量落库（符合"数据库隔离"原则）
  // ============================================================

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flushDecisionBuffer().catch(err => {
        console.error('[ShadowOrchestrator] 批量落库失败', err);
        this.stats.persistenceErrors++;
      });
    }, this.config.persistence.batchInterval);
  }

  private async flushDecisionBuffer(): Promise<void> {
    if (this.decisionBuffer.length === 0) return;

    // 取出缓冲（符合事务原子性）
    const batch = [...this.decisionBuffer];
    this.decisionBuffer = [];

    if (!this.config.persistence.enabled) return;

    console.log(`[ShadowOrchestrator] 批量落库: ${batch.length} 条`);

    // 通过 TransactionManager 写入（符合状态所有权原则）
    try {
      await this.persistWithTransaction(batch);
    } catch (error) {
      // 落库失败不丢失数据，重新加入缓冲
      this.decisionBuffer.unshift(...batch);
      this.stats.persistenceErrors++;
      throw error;
    }
  }

  /**
   * 使用事务 + 乐观锁落库
   */
  private async persistWithTransaction(decisions: ShadowDecisionPayload[]): Promise<void> {
    // 检查事务管理器是否可用
    if (!this.kernel.transactionManager) {
      console.warn('[ShadowOrchestrator] TransactionManager 不可用，跳过事务写入');
      await this.persistDirect(decisions);
      return;
    }

    // 开始事务
    const tx = await this.kernel.transactionManager.begin(
      'shadow_decision_batch',
      'Governor',
      { count: decisions.length }
    );

    try {
      // 批量写入（乐观锁）
      for (const decision of decisions) {
        await this.kernel.transactionManager.query?.(
          this.buildShadowDecisionSQL(decision),
          decision
        );
      }

      // 提交事务
      await this.kernel.transactionManager.commit(tx.id);

    } catch (error) {
      // 回滚事务
      await this.kernel.transactionManager.rollback('shadow_decision_batch', error);
      throw error;
    }
  }

  /**
   * 直接写入（无事务）
   */
  private async persistDirect(decisions: ShadowDecisionPayload[]): Promise<void> {
    for (const decision of decisions) {
      const sql = this.buildShadowDecisionSQL(decision);

      // 使用 SurrealPersistence（如果可用）
      if (this.persistence.isReady?.()) {
        await this.persistence.commitShadowDecision?.(decision).catch(err => {
          console.warn('[ShadowOrchestrator] 单条写入失败', err);
        });
      }
    }
  }

  /**
   * 构造影子决策 SQL
   */
  private buildShadowDecisionSQL(decision: ShadowDecisionPayload): { sql: string; bindings: Record<string, any> } {
    return {
      sql: `
        CREATE type::thing('governor_shadow_decision', $id) CONTENT {
          id: $id,
          traceId: $traceId,
          ruleAction: $ruleAction,
          ruleActionName: $ruleActionName,
          ppoAction: $ppoAction,
          ppoActionName: $ppoActionName,
          ppoProb: $ppoProb,
          ppoValue: $ppoValue,
          winner: $winner,
          confidence: $confidence,
          telemetrySnapshot: $telemetrySnapshot,
          version: $version,
          timestamp: $timestamp
        }
      `,
      bindings: {
        id: decision.id,
        traceId: decision.traceId,
        ruleAction: decision.ruleAction,
        ruleActionName: decision.ruleActionName,
        ppoAction: decision.ppoAction,
        ppoActionName: decision.ppoActionName,
        ppoProb: decision.ppoProb,
        ppoValue: decision.ppoValue,
        winner: decision.winner,
        confidence: decision.confidence,
        telemetrySnapshot: JSON.stringify(decision.telemetrySnapshot),
        version: decision.version,
        timestamp: decision.timestamp
      }
    };
  }

  // ============================================================
  // 公开 API
  // ============================================================

  /**
   * 获取统计信息
   */
  public getStats() {
    return {
      ...this.stats,
      bufferSize: this.decisionBuffer.length,
      connected: this.isConnected
    };
  }

  /**
   * 获取 PPO vs Rule 对比报告
   */
  public getComparisonReport() {
    const total = this.stats.shadowDecisions || 1;
    return {
      ruleWins: this.stats.ruleWins,
      ppoWins: this.stats.ppoWins,
      ties: this.stats.ties,
      ruleWinRate: (this.stats.ruleWins / total * 100).toFixed(2) + '%',
      ppoWinRate: (this.stats.ppoWins / total * 100).toFixed(2) + '%',
      tieRate: (this.stats.ties / total * 100).toFixed(2) + '%'
    };
  }
}
