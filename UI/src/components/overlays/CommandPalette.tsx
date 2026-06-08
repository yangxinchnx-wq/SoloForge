// ─────────────────────────────────────────────────────────────────
// 全局命令面板 (Ctrl+Shift+P / Ctrl+K)
// - 模糊搜索
// - 分组 (视图 / 主题 / 工具 / 切换)
// - 键盘导航
// ─────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, useMemo } from 'react';
import { pushToast } from './Notifications';
import { themesMap } from '../../themes/themes';

interface Command {
  id: string;
  title: string;
  group: '视图' | '主题' | '工具' | '切换' | '会话' | '布局' | '快捷键' | '收藏';
  icon: string;
  shortcut?: string;
  hint?: string;
  args?: string;
  danger?: boolean;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  // hooks
  setActivity: (id: string) => void;
  chat: any;
  onOpenSettings: () => void;
  setTheme: (t: string) => void;
  currentTheme: string;
  onOpenSkills?: () => void;
  onOpenTour?: () => void;
  onOpenSearch?: () => void;
  setLeftWidth?: (w: number) => void;
  setRightWidth?: (w: number) => void;
}

const ALL_THEMES = [
  { id: 'default-dark', label: '深邃黑', icon: '🌑' },
  { id: 'ocean-dark',   label: '海洋蓝', icon: '🌊' },
  { id: 'morning-light',label: '晨光白', icon: '☀️' },
  { id: 'amethyst',     label: '紫晶梦', icon: '💎' },
];

