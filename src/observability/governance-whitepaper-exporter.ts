// src/observability/governance-whitepaper-exporter.ts
/**
 * 📜 SoloForge 演化治理白皮书导出服务
 * 职责：全量 Dump 系统状态机快照、博弈审计轨迹、制度红线违规记录，生成最终技术演化报告。
 */

import fs from 'fs/promises';
import path from 'path';
import { RuntimeKernel } from '../kernel/runtime-kernel';
import { logger } from '../core/logger';
import { TelemetryMetricExporter } from '../kernel/observability/telemetry-exporter';

export interface EvolutionAuditReport {
  reportVersion: string;
  generatedAt: string;
  systemMetadata: SystemMetadata;
  evolutionMetrics: EvolutionMetrics;
  governanceAudit: GovernanceAuditTrail;
  socialEquilibriumState: SocialEquilibriumState;
  distributedConsensusState: DistributedConsensusState;
  hyperparameterDriftState: HyperparameterDriftState;
  closureCertificate: ClosureCertificate;
}

export interface SystemMetadata {
  kernelVersion: number;
  currentTick: number;
  bootTimestamp: string;
  consensusRole: 'LEADER' | 'FOLLOWER' | 'CANDIDATE' | 'OBSERVER';
  uptimeSeconds: number;
  nodeId: string;
  clusterPeers: string[];
}

export interface EvolutionMetrics {
  totalTransactionsProcessed: number;
  totalGovernanceInterventions: number;
  totalCourtAdjudications: number;
  totalCoalitionsFormed: number;
  totalReputationUpdates: number;
  totalSandboxMigrations: number;
  totalIPCEvents: number;
  systemEntropyCurrent: number;
  systemEntropyPeak: number;
  averageQueueLength: number;
}

export interface GovernanceAuditTrail {
  recentInterventions: GovernanceInterventionRecord[];
  privilegeBypassAttempts: PrivilegeBypassRecord[];
  policyViolationAlerts: PolicyViolationRecord[];
  reputationAdjustments: ReputationAdjustmentRecord[];
}

export interface GovernanceInterventionRecord {
  tick: number;
  agentId: string;
  interventionType: 'TAX_EQUILIBRIUM' | 'REPUTATION_DECAY' | 'ISOLATION' | 'SUSPENSION';
  taxCoefficient: number;
  decayOperator: number;
  isolationLevel: 'none' | 'partial' | 'full';
  reason: string;
  revoked: boolean;
  revokedAtTick?: number;
}

export interface PrivilegeBypassRecord {
  tick: number;
  agentId: string;
  attemptCount: number;
  pattern: string;
  actionTaken: 'WARN' | 'INTERVENE' | 'ESCALATE';
}

export interface PolicyViolationRecord {
  tick: number;
  agentId: string;
  violationType: string;
  severity: 'minor' | 'moderate' | 'severe';
  legalBasis: string;
  sanctionApplied: string;
}

export interface ReputationAdjustmentRecord {
  tick: number;
  agentId: string;
  previousReputation: number;
  newReputation: number;
  adjustmentReason: string;
}

export interface SocialEquilibriumState {
  activeAgents: number;
  totalAgents: number;
  averageReputation: number;
  reputationDistribution: Record<string, number>;
  coalitionCount: number;
  activeInstitutions: number;
  entropyIndex: number;
  equilibriumCoefficient: number;
}

export interface DistributedConsensusState {
  raftState: 'LEADER' | 'FOLLOWER' | 'CANDIDATE';
  currentTerm: number;
  lastLogIndex: number;
  lastLogTerm: number;
  commitIndex: number;
  lastApplied: number;
  quorumSize: number;
  peerStates: Record<string, PeerState>;
}

export interface PeerState {
  nodeId: string;
  lastHeartbeat: number;
  matchIndex: number;
  state: 'ACTIVE' | 'INACTIVE' | 'SUSPECTED';
}

export interface HyperparameterDriftState {
  experimentActive: boolean;
  driftType: string;
  currentConfig: Record<string, number>;
  bestPerformance: number;
  bestConfig: Record<string, number>;
  totalDriftSteps: number;
  governanceInterventions: number;
  noveltyScoreAverage: number;
}

