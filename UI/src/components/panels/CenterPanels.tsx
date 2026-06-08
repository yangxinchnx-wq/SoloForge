// ─────────────────────────────────────────────────────────────────
// 中央面板 - 文件浏览器 + 文件内容预览
// - 多选（Shift/Ctrl）
// - 拖拽到对话区 → 变成 @引用
// - 文件内容：语法高亮（行号 / 关键字着色）
// - 右键菜单（AI 解释 / 复制 / 重新生成）
// ─────────────────────────────────────────────────────────────────

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { StreamPanel } from './StreamPanel';
import { HistoryPanel } from './HistoryPanel';
import { ChatPanel } from '../chat/ChatPanel';
import { PanelHeader, IconButton, Tooltip, Badge, Button } from '../ui/Button';
import { pushNotification } from '../overlays/Notifications';
import type { useChat } from '../../hooks/useChat';
import type { useResources } from '../../hooks/useResources';

interface Props {
  chat: ReturnType<typeof useChat>;
  resources: ReturnType<typeof useResources>;
  onOpenSettings?: () => void;
}

type CenterTab = 'files' | 'chat' | 'stream' | 'history';

export function CenterPanels({ chat, resources, onOpenSettings }: Props) {
  const [tab, setTab] = useState<CenterTab>('files');
  const [multiSelected, setMultiSelected] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string; type: 'file' | 'folder' } | null>(null);

  // 暴露引用数据给 ChatPanel
  const addToChat = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    // 切到对话 tab 并把引用写入
    setTab('chat');
    chat.attachFiles(paths);
    pushNotification({
      level: 'info',
      title: '已引用文件',
      message: `${paths.length} 个文件已附加到对话区`,      action: { label: '查看', onClick: () => setTab('chat') },
    });
  }, [chat]);

  // 右键菜单全局关闭
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', close); };
  }, [contextMenu]);

  return (
    <section className="flex-1 flex flex-col bg-bg min-w-0 overflow-hidden">
      {/* Tab 切换 */}
      <div className="flex items-center gap-0.5 px-2 h-9 bg-surface border-b border-border shrink-0">
        <TabButton icon="folder_open" label="文件" active={tab === 'files'} onClick={() => setTab('files')} />
        <TabButton icon="stream" label="流送" active={tab === 'stream'} onClick={() => setTab('stream')} badge={chat.stream.length} />
        <TabButton icon="history" label="历史" active={tab === 'history'} onClick={() => setTab('history')} />
        <TabButton icon="chat" label="对话" active={tab === 'chat'} onClick={() => setTab('chat')} />
        <div className="flex-1" />
        {tab === 'files' && multiSelected.length > 0 && (
          <div className="flex items-center gap-1.5 text-[10px] text-primary">
            <span className="flex items-center gap-1">
              <span className="material-symbols-outlined text-xs filled">check_box</span>
              <span className="font-mono">{multiSelected.length}</span> 已选
            </span>
            <button
              onClick={() => addToChat(multiSelected)}
              className="flex items-center gap-1 px-1.5 h-6 bg-primary-container text-on-primary-container rounded text-[10px] font-medium hover:opacity-80"
            >
              <span className="material-symbols-outlined text-xs">forum</span>
              引用到对话
            </button>
            <button
              onClick={() => setMultiSelected([])}
              className="text-text-secondary hover:text-text"
            >
              <span className="material-symbols-outlined text-xs">close</span>
            </button>
          </div>
        )}
        {tab === 'files' && (
          <span className="text-[10px] text-text-secondary font-mono mr-1">
            共 {countFiles(resources.tree)} 个文件
          </span>
        )}
      </div>

      {tab === 'files' && (
        <FileExplorerView
          resources={resources}
          multiSelected={multiSelected}
          setMultiSelected={setMultiSelected}
          onAddToChat={addToChat}
          onContextMenu={setContextMenu}
          onAIExplainLines={(start, end, mode = 'explain') => {
            const path = resources.activeFile;
            const linesArr = resources.content.split('\n');
            const snippet = linesArr.slice(start - 1, end).join('\n');
            // 同时：写解释到内联面板 + 引用到对话 + 切到 chat
            chat.explainInline(path, start, end, snippet, mode);
            // 切到 chat tab 展示流式进度
            addToChat([path]);
          }}
        />
      )}
      {tab === 'stream' && (
        <StreamPanel
          chunks={chat.stream}
          onClear={chat.clearStream}
          busy={chat.busy}
          onRetry={(text) => { chat.send(text); setTab('chat'); }}
          onSwitchModel={() => { onOpenSettings?.(); }}
          onOpenSettings={() => { onOpenSettings?.(); }}
          onResendToChat={(prompt) => { chat.send(prompt); setTab('chat'); }}
        />
      )}
      {tab === 'history' && <HistoryPanel chat={chat} />}
      {tab === 'chat' && <ChatPanel chat={chat} />}

      {/* 多 Tab 文件预览 (跨 tab 持久化) */}
      {tab !== 'chat' && tab !== 'history' && tab !== 'stream' && resources.openFiles.length > 0 && (
        <FilePreviewContainer
          resources={resources}
          chat={chat}
          onAddToChat={addToChat}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          path={contextMenu.path}
          type={contextMenu.type}
          onClose={() => setContextMenu(null)}
          onAddToChat={() => { addToChat([contextMenu.path]); setContextMenu(null); }}
          onAIExplain={() => {
            addToChat([contextMenu.path]);
            setTab('chat');
            setTimeout(() => chat.send(`请用中文解释 ${contextMenu.path} 这个文件做了什么：\n\n`, [contextMenu.path]), 100);
            setContextMenu(null);
          }}
          onCopy={() => {
            navigator.clipboard?.writeText(contextMenu.path);
            pushNotification({ level: 'info', title: '已复制', message: contextMenu.path });
            setContextMenu(null);
          }}
        />
      )}
    </section>
  );
}

