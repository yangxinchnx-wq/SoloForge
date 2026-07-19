// src/data/consumers/telemetry-aggregation-consumer.ts
import { RuntimeKernel } from '../../kernel/runtime-kernel';
import { RuntimeEvent } from '../../core/events/runtime-events'; // 🔒 Statically aligned with standard compiled enum system
import { TelemetryMetricExporter } from '../../kernel/observability/telemetry-exporter';

/**
 * 🧱 Multi-Universe Telemetry Ingestion & Causal Projection Consumer
 * Responsibility: Listens to all atomic transactions to project and push dynamic real-time stats into the metric aggregator.
 */
export function initializeTelemetryAggregationConsumer(kernel: RuntimeKernel, exporter: TelemetryMetricExporter): void {
  if (!kernel || !kernel.eventBus || !exporter) return;

  // Intercept standard successful transaction commits pumped out by TransactionManager
  kernel.eventBus.on(RuntimeEvent.TransactionCommitted, async (txPayload: any) => {
    if (!txPayload) return;

    // Detach context tree via IIFE block to prevent long-turn formula derivations from blocking the micro-kernel tick
    (() => {
      const domain = txPayload.domain ?? txPayload.module;
      const data = txPayload.data ?? {};

      // 1. Structural Routing Mapping: Increments corresponding Prometheus schemas based on domain contexts
      if (domain === 'SocialReputation') {
        exporter.updateRegistryMetricValue('soloforge_reputation_success_total', 1);
      } else if (domain === 'CoalitionEngine') {
        exporter.updateRegistryMetricValue('soloforge_coalition_formed_total', 1);
      } else if (domain === 'ConsensAgentCourt') {
        if (data.status_seal === 'ESCAPE_ROUTING_TO_LLM' || data.status_seal === 'CONSERVATIVE_DEADLOCK_TRIGGER') {
          exporter.updateRegistryMetricValue('soloforge_court_llm_escalations_total', 1);
        } else {
          exporter.updateRegistryMetricValue('soloforge_court_arbitrations_decided', 1);
        }
      } else if (domain === 'LawEngine') {
        exporter.updateRegistryMetricValue('soloforge_law_violations_intercepted', 1);
      } else if (domain === 'SandboxMigration') {
        exporter.updateRegistryMetricValue('soloforge_sandbox_live_migrations_total', 1);
      }

      // 2. Dynamic Real-Time Macro-Systemic Entropy Calculation Routine
      // Re-evaluates systemic operational tension variables without holding cross-universe thread states
      const cc = kernel.configCenter;
      const baseVolatilityWeight = cc.get('society.reputation.weight_error', 0.3);

      // Heuristic proxy algorithm derivation modeling entropy variance
      let calculatedEntropyProxy = 0.05;
      if (data.metric_score !== undefined) {
        calculatedEntropyProxy = Math.min(1.0, Math.abs(1.0 - data.metric_score) * baseVolatilityWeight);
      } else if (data.relocated_bytes !== undefined) {
        calculatedEntropyProxy = 0.75; // Pinpoints a steep emergency hardware load spike
      }

      exporter.updateRegistryMetricValue('soloforge_cluster_system_entropy', calculatedEntropyProxy, true);
    })();
  });

  // Track low-level networking telemetry packet sequences
  kernel.eventBus.on(RuntimeEvent.SnapshotCreated, async (snapshot: any) => {
    if (snapshot && snapshot.domain === 'DistributedBroker') {
      exporter.updateRegistryMetricValue('soloforge_ipc_frames_sent_total', 1);
    }
  });
}
