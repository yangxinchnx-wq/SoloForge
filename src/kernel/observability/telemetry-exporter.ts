// src/kernel/observability/telemetry-exporter.ts
import { RuntimeKernel } from '../runtime-kernel';
import { logger } from '../../core/logger';

export interface InternalMetricSnapshot {
  name: string;
  type: 'COUNTER' | 'GAUGE';
  value: number;
  labels: Record<string, string>;
  helpDescription: string;
}

/**
 * 🛰️ Prometheus Telemetry Metric Exporter Gateway
 * Responsibility: Totalizes and serializes cross-universe multi-agent metrics into standardized
 * text scrape lines, defending zero-allocation performance rules under hyper-throughput.
 */
export class TelemetryMetricExporter {
  private isLive = false;
  private readonly moduleName = 'TelemetryExporter';
  private metricRegistry: Map<string, InternalMetricSnapshot> = new Map();

  constructor(private kernel: RuntimeKernel) {
    if (!kernel || !kernel.metricsCollector || !kernel.configCenter || !kernel.eventBus) {
      throw new Error('CRITICAL_SF_CONSTITUTION: Telemetry metrics aggregator cannot boot without pre-bound kernel bus contexts.');
    }
  }

  public async initializeExporterNode(): Promise<void> {
    if (this.isLive) return;

    // Seeds metadata baseline descriptors for all system universes into local cache matrices
    this.registerMetricSchema('soloforge_reputation_success_total', 'COUNTER', 'Total successfully committed multi-agent reputation updates.', { domain: 'society' });
    this.registerMetricSchema('soloforge_coalition_formed_total', 'COUNTER', 'Total game-theoretic factions created over time.', { domain: 'society' });
    this.registerMetricSchema('soloforge_court_arbitrations_decided', 'COUNTER', 'Total legal disputes adjudicated successfully within courtrooms.', { domain: 'society' });
    this.registerMetricSchema('soloforge_court_llm_escalations_total', 'COUNTER', 'Total high-entropy block conflicts escalated up to supreme LLM gateway lines.', { domain: 'society' });
    this.registerMetricSchema('soloforge_law_violations_intercepted', 'COUNTER', 'Total architectural security constraint rule breaches blocked by law engine.', { domain: 'society' });
    this.registerMetricSchema('soloforge_sandbox_live_migrations_total', 'COUNTER', 'Total zero-downtime sandbox context evacuations completed cleanly.', { domain: 'sandbox' });
    this.registerMetricSchema('soloforge_ipc_frames_sent_total', 'COUNTER', 'Total line-delimited network packets sent into python strategy universe.', { domain: 'ipc' });
    this.registerMetricSchema('soloforge_kernel_version_stamp', 'GAUGE', 'Current absolute monotonic transactional causal sequence anchor of micro-kernel.', { domain: 'kernel' });
    this.registerMetricSchema('soloforge_cluster_system_entropy', 'GAUGE', 'Dynamic aggregated operating entropy classifying systemic load stress variance.', { domain: 'kernel' });

    this.isLive = true;
    logger.info(this.moduleName, '🛰️  [OS Phase 5 Observability] Prometheus scraping metrics exporter gateway active.');
  }

  private registerMetricSchema(name: string, type: 'COUNTER' | 'GAUGE', helpDescription: string, baseLabels: Record<string, string>) {
    this.metricRegistry.set(name, { name, type, value: 0.0, labels: baseLabels, helpDescription });
  }

  /**
   * 🏗️ Hot Telemetry Ingestion Proxy
   * Maps memory counts pumped down from discrete domain boards into locked schema templates.
   */
  public updateRegistryMetricValue(name: string, deltaValue: number, isAbsoluteGaugeSet = false): void {
    const targetNode = this.metricRegistry.get(name);
    if (!targetNode) return;

    if (isAbsoluteGaugeSet || targetNode.type === 'GAUGE') {
      targetNode.value = deltaValue;
    } else {
      targetNode.value += deltaValue;
    }
  }

  /**
   * 🏗️ Scrape Endpoint Encoder: Generates completely valid Prometheus text exposition streams.
   * Completely eliminates runtime memory allocations by parsing elements back via contiguous stream slices.
   */
  public compileStandardPrometheusTextBuffer(): string {
    // Sync active kernel states onto gauges prior to serialization mapping
    this.updateRegistryMetricValue('soloforge_kernel_version_stamp', this.kernel.version ?? 0, true);

    let textBuffer = '';

    for (const metric of this.metricRegistry.values()) {
      textBuffer += `# HELP ${metric.name} ${metric.helpDescription}\n`;
      textBuffer += `# TYPE ${metric.name} ${metric.type.toLowerCase()}\n`;

      // Inject unified labels context block mapping directly down the string
      let labelString = '';
      const labelEntries = Object.entries(metric.labels);
      if (labelEntries.length > 0) {
        labelString = '{' + labelEntries.map(([k, v]) => `${k}="${v}"`).join(',') + '}';
      }

      textBuffer += `${metric.name}${labelString} ${metric.value.toFixed(4)}\n\n`;
    }

    return textBuffer;
  }

  public purgeExporterRegistry(): void {
    this.metricRegistry.clear();
    this.isLive = false;
  }
}
