import { useState, useEffect, useRef } from 'react';
import {
  Trash2, Lock, Unlock, ChevronDown, ChevronUp,
  MessageSquarePlus, Check, X,
} from '../utils/icons';
import { useHotTheme } from '../context/ThemeContext';
import { useTerminalLogStore } from './terminal/store/terminalLogStore';
import { sseBackend } from '../services/sseBackend';

interface TerminalPanelProps {
  chatId: string;
  permissionMode?: 'normal' | 'performance' | 'expert' | 'ultimate';
  /** 当前 chat 的工作目录, 用于命令执行 cwd */
  workdir?: string;
}

const ACCENT_BY_MODE: Record<NonNullable<TerminalPanelProps['permissionMode']>, string> = {
  normal:      '#34d399',
  performance: '#c084fc',
  expert:      '#fbbf24',
  ultimate:    '#f87171',
};

const LOG_PREFIX: Record<'info' | 'success' | 'warn' | 'error' | 'system', string> = {
  error:   '×',
  warn:    '!',
  success: '✓',
  system:  '›',
  info:    '·',
};

const LOG_COLOR_DARK: Record<'info' | 'success' | 'warn' | 'error' | 'system', string> = {
  error:   '#f87171',
  warn:    '#fbbf24',
  success: '#34d399',
  system:  '#93c5fd',
  info:    '#cbd5e1',
};

const LOG_COLOR_LIGHT: Record<'info' | 'success' | 'warn' | 'error' | 'system', string> = {
  error:   '#b91c1c',
  warn:    '#b45309',
  success: '#047857',
  system:  '#1d4ed8',
  info:    '#3f3f46',
};

const PROBLEM_MSG_DARK = { error: '#fca5a5', warn: '#fde68a' };
const PROBLEM_MSG_LIGHT = { error: '#991b1b', warn: '#92400e' };

// 模块级常量空数组: zustand selector 返回它时引用稳定, 避免 useSyncExternalStore 无限循环
const EMPTY_ARR: readonly unknown[] = [];

