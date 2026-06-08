// ─────────────────────────────────────────────────────────────────
// 快捷键自定义编辑器
// - 按组合分组列出全部默认快捷键
// - 单击 "录制" 进入 capture 模式 (捕获下一个按键)
// - 检测冲突 (与现有快捷键),自动警告
// - 支持单条重置 + 一键全部重置
// - 持久化通过 useKeybindingStore
// ─────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useMemo } from 'react';
import { useKeybindings, formatKeyCombo, eventToCombo, DEFAULT_BINDINGS, type Keybinding, type KeyCombo } from '../../hooks/useKeybindingStore';
import { pushToast } from '../overlays/Notifications';
import { Tooltip, Button, IconButton } from '../ui/Button';

const EXPORT_VERSION = 1;

const GROUP_LABELS: Record<Keybinding['group'], { label: string; icon: string }> = {
  视图: { label: '视图切换',  icon: 'visibility' },
  导航: { label: '导航跳转',  icon: 'explore' },
  会话: { label: '会话操作',  icon: 'forum' },
  工具: { label: '系统工具',  icon: 'build' },
  布局: { label: '布局调整',  icon: 'dashboard' },
};

export function KeybindingEditor() {
  const { bindings, setBinding, resetBinding, resetAll, isConflict } = useKeybindings();
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [previewImport, setPreviewImport] = useState<{ keys: Record<string, KeyCombo>; count: number; conflicts: string[] } | null>(null);
  const captureRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 进入 capture 模式: 监听下一次 keydown
  useEffect(() => {
    if (!captureId) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCaptureId(null);
        return;
      }
      const c = eventToCombo(e);
      if (!c.key) return;  // 仅修饰键不算
      const conflict = isConflict(c, captureId);
      if (conflict) {
        pushToast({
          level: 'warning',
          title: '快捷键冲突',
          message: `${formatKeyCombo(c)} 已被「${conflict.description}」占用`,
          duration: 3000,
        });
        return;
      }
      setBinding(captureId, c);
      pushToast({
        level: 'success',
        title: '快捷键已更新',
        message: formatKeyCombo(c),
        duration: 1500,
      });
      setCaptureId(null);
    };
    // capture 模式: 用 addEventListener (key 不通过 React 冒泡)
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [captureId, isConflict, setBinding]);

  // 点击外部取消录制
  useEffect(() => {
    if (!captureId) return;
    const onClick = (e: MouseEvent) => {
      if (captureRef.current && !captureRef.current.contains(e.target as Node)) {
        setCaptureId(null);
      }
    };
    setTimeout(() => {
      window.addEventListener('mousedown', onClick);
    }, 0);
    return () => window.removeEventListener('mousedown', onClick);
  }, [captureId]);

  // 按组 + 过滤
  const groups = useMemo(() => {
    const byGroup: Record<string, Keybinding[]> = {};
    const q = query.trim().toLowerCase();
    bindings
      .filter(b =>
        !q ||
        b.description.toLowerCase().includes(q) ||
        b.id.toLowerCase().includes(q) ||
        formatKeyCombo(b.combo).toLowerCase().includes(q)
      )
      .forEach(b => {
        if (!byGroup[b.group]) byGroup[b.group] = [];
        byGroup[b.group].push(b);
      });
    return byGroup;
  }, [bindings, query]);

  const totalCount = bindings.length;
  const customizedCount = bindings.filter(b => {
    const orig = DEFAULT_BINDINGS.find(d => d.id === b.id);
    return orig && (
      orig.combo.key !== b.combo.key ||
      !!orig.combo.ctrl !== !!b.combo.ctrl ||
      !!orig.combo.shift !== !!b.combo.shift ||
      !!orig.combo.alt !== !!b.combo.alt ||
      !!orig.combo.meta !== !!b.combo.meta
    );
  }).length;

  const isCustomized = (b: Keybinding) => {
    const orig = DEFAULT_BINDINGS.find(d => d.id === b.id);
    if (!orig) return false;
    return (
      orig.combo.key !== b.combo.key ||
      !!orig.combo.ctrl !== !!b.combo.ctrl ||
      !!orig.combo.shift !== !!b.combo.shift ||
      !!orig.combo.alt !== !!b.combo.alt ||
      !!orig.combo.meta !== !!b.combo.meta
    );
  };

  // ─── 导出 ───
  const handleExport = (download: boolean) => {
    const overrides: Record<string, KeyCombo> = {};
    bindings.forEach(b => {
      if (isCustomized(b)) overrides[b.id] = b.combo;
    });
    const payload = {
      __type: 'soloforge-keybindings',
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      totalBindings: bindings.length,
      customizedCount: customizedCount,
      overrides,
    };
    const json = JSON.stringify(payload, null, 2);
    if (download) {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `soloforge-keybindings-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      pushToast({ level: 'success', title: '已导出', message: `${customizedCount} 项自定义`, duration: 1500 });
    } else {
      navigator.clipboard?.writeText(json).then(() => {
        pushToast({ level: 'success', title: '已复制到剪贴板', message: `${customizedCount} 项`, duration: 1500 });
      });
    }
  };

  // ─── 导入: 解析 + 预览 ───
  const handleImportFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const obj = JSON.parse(String(e.target?.result));
        if (obj.__type !== 'soloforge-keybindings') {
          throw new Error('不是 SoloForge 快捷键文件 (缺少 __type 标识)');
        }
        if (typeof obj.version !== 'number' || obj.version > EXPORT_VERSION) {
          throw new Error(`版本不兼容: 期望 ≤${EXPORT_VERSION}, 收到 ${obj.version}`);
        }
        if (typeof obj.overrides !== 'object' || obj.overrides === null) {
          throw new Error('文件缺少 overrides 字段');
        }
        // 校验: 所有 id 必须存在于 DEFAULT_BINDINGS
        const validIds = new Set(DEFAULT_BINDINGS.map(d => d.id));
        const conflicts: string[] = [];
        const validKeys: Record<string, KeyCombo> = {};
        for (const [id, combo] of Object.entries(obj.overrides)) {
          if (!validIds.has(id)) continue;
          const c = combo as KeyCombo;
          if (typeof c.key !== 'string') continue;
          validKeys[id] = c;
        }
        // 检查冲突 (merge 模式): 与当前未在导入中的 binding 冲突
        if (importMode === 'merge') {
          for (const [id, combo] of Object.entries(validKeys)) {
            const conflict = isConflict(combo, id);
            if (conflict) conflicts.push(`${id} (→ ${conflict.description})`);
          }
        }
        setPreviewImport({ keys: validKeys, count: Object.keys(validKeys).length, conflicts });
        pushToast({ level: 'info', title: '解析完成', message: `${Object.keys(validKeys).length} 项可导入`, duration: 2000 });
      } catch (err: any) {
        pushToast({ level: 'error', title: '导入失败', message: err.message, duration: 3000 });
      }
    };
    reader.readAsText(file);
  };

  const applyImport = () => {
    if (!previewImport) return;
    if (importMode === 'replace') {
      // 先 reset all
      resetAll();
    }
    let applied = 0;
    for (const [id, combo] of Object.entries(previewImport.keys)) {
      setBinding(id, combo);
      applied++;
    }
    setPreviewImport(null);
    pushToast({ level: 'success', title: '已应用', message: `${applied} 项${importMode === 'replace' ? ' (覆盖)' : ' (合并)'}`, duration: 2000 });
  };

  return (
    <div className="space-y-4" ref={captureRef}>
      {/* 顶栏: 搜索 + 统计 + 重置 */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary text-sm pointer-events-none">
            search
          </span>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索快捷键 (描述/绑定/ID)..."
            className="w-full pl-7 pr-7 h-8 bg-bg-dim border border-border-light text-xs text-text rounded
              focus:outline-none focus:border-primary placeholder-text-secondary"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 material-symbols-outlined text-text-secondary hover:text-text text-sm"
            >close</button>
          )}
        </div>
        <span className="text-[10px] text-text-secondary font-mono whitespace-nowrap">
          {totalCount} 总数 · {customizedCount} 已自定义
        </span>
        <Tooltip content="导入 .keybindings.json">
          <IconButton icon="upload" size="sm" onClick={() => fileInputRef.current?.click()} />
        </Tooltip>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleImportFile(f);
            e.target.value = '';
          }}
        />
        <Tooltip content="复制 JSON 到剪贴板">
          <IconButton icon="content_copy" size="sm" onClick={() => handleExport(false)} disabled={customizedCount === 0} />
        </Tooltip>
        <Tooltip content="下载 .keybindings.json">
          <IconButton icon="download" size="sm" onClick={() => handleExport(true)} disabled={customizedCount === 0} />
        </Tooltip>
        <Button
          variant="ghost"
          size="sm"
          icon="restart_alt"
          disabled={customizedCount === 0}
          onClick={() => {
            if (confirm(`重置全部 ${totalCount} 个快捷键为默认值?`)) {
              resetAll();
              pushToast({ level: 'info', title: '已重置为默认', duration: 1500 });
            }
          }}
        >
          全部重置
        </Button>
      </div>

      {/* capture 模式提示条 */}
      {captureId && (
        <div className="flex items-center gap-2 px-3 py-2 rounded bg-warning/10 border border-warning/30 text-xs">
          <span className="material-symbols-outlined text-warning animate-pulse text-base">keyboard</span>
          <span className="text-warning font-semibold">录制中</span>
          <span className="text-text-secondary">·</span>
          <span className="text-text">请按新的组合键 (按 Esc 取消)</span>
          <div className="flex-1" />
          <span className="text-[10px] text-text-secondary/70 font-mono">
            「{bindings.find(b => b.id === captureId)?.description}」
          </span>
        </div>
      )}

      {/* 分组列表 */}
      {Object.keys(groups).length === 0 ? (
        <div className="text-center py-8 text-text-secondary text-xs">
          <span className="material-symbols-outlined text-2xl opacity-40 block mb-1">search_off</span>
          无匹配快捷键
        </div>
      ) : (
        Object.entries(groups).map(([group, items]) => {
          const meta = GROUP_LABELS[group as Keybinding['group']];
          return (
            <div key={group}>
              <div className="flex items-center gap-1.5 mb-1.5 text-[10px] font-semibold text-text-secondary uppercase tracking-wider">
                <span className="material-symbols-outlined text-xs">{meta?.icon || 'tag'}</span>
                {meta?.label || group}
                <span className="text-text-secondary/50">· {items.length}</span>
              </div>
              <div className="space-y-1">
                {items.map(b => (
                  <BindingRow
                    key={b.id}
                    binding={b}
                    customized={isCustomized(b)}
                    capturing={captureId === b.id}
                    onStartCapture={() => setCaptureId(b.id)}
                    onReset={() => {
                      resetBinding(b.id);
                      pushToast({ level: 'info', title: '已重置单条', message: b.description, duration: 1500 });
                    }}
                  />
                ))}
              </div>
            </div>
          );
        })
      )}

      {/* 提示 */}
      <div className="text-[10px] text-text-secondary/70 leading-relaxed p-2 bg-bg-dim rounded">
        <strong>使用说明：</strong>点击「录制」按钮后,下一次按键将绑定到该功能。
        系统会检测冲突 — 已占用的组合会提示但不会覆盖。
        所有更改即时生效并持久化到 <code className="px-1 rounded bg-surface border border-border-light">localStorage</code>。
        顶部「上传/下载」按钮可与团队分享键位方案 (格式 <code className="px-1 rounded bg-surface border border-border-light">.keybindings.json</code>)。
      </div>

      {/* 导入预览 */}
      {previewImport && (
        <div
          className="fixed inset-0 z-[260] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in p-4"
          onClick={() => setPreviewImport(null)}
        >
          <div
            className="w-[520px] max-w-[90vw] bg-surface border border-border rounded-xl shadow-2xl overflow-hidden animate-slide-in-up"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 h-10 border-b border-border">
              <span className="material-symbols-outlined text-primary">upload</span>
              <h3 className="text-sm font-semibold text-text">导入快捷键</h3>
              <span className="text-[10px] text-text-secondary font-mono">· {previewImport.count} 项</span>
              <div className="flex-1" />
              <button onClick={() => setPreviewImport(null)} className="material-symbols-outlined text-text-secondary hover:text-text">close</button>
            </div>
            <div className="p-3 space-y-3">
              {/* 模式选择 */}
              <div className="flex items-center gap-1 p-0.5 rounded bg-bg-dim border border-border-light w-fit">
                {(['merge', 'replace'] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => setImportMode(m)}
                    className={`px-2.5 h-6 text-[10px] rounded font-mono ${
                      importMode === m ? 'bg-primary text-on-primary' : 'text-text-secondary hover:text-text'
                    }`}
                  >
                    {m === 'merge' ? '合并 (保留现有)' : '覆盖 (全部替换)'}
                  </button>
                ))}
              </div>

              {/* 冲突警告 */}
              {previewImport.conflicts.length > 0 && importMode === 'merge' && (
                <div className="rounded bg-warning/10 border border-warning/30 p-2 text-[11px] text-warning">
                  <div className="flex items-center gap-1 mb-1 font-semibold">
                    <span className="material-symbols-outlined text-sm">warning</span>
                    {previewImport.conflicts.length} 项与现有快捷键冲突
                  </div>
                  <div className="text-text-secondary text-[10px] max-h-20 overflow-y-auto">
                    {previewImport.conflicts.slice(0, 5).map((c, i) => <div key={i}>• {c}</div>)}
                    {previewImport.conflicts.length > 5 && <div>· 还有 {previewImport.conflicts.length - 5} 项...</div>}
                  </div>
                </div>
              )}

              {/* 列表 */}
              <div className="max-h-[40vh] overflow-y-auto scrollbar-thin space-y-0.5">
                {Object.entries(previewImport.keys).map(([id, combo]) => {
                  const def = DEFAULT_BINDINGS.find(d => d.id === id);
                  if (!def) return null;
                  return (
                    <div key={id} className="flex items-center gap-2 px-2 py-1 rounded bg-bg-dim/40 text-[11px]">
                      <span className="text-text truncate flex-1">{def.description}</span>
                      <span className="text-text-secondary/70 line-through font-mono text-[10px]">{formatKeyCombo(def.combo)}</span>
                      <span className="text-text-secondary">→</span>
                      <code className="px-1.5 py-0.5 rounded bg-primary/15 text-primary border border-primary/30 font-mono text-[10px]">{formatKeyCombo(combo)}</code>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 h-10 bg-bg-dim border-t border-border">
              <Button variant="ghost" size="sm" onClick={() => setPreviewImport(null)}>取消</Button>
              <Button variant="primary" size="sm" icon="check" onClick={applyImport}>应用 {previewImport.count} 项</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BindingRow({
  binding, customized, capturing, onStartCapture, onReset,
}: {
  binding: Keybinding;
  customized: boolean;
  capturing: boolean;
  onStartCapture: () => void;
  onReset: () => void;
}) {
  const display = formatKeyCombo(binding.combo);
  return (
    <div
      className={`group flex items-center gap-2 p-2 rounded transition-colors ${
        capturing
          ? 'bg-warning/10 border border-warning/40'
          : customized
            ? 'bg-primary/5 border border-primary/20'
            : 'bg-bg-dim border border-transparent'
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-text">{binding.description}</span>
          {customized && (
            <Tooltip content="已自定义">
              <span className="material-symbols-outlined text-xs text-primary">edit</span>
            </Tooltip>
          )}
        </div>
        <code className="text-[10px] text-text-secondary/70 font-mono">{binding.id}</code>
      </div>
      {/* 组合键可视化 */}
      <div className="flex items-center gap-1">
        {display.split('+').map((k, i) => (
          <span key={i} className="inline-flex items-center px-1.5 h-6 min-w-[22px] justify-center rounded border border-border bg-surface text-text font-mono text-[10px]">
            {k}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-0.5">
        {customized ? (
          <Tooltip content="恢复默认">
            <IconButton
              icon="restart_alt"
              size="xs"
              onClick={onReset}
            />
          </Tooltip>
        ) : null}
        <Button
          variant={capturing ? 'primary' : 'ghost'}
          size="sm"
          icon={capturing ? 'stop_circle' : 'keyboard'}
          onClick={onStartCapture}
        >
          {capturing ? '录制中' : '录制'}
        </Button>
      </div>
    </div>
  );
}
