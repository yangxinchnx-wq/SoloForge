import { useState, useEffect, useRef } from 'react';
import { Play, PlayCircle, Terminal, Trash2, CheckCircle, RefreshCw, AlertTriangle, Lock, Unlock, ChevronDown, ChevronUp, AlertCircle, Info, MessageSquarePlus, Sparkles, Check, Plus, X } from 'lucide-react';

interface LogItem {
  time: string;
  type: 'info' | 'success' | 'warn' | 'error' | 'system';
  msg: string;
}

interface TerminalInstance {
  id: string;
  name: string;
  logItems: LogItem[];
  progress: number;
  isBuilding: boolean;
  statusText: string;
  autoScroll: boolean;
  commandValue: string;
}

interface TerminalPanelProps {
  permissionMode?: 'normal' | 'performance' | 'expert' | 'ultimate';
}

const modeStyleMap = {
  normal: {
    accent: '16, 185, 129', // emerald
    color: '#10b981',
  },
  performance: {
    accent: '168, 85, 247', // purple
    color: '#a855f7',
  },
  expert: {
    accent: '245, 158, 11', // amber/gold
    color: '#f59e0b',
  },
  ultimate: {
    accent: '239, 68, 68', // red
    color: '#ef4444',
  }
};

export default function TerminalPanel({ permissionMode = 'normal' }: TerminalPanelProps) {
  const modeStyle = modeStyleMap[permissionMode] || modeStyleMap.normal;
  const [activeTab, setActiveTab] = useState<'terminal' | 'problems' | 'output'>('terminal');
  const [isTerminalCollapsed, setIsTerminalCollapsed] = useState(false);
  const [sentLogMap, setSentLogMap] = useState<Record<number, boolean>>({});
  const [problemsSentMap, setProblemsSentMap] = useState<Record<number, boolean>>({});

  // Broadcast terminal collapse state to other components
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('soloforge-terminal-state-changed', {
        detail: { isCollapsed: isTerminalCollapsed }
      })
    );
  }, [isTerminalCollapsed]);

  // Listen to remote toggle terminal events (e.g. from StatusBar)
  useEffect(() => {
    const handleToggleTerminal = () => {
      setIsTerminalCollapsed(prev => !prev);
    };
    window.addEventListener('soloforge-toggle-terminal', handleToggleTerminal);
    return () => {
      window.removeEventListener('soloforge-toggle-terminal', handleToggleTerminal);
    };
  }, []);
  const [instances, setInstances] = useState<TerminalInstance[]>([
    {
      id: 'server',
      name: 'node (server)',
      logItems: [
        { time: '17:56:50', type: 'system', msg: '系统已成功在容器端口 3000 初始化监听' },
        { time: '17:56:51', type: 'info', msg: 'vite v6.2.3 开发服务运行于本地 http://localhost:3000' },
        { time: '17:56:52', type: 'warn', msg: '[eslint] 警告：在 useKeybind 钩子中发现 Unexpected any 类型定义 (/src/utils.ts:74)' },
        { time: '17:56:53', type: 'error', msg: '[typescript] 错误：在 ChatPanel.tsx:1125 处，类型 "ChatSession" 上不存在属性 "permissionMode"。是否指 "isNormalMode" 或 "currentConfig"？' },
        { time: '17:56:54', type: 'success', msg: '✓ 静态资产包编译成功，静态树结构准备完毕' },
      ],
      progress: 100,
      isBuilding: false,
      statusText: '准备就绪',
      autoScroll: true,
      commandValue: ''
    },
    {
      id: 'compiler',
      name: 'compiler-watch',
      logItems: [
        { time: '17:57:10', type: 'system', msg: '>>> [esbuild] 启动文件关联监控树...' },
        { time: '17:58:22', type: 'info', msg: 'FileChanged: src/components/SettingsModal.tsx - incremental diff processed' },
        { time: '17:58:24', type: 'success', msg: '✓ TS 静态模块树重构校验耗时 42ms' },
      ],
      progress: 100,
      isBuilding: false,
      statusText: '文件变化监视中',
      autoScroll: true,
      commandValue: ''
    }
  ]);

  const [activeInstanceId, setActiveInstanceId] = useState<string>('server');
  const [renameId, setRenameId] = useState<string | null>(null);

  const activeInstance = instances.find(inst => inst.id === activeInstanceId) || instances[0];
  const { logItems, progress, isBuilding, statusText, autoScroll } = activeInstance;

  const setAutoScroll = (val: boolean) => {
    setInstances(prev => prev.map(inst => inst.id === activeInstanceId ? { ...inst, autoScroll: val } : inst));
  };

  const terminalEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom of logs when we add new logs if auto-scroll is enabled
  useEffect(() => {
    if (autoScroll && terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logItems, autoScroll]);

  const addNewInstance = () => {
    const newId = `terminal_${Date.now()}`;
    const newNum = instances.length + 1;
    const newInst: TerminalInstance = {
      id: newId,
      name: `bash (${newNum})`,
      logItems: [
        { time: new Date().toLocaleTimeString(), type: 'system', msg: `终端已成功多开，并为当前实例 [bash (${newNum})] 配套完全独立的沙盒进程。` },
        { time: new Date().toLocaleTimeString(), type: 'info', msg: '输入 "help" 列出交互式终端指令，运行 "build" 手动执行独立构建流水线任务。' }
      ],
      progress: 100,
      isBuilding: false,
      statusText: '沙盒进程启动完毕',
      autoScroll: true,
      commandValue: ''
    };
    setInstances(prev => [...prev, newInst]);
    setActiveInstanceId(newId);
  };

  const closeInstance = (id: string) => {
    if (instances.length <= 1) return;
    setInstances(prev => prev.filter(inst => inst.id !== id));
    if (activeInstanceId === id) {
      const remaining = instances.filter(inst => inst.id !== id);
      setActiveInstanceId(remaining[remaining.length - 1].id);
    }
  };

  const finishRename = (id: string, newName: string) => {
    setRenameId(null);
    const cleanName = newName.trim();
    if (!cleanName) return;
    setInstances(prev => prev.map(inst => inst.id === id ? { ...inst, name: cleanName } : inst));
  };

  const startRebuildForInstance = (instId: string) => {
    const inst = instances.find(i => i.id === instId);
    if (!inst || inst.isBuilding) return;

    setInstances(prev => prev.map(i => i.id === instId ? {
      ...i,
      isBuilding: true,
      progress: 0,
      statusText: '编译路由与应用样式...',
      logItems: [
        { time: new Date().toLocaleTimeString(), type: 'system', msg: '>>> 启动多级流水线自动化构建进程...' },
        { time: new Date().toLocaleTimeString(), type: 'info', msg: 'yarn run build --force' },
      ]
    } : i));

    let currentProgress = 0;
    const interval = setInterval(() => {
      currentProgress += Math.floor(Math.random() * 8) + 4;
      if (currentProgress >= 100) {
        currentProgress = 100;
        clearInterval(interval);

        const endNow = new Date().toLocaleTimeString();
        setInstances(prev => prev.map(i => i.id === instId ? {
          ...i,
          isBuilding: false,
          progress: 100,
          statusText: '应用服务监听中 (Port: 3000)',
          logItems: [
            ...i.logItems,
            { time: endNow, type: 'success', msg: '✓ 生成 /dist 生产捆绑包 (CJS 静态资源格式)' },
            { time: endNow, type: 'info', msg: 'node dist/server.cjs' },
            { time: endNow, type: 'success', msg: '● 服务已在 0.0.0.0:3000 稳定部署并提供访问' }
          ]
        } : i));
      } else {
        let sText = '应用服务监听中 (Port: 3000)';
        let additionalLog: LogItem | null = null;
        const timestamp = new Date().toLocaleTimeString();

        if (currentProgress > 15 && currentProgress <= 25) {
          sText = `解析程序包依赖项 (${currentProgress}%)`;
          additionalLog = { time: timestamp, type: 'info', msg: '[vite:css] 正在组合 PostCSS 工具指令与 Tailwind 核心编译树样式' };
        } else if (currentProgress > 45 && currentProgress <= 55) {
          sText = `编译 TypeScript 及 JSX 模块 (${currentProgress}%)`;
          additionalLog = { time: timestamp, type: 'info', msg: '[esbuild:ts] 编译解析 main.tsx, App.tsx 及其相关 UI 组件文件' };
        } else if (currentProgress > 75 && currentProgress <= 85) {
          sText = `优化混淆最终产物体积 (${currentProgress}%)`;
          additionalLog = { time: timestamp, type: 'warn', msg: 'd3-selection: 外部依赖库体积略微超出默认最佳预算区间' };
        }

        setInstances(prev => prev.map(i => {
          if (i.id !== instId) return i;
          const substringToCheck = additionalLog ? additionalLog.msg.substring(0, 15) : '';
          const alreadyLogged = additionalLog && i.logItems.some(l => l.msg.includes(substringToCheck));
          const nextLogs = (additionalLog && !alreadyLogged) ? [...i.logItems, additionalLog] : i.logItems;
          return {
            ...i,
            progress: currentProgress,
            statusText: sText === '应用服务监听中 (Port: 3000)' ? i.statusText : sText,
            logItems: nextLogs
          };
        }));
      }
    }, 150);
  };

  const startRebuild = () => {
    startRebuildForInstance(activeInstanceId);
  };

  const clearTerminal = () => {
    setInstances(prev => prev.map(inst => inst.id === activeInstanceId ? { ...inst, logItems: [] } : inst));
  };

  const handleCommandSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = activeInstance.commandValue.trim();
    if (!cmd) return;

    const timestamp = new Date().toLocaleTimeString();
    const newUserLog: LogItem = {
      time: timestamp,
      type: 'system',
      msg: `$ ${cmd}`
    };

    let responseLogs: LogItem[] = [];
    const args = cmd.toLowerCase().split(' ');
    const primaryCmd = args[0];

    if (primaryCmd === 'help') {
      responseLogs = [
        { time: timestamp, type: 'info', msg: '💡 可用命令列表 (Simulated Shell):' },
        { time: timestamp, type: 'info', msg: '  - build : 运行完整生产级流水线构建周期' },
        { time: timestamp, type: 'info', msg: '  - clear : 清空当前终端的全部运行日志' },
        { time: timestamp, type: 'info', msg: '  - ls    : 列出当前的系统文件与目录' },
        { time: timestamp, type: 'info', msg: '  - neofetch : 显示 SoloForge 发烧级系统硬件与主题规格' },
        { time: timestamp, type: 'info', msg: '  - node  : 运行简易 JavaScript 算术表达式（如: node 123*456）' },
        { time: timestamp, type: 'info', msg: '  - git status : 查看本地 git 暂存区与追踪状态' },
      ];
    } else if (primaryCmd === 'clear') {
      setInstances(prev => prev.map(inst => inst.id === activeInstanceId ? { ...inst, logItems: [], commandValue: '' } : inst));
      return;
    } else if (primaryCmd === 'build') {
      setInstances(prev => prev.map(inst => inst.id === activeInstanceId ? { 
        ...inst, 
        logItems: [...inst.logItems, newUserLog], 
        commandValue: '' 
      } : inst));
      setTimeout(() => {
        startRebuildForInstance(activeInstanceId);
      }, 100);
      return;
    } else if (primaryCmd === 'ls') {
      responseLogs = [
        { time: timestamp, type: 'info', msg: '📁 列出 BlogSystem/ 工作目录:' },
        { time: timestamp, type: 'info', msg: '  src/         public/      docs/        electron/' },
        { time: timestamp, type: 'info', msg: '  package.json tsconfig.json vite.config.ts' }
      ];
    } else if (primaryCmd === 'neofetch') {
      responseLogs = [
        { time: timestamp, type: 'success', msg: '   ____        __     ______' },
        { time: timestamp, type: 'success', msg: '  / __/___  __/ /__  / __/ /__ ___ _____' },
        { time: timestamp, type: 'success', msg: ' _\\ \\/ _ \\/ _  / _ \\/ _// _  // _ `/ -_)' },
        { time: timestamp, type: 'success', msg: '/___/\\___/\\_,_/\\___/_/ /_//_/ \\_, /\\__/ ' },
        { time: timestamp, type: 'success', msg: '                             /___/' },
        { time: timestamp, type: 'info', msg: `---------------------------------` },
        { time: timestamp, type: 'info', msg: `  OS: SoloForge Sandboxed Node Target` },
        { time: timestamp, type: 'info', msg: `  Kernel: Cloud Run Container (Port 3000)` },
        { time: timestamp, type: 'info', msg: `  Uptime: 2 hours 14 mins` },
        { time: timestamp, type: 'info', msg: `  Shell: soloforge-interactive-zsh-v1.2` },
        { time: timestamp, type: 'info', msg: `  Core Engines: Vite 6 + React 18 + TS` },
        { time: timestamp, type: 'info', msg: `  Authored Permission Mode: ${permissionMode.toUpperCase()}` },
      ];
    } else if (primaryCmd === 'node') {
      const expr = cmd.substring(5).trim();
      if (!expr) {
        responseLogs = [{ time: timestamp, type: 'warn', msg: '用法: node <数学表达式>。例如: node 12+34' }];
      } else {
        try {
          if (/^[0-9+\-*/().\s]+$/.test(expr)) {
            const res = Function(`"use strict"; return (${expr})`)();
            responseLogs = [{ time: timestamp, type: 'success', msg: `▶ ${res}` }];
          } else {
            responseLogs = [{ time: timestamp, type: 'success', msg: `▶ Executed statement successfully (return undefined)` }];
          }
        } catch (err: any) {
          responseLogs = [{ time: timestamp, type: 'error', msg: `SyntaxError: ${err.message}` }];
        }
      }
    } else if (cmd.startsWith('git')) {
      if (cmd === 'git status') {
        responseLogs = [
          { time: timestamp, type: 'success', msg: 'On branch main' },
          { time: timestamp, type: 'success', msg: 'Your branch is up to date with \'origin/main\'.' },
          { time: timestamp, type: 'info', msg: 'nothing to commit, working tree clean' }
        ];
      } else {
        responseLogs = [{ time: timestamp, type: 'info', msg: `[git] Simulated execution of: ${cmd}` }];
      }
    } else {
      responseLogs = [
        { time: timestamp, type: 'error', msg: `sh: command not found: ${primaryCmd}` },
        { time: timestamp, type: 'info', msg: '输入 "help" 获取可供体验的开发控制台命令！' }
      ];
    }

    setInstances(prev => prev.map(inst => {
      if (inst.id === activeInstanceId) {
        return {
          ...inst,
          logItems: [...inst.logItems, newUserLog, ...responseLogs],
          commandValue: ''
        };
      }
      return inst;
    }));
  };

  // Dispatch message to Chat Panel as an attachment
  const handleSendToChat = (msg: string, index: number, type: 'info' | 'success' | 'warn' | 'error' | 'system') => {
    const typeLabel = type === 'error' ? '控制台错误' : type === 'warn' ? '控制台警告' : '控制台日志';
    const cleanMsg = msg.replace(/^(\[eslint\]|\[typescript\])\s*/gi, '');
    const finalPromptText = `请帮我诊断并给出以下控制台报错的完整重构解决方案：\n\n\`\`\`bash\n${msg}\n\`\`\``;
    
    window.dispatchEvent(
      new CustomEvent('send-code-to-chat', {
        detail: {
          fileName: `${typeLabel} (L${index + 1})`,
          text: finalPromptText
        }
      })
    );
    
    // Trigger temporary visual success feedback
    setSentLogMap(prev => ({ ...prev, [index]: true }));
    setTimeout(() => {
      setSentLogMap(prev => ({ ...prev, [index]: false }));
    }, 2500);
  };

  // Send problems tab warnings/errors directly to Chat
  const handleSendProblemToChat = (probMsg: string, probFile: string, index: number, severity: 'error' | 'warning') => {
    const finalPromptText = `请帮我诊断并修复这个在项目编译时发现的 ${severity === 'error' ? '严重错误' : '警告'}：\n\n文件位置: \`${probFile}\`\n问题描述: ${probMsg}\n\n请帮我编写修复代码并解释根本原因。`;
    
    window.dispatchEvent(
      new CustomEvent('send-code-to-chat', {
        detail: {
          fileName: severity === 'error' ? '编译错误 (TS/ESLint)' : '包大小警告 (Build Budget)',
          text: finalPromptText
        }
      })
    );

    setProblemsSentMap(prev => ({ ...prev, [index]: true }));
    setTimeout(() => {
      setProblemsSentMap(prev => ({ ...prev, [index]: false }));
    }, 2500);
  };

  // Count active warnings and errors for badge display
  const errorCount = logItems.filter(l => l.type === 'error').length + 1; // plus hardcoded warning/error in problems Tab
  const warnCount = logItems.filter(l => l.type === 'warn').length;

  return (
    <div 
      className={`dynamic-terminal-container border-t border-outline/20 flex flex-col select-none font-mono transition-all duration-300 relative ${isTerminalCollapsed ? 'h-[28px]' : 'h-64 shadow-2xl'}`}
      style={{
        '--accent-color': modeStyle.color,
        '--accent-rgb': modeStyle.accent,
      } as any}
    >
      <style>{`
        .dynamic-terminal-container {
          background: radial-gradient(circle at 50% 0%, rgba(var(--accent-rgb), 0.04) 0%, var(--color-surface) 75%, var(--color-bg) 100%) !important;
          transition: background 0.6s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.6s ease;
        }
        .dynamic-terminal-scrollarea::-webkit-scrollbar {
          display: block !important;
          width: 6px !important;
          height: 6px !important;
        }
        .dynamic-terminal-scrollarea {
          scrollbar-width: thin !important;
          scrollbar-color: rgba(var(--accent-rgb), 0.18) transparent !important;
        }
        .dynamic-terminal-scrollarea::-webkit-scrollbar-track {
          background: transparent !important;
        }
        .dynamic-terminal-scrollarea::-webkit-scrollbar-thumb {
          background-color: rgba(var(--accent-rgb), 0.18) !important;
          border-radius: 9999px;
          border: 1px solid var(--color-surface);
          background-clip: padding-box;
          transition: background-color 0.4s cubic-bezier(0.16, 1, 0.3, 1) !important;
        }
        .dynamic-terminal-scrollarea::-webkit-scrollbar-thumb:hover {
          background-color: rgba(var(--accent-rgb), 0.38) !important;
        }
      `}</style>

      {/* Visual Glowing Frame Accent */}
      <div 
        className="absolute top-0 left-0 right-0 h-[1.5px] bg-gradient-to-r transition-all duration-500 pointer-events-none" 
        style={{
          backgroundImage: `linear-gradient(to right, transparent, rgba(${modeStyle.accent}, 0.55), transparent)`,
        }}
      />

      {/* Terminal Title Bar & Navigation Buttons */}
      <div 
        onClick={() => isTerminalCollapsed && setIsTerminalCollapsed(false)}
        className={`flex items-center justify-between px-3.5 py-1.5 bg-surface border-b border-outline/15 text-[11px] ${isTerminalCollapsed ? 'cursor-pointer hover:bg-surface-bright' : ''}`}
      >
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-on-surface/50">
            <Terminal className="w-3.5 h-3.5 transition-colors duration-500" style={{ color: modeStyle.color }} />
            <span className="font-semibold uppercase tracking-wider text-[10px] text-on-surface/70">终端底座</span>
          </div>

          {!isTerminalCollapsed && (
            <div className="flex items-center gap-1.5 border-l border-outline/20 pl-4">
              <button 
                onClick={() => setActiveTab('terminal')} 
                className="relative px-2.5 py-1 rounded transition-all text-[11px] flex items-center gap-1.5 border"
                style={{
                  backgroundColor: activeTab === 'terminal' ? `rgba(${modeStyle.accent}, 0.08)` : 'transparent',
                  borderColor: activeTab === 'terminal' ? `rgba(${modeStyle.accent}, 0.25)` : 'transparent',
                  color: activeTab === 'terminal' ? modeStyle.color : 'rgba(255, 255, 255, 0.4)',
                }}
              >
                <span>终端</span>
              </button>

              <button 
                onClick={() => setActiveTab('problems')} 
                className={`px-2.5 py-1 rounded transition-all text-[11px] flex items-center gap-2 ${
                  activeTab === 'problems' 
                    ? 'bg-amber-500/8 text-amber-400 font-bold border border-amber-500/20' 
                    : 'text-on-surface/40 hover:text-on-surface/80 hover:bg-white/5'
                }`}
              >
                <span>问题</span>
                <span className="text-[9px] bg-amber-500/15 text-amber-500 px-1.5 py-0.2 rounded font-sans font-bold">2</span>
              </button>

              <button 
                onClick={() => setActiveTab('output')} 
                className="px-2.5 py-1 rounded transition-all text-[11px] border"
                style={{
                  backgroundColor: activeTab === 'output' ? `rgba(${modeStyle.accent}, 0.08)` : 'transparent',
                  borderColor: activeTab === 'output' ? `rgba(${modeStyle.accent}, 0.25)` : 'transparent',
                  color: activeTab === 'output' ? modeStyle.color : 'rgba(255, 255, 255, 0.4)',
                }}
              >
                <span>输出</span>
              </button>
            </div>
          )}
        </div>

        {/* Action Controls for terminal simulation */}
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {!isTerminalCollapsed ? (
            <>
              <button 
                onClick={startRebuild} 
                disabled={isBuilding}
                className="flex items-center gap-1.5 px-3 py-1 rounded text-[11px] font-semibold select-none transition-all transition-colors duration-500 active:scale-95 shadow-md"
                style={{
                  backgroundColor: isBuilding ? 'rgba(255,255,255,0.05)' : modeStyle.color,
                  color: isBuilding ? 'rgba(255,255,255,0.3)' : '#0e121c',
                  border: '1px solid',
                  borderColor: isBuilding ? 'rgba(255,255,255,0.05)' : `rgba(${modeStyle.accent}, 0.2)`,
                  boxShadow: isBuilding ? 'none' : `0 4px 12px rgba(${modeStyle.accent}, 0.15)`,
                  cursor: isBuilding ? 'not-allowed' : 'pointer',
                }}
              >
                <Play className="w-3 h-3 fill-current" />
                <span>编译并运行</span>
              </button>
              
              <button 
                onClick={() => setAutoScroll(!autoScroll)}
                className="p-1.5 rounded transition-all border"
                style={{
                  color: autoScroll ? modeStyle.color : 'rgba(255, 255, 255, 0.4)',
                  backgroundColor: autoScroll ? `rgba(${modeStyle.accent}, 0.08)` : 'transparent',
                  borderColor: autoScroll ? `rgba(${modeStyle.accent}, 0.2)` : 'transparent',
                }}
                title={autoScroll ? "锁定滚动到最新日志 (点击解锁)" : "手动浏览中 - 自动滚动已暂停 (点击开启)"}
              >
                {autoScroll ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
              </button>

              <button 
                onClick={clearTerminal} 
                className="p-1.5 hover:bg-red-500/10 rounded text-red-400 hover:text-red-300 transition-colors border border-transparent hover:border-red-500/20"
                title="清空控制台日志"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          ) : (
            <span className="text-[9px] select-none font-sans font-medium mr-2 flex items-center gap-1.5" style={{ color: modeStyle.color }}>
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: modeStyle.color }}></span>
                <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ backgroundColor: modeStyle.color }}></span>
              </span>
              <span>PORT: 3000 | {statusText}</span>
            </span>
          )}

          <div className="w-[1px] h-3.5 bg-outline/20 mx-1" />

          <button 
            onClick={() => setIsTerminalCollapsed(!isTerminalCollapsed)} 
            className="p-1.5 hover:bg-white/5 rounded text-on-surface/50 hover:text-primary transition-colors cursor-pointer flex items-center justify-center border border-transparent"
            title={isTerminalCollapsed ? "展开控制台" : "收起控制台"}
          >
            {isTerminalCollapsed ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {!isTerminalCollapsed && (
        <>
          {/* Dynamic Build Progress Bar Container */}
          <div className="bg-bg/90 px-3.5 py-1 border-b border-outline/10 flex items-center justify-between text-[10px] text-on-surface/50">
            <div className="flex items-center gap-2.5 flex-grow max-w-sm">
              <span className="font-medium min-w-[75px] truncate transition-colors duration-500" style={{ color: modeStyle.color }}>{statusText}</span>
              <div className="flex-grow bg-white/5 h-1.5 rounded-full overflow-hidden border border-white/5">
                <div 
                  className="h-full transition-all duration-150"
                  style={{ 
                    width: `${progress}%`,
                    backgroundColor: progress === 100 ? '#10b981' : modeStyle.color,
                    boxShadow: progress === 100 ? '0 0 8px rgba(16, 185, 129, 0.4)' : `0 0 8px rgba(${modeStyle.accent}, 0.4)`
                  }}
                />
              </div>
              <span className="text-on-surface/60 w-8 text-right font-mono font-bold">{progress}%</span>
            </div>
            <div className="flex items-center gap-2 text-[9px] font-medium text-on-surface/40">
              <span className="bg-white/5 px-1.5 py-0.2 rounded border border-white/5 font-mono font-bold text-emerald-400">0.0.0.0</span>
            </div>
          </div>

          {/* Secondary Instance Tab switcher */}
          {activeTab === 'terminal' && (
            <div className="bg-surface border-b border-outline/15 px-3.5 py-1.5 flex items-center justify-between gap-4 overflow-x-auto select-none shrink-0 scrollbar-none shadow-sm">
              <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none py-0.5">
                {instances.map((inst) => {
                  const isActive = inst.id === activeInstanceId;
                  const isEditing = renameId === inst.id;
                  return (
                    <div
                      key={inst.id}
                      className="flex items-center rounded-md border text-[10px] h-6 transition-all font-sans group relative shrink-0"
                      style={{
                        backgroundColor: isActive ? `rgba(${modeStyle.accent}, 0.12)` : 'rgba(255, 255, 255, 0.02)',
                        borderColor: isActive ? `rgba(${modeStyle.accent}, 0.3)` : 'rgba(255, 255, 255, 0.08)',
                        color: isActive ? modeStyle.color : 'rgba(255, 255, 255, 0.45)',
                      }}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          defaultValue={inst.name}
                          onBlur={(e) => finishRename(inst.id, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              finishRename(inst.id, (e.target as HTMLInputElement).value);
                            } else if (e.key === 'Escape') {
                              setRenameId(null);
                            }
                          }}
                          className="bg-transparent text-white font-mono h-full px-2 outline-none w-20 text-[10px] font-bold"
                        />
                      ) : (
                        <button
                          onClick={() => setActiveInstanceId(inst.id)}
                          onDoubleClick={() => setRenameId(inst.id)}
                          className="px-2 py-0.5 font-semibold text-left max-w-[125px] truncate"
                          title="双击重命名此终端"
                        >
                          {inst.name}
                        </button>
                      )}

                      {instances.length > 1 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            closeInstance(inst.id);
                          }}
                          className="p-0.5 hover:bg-white/10 rounded mr-1 text-on-surface/30 hover:text-red-400 transition-colors shrink-0"
                          title="关闭该终端实例"
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                      )}
                    </div>
                  );
                })}

                <button
                  onClick={addNewInstance}
                  className="p-1 px-1.5 border border-dashed border-outline/30 hover:border-outline/50 rounded-md text-on-surface/40 hover:text-on-surface hover:bg-white/5 transition-all flex items-center gap-1 shrink-0"
                  title="多开新的终端实例 (bash)"
                >
                  <Plus className="w-3 h-3" />
                  <span className="text-[9.5px]">新建终端</span>
                </button>
              </div>

              <div className="text-[9.5px] text-on-surface/35 font-sans whitespace-nowrap select-none shrink-0 italic max-sm:hidden">
                双击页签重命名 | 输入 "help" 体验模拟运行 Shell 命令
              </div>
            </div>
          )}

          {/* Log list area */}
          <div className="flex-grow overflow-y-auto p-4 text-[11px] leading-relaxed space-y-1.5 scrollbar-thin scrollbar-track-transparent dynamic-terminal-scrollarea">
            {activeTab === 'terminal' && (
              <>
                {logItems.length === 0 ? (
                  <div className="text-on-surface/30 italic text-center pt-10 font-sans">终端空闲中。点击右上角“编译并运行”可以重新跑一遍构建周期。</div>
                ) : (
                  logItems.map((log, index) => {
                    const isErr = log.type === 'error';
                    const isWarn = log.type === 'warn';
                    const isSuccess = log.type === 'success';
                    const isSystem = log.type === 'system';

                    return (
                      <div 
                        key={index} 
                        className={`group flex items-center justify-between gap-3 p-1 px-2 rounded transition-all ${
                          isErr 
                            ? 'bg-red-500/5 hover:bg-red-500/8 border-l-2 border-red-500/60' 
                            : isWarn 
                              ? 'bg-amber-500/5 hover:bg-amber-500/8 border-l-2 border-amber-500/60'
                              : 'hover:bg-white/5'
                        }`}
                      >
                        <div className="flex gap-3 min-w-0 flex-grow items-start">
                          <span className="text-on-surface/25 select-none font-sans mt-0.5 shrink-0">{log.time}</span>
                          <span className={`font-bold shrink-0 uppercase text-[9px] px-1.5 py-0.2 rounded border select-none tracking-wider ${
                            isSystem 
                              ? 'text-blue-400 bg-blue-500/10 border-blue-500/20' 
                              : isSuccess 
                                ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' 
                                : isWarn 
                                  ? 'text-amber-400 bg-amber-500/10 border-amber-500/20' 
                                  : isErr 
                                    ? 'text-red-400 bg-red-500/10 border-red-500/20' 
                                    : 'text-on-surface/40 bg-white/5 border-white/5'
                          }`}>
                            {log.type === 'system' ? '系统' : log.type === 'success' ? '成功' : log.type === 'warn' ? '警告' : log.type === 'error' ? '错误' : '基本'}
                          </span>
                          <span className={`break-words select-text font-mono font-medium ${
                            isSuccess 
                              ? 'text-emerald-300/90' 
                              : isWarn 
                                ? 'text-amber-200/90' 
                                : isErr 
                                  ? 'text-red-300' 
                                  : 'text-on-surface/85'
                          }`}>
                            {log.msg}
                          </span>
                        </div>

                        {/* Interactive One-Click Send Box */}
                        <div className="shrink-0 flex items-center pl-2 ml-1">
                          <div className={`opacity-0 group-hover:opacity-100 transition-opacity duration-150 flex items-center gap-1`}>
                            {sentLogMap[index] ? (
                              <span className="text-[10px] text-emerald-400 flex items-center gap-1 font-bold font-sans bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                                <Check className="w-3 h-3" />
                                <span>已附送至对话中</span>
                              </span>
                            ) : (
                              <button
                                onClick={() => handleSendToChat(log.msg, index, log.type)}
                                className={`flex items-center gap-1 text-[10px] font-sans font-semibold px-2 py-0.5 rounded transition-all cursor-pointer ${
                                  isErr 
                                    ? 'bg-red-500 hover:bg-red-400 text-white shadow-md shadow-red-500/10' 
                                    : isWarn 
                                      ? 'bg-amber-500 hover:bg-amber-400 text-bg shadow-md shadow-amber-500/10'
                                      : 'bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20'
                                }`}
                                title="一键将该控制台报错/日志发送至 AI 助手并开启诊断解决方案"
                              >
                                <MessageSquarePlus className="w-3 h-3" />
                                <span>{isErr || isWarn ? '一键解决' : '发送至 AI'}</span>
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}

                {/* Simulated interactive command prompt */}
                <form 
                  onSubmit={handleCommandSubmit} 
                  className="flex items-center gap-2 mt-4 pt-2.5 border-t border-white/5 select-text shrink-0"
                >
                  <span className="text-[10px] select-none text-on-surface/40 font-mono flex items-center shrink-0 font-semibold">
                    <span className="text-emerald-400 font-bold mr-1">$</span>
                    <span>soloforge</span>
                  </span>
                  
                  <input
                    type="text"
                    value={activeInstance.commandValue || ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      setInstances(prev => prev.map(i => i.id === activeInstanceId ? { ...i, commandValue: val } : i));
                    }}
                    placeholder='输入指令体验并测试运行 (例: "help", "neofetch", "ls", "build" ...)'
                    className="flex-grow bg-transparent text-[11px] font-mono outline-none text-on-surface/85 placeholder-on-surface/30 min-w-0"
                  />
                  
                  <span className="text-[9px] font-mono text-on-surface/25 bg-white/5 border border-white/5 px-1.5 py-0.2 rounded select-none shadow-sm shrink-0 whitespace-nowrap">
                    ENTER 执行
                  </span>
                </form>

                <div ref={terminalEndRef} />
              </>
            )}

            {activeTab === 'problems' && (
              <div className="space-y-2.5 p-1">
                {/* Simulated Problem 0: Property Error */}
                <div className="group flex items-start justify-between gap-4 bg-red-500/5 hover:bg-red-500/8 border border-red-500/15 p-2.5 rounded-lg transition-all">
                  <div className="flex items-start gap-2.5 min-w-0">
                    <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                    <div>
                      <div className="text-red-200 font-semibold text-[11px] leading-relaxed">
                        Property "permissionMode" does not exist on type "ChatSession". Did you mean to reference isNormalMode or currentConfig?
                      </div>
                      <div className="text-on-surface/40 text-[9.5px] font-mono mt-1 flex items-center gap-1">
                        <span>文件:</span>
                        <span className="text-blue-300 underline font-semibold select-all">/src/components/ChatPanel.tsx:1125</span>
                        <span>|</span>
                        <span>来源: TypeScript JSX Engine</span>
                      </div>
                    </div>
                  </div>

                  <div className="shrink-0 flex items-center self-center">
                    {problemsSentMap[0] ? (
                      <span className="text-[10px] text-emerald-400 flex items-center gap-1 font-bold font-sans bg-emerald-500/10 px-2.5 py-1 rounded border border-emerald-500/20">
                        <Check className="w-3 h-3" />
                        <span>已发送至 AI 诊断</span>
                      </span>
                    ) : (
                      <button
                        onClick={() => handleSendProblemToChat(
                          'Property "permissionMode" does not exist on type "ChatSession" in ChatPanel.tsx:1125', 
                          '/src/components/ChatPanel.tsx:1125', 
                          0, 
                          'error'
                        )}
                        className="flex items-center gap-1 bg-red-500 hover:bg-red-400 text-white text-[10px] font-sans font-bold px-2.5 py-1 rounded shadow-lg shadow-red-500/10 transition-transform active:scale-95 cursor-pointer"
                      >
                        <MessageSquarePlus className="w-3 h-3" />
                        <span>一键发送到对话</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Simulated Problem 1: Warnings */}
                <div className="group flex items-start justify-between gap-4 bg-amber-500/5 hover:bg-amber-500/8 border border-amber-500/15 p-2.5 rounded-lg transition-all">
                  <div className="flex items-start gap-2.5 min-w-0">
                    <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                    <div>
                      <div className="text-amber-200 font-semibold text-[11px] leading-relaxed">
                        Warning: Bundle size exceeds recommended performance budget limit (d3-selection imports size triggers warn limits setup)
                      </div>
                      <div className="text-on-surface/40 text-[9.5px] font-mono mt-1 flex items-center gap-1">
                        <span>文件:</span>
                        <span className="text-blue-300 underline font-semibold select-all">/src/components/TerminalPanel.tsx:105</span>
                        <span>|</span>
                        <span>来源: Terser Compression Engine</span>
                      </div>
                    </div>
                  </div>

                  <div className="shrink-0 flex items-center self-center">
                    {problemsSentMap[1] ? (
                      <span className="text-[10px] text-emerald-400 flex items-center gap-1 font-bold font-sans bg-emerald-500/10 px-2.5 py-1 rounded border border-emerald-500/20">
                        <Check className="w-3 h-3" />
                        <span>已发送至 AI 诊断</span>
                      </span>
                    ) : (
                      <button
                        onClick={() => handleSendProblemToChat(
                          'Warning: Bundle size exceeds recommended performance budget limit (d3-selection imports size triggers warn limits setup) at Terser Compression Engine', 
                          '/src/components/TerminalPanel.tsx', 
                          1, 
                          'warning'
                        )}
                        className="flex items-center gap-1 bg-amber-500 hover:bg-amber-400 text-bg text-[10px] font-sans font-bold px-2.5 py-1 rounded shadow-lg shadow-amber-500/10 transition-transform active:scale-95 cursor-pointer"
                      >
                        <MessageSquarePlus className="w-3 h-3" />
                        <span>一键发送到对话</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'output' && (
              <div className="text-on-surface/30 italic p-6 text-center font-sans">没有检测到活跃的后台输出流水线。一切正常运行！</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
