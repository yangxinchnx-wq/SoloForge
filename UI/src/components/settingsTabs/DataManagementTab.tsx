import React from 'react';
import { Save } from '../../utils/icons';

// 11. 数据备份
export default function DataManagementTab() {
  return (
    <div className="space-y-6 animate-fadeIn">

      <div className="bg-[var(--color-surface)] border border-[var(--color-outline)]/20 p-5 rounded-2xl flex items-center justify-between">
        <div className="space-y-1">
          <span className="text-sm font-bold text-[var(--color-on-surface)] block">全站配置冷备份 (.json)</span>
          <p className="text-xs text-on-surface/50 leading-relaxed">打包导出所有本地模型挂载目录、自定义 API、记忆体、自动化脚本以及风控状态</p>
        </div>

        <button className="bg-[var(--color-primary)] hover:opacity-90 text-[var(--color-bg)] font-extrabold text-sm px-4 py-3 rounded-xl transition-all font-mono shadow-md flex items-center gap-2 cursor-pointer active:scale-95">
          <Save className="w-4 h-4" />
          <span>EXPORT_CONFIG_DATA.JSON</span>
        </button>
      </div>
    </div>
  );
}
