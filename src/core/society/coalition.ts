// src/core/society/coalition.ts
import crypto from 'crypto';
import { RuntimeKernel } from '../../kernel/runtime-kernel';
import { logger } from '../logger';

export interface CoalitionProfile {
  coalitionId: string;
  name: string;
  members: Set<string>;
  totalReputationPool: number;
  sharedResourcePool: number;
  establishedTick: number;
}

/**
 * 📊 Game-Theoretic Coalition Engine
 * Responsibility: Manages multi-agent factional clustering, cooperative game alignments, 
 * and Shapley Value-based resource payout allocation under Nash Equilibrium constraints.
 */
export class CoalitionEngine {
  private isOperational = false;
  private readonly moduleName = 'CoalitionEngine';
  private coalitions: Map<string, CoalitionProfile> = new Map();
  private agentToCoalitionMap: Map<string, string> = new Map();

  constructor(private kernel: RuntimeKernel) {
    if (!kernel || !kernel.transactionManager || !kernel.commandBus || !kernel.configCenter) {
      throw new Error('ErrorCode.CONSTITUTION_VIOLATION: Micro-kernel bus nodes must be fully functional before loading CoalitionEngine.');
    }
  }

  public async boot(): Promise<void> {
    if (this.isOperational) return;

    this.kernel.commandBus.registerHandler('FORM_COALITION', async (command: any) => {
      return this.handleCoalitionFormation(command);
    });

    this.kernel.commandBus.registerHandler('ALLOCATE_COALITION_PAYOUT', async (command: any) => {
      return this.handleCoalitionPayoutDistribution(command);
    });

    this.isOperational = true;
    logger.info(this.moduleName, '📊 [OS Phase 3 Coalition Core] Game-theoretic factional clustering engine deployed.');
  }

  /**
   * 🏗️ Computes the exact Shapley Value marginal contribution allocation for a subset of members.
   * Enforces mathematical fairness in cooperative payouts to eliminate predatory resource hoarding.
   */
  public computeShapleyPayouts(members: string[], totalPayoutPool: number, reputationMap: Map<string, number>): Map<string, number> {
    const payouts = new Map<string, number>();
    const n = members.length;
    if (n === 0) return payouts;
    if (n === 1) {
      payouts.set(members[0], totalPayoutPool);
      return payouts;
    }

    // Initialize all payouts to zero
    for (const member of members) {
      payouts.set(member, 0.0);
    }

    // Helper to evaluate a coalition characteristic function v(S) based on pooled relative reputation weights
    const evaluateCharacteristic = (subset: string[]): number => {
      if (subset.length === 0) return 0.0;
      let combinedRep = 0.0;
      for (const m of subset) {
        combinedRep += reputationMap.get(m) ?? 1.0;
      }
      return (combinedRep / (combinedRep + 100.0)) * totalPayoutPool;
    };

    // Factorial utility calculation generator for exact permutations
    const factorial = (num: number): number => {
      let result = 1;
      for (let i = 2; i <= num; i++) result *= i;
      return result;
    };

    const nFactorial = factorial(n);

    // Iterate through each agent to solve marginal contribution weights over all subset pathways
    for (let i = 0; i < n; i++) {
      const targetAgent = members[i];
      let totalMarginalContribution = 0.0;

      // Generate subsets excluding target agent using binary masking sequences
      const totalSubsets = 1 << n;
      for (let mask = 0; mask < totalSubsets; mask++) {
        const currentSubset: string[] = [];
        let includesTarget = false;

        for (let j = 0; j < n; j++) {
          if ((mask & (1 << j)) !== 0) {
            if (members[j] === targetAgent) {
              includesTarget = true;
            } else {
              currentSubset.push(members[j]);
            }
          }
        }

        if (!includesTarget) {
          const sizeS = currentSubset.length;
          const vS = evaluateCharacteristic(currentSubset);
          currentSubset.push(targetAgent);
          const vWithTarget = evaluateCharacteristic(currentSubset);
          currentSubset.pop();

          const weight = (factorial(sizeS) * factorial(n - sizeS - 1)) / nFactorial;
          totalMarginalContribution += weight * (vWithTarget - vS);
        }
      }

      const cc = this.kernel.configCenter;
      const precisionDigits = cc.get('society.economy.precision', 4);
      payouts.set(targetAgent, parseFloat(totalMarginalContribution.toFixed(precisionDigits)));
    }

    return payouts;
  }

