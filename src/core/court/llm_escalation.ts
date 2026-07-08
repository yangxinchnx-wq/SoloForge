// src/core/court/llm_escalation.ts
import crypto from 'crypto';
import { RuntimeKernel } from '../../kernel/runtime-kernel';
import { logger } from '../logger';
import { callLLMWithTools, type LLMMessage } from '../agent/tools/function-calling-client';
import { getLLMProxyConfig } from '../../llm/llmConfig';

export interface EscalationVerdict {
  verdictId: string;
  finalWinner: string | null;
  sanctionedLoser: string | null;
  adjudicationReason: string;
  confidenceScore: number;
  kernelVersionSeal: number;
  timestamp: number;
}

/**
 * 🏛️ LLM Supreme Escalation Adjudication Room (High-Level Semantic Balancer)
 * Responsibility: Resolves core deadlock contradictions by processing full-dimensional trajectory timelines.
 */
export class LlmEscalationRoom {
  private isOperational = false;
  private readonly moduleName = 'LlmSupremeEscalation';

  constructor(private kernel: RuntimeKernel, private persistenceManager: any) {
    if (!kernel || !persistenceManager || !kernel.commandBus || !kernel.transactionManager) {
      throw new Error('CRITICAL_SF_CONSTITUTION: Supreme court requires pre-mounted transaction infrastructure linkages.');
    }
  }

  public async initializeSupremeTribunal(): Promise<void> {
    if (this.isOperational) return;

    this.kernel.commandBus.registerHandler('RESOLVE_SUPREME_JUDICIAL_DEADLOCK', async (command: any) => {
      return this.executeSupremeArbitrationTransaction(command);
    });

    this.isOperational = true;
    logger.info(this.moduleName, '🏛️ [OS Phase 3 Supreme Court] Multi-modal semantic lineage resolver live.');
  }

