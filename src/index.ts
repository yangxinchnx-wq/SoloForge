// ─────────────────────────────────────────────────────────────────
// SoloForge Production Entry: Master Lifecycle Daemon Core
// Path: src/index.ts
// ─────────────────────────────────────────────────────────────────

import { SovereignRuntimeKernel } from './kernel/runtime-kernel';
import { GeminiRustSchedulerClient } from './kernel/scheduler-client';
import { GeminiRTRRacerEngine, ModelStrategyCandidate } from './core/decision/rtr-racer-engine';
import { GeminiConsensAgentCourtRoom, AdjudicationArgumentClaim, SurrealDatabaseInterface } from './core/court/consensagent';
import { GeminiMappoResourceGovernorClient } from './core/governor/mappo-client';

import { DecisionEvent } from './core/events/decision-events';
import { CourtEvent } from './core/events/court-events';

// 严格对齐 Surreal 契约的内存落盘桩，为法庭盲审提供瞬时状态支撑
class SurrealLocalMemoryDriver implements SurrealDatabaseInterface {
  private memoryRegistry = new Map<string, any>();
  
  constructor() {
    // 预埋一条中文字征的合法证据资产
    this.memoryRegistry.set('evidence_secure_token_001', {
      id: 'evidence_secure_token_001',
      credibilityIndex: 0.95,
      relevanceWeight: 0.88,
      temporalRecencyValue: 0.90,
      rawContent: 'SoloForge 自治网络流控调度底座核心安全授信凭证'
    });
  }

  public async query(sqlStatement: string, queryBindings: Record<string, any>): Promise<any[][]> {
    const targetId = queryBindings.id;
    const record = this.memoryRegistry.get(targetId);
    return record ? [[record]] : [[]];
  }
}

class SoloForgeDaemonSupervisor {
  private kernel: SovereignRuntimeKernel;
  private rustScheduler: GeminiRustSchedulerClient;
  private racerEngine: GeminiRTRRacerEngine;
  private courtRoom: GeminiConsensAgentCourtRoom;
  private pythonGovernor: GeminiMappoResourceGovernorClient;
  
  private pollingTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  
  // ✅ 维护一个全盘遥测账本的增量读取指针，防止重复打印
  private lastProcessedLogIndex = 0;

  constructor() {
    console.log('\n[BOOT] ──────────────────────────────────────────────────');
    console.log('[BOOT] 🚀 SoloForge 主自治骨干网络守护进程开始全量总装初始化...');
    
    // 1. 初始化 Layer 1 自治内核所有权宪法底座
    this.kernel = new SovereignRuntimeKernel();

    // 2. 初始化 Layer 4 跨语言 Rust 高性能优先调度客户端
    this.rustScheduler = new GeminiRustSchedulerClient();
    this.rustScheduler.initialize(); // 物理唤醒底层 scheduler_daemon.exe 实体
    console.log('[BOOT] 🦀 Rust 高性能最大堆 Aging 调度守护进程拉起成功.');

    // 3. 总装 Layer 2 RTR-RACER 智能流控决策引擎（硬互锁挂载 Rust 队列）
    this.racerEngine = new GeminiRTRRacerEngine(this.kernel, this.rustScheduler);

    // 4. 总装 Layer 3 司法共识盲审 courtroom
    const dbDriver = new SurrealLocalMemoryDriver();
    this.courtRoom = new GeminiConsensAgentCourtRoom(this.kernel, dbDriver);

    // 5. 拉起跨语言 Python MAPPO 顶置资源控流子进程
    this.pythonGovernor = new GeminiMappoResourceGovernorClient();

    console.log('[BOOT] 🔒 全层级核心组件（TS/Rust/Python）串联完毕，安全护盾全面合拢.');
    console.log('[BOOT] ──────────────────────────────────────────────────\n');
  }

