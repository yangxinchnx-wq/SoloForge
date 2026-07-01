// ─────────────────────────────────────────────────────────────────
// SoloForge Court Core: Commit-Reveal Adjudicator with Staking
// Path: src/core/court/commit-reveal-adjudicator.ts
//
// 参考: Verdikta 协议 Commit-Reveal + 质押经济
// 参考: Xi'an Jiaotong 论文区块链行为溯源
// 参考: Kleros 去中心化仲裁
// ─────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import { logger } from '../logger';
import type { RuntimeKernel } from '../../kernel/runtime-kernel';
import { CourtEvent } from '../events/court-events';
import type { AdjudicationArgumentClaim } from './consensagent';

/**
 * 仲裁者投票 — Commit 阶段密封
 */
export interface SealedVote {
  /** 仲裁者 ID */
  judgeId: string;
  /** 投票哈希 (commit 阶段提交) */
  commitHash: string;
  /** 投票对象 Agent ID (reveal 阶段揭示) */
  voteFor: string | null;
  /** 置信度 (0-1) */
  confidence: number;
  /** 推理依据 */
  reasoning: string;
}

/**
 * 质押记录
 */
export interface StakeRecord {
  agentId: string;
  amount: number;
  slashed: number;
  timestamp: number;
}

/**
 * 仲裁结果
 */
export interface AdjudicationResult {
  type: 'DECIDED' | 'ESCALATE' | 'DEADLOCK';
  winner: string | null;
  votes: SealedVote[];
  consensusStrength: number;
  totalStake: number;
  slashingEvents: string[];
}

/**
 * Commit-Reveal 仲裁引擎
 *
 * 设计原则 (参考 Verdikta):
 * 1. Commit 阶段: 仲裁者密封投票 (提交哈希)
 * 2. Reveal 阶段: 仲裁者揭示投票内容
 * 3. 质押经济: 仲裁者质押代币，偏离共识被惩罚
 * 4. 伪随机选择: 按声誉加权随机选仲裁者
 */
export class CommitRevealAdjudicator {
  private readonly moduleName = 'CommitRevealAdjudicator';
  private readonly stakes = new Map<string, StakeRecord>();
  private readonly committedVotes = new Map<string, Map<string, string>>(); // roundId → judgeId → hash
  private readonly revealedVotes = new Map<string, SealedVote[]>(); // roundId → votes
  private roundCounter = 0;

  /** 质押门槛 */
  private readonly minStake = 10;
  /** 偏离共识惩罚比例 */
  private readonly slashingRate = 0.2;
  /** 共识奖励比例 */
  private readonly rewardRate = 0.05;

  constructor(private readonly kernel: RuntimeKernel) {}

  /**
   * 仲裁者质押 — 必须质押才能参与仲裁
   */
  stake(agentId: string, amount: number): boolean {
    if (amount < this.minStake) {
      logger.warn(this.moduleName, `stake ${amount} below minimum ${this.minStake} for ${agentId}`);
      return false;
    }
    const existing = this.stakes.get(agentId);
    this.stakes.set(agentId, {
      agentId,
      amount: (existing?.amount ?? 0) + amount,
      slashed: existing?.slashed ?? 0,
      timestamp: Date.now(),
    });
    logger.info(this.moduleName, `${agentId} staked ${amount} (total: ${(existing?.amount ?? 0) + amount})`);
    return true;
  }

  /**
   * 伪随机选择仲裁者 — 按声誉加权随机
   * 参考 Verdikta: pseudorandom weighted by reputation
   */
  selectJudges(candidateIds: string[], reputationScores: Map<string, number>, count: number): string[] {
    const weighted = candidateIds
      .filter(id => {
        const stake = this.stakes.get(id);
        return stake && (stake.amount - stake.slashed) >= this.minStake;
      })
      .map(id => ({
        id,
        weight: (reputationScores.get(id) ?? 0.5) * (this.stakes.get(id)?.amount ?? 1),
      }))
      .sort((a, b) => b.weight - a.weight);

    // 加权随机选择 (不简单取 top-N，增加随机性防串通)
    const selected: string[] = [];
    const pool = [...weighted];

    for (let i = 0; i < Math.min(count, pool.length); i++) {
      const totalWeight = pool.reduce((sum, w) => sum + w.weight, 0);
      let rand = Math.random() * totalWeight;
      for (let j = 0; j < pool.length; j++) {
        rand -= pool[j].weight;
        if (rand <= 0) {
          selected.push(pool[j].id);
          pool.splice(j, 1);
          break;
        }
      }
    }

    return selected;
  }

  /**
   * Phase 1: Commit — 仲裁者密封投票
   * 仲裁者提交投票哈希，不暴露实际判断
   */
  commitVote(roundId: string, judgeId: string, voteHash: string): void {
    if (!this.committedVotes.has(roundId)) {
      this.committedVotes.set(roundId, new Map());
    }
    this.committedVotes.get(roundId)!.set(judgeId, voteHash);
    logger.debug(this.moduleName, `[${roundId}] ${judgeId} committed hash`);
  }

