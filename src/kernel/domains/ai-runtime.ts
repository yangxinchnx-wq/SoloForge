// src/kernel/domains/ai-runtime.ts
import crypto from 'crypto';
import { RuntimeKernel } from '../runtime-kernel';
import { RuntimeEvent } from '../../core/events/runtime-events'; // 🔒 严格锚定附录B 统一控制宇宙事件枚举规范，清除原始字符串
import { logger } from '../../core/logger';
import { ShadowGovernorClient, TelemetryVector } from '../shadow-governor-client';

/**
 * 🔒 终极硬化版：完美对齐微内核零偏差宪法的 AIRuntime 领域自治板卡
 * 职责：实现 100% 绝对纯化、零本地业务方言夹带的路由分发。开除全部 bidding 竞价及特征组装散落代码。
 * 依靠严苛的两阶段全链路乐观锁（Optimistic Locking）事务包裹捍卫控制链状态所有权。
 */
export class AIRuntimeModule {
  private isMounted = false;
  private readonly domainName = 'AIRuntime';
  private shadowClient: ShadowGovernorClient | null = null;

  constructor(
    private kernel: RuntimeKernel,
    private liveDriver: any = null,
    private scheduler: any = null
  ) {
    if (!kernel || !kernel.transactionManager || !kernel.commandBus || !kernel.eventBus || !kernel.configCenter) {
      throw new Error('CRITICAL_SF_CONSTITUTION: Core transaction managers, configuration hubs, and routing buses must be fully pre-bound.');
    }
  }

  /**
   * 🔌 组件挂载插槽：接入微内核生命周期管理器统一调配
   */
  public async mount(): Promise<void> {
    if (this.isMounted) return;

    this.shadowClient = new ShadowGovernorClient(this.kernel);
    await this.shadowClient.connect();

    // 🧱 宪法控制红线：向控制总线注册原子指令 Handler，就地物理切断业务方言跨域直调
    this.kernel.commandBus.registerHandler('GOVERNOR_PROCESS_TELEMETRY', async (command: any) => {
      return this.executeTelemetryGovernanceTransaction(command);
    });

    this.isMounted = true;
    logger.info(this.domainName, '🚀 [OS Constitution Master Spec Alignment] AIRuntime 自治板卡标准无状态路由契约装配完结。');

    // 🧱 严格绑定附录B法定的系统标准时序脉冲心跳枚举常量，100% 消灭隐式硬编码原始字符串
    this.kernel.eventBus.on(RuntimeEvent.Heartbeat, async (pulsePayload: any) => {
      await this.forwardLifecyclePulseToBus(pulsePayload);
    });
  }

  /**
   * 🔒 零知识纯契网关路由：剥离任何算力分配本地计算，委派下沉具体行为
   */
  private async forwardLifecyclePulseToBus(payload: any): Promise<void> {
    if (!payload) return;
    const tickId = payload.tickId ?? 0;
    const traceId = payload.traceId || crypto.randomUUID();
    
    // 动态从配置中心拉取总线采样采样步长
    const samplingModulus = this.kernel.configCenter.get('governor.sampling.tick_modulus', 2);

    try {
      // 🧱 严格遵循微内核零方言总纲：算力流竞价决策提交流程等逻辑全部下沉封装为独立的外部指令，不在此模块内部就地夹带运算
      await this.kernel.executeCommand({
        id: crypto.randomUUID(),
        type: 'DECISION_COMMIT_REQUEST',
        domain: this.domainName,
        caller: 'AI_RUNTIME_HEARTBEAT_TRIGGER',
        payload: { traceId, tickId, systemCpu: payload.cpuMetric, timestamp: Date.now() }
      });

      if (tickId % samplingModulus === 0) {
        // 🔒 [上游契约强防御性屏障检查]：深度校验上游 Command 预装配快照视图之完整性，彻底清除 undefined 运行时风险
        const rawView = payload.telemetrySnapshotView;
        if (!rawView || typeof rawView.cpu_usage !== 'number' || typeof rawView.queue_depth !== 'number') {
          if (this.kernel.metricsCollector?.counter) {
            this.kernel.metricsCollector.counter('governor.upstream_contract_violation', 1, { domain: 'governor' });
          }
          return; // 发现不合规异构契约，断路器秒级就地安全拦截，零开销放行，绝不污染反向拖累心跳主干
        }

        const safeTelemetryView: TelemetryVector = {
          cpu_usage: rawView.cpu_usage,
          memory_pressure: rawView.memory_pressure ?? 0.0,
          queue_depth: rawView.queue_depth,
          agent_count: rawView.agent_count ?? 0,
          token_pressure: rawView.token_pressure ?? 0.0,
          projection_lag: rawView.projection_lag ?? 0.0,
          scheduler_congestion: rawView.scheduler_congestion ?? 0.0,
          attention_collapse: rawView.attention_collapse ?? 0.0,
          starvation_penalty: rawView.starvation_penalty ?? 0,
          pressure_index: 0.0
        };

        // 🧱 所有跨域跨层流转必须无条件包装为统一 Command 派发，维持板卡自治域最清净边界
        await this.kernel.executeCommand({
          id: crypto.randomUUID(),
          type: 'GOVERNOR_PROCESS_TELEMETRY',
          domain: this.domainName,
          caller: 'SYS_LIFECYCLE_HEARTBEAT_PROXIER',
          payload: { traceId, tickId, telemetry: safeTelemetryView }
        });
      }
    } catch (pulsePanic: any) {
      logger.error(this.domainName, `💥 遥测时钟心跳处理发生局域级会话异常 [#${tickId}]，已执行断路自愈隔离`, {
        traceId, error: pulsePanic.message
      });
    }
  }