export function CommandPalette({ open, onClose, setActivity, chat, onOpenSettings, setTheme, currentTheme, onOpenSkills, onOpenTour, onOpenSearch, setLeftWidth, setRightWidth }: Props) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const cmds: Command[] = useMemo(() => [
    // 视图
    { id: 'v.explorer', title: '打开资源管理',  group: '视图', icon: 'files',     args: 'activity=explorer', run: () => setActivity('explorer') },
    { id: 'v.search',   title: '打开搜索',      group: '视图', icon: 'search',    args: 'activity=search', run: () => setActivity('search') },
    { id: 'v.git',      title: '打开源码管理',  group: '视图', icon: 'account_tree', args: 'activity=git', run: () => setActivity('git') },
    { id: 'v.debug',    title: '打开调试',      group: '视图', icon: 'bug_report', args: 'activity=debug', run: () => setActivity('debug') },
    { id: 'v.terminal', title: '打开终端',      group: '视图', icon: 'terminal',  shortcut: 'Ctrl+`', args: 'activity=terminal', run: () => setActivity('terminal') },
    { id: 'v.court',    title: '打开法庭',      group: '视图', icon: 'gavel',     args: 'activity=court', run: () => setActivity('court') },
    { id: 'v.agents',   title: '打开组件',      group: '视图', icon: 'smart_toy', args: 'activity=agents', run: () => setActivity('agents') },
    { id: 'v.skills',   title: '打开技能市场',  group: '视图', icon: 'extension', args: 'overlay', run: () => onOpenSkills?.() },
    { id: 'v.search',   title: '打开全局搜索',  group: '视图', icon: 'search',    shortcut: 'Ctrl+Shift+F', args: 'overlay', run: () => onOpenSearch?.() },
    { id: 'v.settings', title: '打开设置',      group: '视图', icon: 'settings',  shortcut: 'Ctrl+,', args: 'overlay', run: onOpenSettings },
    { id: 'v.history',  title: '搜索对话历史',  group: '视图', icon: 'history',   shortcut: 'Ctrl+H', args: 'overlay', run: () => pushToast({ level: 'info', title: '请使用 Ctrl+H', duration: 1500 }) },
    { id: 'v.split',    title: '分屏对比',      group: '视图', icon: 'splitscreen', shortcut: 'Ctrl+\\', args: '2-4 panes', run: () => pushToast({ level: 'info', title: '请使用 Ctrl+\\', duration: 1500 }) },
    { id: 'v.hotkey',   title: '快捷键速查',    group: '视图', icon: 'keyboard',  shortcut: '?', args: 'overlay', run: () => pushToast({ level: 'info', title: '请使用 ?', duration: 1500 }) },
    { id: 'v.abtest',   title: 'A/B 测试提示词', group: '视图', icon: 'science', shortcut: 'Ctrl+Shift+A', args: '2-4 变体', run: () => pushToast({ level: 'info', title: '请使用 Ctrl+Shift+A', duration: 1500 }) },
    { id: 'v.detach',   title: '拖出独立窗口',  group: '视图', icon: 'open_in_new', shortcut: 'Ctrl+Alt+D', args: 'popup', run: () => pushToast({ level: 'info', title: '请使用 Ctrl+Alt+D', duration: 1500 }) },
    { id: 'v.review',   title: '代码多模型评审', group: '工具', icon: 'rate_review', shortcut: 'Ctrl+Shift+R', args: '5 维 × 5 模型', run: () => pushToast({ level: 'info', title: '请使用 Ctrl+Shift+R', duration: 1500 }) },
    { id: 'v.scheduler',title: 'AI 计划任务调度', group: '工具', icon: 'event_repeat', shortcut: 'Ctrl+Shift+T', args: '自然语言', run: () => pushToast({ level: 'info', title: '请使用 Ctrl+Shift+T', duration: 1500 }) },
    { id: 'v.collab',   title: '协同光标 (模拟)', group: '工具', icon: 'group', shortcut: 'Ctrl+Alt+Shift+C', args: '5 个虚拟队友', run: () => pushToast({ level: 'info', title: '请使用 Ctrl+Alt+Shift+C', duration: 1500 }) },
    { id: 'v.debug',    title: '断点调试器 (模拟)', group: '工具', icon: 'bug_report', shortcut: 'Ctrl+Alt+B', args: '3 个场景', run: () => pushToast({ level: 'info', title: '请使用 Ctrl+Alt+B', duration: 1500 }) },
    { id: 'v.plugins',  title: '插件管理',     group: '工具', icon: 'extension', shortcut: 'Ctrl+Alt+Shift+P', args: '6 个示例插件', run: () => pushToast({ level: 'info', title: '请使用 Ctrl+Alt+Shift+P', duration: 1500 }) },

    // 布局预设
    { id: 'l.default',  title: '布局: 默认 (左+中+右)',  group: '布局', icon: 'view_column', args: '460/420', hint: '平衡三栏', run: () => { setLeftWidth?.(460); setRightWidth?.(420); } },
    { id: 'l.focus',    title: '布局: 聚焦 (只显示对话)', group: '布局', icon: 'center_focus_strong', args: '0/0', hint: '纯净对话', run: () => { setLeftWidth?.(0); setRightWidth?.(0); } },
    { id: 'l.coding',   title: '布局: 编程 (左大+中)',    group: '布局', icon: 'code', args: '720/280', hint: '代码优先', run: () => { setLeftWidth?.(720); setRightWidth?.(280); } },
    { id: 'l.observe',  title: '布局: 观测 (右大+中)',    group: '布局', icon: 'monitoring', args: '280/720', hint: '面板优先', run: () => { setLeftWidth?.(280); setRightWidth?.(720); } },
    { id: 'l.split',    title: '布局: 三分屏',            group: '布局', icon: 'splitscreen', args: '33/33/33', hint: '等宽分布', run: () => { setLeftWidth?.(420); setRightWidth?.(420); } },

    // 工具
    { id: 't.refresh',  title: '刷新后端数据',  group: '工具', icon: 'refresh',   args: 'GET /api', hint: '从 /api 重新拉取', run: () => location.reload() },
    { id: 't.clear',    title: '清空流送区',    group: '工具', icon: 'delete_sweep', args: 'stream', run: () => chat.clearStream() },
    { id: 't.clearAll', title: '清空所有历史',  group: '工具', icon: 'history_toggle_off', args: 'DESTRUCTIVE', danger: true, run: () => {
      if (confirm('确认清空所有历史对话？')) chat.clearAll();
    }},
    { id: 't.export',   title: '导出当前对话',  group: '工具', icon: 'download',  args: 'Markdown', hint: '下载为 Markdown', run: () => {} },
    { id: 't.tour',     title: '开始产品引导',  group: '工具', icon: 'route',     args: 'onboarding', run: () => onOpenTour?.() },

    // 切换
    ...ALL_THEMES.filter(t => t.id !== currentTheme).map(t => {
      const tk = themesMap[t.id]?.tokens;
      const swatch = tk ? [tk.bg, tk.surface, tk.primary, tk.accent].map(c => c.slice(1)).join(' ') : '';
      return {
        id: 'th.' + t.id,
        title: `切换主题: ${t.label}`,
        group: '主题' as const,
        icon: 'palette',
        args: swatch ? `#${swatch.split(' ').join(' #')}` : undefined,
        run: () => setTheme(t.id),
      };
    }),

    // 会话
    { id: 's.new',      title: '新建对话',      group: '会话', icon: 'add',       shortcut: 'Ctrl+N', args: 'session', run: () => chat.newSession() },
    { id: 's.copyLast', title: '复制最近回复',  group: '会话', icon: 'content_copy', args: 'clipboard', run: () => {
      const sess = chat.sessions.find((s: any) => s.id === chat.activeId);
      const last = sess?.messages?.filter((m: any) => m.role === 'assistant').slice(-1)[0];
      if (last) navigator.clipboard?.writeText(last.content);
    }},

    // 快捷键速览
    { id: 'k.cmd',      title: '命令面板',      group: '快捷键', icon: 'keyboard', shortcut: 'Ctrl+K',         hint: '打开命令面板',         run: () => {} },
    { id: 'k.cmdAlt',   title: '命令面板(备)',  group: '快捷键', icon: 'keyboard', shortcut: 'Ctrl+Shift+P',   hint: '备用入口',             run: () => {} },
    { id: 'k.search',   title: '全局搜索',      group: '快捷键', icon: 'keyboard', shortcut: 'Ctrl+Shift+F',   hint: '跨文件搜索',           run: () => {} },
    { id: 'k.deploy',   title: '部署',          group: '快捷键', icon: 'keyboard', shortcut: 'Ctrl+Shift+D',   hint: '部署向导',             run: () => {} },
    { id: 'k.settings', title: '设置',          group: '快捷键', icon: 'keyboard', shortcut: 'Ctrl+,',         hint: '打开设置',             run: () => {} },
    { id: 'k.term',     title: '终端',          group: '快捷键', icon: 'keyboard', shortcut: 'Ctrl+`',         hint: '打开终端',             run: () => {} },
    { id: 'k.explorer', title: '资源管理',      group: '快捷键', icon: 'keyboard', shortcut: 'Ctrl+B',         hint: '切到资源树',           run: () => {} },
    { id: 'k.court',    title: '法庭',          group: '快捷键', icon: 'keyboard', shortcut: 'Ctrl+P',         hint: '切到法庭',             run: () => {} },
    { id: 'k.git',      title: '源码管理',      group: '快捷键', icon: 'keyboard', shortcut: 'Ctrl+G',         hint: '切到 Git',             run: () => {} },
    { id: 'k.search2',  title: '搜索视图',      group: '快捷键', icon: 'keyboard', shortcut: 'Ctrl+S',         hint: '切到搜索',             run: () => {} },
    { id: 'k.refresh',  title: '刷新后端',      group: '快捷键', icon: 'keyboard', shortcut: 'Ctrl+R',         hint: '重新拉取',             run: () => {} },
    { id: 'k.clear',    title: '清空流送',      group: '快捷键', icon: 'keyboard', shortcut: 'Ctrl+L',         hint: '清空流送区',           run: () => {} },
  ], [setActivity, chat, onOpenSettings, currentTheme, setTheme, onOpenSkills, onOpenTour, onOpenSearch, setLeftWidth, setRightWidth]);

  // bang 模式 (!) 本地快捷命令
  const bangMode = q.trimStart().startsWith('!');
  const bangCmd = bangMode ? q.trimStart().slice(1).trim() : '';

  // 主题 picker 模式: 仅 "!theme" 或 "!theme=" 无值时激活
  const themePickerMode = bangMode && /^theme\s*(=)?\s*$/.test(bangCmd);
  const themeQuery = themePickerMode ? '' : (bangCmd.match(/^theme\s*=\s*(.*)$/)?.[1] || '');

  // theme picker 时让 filtered 跟随主题列表
  // ─── 收藏 (持久化, ☆ 标记) — 必须在 filtered useMemo 之前声明 ───
  const FAV_KEY = 'soloforge.cmd.favorites';
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(FAV_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return [];
  });
  useEffect(() => {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(favorites)); } catch { /* ignore */ }
  }, [favorites]);
  const toggleFavorite = (id: string, title: string) => {
    setFavorites(prev => {
      if (prev.includes(id)) {
        pushToast({ level: 'info', title: '已取消收藏', message: title, duration: 1500 });
        return prev.filter(x => x !== id);
      }
      pushToast({ level: 'success', title: '已加入收藏', message: title, duration: 1500 });
      return [...prev, id];
    });
  };
  const isFavorite = (id: string) => favorites.includes(id);

  // ─── 运行历史 (持久化最近 10 个) ───
  const HISTORY_KEY = 'soloforge.cmd.history';
  const [history, setHistory] = useState<Array<{ cmd: string; ts: number; group: string }>>(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return [];
  });
  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 10)));
    } catch { /* ignore */ }
  }, [history]);
  const showHistory = !q.trim() && history.length > 0;
  const [showHistoryPanel, setShowHistoryPanel] = useState(true);
  const recordRun = (raw: string, group: string) => {
    setHistory(prev => {
      const dedup = prev.filter(p => p.cmd !== raw);
      return [{ cmd: raw, ts: Date.now(), group }, ...dedup].slice(0, 10);
    });
  };

  const filtered = useMemo(() => {
    if (bangMode && /^theme/.test(bangCmd)) {
      const q2 = (themeQuery || '').toLowerCase();
      const list: Command[] = ALL_THEMES
        .filter(t => !q2 || t.id.toLowerCase().includes(q2) || t.label.toLowerCase().includes(q2))
        .map(t => ({
          id: 'th.' + t.id,
          title: `切到主题: ${t.label}`,
          group: '主题',
          icon: 'palette',
          run: () => setTheme(t.id),
        }));
      return list;
    }

    const s = q.trim().toLowerCase();
    // 空查询: 把收藏的命令提到最前 (新分组 "收藏")
    if (!s) {
      const favCmds: Command[] = cmds
        .filter(c => favorites.includes(c.id))
        .map(c => ({ ...c, group: '收藏' as any, icon: 'star' }));
      const others = cmds.filter(c => !favorites.includes(c.id));
      return [...favCmds, ...others];
    }
    // 解析 ":" 参数模式: ":key=value" 或 ":key"
    const colonMode = s.startsWith(':');
    const queryStr = colonMode ? s.slice(1) : s;
    const eqIdx = queryStr.indexOf('=');
    const argKey = colonMode && eqIdx > 0 ? queryStr.slice(0, eqIdx) : '';
    const argVal = colonMode && eqIdx > 0 ? queryStr.slice(eqIdx + 1) : '';

    if (colonMode && argKey) {
      // 仅匹配带 args 的命令, 优先按 key=value 命中; 收藏项加权
      const matches = cmds
        .filter(c => c.args)
        .map(c => {
          const a = (c.args || '').toLowerCase();
          const keyHit = a.startsWith(argKey.toLowerCase());
          const valHit = argVal ? a.includes(argVal.toLowerCase()) : true;
          const titleHit = c.title.toLowerCase().includes(queryStr);
          if (!keyHit && !titleHit) return null;
          if (!valHit && !titleHit) return null;
          // 评分
          let score = 0;
          if (keyHit) score += 50;
          if (a === queryStr) score += 200;
          else if (a.startsWith(queryStr)) score += 100;
          else if (a.includes(queryStr)) score += 30;
          if (titleHit) score += 20;
          if (favorites.includes(c.id)) score += 1000; // 收藏命令置顶
          return { cmd: c, score };
        })
        .filter(Boolean)
        .sort((a, b) => (b!.score - a!.score))
        .map(x => x!.cmd);
      return matches;
    }

    return cmds.filter(c =>
      c.title.toLowerCase().includes(s) ||
      c.group.toLowerCase().includes(s) ||
      c.id.toLowerCase().includes(s) ||
      (c.args && c.args.toLowerCase().includes(s))
    );
  }, [cmds, q, bangMode, bangCmd, themeQuery, favorites]);

  // 参数模式提示
  const colonPreview = useMemo(() => {
    const s = q.trim();
    if (!s.startsWith(':')) return null;
    const top = filtered[0];
    if (!top) return null;
    return { arg: s.slice(1), top };
  }, [q, filtered]);

  // shell 模式提示
  const shellMode = q.trimStart().startsWith('>');
  const shellCmd = shellMode ? q.trimStart().slice(1).trim() : '';

  // themePickerMode / themeQuery 已在 filtered 之前定义

  useEffect(() => { setIdx(0); }, [q]);

  const run = (c: Command) => {
    if (c.group === '快捷键') {
      navigator.clipboard?.writeText(c.shortcut || c.title).catch(() => {});
      return;
    }
    recordRun(c.title, c.group);
    c.run();
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      // bang 模式: 本地执行
      if (bangMode && bangCmd) {
        // theme picker: 回车选当前 idx
        if (themePickerMode || (bangCmd.startsWith('theme=') && bangCmd.split('=')[1])) {
          const t = ALL_THEMES[idx];
          if (t) {
            runBang(`theme=${t.id}`);
            return;
          }
        }
        runBang(bangCmd);
        return;
      }
      // shell 模式: 直接发给 AI
      if (shellMode && shellCmd) {
        chat?.send?.(shellCmd);
        onClose();
        return;
      }
      if (filtered[idx]) run(filtered[idx]);
    }
    else if (e.key === 'Escape') onClose();
  };

  // bang 命令解析与执行
  const runBang = (raw: string) => {
    const [cmdRaw, ...rest] = raw.split(/\s+/);
    const arg = rest.join(' ');

    // alias 展开
    const eqIdx = cmdRaw.indexOf('=');
    const headKey = eqIdx > 0 ? cmdRaw.slice(0, eqIdx) : cmdRaw;
    const expandedHead = BANG_ALIASES[headKey] || headKey;
    const cmd = eqIdx > 0 ? expandedHead + cmdRaw.slice(eqIdx) : expandedHead;

    const eq = cmd.indexOf('=');
    const key = eq > 0 ? cmd.slice(0, eq) : cmd;
    const val = eq > 0 ? cmd.slice(eq + 1) : arg;

    let done = false;
    switch (key) {
      case 'clear': chat?.clearStream?.(); pushToast({ level: 'info', title: '已清空流送', duration: 1500 }); done = true; break;
      case 'new':   chat?.newSession?.(); pushToast({ level: 'success', title: '已新建会话', duration: 1500 }); done = true; break;
      case 'theme': if (val) { setTheme(val); pushToast({ level: 'success', title: '已切换主题', message: val, duration: 1800 }); done = true; } break;
      case 'layout':
        if (val.includes('/')) {
          const [l, r] = val.split('/').map(Number);
          if (!isNaN(l)) setLeftWidth?.(l);
          if (!isNaN(r)) setRightWidth?.(r);
          pushToast({ level: 'success', title: '布局已应用', message: `左 ${l} / 右 ${r}`, duration: 1800 });
          done = true;
        }
        break;
      case 'palette': onOpenTour?.(); done = true; break;
      case 'search': onOpenSearch?.(); done = true; break;
      case 'help': /* fallthrough 展示帮助 */ break;
    }
    if (done) { recordRun('!' + cmd, 'bang'); onClose(); return; }
    pushToast({ level: 'warning', title: `未知 bang 命令: !${raw}`, message: '输入 !help 查看可用命令', duration: 3000 });
  };

  const BANG_HELP = [
    { cmd: '!clear',           desc: '清空流送区',                aliases: ['!cls', '!c'] },
    { cmd: '!new',             desc: '新建对话会话',              aliases: ['!n'] },
    { cmd: '!theme=ocean-dark',desc: '切换主题 (可省 =value)',     aliases: ['!th'] },
    { cmd: '!layout=460/420',  desc: '设置左右栏宽度',            aliases: ['!l'] },
    { cmd: '!palette',         desc: '打开命令面板(嵌套)',         aliases: ['!p'] },
    { cmd: '!search',          desc: '打开全局搜索',              aliases: ['!s', '!grep'] },
  ];

  // alias -> 真实命令的映射
  const BANG_ALIASES: Record<string, string> = Object.fromEntries(
    BANG_HELP.flatMap(b => b.aliases.map(a => [a.slice(1), b.cmd.slice(1)]))
  );

  // 帮助列表扁平化 (含 alias) 用于过滤
  const BANG_HELP_FLAT = BANG_HELP.flatMap(b => [
    { cmd: b.cmd, desc: b.desc },
    ...b.aliases.map(a => ({ cmd: a, desc: `→ ${b.cmd.slice(1)}` })),
  ]);

  if (!open) return null;

  // 按组分组
  const groups: Record<string, Command[]> = {};
  filtered.forEach(c => {
    if (!groups[c.group]) groups[c.group] = [];
    groups[c.group].push(c);
  });
  let runningIdx = -1;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-[15vh] bg-black/40 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[640px] max-w-[90vw] bg-surface border border-border rounded-xl shadow-2xl overflow-hidden animate-slide-in-up"
        onClick={e => e.stopPropagation()}
      >
        {/* 搜索框 */}
        <div className="flex items-center gap-2 px-4 h-12 border-b border-border">
          <span className="material-symbols-outlined text-text-secondary">
            {bangMode ? 'priority_high' : shellMode ? 'terminal' : 'search'}
          </span>
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder={
              bangMode ? 'bang 本地命令 (如 !clear, !theme=ocean-dark)...' :
              shellMode ? 'shell 命令将直接发给 AI...' :
              '输入命令、视图或主题... (用 :key=val 过滤 args · > 发送 shell · ! 本地命令)'
            }
            className="flex-1 bg-transparent outline-none text-sm text-text placeholder-text-secondary font-mono"
          />
          <kbd className="px-1.5 py-0.5 text-[10px] rounded bg-surface-high text-text-secondary border border-border-light">ESC</kbd>
        </div>

        {/* shell 模式提示 */}
        {shellMode && (
          <div className="flex items-center gap-2 px-4 py-1.5 bg-success/8 border-b border-success/30 text-[10px]">
            <span className="material-symbols-outlined text-success text-xs">terminal</span>
            <span className="text-text-secondary">shell 模式</span>
            <code className="px-1.5 py-0.5 rounded bg-surface border border-border-light text-success font-mono truncate max-w-[300px]">
              {shellCmd || '(空)'}
            </code>
            <div className="flex-1" />
            <span className="text-text-secondary/70">↵ 发送给 AI</span>
          </div>
        )}

        {/* bang 模式提示 */}
        {bangMode && (
          <div className="flex items-center gap-2 px-4 py-1.5 bg-warning/8 border-b border-warning/30 text-[10px]">
            <span className="material-symbols-outlined text-warning text-xs">priority_high</span>
            <span className="text-text-secondary">bang 模式</span>
            <code className="px-1.5 py-0.5 rounded bg-surface border border-border-light text-warning font-mono truncate max-w-[300px]">
              !{bangCmd || '(空)'}
            </code>
            <div className="flex-1" />
            <span className="text-text-secondary/70">↵ 本地执行</span>
          </div>
        )}

        {/* : 参数模式预览 */}
        {colonPreview && (
          <div className="flex items-center gap-2 px-4 py-1.5 bg-primary/5 border-b border-primary/20 text-[10px]">
            <span className="material-symbols-outlined text-primary text-xs">filter_alt</span>
            <span className="text-text-secondary">参数模式</span>
            <code className="px-1.5 py-0.5 rounded bg-surface border border-border-light text-primary font-mono">
              :{colonPreview.arg}
            </code>
            <span className="text-text-secondary">·</span>
            <span className="text-text-secondary">即将执行</span>
            <span className="text-text font-semibold truncate">{colonPreview.top.title}</span>
            {colonPreview.top.args && (
              <span className="px-1 py-0.5 rounded bg-bg-dim text-text-secondary border border-border-light font-mono">
                {colonPreview.top.args}
              </span>
            )}
            <div className="flex-1" />
            <span className="text-text-secondary/70">{filtered.length} 命中</span>
          </div>
        )}

        {/* 列表 */}
        <div className="max-h-[55vh] overflow-y-auto scrollbar-thin py-1">
          {bangMode && /^theme/.test(bangCmd) ? (
            <div className="px-4 py-3 space-y-1.5">
              <div className="text-[10px] text-text-secondary font-mono mb-2">
                主题选择器 · 当前 <code className="px-1 rounded bg-bg-dim border border-border-light">{currentTheme}</code> · {ALL_THEMES.length} 主题
              </div>
              {ALL_THEMES
                .filter(t => !themeQuery || t.id.toLowerCase().includes(themeQuery) || t.label.toLowerCase().includes(themeQuery))
                .map((t, i) => {
                  const isCurrent = t.id === currentTheme;
                  const tk = themesMap[t.id]?.tokens;
                  // 5 色调色板: bg / surface / primary / accent / danger
                  const swatches = tk ? [tk.bg, tk.surface, tk.primary, tk.accent, tk.danger] : [];
                  return (
                    <button
                      key={t.id}
                      onClick={() => runBang(`theme=${t.id}`)}
                      onMouseEnter={() => setIdx(i)}
                      className={`w-full flex items-center gap-2.5 px-2.5 h-10 rounded text-left hover:bg-surface-high transition-colors group ${
                        isCurrent ? 'bg-primary/10 border border-primary/30' : ''
                      }`}
                    >
                      <span className="text-lg shrink-0 w-6 text-center">{t.icon}</span>
                      <code className="text-xs text-text font-mono shrink-0">{t.id}</code>
                      {/* 颜色色块预览 (每个色块也可点击切换) */}
                      <span className="flex items-center gap-0.5 shrink-0 px-1.5 py-0.5 rounded bg-bg-dim border border-border-light group/swatches">
                        {swatches.map((c, ci) => {
                          const labels = ['背景', '面板', '主色', '点缀', '警示'];
                          return (
                            <button
                              key={ci}
                              onClick={(e) => { e.stopPropagation(); runBang(`theme=${t.id}`); }}
                              className="w-2.5 h-3 rounded-sm border border-black/20 hover:scale-150 hover:ring-1 hover:ring-primary transition-all cursor-pointer"
                              style={{ background: c }}
                              title={`${t.label} · ${labels[ci] || ''} ${c}`}
                            />
                          );
                        })}
                      </span>
                      <span className="text-[10px] text-text-secondary truncate flex-1">— {t.label}</span>
                      {isCurrent && (
                        <span className="text-[9px] text-primary font-semibold shrink-0 flex items-center gap-0.5">
                          <span className="material-symbols-outlined text-[10px]">check</span>
                          当前
                        </span>
                      )}
                      <span className="material-symbols-outlined text-xs text-text-secondary opacity-0 group-hover:opacity-100">north_east</span>
                    </button>
                  );
                })}
              <div className="mt-3 text-[10px] text-text-secondary/70 leading-relaxed px-1">
                输入 <code className="px-1 rounded bg-bg-dim border border-border-light">!theme</code> 打开此选择器；
                也可写 <code className="px-1 rounded bg-bg-dim border border-border-light">!theme=ocean-dark</code> 直接设置。
              </div>
            </div>
          ) : bangMode ? (
            <div className="px-4 py-3 space-y-1.5">
              <div className="text-[10px] text-text-secondary font-mono mb-2">
                bang 本地命令 · 6 个主命令 · 8 个 alias
              </div>
              {BANG_HELP_FLAT
                .filter(s => !bangCmd || s.cmd.toLowerCase().includes(bangCmd.toLowerCase()))
                .map((s, i) => {
                  const isAlias = s.desc.startsWith('→');
                  return (
                    <button
                      key={i}
                      onClick={() => setQ('!' + s.cmd.slice(1))}
                      className={`w-full flex items-center gap-2 px-2.5 h-8 rounded text-left hover:bg-surface-high transition-colors group ${
                        isAlias ? 'opacity-70' : ''
                      }`}
                    >
                      <span className={`material-symbols-outlined text-sm shrink-0 ${isAlias ? 'text-text-secondary' : 'text-warning'}`}>
                        {isAlias ? 'arrow_forward' : 'bolt'}
                      </span>
                      <code className={`text-xs font-mono shrink-0 ${isAlias ? 'text-text-secondary' : 'text-text'}`}>
                        {s.cmd}
                      </code>
                      <span className="text-[10px] text-text-secondary truncate flex-1">{s.desc}</span>
                      <span className="material-symbols-outlined text-xs text-text-secondary opacity-0 group-hover:opacity-100">north_east</span>
                    </button>
                  );
                })}
              <div className="mt-3 text-[10px] text-text-secondary/70 leading-relaxed px-1">
                bang 命令是<strong>本地立即执行</strong>的客户端操作,不会经过 AI。
                <br />语法支持 <code className="px-1 rounded bg-bg-dim border border-border-light">!cmd</code> 和 <code className="px-1 rounded bg-bg-dim border border-border-light">!key=value</code> 两种形式。
                带 → 的灰色行是 alias 缩写。
              </div>
            </div>
          ) : shellMode ? (
            <div className="px-4 py-6 space-y-2">
              <div className="text-[10px] text-text-secondary font-mono mb-2">常用 shell 快捷输入:</div>
              {[
                { cmd: '解释 useChat.ts 第 80 行',      desc: '问 AI 解释指定文件位置' },
                { cmd: '运行 npm test',                  desc: '请求执行测试命令' },
                { cmd: 'git diff 总结',                  desc: '让 AI 汇总变更' },
                { cmd: '修复 src/api/client.ts 报错',    desc: '把任务交给 AI' },
                { cmd: '重构 useResources hook',         desc: '让 AI 重构代码' },
              ].map((s, i) => (
                <button
                  key={i}
                  onClick={() => setQ('> ' + s.cmd)}
                  className="w-full flex items-center gap-2 px-2.5 h-8 rounded text-left hover:bg-surface-high transition-colors group"
                >
                  <span className="material-symbols-outlined text-success text-sm shrink-0">arrow_forward</span>
                  <span className="flex-1 min-w-0">
                    <span className="text-xs text-text font-mono block truncate">{s.cmd}</span>
                    <span className="text-[10px] text-text-secondary truncate block">{s.desc}</span>
                  </span>
                  <span className="material-symbols-outlined text-xs text-text-secondary opacity-0 group-hover:opacity-100">north_east</span>
                </button>
              ))}
              <div className="mt-3 text-[10px] text-text-secondary/70 leading-relaxed px-1">
                提示:此处"shell"是指<strong>把整段当作用户输入发给 AI</strong>,不是真在主机上执行命令;
                AI 会根据你的描述生成回复、代码或建议。
              </div>
            </div>
          ) : showHistory && showHistoryPanel ? (
            <div className="px-4 py-3 space-y-1.5">
              <div className="flex items-center justify-between text-[10px] text-text-secondary font-mono mb-1">
                <span className="flex items-center gap-1">
                  <span className="material-symbols-outlined text-xs">history</span>
                  最近执行 · {history.length}/10
                </span>
                <button
                  onClick={() => setHistory([])}
                  className="text-text-secondary hover:text-danger flex items-center gap-0.5"
                  title="清空历史"
                >
                  <span className="material-symbols-outlined text-[10px]">delete_sweep</span>
                  清空
                </button>
              </div>
              {history.map((h, i) => {
                const ageMs = Date.now() - h.ts;
                const ageLabel = ageMs < 60_000 ? '刚刚' :
                  ageMs < 3_600_000 ? `${Math.floor(ageMs / 60_000)} 分钟前` :
                  ageMs < 86_400_000 ? `${Math.floor(ageMs / 3_600_000)} 小时前` :
                  `${Math.floor(ageMs / 86_400_000)} 天前`;
                const groupColor: Record<string, string> = {
                  主题: 'text-primary', 布局: 'text-accent', 视图: 'text-success',
                  工具: 'text-warning', 切换: 'text-accent', 会话: 'text-text-secondary',
                  快捷键: 'text-text-secondary', bang: 'text-warning',
                };
                return (
                  <button
                    key={i}
                    onClick={() => {
                      // 重新执行: 通过 title 找 command
                      const c = cmds.find(x => x.title === h.cmd);
                      if (c) run(c);
                    }}
                    className="w-full flex items-center gap-2 px-2.5 h-7 rounded text-left hover:bg-surface-high transition-colors group"
                  >
                    <span className="material-symbols-outlined text-xs text-text-secondary shrink-0">replay</span>
                    <span className="text-xs text-text truncate flex-1">{h.cmd}</span>
                    {h.group && (
                      <span className={`text-[9px] font-mono shrink-0 ${groupColor[h.group] || 'text-text-secondary'}`}>
                        {h.group}
                      </span>
                    )}
                    <span className="text-[9px] text-text-secondary/70 font-mono shrink-0 tabular-nums">{ageLabel}</span>
                    <span className="material-symbols-outlined text-xs text-text-secondary opacity-0 group-hover:opacity-100">north_east</span>
                  </button>
                );
              })}
              <div className="mt-2 text-[10px] text-text-secondary/70 leading-relaxed px-1">
                点击历史项可<strong>重新执行</strong>。历史最多保留 10 条,持久化到 localStorage。
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-12 text-center text-text-secondary">
              <span className="material-symbols-outlined text-3xl mb-2 opacity-40">search_off</span>
              <p className="text-xs">没有匹配的命令</p>
              {!q.trim() && history.length > 0 && (
                <button
                  onClick={() => setShowHistoryPanel(true)}
                  className="mt-2 text-[10px] text-primary hover:underline"
                >
                  查看历史 ({history.length})
                </button>
              )}
            </div>
          ) : (
            Object.entries(groups).map(([group, list]) => (
              <div key={group}>
                <div className="px-4 pt-2 pb-1 text-[10px] font-medium text-text-secondary uppercase tracking-wider">
                  {group}
                </div>
                {list.map(c => {
                  runningIdx++;
                  const active = runningIdx === idx;
                  const fav = isFavorite(c.id);
                  return (
                    <button
                      key={c.id}
                      onClick={() => run(c)}
                      onMouseEnter={() => setIdx(runningIdx)}
                      className={`group/cmd w-full flex items-center gap-3 px-4 h-9 text-left transition-colors ${
                        active ? 'bg-primary-container/40' : 'hover:bg-surface-high'
                      }`}
                    >
                      {/* 收藏星标 (hover/fav 时显示) */}
                      {c.id !== 'k.cmd' && c.id !== 'k.cmdAlt' && c.group !== '快捷键' ? (
                        <span
                          role="button"
                          onClick={(e) => { e.stopPropagation(); toggleFavorite(c.id, c.title); }}
                          className={`shrink-0 material-symbols-outlined text-sm transition-colors cursor-pointer ${
                            fav
                              ? 'text-warning filled opacity-100'
                              : 'text-text-secondary/40 opacity-0 group-hover/cmd:opacity-100 hover:text-warning'
                          }`}
                          title={fav ? '取消收藏' : '加入收藏'}
                        >{fav ? 'star' : 'star_outline'}</span>
                      ) : (
                        <span className="w-[14px] shrink-0" />
                      )}
                      <span className={`material-symbols-outlined text-base ${active ? 'text-primary' : c.danger ? 'text-danger' : 'text-text-secondary'}`}>{c.icon}</span>
                      <span className={`flex-1 text-xs ${active ? 'text-text font-medium' : c.danger ? 'text-danger' : 'text-text'}`}>{c.title}</span>
                      {c.args && (
                        <span className={`flex items-center gap-1 px-1.5 py-0.5 text-[9px] rounded font-mono ${
                          c.danger ? 'bg-danger/15 text-danger border border-danger/30' : 'bg-bg-dim text-text-secondary border border-border-light'
                        }`}>
                          {c.group === '主题' && /^#[0-9a-f]{6}/.test(c.args) ? (
                            <>
                              {c.args.split(' ').filter(s => s.startsWith('#')).map((hex, hi) => (
                                <span
                                  key={hi}
                                  className="w-2.5 h-2.5 rounded-sm border border-black/20"
                                  style={{ background: hex }}
                                  title={hex}
                                />
                              ))}
                            </>
                          ) : c.group === '布局' && /^\d+\/\d+/.test(c.args) ? (
                            <>
                              {/* 布局可视化: 三栏比例条 */}
                              {(() => {
                                const m = c.args.match(/^(\d+)\/(\d+)/);
                                if (!m) return <span>{c.args}</span>;
                                const l = Number(m[1]);
                                const r = Number(m[2]);
                                const mid = Math.max(0, 800 - l - r);
                                return (
                                  <span className="flex items-center gap-0.5">
                                    <span className="flex items-end gap-px h-3">
                                      <span className="w-1 bg-primary/60 rounded-sm" style={{ height: `${Math.max(2, (l / 800) * 12)}px` }} title={`左 ${l}px`} />
                                      <span className="w-1 bg-text-secondary/60 rounded-sm" style={{ height: `${Math.max(2, (mid / 800) * 12)}px` }} title="中" />
                                      <span className="w-1 bg-accent/60 rounded-sm" style={{ height: `${Math.max(2, (r / 800) * 12)}px` }} title={`右 ${r}px`} />
                                    </span>
                                    <span>{c.args}</span>
                                  </span>
                                );
                              })()}
                            </>
                          ) : (
                            c.args
                          )}
                        </span>
                      )}
                      {c.hint && <span className="text-[10px] text-text-secondary/70">{c.hint}</span>}
                      {c.shortcut && (
                        <kbd className="px-1.5 py-0.5 text-[9px] rounded bg-bg-dim text-text-secondary border border-border-light font-mono">
                          {c.shortcut}
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* 底栏 */}
        <div className="flex items-center justify-between px-4 h-9 bg-bg-dim border-t border-border text-[10px] text-text-secondary">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-surface border border-border-light">↑↓</kbd>
              选择
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-surface border border-border-light">↵</kbd>
              执行
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-surface border border-border-light">ESC</kbd>
              关闭
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="material-symbols-outlined text-xs">bolt</span>
            SoloForge 命令面板
          </div>
        </div>
      </div>
    </div>
  );
}
