// ─────────────────────────────────────────────────────────────────
// 顶部栏
// 多模型混合任务开关 · 主模型 · 副模型 · 项目 · 主题 · 状态
// ─────────────────────────────────────────────────────────────────

import { useState, useRef, useEffect } from 'react';
import { useTheme } from '../../themes';
import { Switch, Select, Tooltip, Badge, StatusDot, Button, Kbd, KbdGroup } from '../ui/Button';
import type { ChatSettings } from '../../hooks/useChat';

const MODELS = [
  { value: 'MiniMax-M3', label: 'MiniMax M3', desc: '主控 / 推理' },
  { value: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5', desc: 'Anthropic' },
  { value: 'claude-haiku-4.5', label: 'Claude Haiku 4.5', desc: 'Anthropic · 快速' },
  { value: 'gpt-4o', label: 'GPT-4o', desc: 'OpenAI' },
  { value: 'gpt-4o-mini', label: 'GPT-4o mini', desc: 'OpenAI · 轻量' },
  { value: 'gemini-2.0-pro', label: 'Gemini 2.0 Pro', desc: 'Google' },
  { value: 'deepseek-v3', label: 'DeepSeek V3', desc: '深度求索' },
  { value: 'qwen-2.5-72b', label: 'Qwen 2.5 72B', desc: '通义千问' },
  { value: 'local-llama-3.1', label: 'Llama 3.1 (本地)', desc: '本地推理' },
];

// 顶部滚动提示 (icon + 文本 + 可选 action 跳转)
interface HintItem {
  text: string;
  icon: string;
  cta?: string;
  run?: (api: {
    onOpenPalette: () => void;
    onOpenSearch: () => void;
    onOpenQuickJump: () => void;
    onOpenHotkey: () => void;
    onOpenSettings: () => void;
    onOpenDeploy: () => void;
  }) => void;
}

const HINTS: HintItem[] = [
  { text: '按 Ctrl+K 打开命令面板',           icon: 'bolt',            cta: '打开', run: a => a.onOpenPalette() },
  { text: '按 Ctrl+Shift+F 跨文件搜索内容',   icon: 'manage_search',   cta: '搜索', run: a => a.onOpenSearch() },
  { text: '按 Ctrl+P 跳到任意文件',           icon: 'electric_bolt',   cta: '跳转', run: a => a.onOpenQuickJump() },
  { text: '多模型混合可降低单点延迟',          icon: 'hub',             cta: '设置' },
  { text: '点击流送区类型徽标可按类型过滤',    icon: 'stream',          cta: '查看' },
  { text: '按 ? 查看全部 30+ 快捷键',          icon: 'keyboard',        cta: '速查', run: a => a.onOpenHotkey() },
  { text: 'Ctrl+Shift+D 启动部署向导',         icon: 'rocket_launch',   cta: '部署', run: a => a.onOpenDeploy() },
  { text: '长期记忆会自动召回，无需手动启用',  icon: 'memory',          cta: '设置', run: a => a.onOpenSettings() },
];

interface Props {
  settings: ChatSettings;
  setSettings: (s: ChatSettings | ((p: ChatSettings) => ChatSettings)) => void;
  connected: boolean;
  lastUpdate: string;
  onRefresh: () => void;
  projectName: string;
  onProjectNameChange: (n: string) => void;
  onOpenSettings: () => void;
  onOpenPalette?: () => void;
  onOpenActivity?: () => void;
  onOpenSearch?: () => void;
  onOpenQuickJump?: () => void;
  onOpenDeploy?: () => void;
  onOpenHotkey?: () => void;
  onOpenProjectIO?: () => void;
  activityNewCount?: number;
  latencyMs?: number | null;
  retryAttempt?: number;
}

export function TopBar({ settings, setSettings, connected, lastUpdate, onRefresh, projectName, onProjectNameChange, onOpenSettings, onOpenPalette, onOpenActivity, onOpenSearch, onOpenQuickJump, onOpenDeploy, onOpenHotkey, onOpenProjectIO, activityNewCount, latencyMs, retryAttempt }: Props) {
  const { current, themeList, setTheme } = useTheme();
  const [editingProject, setEditingProject] = useState(false);
  const [tempName, setTempName] = useState(projectName);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [hint, setHint] = useState(0);
  const [dismissedHints, setDismissedHints] = useState<Set<number>>(() => {
    try {
      const raw = localStorage.getItem('soloforge.topbar.hints.dismissed');
      if (raw) return new Set(JSON.parse(raw) as number[]);
    } catch { /* ignore */ }
    return new Set();
  });
  // snoozed: { idx: untilTimestamp }
  const [snoozedHints, setSnoozedHints] = useState<Record<number, number>>(() => {
    try {
      const raw = localStorage.getItem('soloforge.topbar.hints.snoozed');
      if (raw) {
        const data = JSON.parse(raw) as Record<string, number>;
        // 过滤掉过期的 (sentinel -1 = "until refresh" 始终保留, 仅在 mount 时清空)
        const now = Date.now();
        const out: Record<number, number> = {};
        for (const [k, v] of Object.entries(data)) {
          if (v === -1) out[Number(k)] = -1;
          else if (v > now) out[Number(k)] = v;
        }
        return out;
      }
    } catch { /* ignore */ }
    return {};
  });
  const modelMenuRef = useRef<HTMLDivElement>(null);

  // dismiss 持久化
  useEffect(() => {
    try {
      localStorage.setItem('soloforge.topbar.hints.dismissed', JSON.stringify([...dismissedHints]));
    } catch { /* ignore */ }
  }, [dismissedHints]);

  // snooze 持久化
  useEffect(() => {
    try {
      localStorage.setItem('soloforge.topbar.hints.snoozed', JSON.stringify(snoozedHints));
    } catch { /* ignore */ }
  }, [snoozedHints]);

  // 定时清理过期 snooze + 重新显示
  // sentinel: -1 表示"直到刷新", 不参与时间清理
  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      setSnoozedHints(prev => {
        let changed = false;
        const next: Record<number, number> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (v === -1 || v > now) next[Number(k)] = v;
          else changed = true;
        }
        return changed ? next : prev;
      });
    };
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, []);

  // 顶部滚动提示 (可点击)
  useEffect(() => {
    const now = Date.now();
    const hiddenCount =
      dismissedHints.size +
      Object.values(snoozedHints).filter(v => v === -1 || v > now).length;
    if (hiddenCount >= HINTS.length) return;
    const t = setInterval(() => setHint(i => (i + 1) % HINTS.length), 5000);
    return () => clearInterval(t);
  }, [dismissedHints.size, snoozedHints]);

  const isHintVisible = (i: number) => {
    if (dismissedHints.has(i)) return false;
    const until = snoozedHints[i];
    // sentinel -1 = "直到刷新" 始终隐藏
    if (until === -1) return false;
    if (until && until > Date.now()) return false;
    return true;
  };

  const visibleHints = HINTS.map((h, i) => ({ h, i })).filter(({ i }) => isHintVisible(i));
  const currentHint = visibleHints[hint % Math.max(1, visibleHints.length)];
  const currentIdx = currentHint?.i ?? -1;

  // 恢复提示按钮 (所有 dismiss/snooze 后的二次入口)
  const restoreHints = () => {
    setDismissedHints(new Set());
    setSnoozedHints({});
    setHint(0);
  };

  // snooze 当前 hint (支持多档)
  // sentinel: ms = -1 表示"直到刷新" (不参与时间过期清理)
  const SNOOZE_OPTIONS: { label: string; ms: number; icon?: string }[] = [
    { label: '1 小时',     ms: 60 * 60 * 1000,          icon: 'schedule' },
    { label: '4 小时',     ms: 4 * 60 * 60 * 1000,      icon: 'schedule' },
    { label: '1 天',       ms: 24 * 60 * 60 * 1000,     icon: 'schedule' },
    { label: '直到刷新',   ms: -1,                       icon: 'refresh' },
  ];
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);
  const snoozeCurrent = (ms: number) => {
    if (currentIdx < 0) return;
    // ms = -1 sentinel: 存为 -1, 永久 (直到刷新)
    setSnoozedHints(prev => ({ ...prev, [currentIdx]: ms === -1 ? -1 : Date.now() + ms }));
    setSnoozeMenuOpen(false);
  };

  // 点击外部关闭菜单
  useEffect(() => {
    if (!snoozeMenuOpen) return;
    const onClick = () => setSnoozeMenuOpen(false);
    setTimeout(() => window.addEventListener('click', onClick, { once: true }), 0);
    return () => window.removeEventListener('click', onClick);
  }, [snoozeMenuOpen]);

  useEffect(() => { setTempName(projectName); }, [projectName]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, []);

  const commitProject = () => {
    if (tempName.trim()) onProjectNameChange(tempName.trim());
    setEditingProject(false);
  };

  return (
    <header className="flex items-center px-3 h-12 bg-surface border-b border-border shrink-0 gap-3 relative z-30 overflow-hidden">
      {/* 左侧：品牌 + 项目名 + 状态 */}
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className="flex items-center gap-2 shrink-0">
          <div className="relative">
            <span className="material-symbols-outlined filled text-primary text-xl">token</span>
            <span className="absolute inset-0 blur-md bg-primary/30 rounded-full" />
          </div>
          <span className="font-display text-base font-bold text-primary tracking-tight">
            SoloForge
          </span>
          <Badge variant="default" className="font-mono">v1.0.0</Badge>
        </div>

        <div className="w-px h-5 bg-border" />

        {/* 项目名 */}
        {editingProject ? (
          <input
            autoFocus
            value={tempName}
            onChange={e => setTempName(e.target.value)}
            onBlur={commitProject}
            onKeyDown={e => { if (e.key === 'Enter') commitProject(); if (e.key === 'Escape') setEditingProject(false); }}
            className="bg-surface-high text-sm text-text px-2 py-0.5 rounded border border-primary focus:outline-none min-w-[120px] max-w-[200px]"
          />
        ) : (
          <button
            onClick={() => setEditingProject(true)}
            className="group flex items-center gap-1 text-sm font-medium text-text hover:bg-surface-high px-2 py-0.5 rounded transition-colors min-w-0"
          >
            <span className="material-symbols-outlined text-text-secondary text-sm">folder</span>
            <span className="truncate max-w-[180px]">{projectName}</span>
            <span className="material-symbols-outlined text-text-secondary text-xs opacity-0 group-hover:opacity-100">edit</span>
          </button>
        )}

        <div className="w-px h-5 bg-border" />

        <Tooltip content={`构建 #${Math.floor(Math.random() * 1000) + 2000} · main`}>
          <Badge variant="info" dot>
            <span className="material-symbols-outlined text-[10px]">commit</span>
            main
          </Badge>
        </Tooltip>

        <div className="w-px h-5 bg-border" />

        <div className="hidden lg:flex items-center gap-1.5 px-2 h-7 max-w-[300px] overflow-hidden bg-surface-high/50 border border-border-light rounded-md hover:border-primary/40 transition-colors group">
          <span className="material-symbols-outlined text-primary text-xs shrink-0">tips_and_updates</span>
          {currentIdx >= 0 ? (
            <>
              <span key={currentIdx + '-' + hint} className="flex items-center gap-1.5 text-[10px] text-text-secondary truncate animate-fade-in min-w-0">
                <span className="material-symbols-outlined text-[10px] text-primary/70 shrink-0">{HINTS[currentIdx].icon}</span>
                <span className="truncate">{HINTS[currentIdx].text}</span>
              </span>
              {HINTS[currentIdx].cta && HINTS[currentIdx].run && (
                <button
                  onClick={() => HINTS[currentIdx].run!({
                    onOpenPalette: onOpenPalette!,
                    onOpenSearch: onOpenSearch!,
                    onOpenQuickJump: onOpenQuickJump!,
                    onOpenHotkey: onOpenHotkey!,
                    onOpenSettings: onOpenSettings!,
                    onOpenDeploy: onOpenDeploy!,
                  })}
                  className="ml-auto shrink-0 px-1.5 h-5 rounded text-[9px] font-semibold text-primary bg-primary/10 border border-primary/30 hover:bg-primary hover:text-on-primary transition-colors flex items-center gap-0.5"
                >
                  {HINTS[currentIdx].cta}
                  <span className="material-symbols-outlined text-[10px]">arrow_forward</span>
                </button>
              )}
              <div className="relative ml-0.5 shrink-0">
                <button
                  onClick={(e) => { e.stopPropagation(); setSnoozeMenuOpen(o => !o); }}
                  className="material-symbols-outlined text-[10px] text-text-secondary/50 hover:text-warning opacity-0 group-hover:opacity-100 transition-opacity"
                  title="暂时隐藏 (1h / 4h / 1d / 直到刷新)"
                >schedule</button>
                {snoozeMenuOpen && (
                  <div
                    className="absolute top-full right-0 mt-1 z-50 w-32 bg-surface border border-border rounded-lg shadow-lg overflow-hidden animate-slide-in-up"
                    onClick={e => e.stopPropagation()}
                  >
                    <div className="px-2 py-1 text-[9px] text-text-secondary/70 font-mono border-b border-border-light bg-bg-dim">
                      隐藏时长
                    </div>
                    {SNOOZE_OPTIONS.map(opt => {
                      const isRefresh = opt.ms === -1;
                      return (
                        <button
                          key={opt.ms}
                          onClick={() => snoozeCurrent(opt.ms)}
                          className={`w-full flex items-center justify-between px-2 h-6 text-[10px] text-text hover:bg-surface-high transition-colors ${
                            isRefresh ? 'border-t border-border-light' : ''
                          }`}
                        >
                          <span className="flex items-center gap-1.5">
                            <span className={`material-symbols-outlined text-[10px] ${isRefresh ? 'text-accent' : 'text-text-secondary'}`}>{opt.icon}</span>
                            <span className={isRefresh ? 'text-accent' : ''}>{opt.label}</span>
                          </span>
                          {isRefresh && (
                            <span className="text-[8px] text-text-secondary/70 font-mono">F5</span>
                          )}
                        </button>
                      );
                    })}
                    {snoozedHints[currentIdx] && (
                      <button
                        onClick={() => {
                          setSnoozedHints(prev => { const n = { ...prev }; delete n[currentIdx]; return n; });
                          setSnoozeMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-1 px-2 h-6 text-[10px] text-warning hover:bg-warning/10 border-t border-border-light transition-colors"
                      >
                        <span className="material-symbols-outlined text-[10px]">cancel</span>
                        <span>取消隐藏</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
              <button
                onClick={() => setDismissedHints(prev => {
                  const next = new Set(prev);
                  next.add(currentIdx);
                  return next;
                })}
                className="shrink-0 material-symbols-outlined text-[10px] text-text-secondary/50 hover:text-text opacity-0 group-hover:opacity-100 transition-opacity"
                title="永久不再显示"
              >close</button>
            </>
          ) : (
            <button
              onClick={restoreHints}
              className="text-[10px] text-text-secondary/70 hover:text-primary flex-1 text-center flex items-center justify-center gap-1"
              title="点击恢复全部提示"
            >
              <span className="material-symbols-outlined text-[10px]">refresh</span>
              恢复提示
            </button>
          )}
          {visibleHints.length > 1 && currentIdx >= 0 && (
            <span className="text-[9px] text-text-secondary/50 font-mono shrink-0">
              {(hint % visibleHints.length) + 1}/{visibleHints.length}
            </span>
          )}
        </div>
      </div>

      {/* 中间：多模型 + 主/副 — 固定宽度布局,开关切换不挤压其他元素 */}
      <div className="flex items-center gap-3 shrink-0 w-[460px] justify-center">
        {/* 混合开关 */}
        <div className="flex items-center gap-2 px-2.5 h-8 bg-surface-high rounded-lg border border-border-light shrink-0">
          <span className="material-symbols-outlined text-primary text-sm">hub</span>
          <span className="text-xs text-text font-medium">多模型混合</span>
          <Switch
            checked={settings.hybridEnabled}
            onChange={v => setSettings(s => ({ ...s, hybridEnabled: v }))}
            size="sm"
          />
        </div>

        <div className="w-px h-5 bg-border" />

        <ModelPicker
          label="主模型"
          value={settings.primaryModel}
          onChange={v => setSettings(s => ({ ...s, primaryModel: v }))}
          disabled={!settings.hybridEnabled}
        />

        {/* 副模型区域: 始终占位,关闭时灰显而非消失 → 位置固定 */}
        <span
          className={'material-symbols-outlined text-base shrink-0 transition-opacity ' +
            (settings.hybridEnabled ? 'text-text-secondary' : 'opacity-30')}
        >sync</span>
        <div className={settings.hybridEnabled ? '' : 'opacity-40 pointer-events-none'}>
          <ModelPicker
            label="副模型"
            value={settings.secondaryModel}
            onChange={v => setSettings(s => ({ ...s, secondaryModel: v }))}
            disabled={!settings.hybridEnabled}
          />
        </div>
      </div>

      {/* 右侧：主题 / 状态 / 设置 */}
      <div className="flex items-center gap-2 shrink-0">
        {/* 主题切换 */}
        <div className="flex items-center bg-surface-high rounded-md border border-border-light p-0.5">
          {themeList.slice(0, 4).map(t => (
            <Tooltip key={t.id} content={t.name}>
              <button
                onClick={() => setTheme(t.id)}
                className={`w-5 h-5 rounded transition-all ${
                  current.id === t.id ? 'ring-1 ring-primary scale-110' : 'hover:scale-110'
                }`}
                style={{
                  background: `linear-gradient(135deg, ${t.tokens.primary} 0%, ${t.tokens.accent} 50%, ${t.tokens.success} 100%)`,
                }}
              />
            </Tooltip>
          ))}
        </div>

        <div className="w-px h-5 bg-border" />

        {/* 状态徽标 */}
        <Tooltip content={
          connected
            ? `后端已连接 · ${lastUpdate}${latencyMs != null ? ` · ${latencyMs}ms` : ''}${retryAttempt ? ` · 第 ${retryAttempt} 次重试` : ''}`
            : `后端不可达${retryAttempt ? ` · 第 ${retryAttempt} 次重试` : ''}`
        }>
          <div className="flex items-center gap-1.5 px-2 h-7 rounded-md bg-surface-high border border-border-light">
            <StatusDot status={connected ? 'running' : 'error'} pulse={connected} />
            <span className="text-[11px] font-medium text-text">
              {connected ? '已连接' : '离线'}
            </span>
            {latencyMs != null && connected && (
              <span className={`text-[10px] font-mono tabular-nums ${
                latencyMs < 100 ? 'text-success' : latencyMs < 300 ? 'text-warning' : 'text-danger'
              }`}>
                {latencyMs}ms
              </span>
            )}
            {retryAttempt ? (
              <span className="text-[9px] font-mono text-warning/80">
                ↻{retryAttempt}
              </span>
            ) : null}
          </div>
        </Tooltip>

        <Button variant="ghost" size="sm" icon="refresh" onClick={onRefresh} tooltip="刷新数据" />
        <Tooltip content={`最近活动${activityNewCount ? ` (${activityNewCount} 条新)` : ''}`} arg="eventStream" hint="决策/训练/法庭/部署">
          <button
            onClick={onOpenActivity}
            className="relative w-7 h-7 flex items-center justify-center rounded-md text-text-secondary hover:text-text hover:bg-surface-high transition-colors"
          >
            <span className="material-symbols-outlined text-sm">history_toggle_off</span>
            {activityNewCount ? (
              <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 px-1 rounded-full bg-danger text-white text-[9px] font-bold flex items-center justify-center tabular-nums">
                {activityNewCount > 99 ? '99+' : activityNewCount}
              </span>
            ) : null}
          </button>
        </Tooltip>
        <Tooltip content="命令面板" keys={['Ctrl', 'K']} arg="command" hint="按视图/工具/快捷键搜索" side="bottom">
          <button
            onClick={onOpenPalette}
            className="w-7 h-7 flex items-center justify-center rounded-md text-text-secondary hover:text-text hover:bg-surface-high transition-colors"
          >
            <span className="material-symbols-outlined text-sm">search</span>
          </button>
        </Tooltip>
        <button
          onClick={onOpenQuickJump}
          className="flex items-center gap-1.5 h-7 px-2 rounded-md bg-surface-high border border-border-light hover:border-primary text-text-secondary hover:text-text text-[11px] transition-colors"
        >
          <span className="material-symbols-outlined text-sm">electric_bolt</span>
          <span className="hidden xl:inline">跳转</span>
          <kbd className="hidden xl:inline-block px-1 py-0.5 text-[9px] rounded bg-bg-dim text-text-secondary/80 border border-border-light font-mono">⌃P</kbd>
        </button>
        <button
          onClick={onOpenSearch}
          className="flex items-center gap-1.5 h-7 px-2 rounded-md bg-surface-high border border-border-light hover:border-primary text-text-secondary hover:text-text text-[11px] transition-colors"
        >
          <span className="material-symbols-outlined text-sm">manage_search</span>
          <span className="hidden xl:inline">搜索</span>
          <kbd className="hidden xl:inline-block px-1 py-0.5 text-[9px] rounded bg-bg-dim text-text-secondary/80 border border-border-light font-mono">⌃⇧F</kbd>
        </button>
        <Tooltip content="快捷键速查" keys={['?']} arg="hotkeys" hint="30+ 快捷键分组速览">
          <button
            onClick={onOpenHotkey}
            className="w-7 h-7 flex items-center justify-center rounded-md text-text-secondary hover:text-text hover:bg-surface-high transition-colors"
          >
            <span className="material-symbols-outlined text-sm">keyboard</span>
          </button>
        </Tooltip>
        <Tooltip content="导入 / 导出" arg="projectIO" hint="JSON 拖拽导入/下载导出">
          <button
            onClick={onOpenProjectIO}
            className="w-7 h-7 flex items-center justify-center rounded-md text-text-secondary hover:text-text hover:bg-surface-high transition-colors"
          >
            <span className="material-symbols-outlined text-sm">sync_alt</span>
          </button>
        </Tooltip>
        <Tooltip content="设置" keys={['Ctrl', ',']} arg="settings" hint="主题/AI/记忆/后端">
          <button
            onClick={onOpenSettings}
            className="w-7 h-7 flex items-center justify-center rounded-md text-text-secondary hover:text-text hover:bg-surface-high transition-colors"
          >
            <span className="material-symbols-outlined text-sm">settings</span>
          </button>
        </Tooltip>
        <Tooltip content="部署" keys={['Ctrl', 'Shift', 'D']} arg="deploy" hint="3 步部署向导">
          <button
            onClick={onOpenDeploy}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-primary text-on-primary hover:opacity-90 text-[11px] font-semibold transition-all"
          >
            <span className="material-symbols-outlined text-sm">rocket_launch</span>
            <span className="hidden sm:inline">部署</span>
          </button>
        </Tooltip>
      </div>
    </header>
  );
}

function ModelPicker({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const current = MODELS.find(m => m.value === value);
  return (
    <Tooltip content={`${current?.label} · ${current?.desc}`}>
      <div className={`flex items-center gap-1.5 ${disabled ? 'opacity-40' : ''}`}>
        <span className="text-[10px] text-text-secondary uppercase tracking-wider font-semibold">{label}</span>
        <Select value={value} onChange={onChange} options={MODELS} size="sm" disabled={disabled} />
      </div>
    </Tooltip>
  );
}