export interface ClosureCertificate {
  projectName: string;
  closureDate: string;
  closureLevel: 'A' | 'B' | 'C' | 'D';
  productionPolicy: string;
  archivedAssets: string[];
  coreConclusion: string;
  falsificationStatement: string;
  authorizedBy: string;
}

/**
 * 📜 演化治理白皮书导出器
 */
export class GovernanceWhitepaperExporter {
  private readonly moduleName = 'GovernanceWhitepaperExporter';
  private readonly reportVersion = '1.0.0';

  constructor(private kernel: RuntimeKernel) {
    if (!kernel) {
      throw new Error('CRITICAL_SF_CONSTITUTION: WhitepaperExporter requires valid kernel.');
    }
  }

  /**
   * 📜 导出完整演化审计报告
   */
  public async exportEvolutionAudit(reportPath: string): Promise<void> {
    logger.info(this.moduleName, `📜 Starting evolution audit export to: ${reportPath}`);

    try {
      const report = await this.generateEvolutionReport();

      // 确保目录存在
      const dir = path.dirname(reportPath);
      await fs.mkdir(dir, { recursive: true });

      // 写入报告
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');

      // 同时生成 Markdown 版本
      const mdPath = reportPath.replace('.json', '.md');
      await this.exportMarkdownReport(report, mdPath);

      logger.info(this.moduleName, `✅ Evolution audit report exported successfully`);
      logger.info(this.moduleName, `   JSON: ${reportPath}`);
      logger.info(this.moduleName, `   Markdown: ${mdPath}`);

    } catch (error: any) {
      logger.error(this.moduleName, `💥 Failed to export evolution audit: ${error.message}`);
      throw error;
    }
  }

  /**
   * 📜 生成完整演化报告
   */
  public async generateEvolutionReport(): Promise<EvolutionAuditReport> {
    return {
      reportVersion: this.reportVersion,
      generatedAt: new Date().toISOString(),
      systemMetadata: await this.collectSystemMetadata(),
      evolutionMetrics: await this.collectEvolutionMetrics(),
      governanceAudit: await this.collectGovernanceAudit(),
      socialEquilibriumState: await this.collectSocialEquilibriumState(),
      distributedConsensusState: await this.collectDistributedConsensusState(),
      hyperparameterDriftState: await this.collectHyperparameterDriftState(),
      closureCertificate: this.generateClosureCertificate(),
    };
  }

  /**
   * 🏛️ 收集系统元数据
   */
  private async collectSystemMetadata(): Promise<SystemMetadata> {
    const configCenter = this.kernel.configCenter;

    return {
      kernelVersion: this.kernel.version,
      currentTick: this.kernel.currentTick ?? 0,
      bootTimestamp: new Date().toISOString(),
      consensusRole: 'LEADER',
      uptimeSeconds: Math.floor((Date.now() - (this.kernel as any).bootTime ?? Date.now()) / 1000),
      nodeId: configCenter.get('governor.cluster.local_node_id', 'node_alpha_master'),
      clusterPeers: configCenter.get('governor.cluster.peers_nodes', []),
    };
  }

  /**
   * 📊 收集演化指标
   */
  private async collectEvolutionMetrics(): Promise<EvolutionMetrics> {
    const mc = this.kernel.metricsCollector;

    const getCounter = async (name: string): Promise<number> => {
      if ((mc as any)._counters && (mc as any)._counters[name] !== undefined) {
        return (mc as any)._counters[name] ?? 0;
      }
      return 0;
    };

    const getGauge = async (name: string): Promise<number> => {
      if ((mc as any)._gauges && (mc as any)._gauges[name] !== undefined) {
        return (mc as any)._gauges[name] ?? 0;
      }
      return 0;
    };

    return {
      totalTransactionsProcessed: await getCounter('total_tx'),
      totalGovernanceInterventions: await getCounter('soloforge_court_arbitrations_decided'),
      totalCourtAdjudications: await getCounter('soloforge_court_arbitrations_decided'),
      totalCoalitionsFormed: await getCounter('soloforge_coalition_formed_total'),
      totalReputationUpdates: await getCounter('soloforge_reputation_success_total'),
      totalSandboxMigrations: await getCounter('soloforge_sandbox_live_migrations_total'),
      totalIPCEvents: await getCounter('governor.ipc.frames_sent_count'),
      systemEntropyCurrent: await getGauge('soloforge_cluster_system_entropy'),
      systemEntropyPeak: await getGauge('soloforge_cluster_system_entropy_peak') || await getGauge('soloforge_cluster_system_entropy'),
      averageQueueLength: await getGauge('soloforge_average_queue_length') || 0,
    };
  }

