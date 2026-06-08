// ─────────────────────────────────────────────────────────────────
// 资源管理：文件树
// - 文件/文件夹图标
// - Git 状态徽标 (M/A/U/D/?)
// - 右键上下文菜单
// - 拖拽支持
// - 过滤 / 展开 / 折叠
// ─────────────────────────────────────────────────────────────────

import { useState, useRef, useEffect } from 'react';
import type { useResources } from '../../hooks/useResources';
import { PanelHeader, IconButton, Tooltip } from '../ui/Button';
import { pushToast } from '../overlays/Notifications';

interface Props {
  resources: ReturnType<typeof useResources>;
}

const ICON_MAP: Record<string, string> = {
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code',
  rs: 'memory',
  py: 'code',
  json: 'data_object', toml: 'settings', yaml: 'settings', yml: 'settings',
  sql: 'storage', surql: 'storage',
  md: 'description', txt: 'article',
};

const GIT_STATUS: Record<string, { color: string; label: string }> = {
  M: { color: 'text-warning', label: '已修改' },
  A: { color: 'text-success', label: '新增' },
  D: { color: 'text-danger',  label: '已删除' },
  U: { color: 'text-accent',  label: '未跟踪' },
  C: { color: 'text-text-secondary', label: '冲突' },
};

// 模拟每个文件的 git 状态（demo 用）
const GIT_STATES: Record<string, string> = {
  '/src/index.ts': 'M',
  '/src/api-server.ts': 'M',
  '/src/kernel/runtime-kernel.ts': 'M',
  '/src/core/court/consensagent.ts': '',
  '/src/data/repositories/surreal-repositories.ts': 'U',
  '/rust_core/src/scheduler.rs': 'A',
  '/python/mappo_server.py': '',
  '/migrations/v5_events.surql': 'M',
  '/package.json': '',
};

