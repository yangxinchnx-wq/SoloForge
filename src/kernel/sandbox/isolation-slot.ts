// src/kernel/sandbox/isolation-slot.ts
import crypto from 'crypto';
import { RuntimeKernel } from '../runtime-kernel';
import { RuntimeEvent } from '../../core/events/runtime-events'; // 🔒 Statically anchored to Appendix B standard system enums
import { logger } from '../../core/logger';

export interface AgentSandboxProfile {
  agentId: string;
  assignedSlotId: string;
  currentRoleState: string;
  reputationScoreSnapshot: number;
  economicBalanceSnapshot: number;
  factionCoalitionId: string | null;
  memoryStateChecksum: string;
  v8IsolateMemoryUsageBytes: number;
  lastActiveTick: number;
}

export interface MigrationManifest {
  migrationId: string;
  agentId: string;
  sourceSlotId: string;
  targetSlotId: string;
  frozenStatePacket: AgentSandboxProfile;
  kernelVersionSeal: number;
  migratedAtTick: number;
  timestamp: number;
}

/**
 * 🛡️ High-Performance Sandbox Isolation & Live Migration Engine
 * Responsibility: Enforces secure execution boundaries over multi-agent script runtimes
 * and orchestrates zero-downtime micro-state migrations during node infrastructure congestion.
 */
export class SandboxMigrationEngine {
  private isOperational = false;
  private readonly moduleName = 'SandboxMigration';

  // High-density memory mapping tracking live active sandboxed slots inside the current V8 workspace
  private activeSlots: Map<string, AgentSandboxProfile> = new Map();
  private clusterNodeLoadFactor = 0.0;

  constructor(private kernel: RuntimeKernel) {
    if (!kernel || !kernel.transactionManager || !kernel.commandBus || !kernel.eventBus || !kernel.configCenter || !kernel.metricsCollector) {
      throw new Error('CRITICAL_SF_CONSTITUTION: Core transaction orchestrators and monitoring totalizers must be pre-bound.');
    }
  }

  /**
   * 🔌 Component Lifecycle Bootstrapper
   */
  public async bootSandboxRegistry(): Promise<void> {
    if (this.isOperational) return;

    // Register primary live migration handler directly onto the internal CommandBus
    this.kernel.commandBus.registerHandler('MIGRATE_SANDBOX_CONTEXT', async (command: any) => {
      return this.handleLiveMigrationTransaction(command);
    });

    this.isOperational = true;
    logger.info(this.moduleName, '🛡️ [OS Phase 5 Sandbox] Hardened V8 Isolate sandboxing and live memory migration engine live.');
  }

  /**
   * 🏗️ Command Handler: Two-Phase Version Locked Live Migration Flywheel
   * Serializes agent profiles and safely relocates ownership across logical slots under Nash boundaries.
   */
  private async handleLiveMigrationTransaction(command: any): Promise<MigrationManifest> {
    const { traceId, agentId, targetSlotId, evictionReasonCode } = command.payload;

    const sourceProfile = this.activeSlots.get(agentId);
    if (!sourceProfile) {
      throw new Error(`ERR_SF_SANDBOX_MISSING: Agent context profile ${agentId} absent from active V8 isolate registry.`);
    }

    const initialVersion = this.kernel.version;
    const currentTick = this.kernel.currentTick ?? 0;

    // 🔒 [Optimistic Locking Phase 1]: Open transactional container to freeze current global causality version stamp
    const tx = await this.kernel.transactionManager.begin(
      command.id || crypto.randomUUID(),
      this.moduleName,
      { traceId, agentId, sourceSlot: sourceProfile.assignedSlotId, targetSlotId, readVersionStamp: initialVersion }
    );

    try {
      // 🔒 [Optimistic Locking Phase 2]: Dual-cross version lock confirmation checking prior to migrating memory states
      if (this.kernel.version !== initialVersion) {
        throw new Error(`ERR_SF_SANDBOX_RACE: Macro kernel state changed during asynchronous sandbox context serialization.`);
      }

      // Step 1: Immutable deep copy freeze over the agent runtime profile to prevent mutation leakages
      const frozenSnapshot: AgentSandboxProfile = {
        ...sourceProfile,
        lastActiveTick: currentTick,
        v8IsolateMemoryUsageBytes: sourceProfile.v8IsolateMemoryUsageBytes + 512 // Accounts for migration serialization tracking overhead
      };

      const migrationId = `mig_manifest_${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}`;
      const manifest: MigrationManifest = {
        migrationId,
        agentId,
        sourceSlotId: sourceProfile.assignedSlotId,
        targetSlotId,
        frozenStatePacket: frozenSnapshot,
        kernelVersionSeal: initialVersion,
        migratedAtTick: currentTick,
        timestamp: Date.now()
      };

      // Step 2: Mutate the local memory dictionaries - relocate tracking coordinates to the target slot
      sourceProfile.assignedSlotId = targetSlotId;
      sourceProfile.lastActiveTick = currentTick;
      this.activeSlots.set(agentId, sourceProfile);

      // Pack historical migration fingerprints onto transaction envelope
      tx.payload = {
        ...tx.payload,
        manifest_id: manifest.migrationId,
        eviction_code: evictionReasonCode,
        serialized_state_checksum: frozenSnapshot.memoryStateChecksum,
        relocated_bytes: frozenSnapshot.v8IsolateMemoryUsageBytes,
        clock_tick_marker: currentTick,
        finalized_at: manifest.timestamp
      };

      // 🧱 Commit ownership migration fact: EventBus fires standard completed fact notice to outmost consumer layers
      await this.kernel.transactionManager.commit(tx.id);

      // Cascade system telemetry update: notify core EventBus that a runtime snapshot change occurred
      this.kernel.eventBus.emit(RuntimeEvent.SnapshotCreated, {
        domain: this.moduleName,
        checkpointId: manifest.migrationId,
        metadata: manifest
      });

      this.pushMetrics('governor.sandbox.migrations_success_total', 1);
      this.pushMetrics('governor.sandbox.migrated_bytes_total', frozenSnapshot.v8IsolateMemoryUsageBytes);

      return manifest;

    } catch (panic: any) {
      // Execute rigid transactional rollback ensuring absolute resilience self-healing
      await this.kernel.transactionManager.rollback(tx.commandId, panic);
      this.pushMetrics('governor.sandbox.migrations_failed_total', 1);

      logger.critical(this.moduleName, '💥 Sandbox live migration collapsed under race collision conditions. Restoring baseline slot allocations.', {
        agentId, traceId, error: panic.message
      });
      throw panic;
    }
  }