export default function TerminalPanel({ chatId, permissionMode = 'normal', workdir }: TerminalPanelProps) {
  const accent = ACCENT_BY_MODE[permissionMode] ?? ACCENT_BY_MODE.normal;
  const { activeTheme, currentThemeId } = useHotTheme();
  const isLight = currentThemeId === 'light';
  const logColor = isLight ? LOG_COLOR_LIGHT : LOG_COLOR_DARK;
  const problemMsg = isLight ? PROBLEM_MSG_LIGHT : PROBLEM_MSG_DARK;

  const [activeTab, setActiveTab] = useState<'terminal' | 'problems' | 'output'>('terminal');
  const [isTerminalCollapsed, setIsTerminalCollapsed] = useState(true);
  const [sentLogMap, setSentLogMap] = useState<Record<number, boolean>>({});
  const [problemsSentMap, setProblemsSentMap] = useState<Record<number, boolean>>({});

  // ── 从 terminalLogStore 读该 chat 的所有 instances ───────────────
  // 注意: `?? []` 每次渲染都创建新空数组引用, useSyncExternalStore 判定状态变化 → 无限循环
  // 修复: 用模块级常量 EMPTY_ARR 保证引用稳定
  const instances = useTerminalLogStore((s) => s.chats[chatId]?.instances ?? EMPTY_ARR);
  const activeInstanceId = useTerminalLogStore((s) => s.chats[chatId]?.activeInstanceId ?? null);
  const clearLogs = useTerminalLogStore((s) => s.clearLogs);
  const setAutoScrollStore = useTerminalLogStore((s) => s.setAutoScroll);
  const setActiveInstance = useTerminalLogStore((s) => s.setActiveInstance);
  const closeInstance = useTerminalLogStore((s) => s.closeInstance);

  const activeInstance = instances.find(i => i.id === activeInstanceId) ?? instances[0] ?? null;

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

  // ── 启用 SSE 常驻连接 ──────────────────────────────────────────
  // 终端是用户随时可用的功能, 需要持续监听 tool_* 事件并桥接到 terminalLogStore.
  // 即使没有 AI 对话流送 (没有 subscriber), 也要保持 EventSource 连接.
  // sseBackend 收到 tool_started/tool_stdout/tool_stderr/tool_exit 后
  // 会直接调用 useTerminalLogStore 的对应方法, 不依赖 subscriber.
  useEffect(() => {
    sseBackend.enableKeepAlive();
  }, []);

  const terminalEndRef = useRef<HTMLDivElement>(null);
  const autoScroll = activeInstance?.autoScroll ?? true;
  const logItems = activeInstance?.logItems ?? [];

  useEffect(() => {
    if (autoScroll && terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logItems, autoScroll]);

  const clearTerminal = () => {
    if (activeInstance) {
      clearLogs(chatId, activeInstance.id);
    }
  };

  const handleSendToChat = (msg: string, index: number, type: 'info' | 'success' | 'warn' | 'error' | 'system') => {
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

  const problems: Array<{
    index: number;
    type: 'error' | 'warning';
    msg: string;
    file: string;
    source: string;
  }> = [];

  const tabs: Array<{ key: 'terminal' | 'problems' | 'output'; label: string; badge?: number }> = [
    { key: 'terminal', label: '终端' },
    { key: 'problems', label: '问题', badge: problems.length },
    { key: 'output',   label: '输出' },
  ];

  const statusText = activeInstance?.statusText ?? '待机中';
  const isBuilding = activeInstance?.isBuilding ?? false;

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
                onClick={() => activeInstance && setAutoScrollStore(chatId, activeInstance.id, !autoScroll)}
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
              {statusText}
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
          {/* ── 实例标签栏 (仅当有实例时显示) ─────────────────── */}
          {instances.length > 0 && (
            <div
              className={`flex items-center gap-1 px-3 h-7 border-b overflow-x-auto sf-term-scroll ${
                isLight ? 'border-black/[0.06]' : 'border-white/[0.04]'
              }`}
            >
              {instances.map((inst) => {
                const isActive = inst.id === (activeInstanceId ?? instances[0]?.id);
                return (
                  <div
                    key={inst.id}
                    onClick={() => setActiveInstance(chatId, inst.id)}
                    className={`group flex items-center gap-1 pl-2 pr-1 py-[3px] rounded text-[11px] font-mono cursor-pointer transition-colors ${
                      isActive
                        ? 'text-on-surface'
                        : isLight ? 'text-zinc-500 hover:text-zinc-800' : 'text-slate-500 hover:text-slate-300'
                    }`}
                    style={{
                      border: `1px solid ${isActive ? accent : (isLight ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.08)')}`,
                      background: isActive ? `${accent}1A` : 'transparent',
                    }}
                    title={inst.statusText}
                  >
                    <span className="tabular-nums select-none">{inst.name}</span>
                    {inst.isBuilding && (
                      <span
                        className="w-1.5 h-1.5 rounded-full animate-pulse"
                        style={{ background: accent }}
                      />
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        closeInstance(chatId, inst.id);
                      }}
                      className={`shrink-0 w-4 h-4 flex items-center justify-center rounded transition-colors ${
                        isLight ? 'hover:bg-black/[0.08] hover:text-zinc-900' : 'hover:bg-white/[0.06] hover:text-white'
                      }`}
                      title="关闭此终端"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Logs */}
          <div className="flex-1 overflow-y-auto px-3 py-2 text-[12px] leading-[1.6] sf-term-scroll">
            {activeTab === 'terminal' && (
              <>
                {logItems.length === 0 ? (
                  <div className={`h-full flex flex-col items-center justify-center gap-2 ${isLight ? 'text-zinc-500' : 'text-slate-600'}`}>
                    <div className="flex items-center gap-2">
                      <span className="relative flex h-2 w-2">
                        <span className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping" style={{ background: accent, animationDuration: '2s' }} />
                        <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: accent }} />
                      </span>
                      <span className="text-[12px] font-semibold">终端待机中</span>
                    </div>
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

                <div ref={terminalEndRef} />
              </>
            )}

            {activeTab === 'problems' && (
              <div className="h-full">
                {problems.length === 0 ? (
                  <div className={`h-full flex items-center justify-center ${isLight ? 'text-zinc-500' : 'text-slate-600'}`}>
                    没有发现问题
                  </div>
                ) : (
                  problems.map(p => {
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
                  })
                )}
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