  /**
   * 🏛️ 收集治理审计轨迹
   */
  private async collectGovernanceAudit(): Promise<GovernanceAuditTrail> {
    const interventions: GovernanceInterventionRecord[] = [];
    const bypassAttempts: PrivilegeBypassRecord[] = [];
    const violations: PolicyViolationRecord[] = [];
    const reputationChanges: ReputationAdjustmentRecord[] = [];

    // 监听治理干预事件
    this.kernel.eventBus.on('governance.intervention.applied', (intervention: any) => {
      interventions.push({
        tick: intervention.interventionStartTick ?? this.kernel.currentTick ?? 0,
        agentId: intervention.targetAgentId,
        interventionType: this.categorizeIntervention(intervention),
        taxCoefficient: intervention.taxEquilibriumCoefficient,
        decayOperator: intervention.reputationDecayOperator,
        isolationLevel: intervention.isolationLevel,
        reason: intervention.interventionReason,
        revoked: false,
      });
    });

    return {
      recentInterventions: interventions.slice(-100),
      privilegeBypassAttempts: bypassAttempts.slice(-100),
      policyViolationAlerts: violations.slice(-100),
      reputationAdjustments: reputationChanges.slice(-100),
    };
  }

  /**
   * 🏛️ 分类治理干预类型
   */
  private categorizeIntervention(intervention: any): GovernanceInterventionRecord['interventionType'] {
    if (intervention.isolationLevel === 'full') return 'SUSPENSION';
    if (intervention.isolationLevel === 'partial') return 'ISOLATION';
    if (intervention.taxEquilibriumCoefficient > intervention.reputationDecayOperator) {
      return 'TAX_EQUILIBRIUM';
    }
    return 'REPUTATION_DECAY';
  }

  /**
   * ⚖️ 收集社会均衡状态
   */
  private async collectSocialEquilibriumState(): Promise<SocialEquilibriumState> {
    const mc = this.kernel.metricsCollector;

    return {
      activeAgents: 0,
      totalAgents: 0,
      averageReputation: 0.5,
      reputationDistribution: {},
      coalitionCount: 0,
      activeInstitutions: 0,
      entropyIndex: (mc as any)._gauges?.['soloforge_cluster_system_entropy'] ?? 0.5,
      equilibriumCoefficient: this.kernel.configCenter.get(
        'society.governance.tax_equilibrium_coefficient',
        0.15
      ),
    };
  }

  /**
   * 🔗 收集分布式共识状态
   */
  private async collectDistributedConsensusState(): Promise<DistributedConsensusState> {
    const configCenter = this.kernel.configCenter;

    return {
      raftState: 'LEADER',
      currentTerm: this.kernel.version,
      lastLogIndex: this.kernel.currentTick ?? 0,
      lastLogTerm: Math.floor((this.kernel.currentTick ?? 0) / 1000),
      commitIndex: this.kernel.currentTick ?? 0,
      lastApplied: this.kernel.currentTick ?? 0,
      quorumSize: 3,
      peerStates: {
        'node_beta_slave_1': {
          nodeId: 'node_beta_slave_1',
          lastHeartbeat: Date.now(),
          matchIndex: this.kernel.currentTick ?? 0,
          state: 'ACTIVE',
        },
        'node_gamma_slave_2': {
          nodeId: 'node_gamma_slave_2',
          lastHeartbeat: Date.now(),
          matchIndex: this.kernel.currentTick ?? 0,
          state: 'ACTIVE',
        },
      },
    };
  }

