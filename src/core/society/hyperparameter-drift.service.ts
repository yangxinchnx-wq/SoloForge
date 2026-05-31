// src/core/society/hyperparameter-drift.service.ts
/**
 * 🧬 MAPPO Hyperparameter Drift Service
 * 深度学习自迭代：超参数漂移实验的 TypeScript 控制层
 */

import { RuntimeKernel } from '../../kernel/runtime-kernel';
import { logger } from '../logger';

/** 漂移类型枚举 */
export enum DriftType {
  RANDOM_WALK = 'random_walk',
  TREND = 'trend',
  CYCLIC = 'cyclic',
  ADVERSARIAL = 'adversarial',
  MOMENTUM = 'momentum',
  ADAPTIVE = 'adaptive',
}

/** 漂移结果 */
export interface DriftResult {
  tick: number;
  hyperparams: Record<string, number>;
  performance: number;
  delta_performance: number;
  drift_type: string;
  novelty_score: number;
  governance_intervention: boolean;
  intervention_reason: string;
}

/** 实验摘要 */
export interface ExperimentSummary {
  current_tick: number;
  total_drift_count: number;
  governance_interventions: number;
  best_performance: number;
  best_config: Record<string, number>;
  worst_performance: number;
  worst_config: Record<string, number>;
  current_config: Record<string, number>;
  drift_type: string;
  performance_trend: number;
}

/** 超参数漂移服务 */
export class HyperparameterDriftService {
  private readonly moduleName = 'HyperparameterDrift';
  private isActive = false;

  constructor(private kernel: RuntimeKernel) {
    if (!kernel || !kernel.eventBus || !kernel.commandBus || !kernel.configCenter) {
      throw new Error('CRITICAL_SF_CONSTITUTION: HyperparameterDriftService requires fully initialized kernel.');
    }
  }

  /**
   * 启动漂移实验
   */
  public async startDriftExperiment(driftType: DriftType = DriftType.MOMENTUM): Promise<void> {
    if (this.isActive) {
      logger.warn(this.moduleName, '🧬 Drift experiment already active.');
      return;
    }

    // 注册 IPC 处理器
    this.kernel.commandBus.registerHandler('DRIFT_EXPERIMENT_START', async (command: any) => {
      return this.handleStartExperiment(command.payload);
    });

    this.kernel.commandBus.registerHandler('DRIFT_STEP', async (command: any) => {
      return this.handleDriftStep(command.payload);
    });

    this.kernel.commandBus.registerHandler('DRIFT_GET_SUMMARY', async (command: any) => {
      return this.handleGetSummary(command.payload);
    });

    // 监听 Governance 干预信号
    this.kernel.eventBus.on('governance.intervention.applied', (intervention: any) => {
      this.handleGovernanceIntervention(intervention);
    });

    // 监听 Telemetry 熵值变化
    this.kernel.eventBus.on('telemetry.entropy.updated', (entropy: number) => {
      this.handleEntropyUpdate(entropy);
    });

    this.isActive = true;

    logger.info(this.moduleName,
      `🧬 [DRIFT EXPERIMENT STARTED] Type: ${driftType}, Governance: ENABLED`
    );
  }

  /**
   * 处理启动实验命令
   */
  private async handleStartExperiment(payload: any): Promise<{ success: boolean; driftType: string }> {
    const driftType = payload?.driftType || DriftType.MOMENTUM;

    logger.info(this.moduleName, `🧬 Starting drift experiment: ${driftType}`);

    // 广播到 Python 侧
    this.broadcastDriftCommand('start', { driftType });

    return { success: true, driftType };
  }

