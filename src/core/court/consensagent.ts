// src/core/court/consensagent.ts
import crypto from 'crypto';
import { RuntimeKernel } from '../../kernel/runtime-kernel';
import { CourtEvent } from '../events/court-events'; // ð Static anchored enum system
import { logger } from '../logger';

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
  verdictId: string;
  verdictResolutionStatus: 'DECIDED_LEGITIMATE' | 'CONSERVATIVE_DEADLOCK_TRIGGER' | 'ESCAPE_ROUTING_TO_LLM';
  winningAgentSignature: string | null;
  adjudicatedMetricScore: number;
  kernelVersionSeal: number;
  timestamp: number;
}

/**
 * ðï¸ Hardened Consensual Multi-Agent Courtroom Engine
 * Responsibility: Manages primary legal cross-examinations under strict two-phase serialization.
 * Design Spec: Eradicates raw inline SQL queries to preserve domain purity.
 */
export class ConsensAgentCourtRoom {
  private isOperational = false;
  private readonly moduleName = 'ConsensAgentCourt';
  private isPhase1Locked = false;

  constructor(private kernel: RuntimeKernel) {
    if (!kernel || !kernel.transactionManager || !kernel.commandBus || !kernel.eventBus || !kernel.configCenter) {
      throw new Error('CRITICAL_SF_CONSTITUTION: Micro-kernel transaction orchestrators must be fully pre-bound.');
    }
  }

  public async bootCourtRoom(): Promise<void> {
    if (this.isOperational) return;

    // Register atomic primary arbitration handler directly to the central CommandBus
    this.kernel.commandBus.registerHandler('EXECUTE_EVIDENTIARY_ARBITRATION', async (command: any) => {
      return this.handleArbitrationTransaction(command);
    });

    this.isOperational = true;
    logger.info(this.moduleName, 'ðï¸ [OS Phase 3 Court Core] Hardened multi-agent evidentiary tribunal live.');
  }

  public enforcePhase1LockState(locked: boolean): void {
    this.isPhase1Locked = locked;
    this.kernel.eventBus.emit(CourtEvent.EVIDENCE_EVALUATED, { status: locked ? 'PHASE_1_LOCKED' : 'PHASE_1_OPEN' });
  }

  private calculateChineseSafeRelevance(content: string, dispute: string): number {
    if (!content || !dispute) return 0.0;
    const cleanContent = content.toLowerCase();
    const cleanDispute = dispute.toLowerCase();

    if (cleanContent.includes(cleanDispute) || cleanDispute.includes(cleanContent)) return 1.0;

    const contentChars = new Set(cleanContent.replace(/\s/g, ''));
    let matchingChars = 0;

    for (const char of cleanDispute) {
      if (contentChars.has(char)) matchingChars++;
    }
    return matchingChars / Math.max(1, cleanDispute.length);
  }

  private calculateEvidenceWeightFormula(evidence: LegalEvidenceNode, disputeText: string): number {
    const cc = this.kernel.configCenter;
    // ð Fix Audit Item 4: Pull formula coefficients dynamically from center to eradicate magic digits
    const wCred = cc.get('society.court.weight_credibility', 0.5);
    const wRel = cc.get('society.court.weight_relevance', 0.3);
    const wTime = cc.get('society.court.weight_temporal', 0.2);

    const contextualRelevance = this.calculateChineseSafeRelevance(evidence.rawContent, disputeText);
    return (evidence.credibilityIndex * wCred) + (contextualRelevance * wRel) + (evidence.temporalRecencyValue * wTime);
  }

