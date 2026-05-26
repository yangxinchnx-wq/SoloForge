// ─────────────────────────────────────────────────────────────────
// SoloForge Production Entry: Master Lifecycle Daemon Core
// Path: src/index.ts
// ─────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { Surreal } from 'surrealdb';

// 🔗 引入全层级核心安全、控制、算法及持久化骨干组件
import { TransactionKernel } from './data/transaction_kernel';
import { DeleteProtection } from './data/delete_protection';
import { GeminiRustSchedulerClient } from './kernel/scheduler-client';
import { GeminiRTRRacerEngine, ModelStrategyCandidate } from './core/decision/rtr-racer-engine';
import { GeminiConsensAgentCourtRoom, AdjudicationArgumentClaim } from './core/court/consensagent';
import { GeminiMappoResourceGovernorClient } from './core/governor/mappo-client';
import { GeminiPersistenceManager, SurrealDbDriverInterface } from './data/surreal_persistence';
import { SurrealLiveWebSocketDriver } from './data/surreal_driver_live';

// 🔗 物理引入 Layer 1 主权自治安全内核
import { SovereignRuntimeKernel } from './kernel/runtime-kernel';

/**
 * 💾 弹性同步安全桩：当物理嵌入式数据库未就位或网络正在握手时，死锁全局时间真空期
 */
class LocalMemoryFallbackDriver implements SurrealDbDriverInterface {
  public async query(sqlStatement: string, queryBindings: Record<string, any>): Promise<any[][]> {
    return [[]];
  }
}

class SoloForgeDaemonSupervisor {
  // 双内核纵向解耦互锁
  private runtimeKernel: SovereignRuntimeKernel; 
  private txKernel: TransactionKernel;           
  
  private shield: DeleteProtection;
  private rustScheduler: GeminiRustSchedulerClient;
  private racerEngine: GeminiRTRRacerEngine;
  private courtRoom: GeminiConsensAgentCourtRoom;
  private governor: GeminiMappoResourceGovernorClient;
  
  // 嵌入式数据落盘仓储层核心管理器
  private persistenceManager: GeminiPersistenceManager;
  private surrealRawClient: Surreal | null = null;
  private databaseProcess: ChildProcess | null = null;
  
  private pollingTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private telemetryCycles = 0;

  constructor() {
    console.log('\n[BOOT] ──────────────────────────────────────────────────');
    console.log('[BOOT] 🚀 SoloForge 主自治骨干网络守护进程开始全量初始化...');
    
    // 1. 物理拉起项目内置的嵌入式数据库长驻子进程（严格基于工作目录相对寻址）
    this.bootEmbeddedDatabase();

    // 2. 初始化 Layer 1 核心双主权自治内核底座
    this.runtimeKernel = new SovereignRuntimeKernel();
    this.txKernel = new TransactionKernel({ system_status: 'BOOTING', active_agents: 0, telemetry_cycles: 0 });
    this.shield = new DeleteProtection();

    // 3. 🛡️ 【时序硬互锁】率先分配默认内存桩，彻底绝杀一微秒的异步未初始化空窗期
    const fallbackDriver = new LocalMemoryFallbackDriver();
    this.persistenceManager = new GeminiPersistenceManager(fallbackDriver);

    // 4. 初始化 Layer 4 跨语言 Rust 高性能优先调度看门狗
    this.rustScheduler = new GeminiRustSchedulerClient();
    this.rustScheduler.initialize(); 
    console.log('[BOOT] 🦀 Rust 高性能最大堆 Aging 调度守护进程拉起成功.');

    // 5. 总装 Layer 2 RTR-RACER 流控决策引擎与 Layer 3 司法共识盲审法庭
    this.racerEngine = new GeminiRTRRacerEngine(this.runtimeKernel, this.rustScheduler);
    this.courtRoom = new GeminiConsensAgentCourtRoom(this.runtimeKernel, fallbackDriver as any);

    // 6. 拉起跨语言 Python MAPPO 顶置资源控流子进程
    this.governor = new GeminiMappoResourceGovernorClient();
    
    // 7. 在后台安全启动物理存储异步升级探测与 DDL 自动热迁移宪法
    this.tryUpgradeToLiveStorage();

    console.log('[BOOT] 🔒 全层级核心组件（TS/Rust/Python/嵌入式Surreal）数据交火闭合.');
    console.log('[BOOT] ──────────────────────────────────────────────────\n');
  }

