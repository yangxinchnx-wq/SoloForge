/**
 * CentralControlPill — 顶部中央"主模型 / 混合任务 / 副模型"集合胶囊
 *
 * 抽离自 Header.tsx, 解决:
 *   1. 原代码容器 <div> 上有重复 className (L775/L780) — 后者覆盖前者, 维护混乱
 *   2. leftPosition 计算 / z-index 逻辑与 children 渲染混在一起
 *   3. 各 children 都自己管 drag/no-drag, 容易遗漏
 *
 * 设计:
 *   - 单一胶囊容器, 统一处理 draggable (默认 data-no-drag 内的 children 可点击)
 *   - children 自由组合, 不耦合具体业务组件
 *   - 暴露 open (模型菜单/副模型菜单展开) 控制 z-index
 */

import React, { memo } from 'react';

export interface CentralControlPillProps {
  /** 相对 sidebar 的左偏移, 形如 "clamp(...)" */
  leftPosition: string;
  /** sidebar 拖动中: 禁用 left transition, 避免抖动 */
  isResizing?: boolean;
  /** 是否有任何下拉打开, true 时 z-index 升到 50 */
  hasOpenDropdown?: boolean;
  /** 内部内容: 主模型选择器 / 副模型 / 混合开关等 */
  children: React.ReactNode;
}

function CentralControlPillImpl({
  leftPosition,
  isResizing = false,
  hasOpenDropdown = false,
  children,
}: CentralControlPillProps) {
  return (
    <div
      // data-no-drag 让父 header 知道这是交互区, 不要启动窗口拖动
      data-no-drag
      className={`absolute top-1/2 -translate-y-1/2 flex items-center bg-[var(--color-surface-bright)]/90 border-2 border-primary/40 hover:border-primary/70 px-5 py-1.5 h-[40px] rounded-full shadow-[0_2px_12px_rgba(0,0,0,0.08)] text-xs md:text-sm font-sans gap-4 overflow-visible transition-all ${
        hasOpenDropdown ? 'z-50' : 'z-20'
      }`}
      style={{
        left: leftPosition,
        transition: isResizing
          ? 'none'
          // 整个流程丝滑: 胶囊 width 必须和内部 motion.div 同步动画
          // (之前 width 没在 transition 里 → 胶囊瞬时变宽 → 整个流程"卡"一下)
          // 350ms 与 ToggleSwitch thumb / motion.div 全部对齐
          : 'left 250ms cubic-bezier(0.4, 0, 0.2, 1), width 350ms cubic-bezier(0.4, 0, 0.2, 1), border-color 200ms, background-color 200ms',
      }}
    >
      {children}
    </div>
  );
}

export const CentralControlPill = memo(CentralControlPillImpl);
CentralControlPill.displayName = 'CentralControlPill';
