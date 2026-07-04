/**
 * 权限模式 4 个 SVG 图标
 *
 * 2026-07-03 阶段3.1.B 从 ChatPanel.tsx 抽出。
 * SettingsModal / ChatPanel 共用。
 * - NormalIcon: 安全模式 (盾牌+对勾, emerald)
 * - PerformanceIcon: 性能模式 (仪表盘指针, purple)
 * - ExpertIcon: 专家模式 (学士帽, amber)
 * - UltimateIcon: 极致模式 (闪电+能量圈, red)
 */

import React from 'react';

export type PermissionMode = 'normal' | 'performance' | 'expert' | 'ultimate';

export const NormalIcon = ({ className = "w-4 h-4" }: { className?: string }) => (
  <svg className={`${className} text-emerald-400 group-hover:text-emerald-300 transition-all duration-300 filter drop-shadow-[0_0_4px_rgba(16,185,129,0.35)]`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {/* Sleek multi-layered security grid shield */}
    <path d="M12 2s-8 3-8 8v4c0 5 8 8 8 8s8-3 8-8v-4c0-5-8-8-8-8z" stroke="currentColor" strokeWidth="1.8" fill="currentColor" fillOpacity="0.08" />
    <path d="M12 5.5s-5 2-5 5v3c0 3.5 5 5.5 5 5.5s5-2 5-5.5v-3c0-3-5-5-5-5z" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2" strokeOpacity="0.75" />
    <path d="m9 12 2 2 4-4.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const PerformanceIcon = ({ className = "w-4 h-4" }: { className?: string }) => (
  <svg className={`${className} text-purple-400 group-hover:text-purple-300 transition-all duration-300 filter drop-shadow-[0_0_4px_rgba(168,85,247,0.35)]`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {/* Semicircular Dashboard dial Arc */}
    <path d="M4 17.5A8 8 0 1 1 20 17.5" stroke="currentColor" strokeWidth="2" strokeOpacity="0.30" />
    <path d="M6.5 15A5.5 5.5 0 1 1 17.5 15" stroke="currentColor" strokeWidth="1.5" strokeDasharray="1.5 2.5" strokeOpacity="0.75" />
    {/* Small speed tick indicators */}
    <path d="M5 16.5l1.2-1.2M19 16.5l-1.2-1.2M12 4v2" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.7" />
    {/* Indicator needle pointing pointing to upper right (High speed) */}
    <path d="M12 12l4.5-4.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    {/* Central hub element */}
    <circle cx="12" cy="12" r="2" fill="currentColor" />
    <circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth="0.8" strokeOpacity="0.5" />
  </svg>
);

export const ExpertIcon = ({ className = "w-4 h-4" }: { className?: string }) => (
  <svg
    className={`${className} text-amber-500 group-hover:text-amber-400 transition-all duration-300 filter drop-shadow-[0_0_5px_rgba(245,158,11,0.45)]`}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {/* Academic scholar/expert mortarboard cap */}
    <path d="M12 3.5L2.5 8l9.5 4.5 9.5-4.5-9.5-4.5z" stroke="currentColor" strokeWidth="1.8" fill="currentColor" fillOpacity="0.10" />
    <path d="M6 10.5v3.5c0 1.8 2.7 3.5 6 3.5s6-1.7 6-3.5v-3.5" stroke="currentColor" strokeWidth="1.8" fill="currentColor" fillOpacity="0.05" />
    {/* Hanging credential tassel */}
    <path d="M20.5 8.5v5.5" stroke="currentColor" strokeWidth="1" />
    <circle cx="20.5" cy="14" r="1" fill="currentColor" />
    {/* Central expert credential target point */}
    <circle cx="12" cy="18.5" r="1.5" fill="currentColor" />
    <path d="M12 14v2" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.5 1.5" />
  </svg>
);

export const UltimateIcon = ({ className = "w-4 h-4" }: { className?: string }) => (
  <svg
    className={`${className} text-red-500 group-hover:text-red-400 transition-all duration-300 filter drop-shadow-[0_0_6px_rgba(239,68,68,0.5)]`}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {/* Circular energy boundary aura */}
    <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="1.2" strokeOpacity="0.25" strokeDasharray="3 2" />
    {/* High frequency energetic lightning bolt */}
    <path
       d="M13.5 2L5.5 12h6.5l-2.5 10 9-10h-6.5L13.5 2z"
       fill="currentColor"
       fillOpacity="0.2"
       stroke="currentColor"
       strokeWidth="2.2"
       strokeLinejoin="miter"
    />
  </svg>
);

/**
 * 单组件 wrapper：按 mode 渲染对应图标
 * 用法: <PermissionModeIcon mode="performance" className="w-5 h-5" />
 */
export const PermissionModeIcon = ({ mode, className }: { mode: PermissionMode; className?: string }) => {
  switch (mode) {
    case 'normal': return <NormalIcon className={className} />;
    case 'performance': return <PerformanceIcon className={className} />;
    case 'expert': return <ExpertIcon className={className} />;
    case 'ultimate': return <UltimateIcon className={className} />;
  }
};