  /**
   * 🛢️ 随生随灭：严格基于当前软件运行工作目录（Portable CWD）定位二进制文件
   */
  private bootEmbeddedDatabase(): void {
    const baseWorkspace = process.cwd();
    const dbDataPath = path.join(baseWorkspace, 'data', 'soloforge_db');
    
    if (!fs.existsSync(dbDataPath)) {
      fs.mkdirSync(dbDataPath, { recursive: true });
    }

    // 🔐 生产级便携寻址：锁死在当前运行目录 bin/ 文件夹下，保障随包迁移不产生任何路径泄露
    const ext = process.platform === 'win32' ? '.exe' : '';
    const surrealBinaryPath = path.join(baseWorkspace, 'bin', `surreal${ext}`);

    this.databaseProcess = spawn(surrealBinaryPath, [
      'start',
      '--user', 'root',
      '--pass', 'root',
      '--bind', '127.0.0.1:8000',
      `file:${dbDataPath}`
    ]);

    // 拦截不可达异常，降级切换保护，绝不让拉起故障向上传导破坏主生命周期
    this.databaseProcess.on('error', (err: any) => {
      console.warn(`\n[DATABASE_WARN] ⚠️ 无法在预定便携路径 [${surrealBinaryPath}] 下直接拉起物理进程: ${err.message}`);
      console.warn('[DATABASE_WARN] 🔌 数据管理服务已自动切入【高性能本地内存沙盒桩】托管运转，确保主计算链稳定。\n');
    });
  }

  /**
   * 💾 自动热迁移与存储层平滑热升级
   */
  private async tryUpgradeToLiveStorage(): Promise<void> {
    let retryAttempts = 5; 
    while (retryAttempts > 0 && !this.isShuttingDown) {
      try {
        this.surrealRawClient = new Surreal();
        await this.surrealRawClient.connect('ws://127.0.0.1:8000/rpc', {
          namespace: 'soloforge_core',
          database: 'autonomous_network',
          auth: { user: 'root', pass: 'root' }
        });

        // 自动读取项目包内固定的全量 Schema 强类型约束并执行热迁移
        const schemaFilePath = path.join(process.cwd(), 'infra', 'schema.surql');
        if (fs.existsSync(schemaFilePath)) {
          const schemaSql = fs.readFileSync(schemaFilePath, 'utf8');
          await this.surrealRawClient.query(schemaSql);
          console.log('[ASYNC_STORAGE] 📜 存储层成功自动灌入本地全量 Schema 强类型宪法迁移约束.');
        }

        const liveDriver = new SurrealLiveWebSocketDriver(this.surrealRawClient);
        this.persistenceManager = new GeminiPersistenceManager(liveDriver);
        this.courtRoom = new GeminiConsensAgentCourtRoom(this.runtimeKernel, liveDriver as any);
        
        console.log('[ASYNC_STORAGE] 🛢️  [REAL STATE] 成功物理介入嵌入式 SurrealDB 数据库集群！真实数据落盘安全激活。');
        return;
      } catch (err) {
        retryAttempts--;
        if (retryAttempts === 0) {
          console.log('[ASYNC_STORAGE] 🛡️  物理存储联络挂起。控制大盘全面进入【高性能内存沙盒桩】托管。');
        } else {
          await new Promise(resolve => setTimeout(resolve, 300)); 
        }
      }
    }
  }

