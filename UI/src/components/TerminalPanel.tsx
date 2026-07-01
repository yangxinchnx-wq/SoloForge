import { useState, useEffect, useRef } from 'react';
import {
  Play, Trash2, Lock, Unlock, ChevronDown, ChevronUp,
  MessageSquarePlus, Check, Plus, X,
} from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

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

const ACCENT_BY_MODE: Record<NonNullable<TerminalPanelProps['permissionMode']>, string> = {
  normal:      '#34d399',
  performance: '#c084fc',
  expert:      '#fbbf24',
  ultimate:    '#f87171',
};

const LOG_PREFIX: Record<LogItem['type'], string> = {
  error:   '×',
  warn:    '!',
  success: '✓',
  system:  '›',
  info:    '·',
};

const LOG_COLOR_DARK: Record<LogItem['type'], string> = {
  error:   '#f87171',
  warn:    '#fbbf24',
  success: '#34d399',
  system:  '#93c5fd',
  info:    '#cbd5e1',
};

const LOG_COLOR_LIGHT: Record<LogItem['type'], string> = {
  error:   '#b91c1c',
  warn:    '#b45309',
  success: '#047857',
  system:  '#1d4ed8',
  info:    '#3f3f46',
};

const PROBLEM_MSG_DARK = { error: '#fca5a5', warn: '#fde68a' };
const PROBLEM_MSG_LIGHT = { error: '#991b1b', warn: '#92400e' };

