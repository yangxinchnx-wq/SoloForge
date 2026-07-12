import React, { useState, useEffect, useCallback } from 'react';
import {
  X, Globe, PlusCircle, Laptop, Cpu, Code2,
  ShieldCheck, Layers, Navigation, Database, Share2, Save, Settings, Bot
} from '../utils/icons';
import LanguageTab from './settingsTabs/LanguageTab';
import ModelAddTab from './settingsTabs/ModelAddTab';
import LocalModelTab from './settingsTabs/LocalModelTab';
import McpTab from './settingsTabs/McpTab';
import EnvironmentTab from './settingsTabs/EnvironmentTab';
import SkillsRulesTab from './settingsTabs/SkillsRulesTab';
import ProxyTab from './settingsTabs/ProxyTab';
import KnowledgeBaseTab from './settingsTabs/KnowledgeBaseTab';
import ChannelsTab from './settingsTabs/ChannelsTab';
import DataManagementTab from './settingsTabs/DataManagementTab';
import AgentCustomTab from './settingsTabs/AgentCustomTab';

// 兼容性 re-export：维持历史 import 路径可用
export { NormalIcon, PerformanceIcon, ExpertIcon, UltimateIcon } from './ChatPanel';

interface SettingsModalProps {
  onClose: () => void;
  initialTabId?: string;
  permissionMode?: 'normal' | 'performance' | 'ultimate' | 'expert';
}

interface TabItem {
  id: string;
  label: string;
  icon: React.ComponentType<any>;
}

const TABS: TabItem[] = [
  { id: 'language', label: '01. 界面语言', icon: Globe },
  { id: 'model-add', label: '02. 云端模型', icon: PlusCircle },
  { id: 'local-model', label: '03. 本地模型', icon: Laptop },
  { id: 'mcp', label: '04. MCP 工具', icon: Cpu },
  { id: 'environment', label: '05. 运行环境', icon: Code2 },
  { id: 'skills-rules', label: '06. 智能规则', icon: ShieldCheck },
  { id: 'memory', label: '07. 助理', icon: Bot },
  { id: 'proxy', label: '08. 网络代理', icon: Navigation },
  { id: 'knowledge-base', label: '09. 知识库', icon: Database },
  { id: 'channels', label: '10. 消息连接', icon: Share2 },
  { id: 'data-management', label: '11. 数据备份', icon: Save }
];

export default function SettingsModal({
  onClose,
  initialTabId = 'language',
  permissionMode = 'normal'
}: SettingsModalProps) {
  const [activeTabId, setActiveTabId] = useState(initialTabId);

  // 稳定的 onClose 引用，避免 effect 频繁重绑
  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [handleClose]);

  return (
    // 根 div：fixed 定位 + backdrop。注意：不加 select-none（会导致 button 内子元素 click 失效）
    <div
      className="fixed inset-0 flex items-center justify-center z-[1000] p-4 font-sans overflow-hidden"
      style={{
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        backgroundColor: 'rgba(0, 0, 0, 0.45)',
      }}
    >
      {/* 背景层：点击关闭。z-0 + absolute，card 用 z-10 确保在背景层之上 */}
      <div
        onClick={handleClose}
        className="absolute inset-0 z-0"
        style={{ cursor: 'default' }}
      />

      {/* Modal 卡片：z-10 确保在背景层之上（不能用 z-[1001] 任意值，Tailwind v4 不生成） */}
      <div
        className="settings-modal-card relative z-10 bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-2xl w-full max-w-5xl shadow-[0_12px_45px_rgba(0,0,0,0.4)] overflow-hidden flex flex-col text-[var(--color-on-surface)] select-none"
        style={{ height: '85vh', flexShrink: 0 }}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between p-4 px-6 border-b border-[var(--color-outline)]/20 bg-[var(--color-bg)] text-[var(--color-on-surface)] shrink-0">
          <div className="flex items-center gap-3">
            <Settings className="text-[var(--color-primary)] w-5 h-5" />
            <div>
              <h2 className="text-lg font-bold text-[var(--color-on-surface)] tracking-wide">设置</h2>
            </div>
          </div>
          {/* X 关闭按钮：select-text 覆盖父级 select-none，确保 click 事件正常触发 */}
          <button
            type="button"
            onClick={handleClose}
            onMouseDown={(e) => e.stopPropagation()}
            className="select-text p-1.5 hover:bg-[var(--color-surface-bright)]/40 rounded-lg transition-colors text-on-surface/50 hover:text-[var(--color-on-surface)]"
            style={{ cursor: 'pointer' }}
            aria-label="关闭设置"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Main Split View */}
        <div className="flex-1 flex overflow-hidden min-h-0">

          {/* Left Column: Tab 列表 */}
          <div className="w-[260px] bg-[var(--color-bg)] border-r border-[var(--color-outline)]/20 flex flex-col overflow-y-auto p-2 gap-0.5 shrink-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {TABS.map((tab) => {
              const TabIcon = tab.icon;
              const isActive = activeTabId === tab.id;
              const match = tab.label.match(/^(\d+)\.\s*(.*)$/);
              const numPrefix = match ? match[1] : '';
              const nameText = match ? match[2] : tab.label;

              return (
                <div
                  key={tab.id}
                  onClick={() => setActiveTabId(tab.id)}
                  className={`group relative flex items-center px-4 py-2.5 rounded-lg transition-colors ${
                    isActive
                      ? 'bg-[var(--color-primary)]/10 text-[var(--color-on-surface)] font-bold'
                      : 'hover:bg-[var(--color-surface-bright)]/45 text-on-surface/75 hover:text-[var(--color-on-surface)]'
                  }`}
                  style={{ cursor: 'pointer' }}
                >
                  {isActive && (
                    <div className="absolute left-0 top-2 bottom-2 w-1 rounded-r bg-[var(--color-primary)]" />
                  )}
                  <TabIcon className={`w-4 h-4 shrink-0 mr-3 ${isActive ? 'text-[var(--color-primary)]' : 'text-on-surface/40'}`} />
                  <span className="font-mono text-xs w-6 shrink-0 opacity-55 text-left">{numPrefix}.</span>
                  <span className="text-[13.5px] md:text-sm font-medium leading-none truncate flex-1">
                    {nameText}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Right Column: 内容区 */}
          <div className="flex-1 bg-[var(--color-surface)] p-6 overflow-y-auto text-left min-w-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {/* 不用 key={activeTabId} 强制重挂，避免动画导致的视觉尺寸变化 */}
            <div className="w-full min-h-full flex flex-col">
              {activeTabId === 'language' && <LanguageTab onClose={handleClose} />}
              {activeTabId === 'model-add' && <ModelAddTab />}
              {activeTabId === 'local-model' && <LocalModelTab />}
              {activeTabId === 'mcp' && <McpTab />}
              {activeTabId === 'environment' && <EnvironmentTab />}
              {activeTabId === 'skills-rules' && <SkillsRulesTab onClose={handleClose} permissionMode={permissionMode} />}
              {activeTabId === 'memory' && <AgentCustomTab />}
              {activeTabId === 'proxy' && <ProxyTab />}
              {activeTabId === 'knowledge-base' && <KnowledgeBaseTab />}
              {activeTabId === 'channels' && <ChannelsTab />}
              {activeTabId === 'data-management' && <DataManagementTab />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