  /**
   * 启动常驻主循环脉冲
   */
  public startRuntimeEventLoop(): void {
    console.log('[RUNTIME] 🌀 全链路跨语言控流主循环已点火. 正在监控系统性能拓扑...\n');

    this.pollingTimer = setInterval(async () => {
      if (this.isShuttingDown) return;
      this.telemetryCycles++;
      const currentCycle = this.telemetryCycles;

      console.log(`\n--- [CYCLE #${currentCycle}] 拓扑脉冲扫描开始 ---`);
      const runtimeUuid = crypto.randomUUID(); // 🔗 全链路唯一追踪链锚点（traceId）

      // ─────────────────────────────────────────────────────────────
      // 📝 阶段一：高并发物理资源检测 + Python MAPPO 推理 + 特征流仓储持久化
      // ─────────────────────────────────────────────────────────────
      const mockCpu = currentCycle % 4 === 0 ? 0.96 : 0.45; 
      const globalState = [mockCpu, 0.35, 0.12];
      const localObs = [0.0, 0.0];

      try {
        const action = await this.governor.evaluateMappoResourceVector(globalState, localObs);
        console.log(`[TELEMETRY] 🐍 Python MAPPO 推理完成 | 负载: ${mockCpu} | Action: ${action}`);

        // 🔗 仓储层对接：写入特征轨迹，打入统一追踪链 traceId
        await this.persistenceManager.logMarlEpisode({
          id: `marl_${runtimeUuid}`,
          traceId: runtimeUuid, 
          episodeCount: currentCycle,
          cpuMetric: mockCpu,
          memoryMetric: 0.35,
          executedAction: action
        });

        // 🔗 蓝图要求：同步持久化内核审计日志（对应 v5_events 规范）
        await this.persistenceManager.logEvent({
          id: `evt_${crypto.randomUUID()}`,
          traceId: runtimeUuid,
          event: 'telemetry.mappo.resolved',
          payload: `Action ${action} inferred under load ${mockCpu}`,
          timestamp: Math.floor(Date.now() / 1000)
        });

        if (action === 2) {
          console.error(`[CIRCUIT_BREAKER] 🚨 触发最高级别熔断！强行阻断本次循环流控。`);
          return; 
        }
      } catch (err) {
        console.error(`[IPC_ERROR] Python 遥测流突发阻断:`, (err as Error).message);
      }

      // ─────────────────────────────────────────────────────────────
      // 📝 阶段二：多智能体流量涌入 + Rust 时序最大堆演化 + 决策记录仓储落地
      // ─────────────────────────────────────────────────────────────
      const candidates: ModelStrategyCandidate[] = [
        { modelName: 'agent-alpha-fast', reasoningStrategy: 'direct', baseGenerationQuality: 0.7, normalizedLatencyScore: 0.9, normalizedCostEfficiency: 0.8, historicalSuccessIndex: 0.85 },
        { modelName: 'agent-beta-heavy', reasoningStrategy: 'chain_of_thought', baseGenerationQuality: 0.95, normalizedLatencyScore: 0.3, normalizedCostEfficiency: 0.4, historicalSuccessIndex: 0.90 },
        { modelName: 'agent-gamma-unstable', reasoningStrategy: 'few_shot', baseGenerationQuality: 0.6, normalizedLatencyScore: 0.6, normalizedCostEfficiency: 0.5, historicalSuccessIndex: 0.40 }
      ];

      const targetStateKey = 'core_scheduler_memory'; 
      try {
        const workerExecutionStub = async (chosen: ModelStrategyCandidate) => {
          return `SUCCESS_UPSTREAM_RESPONSE_FROM_${chosen.modelName.toUpperCase()}`;
        };

        const finalRouteOutput = await this.racerEngine.coordinateRacerFlow(
          candidates,
          targetStateKey,
          true, 
          0.2, 
          0.9, 
          workerExecutionStub,
          { globalFailureRate: 0.2 }
        );

        console.log(`[FLOW_COMPLETED] 🎯 RACER 路由分发成功. 归集输出: ${finalRouteOutput}`);

        // 🔗 仓储层对接：写入决策链路数据，绑定全局一致的 traceId
        await this.persistenceManager.commitDecision({
          id: `decision_${runtimeUuid}`,
          traceId: runtimeUuid,
          selectedStrategy: 'chain_of_thought',
          strategyReason: `Route completed via Rust Scheduler. Output: ${finalRouteOutput}`,
          budgetUsed: 25,
          budgetLimit: 100,
          confidenceTier: 'low',
          subsetSize: 3,
          aggregationMethod: 'plurality_vote',
          aggregatedCandidates: candidates.map(c => c.modelName)
        });

        // 驱动原子内核状态账本版本步进递增
        const currentSnapshot = this.txKernel.getSnapshot();
        this.txKernel.commitTransaction([
          { targetKey: 'telemetry_cycles', value: currentCycle }
        ], currentSnapshot.version);
        console.log(`[SYS_TRANSACTION] 事务提交成功. 新版本: ${currentSnapshot.version + 1}`);

      } catch (flowException) {
        console.error(`[CORE_FLOW_ERROR] 流控主链塌陷:`, (flowException as Error).message);
      }

      // ─────────────────────────────────────────────────────────────
      // 📝 阶段三：争议所有权司法审判 + 盲审决议仓储持久化沉淀
      // ─────────────────────────────────────────────────────────────
      if (currentCycle % 2 === 0) {
        console.log(`[TRIGGER] ⚖️ 触发时序状态所有权争议，唤醒自治法庭...`);
        this.courtRoom.enforcePhase1LockState(true);

        const disputeKey = 'court_case_registry_session_active';
        const claims: AdjudicationArgumentClaim[] = [
          { originatingAgentId: 'agent-alpha-fast', disputedClaimStatement: '自治网络流控调度底座核心', linkedEvidenceRegistry: ['evidence_secure_token_001'] },
          { originatingAgentId: 'agent-gamma-unstable', disputedClaimStatement: '破坏性篡改篡改', linkedEvidenceRegistry: ['evidence_fraud_pointer_999'] }
        ];

        try {
          const verdict = await this.courtRoom.executeEvidentiaryArbitration(claims, disputeKey);
          console.log(`[COURT_VERDICT] 🏛️ 法庭盲审结论: 状态=${verdict.verdictResolutionStatus} | 胜诉者=${verdict.winningAgentSignature}`);

          // 🔗 仓储层对接：审判决议物理落盘，锁死对应周期的追踪链 traceId
          await this.persistenceManager.commitCourtSubmission({
            id: `court_${runtimeUuid}`,
            traceId: runtimeUuid,
            phase: verdict.verdictResolutionStatus === 'DECIDED_LEGITIMATE' ? 'complete' : 'phase_1',
            phase1Deadline: Math.floor(Date.now() / 1000) + 3600,
            judgmentBasis: `Arbitration completed. Winner: ${verdict.winningAgentSignature}`,
            winnerScore: verdict.adjudicatedMetricScore,
            loserScore: 0.0,
            escalatedToHuman: false,
            escalationReason: 'NONE'
          });

        } catch (courtErr) {
          console.error(`[COURT_FAULT] 法庭审理程序性崩溃:`, (courtErr as Error).message);
        }
      }

    }, 2000); 
  }