export default function TerminalPanel({ permissionMode = 'normal' }: TerminalPanelProps) {
  const accent = ACCENT_BY_MODE[permissionMode] ?? ACCENT_BY_MODE.normal;
  const { activeTheme, currentThemeId } = useTheme();
  const isLight = currentThemeId === 'light';
  const logColor = isLight ? LOG_COLOR_LIGHT : LOG_COLOR_DARK;
  const problemMsg = isLight ? PROBLEM_MSG_LIGHT : PROBLEM_MSG_DARK;

  const [activeTab, setActiveTab] = useState<'terminal' | 'problems' | 'output'>('terminal');
  const [isTerminalCollapsed, setIsTerminalCollapsed] = useState(false);
  const [sentLogMap, setSentLogMap] = useState<Record<number, boolean>>({});
  const [problemsSentMap, setProblemsSentMap] = useState<Record<number, boolean>>({});

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('soloforge-terminal-state-changed', {
      detail: { isCollapsed: isTerminalCollapsed },
    }));
  }, [isTerminalCollapsed]);

  useEffect(() => {
    const handleToggleTerminal = () => setIsTerminalCollapsed(prev => !prev);
    window.addEventListener('soloforge-toggle-terminal', handleToggleTerminal);
    return () => window.removeEventListener('soloforge-toggle-terminal', handleToggleTerminal);
  }, []);

  const [instances, setInstances] = useState<TerminalInstance[]>([
    {
      id: 'server',
      name: 'node (server)',
      logItems: [
        { time: '17:56:50', type: 'system',  msg: '系统已成功在容器端口 3000 初始化监听' },
        { time: '17:56:51', type: 'info',    msg: 'vite v6.2.3 开发服务运行于本地 http://localhost:3000' },
        { time: '17:56:52', type: 'warn',    msg: '[eslint] 警告: 在 useKeybind 钩子中发现 Unexpected any 类型定义 (/src/utils.ts:74)' },
        { time: '17:56:53', type: 'error',   msg: '[typescript] 错误: 在 ChatPanel.tsx:1125 处，类型 "ChatSession" 上不存在属性 "permissionMode"。' },
        { time: '17:56:54', type: 'success', msg: '静态资产包编译成功，静态树结构准备完毕' },
      ],
      progress: 100,
      isBuilding: false,
      statusText: '准备就绪',
      autoScroll: true,
      commandValue: '',
    },
    {
      id: 'compiler',
      name: 'compiler-watch',
      logItems: [
        { time: '17:57:10', type: 'system',  msg: '[esbuild] 启动文件关联监控树...' },
        { time: '17:58:22', type: 'info',    msg: 'FileChanged: src/components/SettingsModal.tsx' },
        { time: '17:58:24', type: 'success', msg: 'TS 静态模块树重构校验耗时 42ms' },
      ],
      progress: 100,
      isBuilding: false,
      statusText: '文件变化监视中',
      autoScroll: true,
      commandValue: '',
    },
  ]);

  const [activeInstanceId, setActiveInstanceId] = useState<string>('server');
  const [renameId, setRenameId] = useState<string | null>(null);

  const activeInstance = instances.find(inst => inst.id === activeInstanceId) || instances[0];
  const { logItems, progress, isBuilding, statusText, autoScroll } = activeInstance;

  const setAutoScroll = (val: boolean) => {
    setInstances(prev => prev.map(inst => inst.id === activeInstanceId ? { ...inst, autoScroll: val } : inst));
  };

  const terminalEndRef = useRef<HTMLDivElement>(null);

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
        { time: new Date().toLocaleTimeString(), type: 'info', msg: '输入 "help" 列出交互式终端指令，运行 "build" 手动执行独立构建流水线任务。' },
      ],
      progress: 100,
      isBuilding: false,
      statusText: '沙盒进程启动完毕',
      autoScroll: true,
      commandValue: '',
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
        { time: new Date().toLocaleTimeString(), type: 'system', msg: '启动多级流水线自动化构建进程...' },
        { time: new Date().toLocaleTimeString(), type: 'info',   msg: 'yarn run build --force' },
      ],
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
            { time: endNow, type: 'success', msg: '生成 /dist 生产捆绑包 (ESM 静态资源格式)' },
            { time: endNow, type: 'info',    msg: 'node dist/server.mjs' },
            { time: endNow, type: 'success', msg: '服务已在 0.0.0.0:3000 稳定部署并提供访问' },
          ],
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
            logItems: nextLogs,
          };
        }));
      }
    }, 150);
  };

  const startRebuild = () => startRebuildForInstance(activeInstanceId);

  const clearTerminal = () => {
    setInstances(prev => prev.map(inst => inst.id === activeInstanceId ? { ...inst, logItems: [] } : inst));
  };

  const handleCommandSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = activeInstance.commandValue.trim();
    if (!cmd) return;

    const timestamp = new Date().toLocaleTimeString();
    const newUserLog: LogItem = { time: timestamp, type: 'system', msg: `$ ${cmd}` };

    let responseLogs: LogItem[] = [];
    const args = cmd.toLowerCase().split(' ');
    const primaryCmd = args[0];

    if (primaryCmd === 'help') {
      responseLogs = [
        { time: timestamp, type: 'info', msg: '可用命令:' },
        { time: timestamp, type: 'info', msg: '  build      运行完整生产级流水线构建周期' },
        { time: timestamp, type: 'info', msg: '  clear      清空当前终端的全部运行日志' },
        { time: timestamp, type: 'info', msg: '  ls         列出当前的系统文件与目录' },
        { time: timestamp, type: 'info', msg: '  neofetch   显示 SoloForge 系统硬件与主题规格' },
        { time: timestamp, type: 'info', msg: '  node       运行简易 JavaScript 算术表达式' },
        { time: timestamp, type: 'info', msg: '  git status 查看本地 git 暂存区与追踪状态' },
      ];
    } else if (primaryCmd === 'clear') {
      setInstances(prev => prev.map(inst => inst.id === activeInstanceId ? { ...inst, logItems: [], commandValue: '' } : inst));
      return;
    } else if (primaryCmd === 'build') {
      setInstances(prev => prev.map(inst => inst.id === activeInstanceId ? {
        ...inst,
        logItems: [...inst.logItems, newUserLog],
        commandValue: '',
      } : inst));
      setTimeout(() => startRebuildForInstance(activeInstanceId), 100);
      return;
    } else if (primaryCmd === 'ls') {
      responseLogs = [
        { time: timestamp, type: 'info', msg: 'src/  public/  docs/  electron/' },
        { time: timestamp, type: 'info', msg: 'package.json  tsconfig.json  vite.config.ts' },
      ];
    } else if (primaryCmd === 'neofetch') {
      responseLogs = [
        { time: timestamp, type: 'success', msg: '   ____        __     ______' },
        { time: timestamp, type: 'success', msg: '  / __/___  __/ /__  / __/ /__ ___ _____' },
        { time: timestamp, type: 'success', msg: ' _\\ \\/ _ \\/ _  / _ \\/ _// _  // _ `/ -_)' },
        { time: timestamp, type: 'success', msg: '/___/\\___/\\_,_/\\___/_/ /_//_/ \\_, /\\__/ ' },
        { time: timestamp, type: 'success', msg: '                             /___/' },
        { time: timestamp, type: 'info', msg: 'OS: SoloForge Sandboxed Node Target' },
        { time: timestamp, type: 'info', msg: 'Kernel: Cloud Run Container (Port 3000)' },
        { time: timestamp, type: 'info', msg: 'Uptime: 2 hours 14 mins' },
        { time: timestamp, type: 'info', msg: 'Core Engines: Vite 6 + React 18 + TS' },
        { time: timestamp, type: 'info', msg: `Permission Mode: ${permissionMode.toUpperCase()}` },
      ];
    } else if (primaryCmd === 'node') {
      const expr = cmd.substring(5).trim();
      if (!expr) {
        responseLogs = [{ time: timestamp, type: 'warn', msg: '用法: node <数学表达式>。例如: node 12+34' }];
      } else {
        try {
          if (/^[0-9+\-*/().\s]+$/.test(expr)) {
            const res = Function(`"use strict"; return (${expr})`)();
            responseLogs = [{ time: timestamp, type: 'success', msg: `= ${res}` }];
          } else {
            responseLogs = [{ time: timestamp, type: 'success', msg: 'Executed statement successfully (return undefined)' }];
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
          { time: timestamp, type: 'info',    msg: 'nothing to commit, working tree clean' },
        ];
      } else {
        responseLogs = [{ time: timestamp, type: 'info', msg: `[git] Simulated execution of: ${cmd}` }];
      }
    } else {
      responseLogs = [
        { time: timestamp, type: 'error', msg: `sh: command not found: ${primaryCmd}` },
        { time: timestamp, type: 'info',  msg: '输入 "help" 获取可供体验的开发控制台命令。' },
      ];
    }

    setInstances(prev => prev.map(inst => inst.id === activeInstanceId ? {
      ...inst,
      logItems: [...inst.logItems, newUserLog, ...responseLogs],
      commandValue: '',
    } : inst));
  };

  const handleSendToChat = (msg: string, index: number, type: LogItem['type']) => {
    const typeLabel = type === 'error' ? '控制台错误' : type === 'warn' ? '控制台警告' : '控制台日志';
    const finalPromptText = `请帮我诊断并给出以下控制台报错的完整重构解决方案：\n\n\`\`\`bash\n${msg}\n\`\`\``;
    window.dispatchEvent(new CustomEvent('send-code-to-chat', {
      detail: {
        fileName: `${typeLabel} (L${index + 1})`,
        text: finalPromptText,
      },
    }));
    setSentLogMap(prev => ({ ...prev, [index]: true }));
    setTimeout(() => setSentLogMap(prev => ({ ...prev, [index]: false })), 2500);
  };

  const handleSendProblemToChat = (probMsg: string, probFile: string, index: number, severity: 'error' | 'warning') => {
    const finalPromptText = `请帮我诊断并修复这个在项目编译时发现的 ${severity === 'error' ? '严重错误' : '警告'}：\n\n文件位置: \`${probFile}\`\n问题描述: ${probMsg}\n\n请帮我编写修复代码并解释根本原因。`;
    window.dispatchEvent(new CustomEvent('send-code-to-chat', {
      detail: {
        fileName: severity === 'error' ? '编译错误 (TS/ESLint)' : '包大小警告 (Build Budget)',
        text: finalPromptText,
      },
    }));
    setProblemsSentMap(prev => ({ ...prev, [index]: true }));
    setTimeout(() => setProblemsSentMap(prev => ({ ...prev, [index]: false })), 2500);
  };

  const errorCount = logItems.filter(l => l.type === 'error').length + 1;
  const warnCount = logItems.filter(l => l.type === 'warn').length;
  const problemsBadge = errorCount + warnCount;

  const tabs: Array<{ key: 'terminal' | 'problems' | 'output'; label: string; badge?: number }> = [
    { key: 'terminal', label: '终端' },
    { key: 'problems', label: '问题', badge: problemsBadge },
    { key: 'output',   label: '输出' },
  ];

  const problems: Array<{
    index: number;
    type: 'error' | 'warning';
    msg: string;
    file: string;
    source: string;
  }> = [
    {
      index: 0,
      type: 'error',
      msg: 'Property "permissionMode" does not exist on type "ChatSession". Did you mean to reference isNormalMode or currentConfig?',
      file: '/src/components/ChatPanel.tsx:1125',
      source: 'TypeScript JSX Engine',
    },
    {
      index: 1,
      type: 'warning',
      msg: 'Bundle size exceeds recommended performance budget limit (d3-selection imports).',
      file: '/src/components/TerminalPanel.tsx',
      source: 'Terser Compression Engine',
    },
  ];

  return (
    <div
      className={`relative flex flex-col font-mono select-none border-t transition-[height,background-color,border-color,color] duration-200 ease-out ${
        isLight
          ? 'text-zinc-800 border-black/[0.08]'
          : 'text-slate-300 border-white/[0.06]'
      } ${isTerminalCollapsed ? 'h-7' : 'h-72'}`}
      style={{ backgroundColor: activeTheme.surface }}
    >
      {/* Title bar — single text row */}
      <div
        onClick={() => isTerminalCollapsed && setIsTerminalCollapsed(false)}
        className={`h-7 px-3 flex items-center justify-between text-[12px] border-b ${
          isLight
            ? 'border-black/[0.08]'
            : 'border-white/[0.06]'
        } ${isTerminalCollapsed ? (isLight ? 'cursor-pointer hover:bg-black/[0.04]' : 'cursor-pointer hover:bg-white/[0.03]') : ''}`}
      >
        <div className="flex items-center gap-3 min-w-0">
          {!isTerminalCollapsed && (
            <div className={`flex items-center gap-2 ${isLight ? 'text-zinc-500' : 'text-slate-500'}`}>
              {tabs.map(tab => {
                const isActive = activeTab === tab.key;
                return (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className="relative px-2.5 py-[3px] rounded text-[11px] font-sans font-medium tracking-wide transition-colors"
                    style={{
                      border: `1px solid ${isActive ? accent : (isLight ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.10)')}`,
                      background: isActive ? `${accent}1A` : 'transparent',
                      color: isActive
                        ? accent
                        : (isLight ? '#52525b' : '#94a3b8'),
                      boxShadow: isActive ? `0 0 0 1px ${accent}33 inset` : 'none',
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive) {
                        e.currentTarget.style.borderColor = `${accent}55`;
                        e.currentTarget.style.color = accent;
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) {
                        e.currentTarget.style.borderColor = isLight ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.10)';
                        e.currentTarget.style.color = isLight ? '#52525b' : '#94a3b8';
                      }
                    }}
                  >
                    <span className="flex items-center gap-1.5">
                      {tab.label}
                      {tab.badge !== undefined && tab.badge > 0 && (
                        <span
                          className="tabular-nums"
                          style={{ color: isActive ? accent : (isLight ? '#71717a' : '#64748b') }}
                        >
                          {tab.badge}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div
          className={`flex items-center gap-1 ${isLight ? 'text-zinc-500' : 'text-slate-500'}`}
          onClick={e => e.stopPropagation()}
        >
          {!isTerminalCollapsed ? (
            <>
              <button
                onClick={startRebuild}
                disabled={isBuilding}
                className="px-2 h-6 rounded text-[12px] flex items-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:text-current"
                style={{ color: isBuilding ? undefined : accent }}
                title="运行构建"
              >
                <Play className="w-3 h-3 fill-current" />
                <span>运行</span>
              </button>
              <button
                onClick={() => setAutoScroll(!autoScroll)}
                className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${
                  isLight ? 'hover:text-zinc-900' : 'hover:text-white'
                }`}
                title={autoScroll ? '已锁定滚动 (点击解锁)' : '已暂停滚动 (点击开启)'}
              >
                {autoScroll
                  ? <Lock className="w-3.5 h-3.5" style={{ color: accent }} />
                  : <Unlock className="w-3.5 h-3.5" />}
              </button>
              <button
                onClick={clearTerminal}
                className={`w-6 h-6 rounded flex items-center justify-center transition-colors hover:text-rose-500`}
                title="清空控制台日志"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          ) : (
            <span className="text-[12px] flex items-center gap-1.5 mr-1 tabular-nums" style={{ color: accent }}>
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping" style={{ background: accent }} />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ background: accent }} />
              </span>
              :3000 — {statusText}
            </span>
          )}

          <button
            onClick={() => setIsTerminalCollapsed(!isTerminalCollapsed)}
            className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${
              isLight ? 'hover:text-zinc-900' : 'hover:text-white'
            }`}
            title={isTerminalCollapsed ? '展开控制台' : '收起控制台'}
          >
            {isTerminalCollapsed ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {!isTerminalCollapsed && (
        <>
          {/* Progress strip — single text row */}
          <div className={`h-7 px-3 flex items-center gap-3 text-[12px] border-b ${
            isLight
              ? 'border-black/[0.08] text-zinc-500'
              : 'border-white/[0.06] text-slate-500'
          }`}>
            <span className="truncate" style={{ color: accent }}>{statusText}</span>
            <span className={isLight ? 'text-zinc-300' : 'text-slate-700'}>·</span>
            <div className={`flex-1 h-px relative overflow-hidden ${isLight ? 'bg-black/[0.08]' : 'bg-white/[0.08]'}`}>
              <span
                className="absolute inset-y-0 left-0 transition-all duration-150"
                style={{ width: `${progress}%`, background: accent }}
              />
            </div>
            <span className={`tabular-nums w-9 text-right ${isLight ? 'text-zinc-500' : 'text-slate-400'}`}>{progress}%</span>
            <span className={`tabular-nums hidden sm:inline ${isLight ? 'text-zinc-400' : 'text-slate-600'}`}>0.0.0.0</span>
          </div>

          {/* Sub-instance tabs */}
          {activeTab === 'terminal' && (
            <div className={`h-8 px-3 flex items-center justify-between text-[12px] border-b ${
              isLight
                ? 'border-black/[0.08] text-zinc-500'
                : 'border-white/[0.06] text-slate-500'
            }`}>
              <div className="flex items-center gap-3 min-w-0">
                {instances.map(inst => {
                  const isActive = inst.id === activeInstanceId;
                  return (
                    <div key={inst.id} className="flex items-center group">
                      {renameId === inst.id ? (
                        <input
                          autoFocus
                          defaultValue={inst.name}
                          onBlur={(e) => finishRename(inst.id, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') finishRename(inst.id, (e.target as HTMLInputElement).value);
                            else if (e.key === 'Escape') setRenameId(null);
                          }}
                          className={`bg-transparent outline-none w-32 ${isLight ? 'text-zinc-900' : 'text-white'}`}
                        />
                      ) : (
                        <button
                          onClick={() => setActiveInstanceId(inst.id)}
                          onDoubleClick={() => setRenameId(inst.id)}
                          className={`transition-colors ${
                            isActive
                              ? (isLight ? 'text-zinc-900' : 'text-white')
                              : (isLight ? 'hover:text-zinc-700' : 'hover:text-slate-300')
                          }`}
                          title="单击切换 · 双击重命名"
                        >
                          {inst.name}
                        </button>
                      )}
                      {instances.length > 1 && (
                        <button
                          onClick={(e) => { e.stopPropagation(); closeInstance(inst.id); }}
                          className={`ml-1 w-4 h-4 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:text-rose-500`}
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
                  className={`transition-colors ${isLight ? 'hover:text-zinc-700' : 'hover:text-slate-300'}`}
                  title="多开新的终端实例"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
              <span className={`hidden md:inline ${isLight ? 'text-zinc-400' : 'text-slate-600'}`}>
                双击页签重命名 · <span style={{ color: accent }}>help</span>
              </span>
            </div>
          )}

          {/* Logs */}
          <div className="flex-1 overflow-y-auto px-3 py-2 text-[12px] leading-[1.6] sf-term-scroll">
            {activeTab === 'terminal' && (
              <>
                {logItems.length === 0 ? (
                  <div className={`h-full flex items-center justify-center ${isLight ? 'text-zinc-500' : 'text-slate-600'}`}>
                    终端空闲中 — 点 <span style={{ color: accent }} className="mx-1">运行</span> 开始构建。
                  </div>
                ) : (
                  logItems.map((log, index) => (
                    <div
                      key={index}
                      className={`group flex items-start gap-2 -mx-1 px-1 rounded transition-colors ${
                        isLight ? 'hover:bg-black/[0.04]' : 'hover:bg-white/[0.03]'
                      }`}
                    >
                      <span className={`tabular-nums text-[11px] shrink-0 ${isLight ? 'text-zinc-400' : 'text-slate-600'}`}>{log.time}</span>
                      <span
                        className="shrink-0 w-3 text-center font-bold"
                        style={{ color: logColor[log.type] }}
                      >
                        {LOG_PREFIX[log.type]}
                      </span>
                      <span
                        className="flex-1 break-words select-text"
                        style={{
                          color: log.type === 'error'
                            ? (isLight ? '#7f1d1d' : '#fca5a5')
                            : log.type === 'warn'
                              ? (isLight ? '#78350f' : '#fde68a')
                              : 'inherit',
                        }}
                      >
                        {log.msg}
                      </span>
                      <button
                        onClick={() => handleSendToChat(log.msg, index, log.type)}
                        className={`shrink-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 ${
                          isLight
                            ? 'text-zinc-500 hover:text-zinc-900'
                            : 'text-slate-500 hover:text-white'
                        }`}
                        title="发送给 AI"
                      >
                        {sentLogMap[index] ? (
                          <Check className="w-3 h-3" style={{ color: accent }} />
                        ) : (
                          <MessageSquarePlus className="w-3 h-3" />
                        )}
                      </button>
                    </div>
                  ))
                )}

                {/* Command prompt */}
                <form onSubmit={handleCommandSubmit} className="flex items-center gap-2 mt-2">
                  <span style={{ color: accent }}>›</span>
                  <span className={isLight ? 'text-zinc-500' : 'text-slate-500'}>soloforge</span>
                  <input
                    type="text"
                    value={activeInstance.commandValue || ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      setInstances(prev => prev.map(i => i.id === activeInstanceId ? { ...i, commandValue: val } : i));
                    }}
                    placeholder='输入指令 — "help" "neofetch" "build" ...'
                    className={`flex-1 min-w-0 bg-transparent outline-none placeholder:text-zinc-400 ${
                      isLight ? 'text-zinc-900 placeholder:text-zinc-400' : 'text-white placeholder:text-slate-600'
                    }`}
                  />
                </form>

                <div ref={terminalEndRef} />
              </>
            )}

            {activeTab === 'problems' && (
              <div>
                {problems.map(p => {
                  const sent = problemsSentMap[p.index];
                  const c = p.type === 'error' ? logColor.error : logColor.warn;
                  return (
                    <div
                      key={p.index}
                      className={`group flex items-start gap-2 -mx-1 px-1 rounded transition-colors ${
                        isLight ? 'hover:bg-black/[0.04]' : 'hover:bg-white/[0.03]'
                      }`}
                    >
                      <span
                        className="shrink-0 w-3 text-center font-bold"
                        style={{ color: c }}
                      >
                        {p.type === 'error' ? '×' : '!'}
                      </span>
                      <span className="flex-1 break-words">
                        <span
                          style={{
                            color: p.type === 'error' ? problemMsg.error : problemMsg.warn,
                          }}
                        >
                          {p.msg}
                        </span>
                        <span className={isLight ? 'text-zinc-400' : 'text-slate-600'}>  ·  </span>
                        <span className={isLight ? 'text-zinc-500' : 'text-slate-500'}>{p.file}</span>
                        <span className={isLight ? 'text-zinc-300' : 'text-slate-700'}> · </span>
                        <span className={isLight ? 'text-zinc-400' : 'text-slate-600'}>{p.source}</span>
                      </span>
                      <button
                        onClick={() => handleSendProblemToChat(p.msg, p.file, p.index, p.type)}
                        className={`shrink-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 ${
                          isLight
                            ? 'text-zinc-500 hover:text-zinc-900'
                            : 'text-slate-500 hover:text-white'
                        }`}
                        title="发送给 AI"
                      >
                        {sent ? (
                          <Check className="w-3 h-3" style={{ color: accent }} />
                        ) : (
                          <MessageSquarePlus className="w-3 h-3" />
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {activeTab === 'output' && (
              <div className={`h-full flex items-center justify-center ${isLight ? 'text-zinc-500' : 'text-slate-600'}`}>
                没有活跃的后台输出流水线。
              </div>
            )}
          </div>
        </>
      )}

      <style>{`
        .sf-term-scroll { scrollbar-width: thin; scrollbar-color: rgba(148,163,184,0.18) transparent; }
        .sf-term-scroll::-webkit-scrollbar { width: 6px; height: 6px; display: block; }
        .sf-term-scroll::-webkit-scrollbar-track { background: transparent; }
        .sf-term-scroll::-webkit-scrollbar-thumb {
          background-color: rgba(148,163,184,0.18);
          border-radius: 9999px;
          border: 1px solid transparent;
          background-clip: padding-box;
        }
        .sf-term-scroll::-webkit-scrollbar-thumb:hover { background-color: rgba(148,163,184,0.32); }
      `}</style>
    </div>
  );
}
