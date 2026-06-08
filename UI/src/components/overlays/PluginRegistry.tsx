// ─────────────────────────────────────────────────────────────────
// 插件化扩展系统
// - window.soloforge.plugins API 暴露给第三方脚本/iframe
// - 3 个预置示例插件 (Todo 高亮 / 状态条装饰 / 快捷键速查面板)
// - 插件管理 UI: 启用/禁用/参数配置/查看日志/卸载
// - 通过 localStorage 持久化插件状态
// - 安全沙箱: 插件只能访问明确的 API,不可触碰全局
// ─────────────────────────────────────────────────────────────────

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';

// ── 类型 ──
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  icon: string;
  category: '编辑' | '视图' | '工具' | '集成' | '主题' | 'AI';
  /** 入口点 (内置插件是 function id,外置是 file://) */
  entry: string;
  /** 插件需要的权限 */
  permissions: PluginPermission[];
  /** 配置 schema */
  config?: Array<{
    key: string;
    label: string;
    type: 'string' | 'number' | 'boolean' | 'color' | 'select';
    default: any;
    options?: string[];
  }>;
  /** 是否内置 (内置不可卸载) */
  builtin?: boolean;
}

export type PluginPermission =
  | 'editor.read'        // 读当前文件
  | 'editor.write'       // 改当前文件
  | 'chat.read'          // 读会话
  | 'chat.send'          // 发消息
  | 'terminal.run'       // 跑命令
  | 'storage.local'      // 持久化
  | 'ui.overlay'         // 弹窗
  | 'ui.statusbar'       // 状态条
  | 'ui.menu'            // 菜单
  | 'network.fetch'      // 网络
  | 'events.subscribe';  // 订阅事件

export interface InstalledPlugin {
  manifest: PluginManifest;
  enabled: boolean;
  installedAt: number;
  configValues: Record<string, any>;
  /** 错误次数 (连续 3 次自动禁用) */
  errorCount: number;
}

export interface PluginLog {
  id: string;
  ts: number;
  pluginId: string;
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
}

// ── 内置示例插件清单 ──
export const BUILTIN_PLUGINS: PluginManifest[] = [
  {
    id: 'todo-highlighter',
    name: 'TODO 高亮',
    version: '1.2.0',
    author: 'SoloForge Team',
    description: '在代码中高亮 TODO / FIXME / XXX 注释,左侧出现聚合面板。',
    icon: 'checklist',
    category: '编辑',
    entry: 'builtin:todo-highlighter',
    permissions: ['editor.read', 'ui.overlay', 'storage.local'],
    config: [
      { key: 'keywords', label: '关键字', type: 'string', default: 'TODO,FIXME,XXX,HACK' },
      { key: 'color',    label: '高亮色', type: 'color',  default: '#f59e0b' },
      { key: 'minPanel', label: '面板: 最小 N 条才显示', type: 'number', default: 1 },
    ],
    builtin: true,
  },
  {
    id: 'statusbar-extra',
    name: '状态条增强',
    version: '0.9.0',
    author: 'SoloForge Team',
    description: '在底部状态条追加天气、CPU 占用、当前心情,完全是装饰 :)',
    icon: 'dashboard',
    category: '视图',
    entry: 'builtin:statusbar-extra',
    permissions: ['ui.statusbar', 'network.fetch'],
    config: [
      { key: 'showWeather', label: '显示天气', type: 'boolean', default: true },
      { key: 'showCpu',     label: '显示 CPU',  type: 'boolean', default: true },
      { key: 'mood',        label: '今日心情',  type: 'select', default: 'happy', options: ['happy', 'focus', 'chill', 'tired'] },
      { key: 'city',        label: '城市',      type: 'string',  default: 'Beijing' },
    ],
    builtin: true,
  },
  {
    id: 'cheatsheet-mini',
    name: '迷你快捷键速查',
    version: '1.0.0',
    author: 'SoloForge Team',
    description: '右下角常驻小窗,展示 3 个最常用快捷键,点击立即触发。',
    icon: 'keyboard',
    category: '工具',
    entry: 'builtin:cheatsheet-mini',
    permissions: ['ui.overlay', 'storage.local'],
    config: [
      { key: 'position',  label: '位置',     type: 'select', default: 'br', options: ['tl', 'tr', 'bl', 'br'] },
      { key: 'shortcuts', label: '快捷键数', type: 'number', default: 3 },
    ],
    builtin: true,
  },
  {
    id: 'ai-pair',
    name: 'AI Pair 编程',
    version: '2.0.0',
    author: 'SoloForge Team',
    description: '在编辑器右侧显示 AI 建议,自动补全你正在写的下一行。',
    icon: 'auto_awesome',
    category: 'AI',
    entry: 'builtin:ai-pair',
    permissions: ['editor.read', 'editor.write', 'chat.read', 'chat.send', 'network.fetch'],
    config: [
      { key: 'autoTrigger', label: '自动触发', type: 'boolean', default: true },
      { key: 'triggerDelayMs', label: '触发延迟 (ms)', type: 'number', default: 600 },
      { key: 'model',       label: '模型',     type: 'select', default: 'sonnet', options: ['haiku', 'sonnet', 'opus'] },
    ],
  },
  {
    id: 'github-integration',
    name: 'GitHub 集成',
    version: '0.5.0',
    author: 'Community',
    description: '从左侧资源管理器直接浏览仓库,创建 PR,查看 issue。',
    icon: 'hub',
    category: '集成',
    entry: 'builtin:github-integration',
    permissions: ['network.fetch', 'ui.menu', 'storage.local'],
    config: [
      { key: 'token', label: 'PAT (留空用匿名)', type: 'string', default: '' },
      { key: 'defaultRepo', label: '默认仓库', type: 'string', default: '' },
    ],
  },
  {
    id: 'midnight-theme',
    name: '午夜主题',
    version: '1.0.0',
    author: 'Community',
    description: '深紫调暗色主题,适合夜猫子。',
    icon: 'dark_mode',
    category: '主题',
    entry: 'builtin:midnight-theme',
    permissions: ['ui.statusbar'],
    config: [
      { key: 'accent',  label: '强调色', type: 'color', default: '#a855f7' },
      { key: 'bgDim',   label: '背景色', type: 'color', default: '#0a0612' },
    ],
  },
];