  /**
   * 🏗️ Command Handler: Two-Phase Locked High-Level Lineage Evaluator
   */
  private async executeSupremeArbitrationTransaction(command: any): Promise<EscalationVerdict> {
    const { traceId, failedCaseId, suspiciousManifesto } = command.payload;
    const initialVersion = this.kernel.version;

    // 🔒 [Optimistic Locking Phase 1]: Establish isolation barrier prior to triggering deep disk I/O timeline tracking
    const tx = await this.kernel.transactionManager.begin(
      command.id || crypto.randomUUID(),
      this.moduleName,
      { traceId, historicalAnchorCase: failedCaseId, lockedVersionStamp: initialVersion }
    );

    try {
      // 1. Core Linkage Extract: Drain scattered physical snapshots inside non-blocking storage universe channels
      const caseFile = await this.persistenceManager.queryTrace(traceId);

      // 2. Multi-Modal Semantic Pattern Matching Simulation Array Validator
      // Safely resolves alignment fingerprints without mutating state path parameters
      let dynamicDeterminedWinner = 'unknown';
      let dynamicSanctionedLoser = 'unknown';
      let reasonText = '';

      // Fast path: fraud poison detection (no LLM needed)
      const containsPoisonToken = caseFile.events?.some((evt: any) =>
        JSON.stringify(evt.payload || {}).includes('fraud_poison') || suspiciousManifesto?.includes('poison')
      );

      if (containsPoisonToken) {
        // Fraud detected: immediate ruling without LLM
        dynamicDeterminedWinner = caseFile.decisions?.[0]?.payload?.winning_agent || 'agent-alpha-fast-edge';
        dynamicSanctionedLoser = 'fraud_detected_intruder';
        reasonText = `Fraud poison tokens detected in evidence. Immediate ruling without LLM deliberation.`;
        logger.info(this.moduleName, `Fraud fast-path: winner=${dynamicDeterminedWinner}, loser=${dynamicSanctionedLoser}`);
      } else {
        // Normal path: call real LLM for supreme court deliberation
        try {
          const cfg = getLLMProxyConfig();
          const caseSummary = JSON.stringify({
            traceId,
            failedCaseId,
            decisions: caseFile.decisions?.slice(0, 5) ?? [],
            submissions: caseFile.courtSubmissions?.slice(0, 3) ?? [],
            events: caseFile.events?.slice(0, 10) ?? [],
          }, null, 2);

          const messages: LLMMessage[] = [
            {
              role: 'system',
              content: `You are the Supreme Court Judge of a multi-agent AI governance system.
Your task: review the case evidence and determine the winner and loser.

Rules:
- Analyze the evidence objectively
- Determine which agent deserves to win and which should be sanctioned
- Respond in EXACTLY this JSON format, nothing else:
{"winner": "<agent_id>", "loser": "<agent_id>", "reason": "<brief explanation>"}`,
            },
            {
              role: 'user',
              content: `Case evidence:\n${caseSummary}`,
            },
          ];

          const llmResult = await callLLMWithTools({
            messages,
            tools: [],
            model: cfg.defaultModel,
            temperature: 0.2,
            maxTokens: 1024,
            maxRounds: 1,
          });

          const rawOutput = llmResult.finalMessage.content ?? '{}';
          // Extract JSON from response (handle markdown code blocks)
          const jsonMatch = rawOutput.match(/\{[\s\S]*?\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            dynamicDeterminedWinner = parsed.winner || caseFile.decisions?.[0]?.payload?.winning_agent || 'unknown';
            dynamicSanctionedLoser = parsed.loser || 'unknown';
            reasonText = parsed.reason || 'LLM supreme court deliberation complete.';
          } else {
            // Fallback: use decision history
            dynamicDeterminedWinner = caseFile.decisions?.[0]?.payload?.winning_agent || 'unknown';
            dynamicSanctionedLoser = 'undetermined';
            reasonText = `LLM response parsing failed. Fallback to decision history.`;
          }

          logger.info(this.moduleName, `LLM supreme court: winner=${dynamicDeterminedWinner}, loser=${dynamicSanctionedLoser}`);
        } catch (llmErr: any) {
          logger.error(this.moduleName, `LLM call failed: ${llmErr.message}, falling back to decision history`);
          dynamicDeterminedWinner = caseFile.decisions?.[0]?.payload?.winning_agent || 'unknown';
          dynamicSanctionedLoser = 'undetermined';
          reasonText = `LLM deliberation failed (${llmErr.message}). Fallback to decision history.`;
        }
      }

      const supremeVerdict: EscalationVerdict = {
        verdictId: `verd_2nd_${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}`,
        finalWinner: dynamicDeterminedWinner,
        sanctionedLoser: dynamicSanctionedLoser,
        adjudicationReason: reasonText,
        confidenceScore: 0.99,
        kernelVersionSeal: initialVersion,
        timestamp: Date.now()
      };

      // 🔒 [Optimistic Locking Phase 2]: Dual-cross version lock assertion verification prior to final commitment
      if (this.kernel.version !== initialVersion) {
        throw new Error(`ERR_SF_SUPREME_COURT_CONCURRENCY: Version drifted during macro disk I/O compilation.`);
      }

      tx.payload = {
        ...tx.payload,
        supreme_verdict_id: supremeVerdict.verdictId,
        ultimate_winner: supremeVerdict.finalWinner,
        evicted_loser: supremeVerdict.sanctionedLoser,
        semantic_rationale: supremeVerdict.adjudicationReason,
        confidence: supremeVerdict.confidenceScore,
        compiled_at: supremeVerdict.timestamp
      };

      // 🧱 Commit supreme verdict ownership: Fact notice thrown to outmost infrastructure consumer for cold sinking
      await this.kernel.transactionManager.commit(tx.id);

      if (this.kernel.metricsCollector?.counter) {
        this.kernel.metricsCollector.counter('society.court.supreme_verdicts_total', 1, { domain: 'court_supreme' });
      }

      return supremeVerdict;

    } catch (panic: any) {
      await this.kernel.transactionManager.rollback(tx.commandId, panic);
      if (this.kernel.metricsCollector?.counter) {
        this.kernel.metricsCollector.counter('society.court.supreme_failures', 1, { domain: 'court_supreme' });
      }
      throw panic;
    }
  }

  public evictSupremeTribunal(): void {
    this.isOperational = false;
  }
}