function TabButton({ icon, label, active, onClick, badge }: { icon: string; label: string; active: boolean; onClick: () => void; badge?: number }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-2.5 h-7 rounded text-[11px] font-medium transition-all ${
        active
          ? 'bg-primary-container text-on-primary-container shadow-sm'
          : 'text-text-secondary hover:text-text hover:bg-surface-high'
      }`}
    >
      <span className={`material-symbols-outlined text-sm ${active ? 'filled' : ''}`}>{icon}</span>
      <span>{label}</span>
      {badge != null && badge > 0 && (
        <Badge variant={active ? 'primary' : 'default'} className="text-[9px] px-1 ml-0.5">{badge}</Badge>
      )}
    </button>
  );
}

// ─── 文件浏览视图 ───
function FileExplorerView({
  resources, multiSelected, setMultiSelected, onAddToChat, onContextMenu, onAIExplainLines,
}: {
  resources: ReturnType<typeof useResources>;
  multiSelected: string[];
  setMultiSelected: (v: string[]) => void;
  onAddToChat: (paths: string[]) => void;
  onContextMenu: (m: { x: number; y: number; path: string; type: 'file' | 'folder' }) => void;
  onAIExplainLines: (start: number, end: number, mode?: 'explain' | 'refactor' | 'test') => void;
}) {
  const [selectedFolder, setSelectedFolder] = useState<string>('/src/components');
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<'list' | 'tree'>('list');

  const allFolders = useMemo(() => {
    const out: Array<{ id: string; name: string; path: string }> = [];
    const walk = (n: any, prefix: string) => {
      if (n.type === 'folder') {
        out.push({ id: n.id, name: n.name, path: prefix + '/' + n.name });
        n.children?.forEach((c: any) => walk(c, prefix + '/' + n.name));
      }
    };
    walk(resources.tree, '');
    return out;
  }, [resources.tree]);

  const currentContent = useMemo(() => {
    const find = (n: any): any => {
      if (n.path === selectedFolder || ('/' + n.name) === selectedFolder) return n;
      if (n.children) {
        for (const c of n.children) {
          const r = find(c);
          if (r) return r;
        }
      }
      return null;
    };
    return find(resources.tree);
  }, [resources.tree, selectedFolder]);

  let items = (currentContent?.children || []) as any[];

  // 树视图展开状态
  const [treeExpanded, setTreeExpanded] = useState<Record<string, boolean>>({
    root: true, src: true, rust: false, python: false, migrations: true, components: true,
  });

  // 搜索过滤
  if (search.trim()) {
    const q = search.toLowerCase();
    items = items.filter(it => it.name.toLowerCase().includes(q));
  }

  const handleClick = (it: any, e: React.MouseEvent) => {
    if (e.shiftKey && resources.activeFile) {
      // Shift 多选
      const start = items.findIndex(x => x.path === resources.activeFile);
      const end = items.findIndex(x => x.path === it.path);
      if (start >= 0 && end >= 0) {
        const [a, b] = start < end ? [start, end] : [end, start];
        setMultiSelected(items.slice(a, b + 1).map(x => x.path));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      // Ctrl 加选
      if (multiSelected.includes(it.path)) {
        setMultiSelected(multiSelected.filter(p => p !== it.path));
      } else {
        setMultiSelected([...multiSelected, it.path]);
      }
      return;
    }
    setMultiSelected([]);
    if (it.type === 'folder') {
      setSelectedFolder(it.path);
    } else {
      resources.openFile(it.path);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 面包屑 + 工具栏 */}
      <div className="flex items-center gap-2 px-3 h-9 bg-bg-dim border-b border-border-light shrink-0">
        <FolderBreadcrumb
          path={selectedFolder}
          folders={allFolders}
          onSelect={setSelectedFolder}
        />
        <div className="flex-1" />
        <div className="relative">
          <span className="material-symbols-outlined absolute left-1.5 top-1/2 -translate-y-1/2 text-text-secondary text-xs pointer-events-none">search</span>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="过滤..."
            className="w-32 pl-6 pr-2 h-6 bg-surface border border-border-light text-[10px] text-text rounded focus:outline-none focus:border-primary placeholder-text-secondary"
          />
        </div>
        <Tooltip content={viewMode === 'list' ? '切换到树视图' : '切换到列表视图'}>
          <IconButton icon={viewMode === 'list' ? 'account_tree' : 'view_list'} size="xs" onClick={() => setViewMode(v => v === 'list' ? 'tree' : 'list')} />
        </Tooltip>
        <Tooltip content="排序">
          <IconButton icon="sort" size="xs" />
        </Tooltip>
        <Tooltip content="刷新">
          <IconButton icon="refresh" size="xs" onClick={resources.resetTree} />
        </Tooltip>
        <Tooltip content="新建文件">
          <IconButton icon="note_add" size="xs" />
        </Tooltip>
      </div>

      {/* 多选操作条 */}
      {multiSelected.length > 0 && (
        <div className="flex items-center gap-2 px-3 h-8 bg-primary/5 border-b border-primary/20 text-[10px] shrink-0">
          <span className="text-primary font-medium">{multiSelected.length} 个文件已选</span>
          <button
            draggable
            onDragStart={e => {
              e.dataTransfer.setData('text/x-soloforge-paths', JSON.stringify(multiSelected));
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => onAddToChat(multiSelected)}
            className="flex items-center gap-1 px-1.5 h-5 bg-primary text-on-primary rounded text-[10px] cursor-grab active:cursor-grabbing hover:opacity-90"
            title="拖动到对话区 / 点击直接引用"
          >
            <span className="material-symbols-outlined text-xs">drag_pan</span>
            拖到对话
          </button>
          <div className="flex-1" />
          <button onClick={() => setMultiSelected([])} className="text-text-secondary hover:text-text">
            <span className="material-symbols-outlined text-xs">close</span>
          </button>
        </div>
      )}

      {/* 文件列表 */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {viewMode === 'tree' ? (
          <TreeView
            root={resources.tree}
            treeExpanded={treeExpanded}
            setTreeExpanded={setTreeExpanded}
            activeFile={resources.activeFile}
            multiSelected={multiSelected}
            onClick={handleClick}
            onContextMenu={onContextMenu}
            onDragStart={(it, e) => {
              const paths = multiSelected.includes(it.path) ? multiSelected : [it.path];
              e.dataTransfer.setData('text/x-soloforge-paths', JSON.stringify(paths));
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onFolderClick={(it) => {
              setTreeExpanded(prev => ({ ...prev, [it.id]: !prev[it.id] }));
            }}
            onOpenFile={(it) => resources.openFile(it.path)}
            search={search}
          />
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-text-secondary">
            <span className="material-symbols-outlined text-4xl mb-2 opacity-40">{search ? 'search_off' : 'folder_off'}</span>
            <p className="text-xs">{search ? `无匹配 "${search}"` : '空文件夹'}</p>
          </div>
        ) : (
          <div className="divide-y divide-border-light">
            {items.map((it, i) => (
              <FileRow
                key={it.id}
                item={it}
                index={i}
                isActive={it.path === resources.activeFile}
                isMultiSelected={multiSelected.includes(it.path)}
                onClick={(e) => handleClick(it, e)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onContextMenu({ x: e.clientX, y: e.clientY, path: it.path, type: it.type });
                  if (!multiSelected.includes(it.path)) {
                    setMultiSelected([it.path]);
                  }
                }}
                onDragStart={(e) => {
                  const paths = multiSelected.includes(it.path) ? multiSelected : [it.path];
                  e.dataTransfer.setData('text/x-soloforge-paths', JSON.stringify(paths));
                  e.dataTransfer.effectAllowed = 'copy';
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FilePreviewContainer({ resources, chat, onAddToChat }: { resources: ReturnType<typeof useResources>; chat: any; onAddToChat: (paths: string[]) => void }) {
  return (
    <MultiTabPreview
      resources={resources}
      chat={chat}
      onClose={() => resources.closeAll()}
      onAIExplainLines={(start, end, mode = 'explain') => {
        const path = resources.activeFile;
        const linesArr = resources.content.split('\n');
        const snippet = linesArr.slice(start - 1, end).join('\n');
        chat.explainInline(path, start, end, snippet, mode);
        onAddToChat([path]);
      }}
      explanations={chat.explanations}
    />
  );
}

function TreeView({ root, treeExpanded, setTreeExpanded, activeFile, multiSelected, onClick, onContextMenu, onDragStart, onFolderClick, onOpenFile, search }: {
  root: any;
  treeExpanded: Record<string, boolean>;
  setTreeExpanded: (v: Record<string, boolean>) => void;
  activeFile: string;
  multiSelected: string[];
  onClick: (it: any, e: React.MouseEvent) => void;
  onContextMenu: (m: { x: number; y: number; path: string; type: 'file' | 'folder' }) => void;
  onDragStart: (it: any, e: React.DragEvent) => void;
  onFolderClick: (it: any) => void;
  onOpenFile: (it: any) => void;
  search: string;
}) {
  const filtered = (node: any): any => {
    if (!search) return node;
    const q = search.toLowerCase();
    if (node.type === 'file' && node.name.toLowerCase().includes(q)) return node;
    if (node.type === 'folder' && node.children) {
      const kids = node.children.map(filtered).filter(Boolean);
      if (kids.length > 0) return { ...node, children: kids };
    }
    return null;
  };
  const renderNode = (node: any, depth: number): React.ReactNode => {
    if (!node) return null;
    const isFolder = node.type === 'folder';
    const isOpen = treeExpanded[node.id];
    const isActive = node.path === activeFile;
    const isSelected = multiSelected.includes(node.path);
    const icon = isFolder ? (isOpen ? 'folder_open' : 'folder') : (LANG_ICONS[node.language] || 'description');
    const color = isFolder ? 'text-warning' : (LANG_COLORS[node.language] || 'text-text-secondary');
    return (
      <div key={node.id}>
        <div
          onClick={(e) => {
            if (isFolder && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
              onFolderClick(node);
            } else {
              onClick(node, e);
            }
            if (!isFolder) onOpenFile(node);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            onContextMenu({ x: e.clientX, y: e.clientY, path: node.path, type: node.type });
            if (!multiSelected.includes(node.path)) {/* set */}
          }}
          draggable
          onDragStart={(e) => onDragStart(node, e)}
          style={{ paddingLeft: 6 + depth * 14 }}
          className={`group flex items-center gap-1.5 h-7 text-[11px] cursor-pointer transition-colors ${
            isActive
              ? 'bg-primary-container/30 border-l-2 border-primary'
              : isSelected
                ? 'bg-primary/10 border-l-2 border-primary/60'
                : 'hover:bg-surface-high border-l-2 border-transparent'
          }`}
        >
          {isFolder ? (
            <span className="material-symbols-outlined text-xs text-text-secondary w-3 shrink-0">
              {isOpen ? 'expand_more' : 'chevron_right'}
            </span>
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <span className={`material-symbols-outlined text-sm shrink-0 ${isFolder ? 'filled' : ''} ${color}`} style={{ fontSize: 14 }}>{icon}</span>
          <span className={`font-mono truncate ${isActive || isSelected ? 'text-text font-semibold' : 'text-text'}`}>{node.name}</span>
          {isFolder && node.children && (
            <span className="text-[9px] text-text-secondary font-mono shrink-0 ml-auto pr-2">{node.children.length}</span>
          )}
        </div>
        {isFolder && isOpen && node.children && (
          <div>{node.children.map((c: any) => renderNode(c, depth + 1))}</div>
        )}
      </div>
    );
  };
  const filteredRoot = filtered(root);
  if (!filteredRoot) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-secondary">
        <span className="material-symbols-outlined text-4xl mb-2 opacity-40">search_off</span>
        <p className="text-xs">无匹配 "{search}"</p>
      </div>
    );
  }
  return <div className="py-1">{renderNode(filteredRoot, 0)}</div>;
}

function FileRow({ item, index, isActive, isMultiSelected, onClick, onContextMenu, onDragStart }: {
  item: any; index: number;
  isActive: boolean; isMultiSelected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
}) {
  const isFolder = item.type === 'folder';
  const icon = isFolder ? 'folder' : (LANG_ICONS[item.language] || 'description');
  const color = isFolder ? 'text-warning' : (LANG_COLORS[item.language] || 'text-text-secondary');
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      draggable
      onDragStart={onDragStart}
      style={{ animationDelay: `${Math.min(index * 15, 200)}ms` }}
      className={`group w-full flex items-center gap-3 px-3 h-9 text-left transition-colors animate-fade-in ${
        isActive
          ? 'bg-primary-container/30 border-l-2 border-primary'
          : isMultiSelected
            ? 'bg-primary/10 border-l-2 border-primary/60'
            : 'hover:bg-surface-high border-l-2 border-transparent'
      }`}
    >
      <span className="material-symbols-outlined text-base shrink-0 text-text-secondary" style={{ fontSize: 16 }}>
        {isMultiSelected ? 'check_box' : 'check_box_outline_blank'}
      </span>
      <span className={`material-symbols-outlined text-base shrink-0 ${isFolder ? 'filled' : ''} ${color}`}>{icon}</span>
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span className={`text-xs font-mono truncate ${isActive || isMultiSelected ? 'text-text font-semibold' : 'text-text group-hover:text-text'}`}>
          {item.name}
        </span>
        {isFolder && item.children && (
          <span className="text-[9px] text-text-secondary font-mono">{item.children.length} 项</span>
        )}
      </div>
      {item.size != null && (
        <span className="text-[10px] text-text-secondary font-mono shrink-0">{formatSize(item.size)}</span>
      )}
      <span className="text-[10px] text-text-secondary font-mono shrink-0 hidden group-hover:inline">2d</span>
      <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5">
        <IconButton icon="content_copy" size="xs" />
        <IconButton icon="more_horiz" size="xs" />
      </div>
    </button>
  );
}

function FolderBreadcrumb({ path, folders, onSelect }: { path: string; folders: Array<{ name: string; path: string }>; onSelect: (p: string) => void }) {
  const parts = path.split('/').filter(Boolean);
  return (
    <div className="flex items-center gap-0.5 text-[11px] font-mono overflow-x-auto scrollbar-hide min-w-0">
      {parts.map((p, i) => {
        const upTo = '/' + parts.slice(0, i + 1).join('/');
        const folder = folders.find(f => f.path === upTo);
        return (
          <span key={i} className="flex items-center gap-0.5 shrink-0">
            {i > 0 && <span className="material-symbols-outlined text-[10px] text-text-secondary/50">chevron_right</span>}
            <button
              onClick={() => folder && onSelect(folder.path)}
              className="px-1 rounded text-text-secondary hover:text-text hover:bg-surface-high"
            >
              {p}
            </button>
          </span>
        );
      })}
    </div>
  );
}

function FileContentPreview({ file, content, onClose, onAIExplainLines, explanations, chat }: { file: string; content: string; onClose: () => void; onAIExplainLines?: (start: number, end: number, mode?: 'explain' | 'refactor' | 'test') => void; explanations?: Record<string, { content: string; mode: string; timestamp: number }>; chat?: any }) {
  const ext = file.split('.').pop() || '';
  const isMarkdown = ext === 'md';
  const isJson = ext === 'json';
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 h-7 bg-bg-dim border-b border-border-light shrink-0">
        <div className="flex items-center gap-2 text-[11px] font-mono min-w-0">
          <span className="material-symbols-outlined text-sm text-text-secondary">description</span>
          <span className="text-text shrink-0">{file.split('/').pop()}</span>
          <span className="text-text-secondary truncate">{file}</span>
          <span className="text-text-secondary/60">·</span>
          <span className="text-text-secondary shrink-0">{content.split('\n').length} 行</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Tooltip content="复制内容">
            <IconButton icon="content_copy" size="xs" onClick={() => navigator.clipboard?.writeText(content)} />
          </Tooltip>
          <Tooltip content="下载">
            <IconButton icon="download" size="xs" />
          </Tooltip>
          <Tooltip content="关闭">
            <IconButton icon="close" size="xs" onClick={onClose} />
          </Tooltip>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-0 scrollbar-thin">
        {isMarkdown ? (
          <MarkdownView content={content} />
        ) : isJson ? (
          <JsonView content={content} />
        ) : (
          <>
            <CodeView content={content} language={ext} file={file} onAIExplainLines={onAIExplainLines} />
            {explanations && file && (
              <AIExplainPanel
                file={file}
                explanations={explanations}
                onRemove={(key) => chat?.removeExplanation?.(key)}
                onClearAll={() => chat?.clearExplanations?.()}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── AI 解释内联面板 ───
function AIExplainPanel({ file, explanations, onRemove, onClearAll }: {
  file: string;
  explanations: Record<string, { content: string; mode: string; timestamp: number }>;
  onRemove?: (key: string) => void;
  onClearAll?: () => void;
}) {
  const fileExps = Object.entries(explanations).filter(([k]) => k.startsWith(file + ':')).sort((a, b) => b[1].timestamp - a[1].timestamp);
  const [collapsed, setCollapsed] = useState(false);
  if (fileExps.length === 0) return null;
  return (
    <div className="border-t-2 border-primary/30 bg-gradient-to-b from-primary/5 to-transparent">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-primary-container/30 border-b border-primary/20">
        <button
          onClick={() => setCollapsed(c => !c)}
          className="material-symbols-outlined text-sm text-primary"
          title={collapsed ? '展开' : '折叠'}
        >
          {collapsed ? 'expand_more' : 'expand_less'}
        </button>
        <span className="material-symbols-outlined text-sm text-primary filled">psychology</span>
        <span className="text-[11px] font-semibold text-primary">AI 解释</span>
        <span className="text-[10px] text-text-secondary font-mono">{fileExps.length} 条</span>
        <span className="flex-1" />
        {onClearAll && (
          <button
            onClick={() => {
              if (confirm(`清空该文件全部 ${fileExps.length} 条 AI 解释?`)) onClearAll();
            }}
            className="text-[10px] text-text-secondary hover:text-danger flex items-center gap-0.5"
            title="清空该文件全部解释"
          >
            <span className="material-symbols-outlined text-xs">delete_sweep</span>
            <span>清空</span>
          </button>
        )}
      </div>
      <div className={`max-h-[40vh] overflow-y-auto scrollbar-thin ${collapsed ? 'hidden' : ''}`}>
        {fileExps.map(([key, exp]) => {
          const [, range, mode] = key.split(':');
          const [start, end] = range.split('-').map(Number);
          const isThinking = exp.content === '__thinking__';
          return (
            <div key={key} className="group p-3 border-b border-border-light last:border-b-0 animate-slide-in-up">
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`material-symbols-outlined text-sm ${mode === 'refactor' ? 'text-warning' : mode === 'test' ? 'text-success' : 'text-accent'}`}>
                  {mode === 'refactor' ? 'build' : mode === 'test' ? 'science' : 'psychology'}
                </span>
                <span className="text-[11px] font-semibold text-text">
                  {mode === 'refactor' ? '重构建议' : mode === 'test' ? '测试用例' : '代码解释'}
                </span>
                <span className="text-[10px] text-text-secondary font-mono">行 {start}-{end}</span>
                <span className="text-[9px] text-text-secondary ml-auto font-mono">
                  {new Date(exp.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}
                </span>
                <button
                  onClick={() => navigator.clipboard?.writeText(exp.content)}
                  className="material-symbols-outlined text-xs text-text-secondary hover:text-text"
                  title="复制"
                >content_copy</button>
                {onRemove && (
                  <button
                    onClick={() => onRemove(key)}
                    className="material-symbols-outlined text-xs text-text-secondary hover:text-danger opacity-0 group-hover:opacity-100"
                    title="删除该解释"
                  >close</button>
                )}
              </div>
              {isThinking ? (
                <div className="flex items-center gap-2 text-[11px] text-text-secondary py-2">
                  <span className="flex gap-0.5">
                    <span className="w-1.5 h-1.5 bg-primary rounded-full animate-typing" />
                    <span className="w-1.5 h-1.5 bg-primary rounded-full animate-typing" />
                    <span className="w-1.5 h-1.5 bg-primary rounded-full animate-typing" />
                  </span>
                  AI 正在思考这段代码...
                </div>
              ) : (
                <MarkdownView content={exp.content} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MultiTabPreview({ resources, onClose, onAIExplainLines, explanations, chat }: {
  resources: ReturnType<typeof useResources>;
  onClose: () => void;
  onAIExplainLines: (start: number, end: number, mode?: 'explain' | 'refactor' | 'test') => void;
  explanations?: Record<string, { content: string; mode: string; timestamp: number }>;
  chat?: any;
}) {
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  useEffect(() => {
    if (!tabContextMenu) return;
    const close = () => setTabContextMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', close); };
  }, [tabContextMenu]);

  return (
    <div className="border-t border-border bg-surface animate-slide-in-up h-[55%] flex flex-col shrink-0">
      {/* Tab 栏 */}
      <div className="flex items-center bg-bg-dim border-b border-border-light shrink-0 h-8 overflow-x-auto scrollbar-thin">
        {resources.openFiles.map((path) => {
          const name = path.split('/').pop() || path;
          const isActive = path === resources.activeFile;
          const ext = name.split('.').pop() || '';
          const langColor = LANG_COLORS[ext] || 'text-text-secondary';
          const isDirty = path === '/src/components/Button.tsx'; // 模拟脏标记
          return (
            <div
              key={path}
              onClick={() => resources.setActiveFile(path)}
              onContextMenu={(e) => { e.preventDefault(); setTabContextMenu({ x: e.clientX, y: e.clientY, path }); }}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); resources.closeFile(path); } }}
              className={`group flex items-center gap-1.5 pl-3 pr-1 h-full border-r border-border-light cursor-pointer transition-colors ${
                isActive ? 'bg-surface text-text' : 'text-text-secondary hover:text-text hover:bg-surface/50'
              }`}
              style={{ borderTop: isActive ? '2px solid var(--color-primary)' : '2px solid transparent' }}
            >
              <span className={`material-symbols-outlined text-xs ${langColor}`}>{LANG_ICONS[ext] || 'description'}</span>
              <span className={`text-[11px] font-mono whitespace-nowrap ${isActive ? 'font-semibold' : ''}`}>{name}</span>
              {isDirty && <span className="w-1.5 h-1.5 rounded-full bg-warning shrink-0" title="未保存" />}
              <button
                onClick={(e) => { e.stopPropagation(); resources.closeFile(path); }}
                className="ml-1 w-4 h-4 rounded flex items-center justify-center hover:bg-surface-high opacity-0 group-hover:opacity-100"
                title="关闭"
              >
                <span className="material-symbols-outlined text-[10px]">close</span>
              </button>
            </div>
          );
        })}
        <div className="flex-1" />
        <div className="flex items-center gap-0.5 px-2">
          <Tooltip content="关闭所有">
            <button
              onClick={onClose}
              className="w-5 h-5 rounded text-text-secondary hover:text-text hover:bg-surface-high flex items-center justify-center"
            >
              <span className="material-symbols-outlined text-xs">close</span>
            </button>
          </Tooltip>
        </div>
      </div>
      {/* 当前内容 */}
      {resources.activeFile && (
        <FileContentPreview
          file={resources.activeFile}
          content={(resources as any).contents?.[resources.activeFile] ?? '// 暂无内容预览'}
          onClose={() => resources.closeFile(resources.activeFile)}
          onAIExplainLines={onAIExplainLines}
          explanations={explanations}
          chat={chat}
        />
      )}
      {/* Tab 右键菜单 */}
      {tabContextMenu && (
        <div
          className="fixed z-50 min-w-[180px] bg-surface border border-border rounded-lg shadow-2xl py-1 animate-fade-in"
          style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1.5 text-[10px] text-text-secondary border-b border-border-light truncate max-w-[260px]" title={tabContextMenu.path}>
            {tabContextMenu.path}
          </div>
          <TabMenuItem icon="close" label="关闭" onClick={() => { resources.closeFile(tabContextMenu.path); setTabContextMenu(null); }} />
          <TabMenuItem icon="close_fullscreen" label="关闭其他" onClick={() => { resources.closeOthers(tabContextMenu.path); setTabContextMenu(null); }} />
          <TabMenuItem icon="clear_all" label="关闭全部" onClick={() => { resources.closeAll(); setTabContextMenu(null); }} />
          <div className="border-t border-border-light my-1" />
          <TabMenuItem icon="content_copy" label="复制路径" onClick={() => { navigator.clipboard?.writeText(tabContextMenu.path); setTabContextMenu(null); }} />
          <TabMenuItem icon="forum" label="引用到对话" onClick={() => { onAIExplainLines(1, 1); setTabContextMenu(null); }} />
        </div>
      )}
    </div>
  );
}

function TabMenuItem({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text hover:bg-surface-high transition-colors"
    >
      <span className="material-symbols-outlined text-sm">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

// ─── 语法高亮 Code View ───
function CodeView({ content, language, file, onAIExplainLines }: { content: string; language: string; file?: string; onAIExplainLines?: (start: number, end: number, mode?: 'explain' | 'refactor' | 'test') => void }) {
  const lines = content.split('\n');
  const [selStart, setSelStart] = useState<number | null>(null);
  const [selEnd, setSelEnd] = useState<number | null>(null);
  const [isMouseDown, setIsMouseDown] = useState(false);

  const onLineMouseDown = (idx: number, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (!e.shiftKey) {
      setSelStart(idx);
      setSelEnd(idx);
      setIsMouseDown(true);
    } else if (selStart != null) {
      setSelEnd(idx);
    }
  };
  const onLineMouseEnter = (idx: number) => {
    if (isMouseDown && selStart != null) setSelEnd(idx);
  };
  const onLineMouseUp = () => setIsMouseDown(false);

  useEffect(() => {
    const up = () => setIsMouseDown(false);
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const range = selStart != null && selEnd != null
    ? { from: Math.min(selStart, selEnd), to: Math.max(selStart, selEnd) }
    : null;

  return (
    <div className="font-mono text-[11px] leading-relaxed relative">
      {lines.map((line, idx) => {
        const inRange = range && idx >= range.from && idx <= range.to;
        return (
          <div
            key={idx}
            onMouseDown={(e) => onLineMouseDown(idx, e)}
            onMouseEnter={() => onLineMouseEnter(idx)}
            onMouseUp={onLineMouseUp}
            onContextMenu={(e) => {
              e.preventDefault();
              if (onAIExplainLines) {
                const start = range?.from ?? idx;
                const end = range?.to ?? idx;
                onAIExplainLines(start + 1, end + 1, 'explain');
              }
            }}
            className={`flex hover:bg-surface-high/40 group cursor-text ${
              inRange ? 'bg-primary/10' : ''
            }`}
          >
            <span className={`select-none w-10 shrink-0 text-right pr-3 py-0.5 text-[10px] border-r border-border-light/30 ${
              inRange ? 'text-primary font-semibold' : 'text-text-secondary/50'
            }`}>
              {idx + 1}
            </span>
            <pre
              className="px-3 py-0.5 flex-1 whitespace-pre overflow-x-auto"
              dangerouslySetInnerHTML={{ __html: highlightLine(line, language) }}
            />
          </div>
        );
      })}
      {/* 浮动操作栏 — 选中行后出现 */}
      {range && file && onAIExplainLines && (
        <div className="sticky bottom-2 left-1/2 -translate-x-1/2 z-10 inline-flex items-center gap-1 px-1.5 py-1 bg-surface border border-primary rounded-lg shadow-2xl animate-slide-in-up">
          <span className="text-[10px] text-text-secondary px-1 font-mono">
            行 {range.from + 1}-{range.to + 1}
          </span>
          <div className="w-px h-3 bg-border" />
          <button
            onClick={() => onAIExplainLines(range.from + 1, range.to + 1, 'explain')}
            className="flex items-center gap-1 px-1.5 h-6 rounded text-[10px] bg-primary text-on-primary hover:opacity-90"
            title="向 AI 解释这段代码"
          >
            <span className="material-symbols-outlined text-xs filled">psychology</span>
            解释
          </button>
          <button
            onClick={() => onAIExplainLines(range.from + 1, range.to + 1, 'refactor')}
            className="flex items-center gap-1 px-1.5 h-6 rounded text-[10px] bg-warning/20 text-warning hover:bg-warning/30"
            title="重构这段代码"
          >
            <span className="material-symbols-outlined text-xs">build</span>
            重构
          </button>
          <button
            onClick={() => onAIExplainLines(range.from + 1, range.to + 1, 'test')}
            className="flex items-center gap-1 px-1.5 h-6 rounded text-[10px] bg-success/20 text-success hover:bg-success/30"
            title="为这段代码生成测试"
          >
            <span className="material-symbols-outlined text-xs">science</span>
            测试
          </button>
          <button
            onClick={() => { setSelStart(null); setSelEnd(null); }}
            className="flex items-center justify-center w-5 h-5 rounded text-text-secondary hover:bg-surface-high"
            title="取消选择"
          >
            <span className="material-symbols-outlined text-xs">close</span>
          </button>
        </div>
      )}
    </div>
  );
}

function highlightLine(line: string, lang: string): string {
  let s = line
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 注释
  if (lang === 'ts' || lang === 'tsx' || lang === 'js' || lang === 'rs' || lang === 'py' || lang === 'json') {
    s = s.replace(/(\/\/.*$)/g, '<span style="color:var(--color-text-secondary)">$1</span>');
    s = s.replace(/(#.*$)/g, '<span style="color:var(--color-text-secondary)">$1</span>');
  }
  // 字符串
  s = s.replace(/(['"`])((?:\\.|(?!\1).)*)\1/g, '<span style="color:var(--color-success)">$1$2$1</span>');
  // 关键字
  const KWS: Record<string, string[]> = {
    ts: ['import', 'export', 'from', 'const', 'let', 'var', 'function', 'class', 'extends', 'implements', 'interface', 'type', 'enum', 'return', 'if', 'else', 'for', 'while', 'new', 'async', 'await', 'try', 'catch', 'throw', 'of', 'in', 'as', 'public', 'private', 'protected', 'static', 'readonly', 'void', 'null', 'true', 'false', 'undefined'],
    rs: ['fn', 'let', 'mut', 'pub', 'use', 'mod', 'struct', 'enum', 'impl', 'trait', 'for', 'while', 'if', 'else', 'match', 'return', 'self', 'Self', 'as', 'in', 'true', 'false', 'None', 'Some', 'Ok', 'Err'],
    py: ['def', 'class', 'import', 'from', 'as', 'return', 'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'with', 'lambda', 'yield', 'async', 'await', 'True', 'False', 'None', 'self'],
    sql: ['SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'TABLE', 'INDEX', 'DROP', 'DEFINE', 'SCHEMAFULL', 'NULL', 'TRUE', 'FALSE', 'AND', 'OR', 'NOT', 'IN', 'AS', 'ON', 'JOIN'],
    json: ['true', 'false', 'null'],
    md: [],
  };
  const kws = KWS[lang] || KWS.ts;
  kws.forEach(kw => {
    const re = new RegExp(`\\b(${kw})\\b`, 'g');
    s = s.replace(re, '<span style="color:var(--color-accent); font-weight:600">$1</span>');
  });
  // 数字
  s = s.replace(/\b(\d+)\b/g, '<span style="color:var(--color-warning)">$1</span>');
  return s || '&nbsp;';
}

function JsonView({ content }: { content: string }) {
  let pretty = content;
  try { pretty = JSON.stringify(JSON.parse(content), null, 2); } catch { /* ignore */ }
  return <CodeView content={pretty} language="json" />;
}

function MarkdownView({ content }: { content: string }) {
  // 增强 Markdown 渲染：表格 / 代码块 / 引用 / 链接 / 任务列表 / 删除线
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let text = esc(content);

  // 围栏代码块 ```lang ... ```
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre class="my-2 p-2 bg-bg-dim border border-border-light rounded text-[11px] overflow-x-auto"><code class="font-mono text-text">${code.trim()}</code></pre>`;
  });

  // 行内代码
  text = text.replace(/`([^`\n]+)`/g, '<code class="px-1 py-0.5 bg-surface-high border border-border-light rounded text-[11px] font-mono text-text">$1</code>');

  // 标题
  text = text.replace(/^###### (.*)$/gim, '<h6 class="text-[11px] font-semibold mt-1 mb-0.5 text-text">$1</h6>');
  text = text.replace(/^##### (.*)$/gim, '<h5 class="text-xs font-semibold mt-1 mb-0.5 text-text">$1</h5>');
  text = text.replace(/^#### (.*)$/gim, '<h4 class="text-sm font-semibold mt-2 mb-1 text-text">$1</h4>');
  text = text.replace(/^### (.*)$/gim, '<h3 class="text-sm font-semibold mt-2 mb-1 text-text border-b border-border-light pb-0.5">$1</h3>');
  text = text.replace(/^## (.*)$/gim, '<h2 class="text-base font-bold mt-3 mb-1 text-text border-b border-border pb-0.5">$1</h2>');
  text = text.replace(/^# (.*)$/gim, '<h1 class="text-lg font-bold mt-3 mb-2 text-text">$1</h1>');

  // 引用
  text = text.replace(/^> (.*)$/gim, '<blockquote class="border-l-4 border-primary pl-3 my-1 text-text-secondary italic">$1</blockquote>');

  // 表格 (| col | col |\n|---|---|)
  text = text.replace(/((?:\|[^\n]+\|\n)+)/g, (block) => {
    const rows = block.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return block;
    const isSep = (r: string) => /^\|[\s\-:|]+\|$/.test(r.trim());
    if (!isSep(rows[1])) return block;
    const headerCells = rows[0].slice(1, -1).split('|').map(c => c.trim());
    const bodyRows = rows.slice(2);
    let html = '<table class="my-2 border-collapse text-[11px]"><thead><tr>';
    headerCells.forEach(c => { html += `<th class="border border-border-light bg-surface-high px-2 py-1 text-left font-semibold text-text">${c}</th>`; });
    html += '</tr></thead><tbody>';
    bodyRows.forEach(r => {
      const cells = r.slice(1, -1).split('|').map(c => c.trim());
      html += '<tr>';
      cells.forEach(c => { html += `<td class="border border-border-light px-2 py-1 text-text">${c}</td>`; });
      html += '</tr>';
    });
    html += '</tbody></table>';
    return html;
  });

  // 任务列表
  text = text.replace(/^- \[ \] (.*)$/gim, '<div class="ml-4 flex items-center gap-1.5 my-0.5"><span class="material-symbols-outlined text-sm text-text-secondary">check_box_outline_blank</span><span class="text-text">$1</span></div>');
  text = text.replace(/^- \[x\] (.*)$/gim, '<div class="ml-4 flex items-center gap-1.5 my-0.5"><span class="material-symbols-outlined text-sm text-success filled">check_box</span><span class="text-text line-through opacity-60">$1</span></div>');

  // 无序列表
  text = text.replace(/^[*\-+] (.*)$/gim, '<li class="ml-5 list-disc text-text my-0.5">$1</li>');
  text = text.replace(/^\d+\. (.*)$/gim, '<li class="ml-5 list-decimal text-text my-0.5">$1</li>');

  // 粗体 / 斜体 / 删除线
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong class="text-text font-semibold">$1</strong>');
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)\*(?!\*)/g, '<em>$1</em>');
  text = text.replace(/~~(.+?)~~/g, '<del class="opacity-60">$1</del>');

  // 链接
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer" class="text-primary hover:underline">$1</a>');

  // 分隔线
  text = text.replace(/^---+$/gim, '<hr class="my-3 border-border-light"/>');
  text = text.replace(/^\*\*\*+$/gim, '<hr class="my-3 border-border-light"/>');

  return (
    <div
      className="p-4 text-text-secondary text-xs leading-relaxed markdown-view"
      dangerouslySetInnerHTML={{ __html: text }}
    />
  );
}

// ─── 右键菜单 ───
function ContextMenu({ x, y, path, type, onClose, onAddToChat, onAIExplain, onCopy }: {
  x: number; y: number; path: string; type: 'file' | 'folder';
  onClose: () => void;
  onAddToChat: () => void;
  onAIExplain: () => void;
  onCopy: () => void;
}) {
  return (
    <div
      className="fixed z-50 min-w-[200px] bg-surface border border-border rounded-lg shadow-2xl py-1 animate-fade-in"
      style={{ left: x, top: y }}
      onMouseDown={e => e.stopPropagation()}
    >
      <div className="px-3 py-1.5 text-[10px] text-text-secondary border-b border-border-light truncate max-w-[280px]" title={path}>
        {path}
      </div>
      <MenuItem icon="forum" label="引用到对话" onClick={onAddToChat} />
      {type === 'file' && <MenuItem icon="psychology" label="AI 解释这个文件" onClick={onAIExplain} highlight />}
      <MenuItem icon="content_copy" label="复制路径" onClick={onCopy} />
      <div className="border-t border-border-light my-1" />
      <MenuItem icon="download" label="下载" onClick={onClose} />
      <MenuItem icon="drive_file_rename_outline" label="重命名" onClick={onClose} />
      <MenuItem icon="delete" label="删除" onClick={onClose} danger />
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger, highlight }: { icon: string; label: string; onClick: () => void; danger?: boolean; highlight?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
        danger
          ? 'text-danger hover:bg-danger/10'
          : highlight
            ? 'text-primary hover:bg-primary/10 font-medium'
            : 'text-text hover:bg-surface-high'
      }`}
    >
      <span className="material-symbols-outlined text-sm">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function countFiles(node: any): number {
  if (node.type === 'file') return 1;
  return (node.children || []).reduce((s: number, c: any) => s + countFiles(c), 0);
}

const LANG_ICONS: Record<string, string> = {
  typescript: 'code',
  rust: 'memory',
  python: 'code_blocks',
  sql: 'database',
  json: 'data_object',
  markdown: 'description',
};

const LANG_COLORS: Record<string, string> = {
  typescript: 'text-info',
  rust: 'text-warning',
  python: 'text-success',
  sql: 'text-accent',
  json: 'text-warning',
  markdown: 'text-text-secondary',
};

function formatSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
