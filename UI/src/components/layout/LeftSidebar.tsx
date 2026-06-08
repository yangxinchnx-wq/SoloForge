// ─────────────────────────────────────────────────────────────────
// 左侧双面板：资源管理 + 代码编辑器
// 分屏/单屏切换 + 面包屑 + 可拖拽分隔
// ─────────────────────────────────────────────────────────────────

import { useState, useRef, useEffect } from 'react';
import { useResources } from '../../hooks/useResources';
import { FileTree } from '../resources/FileTree';
import { CodeEditor } from '../editor/CodeEditor';
import { Terminal } from '../terminal/Terminal';
import { Button, IconButton, Tabs, Badge, Tooltip } from '../ui/Button';
import { GitPanel, SearchPanel, DebugPanel, CourtPanel, AgentsPanel } from './SidePanels';

interface Props {
  resources: ReturnType<typeof useResources>;
  activity: string;
}

type LeftMode = 'split' | 'tree' | 'editor';

export function LeftSidebar({ resources, activity }: Props) {
  const [mode, setMode] = useState<LeftMode>('split');
  const [ratio, setRatio] = useState(0.45);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef(false);

  // 跟随 Activity 切换默认模式
  useEffect(() => {
    if (activity === 'explorer') setMode('split');
    else if (activity === 'search') setMode('tree');
    else if (activity === 'git') setMode('tree');
  }, [activity]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current || !containerRef.current) return;
      const r = containerRef.current.getBoundingClientRect();
      const y = e.clientY - r.top;
      setRatio(Math.max(0.15, Math.min(0.85, y / r.height)));
    };
    const onUp = () => { dragRef.current = false; document.body.style.cursor = ''; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const tabs = [
    { id: 'split',  label: '分屏', icon: 'view_column' },
    { id: 'tree',   label: '资源', icon: 'account_tree' },
    { id: 'editor', label: '编辑器', icon: 'code' },
  ];

  return (
    <aside className="flex-1 min-w-0 flex flex-col border-r border-border bg-bg-dim">
      {/* 模式切换 + 面包屑 */}
      <div className="flex flex-col bg-surface border-b border-border shrink-0">
        <div className="flex items-center px-2 h-9 gap-2">
          <Tabs
            tabs={tabs}
            active={mode}
            onChange={id => setMode(id as LeftMode)}
            variant="pill"
          />
          <div className="flex-1" />
          <Tooltip content="新建文件">
            <IconButton icon="note_add" size="sm" />
          </Tooltip>
          <Tooltip content="新建文件夹">
            <IconButton icon="create_new_folder" size="sm" />
          </Tooltip>
          <Tooltip content="刷新文件树">
            <IconButton icon="refresh" size="sm" onClick={resources.resetTree} />
          </Tooltip>
        </div>
        <Breadcrumb path={resources.activeFile} onNavigate={resources.setActiveFile} />
      </div>

      <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden relative">
        {activity === 'git' ? (
          <GitPanel />
        ) : activity === 'search' ? (
          <SearchPanel resources={resources} />
        ) : activity === 'debug' ? (
          <DebugPanel />
        ) : activity === 'court' ? (
          <CourtPanel />
        ) : activity === 'agents' ? (
          <AgentsPanel />
        ) : activity === 'terminal' ? (
          <Terminal />
        ) : (
          <>
            {mode === 'split' && (
              <>
                <div style={{ height: `${ratio * 100}%` }} className="overflow-hidden shrink-0">
                  <FileTree resources={resources} />
                </div>
                <div
                  onMouseDown={() => { dragRef.current = true; document.body.style.cursor = 'row-resize'; }}
                  className="h-1 bg-border-light hover:bg-primary cursor-row-resize shrink-0 relative group"
                >
                  <div className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <div className="w-8 h-0.5 rounded bg-text-secondary" />
                    <div className="w-8 h-0.5 rounded bg-text-secondary" />
                  </div>
                </div>
                <div className="flex-1 overflow-hidden">
                  <CodeEditor resources={resources} />
                </div>
              </>
            )}
            {mode === 'tree' && (
              <div className="flex-1 overflow-hidden">
                <FileTree resources={resources} />
              </div>
            )}
            {mode === 'editor' && (
              <div className="flex-1 overflow-hidden">
                <CodeEditor resources={resources} />
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function Breadcrumb({ path, onNavigate }: { path: string; onNavigate: (p: string) => void }) {
  if (!path) return null;
  const parts = path.split('/').filter(Boolean);
  let acc = '';
  return (
    <div className="flex items-center gap-0.5 px-2 pb-1.5 text-[11px] font-mono text-text-secondary overflow-x-auto scrollbar-hide">
      <button onClick={() => onNavigate('/')} className="hover:text-text shrink-0">
        <span className="material-symbols-outlined text-xs align-middle">home</span>
      </button>
      {parts.map((p, i) => {
        acc += '/' + p;
        const isLast = i === parts.length - 1;
        return (
          <span key={i} className="flex items-center gap-0.5 shrink-0">
            <span className="material-symbols-outlined text-[10px] text-text-secondary/50">chevron_right</span>
            <button
              onClick={() => onNavigate(acc)}
              className={`px-1 rounded ${isLast ? 'text-text font-semibold' : 'hover:text-text'}`}
            >
              {p}
            </button>
          </span>
        );
      })}
    </div>
  );
}