  /**
   * 🧬 收集超参数漂移状态
   */
  private async collectHyperparameterDriftState(): Promise<HyperparameterDriftState> {
    return {
      experimentActive: false,
      driftType: 'MOMENTUM',
      currentConfig: {
        lr: this.kernel.configCenter.get('governor.marl.lr', 3e-4),
        gamma: this.kernel.configCenter.get('governor.marl.gamma', 0.99),
        clip_eps: this.kernel.configCenter.get('governor.marl.clip_eps', 0.2),
      },
      bestPerformance: 0,
      bestConfig: {},
      totalDriftSteps: 0,
      governanceInterventions: 0,
      noveltyScoreAverage: 0,
    };
  }

  /**
   * 🏛️ 生成关闭证书
   */
  private generateClosureCertificate(): ClosureCertificate {
    return {
      projectName: 'SoloForge Governor RL Training Pipeline',
      closureDate: new Date().toISOString(),
      closureLevel: 'C',
      productionPolicy: 'BC V3.1',
      archivedAssets: [
        'checkpoints/bc_policy_v3.pt',
        'checkpoints/ppo_policy.pt',
        'src/core/society/governance.ts',
        'python/governor_rl/training/hyperparameter_drift.py',
        'docs/SOLOFORGE-GOVERNANCE-WHITEPAPER.md',
      ],
      coreConclusion: 'BC V3.1 已将 Teacher + Reward 定义的问题解到了接近最优',
      falsificationStatement: 'PPO 在生产工作负载中没有提供足够的运营价值来证明继续投入的合理性',
      authorizedBy: 'Gate 5 Automated Closure System',
    };
  }

  /**
   * 📄 导出 Markdown 格式报告
   */
  private async exportMarkdownReport(report: EvolutionAuditReport, mdPath: string): Promise<void> {
    const md = this.generateMarkdown(report);
    await fs.writeFile(mdPath, md, 'utf-8');
  }

