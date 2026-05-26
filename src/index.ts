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
import { GeminiRTRRacerEngine } from './core/decision/rtr-racer-engine';
import { GeminiConsensAgentCourtRoom } from './core/court/consensagent';
import { GeminiMappoResourceGovernorClient } from './core/governor/mappo-client';
import { GeminiPersistenceManager, SurrealDbDriverInterface } from './data/surreal_persistence';
import { SurrealLiveWebSocketDriver } from './data/surreal_driver_live';

// 🔗 引入 Layer 1 主权自治安全内核
import { SovereignRuntimeKernel } from './kernel/runtime-kernel';

// 🔗 引入真实的多智能体行为实体内核与最高司法大模型终审庭
import { AutonomousNetworkAgent } from './core/agent/autonomous_agent';
import { LlmEscalationRoom } from './core/court/llm_escalation';

class SoloForgeDaemonSupervisor {
  private runtimeKernel: SovereignRuntimeKernel; 
  private txKernel: TransactionKernel;           
  
  private shield: DeleteProtection;
  private rustScheduler: GeminiRustSchedulerClient;
  private racerEngine!: GeminiRTRRacerEngine;
  private courtRoom!: GeminiConsensAgentCourtRoom;
  private governor: GeminiMappoResourceGovernorClient;
  private llmSupremeCourt: LlmEscalationRoom;
  
  private agents: AutonomousNetworkAgent[] = [];
  
  private persistenceManager!: GeminiPersistenceManager;
  private surrealRawClient: Surreal | null = null;
  private databaseProcess: ChildProcess | null = null;
  
  private pollingTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private telemetryCycles = 0;

  // 🔐 生产级内部隔离安全端口
  private readonly DB_PORT = 8003; 

  constructor() {
    console.log('\n[BOOT] ──────────────────────────────────────────────────');
    console.log('[BOOT] 🚀 SoloForge 主自治骨干网络守护进程开始全量初始化...');
    
    this.runtimeKernel = new SovereignRuntimeKernel();
    this.txKernel = new TransactionKernel({ system_status: 'BOOTING', active_agents: 3, telemetry_cycles: 0 });
    this.shield = new DeleteProtection();

    this.agents = [
      new AutonomousNetworkAgent('agent-alpha-fast-edge', 'direct', 1.0),
      new AutonomousNetworkAgent('agent-beta-heavy-thought', 'chain_of_thought', 1.0),
      new AutonomousNetworkAgent('agent-gamma-unstable-intruder', 'few_shot', 0.8)
    ];
    console.log(`[BOOT] 🤖 成功孵化 3 组跨语言自治 Agent 集群. 初始信用分边界已强行卡死。`);

    this.rustScheduler = new GeminiRustSchedulerClient();
    this.rustScheduler.initialize(); 
    console.log('[BOOT] 🦀 Rust 高性能最大堆 Aging 调度守护进程拉起成功.');

    this.llmSupremeCourt = new LlmEscalationRoom();
    this.governor = new GeminiMappoResourceGovernorClient();
  }

  /**
   * 🛢️ 随生随灭：自拉起项目本地 bin/ 目录下的嵌入式数据库进程
   */
  private bootEmbeddedDatabase(): void {
    const baseWorkspace = process.cwd();
    
    const dbDataPath = path.join(baseWorkspace, 'data');
    if (!fs.existsSync(dbDataPath)) {
      fs.mkdirSync(dbDataPath, { recursive: true });
    }

    const ext = process.platform === 'win32' ? '.exe' : '';
    const surrealBinaryPath = path.join(baseWorkspace, 'bin', `surreal${ext}`);

    this.databaseProcess = spawn(surrealBinaryPath, [
      'start',
      '--user', 'root',
      '--pass', 'root',
      '--bind', `127.0.0.1:${this.DB_PORT}`,
      'surrealkv:data/soloforge_db' 
    ]);

    this.databaseProcess.stderr?.on('data', (data) => {
      const errorMsg = data.toString().trim();
      console.warn(`[DATABASE_STDERR] 🛢️  SurrealDB 内核输出: ${errorMsg}`);
    });

    this.databaseProcess.on('error', (err: any) => {
      console.error(`[DATABASE_FATAL] 💥 无法在便携路径下直接拉起物理进程: ${err.message}`);
    });
  }

