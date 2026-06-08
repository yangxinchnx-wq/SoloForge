// ─────────────────────────────────────────────────────────────────
// 设置模态框
// - 左侧分页式导航(带 step 编号 / 图标 / 描述)
// - 右侧内容: 通用 / 主题 / 后端 / 模型 / 记忆 / 快捷键 / 扩展 / 关于
// - 底部全局操作: 取消 / 完成 / 危险操作
// ─────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTheme } from '../../themes';
import { Switch, Button, Badge } from '../ui/Button';
import { KeybindingEditor } from '../settings/KeybindingEditor';

interface Props {
  open: boolean;
  onClose: () => void;
  apiBase: string;
  connected: boolean;
  lastUpdate: string;
  projectName: string;
  onProjectNameChange: (n: string) => void;
  onClearHistory: () => void;
  onOpenThemeEditor?: () => void;
}

interface Section {
  id: string;
  label: string;
  desc: string;
  icon: string;
  badge?: string;
}

const SECTIONS: Section[] = [
  { id: 'general',  label: '通用',     desc: '项目 / 通知 / 显示',  icon: 'tune' },
  { id: 'theme',    label: '主题',     desc: '颜色 / 字体 / 间距',  icon: 'palette' },
  { id: 'ai',       label: 'AI 模型',  desc: '主模型 / 温度 / 提示', icon: 'model_training', badge: 'NEW' },
  { id: 'memory',   label: '记忆',     desc: '召回策略 / 容量',      icon: 'memory', badge: 'NEW' },
  { id: 'backend',  label: '后端',     desc: 'API / 数据库 / 缓存',  icon: 'cloud' },
  { id: 'data',     label: '数据备份', desc: '全量导入/导出/清空',   icon: 'backup', badge: 'NEW' },
  { id: 'ext',      label: '扩展',     desc: '技能 / 插件',          icon: 'extension' },
  { id: 'shortcut', label: '快捷键',   desc: '所有键盘绑定',         icon: 'keyboard' },
  { id: 'about',    label: '关于',     desc: '版本 / 协议 / 致谢',   icon: 'info' },
];

const SHORTCUTS = [
  { group: '全局', items: [
    { keys: ['Ctrl', 'K'],         label: '打开命令面板' },
    { keys: ['Ctrl', 'Shift', 'P'],label: '命令面板(备)' },
    { keys: ['Ctrl', 'Shift', 'F'],label: '全局搜索' },
    { keys: ['Ctrl', 'Shift', 'D'],label: '部署向导' },
    { keys: ['Ctrl', ','],         label: '打开设置' },
    { keys: ['Ctrl', 'R'],         label: '刷新后端' },
  ]},
  { group: '视图', items: [
    { keys: ['Ctrl', 'B'],         label: '切到资源管理' },
    { keys: ['Ctrl', 'P'],         label: '切到法庭' },
    { keys: ['Ctrl', 'G'],         label: '切到源码管理' },
    { keys: ['Ctrl', 'S'],         label: '切到搜索' },
    { keys: ['Ctrl', '`'],         label: '切到终端' },
  ]},
  { group: '会话', items: [
    { keys: ['Ctrl', 'N'],         label: '新建对话' },
    { keys: ['Ctrl', 'L'],         label: '清空流送' },
    { keys: ['Enter'],             label: '发送消息' },
    { keys: ['Shift', 'Enter'],    label: '换行' },
    { keys: ['Esc'],               label: '关闭弹窗' },
  ]},
];

const MODELS = [
  { id: 'gpt-4o',          label: 'GPT-4o',           provider: 'OpenAI',     tag: 'primary' },
  { id: 'gpt-4o-mini',      label: 'GPT-4o mini',      provider: 'OpenAI',     tag: 'fast' },
  { id: 'claude-sonnet-4',  label: 'Claude Sonnet 4',  provider: 'Anthropic',  tag: 'primary' },
  { id: 'claude-haiku',     label: 'Claude Haiku',     provider: 'Anthropic',  tag: 'fast' },
  { id: 'gemini-2.5-pro',   label: 'Gemini 2.5 Pro',   provider: 'Google',     tag: 'primary' },
  { id: 'deepseek-r1',      label: 'DeepSeek R1',      provider: 'DeepSeek',   tag: 'reasoning' },
  { id: 'qwen-3',           label: 'Qwen 3',           provider: 'Alibaba',    tag: 'local' },
];

