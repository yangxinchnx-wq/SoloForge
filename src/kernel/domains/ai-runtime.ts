// ─────────────────────────────────────────────────────────────────
// SoloForge Layer 2: Pluggable AI Runtime Domain Card
// Path: src/kernel/domains/ai-runtime.ts
// ─────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import { RuntimeKernel } from '../runtime-kernel';
import { logger } from '../../core/logger';
import { GeminiRTRRacerEngine } from '../../core/decision/rtr-racer-engine';
import { GeminiConsensAgentCourtRoom } from '../../core/court/consensagent';
import { LlmEscalationRoom } from '../../core/court/llm_escalation';
import { AutonomousNetworkAgent } from '../../core/agent/autonomous_agent';

export class AIRuntimeModule {
  private racerEngine: GeminiRTRRacerEngine;
  private courtRoom: GeminiConsensAgentCourtRoom;
  private llmSupremeCourt: LlmEscalationRoom;
  private agents: AutonomousNetworkAgent[] = [];

  constructor(
    private kernel: RuntimeKernel,
    private liveDriver: any,
    private rustScheduler: any
  ) {
    this.racerEngine = new GeminiRTRRacerEngine(this.kernel, this.rustScheduler);
    this.courtRoom = new GeminiConsensAgentCourtRoom(this.kernel, this.liveDriver);
    this.llmSupremeCourt = new LlmEscalationRoom();

    this.agents = [
      new AutonomousNetworkAgent('agent-alpha-fast-edge', 'direct', 1.0),
      new AutonomousNetworkAgent('agent-beta-heavy-thought', 'chain_of_thought', 1.0),
      new AutonomousNetworkAgent('agent-gamma-unstable-intruder', 'few_shot', 0.8)
    ];
  }

  /**
   * 🔌 主权挂载：自发向内核注册本领地所能承接的一切原子指令
   */
  public mount(): void {
    if (!this.kernel.commandBus) return;

    // 1. 注册决策落盘指令处理器
    this.kernel.commandBus.registerHandler('DECISION_COMMIT', async (cmd) => {
      logger.debug('AIRuntimeModule', 'Processing DECISION_COMMIT DML transaction...');
      return cmd.payload;
    });

    // 2. 注册司法案卷提交处理器
    this.kernel.commandBus.registerHandler('COURT_COMMIT_SUBMISSION', async (cmd) => {
      logger.debug('AIRuntimeModule', 'Processing COURT_COMMIT_SUBMISSION DML transaction...');
      return cmd.payload;
    });

    this.kernel.registerDomain('AIRuntime', this);
    logger.info('AIRuntimeModule', '🚀 AI 智能体/决策/司法自治板卡全量接口契约挂载完毕。');
  }

  /**
   * ⚡ 承接大盘脉冲：触发流控竞价业务
   */
  public async tickRacerFlow(runtimeUuid: string, mockCpu: number): Promise<void> {
    const currentPacketSize = Math.floor(100 + Math.random() * 800);
    const dynamicCandidates = this.agents.map(agent => agent.generateRoutingCandidateState(mockCpu));
    const targetStateKey = 'core_scheduler_memory';

    const workerExecutionStub = async (chosen: any) => {
      const winnerInstance = this.agents.find(a => a.agentId === chosen.modelName);
      if (!winnerInstance) throw new Error(`CRITICAL_ORPHAN_AGENT: ${chosen.modelName}`);
      return await winnerInstance.executeNetworkPacketTask(runtimeUuid, currentPacketSize);
    };

    const finalRouteOutput = await this.racerEngine.coordinateRacerFlow(
      dynamicCandidates,
      targetStateKey,
      true,
      0.2,
      0.9,
      workerExecutionStub,
      { globalFailureRate: 0.2 }
    );

    logger.info('AIRuntimeModule', `🎯 RACER Flow executed inside kernel: ${finalRouteOutput}`);

    // 🛡️ 通过微内核标准指令发布状态改写，冲刷五道红线
    await this.kernel.executeCommand({
      type: 'DECISION_COMMIT',
      domain: 'AIRuntime',
      caller: 'SYSTEM_MASTER_DAEMON',
      payload: {
        id: `decision_${runtimeUuid}`,
        traceId: runtimeUuid,
        selectedStrategy: 'dynamic_marl_routing',
        strategyReason: `Result: ${finalRouteOutput}`,
        budgetUsed: Math.floor(currentPacketSize / 10),
        budgetLimit: 100,
        confidenceTier: 'high',
        subsetSize: this.agents.length,
        aggregationMethod: 'racer_heap_sort',
        aggregatedCandidates: dynamicCandidates.map(c => c.modelName)
      }
    });
  }

  /**
   * ⚡ 承接大盘脉冲：唤醒自治盲审法庭
   */
  public async tickJudicialCourt(runtimeUuid: string): Promise<void> {
    this.courtRoom.enforcePhase1LockState(true);
    const disputeKey = 'court_case_registry_session_active';
    
    const dynamicClaims = [
      this.agents[0].forgeDisputeClaim('确权核心路由底座主权', 'legitimate'),
      this.agents[2].forgeDisputeClaim('破坏性越权篡改重排', 'sybil_fraud')
    ];

    const verdict = await this.courtRoom.executeEvidentiaryArbitration(dynamicClaims, disputeKey);
    let finalStatus = verdict.verdictResolutionStatus === 'DECIDED_LEGITIMATE' ? 'complete' : 'phase_1';
    let decisionText = `Blind crypto audit winner: ${verdict.winningAgentSignature}`;

    if (verdict.verdictResolutionStatus === 'CONSERVATIVE_DEADLOCK_TRIGGER') {
      logger.warn('AIRuntimeModule', '🚨 一审陷入死锁！越级呼叫最高大模型终审庭剖析高级语义...');
      
      // 动态反转内核模式为 SANDBOX 推演宇宙，防止污染持久层
      this.kernel.setMode(2 as any); // 进入分叉宇宙推演
      
      const supremeVerdict = await this.llmSupremeCourt.adjudicateDeadlock(runtimeUuid, null as any);
      finalStatus = 'complete';
      decisionText = supremeVerdict.adjudicationReason;

      this.kernel.setMode(0 as any); // 平滑切回正常宇宙

      if (supremeVerdict.finalWinner) {
        this.agents.find(a => a.agentId === supremeVerdict.finalWinner)?.rewardReputation(0.08);
      }
      if (supremeVerdict.sanctionedLoser) {
        this.agents.find(a => a.agentId === supremeVerdict.sanctionedLoser)?.penalizeReputation(0.25);
      }
    }

    await this.kernel.executeCommand({
      type: 'COURT_COMMIT_SUBMISSION',
      domain: 'AIRuntime',
      caller: 'SYSTEM_MASTER_DAEMON',
      payload: {
        id: `court_${runtimeUuid}`,
        traceId: runtimeUuid,
        phase: finalStatus as any,
        phase1Deadline: Math.floor(Date.now() / 1000) + 3600,
        judgmentBasis: decisionText,
        winnerScore: verdict.adjudicatedMetricScore || 1.0,
        loserScore: 0.0,
        escalatedToHuman: false,
        escalationReason: 'NONE'
      }
    });
  }
}