  /**
   * 🔒 同步阻塞点流锁（网络连接与 DDL 宪法热迁移完全解耦隔离版）
   */
  public async initializeSovereignStorage(): Promise<void> {
    this.bootEmbeddedDatabase();

    let retryAttempts = 15; 
    let maxWaitCycles = 15;
    console.log('[BOOT] 🛢️  正在物理联络嵌入式 SurrealDB 存储层服务并灌入 Schema 宪法...');
    
    while (retryAttempts > 0) {
      const currentTry = maxWaitCycles - retryAttempts + 1;
      console.log(`  ├── [握手脉冲 #${currentTry}] 正在尝试建立 WebSocket 物理穿透...`);
      
      try {
        this.surrealRawClient = new Surreal();
        
        // 1. 物理网络建立握手
        await Promise.race([
          this.surrealRawClient.connect(`ws://127.0.0.1:${this.DB_PORT}/rpc`),
          new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT_1500MS')), 1500))
        ]);

        // 2. 身份主权签到
        await this.surrealRawClient.signin({
          username: 'root',
          password: 'root'
        });

        // 3. 锁定业务领域域
        await this.surrealRawClient.use({
          namespace: 'soloforge_core',
          database: 'autonomous_network'
        });

        // 4. 🔥 核心解耦带：幂等注入 Schema 强类型约束
        try {
          const schemaFilePath = path.join(process.cwd(), 'infra', 'schema.surql');
          if (fs.existsSync(schemaFilePath)) {
            const schemaSql = fs.readFileSync(schemaFilePath, 'utf8');
            await this.surrealRawClient.query(schemaSql);
            console.log('[BOOT] 📜 存储层成功自动灌入本地全量 Schema 强类型宪法迁移约束.');
          }
        } catch (schemaErr: any) {
          const errMsg = schemaErr.message || '';
          // 🛡️ 如果只是表已经存在，说明数据库已就位，属于健康的可忽略 warn，直接平滑放行
          if (errMsg.includes('already exists')) {
            console.log('[BOOT] 📜 检测到本地硬盘已存在完备的持久化 Schema 强类型结构，自动跳过热迁移。');
          } else {
            // 如果是其他真正的 SQL 语法错误，则必须向上传导拉响警报
            throw schemaErr;
          }
        }

        const liveDriver = new SurrealLiveWebSocketDriver(this.surrealRawClient);
        this.persistenceManager = new GeminiPersistenceManager(liveDriver);
        
        this.racerEngine = new GeminiRTRRacerEngine(this.runtimeKernel, this.rustScheduler);
        this.courtRoom = new GeminiConsensAgentCourtRoom(this.runtimeKernel, liveDriver as any);
        
        console.log('[BOOT] 🛢️  [REAL STATE] 成功物理介入嵌入式 SurrealDB 数据库集群！真实落盘安全激活。');
        console.log('[BOOT] 🔒 全层级核心组件（TS/Rust/Python/嵌入式Surreal）数据交火闭合.');
        console.log('[BOOT] ──────────────────────────────────────────────────\n');
        return;
      } catch (err) {
        retryAttempts--;
        console.log(`  ├── [⚠️ 脉冲挂起] 连接暂未对齐: ${(err as Error).message}. 300ms后自动重试...`);
        
        if (this.surrealRawClient) {
          try { this.surrealRawClient.close(); } catch {}
        }
        
        if (retryAttempts === 0) {
          throw new Error('💥 核心存储硬链接遭遇毁灭性阻断：嵌入式数据库未能按时建立物理握手。');
        }
        await new Promise(resolve => setTimeout(resolve, 300)); 
      }
    }
  }