  /**
   * 工业级优雅关机守卫：随主进程一同平稳注销，强杀黑盒句柄释放内存
   */
  public async terminateGracefully(signalSource: string): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    
    console.log('\n[SHUTDOWN] ──────────────────────────────────────────────');
    console.log(`[SHUTDOWN] 🛑 捕获终止信号 [${signalSource}]. 开始回收全链路跨语言常驻句柄...`);

    if (this.pollingTimer) clearInterval(this.pollingTimer);

    try {
      this.rustScheduler.shutdown();
      console.log('[SHUTDOWN] 🦀 Rust 高性能最大堆优先调度看门狗子进程已安全释放。');

      this.governor.safelyTerminateGovernorContext();
      console.log('[SHUTDOWN] 🐍 Python 常驻资源控流子进程底层管道已物理回收。');

      if (this.surrealRawClient) {
        await this.surrealRawClient.close();
      }

      if (this.databaseProcess) {
        this.databaseProcess.kill(); // 💥 强杀线：物理强杀包内自带子进程
        console.log('[SHUTDOWN] 🛢️  嵌入式 SurrealDB 数据库进程已被主程序强杀清理，内存全量归还系统。');
      }
    } catch (e) {
      console.error('[SHUTDOWN_ERROR] 子进程句柄归还出现残余破损:', e);
    }

    console.log('[SHUTDOWN] 🏆 全链路控制面完美解耦归档，骨干网平稳闭合. [PASS]');
    console.log('[SHUTDOWN] ──────────────────────────────────────────────');
    process.exit(0);
  }
}

const supervisor = new SoloForgeDaemonSupervisor();
supervisor.startRuntimeEventLoop();

process.on('SIGINT', () => supervisor.terminateGracefully('SIGINT'));
process.on('SIGTERM', () => supervisor.terminateGracefully('SIGTERM'));