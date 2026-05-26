// ─────────────────────────────────────────────────────────────────
// SoloForge Judicial Assembly: CONSENSAGENT Sovereign Multi-Agent Court Room
// Path: src/core/court/consensagent.ts
// ─────────────────────────────────────────────────────────────────

import { CourtEvent } from '../events/court-events';
import { RuntimeKernelInterface } from '../decision/rtr-racer-engine';

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

export interface SurrealDatabaseInterface {
  query(sqlStatement: string, queryBindings: Record<string, any>): Promise<any[][]>;
}

export class GeminiConsensAgentCourtRoom {
  private kernel: RuntimeKernelInterface;
  private databaseDriver: SurrealDatabaseInterface;
  private readonly domainSignature = 'JudicialCourt';
  private isPhase1Locked = false;

  constructor(kernelInstance: RuntimeKernelInterface, wiredSurrealDbInstance: SurrealDatabaseInterface) {
    this.kernel = kernelInstance;
    this.databaseDriver = wiredSurrealDbInstance;
  }

  public enforcePhase1LockState(locked: boolean): void {
    this.isPhase1Locked = locked;
    this.kernel.getEventBus().emit(CourtEvent.EVIDENCE_EVALUATED, { status: locked ? 'PHASE_1_LOCKED' : 'PHASE_1_OPEN' });
  }

  /// ✅ 纯血中英双语多模态子序列交叉关联匹配评估器
  private calculateChineseSafeRelevance(content: string, dispute: string): number {
    const cleanContent = content.toLowerCase();
    const cleanDispute = dispute.toLowerCase();
    if (cleanContent.includes(cleanDispute) || cleanDispute.includes(cleanContent)) return 1.0;
    
    let matchingChars = 0;
    for (const char of cleanDispute) {
      if (cleanContent.includes(char)) matchingChars++;
    }
    return matchingChars / Math.max(1, cleanDispute.length);
  }

  private calculateEvidenceWeightFormula(evidence: LegalEvidenceNode, disputeText: string): number {
    const contextualRelevance = this.calculateChineseSafeRelevance(evidence.rawContent, disputeText);
    return (evidence.credibilityIndex * 0.5) + (contextualRelevance * 0.3) + (evidence.temporalRecencyValue * 0.2);
  }

  /**
   * Phase 2 两阶段证据隔离链社会学裁决主方法
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
            // ✅ Bug #7 彻底抹平：虚假引流引用，直接 continue 剥离，拒绝伪造分数
            console.warn(`[JUDICIAL_ALERT] Sibil Fraud Detected. Non-existent evidence pointer [${targetEvidenceId}] stripped.`);
            continue; 
          }

          cumulativeEvidenceScore += this.calculateEvidenceWeightFormula(localizedEvidenceRecord, argument.disputedClaimStatement);
        } catch (dbReadIsolationException) {
          continue;
        }
      }
      return { ...argument, score: cumulativeEvidenceScore };
    }));

    // 2. 证据度量降序重排
    calibratedClaims.sort((nodeX, nodeY) => nodeY.score - nodeX.score);
    
    const undisputedWinnerNode = calibratedClaims[0];
    const immediateRunnerUpNode = calibratedClaims[1];

    // 不可逆高风险破坏硬熔断升级
    if (undisputedWinnerNode.disputedClaimStatement.includes('IRREVERSIBLE_DESTRUCTION_OPERATION')) {
      this.kernel.getEventBus().emit(CourtEvent.ESCALATION_TRIGGERED, { target: undisputedWinnerNode.originatingAgentId });
      return { verdictResolutionStatus: 'ESCAPE_ROUTING_TO_HUMAN', winningAgentSignature: null, adjudicatedMetricScore: 0 };
    }

    // ✅ 完美修复 Flaw #2：严格判定 Winner 与 Runner-Up（第二名）之间的分差
    if (immediateRunnerUpNode && (undisputedWinnerNode.score - immediateRunnerUpNode.score) < 0.1) {
      this.kernel.getEventBus().emit(CourtEvent.DEADLOCK_DETECTED, { winner: undisputedWinnerNode.score, runnerUp: immediateRunnerUpNode.score });
      return { verdictResolutionStatus: 'CONSERVATIVE_DEADLOCK_TRIGGER', winningAgentSignature: null, adjudicatedMetricScore: 0 };
    }

    this.kernel.getEventBus().emit(CourtEvent.ARBITRATION_DECIDED, { winner: undisputedWinnerNode.originatingAgentId });

    return {
      verdictResolutionStatus: 'DECIDED_LEGITIMATE',
      winningAgentSignature: undisputedWinnerNode.originatingAgentId,
      adjudicatedMetricScore: undisputedWinnerNode.score
    };
  }
}