export function FileTree({ resources }: Props) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string; type: 'file' | 'folder' } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = () => setContextMenu(null);
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, []);

  const expandAll = () => {
    const expand = (n: { id: string; type: string; children?: any[] }, all: Record<string, boolean> = {}) => {
      if (n.type === 'folder') {
        all[n.id] = true;
        n.children?.forEach(c => expand(c, all));
      }
      return all;
    };
    const all = expand(resources.tree);
    resources.setExpanded(all);
  };

  const collapseAll = () => resources.setExpanded({ root: true });

  return (
    <div className="flex flex-col h-full relative">
      <PanelHeader
        icon="account_tree"
        title="资源管理"
        count={`${countFiles(resources.tree)} 文件 · ${countFolders(resources.tree)} 目录`}
        action={
          <div className="flex items-center gap-1">
            <Tooltip content="全部展开">
              <IconButton icon="unfold_more" size="xs" onClick={expandAll} />
            </Tooltip>
            <Tooltip content="全部折叠">
              <IconButton icon="unfold_less" size="xs" onClick={collapseAll} />
            </Tooltip>
            <Tooltip content="新建">
              <IconButton icon="add" size="xs" />
            </Tooltip>
          </div>
        }
      />

      {/* 搜索框 */}
      <div className="px-2 py-1.5 bg-surface-low border-b border-border-light">
        <div className="relative">
          <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary text-sm pointer-events-none">
            search
          </span>
          <input
            value={resources.filter}
            onChange={e => resources.setFilter(e.target.value)}
            placeholder="搜索文件..."
            className="w-full pl-7 pr-7 h-7 bg-surface border border-border-light text-text text-[11px]
              rounded focus:outline-none focus:border-primary placeholder-text-secondary"
          />
          {resources.filter && (
            <button
              onClick={() => resources.setFilter('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 material-symbols-outlined text-text-secondary hover:text-text text-sm"
            >close</button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1 scrollbar-thin">
        {resources.flat.length === 0 ? (
          <div className="px-3 py-4 text-xs text-text-secondary text-center">
            无匹配文件
          </div>
        ) : (
          resources.flat.map(({ node, depth }) => {
            const isActive = node.type === 'file' && node.path === resources.activeFile;
            const isFolder = node.type === 'folder';
            const isOpen = resources.expanded[node.id];
            const ext = node.name.split('.').pop() || '';
            const icon = isFolder
              ? (isOpen ? 'folder_open' : 'folder')
              : (ICON_MAP[ext] || 'description');
            const gitState = GIT_STATES[node.path] || '';
            const gitInfo = gitState ? GIT_STATUS[gitState] : null;

            return (
              <div
                key={node.id}
                onClick={() => {
                  if (isFolder) resources.toggle(node.id);
                  else resources.setActiveFile(node.path);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, path: node.path, type: node.type as any });
                }}
                className={`group flex items-center gap-1.5 pr-2 py-1 text-[11px] cursor-pointer transition-colors ${
                  isActive ? 'bg-primary-container text-on-primary-container' : 'hover:bg-surface-high text-text'
                }`}
                style={{ paddingLeft: 8 + depth * 12 }}
              >
                {isFolder ? (
                  <span className={`material-symbols-outlined text-xs shrink-0 transition-transform ${isOpen ? 'rotate-0' : '-rotate-90'}`}>
                    expand_more
                  </span>
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <span className={`material-symbols-outlined text-sm shrink-0 ${
                  isFolder ? 'text-primary' : (isActive ? 'filled' : 'text-text-secondary')
                }`}>{icon}</span>
                <span className="truncate flex-1">{node.name}</span>
                {gitInfo && (
                  <span className={`text-[10px] font-bold font-mono ${gitInfo.color}`} title={gitInfo.label}>
                    {gitState}
                  </span>
                )}
                {node.size != null && !gitInfo && (
                  <span className="text-[9px] text-text-secondary/70 font-mono opacity-0 group-hover:opacity-100">
                    {formatSize(node.size)}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* 上下文菜单 */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            ...(contextMenu.type === 'file' ? [
              { id: 'open',      icon: 'open_in_new',     label: '打开',         onClick: () => resources.setActiveFile(contextMenu.path) },
              { id: 'open-side', icon: 'open_in_new_down',label: '侧边打开',     onClick: () => resources.setActiveFile(contextMenu.path) },
              { id: 'reveal',    icon: 'folder_open',     label: '在文件管理器中显示', onClick: () => pushToast({ level: 'info', title: '在文件管理器中显示', message: contextMenu.path, duration: 1500 }) },
              { divider: true, id: '', label: '' },
            ] : []),
            { id: 'rename', icon: 'edit',         label: '重命名 (F2)',          onClick: () => pushToast({ level: 'info', title: '重命名', message: contextMenu.path, duration: 1500 }) },
            { id: 'copy-path', icon: 'content_copy', label: '复制路径',            onClick: () => { navigator.clipboard?.writeText(contextMenu.path); pushToast({ level: 'success', title: '路径已复制', message: contextMenu.path, duration: 1500 }); } },
            { id: 'copy-name', icon: 'short_text',   label: '复制文件名',          onClick: () => { const name = contextMenu.path.split('/').pop() || ''; navigator.clipboard?.writeText(name); pushToast({ level: 'success', title: '文件名已复制', message: name, duration: 1500 }); } },
            { id: 'copy-relative', icon: 'link',    label: '复制为相对路径',      onClick: () => { const rel = contextMenu.path.replace(/^\//, ''); navigator.clipboard?.writeText(rel); pushToast({ level: 'success', title: '已复制', message: rel, duration: 1500 }); } },
            { divider: true, id: '', label: '' },
            { id: 'move',  icon: 'drive_file_move', label: '移动...',              onClick: () => pushToast({ level: 'info', title: '移动', duration: 1500 }) },
            { id: 'cut',   icon: 'content_cut',     label: '剪切',                 onClick: () => pushToast({ level: 'info', title: '已剪切', duration: 1500 }) },
            { id: 'paste', icon: 'content_paste',   label: '粘贴', disabled: true,  onClick: () => {} },
            { divider: true, id: '', label: '' },
            { id: 'terminal', icon: 'terminal',     label: '在终端打开',           onClick: () => pushToast({ level: 'info', title: '在终端打开', message: contextMenu.path, duration: 1500 }) },
            { id: 'history',  icon: 'history',      label: '查看历史',             onClick: () => pushToast({ level: 'info', title: '查看历史', message: contextMenu.path, duration: 1500 }) },
            { id: 'git',      icon: 'commit',       label: 'Git blame',            onClick: () => pushToast({ level: 'info', title: 'Git blame', message: contextMenu.path, duration: 1500 }) },
            { divider: true, id: '', label: '' },
            { id: 'copy',  icon: 'file_copy',      label: '复制为...',            onClick: () => pushToast({ level: 'info', title: '复制为', duration: 1500 }) },
            { id: 'del',   icon: 'delete',         label: '删除', danger: true,   onClick: () => { if (confirm(`确认删除 ${contextMenu.path}?`)) pushToast({ level: 'warning', title: '已删除', message: contextMenu.path, duration: 1800 }); } },
          ]}
        />
      )}
    </div>
  );
}

// 简单的内嵌菜单组件 (与外部的 ContextMenu 不同, 这里只用 static)
function ContextMenu({ x, y, onClose, items }: { x: number; y: number; onClose: () => void; items: Array<any> }) {
  return (
    <div
      style={{ left: x, top: y }}
      className="fixed z-[250] w-48 bg-surface border border-border rounded-lg shadow-2xl py-1 animate-fade-in"
      onMouseDown={e => e.stopPropagation()}
      onClick={onClose}
    >
      {items.map((it, i) => {
        if (it.divider) return <div key={i} className="h-px bg-border-light my-1 mx-1" />;
        return (
          <button
            key={it.id || i}
            disabled={it.disabled}
            onClick={it.onClick}
            className={`w-full flex items-center gap-2 px-2.5 h-7 text-[11px] text-left transition-colors ${
              it.disabled
                ? 'text-text-secondary/40 cursor-not-allowed'
                : it.danger
                  ? 'text-danger hover:bg-danger/10'
                  : 'text-text hover:bg-surface-high'
            }`}
          >
            {it.icon && <span className={`material-symbols-outlined text-sm ${it.danger ? 'text-danger' : 'text-text-secondary'}`}>{it.icon}</span>}
            <span className="flex-1 truncate">{it.label}</span>
            {it.shortcut && <span className="text-[9px] text-text-secondary/70 font-mono shrink-0">{it.shortcut}</span>}
          </button>
        );
      })}
    </div>
  );
}

function formatSize(b: number) {
  if (b < 1024) return `${b}B`;
  return `${(b / 1024).toFixed(1)}K`;
}

function countFiles(n: { type: string; children?: any[] }): number {
  if (n.type === 'file') return 1;
  return (n.children || []).reduce((s, c) => s + countFiles(c), 0);
}
function countFolders(n: { type: string; children?: any[] }): number {
  if (n.type === 'folder') return 1 + (n.children || []).reduce((s, c) => s + countFolders(c), 0);
  return 0;
}
