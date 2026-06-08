// ─────────────────────────────────────────────────────────────────
// 顶栏 QuickJump (Ctrl+P / Ctrl+E)
// - 扁平化文件树 + 模糊匹配
// - 键盘导航 (↑↓ / ↵ / Esc)
// - 跳到文件并自动聚焦到代码编辑器
// ─────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, useMemo } from 'react';
import type { FileNode } from '../../types';
import { pushToast } from './Notifications';
import { Kbd } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
  tree: FileNode;
  onJumpToFile: (path: string) => void;
}

interface FileEntry {
  path: string;
  name: string;
  dir: string;
  ext: string;
  depth: number;
}

// 模糊匹配评分
function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800;
  if (t.includes(q)) return 600;
  // 字符级 fuzzy
  let qi = 0, score = 0, prevHit = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 10 - Math.min(5, Math.max(0, ti - prevHit - 1)) * 2;
      prevHit = ti;
      qi++;
    }
  }
  return qi === q.length ? score : 0;
}

export function QuickJump({ open, onClose, tree, onJumpToFile }: Props) {
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

  // 扁平化文件树
  const allFiles = useMemo(() => {
    const out: FileEntry[] = [];
    const walk = (n: FileNode, depth: number) => {
      if (n.type === 'file') {
        const parts = n.path.split('/').filter(Boolean);
        const name = parts[parts.length - 1] || n.path;
        const ext = name.includes('.') ? name.split('.').pop()! : '';
        const dir = parts.slice(0, -1).join('/');
        out.push({ path: n.path, name, dir, ext, depth });
      }
      n.children?.forEach(c => walk(c, depth + 1));
    };
    walk(tree, 0);
    return out;
  }, [tree]);

  // 搜索结果
  const results = useMemo(() => {
    if (!q.trim()) return allFiles.slice(0, 30);
    const scored = allFiles
      .map(f => ({
        ...f,
        score: Math.max(
          fuzzyScore(q, f.name),
          fuzzyScore(q, f.path) * 0.6
        ),
      }))
      .filter(f => f.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
    return scored;
  }, [allFiles, q]);

  useEffect(() => { setIdx(0); }, [q]);

  const select = (f: FileEntry) => {
    onJumpToFile(f.path);
    pushToast({ level: 'success', title: '已跳到文件', message: f.path, duration: 2200 });
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[idx]) select(results[idx]); }
    else if (e.key === 'Escape') onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-[12vh] bg-black/40 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[600px] max-w-[92vw] bg-surface border border-border rounded-xl shadow-2xl overflow-hidden animate-slide-in-up"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 h-11 border-b border-border">
          <span className="material-symbols-outlined text-text-secondary text-base">electric_bolt</span>
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="按文件名跳到任何文件..."
            className="flex-1 bg-transparent outline-none text-sm text-text placeholder-text-secondary"
          />
          <span className="text-[10px] text-text-secondary/70 font-mono shrink-0">
            {results.length} / {allFiles.length}
          </span>
          <Kbd>ESC</Kbd>
        </div>

        <div className="max-h-[55vh] overflow-y-auto scrollbar-thin">
          {results.length === 0 ? (
            <div className="px-4 py-12 text-center text-text-secondary">
              <span className="material-symbols-outlined text-3xl mb-2 opacity-40">search_off</span>
              <p className="text-xs">没有匹配的文件</p>
            </div>
          ) : (
            <ul>
              {results.map((f, i) => {
                const active = i === idx;
                return (
                  <li
                    key={f.path}
                    onClick={() => select(f)}
                    onMouseEnter={() => setIdx(i)}
                    className={`flex items-center gap-2 px-3 h-9 text-xs cursor-pointer ${
                      active ? 'bg-primary-container/30 text-text' : 'text-text-secondary hover:bg-surface-high'
                    }`}
                  >
                    <span className="material-symbols-outlined text-base text-text-secondary">description</span>
                    <span className={`flex-1 truncate font-mono ${active ? 'text-text font-medium' : ''}`}>
                      {highlight(f.name, q)}
                    </span>
                    <span className="text-[10px] text-text-secondary/60 font-mono shrink-0 max-w-[180px] truncate">
                      {f.dir || '/'}
                    </span>
                    {f.ext && (
                      <span className="px-1.5 py-0.5 text-[9px] rounded bg-bg-dim text-text-secondary font-mono uppercase">
                        {f.ext}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between px-3 h-8 bg-bg-dim border-t border-border text-[10px] text-text-secondary">
          <div className="flex items-center gap-2.5">
            <span className="flex items-center gap-1"><Kbd>↑↓</Kbd>选择</span>
            <span className="flex items-center gap-1"><Kbd>↵</Kbd>跳转</span>
            <span className="flex items-center gap-1"><Kbd>ESC</Kbd>关闭</span>
          </div>
          <span className="flex items-center gap-1">
            <span className="material-symbols-outlined text-[10px]">bolt</span>
            QuickJump
          </span>
        </div>
      </div>
    </div>
  );
}

// 高亮匹配片段
function highlight(text: string, q: string): React.ReactNode {
  if (!q.trim()) return text;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const found = lower.indexOf(ql, i);
    if (found === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (found > i) parts.push(text.slice(i, found));
    parts.push(
      <span key={found} className="text-primary font-bold">
        {text.slice(found, found + ql.length)}
      </span>
    );
    i = found + ql.length;
  }
  return parts;
}