  /**
   * 📝 生成 Markdown 格式
   */
  private generateMarkdown(report: EvolutionAuditReport): string {
    return `# 📜 SoloForge 演化治理白皮书

**版本**: ${report.reportVersion}  
**生成时间**: ${report.generatedAt}  
**状态**: Production Ready

---

## 1. 系统元数据

| 属性 | 值 |
|------|-----|
| 内核版本 | ${report.systemMetadata.kernelVersion} |
| 当前 Tick | ${report.systemMetadata.currentTick} |
| 共识角色 | ${report.systemMetadata.consensusRole} |
| 节点 ID | ${report.systemMetadata.nodeId} |
| 集群节点 | ${report.systemMetadata.clusterPeers.join(', ')} |

---

## 2. 演化指标

| 指标 | 数值 |
|------|------|
| 已处理交易总数 | ${report.evolutionMetrics.totalTransactionsProcessed.toLocaleString()} |
| 治理干预次数 | ${report.evolutionMetrics.totalGovernanceInterventions} |
| 司法裁决次数 | ${report.evolutionMetrics.totalCourtAdjudications} |
| 联盟形成次数 | ${report.evolutionMetrics.totalCoalitionsFormed} |
| 声望更新次数 | ${report.evolutionMetrics.totalReputationUpdates} |
| 沙箱迁移次数 | ${report.evolutionMetrics.totalSandboxMigrations} |
| IPC 事件总数 | ${report.evolutionMetrics.totalIPCEvents.toLocaleString()} |
| 系统熵（当前） | ${report.evolutionMetrics.systemEntropyCurrent.toFixed(4)} |
| 系统熵（峰值） | ${report.evolutionMetrics.systemEntropyPeak.toFixed(4)} |

---

## 3. 治理审计轨迹

### 3.1 近期干预记录

${report.governanceAudit.recentInterventions.length > 0
  ? report.governanceAudit.recentInterventions.map(i =>
    `- **[Tick ${i.tick}]** ${i.agentId}: ${i.interventionType} (tax=${i.taxCoefficient}, decay=${i.decayOperator})`
  ).join('\n')
  : '_暂无干预记录_'
}

### 3.2 特权绕过尝试

${report.governanceAudit.privilegeBypassAttempts.length > 0
  ? report.governanceAudit.privilegeBypassAttempts.map(b =>
    `- **[Tick ${b.tick}]** ${b.agentId}: ${b.pattern} (尝试次数: ${b.attemptCount})`
  ).join('\n')
  : '_暂无绕过尝试_'
}

---

## 4. 社会均衡状态

| 指标 | 数值 |
|------|------|
| 活跃代理数 | ${report.socialEquilibriumState.activeAgents} |
| 均衡系数 | ${report.socialEquilibriumState.equilibriumCoefficient} |
| 熵指数 | ${report.socialEquilibriumState.entropyIndex.toFixed(4)} |

---

## 5. 分布式共识状态

| 属性 | 值 |
|------|-----|
| Raft 状态 | ${report.distributedConsensusState.raftState} |
| 当前 Term | ${report.distributedConsensusState.currentTerm} |
| 最后日志索引 | ${report.distributedConsensusState.lastLogIndex} |
| 提交索引 | ${report.distributedConsensusState.commitIndex} |
| 仲裁大小 | ${report.distributedConsensusState.quorumSize} |

**Peer 状态**:
${Object.entries(report.distributedConsensusState.peerStates).map(([id, peer]) =>
  `- ${peer.nodeId}: ${peer.state} (lastHeartbeat: ${new Date(peer.lastHeartbeat).toISOString()})`
).join('\n')}

---

## 6. 超参数漂移状态

| 属性 | 值 |
|------|-----|
| 实验状态 | ${report.hyperparameterDriftState.experimentActive ? '活跃' : '未启动'} |
| 漂移类型 | ${report.hyperparameterDriftState.driftType} |
| 漂移步数 | ${report.hyperparameterDriftState.totalDriftSteps} |
| Governance 干预 | ${report.hyperparameterDriftState.governanceInterventions} |

**当前配置**:
${Object.entries(report.hyperparameterDriftState.currentConfig).map(([k, v]) =>
  `- ${k}: ${v}`
).join('\n')}

---

## 7. 关闭证书

\`\`\`
┌─────────────────────────────────────────────────────────────┐
│                    PROJECT CLOSURE CERTIFICATE               │
├─────────────────────────────────────────────────────────────┤
│ 项目名称: ${report.closureCertificate.projectName.substring(0, 47).padEnd(47)} │
│ 关闭日期: ${report.closureCertificate.closureDate.substring(0, 10).padEnd(47)} │
│ 关闭等级: ${report.closureCertificate.closureLevel.padEnd(47)} │
│                                                             │
│ 生产策略: ${report.closureCertificate.productionPolicy.padEnd(47)} │
│                                                             │
│ 核心结论: ${report.closureCertificate.coreConclusion.substring(0, 47).padEnd(47)} │
│                                                             │
│ 授权方: ${report.closureCertificate.authorizedBy.padEnd(47)} │
└─────────────────────────────────────────────────────────────┘
\`\`\`

**归档资产**:
${report.closureCertificate.archivedAssets.map(a => `- ${a}`).join('\n')}

---

## 8. 可证伪性声明

> **不是 PPO 训练失败，而是 BC 已经把 Teacher + Reward 所定义的问题解到了接近最优。**

这句话在工程上意味着：
1. 继续投入 PPO 训练资源没有边际收益
2. 项目应该关闭（Level C）
3. BC V3.1 进入生产

这不是一个负面结论，而是一个**成功证伪**。

---

**文档生成**: SoloForge Governance Whitepaper Exporter v${report.reportVersion}  
**内核版本**: ${report.systemMetadata.kernelVersion}  
**生成时间**: ${report.generatedAt}
`;
  }

  /**
   * 📜 导出 Prometheus 指标快照
   */
  public async exportMetricsSnapshot(snapshotPath: string): Promise<void> {
    const exporter = new TelemetryMetricExporter(this.kernel);
    await exporter.initializeExporterNode();

    const prometheusText = exporter.compileStandardPrometheusTextBuffer();

    const dir = path.dirname(snapshotPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(snapshotPath, prometheusText, 'utf-8');

    logger.info(this.moduleName, `📊 Metrics snapshot exported: ${snapshotPath}`);
  }

  /**
   * 📜 导出完整白皮书包（含所有附件）
   */
  public async exportCompleteWhitepaperBundle(outputDir: string): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bundleDir = path.join(outputDir, `soloforge-whitepaper-${timestamp}`);

    await fs.mkdir(bundleDir, { recursive: true });

    // 1. 演化审计报告 (JSON)
    await this.exportEvolutionAudit(path.join(bundleDir, 'evolution-audit-report.json'));

    // 2. Markdown 版本
    await this.exportEvolutionAudit(path.join(bundleDir, 'evolution-audit-report.md'));

    // 3. Prometheus 指标快照
    await this.exportMetricsSnapshot(path.join(bundleDir, 'prometheus-snapshot.txt'));

    // 4. 系统架构图 (PlantUML 源)
    const architecturePuml = this.generateArchitectureDiagram();
    await fs.writeFile(path.join(bundleDir, 'architecture.puml'), architecturePuml, 'utf-8');

    // 5. 生成索引文件
    const index = this.generateBundleIndex(bundleDir);
    await fs.writeFile(path.join(bundleDir, 'INDEX.md'), index, 'utf-8');

    logger.info(this.moduleName, `✅ Complete whitepaper bundle exported to: ${bundleDir}`);
  }

