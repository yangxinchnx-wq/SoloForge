import { FolderOpen, GitBranch, MessageSquare, FileCode, Search, Puzzle, Settings, HelpCircle, Palette, BarChart3 } from 'lucide-react';

interface ActivityBarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  showHistory: boolean;
  setShowHistory: (val: boolean) => void;
  showCodeEditor: boolean;
  setShowCodeEditor: (val: boolean) => void;
  onOpenThemeCustomizer: () => void;
  onOpenSettingsModal: () => void;
  onOpenStatsModal: () => void;
}

export default function ActivityBar({ 
  activeTab, 
  setActiveTab, 
  showHistory, 
  setShowHistory, 
  showCodeEditor,
  setShowCodeEditor,
  onOpenThemeCustomizer,
  onOpenSettingsModal,
  onOpenStatsModal
}: ActivityBarProps) {
  const topTabs = [
    { id: 'explorer', icon: FolderOpen, label: '资源管理器' },
    { id: 'git', icon: GitBranch, label: '源代码管理' },
    { id: 'history', icon: MessageSquare, label: '历史对话' },
    { id: 'codeEditor', icon: FileCode, label: '代码编辑器' },
    { id: 'search', icon: Search, label: '搜索' },
    { id: 'extensions', icon: Puzzle, label: '插件' },
  ];

  return (
    <div className="w-[48px] bg-surface border-r border-outline/50 flex flex-col items-center py-3 shrink-0 select-none z-10 justify-between h-full">
      {/* Top Part: Tab List */}
      <div className="flex flex-col items-center w-full gap-2">
        {topTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.id === 'history' 
            ? showHistory 
            : tab.id === 'codeEditor'
              ? showCodeEditor
              : activeTab === tab.id;
          return (
            <div key={tab.id} className="relative w-full flex justify-center group">
              {/* Active Indicator bar */}
              {isActive && (
                <div className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-primary rounded-r" />
              )}
              
              <button
                onClick={() => {
                  if (tab.id === 'history') {
                    setShowHistory(!showHistory);
                  } else if (tab.id === 'codeEditor') {
                    setShowCodeEditor(!showCodeEditor);
                  } else {
                    if (activeTab === tab.id) {
                      setActiveTab('');
                    } else {
                      setActiveTab(tab.id);
                    }
                  }
                }}
                className={`p-2.5 rounded-lg transition-all cursor-pointer relative ${
                  isActive 
                    ? 'bg-primary/10 text-primary shadow-inner' 
                    : 'text-on-surface/50 hover:text-on-surface/90 hover:bg-surface-bright'
                }`}
                title={tab.label}
              >
                <Icon className="w-5 h-5" />
              </button>

              {/* Dynamic hover tip */}
              <div className="absolute left-[54px] top-1/2 -translate-y-1/2 bg-surface border border-outline text-on-surface text-[10px] px-2 py-1 rounded shadow-md opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none whitespace-nowrap z-50">
                {tab.label}
              </div>
            </div>
          );
        })}
      </div>

      {/* Bottom Part: Theme Customizer button, help, config */}
      <div className="flex flex-col items-center w-full gap-2.5">
        {/* Theme customization button */}
        <button
          onClick={onOpenThemeCustomizer}
          className="p-2.5 rounded-lg text-on-surface/50 hover:text-on-surface/90 hover:bg-surface-bright transition-colors cursor-pointer relative group"
          title="自定义主题"
        >
          <Palette className="w-5 h-5" />
          {/* Dynamic hover tip */}
          <div className="absolute left-[54px] top-1/2 -translate-y-1/2 bg-surface border border-outline text-on-surface text-[10px] px-2 py-1 rounded shadow-md opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none whitespace-nowrap z-50">
            自定义主题
          </div>
        </button>

        {/* Token and AI Statistics button */}
        <button
          onClick={onOpenStatsModal}
          className="p-2.5 rounded-lg text-on-surface/50 hover:text-on-surface/90 hover:bg-surface-bright transition-colors cursor-pointer relative group"
          title="审计统计"
        >
          <BarChart3 className="w-5 h-5" />
          {/* Dynamic hover tip */}
          <div className="absolute left-[54px] top-1/2 -translate-y-1/2 bg-surface border border-outline text-on-surface text-[10px] px-2 py-1 rounded shadow-md opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none whitespace-nowrap z-50">
            AI 与 Token 审计
          </div>
        </button>

        <button
          onClick={onOpenSettingsModal}
          className="p-2.5 rounded-lg text-on-surface/50 hover:text-on-surface/90 hover:bg-surface-bright transition-colors cursor-pointer relative group"
          title="全局设置"
        >
          <Settings className="w-5 h-5" />
          {/* Dynamic hover tip */}
          <div className="absolute left-[54px] top-1/2 -translate-y-1/2 bg-surface border border-outline text-on-surface text-[10px] px-2 py-1 rounded shadow-md opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none whitespace-nowrap z-50">
            极客设置中心
          </div>
        </button>
      </div>
    </div>
  );
}
