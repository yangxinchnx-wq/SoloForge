// src/kernel/config-center.ts
/**
 * 🗂️ Centralized Configuration Registry
 * Responsibility: Provides a unified key-value configuration interface with defaults.
 * All magic numbers must be parameterized here - zero hardcoding allowed.
 */

/**
 * Default configuration values for SoloForge
 */
const DEFAULT_CONFIG: Record<string, any> = {
  // Governor clock timing
  'governor.clock.tick_rate_ms': 50,
  'governor.observability.http_port': 9090,

  // IPC network settings
  'governor.ipc.host': '127.0.0.1',
  'governor.ipc.port': 8765,
  'governor.ipc.max_reconnect_attempts': 10,
  'governor.ipc.reconnect_backoff_base': 1000,

  // Society configurations
  'society.law.default_active_wal': true,
  'society.law.emergency_lockdown_cooldown': 5000,
  'society.reputation.weight_error': 0.3,
  'society.reputation.decay_rate': 0.95,
  'society.governance.effectiveness_threshold': 0.85,

  // 🏛️ Government Intervention Parameters
  'society.governance.tax_equilibrium_coefficient': 0.15,    // 税收均衡系数
  'society.governance.reputation_decay_operator': 0.05,     // 声望衰减算子
  'society.governance.privilege_threshold': 20,            // 特权阈值
  'society.governance.auto_intervention_enabled': true,      // 自动干预开关

  // Sandbox configurations
  'society.sandbox.cpu_critical_bar': 0.90,
  'society.sandbox.heavyweight_byte_line': 10485760,
  'society.sandbox.fallback_safe_slot_id': 'isolated_failover_slot_omega',

  // Coalition Shapley value tolerance
  'society.coalition.shapley_tolerance': 0.001,
  'society.coalition.min_formation_threshold': 0.1,

  // Institution trust thresholds
  'society.institution.trust_threshold_min': 0.6,
  'society.institution.trust_threshold_max': 0.95,

  // Role evolution
  'society.evolution.role_cooldown_ticks': 100,
  'society.evolution.promotion_threshold': 0.8,
  'society.evolution.demotion_threshold': 0.3,

  // Social memory
  'society.memory.forgetting_curve_base': 0.05,
  'society.memory.consolidation_interval_ticks': 50,

  // Shadow Governor
  'governor.shadow.enabled': false,
  'governor.shadow.server_url': 'http://127.0.0.1:8080',

  // Phase 7: Distributed Raft Consensus Cluster Configuration
  'governor.cluster.local_node_id': 'node_alpha_master',
  'governor.cluster.peers_nodes': ['node_beta_slave_1', 'node_gamma_slave_2'],
  'society.economy.precision': 4,
};

export interface MetricsCollectorInterface {
  counter(name: string, value: number, labels?: Record<string, string>): void;
  gauge?(name: string, value: number, labels?: Record<string, string>): void;
}

/**
 * Default metrics collector implementation (noop for standalone usage)
 */
class NoopMetricsCollector implements MetricsCollectorInterface {
  counter(_name: string, _value: number, _labels?: Record<string, string>): void {
    // No-op: metrics are collected by TelemetryMetricExporter instead
  }
  gauge?(_name: string, _value: number, _labels?: Record<string, string>): void {
    // No-op
  }
}

/**
 * Configuration Center - provides typed access to all system configuration
 */
export class ConfigCenter {
  private config: Map<string, any>;
  private defaults: Map<string, any>;

  constructor(initialConfig?: Record<string, any>) {
    this.defaults = new Map(Object.entries(DEFAULT_CONFIG));
    this.config = new Map(Object.entries(initialConfig || {}));
  }

  /**
   * Get a configuration value with optional default
   */
  get<T = any>(key: string, defaultValue?: T): T {
    // Check user-defined config first
    if (this.config.has(key)) {
      return this.config.get(key) as T;
    }
    // Fall back to defaults
    if (this.defaults.has(key)) {
      return this.defaults.get(key) as T;
    }
    // Fall back to provided default
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    // Return undefined
    return undefined as T;
  }

  /**
   * Set a configuration value
   */
  set(key: string, value: any): void {
    this.config.set(key, value);
  }

  /**
   * Check if a key exists
   */
  has(key: string): boolean {
    return this.config.has(key) || this.defaults.has(key);
  }

  /**
   * Get all keys
   */
  keys(): string[] {
    return Array.from(new Set([...this.config.keys(), ...this.defaults.keys()]));
  }
}

/**
 * Global singleton metrics collector instance
 */
export const globalMetricsCollector: MetricsCollectorInterface = new NoopMetricsCollector();

/**
 * Global singleton config center instance
 */
export const globalConfigCenter = new ConfigCenter();

export default globalConfigCenter;