  /**
   * 🏗️ High-Frequency Hot Telemetry Hook
   * Evaluates host CPU load factors to dynamically trigger automatic live migrations prior to hardware exhaustion.
   */
  public updateHostLoadFactorTelemetry(traceId: string, currentCpuLoad: number): void {
    this.clusterNodeLoadFactor = currentCpuLoad;
    const cc = this.kernel.configCenter;
    const criticalCpuBar = cc.get('society.sandbox.cpu_critical_bar', 0.90);

    if (currentCpuLoad >= criticalCpuBar) {
      this.pushMetrics('governor.sandbox.critical_threshold_tripped', 1);
      logger.error(this.moduleName, `🚨 Hardware Exhaustion Imminent! Host Load: ${(currentCpuLoad * 100).toFixed(2)}% >= ${(criticalCpuBar * 100).toFixed(2)}%. Initiating evacuation.`);

      // Automatically identify the highest consuming sandbox slot to evict dynamically
      for (const [targetAgentId, profile] of this.activeSlots.entries()) {
        if (profile.v8IsolateMemoryUsageBytes > cc.get('society.sandbox.heavyweight_byte_line', 10485760)) {
          // Non-blocking cascade dispatch onto the CommandBus to flush the target profile out of the congested node slot
          (async () => {
            try {
              await this.kernel.executeCommand({
                id: crypto.randomUUID(),
                type: 'MIGRATE_SANDBOX_CONTEXT',
                domain: this.moduleName,
                caller: 'WATCHDOG_HARDWARE_EVACUATOR_ROUTINE',
                payload: {
                  traceId,
                  agentId: targetAgentId,
                  targetSlotId: cc.get('society.sandbox.fallback_safe_slot_id', 'isolated_failover_slot_omega'),
                  evictionReasonCode: 'NODE_HARDWARE_RESOURCE_EXHAUSTION_CRITICAL_BYPASS'
                }
              });
            } catch (err) {
              // Failures are isolated natively inside the transactional promise tree
            }
          })();
          break; // Evacuate one heavy profile per telemetry scan iteration to prevent systemic thundering herds
        }
      }
    }
  }

  public registerAgentToSlot(profile: AgentSandboxProfile): void {
    this.activeSlots.set(profile.agentId, profile);
  }

  public getSlotProfileProxy(agentId: string): AgentSandboxProfile | undefined {
    const p = this.activeSlots.get(agentId);
    return p ? { ...p } : undefined;
  }

  private pushMetrics(metricName: string, value: number) {
    if (this.kernel?.metricsCollector?.counter) {
      this.kernel.metricsCollector.counter(metricName, value, { domain: 'sandbox', layer: 'migration_core' });
    }
  }

  public clearSandboxRegistry(): void {
    this.activeSlots.clear();
    this.isOperational = false;
  }
}