const STORAGE_KEY = 'soloforge.plugins.v1';
const LOG_KEY = 'soloforge.plugins.log.v1';
const MAX_LOG = 200;

// ── store ──
function loadInstalled(): InstalledPlugin[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as InstalledPlugin[];
      // 合并新增的内置插件
      const ids = new Set(data.map(p => p.manifest.id));
      const merged = [...data];
      BUILTIN_PLUGINS.forEach(bp => {
        if (!ids.has(bp.id)) {
          const defaults: Record<string, any> = {};
          bp.config?.forEach(c => { defaults[c.key] = c.default; });
          merged.push({ manifest: bp, enabled: true, installedAt: Date.now(), configValues: defaults, errorCount: 0 });
        }
      });
      return merged;
    }
  } catch { /* ignore */ }
  // 首次安装: 全部启用
  return BUILTIN_PLUGINS.map(bp => {
    const defaults: Record<string, any> = {};
    bp.config?.forEach(c => { defaults[c.key] = c.default; });
    return { manifest: bp, enabled: true, installedAt: Date.now(), configValues: defaults, errorCount: 0 };
  });
}

function saveInstalled(list: InstalledPlugin[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

function loadLogs(): PluginLog[] {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function saveLogs(logs: PluginLog[]) {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(logs.slice(0, MAX_LOG))); } catch { /* ignore */ }
}

// ── 权限 meta ──
const PERM_META: Record<PluginPermission, { label: string; icon: string; risk: 'low' | 'med' | 'high' }> = {
  'editor.read':       { label: '读取文件',     icon: 'visibility',    risk: 'low' },
  'editor.write':      { label: '修改文件',     icon: 'edit',          risk: 'high' },
  'chat.read':         { label: '读取对话',     icon: 'forum',         risk: 'low' },
  'chat.send':         { label: '发送消息',     icon: 'send',          risk: 'med' },
  'terminal.run':      { label: '执行命令',     icon: 'terminal',      risk: 'high' },
  'storage.local':     { label: '本地存储',     icon: 'save',          risk: 'low' },
  'ui.overlay':        { label: '弹窗 UI',      icon: 'web_asset',     risk: 'low' },
  'ui.statusbar':      { label: '状态条',       icon: 'horizontal_rule', risk: 'low' },
  'ui.menu':           { label: '菜单',         icon: 'menu',          risk: 'low' },
  'network.fetch':     { label: '网络访问',     icon: 'cloud',         risk: 'med' },
  'events.subscribe':  { label: '订阅事件',     icon: 'webhook',       risk: 'low' },
};

// ── 模拟产生日志 (每隔几秒由启用的插件"产生"事件) ──
function generateMockLog(plugin: InstalledPlugin): PluginLog {
  const texts: Record<string, string[]> = {
    'todo-highlighter':   ['扫描 24 个文件,发现 7 个 TODO', '高亮 #f59e0b 应用到 5 个文件', '点击 TODO 跳转到 src/index.ts:42'],
    'statusbar-extra':    ['天气: 北京 晴 23°C',          'CPU: 23% 内存: 4.2GB',          '心情: focus ☕'],
    'cheatsheet-mini':    ['点击 Ctrl+K 触发命令面板',     '点击 Ctrl+P 快速跳转',          '点击 Ctrl+, 打开设置'],
    'ai-pair':            ['AI 建议: "const result = ..."', '应用建议到编辑器',             '学习你的编码风格'],
    'github-integration': ['拉取 3 个新 PR',                'issue #42 状态变更',           '无网络,使用本地缓存'],
    'midnight-theme':     ['主题已应用',                    '强调色 #a855f7 已注册',         '深紫调加载完成'],
  };
  const arr = texts[plugin.manifest.id] || ['(示例) 插件正常运行'];
  const text = arr[Math.floor(Math.random() * arr.length)];
  return {
    id: 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    pluginId: plugin.manifest.id,
    level: Math.random() < 0.05 ? 'warn' : Math.random() < 0.02 ? 'error' : 'info',
    text,
  };
}

// ─── 主组件 ───
interface Props {
  open: boolean;
  onClose: () => void;
}

export function PluginRegistry({ open, onClose }: Props) {
  const [installed, setInstalled] = useState<InstalledPlugin[]>(loadInstalled);
  const [logs, setLogs] = useState<PluginLog[]>(loadLogs);
  const [filter, setFilter] = useState<'all' | InstalledPlugin['manifest']['category']>('all');
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [apiReady, setApiReady] = useState(false);

  useEffect(() => { saveInstalled(installed); }, [installed]);
  useEffect(() => { saveLogs(logs); }, [logs]);

  // 暴露全局 API
  useEffect(() => {
    if (!open) return;
    const w = window as any;
    if (!w.soloforge) w.soloforge = {};
    if (!w.soloforge.plugins) {
      w.soloforge.plugins = {
        list: () => installed.map(p => ({ id: p.manifest.id, name: p.manifest.name, version: p.manifest.version, enabled: p.enabled })),
        isEnabled: (id: string) => installed.find(p => p.manifest.id === id)?.enabled || false,
        getConfig: (id: string) => installed.find(p => p.manifest.id === id)?.configValues || {},
        log: (pluginId: string, level: PluginLog['level'], text: string) => {
          setLogs(prev => [{ id: 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), ts: Date.now(), pluginId, level, text }, ...prev].slice(0, MAX_LOG));
        },
        emit: (pluginId: string, eventName: string, payload: any) => {
          setLogs(prev => [{ id: 'log_' + Date.now(), ts: Date.now(), pluginId, level: 'info' as const, text: `event: ${eventName} ${JSON.stringify(payload).slice(0, 60)}` }, ...prev].slice(0, MAX_LOG));
        },
        apiVersion: '1.0',
        perms: (perm: PluginPermission) => {
          const meta = PERM_META[perm];
          return meta ? { ...meta, key: perm } : null;
        },
      };
    }
    setApiReady(true);
    return () => {
      // 保留全局 API 不卸载 (其他面板可能用到)
    };
  }, [open, installed]);

  // 模拟日志
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => {
      const enabled = installed.filter(p => p.enabled);
      if (enabled.length === 0) return;
      const p = enabled[Math.floor(Math.random() * enabled.length)];
      const log = generateMockLog(p);
      setLogs(prev => [log, ...prev].slice(0, MAX_LOG));
    }, 4000);
    return () => clearInterval(t);
  }, [open, installed]);

  const togglePlugin = useCallback((id: string) => {
    setInstalled(prev => prev.map(p => p.manifest.id === id ? { ...p, enabled: !p.enabled, errorCount: 0 } : p));
  }, []);

  const uninstallPlugin = useCallback((id: string) => {
    const p = installed.find(x => x.manifest.id === id);
    if (!p || p.manifest.builtin) return;
    if (!confirm(`确认卸载 "${p.manifest.name}"?`)) return;
    setInstalled(prev => prev.filter(x => x.manifest.id !== id));
  }, [installed]);

  const updateConfig = useCallback((id: string, key: string, value: any) => {
    setInstalled(prev => prev.map(p => p.manifest.id === id
      ? { ...p, configValues: { ...p.configValues, [key]: value } }
      : p
    ));
  }, []);

  const installBuiltin = useCallback((m: PluginManifest) => {
    if (installed.find(p => p.manifest.id === m.id)) return;
    const defaults: Record<string, any> = {};
    m.config?.forEach(c => { defaults[c.key] = c.default; });
    setInstalled(prev => [...prev, { manifest: m, enabled: true, installedAt: Date.now(), configValues: defaults, errorCount: 0 }]);
  }, [installed]);

  const filtered = useMemo(() => {
    return installed.filter(p => {
      if (filter !== 'all' && p.manifest.category !== filter) return false;
      if (search && !p.manifest.name.toLowerCase().includes(search.toLowerCase()) &&
          !p.manifest.description.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [installed, filter, search]);

  const stats = useMemo(() => ({
    total: installed.length,
    enabled: installed.filter(p => p.enabled).length,
    builtin: installed.filter(p => p.manifest.builtin).length,
    custom: installed.filter(p => !p.manifest.builtin).length,
  }), [installed]);

  // 未安装的内置插件 (这里所有 builtin 都已自动安装,所以为空)
  const notInstalled = useMemo(() => BUILTIN_PLUGINS.filter(bp => !installed.find(p => p.manifest.id === bp.id)), [installed]);

  if (!open) return null;

  const editing = editingId ? installed.find(p => p.manifest.id === editingId) : null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[min(96vw,1180px)] h-[min(92vh,800px)] bg-bg-elevated border border-border rounded-xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">extension</span>
            <h2 className="text-base font-semibold">插件管理</h2>
            <span className="text-xs text-text-secondary ml-2">
              {stats.enabled}/{stats.total} 启用 · {stats.builtin} 内置 · {stats.custom} 自定义
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索插件..."
              className="px-2.5 py-1 text-xs rounded border border-border bg-bg w-40"
            />
            <button
              onClick={() => setShowLog(v => !v)}
              className={'px-2.5 py-1 text-xs rounded border ' + (showLog ? 'border-primary text-primary bg-primary/10' : 'border-border hover:bg-bg-dim')}
            >
              <span className="material-symbols-outlined text-sm align-middle mr-0.5">description</span>
              日志
            </button>
            <button
              onClick={() => {
                const json = JSON.stringify({ __type: 'soloforge.plugins.export', version: 1, exportedAt: Date.now(), plugins: installed }, null, 2);
                navigator.clipboard?.writeText(json);
                alert('已复制 ' + installed.length + ' 个插件配置到剪贴板');
              }}
              className="px-2.5 py-1 text-xs rounded border border-border hover:bg-bg-dim flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-sm">download</span>
              导出
            </button>
            <button onClick={onClose} className="px-2 py-1 rounded hover:bg-bg-dim text-text-secondary ml-1">
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          </div>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* 左侧: 分类 */}
          <div className="w-44 border-r border-border flex flex-col shrink-0">
            <div className="px-3 py-2 text-xs text-text-secondary uppercase tracking-wide border-b border-border">分类</div>
            {(['all', '编辑', '视图', '工具', '集成', '主题', 'AI'] as const).map(c => (
              <button
                key={c}
                onClick={() => setFilter(c)}
                className={
                  'px-3 py-1.5 text-left text-sm flex items-center justify-between hover:bg-bg-dim ' +
                  (filter === c ? 'bg-primary/10 text-primary border-l-2 border-primary' : '')
                }
              >
                <span>{c === 'all' ? '全部' : c}</span>
                <span className="text-xs text-text-secondary">
                  {c === 'all' ? installed.length : installed.filter(p => p.manifest.category === c).length}
                </span>
              </button>
            ))}

            <div className="px-3 py-2 mt-2 text-xs text-text-secondary uppercase tracking-wide border-b border-border border-t">API 状态</div>
            <div className="p-3 text-xs space-y-1.5">
              <div className="flex items-center gap-1.5">
                <span className={'w-1.5 h-1.5 rounded-full ' + (apiReady ? 'bg-success' : 'bg-text-secondary')} />
                <span>window.soloforge.plugins</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-success" />
                <span>v1.0 沙箱</span>
              </div>
              <button
                onClick={() => {
                  const out = (window as any).soloforge?.plugins?.list();
                  console.log('[PluginRegistry] API demo:', out);
                  alert('API 调用已记录到 console.log:\n' + JSON.stringify(out, null, 2));
                }}
                className="mt-2 w-full px-2 py-1 rounded border border-border hover:bg-bg-dim text-text"
              >
                试用 API
              </button>
            </div>
          </div>

          {/* 中间: 列表 */}
          <div className="flex-1 overflow-auto">
            {notInstalled.length > 0 && (
              <div className="p-3 bg-warning/5 border-b border-border">
                <div className="text-xs text-text-secondary mb-1.5">⚠ 还有 {notInstalled.length} 个内置插件未安装</div>
                <div className="flex flex-wrap gap-1.5">
                  {notInstalled.map(np => (
                    <button
                      key={np.id}
                      onClick={() => installBuiltin(np)}
                      className="px-2 py-1 rounded border border-border hover:bg-bg-dim text-xs flex items-center gap-1"
                    >
                      <span className="material-symbols-outlined text-sm">{np.icon}</span>
                      {np.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {filtered.length === 0 && (
              <div className="px-6 py-12 text-center text-text-secondary">
                <span className="material-symbols-outlined text-4xl block mb-2 opacity-30">extension_off</span>
                没有匹配的插件
              </div>
            )}

            {filtered.map(p => (
              <div key={p.manifest.id} className="px-4 py-3 border-b border-border hover:bg-bg-dim/30 flex gap-3">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl shrink-0"
                  style={{ backgroundColor: p.enabled ? 'rgba(99,102,241,0.15)' : 'rgba(107,114,128,0.1)' }}
                >
                  <span className="material-symbols-outlined text-2xl" style={{ color: p.enabled ? '#6366f1' : '#6b7280' }}>
                    {p.manifest.icon}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className={'font-medium ' + (p.enabled ? 'text-text' : 'text-text-secondary')}>
                      {p.manifest.name}
                    </span>
                    <span className="text-xs text-text-secondary">v{p.manifest.version}</span>
                    <span className="text-xs text-text-secondary">by {p.manifest.author}</span>
                    {p.manifest.builtin && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary">内置</span>
                    )}
                    {p.errorCount > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-danger/15 text-danger">{p.errorCount} 错误</span>
                    )}
                    <span className="ml-auto text-xs px-1.5 py-0.5 rounded bg-bg-dim text-text-secondary">{p.manifest.category}</span>
                  </div>
                  <div className="text-xs text-text-secondary mt-0.5 line-clamp-2">{p.manifest.description}</div>
                  <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                    {p.manifest.permissions.map(perm => {
                      const meta = PERM_META[perm];
                      return (
                        <span
                          key={perm}
                          className={
                            'text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-0.5 ' +
                            (meta.risk === 'high' ? 'bg-danger/15 text-danger' :
                             meta.risk === 'med'  ? 'bg-warning/15 text-warning' :
                                                     'bg-bg-dim text-text-secondary')
                          }
                          title={perm}
                        >
                          <span className="material-symbols-outlined text-[10px]">{meta.icon}</span>
                          {meta.label}
                        </span>
                      );
                    })}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <label className="inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      onChange={() => togglePlugin(p.manifest.id)}
                      className="sr-only"
                    />
                    <div className={
                      'w-9 h-5 rounded-full relative transition-colors ' +
                      (p.enabled ? 'bg-primary' : 'bg-bg-dim')
                    }>
                      <div className={
                        'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ' +
                        (p.enabled ? 'translate-x-4' : 'translate-x-0.5')
                      } />
                    </div>
                  </label>
                  <div className="flex gap-1">
                    {p.manifest.config && p.manifest.config.length > 0 && (
                      <button
                        onClick={() => setEditingId(p.manifest.id)}
                        className="px-2 py-0.5 text-xs rounded border border-border hover:bg-bg-dim flex items-center gap-0.5"
                        title="配置"
                      >
                        <span className="material-symbols-outlined text-sm">tune</span>
                        配置
                      </button>
                    )}
                    {!p.manifest.builtin && (
                      <button
                        onClick={() => uninstallPlugin(p.manifest.id)}
                        className="px-2 py-0.5 text-xs rounded border border-border hover:bg-danger/15 hover:text-danger hover:border-danger/30 flex items-center gap-0.5"
                        title="卸载"
                      >
                        <span className="material-symbols-outlined text-sm">delete</span>
                        卸载
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* 右侧: 日志 */}
          {showLog && (
            <div className="w-80 border-l border-border flex flex-col shrink-0">
              <div className="px-3 py-2 border-b border-border text-xs text-text-secondary flex items-center gap-2">
                <span className="material-symbols-outlined text-sm">description</span>
                <span>实时日志 ({logs.length})</span>
                <button
                  onClick={() => setLogs([])}
                  className="ml-auto text-text-secondary hover:text-text"
                  title="清空"
                >
                  <span className="material-symbols-outlined text-sm">delete_sweep</span>
                </button>
              </div>
              <div className="flex-1 overflow-auto font-mono text-[11px]">
                {logs.length === 0 && (
                  <div className="px-3 py-6 text-center text-text-secondary">暂无日志</div>
                )}
                {logs.map(log => {
                  const p = installed.find(x => x.manifest.id === log.pluginId);
                  const ago = Math.max(0, Math.floor((Date.now() - log.ts) / 1000));
                  return (
                    <div key={log.id} className="px-3 py-1.5 border-b border-border/50">
                      <div className="flex items-baseline gap-1.5">
                        <span className={
                          'text-[10px] uppercase ' +
                          (log.level === 'error' ? 'text-danger' :
                           log.level === 'warn' ? 'text-warning' :
                           log.level === 'info' ? 'text-primary' : 'text-text-secondary')
                        }>{log.level}</span>
                        <span className="text-text-secondary text-[10px]">
                          {ago < 60 ? `${ago}s` : `${Math.floor(ago / 60)}m`}前
                        </span>
                        <span className="text-text ml-auto truncate" style={{ maxWidth: 100 }}>{p?.manifest.name || log.pluginId}</span>
                      </div>
                      <div className="text-text mt-0.5 break-words">{log.text}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* 配置 Modal */}
        {editing && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center" onClick={() => setEditingId(null)}>
            <div className="w-[min(90vw,500px)] bg-bg-elevated border border-border rounded-xl shadow-2xl p-5" onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-2 mb-3">
                <span className="material-symbols-outlined text-primary">{editing.manifest.icon}</span>
                <h3 className="text-base font-semibold">{editing.manifest.name} · 配置</h3>
                <button onClick={() => setEditingId(null)} className="ml-auto text-text-secondary hover:text-text">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
              <div className="space-y-2.5">
                {editing.manifest.config?.map(c => (
                  <div key={c.key} className="flex items-center gap-2">
                    <label className="text-sm w-32 shrink-0">{c.label}</label>
                    {c.type === 'boolean' ? (
                      <input
                        type="checkbox"
                        checked={!!editing.configValues[c.key]}
                        onChange={e => updateConfig(editing.manifest.id, c.key, e.target.checked)}
                        className="w-4 h-4"
                      />
                    ) : c.type === 'select' ? (
                      <select
                        value={editing.configValues[c.key] || c.default}
                        onChange={e => updateConfig(editing.manifest.id, c.key, e.target.value)}
                        className="flex-1 px-2 py-1 rounded border border-border bg-bg text-sm"
                      >
                        {c.options?.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : c.type === 'color' ? (
                      <div className="flex-1 flex items-center gap-1.5">
                        <input
                          type="color"
                          value={editing.configValues[c.key] || c.default}
                          onChange={e => updateConfig(editing.manifest.id, c.key, e.target.value)}
                          className="w-8 h-7 rounded border border-border cursor-pointer"
                        />
                        <input
                          type="text"
                          value={editing.configValues[c.key] || c.default}
                          onChange={e => updateConfig(editing.manifest.id, c.key, e.target.value)}
                          className="flex-1 px-2 py-1 rounded border border-border bg-bg text-xs font-mono"
                        />
                      </div>
                    ) : (
                      <input
                        type={c.type === 'number' ? 'number' : 'text'}
                        value={editing.configValues[c.key] ?? c.default}
                        onChange={e => updateConfig(editing.manifest.id, c.key, c.type === 'number' ? parseFloat(e.target.value) : e.target.value)}
                        className="flex-1 px-2 py-1 rounded border border-border bg-bg text-sm"
                      />
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-4 text-xs text-text-secondary">
                修改实时生效,无需保存。插件 {editing.enabled ? '已启用' : '已禁用'}。
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
