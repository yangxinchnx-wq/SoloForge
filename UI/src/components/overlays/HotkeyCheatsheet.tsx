// ─────────────────────────────────────────────────────────────────
// 键盘快捷键速查浮层 (重写版)
// - 数据源: useKeybindings store (反映用户自定义)
// - 全文搜索 (按名称/键位/分组/ID)
// - 分组过滤 + 已自定义徽标
// - 点击行直接触发对应动作 (或复制键位)
// - 内置 13 个应用级快捷键 (内联,非 store) 如 / / @ /Ctrl+F 等
// - Esc 关闭 · ? 打开
// ─────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useMemo } from 'react';
import { Badge, Button } from '../ui/Button';
import { useKeybindings, formatKeyCombo, DEFAULT_BINDINGS } from '../../hooks/useKeybindingStore';
import { pushToast } from './Notifications';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 触发动作的回调 (由 App 注入) */
  onAction?: (id: string) => void;
}

interface BuiltinBinding {
  id: string;
  label: string;
  keys: string[];
  group: 'AI' | '编辑' | '搜索' | '会话';
  hint?: string;
}

const BUILTIN: BuiltinBinding[] = [
  { id: 'b.slash',     label: '触发斜杠命令',     keys: ['/'],          group: 'AI' },
  { id: 'b.at',        label: '引用文件',         keys: ['@'],          group: 'AI' },
  { id: 'b.explain',   label: '解释当前文件',     keys: ['/', 'explain'],   group: 'AI', hint: '需先引用文件' },
  { id: 'b.test',      label: '生成测试',         keys: ['/', 'test'],      group: 'AI', hint: '需先引用文件' },
  { id: 'b.refactor',  label: '重构当前函数',     keys: ['/', 'refactor'],  group: 'AI', hint: '需先引用文件' },
  { id: 'b.doc',       label: '生成文档注释',     keys: ['/', 'doc'],       group: 'AI' },
  { id: 'b.translate', label: '翻译为中文',       keys: ['/', 'translate'], group: 'AI' },
  { id: 'b.model',     label: '切换主模型',       keys: ['/', 'model'],     group: 'AI' },
  { id: 'b.temperature',label: '设置温度',        keys: ['/', 'temperature'], group: 'AI' },

  { id: 'e.find',      label: '在文件中查找',     keys: ['Ctrl', 'F'],  group: '编辑' },
  { id: 'e.replace',   label: '查找替换',         keys: ['Ctrl', 'H'],  group: '编辑' },
  { id: 'e.multicursor',label: '多光标编辑',      keys: ['Alt', 'Click'], group: '编辑' },
  { id: 'e.match',     label: '选中下一个相同词', keys: ['Ctrl', 'D'],  group: '编辑' },

  { id: 's.send',      label: '发送消息',         keys: ['Enter'],       group: '会话' },
  { id: 's.newline',   label: '换行',             keys: ['Shift', 'Enter'], group: '会话' },
  { id: 's.escape',    label: '关闭浮层',         keys: ['Esc'],         group: '会话' },
];