  private async handleCoalitionFormation(command: any): Promise<void> {
    const { traceId, coalitionName, initialMembers, initialResources } = command.payload;
    const initialVersion = this.kernel.version;

    const tx = await this.kernel.transactionManager.begin(
      command.id || crypto.randomUUID(),
      this.moduleName,
      { traceId, coalitionName, initialVersion }
    );

    try {
      if (this.kernel.version !== initialVersion) {
        throw new Error(`ERR_SF_COALITION_RACE: State version drifted before forming faction: ${coalitionName}`);
      }

      const coalitionId = `coal_${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}`;
      const memberSet = new Set<string>(initialMembers);

      const profile: CoalitionProfile = {
        coalitionId,
        name: coalitionName,
        members: memberSet,
        totalReputationPool: 100.0, // Initial structural placeholder weight
        sharedResourcePool: initialResources,
        establishedTick: this.kernel.currentTick ?? 0
      };

      this.coalitions.set(coalitionId, profile);
      for (const m of memberSet) {
        this.agentToCoalitionMap.set(m, coalitionId);
      }

      tx.payload = {
        ...tx.payload,
        coalition_id: coalitionId,
        faction_name: coalitionName,
        registered_members: Array.from(memberSet),
        resource_pool: initialResources,
        timestamp: Date.now()
      };

      await this.kernel.transactionManager.commit(tx.id);
      this.pushMetrics('society.coalition.formed_count', 1);

    } catch (err: any) {
      await this.kernel.transactionManager.rollback(tx.commandId, err);
      throw err;
    }
  }

  private async handleCoalitionPayoutDistribution(command: any): Promise<void> {
    const { traceId, coalitionId, totalPayoutPool, reputationSnapshot } = command.payload;
    const initialVersion = this.kernel.version;

    const faction = this.coalitions.get(coalitionId);
    if (!faction) throw new Error(`ERR_SF_COALITION_NOT_FOUND: Coalition ${coalitionId} absent from runtime ledger.`);

    const tx = await this.kernel.transactionManager.begin(
      command.id || crypto.randomUUID(),
      this.moduleName,
      { traceId, coalitionId, totalPayoutPool, initialVersion }
    );

    try {
      if (this.kernel.version !== initialVersion) {
        throw new Error(`ERR_SF_COALITION_PAYOUT_RACE: Concurrency lock assertion drifted on payout distribution for: ${coalitionId}`);
      }

      const memberList = Array.from(faction.members);
      const reputationMap = new Map<string, number>(Object.entries(reputationSnapshot));

      // Calculate fair Shapley distribution matrix across local member slots
      const allocationMap = this.computeShapleyPayouts(memberList, totalPayoutPool, reputationMap);

      tx.payload = {
        ...tx.payload,
        coalition_id: coalitionId,
        allocated_matrix: Object.fromEntries(allocationMap),
        distributed_amount: totalPayoutPool,
        timestamp: Date.now()
      };

      // Cascade liquidity distribution via CommandBus to synchronize balance records inside TokenEconomyEngine
      for (const [agentId, allocation] of allocationMap.entries()) {
        await this.kernel.executeCommand({
          id: crypto.randomUUID(),
          type: 'DISTRIBUTE_ROLE_ALLOCATION_REWARD',
          domain: this.moduleName,
          caller: 'COALITION_GAME_PAYOUT_FLYWHEEL',
          payload: { traceId, agentId, targetRole: 'WORKER', allocationBonusFactor: allocation / totalPayoutPool }
        });
      }

      await this.kernel.transactionManager.commit(tx.id);
      this.pushMetrics('society.coalition.payouts_distributed', 1);

    } catch (err: any) {
      await this.kernel.transactionManager.rollback(tx.commandId, err);
      throw err;
    }
  }

  private pushMetrics(metricName: string, value: number) {
    if (this.kernel?.metricsCollector?.counter) {
      this.kernel.metricsCollector.counter(metricName, value, { domain: 'society', layer: 'coalition' });
    }
  }

  public shutdown(): void {
    this.coalitions.clear();
    this.agentToCoalitionMap.clear();
    this.isOperational = false;
  }
}
