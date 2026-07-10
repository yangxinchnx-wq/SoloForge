// ─────────────────────────────────────────────────────────────────
// 启动期依赖的最小接口契约
// Path: src/types/bootstrap-deps.ts
// Description: 仅覆盖 bootstrap.ts 启动流程实际调用的字段，
//              消除 any 类型，恢复 IDE 智能提示与重构安全性。
// ─────────────────────────────────────────────────────────────────

/**
 * 命令总线接口
 * 用于启动期依赖注入，支持 handler 注册与命令分发
 */
export interface ICommandBus {
  registerHandler(
    type: string,
    handler: (cmd: ICommand) => Promise<ICommandResult>
  ): void;
  execute(cmd: ICommand): Promise<ICommandResult>;
}

/**
 * 命令结构
 */
export interface ICommand {
  type: string;
  payload?: unknown;
}

/**
 * 命令执行结果
 */
export interface ICommandResult {
  success: boolean;
  payload?: unknown;
  event?: string;
}

/**
 * 事务管理器接口
 * 提供事务开始/提交/回滚/排空能力
 * 签名对齐 src/kernel/transaction-manager.ts 的真实实现
 */
export interface ITransactionManager {
  begin(commandId: string, domain: string, initialPayload?: unknown): Promise<ITransaction>;
  commit(txId: string): Promise<void>;
  rollback(commandId: string, error: unknown): Promise<void>;
  drain(): Promise<void>;
}

/**
 * 事务对象
 */
export interface ITransaction {
  id: string;
  commandId?: string;
  domain?: string;
  startedAt?: number;
  payload?: unknown;
  status?: 'pending' | 'committed' | 'rolled_back';
}

/**
 * 投影管理器接口
 * 用于事件回放与投影批量更新
 */
export interface IProjectionManager {
  updateAll(): void;
  replayEvent(evt: unknown): Promise<void>;
}

/**
 * 快照管理器接口
 * 提供全量快照与恢复能力
 */
export interface ISnapshotManager {
  createFullSnapshot(): Promise<string>;
  recover(): Promise<void>;
  replayEvent(evt: unknown): Promise<void>;
}

/**
 * 调度器客户端接口
 * 用于任务派发与队列排空
 */
export interface ISchedulerClient {
  ping?(): Promise<boolean>;
  dispatch?(task: unknown): Promise<string>;
  drain(): Promise<void>;
  initialize?(): void;
}

/**
 * 启动依赖聚合接口
 * 用于 initInfrastructure / initCoreServices 之间的依赖传递
 */
export interface BootstrapDeps {
  commandBus: ICommandBus;
  transactionManager: ITransactionManager;
  projectionManager: IProjectionManager;
  snapshotManager: ISnapshotManager;
  scheduler: ISchedulerClient;
}