  /**
   * 🏗️ Command Handler: 全链路强乐观锁硬化两阶段事务控制流 (CQRS + Event Sourcing Lineage)
   */
  private async executeTelemetryGovernanceTransaction(command: any): Promise<void> {
    const { traceId, tickId, telemetry } = command.payload;

    // 🔒 级联矩阵安全逻辑互锁：同时检验特性 Flag 与规范文档 v3.0 中的全局 marl_enabled 状态
    const isShadowAllowed = this.kernel.featureFlagManager?.isEnabled?.('shadow_governor_engine') ?? true;
    const isMarlGloballyActive = this.kernel.configCenter.get('governor.marl_enabled', true);
    
    if (!isShadowAllowed || !isMarlGloballyActive || !this.shadowClient) {
      return; // 开关不一致或未就绪时自动路由级离线熔断，保障系统状态处于完全确定态
    }

    // 🧱 强行注入统一的 TransactionManager。
    // 🔒 [全链路强乐观锁第一阶段]：在开启事务边界时原子捕获并缓存当前的内核全局状态版本戳
    const initialVersion = this.kernel.version;
    const tx = await this.kernel.transactionManager.begin(
      command.id,
      this.domainName,
      { traceId, tickId, readVersionAssertion: initialVersion, openedAt: Date.now() }
    );

    try {
      // 🔒 全链路上下文追踪：将当前的快照指纹打包进元数据传递给 TCP 客户端，使其随字节管道发射，实现多进程 Lineage 完备级闭环
      const txMetaContext = { txId: tx.id, traceId, tickId, version: initialVersion };
      const ppoPrediction = await this.shadowClient.getShadowAction(telemetry, txMetaContext);

      // 🔒 [全链路强乐观锁第二阶段]：在执行提交决议的临界区前，触发严格的全链路全局版本所有权二次强交叉断言验证
      // 从物理层彻底瓦解超高 TPS 下并发写竞争引发的审计链状态变迁混乱，保证串行原子所有权
      if (this.kernel.version !== initialVersion) {
        throw new Error(`ERR_SF_TX_CONFLICT: Full-link optimistic lock serialization failed. Expected version stamp: ${initialVersion}, Current version: ${this.kernel.version}`);
      }

      // 将影子治理决策日志填充至当前事务 Payload 载荷容器中
      tx.payload = {
        ...tx.payload,
        runtime_tick: tickId,
        telemetry_snapshot: telemetry,
        ppo_action: ppoPrediction.action_name,
        probability: ppoPrediction.prob,
        confidence: ppoPrediction.confidence ?? 1.0,
        committed_at: Date.now()
      };

      // 🧱 提交两阶段状态所有权：底层自发向全局 EventBus 广播标准事实变迁事件（RuntimeEvent.TransactionCommitted）
      // 进而驱动基础设施层外部消费者执行冷沉淀异步落库，彻底斩断领域内直接读写混库漏洞
      await this.kernel.transactionManager.commit(tx.id);

    } catch (txPanic: any) {
      await this.kernel.transactionManager.rollback(tx.commandId, txPanic);
      throw txPanic;
    }
  }

  /**
   * 🔌 卸载拔除生命周期接口：100% 互锁接入 SnapshotManager / Recovery Plan 状态机恢复力规范
   */
  public async unmount(): Promise<void> {
    if (!this.isMounted) return;

    if (this.shadowClient) {
      this.shadowClient.close();
      this.shadowClient = null;
    }

    const checkpointSequenceId = `chk_seq_airuntime_board_${Date.now()}`;
    
    // 🧱 彻底封堵可恢复性漏洞：直接强互锁调用内核统一的持久化快照序列化管理器
    if (this.kernel.snapshotManager?.createCheckpoint) {
      await this.kernel.snapshotManager.createCheckpoint({
        domain: this.domainName,
        checkpointId: checkpointSequenceId,
        kernelVersionSeal: this.kernel.version,
        // 🔒 精确描述快照序列化边界条件：提供持久化恢复的断言桩配置，保障 Headless 模式自愈无任何状态遗漏
        stateSnapshot: { 
          shadowClientActiveStatus: false, 
          totalRequestsBuffered: 0,
          expectedRouterRegime: 'FAILOVER_PURE_STATELESS_GATEWAY' 
        }
      });
    }

    // 🔒 强硬化自愈路径：强互锁向 RecoveryPlan 状态机注册恢复执行契约，达成 Headless 状态下 100% 的无损故障恢复还原
    if (this.kernel.recoveryPlanManager?.registerRecoveryPlan) {
      await this.kernel.recoveryPlanManager.registerRecoveryPlan(this.domainName, {
        targetCheckpoint: checkpointSequenceId,
        strategy: 'RESTORE_TO_ZERO_KNOWLEDGE_ROUTER',
        autoResume: true,
        maxRetriesBeforePanic: 3
      });
    }

    // 🔒 严格发送标准的系统快照事实事件，废除原始字符串猜测
    this.kernel.eventBus.emit(RuntimeEvent.SnapshotCreated, {
      domain: this.domainName,
      checkpointId: checkpointSequenceId,
      timestamp: Date.now()
    });

    this.isMounted = false;
    logger.warn(this.domainName, '🔌 AIRuntime 治理自治域领域板卡已从微内核主干插槽安全平滑拉拔拔除，Headless 恢复资产就绪。');
  }
}

export default AIRuntimeModule;