  /**
   * 处理漂移步骤命令
   */
  private async handleDriftStep(payload: any): Promise<DriftResult> {
    const { performance, governanceSignal } = payload;

    // 记录性能指标
    if (this.kernel.metricsCollector?.gauge) {
      this.kernel.metricsCollector.gauge(
        'soloforge_drift.performance',
        performance,
        { drift_type: payload.driftType || 'momentum' }
      );
    }

    // 广播到 Python 侧
    const pythonResult = await this.broadcastDriftCommand('step', {
      performance,
      governanceSignal,
    });

    const result: DriftResult = {
      tick: (pythonResult?.tick) ?? (this.kernel.currentTick ?? 0),
      hyperparams: pythonResult?.hyperparams || {},
      performance,
      delta_performance: pythonResult?.delta_performance || 0,
      drift_type: pythonResult?.drift_type || 'momentum',
      novelty_score: pythonResult?.novelty_score || 0,
      governance_intervention: pythonResult?.governance_intervention || false,
      intervention_reason: pythonResult?.intervention_reason || '',
    };

    // 检查是否需要干预
    if (result.governance_intervention) {
      this.emitDriftAlert(result);
    }

    // 更新指标
    if (this.kernel.metricsCollector?.gauge) {
      this.kernel.metricsCollector.gauge('soloforge_drift.novelty_score', result.novelty_score);
    }

    return result;
  }

  /**
   * 处理获取摘要命令
   */
  private async handleGetSummary(_payload: any): Promise<ExperimentSummary> {
    const pythonSummary = await this.broadcastDriftCommand('get_summary', {});

    return {
      current_tick: pythonSummary?.current_tick || 0,
      total_drift_count: pythonSummary?.total_drift_count || 0,
      governance_interventions: pythonSummary?.governance_interventions || 0,
      best_performance: pythonSummary?.best_performance || 0,
      best_config: pythonSummary?.best_config || {},
      worst_performance: pythonSummary?.worst_performance || 0,
      worst_config: pythonSummary?.worst_config || {},
      current_config: pythonSummary?.current_config || {},
      drift_type: pythonSummary?.drift_type || 'momentum',
      performance_trend: pythonSummary?.performance_trend || 0,
    };
  }

  /**
   * 处理 Governance 干预信号
   */
  private handleGovernanceIntervention(intervention: any): void {
    logger.warn(this.moduleName,
      `🏛️ [DRIFT-GOVERNANCE SYNC] Agent ${intervention.targetAgentId} intervention applied: ` +
      `tax=${intervention.taxEquilibriumCoefficient}, decay=${intervention.reputationDecayOperator}`
    );

    // 将干预信号广播到 Python 侧
    this.broadcastDriftCommand('governance_signal', {
      tax_equilibrium_coefficient: intervention.taxEquilibriumCoefficient,
      reputation_decay_operator: intervention.reputationDecayOperator,
      target_agent: intervention.targetAgentId,
      isolation_level: intervention.isolationLevel,
    });
  }

  /**
   * 处理熵值更新
   */
  private handleEntropyUpdate(entropy: number): void {
    const entropyThreshold = this.kernel.configCenter.get('governor.entropy_threshold', 0.85);

    if (entropy > entropyThreshold) {
      logger.warn(this.moduleName,
        `⚠️ [HIGH ENTROPY ALERT] system_entropy=${entropy.toFixed(4)} > threshold=${entropyThreshold}`
      );

      // 广播到 Python 侧以触发自适应干预
      this.broadcastDriftCommand('entropy_alert', {
        entropy,
        threshold: entropyThreshold,
      });
    }
  }

  /**
   * 发射漂移告警事件
   */
  private emitDriftAlert(result: DriftResult): void {
    this.kernel.eventBus.emit('drift.governance_intervention', {
      tick: result.tick,
      hyperparams: result.hyperparams,
      reason: result.intervention_reason,
      novelty_score: result.novelty_score,
    });
  }

  /**
   * 广播漂移命令到 Python 侧
   */
  private broadcastDriftCommand(action: string, payload: any): Promise<any> {
    // 通过 IPC 发送到 Python
    this.kernel.eventBus.emit('drift.command', {
      action,
      payload,
      timestamp: Date.now(),
      kernelVersion: this.kernel.version,
    });

    return Promise.resolve({});
  }

  /**
   * 获取实验状态
   */
  public getExperimentStatus(): { isActive: boolean; moduleName: string } {
    return {
      isActive: this.isActive,
      moduleName: this.moduleName,
    };
  }

  /**
   * 停止实验
   */
  public stopExperiment(): void {
    this.isActive = false;
    logger.info(this.moduleName, '🧬 Drift experiment stopped.');
  }
}