  /**
   * 生成投票哈希 (仲裁者本地调用)
   */
  static generateCommitHash(voteFor: string, confidence: number, salt: string): string {
    return crypto.createHash('sha256').update(`${voteFor}:${confidence}:${salt}`).digest('hex');
  }

  /**
   * Phase 2: Reveal — 仲裁者揭示投票
   * 必须与 commit 阶段的哈希匹配
   */
  revealVote(roundId: string, judgeId: string, voteFor: string | null, confidence: number, reasoning: string, salt: string): boolean {
    const committed = this.committedVotes.get(roundId)?.get(judgeId);
    if (!committed) {
      logger.warn(this.moduleName, `[${roundId}] ${judgeId} reveal without commit`);
      return false;
    }

    // 验证哈希一致性
    const expectedHash = CommitRevealAdjudicator.generateCommitHash(voteFor ?? 'ABSTAIN', confidence, salt);
    if (committed !== expectedHash) {
      logger.warn(this.moduleName, `[${roundId}] ${judgeId} hash mismatch: expected ${expectedHash}, got ${committed}`);
      return false;
    }

    if (!this.revealedVotes.has(roundId)) {
      this.revealedVotes.set(roundId, []);
    }
    this.revealedVotes.get(roundId)!.push({
      judgeId,
      commitHash: committed,
      voteFor,
      confidence,
      reasoning,
    });

    logger.debug(this.moduleName, `[${roundId}] ${judgeId} revealed: voteFor=${voteFor} confidence=${confidence}`);
    return true;
  }

  /**
   * 裁决 — 聚合所有揭示的投票并执行质押惩罚/奖励
   */
  adjudicate(roundId: string): AdjudicationResult {
    const votes = this.revealedVotes.get(roundId) ?? [];
    const slashingEvents: string[] = [];

    if (votes.length === 0) {
      return { type: 'ESCALATE', winner: null, votes: [], consensusStrength: 0, totalStake: 0, slashingEvents };
    }

    // 统计投票 (加权 by confidence)
    const tally = new Map<string, number>();
    for (const vote of votes) {
      if (!vote.voteFor) continue;
      const current = tally.get(vote.voteFor) ?? 0;
      tally.set(vote.voteFor, current + vote.confidence);
    }

    if (tally.size === 0) {
      return { type: 'ESCALATE', winner: null, votes, consensusStrength: 0, totalStake: 0, slashingEvents };
    }

    const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    const winner = sorted[0][0];
    const winnerScore = sorted[0][1];
    const totalConfidence = votes.reduce((sum, v) => sum + v.confidence, 0);
    const consensusStrength = totalConfidence > 0 ? winnerScore / totalConfidence : 0;

    // 质押惩罚: 偏离共识者被惩罚
    for (const vote of votes) {
      const stake = this.stakes.get(vote.judgeId);
      if (!stake) continue;

      if (vote.voteFor !== winner && vote.voteFor !== null) {
        // 偏离共识: 惩罚
        const slashAmount = stake.amount * this.slashingRate;
        stake.slashed += slashAmount;
        slashingEvents.push(`${vote.judgeId}: slashed ${slashAmount.toFixed(2)} for dissent`);
        logger.info(this.moduleName, `[${roundId}] ${vote.judgeId} slashed ${slashAmount.toFixed(2)}`);
      } else if (vote.voteFor === winner) {
        // 符合共识: 奖励 (增加质押)
        const rewardAmount = stake.amount * this.rewardRate;
        stake.amount += rewardAmount;
        logger.debug(this.moduleName, `[${roundId}] ${vote.judgeId} rewarded ${rewardAmount.toFixed(2)}`);
      }
    }

    // 共识度太低时升级
    if (consensusStrength < 0.6) {
      this.kernel.eventBus.emit(CourtEvent.DEADLOCK_DETECTED, { roundId, consensusStrength });
      return { type: 'DEADLOCK', winner: null, votes, consensusStrength, totalStake: this.getTotalStake(), slashingEvents };
    }

    this.kernel.eventBus.emit(CourtEvent.ARBITRATION_DECIDED, { roundId, winner, consensusStrength });
    return { type: 'DECIDED', winner, votes, consensusStrength, totalStake: this.getTotalStake(), slashingEvents };
  }

  /**
   * 获取总质押量
   */
  private getTotalStake(): number {
    let total = 0;
    for (const stake of this.stakes.values()) {
      total += stake.amount - stake.slashed;
    }
    return total;
  }

  /**
   * 获取质押快照
   */
  getStakeSnapshot(): StakeRecord[] {
    return Array.from(this.stakes.values());
  }
}