  /**
   * ðï¸ Command Handler: Two-Phase Version Checked Arbitrator Pipeline
   */
  private async handleArbitrationTransaction(command: any): Promise<any> {
    const { traceId, argumentsList, evidenceSnapshotMap } = command.payload;

    if (!this.isPhase1Locked) {
      throw new Error("ERR_COURT_FLOW_VIOLATION: Adjudication loop must be strictly isolated inside Phase 1 locked barriers.");
    }

    // ð [Optimistic Locking Phase 1]: Lock down state fingerprint prior to long-turn loop logic
    const initialVersion = this.kernel.version;
    const tx = await this.kernel.transactionManager.begin(
      command.id || crypto.randomUUID(),
      this.moduleName,
      { traceId, initialVersionStamp: initialVersion }
    );

    try {
      this.kernel.eventBus.emit(CourtEvent.CLAIM_SUBMITTED, { activeClaims: argumentsList.length });

      // Process evidentiary metrics directly mapping from memory-safe input view slices
      const calibratedClaims = argumentsList.map((argument: AdjudicationArgumentClaim) => {
        let cumulativeEvidenceScore = 0.0;

        for (const targetEvidenceId of argument.linkedEvidenceRegistry) {
          const localEvidenceRecord = evidenceSnapshotMap[targetEvidenceId] as LegalEvidenceNode;
          if (!localEvidenceRecord) {
            this.pushMetrics('society.court.fraud_pointers_stripped', 1);
            continue; // Evict missing pointers to block scoring exploitation
          }
          cumulativeEvidenceScore += this.calculateEvidenceWeightFormula(localEvidenceRecord, argument.disputedClaimStatement);
        }
        return { ...argument, score: cumulativeEvidenceScore };
      });

      calibratedClaims.sort((nodeX: any, nodeY: any) => nodeY.score - nodeX.score);
      const undisputedWinnerNode = calibratedClaims[0];
      const immediateRunnerUpNode = calibratedClaims[1];

      let verdictEnvelope: JudicialVerdictEnvelope = {
        verdictId: `verd_1st_${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}`,
        verdictResolutionStatus: 'DECIDED_LEGITIMATE',
        winningAgentSignature: undisputedWinnerNode?.originatingAgentId || null,
        adjudicatedMetricScore: undisputedWinnerNode?.score || 0.0,
        kernelVersionSeal: initialVersion,
        timestamp: Date.now()
      };

      // 3. Heuristic high-risk destruction auto-circuit breaker triggers escape escalation
      if (undisputedWinnerNode?.disputedClaimStatement.includes('IRREVERSIBLE_DESTRUCTION_OPERATION')) {
        verdictEnvelope.verdictResolutionStatus = 'ESCAPE_ROUTING_TO_LLM';
        verdictEnvelope.winningAgentSignature = null;
        this.kernel.eventBus.emit(CourtEvent.ESCALATION_TRIGGERED, { target: undisputedWinnerNode.originatingAgentId });
      }

      // 4. Structural Deadlock Detector: trigger immediate higher LLM Supreme review if score delta is razor-thin
      const cc = this.kernel.configCenter;
      const deadlockDeltaBar = cc.get('society.court.deadlock_delta_bar', 0.1);

      if (verdictEnvelope.verdictResolutionStatus === 'DECIDED_LEGITIMATE' &&
          immediateRunnerUpNode && (undisputedWinnerNode.score - immediateRunnerUpNode.score) < deadlockDeltaBar) {
        verdictEnvelope.verdictResolutionStatus = 'CONSERVATIVE_DEADLOCK_TRIGGER';
        verdictEnvelope.winningAgentSignature = null;
        this.kernel.eventBus.emit(CourtEvent.DEADLOCK_DETECTED, { winner: undisputedWinnerNode.score, runnerUp: immediateRunnerUpNode.score });
      }

      // ð [Optimistic Locking Phase 2]: Intercept and abort transaction if state owner mismatched
      if (this.kernel.version !== initialVersion) {
        throw new Error(`ERR_SF_COURT_RACE: Macro state evolved during core courtroom processing lifecycle.`);
      }

      tx.payload = {
        ...tx.payload,
        verdict_id: verdictEnvelope.verdictId,
        status_seal: verdictEnvelope.verdictResolutionStatus,
        winner_signature: verdictEnvelope.winningAgentSignature,
        metric_score: verdictEnvelope.adjudicatedMetricScore,
        finalized_at: verdictEnvelope.timestamp
      };

      // ð§± Commit ownership: EventBus fires standard completed facts notice onto unified sink consumers
      await this.kernel.transactionManager.commit(tx.id);

      if (verdictEnvelope.verdictResolutionStatus === 'DECIDED_LEGITIMATE') {
        this.kernel.eventBus.emit(CourtEvent.ARBITRATION_DECIDED, { winner: verdictEnvelope.winningAgentSignature });
        this.pushMetrics('society.court.arbitrations_decided_total', 1);
      } else {
        // Cascade structural escape commands directly up to the LLM Escalation Room node
        await this.kernel.executeCommand({
          id: crypto.randomUUID(),
          type: 'RESOLVE_SUPREME_JUDICIAL_DEADLOCK',
          domain: this.moduleName,
          caller: 'PRIMARY_COURTROOM_CIRCUIT',
          payload: { traceId, failedCaseId: verdictEnvelope.verdictId, suspiciousManifesto: undisputedWinnerNode?.disputedClaimStatement || '' }
        });
      }

      return verdictEnvelope;

    } catch (panic: any) {
      await this.kernel.transactionManager.rollback(tx.commandId, panic);
      this.pushMetrics('society.court.failures_count', 1);
      throw panic;
    }
  }

  private pushMetrics(metricName: string, value: number) {
    if (this.kernel?.metricsCollector?.counter) {
      this.kernel.metricsCollector.counter(metricName, value, { domain: 'society', layer: 'court_primary' });
    }
  }
}