  /**
   * ✅ 增量冲刷账本日志（Pull 模式）：完美对齐 SimpleEventBus 的 .getEventLog() 契约
   */
  private flushTelemetryLogs(): void {
    const eventBus = this.kernel.getEventBus() as any;
    if (!eventBus || typeof eventBus.getEventLog !== 'function') return;

    const allLogs = eventBus.getEventLog();
    for (let i = this.lastProcessedLogIndex; i < allLogs.length; i++) {
      const entry = allLogs[i];
      const eventName = entry.event;
      const data = entry.payload || {};

      switch (eventName) {
        // RTR 流控决策流
        case DecisionEvent.ROUTE_REQUESTED:
          console.log(`[EVENT_RTR] 🔍 接收到流控路由请求 | 候选节点数: ${data.totalCandidates}`);
          break;
        case DecisionEvent.CONFIDENCE_CALCULATED:
          console.log(`[EVENT_RTR] 📊 实时收敛置信度推演值: ${data.confidence?.toFixed(4)}`);
          break;
        case DecisionEvent.VOTE_TRIGGERED:
          console.warn(`[EVENT_RTR] ⚠️ 置信度低！物理交割 Rust 队列，并发激活 ${data.subsetExpandedSize} 路多数博弈投票！`);
          break;
        case DecisionEvent.ADAPTIVE_PENALTY_APPLIED:
          console.warn(`[EVENT_RTR] 📉 触发自学习环境惩罚 -> 节点 [${data.modelName}] 权重降级.`);
          break;

        // 司法盲审流
        case CourtEvent.CLAIM_SUBMITTED:
          console.log(`[EVENT_COURT] ⚖️ 智能法庭介入对抗裁决 | 存疑断言数: ${data.activeClaims}`);
          break;
        case CourtEvent.ARBITRATION_DECIDED:
          console.log(`[EVENT_COURT] 🎉 司法盲审裁决完成！胜出节点签名: [${data.winner}]`);
          break;
        case CourtEvent.DEADLOCK_DETECTED:
          console.error(`[EVENT_COURT] 🚨 触发平局死锁保护机制！胜出分差过小，流控硬性拦截挂起。`);
          break;
      }
    }
    // 指针前移，确保下一轮循环只消费增量数据
    this.lastProcessedLogIndex = allLogs.length;
  }

