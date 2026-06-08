// ─────────────────────────────────────────────────────────────────
// 全局搜索 (Ctrl+Shift+F)
// - 跨文件树搜索内容
// - 正则 / 区分大小写 / 整词匹配
// - 替换功能
// - 结果按文件分组，点击跳转到文件
// ─────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, useMemo } from 'react';
import type { FileNode } from '../../types';
import { pushNotification } from './Notifications';
import { Button, IconButton, Tooltip, Badge } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
  tree: FileNode;
  onJumpToFile: (path: string) => void;
  contents: Record<string, string>;
}

interface Match {
  path: string;
  line: number;
  col: number;
  preview: string;
  matchText: string;
}

const MAX_RESULTS = 500;

export function GlobalSearch({ open, onClose, tree, onJumpToFile, contents }: Props) {
  const [q, setQ] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [activeMatch, setActiveMatch] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setReplacement('');
      setActiveMatch(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  // 扁平化文件树
  const flatFiles = useMemo(() => {
    const out: { path: string; name: string }[] = [];
    const walk = (n: FileNode) => {
      if (n.type === 'file') out.push({ path: n.path, name: n.name });
      n.children?.forEach(walk);
    };
    walk(tree);
    return out;
  }, [tree]);

  // 搜索结果
  const results: Match[] = useMemo(() => {
    if (!q.trim()) return [];
    let pattern: RegExp;
    try {
      if (useRegex) {
        pattern = new RegExp(q, caseSensitive ? 'g' : 'gi');
      } else {
        let escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (wholeWord) escaped = `\\b${escaped}\\b`;
        pattern = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
      }
    } catch (e) {
      return [];
    }
    const out: Match[] = [];
    for (const f of flatFiles) {
      const text = contents[f.path];
      if (!text) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // 每次 exec 前重置 lastIndex
        pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(line)) !== null) {
          if (out.length >= MAX_RESULTS) return out;
          out.push({
            path: f.path,
            line: i + 1,
            col: m.index + 1,
            preview: line.trim().slice(0, 200),
            matchText: m[0],
          });
          // 防止零宽匹配死循环
          if (m.index === pattern.lastIndex) pattern.lastIndex++;
        }
      }
    }
    return out;
  }, [q, caseSensitive, wholeWord, useRegex, flatFiles, contents]);

  // 按文件分组
  const grouped = useMemo(() => {
    const g: Record<string, { name: string; matches: Match[] }> = {};
    results.forEach(r => {
      if (!g[r.path]) g[r.path] = { name: r.path.split('/').pop() || r.path, matches: [] };
      g[r.path].matches.push(r);
    });
    return Object.entries(g).sort((a, b) => a[0].localeCompare(b[0]));
  }, [results]);

  useEffect(() => { setActiveMatch(0); }, [q, caseSensitive, wholeWord, useRegex]);

  const regexValid = useMemo(() => {
    if (!useRegex || !q.trim()) return true;
    try { new RegExp(q); return true; } catch { return false; }
  }, [q, useRegex]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (grouped[Math.floor(activeMatch / Math.max(1, results.length / grouped.length))]?.[1].matches[activeMatch % Math.max(1, results.length / grouped.length)]) {
        const m = results[activeMatch];
        if (m) onJumpToFile(m.path);
      } else if (results[activeMatch]) {
        onJumpToFile(results[activeMatch].path);
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'g') {
      e.preventDefault();
      setActiveMatch(i => Math.min(i + 1, results.length - 1));
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'G') {
      e.preventDefault();
      setActiveMatch(i => Math.max(0, i - 1));
    }
  };

  const replaceAll = () => {
    if (!replacement.trim() || !q.trim()) return;
    let pattern: RegExp;
    try {
      if (useRegex) {
        pattern = new RegExp(q, caseSensitive ? 'g' : 'gi');
      } else {
        let escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (wholeWord) escaped = `\\b${escaped}\\b`;
        pattern = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
      }
    } catch {
      pushNotification({ level: 'error', title: '替换失败', message: '正则表达式无效' });
      return;
    }
    const replaceText = useRegex ? replacement : replacement.replace(/\$&/g, q);
    let fileCount = 0;
    let replaceCount = 0;
    const newContents: Record<string, string> = { ...contents };
    for (const f of flatFiles) {
      const text = newContents[f.path];
      if (!text) continue;
      const matches = text.match(pattern);
      if (matches) {
        newContents[f.path] = text.replace(pattern, replaceText);
        fileCount++;
        replaceCount += matches.length;
      }
    }
    pushNotification({
      level: 'success',
      title: '替换完成',
      message: `替换 ${replaceCount} 处 · 涉及 ${fileCount} 个文件`,
    });
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-[8vh] bg-black/40 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[760px] max-w-[95vw] max-h-[80vh] bg-surface border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col animate-slide-in-up"
        onClick={e => e.stopPropagation()}
      >
        {/* 搜索框 */}
        <div className="px-3 py-2 border-b border-border space-y-2">
          <div className="flex items-center gap-2 h-9">
            <span className="material-symbols-outlined text-text-secondary text-lg">search</span>
            <input
              ref={inputRef}
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={onKey}
              placeholder="跨文件搜索... (正则用 /pattern/，整词 \b 包裹)"
              className="flex-1 bg-transparent outline-none text-sm text-text placeholder-text-secondary font-mono"
            />
            <Badge variant="default" className="text-[10px]">{flatFiles.length} 文件</Badge>
            {q.trim() && (
              regexValid
                ? <Badge variant="primary" className="text-[10px]">{results.length} 命中</Badge>
                : <Badge variant="danger" className="text-[10px]">无效正则</Badge>
            )}
            <kbd className="px-1.5 py-0.5 text-[10px] rounded bg-surface-high text-text-secondary border border-border-light">ESC</kbd>
          </div>

          {/* 替换栏 */}
          {showReplace && (
            <div className="flex items-center gap-2 h-9 pl-7 animate-slide-in-up">
              <span className="material-symbols-outlined text-text-secondary text-sm">find_replace</span>
              <input
                value={replacement}
                onChange={e => setReplacement(e.target.value)}
                placeholder="替换为..."
                className="flex-1 bg-transparent outline-none text-sm text-text placeholder-text-secondary font-mono"
              />
              <Button variant="outline" size="xs" icon="done_all" onClick={replaceAll}>全部替换</Button>
            </div>
          )}

          {/* 选项 */}
          <div className="flex items-center gap-1 pl-7">
            <ToggleBtn active={caseSensitive} on={setCaseSensitive} icon="text_fields" label="Aa" title="区分大小写" />
            <ToggleBtn active={wholeWord} on={setWholeWord} icon="separator" label="\\b" title="整词匹配" />
            <ToggleBtn active={useRegex} on={setUseRegex} icon="code" label=".*" title="正则表达式" />
            <button
              onClick={() => setShowReplace(s => !s)}
              className={`flex items-center gap-1 px-2 h-6 rounded text-[10px] transition-colors ${
                showReplace ? 'bg-primary-container text-on-primary-container' : 'text-text-secondary hover:text-text hover:bg-surface-high'
              }`}
            >
              <span className="material-symbols-outlined text-sm">find_replace</span>
              替换
            </button>
            <div className="flex-1" />
            <span className="text-[10px] text-text-secondary font-mono">
              {results.length > 0 ? `${activeMatch + 1} / ${results.length}` : '0 / 0'}
            </span>
            <button
              onClick={() => setActiveMatch(i => Math.max(0, i - 1))}
              disabled={activeMatch === 0}
              className="material-symbols-outlined text-base text-text-secondary hover:text-text disabled:opacity-30"
            >keyboard_arrow_up</button>
            <button
              onClick={() => setActiveMatch(i => Math.min(results.length - 1, i + 1))}
              disabled={activeMatch >= results.length - 1}
              className="material-symbols-outlined text-base text-text-secondary hover:text-text disabled:opacity-30"
            >keyboard_arrow_down</button>
          </div>
        </div>

        {/* 结果 */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {!q.trim() ? (
            <div className="px-4 py-12 text-center text-text-secondary">
              <span className="material-symbols-outlined text-4xl mb-2 opacity-40">manage_search</span>
              <p className="text-xs">输入内容以开始搜索</p>
              <div className="mt-4 flex flex-wrap justify-center gap-2 text-[10px]">
                <KbdHint keys="Enter" desc="跳转到匹配" />
                <KbdHint keys="Ctrl+G" desc="下一项" />
                <KbdHint keys="Ctrl+Shift+G" desc="上一项" />
                <KbdHint keys="ESC" desc="关闭" />
              </div>
            </div>
          ) : grouped.length === 0 ? (
            <div className="px-4 py-12 text-center text-text-secondary">
              <span className="material-symbols-outlined text-4xl mb-2 opacity-40">search_off</span>
              <p className="text-xs">没有找到匹配项</p>
            </div>
          ) : (
            grouped.map(([path, { name, matches }], gi) => {
              let runningIdx = 0;
              return (
                <div key={path} className="border-b border-border-light">
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-high text-[10px]">
                    <span className="material-symbols-outlined text-xs text-primary">description</span>
                    <span className="font-mono text-text font-semibold truncate flex-1" title={path}>{name}</span>
                    <span className="text-text-secondary font-mono">{path}</span>
                    <Badge variant="default" className="text-[9px]">{matches.length}</Badge>
                    <button
                      onClick={() => onJumpToFile(path)}
                      className="material-symbols-outlined text-sm text-text-secondary hover:text-primary"
                      title="打开文件"
                    >open_in_new</button>
                  </div>
                  {matches.map((m) => {
                    const globalIdx = results.indexOf(m);
                    const active = globalIdx === activeMatch;
                    runningIdx++;
                    return (
                      <button
                        key={`${m.line}-${m.col}-${runningIdx}`}
                        onClick={() => { setActiveMatch(globalIdx); onJumpToFile(m.path); }}
                        onMouseEnter={() => setActiveMatch(globalIdx)}
                        className={`w-full flex items-start gap-2 px-3 py-1 text-left text-[11px] font-mono transition-colors ${
                          active ? 'bg-primary-container/40' : 'hover:bg-surface-low'
                        }`}
                      >
                        <span className="text-text-secondary shrink-0 w-10 text-right tabular-nums">{m.line}</span>
                        <span className="text-text flex-1 truncate" dangerouslySetInnerHTML={{
                          __html: highlightMatch(m.preview, m.matchText, useRegex)
                        }} />
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        {/* 底栏 */}
        <div className="flex items-center justify-between px-3 h-9 bg-bg-dim border-t border-border text-[10px] text-text-secondary">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-surface border border-border-light">Enter</kbd>
              跳转
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-surface border border-border-light">Ctrl+G</kbd>
              下一项
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="material-symbols-outlined text-xs">search</span>
            SoloForge 全局搜索
          </div>
        </div>
      </div>
    </div>
  );
}

function ToggleBtn({ active, on, icon, label, title }: { active: boolean; on: (v: boolean) => void; icon: string; label: string; title: string }) {
  return (
    <Tooltip content={title}>
      <button
        onClick={() => on(!active)}
        className={`flex items-center gap-1 px-2 h-6 rounded text-[10px] font-mono transition-colors ${
          active ? 'bg-primary-container text-on-primary-container' : 'text-text-secondary hover:text-text hover:bg-surface-high'
        }`}
      >
        <span className={`material-symbols-outlined text-sm ${active ? 'filled' : ''}`}>{icon}</span>
        {label}
      </button>
    </Tooltip>
  );
}

function KbdHint({ keys, desc }: { keys: string; desc: string }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="px-1 py-0.5 rounded bg-surface border border-border-light font-mono">{keys}</kbd>
      {desc}
    </span>
  );
}

function highlightMatch(preview: string, matchText: string, isRegex: boolean): string {
  if (!matchText) return escapeHtml(preview);
  let escaped;
  try {
    if (isRegex) {
      // 重新构造以转义特殊字符
      escaped = matchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else {
      escaped = matchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  } catch {
    escaped = matchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const re = new RegExp(escaped, 'gi');
  return escapeHtml(preview).replace(re, m => `<mark class="bg-warning/40 text-text rounded px-0.5">${escapeHtml(m)}</mark>`);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}
