// ─────────────────────────────────────────────────────────────────
// SoloForge Judicial Assembly: CONSENSAGENT Sovereign Multi-Agent Court Room
// Path: src/core/court/consensagent.ts
// Description: 司法仲裁室 - 两阶段盲审、死锁防御、LLM 升级
// ─────────────────────────────────────────────────────────────────

import { CourtEvent } from '../events/court-events';
import { RuntimeKernel, RuntimeKernelInterface } from '../decision/rtr-racer-engine';

// ============================================================
// 类型定义
// ============================================================

export interface LegalEvidenceNode {
  id: string;
  credibilityIndex: number;
  relevanceWeight: number;
  temporalRecencyValue: number;
  rawContent: string;
}

export interface AdjudicationArgumentClaim {
  originatingAgentId: string;
  disputedClaimStatement: string;
  linkedEvidenceRegistry: string[];
}

export interface JudicialVerdictEnvelope {
  verdictResolutionStatus: 'DECIDED_LEGITIMATE' | 'CONSERVATIVE_DEADLOCK_TRIGGER' | 'ESCAPE_ROUTING_TO_HUMAN';
  winningAgentSignature: string | null;
  adjudicatedMetricScore: number;
}

/**
 * SurrealDB 数据库接口
 */
export interface SurrealDatabaseInterface {
  query(sqlStatement: string, queryBindings: Record<string, any>): Promise<any[][]>;
}

// ============================================================
// 司法仲裁室实现
// ============================================================

export class GeminiConsensAgentCourtRoom {
  private kernel: RuntimeKernelInterface;
  private databaseDriver: SurrealDatabaseInterface;
  private readonly domainSignature = 'JudicialCourt';
  private isPhase1Locked = false;

  constructor(kernelInstance: RuntimeKernelInterface, wiredSurrealDbInstance: SurrealDatabaseInterface) {
    this.kernel = kernelInstance;
    this.databaseDriver = wiredSurrealDbInstance;
  }

  /**
   * 设置 Phase 1 锁定状态
   */
  public enforcePhase1LockState(locked: boolean): void {
    this.isPhase1Locked = locked;
    this.kernel.getEventBus().emit(CourtEvent.EVIDENCE_EVALUATED, { status: locked ? 'PHASE_1_LOCKED' : 'PHASE_1_OPEN' });
  }

  /**
   * 中英双语多模态子序列交叉关联匹配评估器
   */
  private calculateChineseSafeRelevance(content: string, dispute: string): number {
    const cleanContent = content.toLowerCase();
    const cleanDispute = dispute.toLowerCase();

    // 精确匹配
    if (cleanContent.includes(cleanDispute) || cleanDispute.includes(cleanContent)) return 1.0;

    // 包含匹配
    const contentChars = new Set(cleanContent.replace(/\s/g, ''));
    let matchingChars = 0;

    for (const char of cleanDispute) {
      if (contentChars.has(char)) matchingChars++;
    }

    return matchingChars / Math.max(1, cleanDispute.length);
  }

  /**
   * 证据权重计算公式
   */
  private calculateEvidenceWeightFormula(evidence: LegalEvidenceNode, disputeText: string): number {
    const contextualRelevance = this.calculateChineseSafeRelevance(evidence.rawContent, disputeText);
    return (evidence.credibilityIndex * 0.5) + (contextualRelevance * 0.3) + (evidence.temporalRecencyValue * 0.2);
  }

  /**
   * 两阶段证据隔离链社会学裁决主方法
   */
  public async executeEvidentiaryArbitration(
    argumentsList: AdjudicationArgumentClaim[],
    statePathKey: string
  ): Promise<JudicialVerdictEnvelope> {
    // 1. 严格主链拦截
    if (!this.kernel.verifyOwnership(this.domainSignature, statePathKey)) {
      throw new Error(`[COURT_CRITICAL] 🚨 Access Denied: Unauthorized state modification block at key [${statePathKey}]`);
    }

    if (!this.isPhase1Locked) {
      throw new Error("ERR_COURT_FLOW_VIOLATION: Court room arbitration must execute strictly inside Phase 2 lock barriers.");
    }

    this.kernel.getEventBus().emit(CourtEvent.CLAIM_SUBMITTED, { activeClaims: argumentsList.length });

    // 2. 校准声明分数
    const calibratedClaims = await Promise.all(argumentsList.map(async (argument) => {
      let cumulativeEvidenceScore = 0;

      for (const targetEvidenceId of argument.linkedEvidenceRegistry) {
        try {
          const rawDbQueryExecution = await this.databaseDriver.query(
            'SELECT * FROM evidence WHERE id = $id',
            { id: targetEvidenceId }
          );

          const localizedEvidenceRecord = rawDbQueryExecution[0]?.[0] as unknown as LegalEvidenceNode;

          if (!localizedEvidenceRecord) {
            // 虚假引流引用，直接跳过，拒绝伪造分数
            console.warn(`[JUDICIAL_ALERT] Fraud Detected. Non-existent evidence pointer [${targetEvidenceId}] stripped.`);
            continue;
          }

          cumulativeEvidenceScore += this.calculateEvidenceWeightFormula(localizedEvidenceRecord, argument.disputedClaimStatement);
        } catch (dbReadIsolationException) {
          continue;
        }
      }
      return { ...argument, score: cumulativeEvidenceScore };
    }));

    // 3. 证据度量降序重排
    calibratedClaims.sort((nodeX, nodeY) => nodeY.score - nodeX.score);

    const undisputedWinnerNode = calibratedClaims[0];
    const immediateRunnerUpNode = calibratedClaims[1];

    // 4. 不可逆高风险破坏硬熔断升级
    if (undisputedWinnerNode.disputedClaimStatement.includes('IRREVERSIBLE_DESTRUCTION_OPERATION') ||
        undisputedWinnerNode.disputedClaimStatement.includes('物理删库')) {
      this.kernel.getEventBus().emit(CourtEvent.ESCALATION_TRIGGERED, { target: undisputedWinnerNode.originatingAgentId });
      return { verdictResolutionStatus: 'ESCAPE_ROUTING_TO_HUMAN', winningAgentSignature: null, adjudicatedMetricScore: 0 };
    }

    // 5. 死锁检测：严格判定 Winner 与 Runner-Up 之间的分差
    if (immediateRunnerUpNode && (undisputedWinnerNode.score - immediateRunnerUpNode.score) < 0.1) {
      this.kernel.getEventBus().emit(CourtEvent.DEADLOCK_DETECTED, {
        winner: undisputedWinnerNode.score,
        runnerUp: immediateRunnerUpNode.score
      });
      return { verdictResolutionStatus: 'CONSERVATIVE_DEADLOCK_TRIGGER', winningAgentSignature: null, adjudicatedMetricScore: 0 };
    }

    // 6. 正常裁决
    this.kernel.getEventBus().emit(CourtEvent.ARBITRATION_DECIDED, { winner: undisputedWinnerNode.originatingAgentId });

    return {
      verdictResolutionStatus: 'DECIDED_LEGITIMATE',
      winningAgentSignature: undisputedWinnerNode.originatingAgentId,
      adjudicatedMetricScore: undisputedWinnerNode.score
    };
  }
}