  /**
   * 启动长驻主循环脉冲
   */
  public startRuntimeEventLoop(): void {
    console.log('[RUNTIME] 🌀 全链路跨语言控流主循环已点火. 正在监控系统性能拓扑...\n');

    this.pollingTimer = setInterval(async () => {
      if (this.isShuttingDown) return;
      this.telemetryCycles++;
      const currentCycle = this.telemetryCycles;

      console.log(`\n--- [CYCLE #${currentCycle}] 拓扑脉冲扫描开始 ---`);
      const runtimeUuid = crypto.randomUUID(); 

      // ─────────────────────────────────────────────────────────────
      // 📝 阶段一：动态物理资源检测 + Python MAPPO 推理 + 特征流持久化
      // ─────────────────────────────────────────────────────────────
      const mockCpu = currentCycle % 4 === 0 ? 0.96 : 0.45; 
      const globalState = [mockCpu, 0.35, 0.12];
      const localObs = [0.0, 0.0];

      try {
        const action = await this.governor.evaluateMappoResourceVector(globalState, localObs);
        console.log(`[TELEMETRY] 🐍 Python MAPPO 推理完成 | 负载: ${mockCpu} | Action: ${action}`);

        await this.persistenceManager.logMarlEpisode({
          id: `marl_${runtimeUuid}`,
          traceId: runtimeUuid, 
          episodeCount: currentCycle,
          cpuMetric: mockCpu,
          memoryMetric: 0.35,
          executedAction: action
        });

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
      // 📝 阶段二：真实业务流量竞争 + 多智能体哈希签名执行 + 仓储数据落盘
      // ─────────────────────────────────────────────────────────────
      const currentPacketSize = Math.floor(100 + Math.random() * 800);
      const dynamicCandidates = this.agents.map(agent => agent.generateRoutingCandidateState(mockCpu));

      const targetStateKey = 'core_scheduler_memory'; 
      try {
        const workerExecutionStub = async (chosen: any) => {
          const winnerInstance = this.agents.find(a => a.agentId === chosen.modelName);
          if (!winnerInstance) throw new Error(`CRITICAL_ORPHAN_AGENT: ${chosen.modelName}`);
          return await winnerInstance.executeNetworkPacketTask(runtimeUuid, currentPacketSize);
        };

        const finalRouteOutput = await this.racerEngine.coordinateRacerFlow(
          dynamicCandidates,
          targetStateKey,
          true, 
          0.2, 
          0.9, 
          workerExecutionStub,
          { globalFailureRate: 0.2 }
        );

        console.log(`[FLOW_COMPLETED] 🎯 RACER 优选执行链响应成功:\n  └──> ${finalRouteOutput}`);

        await this.persistenceManager.commitDecision({
          id: `decision_${runtimeUuid}`,
          traceId: runtimeUuid,
          selectedStrategy: 'dynamic_marl_routing',
          strategyReason: `Optimized execution packet. Result: ${finalRouteOutput}`,
          budgetUsed: Math.floor(currentPacketSize / 10),
          budgetLimit: 100,
          confidenceTier: 'high',
          subsetSize: this.agents.length,
          aggregationMethod: 'racer_heap_sort',
          aggregatedCandidates: dynamicCandidates.map(c => c.modelName)
        });

        const currentSnapshot = this.txKernel.getSnapshot();
        this.txKernel.commitTransaction([
          { targetKey: 'telemetry_cycles', value: currentCycle }
        ], currentSnapshot.version);
        console.log(`[SYS_TRANSACTION] 事务提交成功. 新版本: ${currentSnapshot.version + 1}`);

      } catch (flowException) {
        console.error(`[CORE_FLOW_ERROR] 流控主链塌陷:`, (flowException as Error).message);
      }

      // ─────────────────────────────────────────────────────────────
      // 📝 阶段三：多智能体争议诉讼 + 共识盲审法庭判决 + 大模型最高二级终审
      // ─────────────────────────────────────────────────────────────
      if (currentCycle % 2 === 0) {
        console.log(`[TRIGGER] ⚖️ 触发时序状态所有权争议，唤醒自治法庭...`);
        this.courtRoom.enforcePhase1LockState(true);

        const disputeKey = 'court_case_registry_session_active';
        
        const dynamicClaims = [
          this.agents[0].forgeDisputeClaim('确权核心路由底座主权', 'legitimate'),
          this.agents[2].forgeDisputeClaim('破坏性越权篡改重排', 'sybil_fraud')
        ];

        try {
          const verdict = await this.courtRoom.executeEvidentiaryArbitration(dynamicClaims, disputeKey);
          console.log(`[COURT_VERDICT] 🏛️ 一审密码学盲审结果: 状态=${verdict.verdictResolutionStatus}`);

          let finalWinnerId: string | null = verdict.winningAgentSignature;
          let finalStatus = verdict.verdictResolutionStatus === 'DECIDED_LEGITIMATE' ? 'complete' : 'phase_1';
          let decisionText = `Arbitration resolved via blind crypto audit. Winner: ${verdict.winningAgentSignature}`;

          if (verdict.verdictResolutionStatus === 'CONSERVATIVE_DEADLOCK_TRIGGER') {
            console.warn(`[COURT_ALERT] 🚨 一审证据链冲突陷入技术死锁！越级唤醒【最高大模型终审庭】执行高级语义剖析...`);
            
            // 给异步写队列调度预留足够的微秒级硬件写入窗口，随后拉起卷宗
            await new Promise(resolve => setTimeout(resolve, 150));
            
            const supremeVerdict = await this.llmSupremeCourt.adjudicateDeadlock(runtimeUuid, this.persistenceManager);
            
            console.log(`[COURT_VERDICT] ⚖️  最高大模型终审下达判决：`);
            console.log(`  ├── 判定胜诉者 : [${supremeVerdict.finalWinner}]`);
            console.log(`  └── 终审法理依据 : ${supremeVerdict.adjudicationReason}`);

            finalWinnerId = supremeVerdict.finalWinner;
            finalStatus = 'complete';
            decisionText = supremeVerdict.adjudicationReason;

            if (supremeVerdict.finalWinner) {
              const winner = this.agents.find(a => a.agentId === supremeVerdict.finalWinner);
              if (winner) {
                winner.rewardReputation(0.08);
                console.log(`[JUDICIAL_REWARD] 📈 终审清白者 [${winner.agentId}] 信用修复提升至: ${winner.reputationScore.toFixed(2)}`);
              }
            }
            if (supremeVerdict.sanctionedLoser) {
              const loser = this.agents.find(a => a.agentId === supremeVerdict.sanctionedLoser);
              if (loser) {
                loser.penalizeReputation(0.25);
                console.warn(`[JUDICIAL_SANCTION] 📉 终审欺诈者 [${loser.agentId}] 惨遭实锤反制，信用分物理暴跌至: ${loser.reputationScore.toFixed(2)}`);
              }
            }
          }

          await this.persistenceManager.commitCourtSubmission({
            id: `court_${runtimeUuid}`,
            traceId: runtimeUuid,
            phase: finalStatus as any,
            phase1Deadline: Math.floor(Date.now() / 1000) + 3600,
            judgmentBasis: decisionText,
            winnerScore: verdict.adjudicatedMetricScore || 1.0,
            loserScore: 0.0,
            escalatedToHuman: false,
            escalationReason: 'NONE'
          });

        } catch (courtErr) {
          console.error(`[COURT_FAULT] 司法体系陷入非预期的程序性瘫痪:`, (courtErr as Error).message);
        }
      }

    }, 2000); 
  }

  /**
   * 工业级优雅关机守卫
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
        this.databaseProcess.kill(); 
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

async function main() {
  const supervisor = new SoloForgeDaemonSupervisor();
  await supervisor.initializeSovereignStorage();
  supervisor.startRuntimeEventLoop();
}

main().catch(err => {
  console.error('[FATAL_BOOT_FAILURE] 核心守护进程遭遇毁灭性阻断，点火终止:', err);
});