export function SettingsModal({
  open, onClose, apiBase, connected, lastUpdate, projectName,
  onProjectNameChange, onClearHistory, onOpenThemeEditor,
}: Props) {
  const { current, themeList, setTheme } = useTheme();
  const [tab, setTab] = useState('general');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [notifications, setNotifications] = useState(true);
  const [sounds, setSounds] = useState(false);
  const [compactMode, setCompactMode] = useState(false);
  const [developerMode, setDeveloperMode] = useState(true);
  const [hybrid, setHybrid] = useState(false);
  const [primaryModel, setPrimaryModel] = useState('claude-sonnet-4');
  const [secondaryModel, setSecondaryModel] = useState('gpt-4o-mini');
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(8192);
  const [memoryCapacity, setMemoryCapacity] = useState(2048);
  const [memoryRecall, setMemoryRecall] = useState(8);
  const [memoryDecay, setMemoryDecay] = useState(30);

  // ─── AI 提示词模板 (持久化) ───
  const PROMPTS_KEY = 'soloforge.ai.prompts';
  interface PromptTemplate { id: string; name: string; content: string; builtin?: boolean; }
  const DEFAULT_PROMPTS: PromptTemplate[] = [
    { id: 'system',    name: '系统提示词', content: '你是一个严谨、简洁、注重事实的 AI 助手,擅长代码解释与重构。', builtin: true },
    { id: 'code',      name: '代码生成',   content: '请用 TypeScript 编写,严格类型,带完整错误处理。优先使用项目已有的工具函数。', builtin: true },
    { id: 'review',    name: '代码审查',   content: '按可读性 / 性能 / 安全性 / 可维护性 4 个维度评审,指出具体行号。', builtin: true },
    { id: 'explain',   name: '代码解释',   content: '用通俗语言解释这段代码做了什么、为什么这样写、有什么坑。', builtin: true },
    { id: 'refactor',  name: '重构建议',   content: '保持行为不变的前提下给出重构方案,先描述意图,再给 diff 风格代码。', builtin: true },
  ];
  const [prompts, setPrompts] = useState<PromptTemplate[]>(() => {
    try {
      const raw = localStorage.getItem(PROMPTS_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as PromptTemplate[];
        // 合并: 内置模板 + 用户自定义
        const builtinIds = new Set(DEFAULT_PROMPTS.map(p => p.id));
        const userPrompts = saved.filter(p => !builtinIds.has(p.id));
        return [...DEFAULT_PROMPTS, ...userPrompts];
      }
    } catch { /* ignore */ }
    return DEFAULT_PROMPTS;
  });
  useEffect(() => {
    try {
      // 只持久化用户自定义 (builtin 重新生成)
      const builtinIds = new Set(DEFAULT_PROMPTS.map(p => p.id));
      const userPrompts = prompts.filter(p => !builtinIds.has(p.id));
      localStorage.setItem(PROMPTS_KEY, JSON.stringify([...prompts.filter(p => p.builtin), ...userPrompts]));
    } catch { /* ignore */ }
  }, [prompts]);
  const [activePromptId, setActivePromptId] = useState('system');
  const activePrompt = prompts.find(p => p.id === activePromptId) || prompts[0];
  const updatePrompt = (id: string, content: string) => {
    setPrompts(prev => prev.map(p => p.id === id ? { ...p, content } : p));
  };
  const addPrompt = () => {
    const id = 'user_' + Date.now().toString(36);
    const name = `自定义 ${prompts.filter(p => !p.builtin).length + 1}`;
    setPrompts(prev => [...prev, { id, name, content: '' }]);
    setActivePromptId(id);
  };
  const deletePrompt = (id: string) => {
    const p = prompts.find(x => x.id === id);
    if (!p || p.builtin) return;
    setPrompts(prev => prev.filter(x => x.id !== id));
    if (activePromptId === id) setActivePromptId('system');
  };
  const resetPrompt = (id: string) => {
    const def = DEFAULT_PROMPTS.find(x => x.id === id);
    if (def) updatePrompt(id, def.content);
  };

  // ─── 数据备份区状态 ───
  const [backupScope, setBackupScope] = useState<Record<string, boolean>>({
    sessions: true, settings: true, prompts: true, theme: true, history: true, favorites: true, layout: true, order: true, custom: true,
  });
  const [backupSize, setBackupSize] = useState<number>(0);
  const [backupResult, setBackupResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const importInputRef = useState<HTMLInputElement | null>(null);

  // 收集当前所有 localStorage 中 soloforge.* 的 key
  const collectAllKeys = useCallback(() => {
    const keys: Record<string, any> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('soloforge.')) {
        try {
          keys[k] = JSON.parse(localStorage.getItem(k) || 'null');
        } catch {
          keys[k] = localStorage.getItem(k);
        }
      }
    }
    return keys;
  }, []);

  // 分类映射 (key 前缀 → scope id)
  const scopeForKey = (k: string): string => {
    if (k.includes('chat.history') || k.includes('sessions')) return 'sessions';
    if (k.includes('settings')) return 'settings';
    if (k.includes('prompts')) return 'prompts';
    if (k.includes('theme')) return 'theme';
    if (k.includes('cmd.history') || k.includes('hint')) return 'history';
    if (k.includes('favorites') || k.includes('activity.order')) return 'favorites';
    if (k.includes('layout')) return 'layout';
    if (k.includes('order')) return 'order';
    if (k.includes('custom') || k.includes('token')) return 'custom';
    return 'settings';
  };

  // 计算预计大小
  useEffect(() => {
    const all = collectAllKeys();
    const filtered: Record<string, any> = { __type: 'soloforge-fullbackup', version: 1, exportedAt: new Date().toISOString() };
    Object.entries(all).forEach(([k, v]) => {
      const scope = scopeForKey(k);
      if (backupScope[scope]) filtered[k] = v;
    });
    setBackupSize(new Blob([JSON.stringify(filtered)]).size);
  }, [backupScope, collectAllKeys]);

  const handleFullExport = (download: boolean) => {
    const all = collectAllKeys();
    const filtered: Record<string, any> = { __type: 'soloforge-fullbackup', version: 1, exportedAt: new Date().toISOString() };
    let keyCount = 0;
    Object.entries(all).forEach(([k, v]) => {
      const scope = scopeForKey(k);
      if (backupScope[scope]) { filtered[k] = v; keyCount++; }
    });
    const json = JSON.stringify(filtered, null, 2);
    if (download) {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `soloforge-fullbackup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setBackupResult({ ok: true, msg: `已下载 ${keyCount} 个配置项 · ${(new Blob([json]).size / 1024).toFixed(1)} KB` });
    } else {
      navigator.clipboard?.writeText(json).then(() => {
        setBackupResult({ ok: true, msg: `已复制 ${keyCount} 项到剪贴板` });
      });
    }
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleFullImport = (file: File) => {
    setBackupResult(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const obj = JSON.parse(String(e.target?.result));
        if (obj.__type !== 'soloforge-fullbackup') {
          throw new Error('不是 SoloForge 全量备份文件');
        }
        let count = 0;
        const restored: string[] = [];
        Object.entries(obj).forEach(([k, v]) => {
          if (k.startsWith('soloforge.')) {
            try {
              localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
              count++;
              restored.push(k.replace('soloforge.', ''));
            } catch { /* ignore */ }
          }
        });
        setBackupResult({ ok: true, msg: `已恢复 ${count} 项 · 刷新页面后生效` });
      } catch (err: any) {
        setBackupResult({ ok: false, msg: `导入失败: ${err.message || err}` });
      }
    };
    reader.readAsText(file);
  };

  const handleClearAll = () => {
    if (!confirm('确认清空所有 SoloForge 本地数据? 此操作不可恢复 (建议先备份)。')) return;
    let count = 0;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('soloforge.')) {
        localStorage.removeItem(k);
        count++;
      }
    }
    setBackupResult({ ok: true, msg: `已清空 ${count} 项 · 刷新页面后生效` });
  };

  if (!open) return null;

  const activeIdx = SECTIONS.findIndex(s => s.id === tab);
  const active = SECTIONS[activeIdx];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[860px] max-w-[94vw] h-[640px] max-h-[90vh] overflow-hidden bg-surface rounded-2xl border border-border shadow-2xl flex animate-slide-in-up"
        onClick={e => e.stopPropagation()}
      >
        {/* 左侧分页导航 */}
        <div className="w-60 border-r border-border bg-surface-low p-3 flex flex-col">
          <div className="flex items-center gap-2 mb-3 px-2">
            <span className="material-symbols-outlined filled text-primary text-xl">settings</span>
            <div>
              <div className="font-display font-bold text-text text-sm leading-none">设置</div>
              <div className="text-[10px] text-text-secondary mt-0.5">SoloForge v1.0.0</div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto space-y-0.5 scrollbar-thin pr-1">
            {SECTIONS.map((s, i) => {
              const active = tab === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setTab(s.id)}
                  className={`group w-full flex items-start gap-2.5 px-2.5 py-2 rounded-md text-left transition-colors ${
                    active
                      ? 'bg-primary-container text-on-primary-container'
                      : 'text-text-secondary hover:text-text hover:bg-surface-high'
                  }`}
                >
                  <span
                    className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-mono ${
                      active
                        ? 'bg-primary text-on-primary'
                        : 'bg-bg-dim text-text-secondary group-hover:text-text'
                    }`}
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className={`material-symbols-outlined text-sm ${active ? 'filled' : ''}`}>
                        {s.icon}
                      </span>
                      <span className="text-xs font-medium">{s.label}</span>
                      {s.badge && (
                        <Badge variant="primary" className="text-[8px] !px-1 !py-0">
                          {s.badge}
                        </Badge>
                      )}
                    </div>
                    <div className={`text-[10px] mt-0.5 ${active ? 'text-on-primary-container/70' : 'text-text-secondary/70'}`}>
                      {s.desc}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="px-2 py-2 text-[10px] text-text-secondary border-t border-border-light">
            <div className="flex items-center gap-1.5">
              <span className="material-symbols-outlined text-xs">build</span>
              <span>build #4208-stable</span>
            </div>
            <div className="font-mono mt-0.5">2026-06-03</div>
          </div>
        </div>

        {/* 右侧内容 */}
        <div className="flex-1 flex flex-col bg-bg">
          {/* 顶部 step 指示器 */}
          <div className="flex items-center justify-between px-5 h-12 border-b border-border">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-text-secondary">
                {String(activeIdx + 1).padStart(2, '0')} / {String(SECTIONS.length).padStart(2, '0')}
              </span>
              <span className="text-text-secondary">·</span>
              <span className={`material-symbols-outlined text-base text-primary`}>{active.icon}</span>
              <h3 className="font-display font-semibold text-text text-sm">{active.label}</h3>
              <span className="text-text-secondary text-xs">— {active.desc}</span>
            </div>
            <div className="flex items-center gap-2">
              {/* step 跳转 */}
              <button
                onClick={() => activeIdx > 0 && setTab(SECTIONS[activeIdx - 1].id)}
                disabled={activeIdx === 0}
                className="material-symbols-outlined text-sm text-text-secondary hover:text-text disabled:opacity-30 disabled:hover:text-text-secondary"
              >chevron_left</button>
              <button
                onClick={() => activeIdx < SECTIONS.length - 1 && setTab(SECTIONS[activeIdx + 1].id)}
                disabled={activeIdx === SECTIONS.length - 1}
                className="material-symbols-outlined text-sm text-text-secondary hover:text-text disabled:opacity-30 disabled:hover:text-text-secondary"
              >chevron_right</button>
              <span className="w-px h-4 bg-border mx-1" />
              <button
                onClick={onClose}
                className="material-symbols-outlined text-text-secondary hover:text-text w-7 h-7 flex items-center justify-center rounded hover:bg-surface-high"
              >close</button>
            </div>
          </div>

          {/* step 进度条 */}
          <div className="h-0.5 bg-border-light">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${((activeIdx + 1) / SECTIONS.length) * 100}%` }}
            />
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-5 scrollbar-thin">
            {/* 通用 */}
            {tab === 'general' && (
              <>
                <Field label="项目名称" hint="显示在顶部栏和文件树根">
                  <input
                    value={projectName}
                    onChange={e => onProjectNameChange(e.target.value)}
                    className="w-full bg-bg-dim border border-border rounded-md px-3 py-1.5 text-sm text-text focus:outline-none focus:border-primary"
                    placeholder="我的 SoloForge 项目"
                  />
                </Field>
                <div className="h-px bg-border" />
                <Field label="自动刷新" hint="每 3 秒拉取后端最新数据">
                  <Switch checked={autoRefresh} onChange={setAutoRefresh} label={autoRefresh ? '已开启' : '已关闭'} />
                </Field>
                <Field label="桌面通知" hint="任务完成时弹出系统通知">
                  <Switch checked={notifications} onChange={setNotifications} label={notifications ? '已开启' : '已关闭'} />
                </Field>
                <Field label="提示音" hint="完成任务时播放音效">
                  <Switch checked={sounds} onChange={setSounds} label={sounds ? '已开启' : '已关闭'} />
                </Field>
                <Field label="紧凑模式" hint="缩小面板间距,显示更多内容">
                  <Switch checked={compactMode} onChange={setCompactMode} label={compactMode ? '已开启' : '已关闭'} />
                </Field>
                <Field label="开发者模式" hint="显示调试信息和高级选项">
                  <Switch checked={developerMode} onChange={setDeveloperMode} label={developerMode ? '已开启' : '已关闭'} />
                </Field>
              </>
            )}

            {/* 主题 */}
            {tab === 'theme' && (
              <>
                <p className="text-xs text-text-secondary">
                  选择主题后立即生效,无需刷新页面。
                </p>
                <div className="grid grid-cols-2 gap-3">
                  {themeList.map(t => (
                    <button
                      key={t.id}
                      onClick={() => setTheme(t.id)}
                      className={`p-3 rounded-xl border-2 text-left transition-all ${
                        current.id === t.id
                          ? 'border-primary bg-primary/5'
                          : 'border-border bg-bg-dim hover:border-primary/50'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex gap-0.5">
                          <div className="w-3 h-8 rounded-sm" style={{ backgroundColor: t.tokens.primary }} />
                          <div className="w-3 h-8 rounded-sm" style={{ backgroundColor: t.tokens.surface }} />
                          <div className="w-3 h-8 rounded-sm" style={{ backgroundColor: t.tokens.bg }} />
                          <div className="w-3 h-8 rounded-sm" style={{ backgroundColor: t.tokens.accent }} />
                        </div>
                        {current.id === t.id && <Badge variant="primary" dot>使用中</Badge>}
                      </div>
                      <div className="text-sm font-semibold text-text">{t.name}</div>
                      <div className="text-[10px] text-text-secondary font-mono mt-0.5">{t.id}</div>
                    </button>
                  ))}
                </div>
                <div className="h-px bg-border" />
                <div className="p-3 rounded-lg border border-primary/30 bg-primary/5 flex items-start gap-3">
                  <span className="material-symbols-outlined text-primary text-2xl">palette</span>
                  <div className="flex-1">
                    <div className="text-sm font-semibold text-text">实时调色板</div>
                    <div className="text-[10px] text-text-secondary mt-0.5">
                      逐 token 微调主色 / 表面 / 状态颜色,改动自动持久化。
                    </div>
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    icon="tune"
                    onClick={onOpenThemeEditor}
                  >
                    打开编辑器
                  </Button>
                </div>
              </>
            )}

            {/* AI 模型 */}
            {tab === 'ai' && (
              <>
                <Field label="主模型" hint="生成主要回复">
                  <ModelSelect
                    value={primaryModel}
                    onChange={setPrimaryModel}
                    models={MODELS}
                  />
                </Field>
                <Field label="混合模式" hint="使用主模型 + 副模型交叉验证">
                  <Switch checked={hybrid} onChange={setHybrid} label={hybrid ? '已开启' : '已关闭'} />
                </Field>
                {hybrid && (
                  <Field label="副模型" hint="用于评估 / 投票">
                    <ModelSelect
                      value={secondaryModel}
                      onChange={setSecondaryModel}
                      models={MODELS}
                    />
                  </Field>
                )}
                <Field label="温度 (Temperature)" hint={`当前: ${temperature.toFixed(2)} · 越高越发散`}>
                  <input
                    type="range"
                    min="0" max="2" step="0.05"
                    value={temperature}
                    onChange={e => setTemperature(parseFloat(e.target.value))}
                    className="w-48 accent-primary"
                  />
                </Field>
                <Field label="最大 Token" hint="单次响应上限">
                  <input
                    type="number"
                    value={maxTokens}
                    min={256} max={32768} step={256}
                    onChange={e => setMaxTokens(parseInt(e.target.value) || 4096)}
                    className="w-32 bg-bg-dim border border-border rounded-md px-3 py-1.5 text-sm text-text font-mono focus:outline-none focus:border-primary"
                  />
                </Field>
                <Field label="提示词模板" hint={`${prompts.length} 个模板 · ${prompts.filter(p => !p.builtin).length} 自定义 · 自动持久化`}>
                  <div className="border border-border-light rounded-lg overflow-hidden bg-bg-dim">
                    {/* 模板切换 tabs */}
                    <div className="flex items-center gap-0.5 px-1 py-1 border-b border-border-light bg-surface-low overflow-x-auto scrollbar-thin">
                      {prompts.map(p => (
                        <button
                          key={p.id}
                          onClick={() => setActivePromptId(p.id)}
                          className={`shrink-0 flex items-center gap-1 px-2 h-6 rounded text-[10px] transition-colors ${
                            activePromptId === p.id
                              ? 'bg-primary text-on-primary'
                              : 'text-text-secondary hover:text-text hover:bg-surface-high'
                          }`}
                        >
                          {p.builtin && <span className="material-symbols-outlined text-[10px]">lock</span>}
                          <span className="font-medium">{p.name}</span>
                          {!p.builtin && (
                            <span
                              role="button"
                              onClick={(e) => { e.stopPropagation(); deletePrompt(p.id); }}
                              className="material-symbols-outlined text-[10px] opacity-60 hover:opacity-100 hover:text-danger"
                            >close</span>
                          )}
                        </button>
                      ))}
                      <button
                        onClick={addPrompt}
                        className="shrink-0 flex items-center gap-0.5 px-1.5 h-6 rounded text-[10px] text-primary hover:bg-primary/10 border border-dashed border-primary/40"
                        title="新建自定义模板"
                      >
                        <span className="material-symbols-outlined text-xs">add</span>
                      </button>
                    </div>
                    {/* 当前模板内容 */}
                    {activePrompt && (
                      <div className="p-2 space-y-1.5">
                        <div className="flex items-center gap-2">
                          <input
                            value={activePrompt.name}
                            disabled={activePrompt.builtin}
                            onChange={e => setPrompts(prev => prev.map(p => p.id === activePrompt.id ? { ...p, name: e.target.value } : p))}
                            className="flex-1 bg-transparent text-xs font-semibold text-text focus:outline-none disabled:opacity-70"
                          />
                          <span className="text-[9px] text-text-secondary/70 font-mono">
                            {activePrompt.content.length} 字符
                          </span>
                          {activePrompt.builtin && (
                            <button
                              onClick={() => resetPrompt(activePrompt.id)}
                              className="text-[10px] text-text-secondary hover:text-primary flex items-center gap-0.5"
                              title="恢复内置默认内容"
                            >
                              <span className="material-symbols-outlined text-[10px]">restart_alt</span>
                              恢复
                            </button>
                          )}
                        </div>
                        <textarea
                          value={activePrompt.content}
                          onChange={e => updatePrompt(activePrompt.id, e.target.value)}
                          rows={5}
                          placeholder="输入提示词内容,支持换行..."
                          className="w-full bg-surface border border-border-light rounded-md px-2 py-1.5 text-[11px] text-text font-mono resize-y focus:outline-none focus:border-primary leading-relaxed"
                        />
                        <div className="flex items-center justify-between text-[9px] text-text-secondary/70 font-mono">
                          <span className="flex items-center gap-1.5">
                            <span className="material-symbols-outlined text-[10px] text-success">cloud_done</span>
                            已自动保存到 localStorage
                          </span>
                          {activePrompt.builtin && (
                            <span className="flex items-center gap-0.5 text-accent">
                              <span className="material-symbols-outlined text-[10px]">lock</span>
                              内置模板 (不可删除)
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </Field>
              </>
            )}

            {/* 记忆 */}
            {tab === 'memory' && (
              <>
                <div className="p-3 rounded-lg bg-primary/5 border border-primary/20 flex items-start gap-2">
                  <span className="material-symbols-outlined text-primary text-sm">info</span>
                  <div className="text-[11px] text-text-secondary">
                    SoloForge 使用向量 + 关键词混合检索,从长期记忆中召回相关上下文。
                  </div>
                </div>
                <Field label="记忆容量" hint="最多保留的对话轮次">
                  <div className="flex items-center gap-2">
                    <input
                      type="range" min={128} max={8192} step={128}
                      value={memoryCapacity}
                      onChange={e => setMemoryCapacity(parseInt(e.target.value))}
                      className="w-48 accent-primary"
                    />
                    <span className="text-xs font-mono text-text tabular-nums w-16 text-right">{memoryCapacity}</span>
                  </div>
                </Field>
                <Field label="召回 Top-K" hint="每次查询返回的记忆条数">
                  <div className="flex items-center gap-2">
                    <input
                      type="range" min={1} max={32} step={1}
                      value={memoryRecall}
                      onChange={e => setMemoryRecall(parseInt(e.target.value))}
                      className="w-48 accent-primary"
                    />
                    <span className="text-xs font-mono text-text tabular-nums w-8 text-right">{memoryRecall}</span>
                  </div>
                </Field>
                <Field label="记忆衰减 (天)" hint="超过该天数会被压缩归档">
                  <div className="flex items-center gap-2">
                    <input
                      type="range" min={1} max={180} step={1}
                      value={memoryDecay}
                      onChange={e => setMemoryDecay(parseInt(e.target.value))}
                      className="w-48 accent-primary"
                    />
                    <span className="text-xs font-mono text-text tabular-nums w-12 text-right">{memoryDecay} 天</span>
                  </div>
                </Field>
                <Field label="记忆类型">
                  <div className="flex flex-wrap gap-1">
                    {['对话', '代码', '决策', '训练', '法庭', '错误'].map(t => (
                      <Badge key={t} variant="primary">{t}</Badge>
                    ))}
                  </div>
                </Field>
              </>
            )}

            {/* 数据备份 */}
            {tab === 'data' && (
              <>
                <div className="p-3 rounded-lg bg-primary/5 border border-primary/20 flex items-start gap-2">
                  <span className="material-symbols-outlined text-primary text-sm">info</span>
                  <div className="text-[11px] text-text-secondary">
                    全量备份会扫描所有 <code className="font-mono text-text">soloforge.*</code> 命名的 localStorage 项,包括会话/设置/提示词/主题/历史/收藏/布局/活动栏顺序等。
                    导出的 JSON 可在任意设备/浏览器上导入恢复。
                  </div>
                </div>

                <Field label="备份范围" hint={`预计 ${(backupSize / 1024).toFixed(1)} KB · 勾选要包含的类别`}>
                  <div className="grid grid-cols-3 gap-1.5">
                    {[
                      { id: 'sessions', label: '对话会话', icon: 'forum' },
                      { id: 'settings', label: 'AI 设置',  icon: 'tune' },
                      { id: 'prompts',  label: '提示词',    icon: 'model_training' },
                      { id: 'theme',    label: '主题',      icon: 'palette' },
                      { id: 'history',  label: '历史/提示', icon: 'history' },
                      { id: 'favorites',label: '收藏/顺序', icon: 'star' },
                      { id: 'layout',   label: '布局',      icon: 'view_column' },
                      { id: 'order',    label: '导航顺序',  icon: 'sort' },
                      { id: 'custom',   label: '自定义主题',icon: 'edit' },
                    ].map(s => (
                      <label
                        key={s.id}
                        className={`flex items-center gap-1.5 px-2 h-7 rounded border cursor-pointer transition-colors ${
                          backupScope[s.id]
                            ? 'bg-primary/10 border-primary/40 text-text'
                            : 'bg-bg-dim border-border-light text-text-secondary hover:text-text'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={!!backupScope[s.id]}
                          onChange={e => setBackupScope(p => ({ ...p, [s.id]: e.target.checked }))}
                          className="accent-primary"
                        />
                        <span className="material-symbols-outlined text-xs">{s.icon}</span>
                        <span className="text-[10px] font-medium">{s.label}</span>
                      </label>
                    ))}
                  </div>
                </Field>

                <Field label="导出" hint="下载或复制到剪贴板">
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" variant="primary" icon="download" onClick={() => handleFullExport(true)}>
                      下载 .json
                    </Button>
                    <Button size="sm" variant="ghost" icon="content_copy" onClick={() => handleFullExport(false)}>
                      复制 JSON
                    </Button>
                    <Button size="sm" variant="ghost" icon="select_all" onClick={() => setBackupScope({ sessions: true, settings: true, prompts: true, theme: true, history: true, favorites: true, layout: true, order: true, custom: true })}>
                      全选
                    </Button>
                    <Button size="sm" variant="ghost" icon="deselect" onClick={() => setBackupScope({})}>
                      全不选
                    </Button>
                  </div>
                </Field>

                <Field label="导入" hint="选择 .json 全量备份文件恢复">
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" variant="outline" icon="upload_file" onClick={() => fileInputRef.current?.click()}>
                      选择文件
                    </Button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".json,application/json"
                      hidden
                      onChange={e => {
                        const f = e.target.files?.[0];
                        if (f) handleFullImport(f);
                        e.target.value = '';
                      }}
                    />
                    <span className="text-[10px] text-text-secondary">仅识别 <code className="font-mono">__type: soloforge-fullbackup</code> 文件</span>
                  </div>
                </Field>

                <Field label="危险操作" hint="清空后刷新页面生效">
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" variant="outline" icon="delete_forever" onClick={handleClearAll} className="text-danger border-danger/40 hover:bg-danger/10">
                      清空所有本地数据
                    </Button>
                    <span className="text-[10px] text-text-secondary/70">建议先备份再操作,不可恢复</span>
                  </div>
                </Field>

                {backupResult && (
                  <div className={`p-2.5 rounded-lg flex items-start gap-2 text-xs animate-slide-in-up ${
                    backupResult.ok
                      ? 'bg-success/10 border border-success/30 text-success'
                      : 'bg-danger/10 border border-danger/30 text-danger'
                  }`}>
                    <span className="material-symbols-outlined text-sm">
                      {backupResult.ok ? 'check_circle' : 'error'}
                    </span>
                    <span>{backupResult.msg}</span>
                  </div>
                )}
              </>
            )}

            {/* 后端 */}
            {tab === 'backend' && (
              <>
                <Field label="API 地址">
                  <div className="flex items-center gap-2">
                    <input
                      value={apiBase}
                      readOnly
                      className="flex-1 bg-bg-dim border border-border rounded-md px-3 py-1.5 text-sm text-text font-mono focus:outline-none"
                    />
                    <Button variant="outline" size="sm" icon="content_copy">复制</Button>
                  </div>
                </Field>
                <Field label="连接状态">
                  <Badge variant={connected ? 'success' : 'danger'} dot>
                    {connected ? '已连接' : '未连接'}
                  </Badge>
                </Field>
                <Field label="最后更新" hint="自动刷新触发">
                  <div className="font-mono text-sm text-text">{lastUpdate}</div>
                </Field>
                <Field label="前端端口">
                  <div className="font-mono text-sm text-text">{window.location.port || '5173'}</div>
                </Field>
                <Field label="浏览器">
                  <div className="text-xs text-text-secondary font-mono truncate">{navigator.userAgent}</div>
                </Field>
              </>
            )}

            {/* 扩展 */}
            {tab === 'ext' && (
              <>
                <p className="text-xs text-text-secondary">
                  SoloForge 支持安装社区技能与插件。
                </p>
                {[
                  { id: 'web-search', icon: 'travel_explore', name: '网络搜索', desc: 'Exa / Tavily / Brave 检索', enabled: true },
                  { id: 'code-exec',  icon: 'terminal',       name: '代码执行', desc: '沙箱运行 Python / Node',   enabled: true },
                  { id: 'git-ops',    icon: 'account_tree',   name: 'Git 操作', desc: '自动 commit / PR',          enabled: false },
                  { id: 'marl-viz',   icon: 'monitoring',     name: 'MARL 可视化', desc: '训练曲线 / 策略热力图',  enabled: true },
                  { id: 'db-inspect', icon: 'database',       name: '数据库探针', desc: 'SurrealDB 实时查询',        enabled: true },
                ].map(p => (
                  <div key={p.id} className="flex items-center gap-3 p-2.5 rounded-lg border border-border-light bg-bg-dim">
                    <span className="material-symbols-outlined text-primary text-lg">{p.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-text">{p.name}</div>
                      <div className="text-[10px] text-text-secondary">{p.desc}</div>
                    </div>
                    <Switch checked={p.enabled} onChange={() => {}} label={p.enabled ? '已启用' : '已停用'} />
                  </div>
                ))}
              </>
            )}

            {/* 快捷键 */}
            {tab === 'shortcut' && (
              <KeybindingEditor />
            )}

            {/* 关于 */}
            {tab === 'about' && (
              <div className="space-y-4">
                <div className="text-center py-4">
                  <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-accent mb-3">
                    <span className="material-symbols-outlined filled text-white" style={{ fontSize: 32 }}>token</span>
                  </div>
                  <div className="text-lg font-display font-bold text-text">SoloForge</div>
                  <div className="text-xs text-text-secondary">分布式 MARL 智能体治理 OS</div>
                </div>
                <Field label="版本"><span className="font-mono text-sm text-text">v1.0.0</span></Field>
                <Field label="构建"><span className="font-mono text-sm text-text">#4208-stable · 2026-06-03</span></Field>
                <Field label="协议"><Badge variant="success">MIT</Badge></Field>
                <div className="h-px bg-border" />
                <div>
                  <div className="text-[10px] text-text-secondary uppercase tracking-wider mb-2">技术栈</div>
                  <div className="grid grid-cols-2 gap-1.5 text-xs">
                    <div className="p-2 bg-bg-dim rounded">TypeScript 5.5</div>
                    <div className="p-2 bg-bg-dim rounded">React 18.3</div>
                    <div className="p-2 bg-bg-dim rounded">Vite 5.4</div>
                    <div className="p-2 bg-bg-dim rounded">Tailwind 3</div>
                    <div className="p-2 bg-bg-dim rounded">SurrealDB 3</div>
                    <div className="p-2 bg-bg-dim rounded">Rust 1.85</div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between px-5 h-12 border-t border-border bg-surface-low">
            <div className="flex items-center gap-2">
              <Button
                variant="danger"
                size="sm"
                icon="delete_sweep"
                onClick={() => { if (confirm('清空所有对话历史?')) onClearHistory(); }}
              >
                清空对话历史
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon="restart_alt"
                onClick={() => { if (confirm('重置全部设置为默认值?')) { /* reset */ } }}
              >
                恢复默认
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-text-secondary mr-2 font-mono">
                {activeIdx + 1} / {SECTIONS.length}
              </span>
              <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
              <Button variant="primary" size="sm" icon="check" onClick={onClose}>完成</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text">{label}</div>
        {hint && <div className="text-[10px] text-text-secondary mt-0.5">{hint}</div>}
      </div>
      <div className="shrink-0 min-w-[200px] flex items-center justify-end">
        {children}
      </div>
    </div>
  );
}

function ModelSelect({ value, onChange, models }: {
  value: string;
  onChange: (v: string) => void;
  models: typeof MODELS;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="w-full bg-bg-dim border border-border rounded-md px-3 py-1.5 text-sm text-text font-mono focus:outline-none focus:border-primary"
    >
      {models.map(m => (
        <option key={m.id} value={m.id}>
          {m.label} · {m.provider} · {m.tag}
        </option>
      ))}
    </select>
  );
}