export function HotkeyCheatsheet({ open, onClose, onAction }: Props) {
  const { bindings } = useKeybindings();
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<'全部' | string>('全部');
  const [showOnly, setShowOnly] = useState<'all' | 'customized' | 'system'>('all');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setGroup('全部');
      setShowOnly('all');
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  // 合并 store + 内置
  const allBindings = useMemo(() => {
    const storeItems = bindings.map(b => {
      const orig = DEFAULT_BINDINGS.find(d => d.id === b.id);
      const isCustom = orig && (
        orig.combo.key !== b.combo.key ||
        !!orig.combo.ctrl !== !!b.combo.ctrl ||
        !!orig.combo.shift !== !!b.combo.shift ||
        !!orig.combo.alt !== !!b.combo.alt ||
        !!orig.combo.meta !== !!b.combo.meta
      );
      return {
        id: b.id,
        label: b.description,
        keys: formatKeyCombo(b.combo).split('+'),
        group: b.group,
        source: 'store' as const,
        isCustom,
      };
    });
    return [...storeItems, ...BUILTIN.map(b => ({ ...b, source: 'builtin' as const, isCustom: false }))];
  }, [bindings]);

  // 收集所有 group
  const allGroups = useMemo(() => {
    const set = new Set<string>(['视图', '导航', '会话', '工具', 'AI', '编辑', '搜索']);
    allBindings.forEach(b => set.add(b.group));
    return Array.from(set);
  }, [allBindings]);

  const filtered = useMemo(() => {
    return allBindings.filter(b => {
      if (group !== '全部' && b.group !== group) return false;
      if (showOnly === 'customized' && !b.isCustom) return false;
      if (showOnly === 'system' && b.source !== 'builtin') return false;
      if (q.trim()) {
        const s = q.toLowerCase();
        return b.label.toLowerCase().includes(s) ||
               b.keys.join('+').toLowerCase().includes(s) ||
               b.group.toLowerCase().includes(s) ||
               b.id.toLowerCase().includes(s);
      }
      return true;
    });
  }, [allBindings, q, group, showOnly]);

  // 按 group 分组渲染
  const grouped = useMemo(() => {
    const g: Record<string, typeof allBindings> = {};
    filtered.forEach(b => {
      if (!g[b.group]) g[b.group] = [];
      g[b.group].push(b);
    });
    return g;
  }, [filtered]);

  // 统计
  const totalCount = allBindings.length;
  const customizedCount = allBindings.filter(b => b.isCustom).length;
  const builtinCount = allBindings.filter(b => b.source === 'builtin').length;
  const storeCount = totalCount - builtinCount;

  const onClick = (b: typeof allBindings[0]) => {
    const text = b.keys.join('+');
    if (b.source === 'store' && onAction) {
      // 触发对应动作
      onAction(b.id);
      pushToast({ level: 'success', title: '已触发', message: b.label, duration: 1200 });
    } else {
      navigator.clipboard?.writeText(text).catch(() => {});
      pushToast({ level: 'info', title: '已复制键位', message: text, duration: 1200 });
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[180] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[820px] max-w-[94vw] h-[640px] max-h-[88vh] overflow-hidden bg-surface rounded-2xl border border-border shadow-2xl flex flex-col animate-slide-in-up"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 h-12 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-lg">keyboard</span>
            <h3 className="font-display font-semibold text-text">键盘快捷键</h3>
            <Badge variant="primary">{totalCount}</Badge>
            <span className="text-[10px] text-text-secondary font-mono">
              · {storeCount} 系统 · {builtinCount} 内置 · {customizedCount} 自定义
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon="tune"
            onClick={() => {
              // 触发 App 的 onOpenSettings
              onAction?.('__openSettings');
              onClose();
            }}
          >
            自定义键位
          </Button>
          <button
            onClick={onClose}
            className="material-symbols-outlined text-text-secondary hover:text-text w-7 h-7 flex items-center justify-center rounded hover:bg-surface-high"
            aria-label="关闭"
          >close</button>
        </div>

        {/* 搜索框 */}
        <div className="flex items-center gap-2 px-4 h-11 border-b border-border-light shrink-0">
          <span className="material-symbols-outlined text-text-secondary text-sm">search</span>
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="搜索快捷键、动作、命令 (支持: 名称 / 键位 / 分组 / ID)..."
            className="flex-1 bg-transparent outline-none text-sm text-text placeholder-text-secondary"
          />
          {q && (
            <button
              onClick={() => setQ('')}
              className="text-[10px] text-text-secondary hover:text-text"
            >清空</button>
          )}
          <kbd className="px-1.5 py-0.5 text-[10px] rounded bg-surface-high text-text-secondary border border-border-light">ESC</kbd>
        </div>

        {/* 过滤栏 */}
        <div className="flex items-center gap-1 px-4 py-2 border-b border-border-light bg-bg-dim overflow-x-auto scrollbar-thin shrink-0">
          <GroupChip active={group === '全部'} onClick={() => setGroup('全部')} label="全部" count={allBindings.length} />
          {allGroups.map(g => (
            <GroupChip
              key={g}
              active={group === g}
              onClick={() => setGroup(g)}
              label={g}
              count={allBindings.filter(b => b.group === g).length}
            />
          ))}
          <div className="w-px h-5 bg-border mx-1" />
          <FilterChip active={showOnly === 'all'}         onClick={() => setShowOnly('all')}         label="全部" />
          <FilterChip active={showOnly === 'customized'} onClick={() => setShowOnly('customized')} label="已自定义" count={customizedCount} />
          <FilterChip active={showOnly === 'system'}     onClick={() => setShowOnly('system')}     label="系统内置" count={builtinCount} />
        </div>

        {/* 列表 */}
        <div className="flex-1 overflow-y-auto p-3 scrollbar-thin">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
              <span className="material-symbols-outlined text-3xl mb-2 opacity-40">search_off</span>
              <p className="text-xs">没有匹配的快捷键</p>
              {q.trim() && (
                <button onClick={() => setQ('')} className="mt-2 text-[10px] text-primary hover:underline">
                  清空搜索
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {Object.entries(grouped).map(([g, list]) => (
                <div key={g}>
                  <div className="flex items-center gap-1.5 mb-1.5 px-1 text-[10px] font-semibold text-text-secondary uppercase tracking-wider">
                    <span className="material-symbols-outlined text-xs">
                      {g === '视图' ? 'visibility' : g === '导航' ? 'explore' : g === '会话' ? 'forum' :
                       g === 'AI' ? 'auto_awesome' : g === '编辑' ? 'edit' : g === '搜索' ? 'search' : 'tag'}
                    </span>
                    {g}
                    <span className="text-text-secondary/50 font-mono">· {list.length}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {list.map(b => (
                      <button
                        key={b.id}
                        onClick={() => onClick(b)}
                        className="group flex items-center gap-2 px-2.5 h-9 rounded-md bg-bg-dim hover:bg-surface-high border border-border-light hover:border-primary/40 transition-colors text-left"
                      >
                        <div className="flex items-center gap-0.5 shrink-0">
                          {b.keys.map((k, j) => (
                            <span key={j} className="inline-flex items-center px-1.5 h-5 min-w-[20px] justify-center rounded border border-border bg-surface text-text font-mono text-[10px]">
                              {k}
                            </span>
                          ))}
                        </div>
                        <span className="text-[11px] text-text flex-1 truncate">{b.label}</span>
                        {b.isCustom && (
                          <span className="material-symbols-outlined text-[10px] text-primary" title="已自定义">edit</span>
                        )}
                        {b.source === 'builtin' && (
                          <span className="text-[9px] text-text-secondary/70 font-mono shrink-0">AI</span>
                        )}
                        <span className="opacity-0 group-hover:opacity-100 material-symbols-outlined text-[10px] text-text-secondary">
                          {b.source === 'store' ? 'play_arrow' : 'content_copy'}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 底栏 */}
        <div className="flex items-center justify-between px-4 h-10 bg-bg-dim border-t border-border text-[10px] text-text-secondary shrink-0">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-surface border border-border-light">点击</kbd>
              触发 / 复制
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-surface border border-border-light">ESC</kbd>
              关闭
            </span>
          </div>
          <span className="font-mono">
            {filtered.length} / {totalCount}
            {q && ` · 搜「${q}」`}
          </span>
        </div>
      </div>
    </div>
  );
}

function GroupChip({ active, onClick, label, count }: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 flex items-center gap-1 px-2.5 h-6 rounded-full text-[11px] transition-colors ${
        active
          ? 'bg-primary text-on-primary'
          : 'bg-surface text-text-secondary hover:text-text border border-border-light'
      }`}
    >
      <span>{label}</span>
      <span className={`font-mono ${active ? 'text-on-primary/70' : 'text-text-secondary/70'}`}>
        {count}
      </span>
    </button>
  );
}

function FilterChip({ active, onClick, label, count }: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 flex items-center gap-1 px-2 h-6 rounded text-[10px] font-mono transition-colors ${
        active
          ? 'bg-accent/20 text-accent border border-accent/40'
          : 'text-text-secondary hover:text-text border border-border-light'
      }`}
    >
      {label}
      {count != null && <span className={active ? 'text-accent/70' : 'text-text-secondary/70'}>{count}</span>}
    </button>
  );
}
