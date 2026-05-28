// ─────────────────────────────────────────────────────────────────
// SoloForge Runtime OS Layer: Unified Component Lifecycle Contract
// Path: src/kernel/runtime-component.ts
// ─────────────────────────────────────────────────────────────────

/**
 * SoloForge Runtime 统一生命周期接口
 *
 * 所有基础设施模块必须实现此接口。
 * 禁止模块自行启动/停止/连接。
 *
 * RuntimeKernel 是唯一 Authority。
 */
export interface RuntimeComponent {
  /**
   * 组件唯一名称
   * 用于日志、注册、诊断
   */
  readonly name: string;

  /**
   * 启动组件
   * 只能由 RuntimeKernel 调用
   */
  start(): Promise<void>;

  /**
   * 停止组件
   * 必须实现优雅关闭
   */
  stop(): Promise<void>;

  /**
   * 健康检查
   * 必须快速返回
   * 禁止阻塞
   */
  healthCheck(): Promise<boolean>;
}