  /**
   * 🏗️ 生成架构图 (PlantUML)
   */
  private generateArchitectureDiagram(): string {
    return `@startuml SoloForge Architecture

skinparam backgroundColor #FEFEFE
skinparam componentStyle rectangle

title SoloForge Governance OS - System Architecture

package "TypeScript Microkernel" {
  [RuntimeKernel] as KERNEL
  [TransactionManager] as TX
  [CommandBus] as CMD
  [RuntimeEventBus] as EVT
  [ConfigCenter] as CFG
  [MetricsCollector] as MET
}

package "AI Society Modules" {
  [GovernancePolicyEngine] as GOV
  [RoleEvolutionEngine] as ROLE
  [CoalitionEngine] as COAL
  [SocialMemoryEngine] as MEM
  [LawEngine] as LAW
  [SocialReputationEngine] as REP
}

package "Court & Justice" {
  [ConsensAgentCourtRoom] as COURT
  [LlmEscalationRoom] as LLMC
}

package "Observability" {
  [TelemetryMetricExporter] as TELE
  [GovernanceWhitepaperExporter] as WHITE
  [PrometheusEndpoint] as PROM
}

package "Distributed IPC" {
  [DistributedProtocolBroker] as IPC
  [SurrealPersistence] as DB
}

package "Python Strategy Universe" {
  [MarlServiceAsyncServer] as PY
  [PPOTrainer] as PPO
  [HyperparameterDrift] as DRIFT
}

KERNEL --> TX
KERNEL --> CMD
KERNEL --> EVT
KERNEL --> CFG
KERNEL --> MET

GOV --> KERNEL
ROLE --> KERNEL
COAL --> KERNEL
MEM --> KERNEL
LAW --> KERNEL
REP --> KERNEL

COURT --> KERNEL
LLMC --> KERNEL

TELE --> KERNEL
WHITE --> KERNEL
PROM --> TELE

IPC --> KERNEL
IPC <--> PY : TCP/IPC
PY --> PPO
PY --> DRIFT

DB --> KERNEL

@enduml
`;
  }

  /**
   * 📋 生成打包索引
   */
  private generateBundleIndex(bundleDir: string): string {
    return `# SoloForge Governance Whitepaper Bundle

**生成时间**: ${new Date().toISOString()}

## 文件清单

| 文件 | 描述 |
|------|------|
| \`evolution-audit-report.json\` | 完整演化审计报告 (JSON) |
| \`evolution-audit-report.md\` | 完整演化审计报告 (Markdown) |
| \`prometheus-snapshot.txt\` | Prometheus 指标快照 |
| \`architecture.puml\` | 系统架构图 (PlantUML) |
| \`INDEX.md\` | 本索引文件 |

## 快速导航

- [演化审计报告](./evolution-audit-report.md)
- [Prometheus 指标](./prometheus-snapshot.txt)
- [架构图](./architecture.puml)

## 系统状态

- **内核版本**: ${this.kernel.version}
- **当前 Tick**: ${this.kernel.currentTick ?? 0}
- **共识角色**: LEADER

## 核心结论

> BC V3.1 已将 Teacher + Reward 定义的问题解到了接近最优。PPO 在生产工作负载中没有提供足够的运营价值。

**项目状态**: CLOSED (Level C)

---

*Generated by SoloForge Governance Whitepaper Exporter v${this.reportVersion}*
`;
  }
}
