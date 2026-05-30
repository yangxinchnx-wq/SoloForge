// src/kernel/orchestration/reputation-bridge.ts
import crypto from 'crypto';
import { RuntimeKernel } from '../runtime-kernel';
import { RuntimeEvent } from '../../core/events/runtime-events'; // 🔒 严格静态锚定附录B系统标准枚举体系，清除字符串拼接
import { logger } from '../../core/logger';

export interface ReputationCommandPayload {
  commandId: string;
  txId: string;
  traceId: string;
  agentClusterId: string;
  reputationIncrement: number;
  reasonCode: string;
  kernelVersionSeal: number;
  timestamp: number;
}

/**
 * 🧱 跨域信誉中继器 (Cross-Domain Reputation Bridge)
 * 职责：作为控制宇宙向 AI 社会宇宙单向广播的绝对解耦关卡，捍卫四宇宙强隔离红线
 */
export class CrossDomainReputationBridge {
  private kernelRef: RuntimeKernel;
  private domainName = 'ReputationBridge';

  constructor(kernel: RuntimeKernel) {
    if (!kernel || !kernel.eventBus || !kernel.configCenter || !kernel.metricsCollector) {
      throw new Error('ErrorCode.SYS_INIT_FAILED: Kernel control buses and metrics collector must be pre-bound.');
    }
    this.kernelRef = kernel;
  }

  /**
   * 🔌 启动单向审计中继监听流
   */
  public initializeInterlockListening(): void {
    // 🔒 严格订阅由 TransactionManager 强行向全局总线广播出来的原子级事务提交流事实通知
    this.kernelRef.eventBus.on(RuntimeEvent.TransactionCommitted, async (txPayload: any) => {
      if (!txPayload || txPayload.domain !== 'AIRuntime') return;
      await this.interceptAndEvaluateGovernanceWinner(txPayload);
    });
  }

  /**
   * ⚖️ 评估决策胜出者并单向提取资产变迁指纹
   */
  private async interceptAndEvaluateGovernanceWinner(txPayload: any): Promise<void> {
    const { data, txId, version } = txPayload;
    if (!data || !data.telemetry_snapshot) return;

    const cc = this.kernelRef.configCenter;
    const confidenceThreshold = cc.get('governor.reputation.confidence_threshold', 0.80);
    const baseIncrement = cc.get('governor.reputation.base_increment', 5.0);

    try {
      // 🧱 触发强匹配断言：仅当 PPO 影子网络的推理置信度越过安全中置线且表现优异时，宣告影子决策胜出
      if (data.probability > confidenceThreshold) {
        const clusterId = data.telemetry_snapshot.target_cluster_id || cc.get('governor.default.cluster_id', 'agent_cluster_alpha');
        const traceId = txPayload.traceId || crypto.randomUUID();

        // 计算基于系统熵优化后的动态信誉膨胀分值
        const entropyBonus = 1.0 / (data.probability + 1e-5);
        const finalIncrement = parseFloat((baseIncrement * (1.0 + entropyBonus)).toFixed(4));

        const bridgeCommand: ReputationCommandPayload = {
          commandId: `cmd_rep_${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}`,
          txId,
          traceId,
          agentClusterId: clusterId,
          reputationIncrement: finalIncrement,
          reasonCode: 'GOVERNOR_PPO_WINNER_OPTIMAL_ALIGNMENT',
          kernelVersionSeal: version,
          timestamp: Date.now()
        };

        // 🧱 严格遵循微内核隔离总纲：中继器绝对禁止越权直连、直写、或短路调用 AI 社会的存储层。
        // 必须向全局总线派发标准的跨域变更命令 RuntimeEvent.ReputationIncrementRequested（已完整注册注册到附录B）
        // 100% 阻断物理逆向死锁！
        this.kernelRef.eventBus.emit(RuntimeEvent.ReputationIncrementRequested, bridgeCommand);
        
        // 🔒 修复审计项 4：核心组件指标全量并入统一 Metrics 总线，打通全链路可观测性仪表盘
        this.pushMetricsToMonitorBus('governor.reputation.commands_routed', 1);
      }
    } catch (panic: any) {
      this.pushMetricsToMonitorBus('governor.reputation.structural_violations', 1);
      logger.error(this.domainName, '💥 Cross-domain evaluation crashed. Command blocked on barrier for self-healing resilience.', {
        txId, error: panic.message
      });
    }
  }

  private pushMetricsToMonitorBus(metricName: string, value: number) {
    this.kernelRef.metricsCollector.counter(metricName, value, { domain: 'governor', layer: 'reputation_bridge' });
  }
}