  /**
   * 启动常驻主循环
   */
  public startRuntimeEventLoop(): void {
    console.log('[RUNTIME] 🌀 全链路跨语言控流主循环已点火. 正在监控系统性能拓扑...\n');

    let cycleCounter = 0;

    this.pollingTimer = setInterval(async () => {
      if (this.isShuttingDown) return;
      cycleCounter++;

      console.log(`\n--- [CYCLE #${cycleCounter}] 拓扑脉冲扫描开始 ---`);

      // ─────────────────────────────────────────────────────────────
      // 📝 阶段一：高并发状态下的动态物理资源上报（对接 Python MAPPO 顶置降级）
      // ─────────────────────────────────────────────────────────────
      const mockCpu = cycleCounter % 4 === 0 ? 0.96 : 0.45; 
      const globalState = [mockCpu, 0.35, 0.12];
      const localObs = [0.0, 0.0];

      try {
        const action = await this.pythonGovernor.evaluateMappoResourceVector(globalState, localObs);
        console.log(`[TELEMETRY] 🐍 Python MAPPO 推理响应完成 | 负载: ${mockCpu} | 决策 Action: ${action}`);

        if (action === 2) {
          console.error(`[CIRCUIT_BREAKER] 🚨 触发最高优先级别熔断！Python 拒绝向下游分发请求！`);
          this.flushTelemetryLogs(); // 熔断前也要冲刷日志
          return; 
        }
      } catch (err) {
        console.error(`[IPC_ERROR] Python 遥测流水线阻断:`, (err as Error).message);
      }

      // ─────────────────────────────────────────────────────────────
      // 📝 阶段二：多智能体任务涌入（对接 TS 流控引擎 + Rust 高性能自愈老化队列）
      // ─────────────────────────────────────────────────────────────
      const candidates: ModelStrategyCandidate[] = [
        { modelName: 'agent-alpha-fast', reasoningStrategy: 'direct', baseGenerationQuality: 0.7, normalizedLatencyScore: 0.9, normalizedCostEfficiency: 0.8, historicalSuccessIndex: 0.85 },
        { modelName: 'agent-beta-heavy', reasoningStrategy: 'chain_of_thought', baseGenerationQuality: 0.95, normalizedLatencyScore: 0.3, normalizedCostEfficiency: 0.4, historicalSuccessIndex: 0.90 },
        { modelName: 'agent-gamma-unstable', reasoningStrategy: 'few_shot', baseGenerationQuality: 0.6, normalizedLatencyScore: 0.6, normalizedCostEfficiency: 0.5, historicalSuccessIndex: 0.40 }
      ];

      const targetStateKey = 'core_scheduler_memory'; 
      const globalConfidenceMetric = 0.2; 
      const taskComplexityMetrics = 0.9; 

      try {
        const workerExecutionStub = async (chosen: ModelStrategyCandidate) => {
          return `SUCCESS_UPSTREAM_RESPONSE_FROM_${chosen.modelName.toUpperCase()}`;
        };

        const finalRouteOutput = await this.racerEngine.coordinateRacerFlow(
          candidates,
          targetStateKey,
          true, 
          globalConfidenceMetric,
          taskComplexityMetrics,
          workerExecutionStub,
          { globalFailureRate: 0.2 }
        );

        console.log(`[FLOW_COMPLETED] 🎯 核心流控总控分发成功. 最终归集输出: ${finalRouteOutput}`);
      } catch (flowException) {
        console.error(`[CORE_FLOW_ERROR] 流控主链塌陷:`, (flowException as Error).message);
      }

      // ─────────────────────────────────────────────────────────────
      // 📝 阶段三：模拟突发状态争议冲突（对接 Layer 3 司法盲审法庭）
      // ─────────────────────────────────────────────────────────────
      if (cycleCounter % 2 === 0) {
        console.log(`[TRIGGER] ⚖️ 触发时序状态所有权存疑冲突，唤醒自治法庭...`);
        
        this.courtRoom.enforcePhase1LockState(true);

        const disputeKey = 'court_case_registry_session_active';
        const claims: AdjudicationArgumentClaim[] = [
          {
            originatingAgentId: 'agent-alpha-fast',
            disputedClaimStatement: '自治网络流控调度底座核心', 
            linkedEvidenceRegistry: ['evidence_secure_token_001'] 
          },
          {
            originatingAgentId: 'agent-gamma-unstable',
            disputedClaimStatement: '破坏性篡改篡改',
            linkedEvidenceRegistry: ['evidence_fraud_pointer_999'] 
          }
        ];

        try {
          const verdict = await this.courtRoom.executeEvidentiaryArbitration(claims, disputeKey);
          console.log(`[COURT_VERDICT] 🏛️ 法庭最终结论: 状态=${verdict.verdictResolutionStatus} | 胜诉者=${verdict.winningAgentSignature} | 最终得分=${verdict.adjudicatedMetricScore.toFixed(2)}`);
        } catch (courtErr) {
          console.error(`[COURT_FAULT] 法庭审理程序性崩溃:`, (courtErr as Error).message);
        }
      }

      // ⚡ 脉冲收尾：物理刷盘打印当前周期产生的所有内核账目日志
      this.flushTelemetryLogs();

    }, 2000); 
  }

  /**
   * 工业级优雅关机守卫：彻底斩断跨语言孤儿进程残留
   */
  public async terminateGracefully(signalSource: string): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    
    console.log('\n[SHUTDOWN] ──────────────────────────────────────────────');
    console.log(`[SHUTDOWN] 🛑 捕获到操作系统级终止信号 [${signalSource}]. 开始回收全链路跨语言常驻句柄...`);

    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
    }

    try {
      this.rustScheduler.shutdown();
      console.log('[SHUTDOWN] 🦀 Rust 高性能老化调度引擎底层二进制句柄已安全注销。');

      this.pythonGovernor.safelyTerminateGovernorContext();
      console.log('[SHUTDOWN] 🐍 Python 资源控流常驻推理管道已物理回收。');
    } catch (e) {
      console.error('[SHUTDOWN_ERROR] 跨语言常驻句柄回收出现残余破损:', e);
    }

    console.log('[SHUTDOWN] 🏆 核心层、控制层全链状态圆满归档，骨干网平稳闭合. [PASS]');
    console.log('[SHUTDOWN] ──────────────────────────────────────────────');
    process.exit(0);
  }
}

const supervisor = new SoloForgeDaemonSupervisor();
supervisor.startRuntimeEventLoop();

process.on('SIGINT', () => supervisor.terminateGracefully('SIGINT'));
process.on('SIGTERM', () => supervisor.terminateGracefully('SIGTERM'));