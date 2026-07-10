import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  ChevronDown, 
  ChevronRight, 
  Folder, 
  FolderOpen, 
  FileCode, 
  RefreshCw, 
  X, 
  FolderPlus, 
  FilePlus, 
  Copy, 
  Scissors, 
  Clipboard, 
  Trash2, 
  Edit3, 
  Link2, 
  MessageSquarePlus, 
  ExternalLink,
  MoreVertical,
  Check,
  Search,
  FileText
} from '../utils/icons';
import { MountTransition } from './MountTransition';
import type { FileNode } from '../shared/types/file';
import { useChatsStore } from '../state/chatsStore';
import { useWorkspaceStore } from '../state/useWorkspaceStore';

interface FileExplorerProps {
  selectedFile: string;
  setSelectedFile: (path: string) => void;
  onNewFile: () => void;
  onClose?: () => void;
  isFloatingEditorOpen?: boolean;
}

// Deep path update helper
const updatePaths = (node: FileNode, oldParentPath: string, newParentPath: string): FileNode => {
  const relPath = node.path.substring(oldParentPath.length);
  const newPath = newParentPath + relPath;
  if (node.type === 'folder' && node.children) {
    return {
      ...node,
      path: newPath,
      children: node.children.map(child => updatePaths(child, oldParentPath, newParentPath))
    };
  }
  return { ...node, path: newPath };
};

// Recursive node insertion helper
const insertNodeByPath = (root: FileNode, parentPath: string, newNode: FileNode): FileNode => {
  if (root.path === parentPath) {
    let finalName = newNode.name;
    let finalPath = `${parentPath}/${finalName}`;
    let counter = 1;
    const existingNames = new Set(root.children?.map(c => c.name) || []);
    while (existingNames.has(finalName)) {
      const dotIndex = newNode.name.lastIndexOf('.');
      if (newNode.type === 'file' && dotIndex !== -1) {
        const base = newNode.name.substring(0, dotIndex);
        const ext = newNode.name.substring(dotIndex);
        finalName = `${base}_copy${counter}${ext}`;
      } else {
        finalName = `${newNode.name}_copy${counter}`;
      }
      finalPath = `${parentPath}/${finalName}`;
      counter++;
    }
    const createdNode = { ...newNode, name: finalName, path: finalPath };
    return {
      ...root,
      children: [...(root.children || []), createdNode]
    };
  }

  if (root.children) {
    return {
      ...root,
      children: root.children.map(child => insertNodeByPath(child, parentPath, newNode))
    };
  }
  return root;
};

// Recursive deletion helper
const deleteNodeByPath = (root: FileNode, targetPath: string): FileNode => {
  if (root.children) {
    const updatedChildren = root.children
      .filter(child => child.path !== targetPath)
      .map(child => deleteNodeByPath(child, targetPath));
    return { ...root, children: updatedChildren };
  }
  return root;
};

// Recursive rename helper
const renameNodeByPath = (root: FileNode, targetPath: string, newName: string): FileNode => {
  if (root.path === targetPath) {
    const parentPath = targetPath.substring(0, targetPath.lastIndexOf('/'));
    const newPath = parentPath ? `${parentPath}/${newName}` : newName;
    const updated = { ...root, name: newName, path: newPath };
    if (root.type === 'folder' && root.children) {
      updated.children = root.children.map(child => updatePaths(child, targetPath, newPath));
    }
    return updated;
  }

  if (root.children) {
    return {
      ...root,
      children: root.children.map(child => renameNodeByPath(child, targetPath, newName))
    };
  }
  return root;
};

// Find node helper
const findNodeByPath = (root: FileNode, targetPath: string): FileNode | null => {
  if (root.path === targetPath) {
    return root;
  }
  if (root.children) {
    for (const child of root.children) {
      const found = findNodeByPath(child, targetPath);
      if (found) return found;
    }
  }
  return null;
};

// Helper to move a node inside the file tree
const moveNode = (root: FileNode, draggedPath: string, targetPath: string, targetType: 'file' | 'folder'): FileNode => {
  const draggedNode = findNodeByPath(root, draggedPath);
  if (!draggedNode) return root;

  // Prevent dropping onto itself or into a sub-folder of itself
  if (targetPath === draggedPath || targetPath.startsWith(draggedPath + '/')) {
    return root;
  }

  // Determine the parent folder where we want to insert the dragged node
  let destFolder = targetPath;
  if (targetType === 'file') {
    destFolder = targetPath.substring(0, targetPath.lastIndexOf('/'));
  }

  // Delete the node from original location first
  const cleanTree = deleteNodeByPath(root, draggedPath);

  // Update paths of the dragged node recursively to reflect the new parent path
  const newPath = `${destFolder}/${draggedNode.name}`;
  let updatedNode = { ...draggedNode };
  if (draggedNode.type === 'folder' && draggedNode.children) {
    updatedNode = {
      ...draggedNode,
      path: newPath,
      children: draggedNode.children.map(child => updatePaths(child, draggedPath, newPath))
    };
  } else {
    updatedNode.path = newPath;
  }

  // Insert node under destFolder
  return insertNodeByPath(cleanTree, destFolder, updatedNode);
};

// Simple deterministic file size generator for files
const getFileSize = (path: string): string => {
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    hash = (hash << 5) - hash + path.charCodeAt(i);
    hash |= 0;
  }
  const absHash = Math.abs(hash);
  const sizeKb = (1.1 + (absHash % 176) / 10).toFixed(1);
  return `${sizeKb}KB`;
};

export default function FileExplorer({ selectedFile, setSelectedFile, onNewFile, onClose, isFloatingEditorOpen }: FileExplorerProps) {
  // ── Chat-aligned workspaces (全局 store, 组件卸载不丢失) ───
  const selectedChatId = useChatsStore(s => s.selectedChatId);
  const updateChat = useChatsStore(s => s.updateChat);

  // workspaces 从全局 store 读取 (不再用 useState, 避免组件卸载后丢失)
  const workspaces = useWorkspaceStore(s => s.workspaces);
  const setWorkspaces = useWorkspaceStore(s => s.setWorkspaces);
  const setWorkspaceTree = useWorkspaceStore(s => s.setWorkspaceTree);
  const setOpenFoldersInStore = useWorkspaceStore(s => s.setOpenFolders);
  const removeWorkspace = useWorkspaceStore(s => s.removeWorkspace);

  // Clean up legacy localStorage key
  useEffect(() => {
    try { localStorage.removeItem('soloforge_workspace_tabs'); } catch {}
  }, []);

  // Current chat's workspace (derived)
  const chatId = selectedChatId || 'default';
  const currentWorkspace = workspaces[chatId];
  const tree: FileNode = currentWorkspace?.tree ?? { name: '无工作区', type: 'folder', path: '无工作区', children: [] };
  const openFolders: Record<string, boolean> = currentWorkspace?.openFolders ?? {};
  const workspaceName = currentWorkspace?.name ?? '';

  // Update active workspace's tree (via store)
  const setTree = useCallback((updater: FileNode | ((prev: FileNode) => FileNode)) => {
    setWorkspaceTree(chatId, updater);
  }, [chatId, setWorkspaceTree]);

  const setOpenFolders = useCallback((updater: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>)) => {
    setOpenFoldersInStore(chatId, updater);
  }, [chatId, setOpenFoldersInStore]);

  const [refreshKey, setRefreshKey] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const hasMatchingChild = (node: FileNode, query: string): boolean => {
    if (!query) return false;
    if (node.type === 'folder' && node.children) {
      return node.children.some(child => 
        child.name.toLowerCase().includes(query.toLowerCase()) || hasMatchingChild(child, query)
      );
    }
    return false;
  };

  // Broadcast channel sync for tree changes
  // 仅在 tree 内容真正变化时发送 (深比较), 避免引用变化导致频繁广播 → 抖动
  const treeRef = useRef(tree);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // 引用相同 → 跳过
    if (treeRef.current === tree) return;
    // 内容相同 → 仅更新 ref, 不广播
    if (JSON.stringify(treeRef.current) === JSON.stringify(tree)) {
      treeRef.current = tree;
      return;
    }
    treeRef.current = tree;
    try {
      const channel = new BroadcastChannel('soloforge-editor-sync-channel');
      channel.postMessage({ type: 'TREE_UPDATE', tree, chatId });
      channel.close();
    } catch {}
  }, [tree, chatId]);

  // Listen to external tree changes
  // Bug 修复: 原实现 useEffect([]) 闭包捕获了初始 setTree (绑定初始 chatId),
  // 导致对话 B 的文件树被写入对话 A 的工作区, 造成跨对话树污染。
  // 现在直接用 setWorkspaces + msg.chatId 精确更新, 不依赖可能过期的 setTree 闭包。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const channel = new BroadcastChannel('soloforge-editor-sync-channel');
      const handleMessage = (event: MessageEvent) => {
        const msg = event.data;
        if (msg && msg.type === 'TREE_UPDATE' && msg.chatId) {
          setWorkspaces(prev => {
            const ws = prev[msg.chatId];
            if (!ws) return prev;
            if (JSON.stringify(ws.tree) === JSON.stringify(msg.tree)) return prev;
            return { ...prev, [msg.chatId]: { ...ws, tree: msg.tree } };
          });
        }
      };
      channel.addEventListener('message', handleMessage);
      return () => {
        channel.removeEventListener('message', handleMessage);
        channel.close();
      };
    } catch {}
  }, []);

  // ── Workspace binding to chat ──────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isLoadingFolder, setIsLoadingFolder] = useState(false);

  const readDirectoryRecursive = async (
    dirHandle: FileSystemDirectoryHandle,
    dirName: string,
    parentPath: string,
    depth: number = 0,
  ): Promise<FileNode> => {
    const children: FileNode[] = [];
    if (depth < 12) {
      try {
        for await (const entry of dirHandle.values()) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
          const entryPath = `${parentPath}/${entry.name}`;
          if (entry.kind === 'file') {
            children.push({ name: entry.name, type: 'file', path: entryPath });
          } else if (entry.kind === 'directory') {
            children.push(await readDirectoryRecursive(entry, entry.name, entryPath, depth + 1));
          }
        }
      } catch {}
    }
    children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { name: dirName, type: 'folder', path: parentPath, children };
  };

  // Bind a loaded tree to the current chat
  // workspaceFolder 可以是完整路径 (Electron) 或仅文件夹名 (浏览器)
  const bindTreeToChat = useCallback((workspaceFolder: string, treeData: FileNode) => {
    // 从路径中提取文件夹名用于显示
    const folderName = workspaceFolder.split(/[\\/]/).pop() || workspaceFolder;
    setWorkspaces(prev => ({
      ...prev,
      [chatId]: { name: folderName, tree: treeData, openFolders: { [folderName]: true } },
    }));
    if (chatId !== 'default' && updateChat) {
      // 保存完整路径 (而非仅名称), 便于 ensureWorkspace 后续恢复
      updateChat(chatId, { workspaceFolder });
    }
  }, [chatId, updateChat, setWorkspaces]);

  const openFolderForChat = useCallback(async () => {
    if (isLoadingFolder) return;
    setIsLoadingFolder(true);
    try {
      // 0. Electron 优先: selectFolder + readDirTree (能获取完整路径, 便于后续恢复)
      const sf = (window as any).soloforge;
      if (sf?.selectFolder && sf?.readDirTree) {
        try {
          const result = await sf.selectFolder();
          if (result?.path) {
            const treeResult = await sf.readDirTree(result.path);
            if (treeResult?.success && treeResult.tree) {
              // 用完整路径作为 workspaceFolder, 便于 ensureWorkspace 后续恢复
              bindTreeToChat(result.path, treeResult.tree as FileNode);
              setIsLoadingFolder(false);
              return;
            }
            // readDirTree 失败 → 回退到 showDirectoryPicker
          }
          // 用户取消 (result === null) → 直接返回
          if (result === null) {
            setIsLoadingFolder(false);
            return;
          }
        } catch (e) {
          console.warn('[FileExplorer] Electron selectFolder failed:', e);
        }
      }
      // 1. Try File System Access API (Chromium)
      if ('showDirectoryPicker' in window) {
        try {
          const dirHandle = await (window as any).showDirectoryPicker({ mode: 'read' });
          const folderName = dirHandle.name;
          const treeData = await readDirectoryRecursive(dirHandle, folderName, folderName);
          bindTreeToChat(folderName, treeData);
          setIsLoadingFolder(false);
          return;
        } catch (pickErr: any) {
          if (pickErr.name === 'AbortError') { setIsLoadingFolder(false); return; }
          // showDirectoryPicker not usable — fall through to hidden input
          console.warn('[FileExplorer] showDirectoryPicker failed:', pickErr.message);
        }
      }
      // 2. Fallback: hidden <input webkitdirectory> (works in Electron + all Chromium)
      fileInputRef.current?.click();
    } finally {
      // Don't set false here for fallback path — handleFileInputChange does it
      if ('showDirectoryPicker' in window || sf?.selectFolder) setIsLoadingFolder(false);
    }
  }, [chatId, isLoadingFolder, bindTreeToChat]);

  // Fallback: <input type="file" webkitdirectory> handler
  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const firstFile = files[0];
    const webkitRelativePath = (firstFile as any).webkitRelativePath as string;
    if (!webkitRelativePath) return;
    const folderName = webkitRelativePath.split('/')[0];
    // Build tree from FileList
    const root: FileNode = { name: folderName, type: 'folder', path: folderName, children: [] };
    const dirMap = new Map<string, FileNode>();
    dirMap.set(folderName, root);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const relPath = (f as any).webkitRelativePath as string;
      if (!relPath) continue;
      const parts = relPath.split('/');
      let currentPath = parts[0];
      for (let j = 1; j < parts.length; j++) {
        const partPath = `${currentPath}/${parts[j]}`;
        if (j < parts.length - 1) {
          // It's a directory
          if (!dirMap.has(partPath)) {
            const dirNode: FileNode = { name: parts[j], type: 'folder', path: partPath, children: [] };
            dirMap.set(partPath, dirNode);
            const parent = dirMap.get(currentPath);
            if (parent && parent.children && !parent.children.some(c => c.path === partPath)) {
              parent.children.push(dirNode);
            }
          }
        } else {
          // It's a file
          if (parts[j].startsWith('.') || parts[j] === 'node_modules') continue;
          const fileNode: FileNode = { name: parts[j], type: 'file', path: partPath };
          const parent = dirMap.get(currentPath);
          if (parent && parent.children) {
            parent.children.push(fileNode);
          }
        }
        currentPath = partPath;
      }
    }
    // Sort all directories
    const sortTree = (node: FileNode): FileNode => {
      if (node.children) {
        node.children.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        node.children.forEach(sortTree);
      }
      return node;
    };
    sortTree(root);

    setWorkspaces(prev => ({
      ...prev,
      [chatId]: { name: folderName, tree: root, openFolders: { [folderName]: true } },
    }));
    if (chatId !== 'default' && updateChat) {
      updateChat(chatId, { workspaceFolder: folderName });
    }
    // Reset input
    e.target.value = '';
  }, [chatId, updateChat, setWorkspaces]);

  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    visible: boolean;
    targetPath: string;
    targetType: 'file' | 'folder' | 'root_blank';
  }>({
    x: 0,
    y: 0,
    visible: false,
    targetPath: tree.path,
    targetType: 'root_blank',
  });

  // Clipboard State
  const [clipboard, setClipboard] = useState<{
    type: 'copy' | 'cut';
    node: FileNode;
  } | null>(null);

  // Dialog State
  const [dialog, setDialog] = useState<{
    type: 'new_file' | 'new_folder' | 'rename' | 'show_explorer' | null;
    targetPath: string;
    inputValue: string;
  }>({
    type: null,
    targetPath: '',
    inputValue: ''
  });

  // Simple Toast State
  const [toast, setToast] = useState<{
    show: boolean;
    message: string;
  }>({
    show: false,
    message: ''
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dialog.type) {
        setDialog({ type: null, targetPath: '', inputValue: '' });
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [dialog.type]);

  // 确保根文件夹始终展开 (当工作区树变化时)
  // 修复: ensureWorkspace 或 localStorage 恢复的数据可能 openFolders 为空或不匹配,
  // 导致根文件夹折叠, 用户只看到文件夹名但看不到文件
  // 注意: 不将 openFolders 放入依赖, 避免用户折叠根文件夹后被自动重新展开
  const openFoldersRef = useRef(openFolders);
  openFoldersRef.current = openFolders;
  useEffect(() => {
    if (!currentWorkspace?.tree?.children?.length) return;
    const rootPath = currentWorkspace.tree.path;
    if (!openFoldersRef.current[rootPath]) {
      setOpenFolders(prev => ({ ...prev, [rootPath]: true }));
    }
  }, [currentWorkspace?.tree?.path, currentWorkspace?.tree?.children?.length, setOpenFolders]);

  // Automatically expand parent folders of selectedFile when selectedFile changes
  useEffect(() => {
    if (!selectedFile) return;
    const parts = selectedFile.split('/');
    if (parts.length <= 1) return;
    
    setOpenFolders(prev => {
      const newOpenFolders = { ...prev };
      let currentPath = '';
      let updated = false;
      
      for (let i = 0; i < parts.length - 1; i++) {
        currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
        if (!newOpenFolders[currentPath]) {
          newOpenFolders[currentPath] = true;
          updated = true;
        }
      }
      return updated ? newOpenFolders : prev;
    });
  }, [selectedFile]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Drag and drop states for explorer files/folders
  const [draggedNodePath, setDraggedNodePath] = useState<string | null>(null);
  const [dragOverNodePath, setDragOverNodePath] = useState<string | null>(null);

  const handleFileDragStart = (e: React.DragEvent, path: string) => {
    setDraggedNodePath(path);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', path);
  };

  const handleFileDragOver = (e: React.DragEvent, path: string) => {
    e.preventDefault();
    if (draggedNodePath === path) return;
    setDragOverNodePath(path);
  };

  const handleFileDragLeave = (e: React.DragEvent, path: string) => {
    if (dragOverNodePath === path) {
      setDragOverNodePath(null);
    }
  };

  const handleFileDragEnd = () => {
    setDraggedNodePath(null);
    setDragOverNodePath(null);
  };

  const handleFileDrop = (e: React.DragEvent, targetPath: string) => {
    e.preventDefault();
    if (!draggedNodePath || draggedNodePath === targetPath) {
      setDraggedNodePath(null);
      setDragOverNodePath(null);
      return;
    }

    const targetNode = findNodeByPath(tree, targetPath);
    if (!targetNode) {
      setDraggedNodePath(null);
      setDragOverNodePath(null);
      return;
    }

    setTree(prev => {
      const updated = moveNode(prev, draggedNodePath, targetPath, targetNode.type);
      return updated;
    });

    if (targetNode.type === 'folder') {
      setOpenFolders(prev => ({ ...prev, [targetPath]: true }));
    } else {
      const parentPath = targetPath.substring(0, targetPath.lastIndexOf('/'));
      if (parentPath) {
        setOpenFolders(prev => ({ ...prev, [parentPath]: true }));
      }
    }

    // If dragged selected file, update selection to keep in sync
    if (selectedFile === draggedNodePath) {
      const dragNodeName = draggedNodePath.split('/').pop() || '';
      let newSelectedPath = targetPath;
      if (targetNode.type === 'folder') {
        newSelectedPath = `${targetPath}/${dragNodeName}`;
      } else {
        const parentPath = targetPath.substring(0, targetPath.lastIndexOf('/'));
        newSelectedPath = parentPath ? `${parentPath}/${dragNodeName}` : dragNodeName;
      }
      setSelectedFile(newSelectedPath);
    }

    setDraggedNodePath(null);
    setDragOverNodePath(null);
    triggerToast(`成功移动文件/目录至目标位置！`);
  };

  // Close context menu on global click
  // NOTE: Use mousedown instead of click to avoid race condition with contextmenu:
  // right-click fires contextmenu -> mouseup -> click, closing the menu immediately.
  // mousedown fires BEFORE contextmenu, so we use a timestamp guard.
  const contextMenuOpenTime = useRef(0);
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      // Ignore if the click is inside the context menu itself
      const target = e.target as HTMLElement;
      if (target.closest('[data-context-menu]')) return;
      // Suppress close within 200ms of opening (right-click sequence)
      if (Date.now() - contextMenuOpenTime.current < 200) return;
      setContextMenu(prev => prev.visible ? { ...prev, visible: false } : prev);
    };
    window.addEventListener('mousedown', handleMouseDown);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
    };
  }, []);

  const triggerToast = (message: string) => {
    setToast({ show: true, message });
    setTimeout(() => {
      setToast(prev => ({ ...prev, show: false }));
    }, 2800);
  };

  const handleRefresh = () => {
    setIsRefreshing(true);
    setRefreshKey((prev) => prev + 1);
    triggerToast("刷新资源管理器成功！");
    setTimeout(() => {
      setIsRefreshing(false);
    }, 600);
  };

  const toggleFolder = (path: string) => {
    setOpenFolders((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  // Trigger Context menu
  const openCustomMenu = (e: React.MouseEvent, path: string, type: 'file' | 'folder' | 'root_blank') => {
    e.preventDefault();
    e.stopPropagation();
    contextMenuOpenTime.current = Date.now();

    const rect = scrollContainerRef.current?.getBoundingClientRect();
    const menuWidth = 190;
    const menuHeight = 280;

    // Relative to window
    let x = e.clientX;
    let y = e.clientY;

    // Safety boundary constraints so it stays inside screen
    if (x + menuWidth > window.innerWidth) {
      x = window.innerWidth - menuWidth - 8;
    }
    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight - 8;
    }

    setContextMenu({
      x,
      y,
      visible: true,
      targetPath: path,
      targetType: type
    });
  };

  // Get color by file extension suffix
  const getFileIconColor = (name: string) => {
    const parts = name.split('.');
    const ext = parts[parts.length - 1].toLowerCase();
    switch (ext) {
      case 'py': return 'text-emerald-500';
      case 'vue': return 'text-emerald-400';
      case 'js': return 'text-amber-400';
      case 'ts': case 'tsx': return 'text-sky-400';
      case 'html': return 'text-orange-500';
      case 'css': return 'text-sky-300';
      case 'json': return 'text-red-400';
      case 'md': return 'text-purple-400';
      default: return 'text-on-surface/40';
    }
  };

  // Perform context action
  const handleAction = (action: string) => {
    const { targetPath, targetType } = contextMenu;
    setContextMenu(prev => ({ ...prev, visible: false }));

    if (action === 'new_file') {
      const activeFolder = targetType === 'folder' ? targetPath : tree.path;
      setDialog({
        type: 'new_file',
        targetPath: activeFolder,
        inputValue: 'index.js'
      });
    } else if (action === 'new_folder') {
      const activeFolder = targetType === 'folder' ? targetPath : tree.path;
      setDialog({
        type: 'new_folder',
        targetPath: activeFolder,
        inputValue: 'unnamed_folder'
      });
    } else if (action === 'rename') {
      const node = findNodeByPath(tree, targetPath);
      setDialog({
        type: 'rename',
        targetPath,
        inputValue: node ? node.name : ''
      });
    } else if (action === 'delete') {
      if (targetPath === tree.path) {
        triggerToast("不可删除工作区根节点！");
        return;
      }
      setTree(prev => deleteNodeByPath(prev, targetPath));
      if (selectedFile === targetPath) {
        setSelectedFile('');
      }
      triggerToast(`已成功删除: ${targetPath.split('/').pop()}`);
    } else if (action === 'copy' || action === 'cut') {
      const node = findNodeByPath(tree, targetPath);
      if (node) {
        setClipboard({
          type: action as 'copy' | 'cut',
          node
        });
        triggerToast(`已${action === 'copy' ? '复制' : '剪切'}: ${node.name}`);
      }
    } else if (action === 'paste') {
      if (!clipboard) return;
      const destFolder = targetType === 'folder' ? targetPath : tree.path;
      
      // Perform deep duplication
      const duplicatedNode = JSON.parse(JSON.stringify(clipboard.node)) as FileNode;
      
      // Remove original if cut
      let nextTree = tree;
      if (clipboard.type === 'cut') {
        if (destFolder.startsWith(clipboard.node.path)) {
          triggerToast("无法在子文件夹中执行剪贴操作！");
          return;
        }
        nextTree = deleteNodeByPath(nextTree, clipboard.node.path);
      }

      nextTree = insertNodeByPath(nextTree, destFolder, duplicatedNode);
      setTree(nextTree);
      
      if (clipboard.type === 'cut') {
        setClipboard(null); // Clear clipboard if cut
      }
      
      triggerToast(`已粘贴 ${duplicatedNode.name} 至 ${destFolder.split('/').pop()}`);
    } else if (action === 'copy_path') {
      const pseudoPath = `${tree.path}\\${targetPath.replace(/\//g, '\\')}`;
      navigator.clipboard.writeText(pseudoPath)
        .then(() => triggerToast("本地绝对路径复制成功！"))
        .catch(() => triggerToast("复制失败，请重试"));
    } else if (action === 'add_to_chat') {
      window.dispatchEvent(new CustomEvent('add-to-chat', {
        detail: { filePath: targetPath }
      }));
      triggerToast("已成功加载文件引用至 AI 对话框！");
    } else if (action === 'reveal') {
      setDialog({
        type: 'show_explorer',
        targetPath,
        inputValue: ''
      });
    }
  };

  // Perform Confirmation of Dialogs
  const confirmDialog = () => {
    const { type, targetPath, inputValue } = dialog;
    setDialog({ type: null, targetPath: '', inputValue: '' });

    if (!inputValue.trim()) return;

    if (type === 'new_file') {
      const newNode: FileNode = {
        name: inputValue,
        type: 'file',
        path: `${targetPath}/${inputValue}`
      };
      setTree(prev => insertNodeByPath(prev, targetPath, newNode));
      setOpenFolders(prev => ({ ...prev, [targetPath]: true }));
      setSelectedFile(`${targetPath}/${inputValue}`);
      triggerToast(`已成功创建文件: ${inputValue}`);
    } else if (type === 'new_folder') {
      const newNode: FileNode = {
        name: inputValue,
        type: 'folder',
        path: `${targetPath}/${inputValue}`,
        children: []
      };
      setTree(prev => insertNodeByPath(prev, targetPath, newNode));
      setOpenFolders(prev => ({ ...prev, [targetPath]: true, [`${targetPath}/${inputValue}`]: true }));
      triggerToast(`已成功创建文件夹: ${inputValue}`);
    } else if (type === 'rename') {
      setTree(prev => renameNodeByPath(prev, targetPath, inputValue));
      // Update selected state if needed
      const parentPath = targetPath.substring(0, targetPath.lastIndexOf('/'));
      const newPath = parentPath ? `${parentPath}/${inputValue}` : inputValue;
      if (selectedFile === targetPath) {
        setSelectedFile(newPath);
      }
      triggerToast(`已重命名为: ${inputValue}`);
    }
  };

  const renderNode = (node: FileNode, depth = 0) => {
    const isSearchActive = !!searchQuery;
    const matchCurrent = !isSearchActive || node.name.toLowerCase().includes(searchQuery.toLowerCase()) || hasMatchingChild(node, searchQuery);
    
    if (!matchCurrent) return null;

    const isRoot = node.path === tree.path;
    const isOpen = isSearchActive 
      ? (openFolders[node.path] ?? true) 
      : (openFolders[node.path] ?? (isRoot && !!(node.children && node.children.length > 0)));
    const isSelected = selectedFile === node.path;

    if (node.type === 'folder') {
      return (
        <React.Fragment key={node.path}>
          <div className="select-none">
            {/* Folder row */}
            <div
              draggable
              onDragStart={(e) => handleFileDragStart(e, node.path)}
              onDragOver={(e) => handleFileDragOver(e, node.path)}
              onDragLeave={(e) => handleFileDragLeave(e, node.path)}
              onDragEnd={handleFileDragEnd}
              onDrop={(e) => handleFileDrop(e, node.path)}
              onClick={() => toggleFolder(node.path)}
              onContextMenu={(e) => openCustomMenu(e, node.path, 'folder')}
              style={{ paddingLeft: `${depth * 10 + 6}px` }}
              className={`flex items-center justify-between py-1 px-2.5 rounded-md cursor-grab active:cursor-grabbing group transition-colors duration-150 relative ${
                draggedNodePath === node.path
                  ? 'opacity-20 bg-red-500/10 border-dashed border-red-500/30'
                  : dragOverNodePath === node.path
                    ? 'bg-primary/10 border border-primary/40 shadow-lg text-primary'
                    : isSelected ? 'bg-primary/8 text-primary font-semibold' : 'hover:bg-surface-bright text-on-surface/80'
              }`}
            >
              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                {isOpen ? (
                  <ChevronDown className="w-3.5 h-3.5 text-on-surface/40 shrink-0" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-on-surface/40 shrink-0" />
                )}
                {isOpen ? (
                  <FolderOpen className="w-4 h-4 text-primary shrink-0" />
                ) : (
                  <Folder className="w-4 h-4 text-primary/80 shrink-0" />
                )}
                <span className="text-[12px] truncate">{node.name}</span>
                {dragOverNodePath === node.path && draggedNodePath !== node.path && (
                  <span className="text-[9px] font-bold text-primary bg-primary/15 border border-primary/30 px-1.5 py-0.2 rounded ml-1.5 select-none animate-pulse shrink-0">
                    移动至此
                  </span>
                )}
              </div>

              {/* Hover visual options trigger button */}
              <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 mr-1 transition-opacity z-10">
                <button 
                  onClick={(e) => { e.stopPropagation(); openCustomMenu(e, node.path, 'folder'); }}
                  className="p-1 hover:bg-primary/15 text-on-surface/40 hover:text-primary rounded transition-colors"
                  title="操作菜单"
                >
                  <MoreVertical className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* Child nodes */}
            {isOpen && node.children && (
              <div className="mt-0.5">
                {node.children.map((child) => renderNode(child, depth + 1))}
              </div>
            )}
          </div>
        </React.Fragment>
      );
    } else {
      const fileColorClass = getFileIconColor(node.name);
      return (
        <React.Fragment key={node.path}>
          <div
            draggable
            onDragStart={(e) => handleFileDragStart(e, node.path)}
            onDragOver={(e) => handleFileDragOver(e, node.path)}
            onDragLeave={(e) => handleFileDragLeave(e, node.path)}
            onDragEnd={handleFileDragEnd}
            onDrop={(e) => handleFileDrop(e, node.path)}
            onClick={() => setSelectedFile(node.path)}
            onContextMenu={(e) => openCustomMenu(e, node.path, 'file')}
            style={{ paddingLeft: `${depth * 10 + 20}px` }}
            className={`flex items-center justify-between py-1 px-2.5 rounded-md cursor-grab active:cursor-grabbing group transition-colors duration-150 relative ${
              draggedNodePath === node.path
                ? 'opacity-20 bg-red-500/10 border-dashed border-red-500/30'
                : dragOverNodePath === node.path
                  ? 'bg-primary/10 border border-primary/40 shadow-lg text-primary'
                  : isSelected 
                    ? 'bg-primary/12 text-primary font-bold border-l-2 border-primary' 
                    : 'hover:bg-surface-bright text-on-surface/70 hover:text-on-surface'
            }`}
          >
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <FileCode className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-primary' : fileColorClass}`} />
              <span className="text-[12px] truncate">{node.name}</span>
              {dragOverNodePath === node.path && draggedNodePath !== node.path && (
                <span className="text-[9px] font-bold text-primary bg-primary/15 border border-primary/30 px-1.5 py-0.2 rounded ml-1.5 select-none animate-pulse shrink-0">
                  同级移动
                </span>
              )}
              <span className="text-[10px] text-on-surface/35 font-mono shrink-0 select-none ml-1.5 px-1 py-0.2 bg-surface-bright rounded border border-outline/50">
                {getFileSize(node.path)}
              </span>
            </div>

            {/* Hover visual template trigger */}
            <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 mr-1 transition-opacity z-10">
              <button 
                onClick={(e) => { e.stopPropagation(); openCustomMenu(e, node.path, 'file'); }}
                className="p-1 hover:bg-primary/15 text-on-surface/40 hover:text-primary rounded transition-colors"
                title="操作菜单"
              >
                <MoreVertical className="w-3 h-3" />
              </button>
            </div>
          </div>
        </React.Fragment>
      );
    }
  };

  return (
    <div className="w-full h-full bg-surface flex flex-col select-none relative">
      {/* Search Header / Resource Management */}
      <div className="p-3 border-b border-outline/50 flex items-center justify-between shrink-0">
        <span className="font-display font-bold text-[12px] text-on-surface truncate max-w-[120px]">{workspaceName || '无工作区'}</span>
        <div className="flex items-center gap-1.5">
          <button 
            type="button"
            onClick={handleRefresh}
            className={`p-1 hover:bg-surface-bright rounded text-on-surface/50 hover:text-primary transition-colors cursor-pointer flex items-center justify-center sf-press-lg ${isRefreshing ? 'animate-spin' : ''}`}
            title="刷新工作区"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1 hover:bg-surface-bright rounded text-on-surface/50 hover:text-on-surface transition-colors cursor-pointer"
              title="收起资源管理器"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* ─── Workspace Bar ─── */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-outline/30 bg-surface-bright/50 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <Folder className="w-3 h-3 text-primary shrink-0" />
          {currentWorkspace ? (
            <span className="text-[10px] font-bold text-primary truncate">{currentWorkspace.name}</span>
          ) : (
            <span className="text-[10px] text-on-surface/40">未绑定文件夹</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {currentWorkspace && (
            <button
              type="button"
              onClick={() => {
                if (confirm('解除当前对话的工作区绑定？')) {
                  removeWorkspace(chatId);
                }
              }}
              className="p-1 rounded text-on-surface/30 hover:text-rose-400 hover:bg-rose-500/10 transition-colors cursor-pointer"
              title="解除绑定"
            >
              <X className="w-3 h-3" />
            </button>
          )}
          <button
            type="button"
            onClick={openFolderForChat}
            disabled={isLoadingFolder}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold transition-colors cursor-pointer ${
              currentWorkspace
                ? 'text-on-surface/50 hover:text-primary hover:bg-surface/50'
                : 'text-primary bg-primary/10 hover:bg-primary/20 border border-primary/25'
            } ${isLoadingFolder ? 'animate-pulse opacity-60' : ''}`}
            title="为当前对话打开文件夹"
          >
            {isLoadingFolder ? (
              <RefreshCw className="w-3 h-3 animate-spin" />
            ) : (
              <FolderPlus className="w-3 h-3" />
            )}
            <span>{currentWorkspace ? '切换' : '打开文件夹'}</span>
          </button>
        </div>
      </div>
      {/* Hidden file input for fallback */}
      <input
        ref={fileInputRef}
        type="file"
        // @ts-ignore
        webkitdirectory=""
        directory=""
        multiple
        style={{ display: 'none' }}
        onChange={handleFileInputChange}
      />

      {/* Search Input and Documentation Helper Trigger */}
      <div className="px-3 pb-2 pt-2 border-b border-outline/40 flex items-center gap-1.5 shrink-0 bg-surface">
        <div className="relative flex-1">
          <Search className="w-3 h-3 text-on-surface/40 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索工作区文件..."
            className="w-full bg-bg border border-outline focus:border-primary/50 text-[11px] text-on-surface pl-8 pr-6 py-1.5 rounded outline-none placeholder-on-surface/30 font-sans"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-on-surface/40 hover:text-on-surface"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          )}
        </div>
        
        {/* Document helper trigger button */}
        {isFloatingEditorOpen && (
          <button
            onClick={() => {
              window.dispatchEvent(new CustomEvent('soloforge-open-docs-generator'));
            }}
            className="flex items-center justify-center p-2 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-[#34d399] border border-emerald-500/20 hover:border-emerald-500/50 cursor-pointer self-stretch shrink-0 transition-all active:scale-95"
            title="生成代码说明文档"
          >
            <FileText className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Directory file trees scroll container */}
      <div 
        ref={scrollContainerRef}
        onContextMenu={(e) => currentWorkspace && openCustomMenu(e, tree.path, 'root_blank')}
        className="flex-1 overflow-y-auto p-1.5 space-y-0.5 scrollbar-thin scrollbar-thumb-outline relative min-h-[150px]"
      >
        {currentWorkspace ? (
          <div key={refreshKey}>
            {renderNode(tree)}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center px-4 py-8 gap-3">
            <FolderPlus className="w-8 h-8 text-on-surface/20" />
            <p className="text-[11px] text-on-surface/40 leading-relaxed">
              当前对话未绑定工作区文件夹。<br />
              点击上方「打开文件夹」选择一个本地目录。
            </p>
            <button
              type="button"
              onClick={openFolderForChat}
              disabled={isLoadingFolder}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/25 rounded-lg text-[10px] font-bold cursor-pointer transition-colors"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>打开文件夹</span>
            </button>
          </div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu.visible && (
        <div
          data-context-menu
          style={{
            position: 'fixed',
            left: `${contextMenu.x}px`,
            top: `${contextMenu.y}px`,
            zIndex: 99999,
          } as React.CSSProperties}
          className="w-[190px] bg-surface border border-outline rounded-lg shadow-2xl p-1.5 flex flex-col font-sans select-none"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
            {/* Folder / Blank only operations */}
            {contextMenu.targetType !== 'file' && (
              <>
                <button
                  onClick={() => handleAction('new_folder')}
                  className="flex items-center gap-2 px-2 py-1.5 hover:bg-primary/15 hover:text-primary rounded text-[11px] text-on-surface/80 transition-colors text-left cursor-pointer"
                >
                  <FolderPlus className="w-3.5 h-3.5 shrink-0" />
                  <span>新建文件夹</span>
                </button>
                <button
                  onClick={() => handleAction('new_file')}
                  className="flex items-center gap-2 px-2 py-1.5 hover:bg-primary/15 hover:text-primary rounded text-[11px] text-on-surface/80 transition-colors text-left cursor-pointer"
                >
                  <FilePlus className="w-3.5 h-3.5 shrink-0" />
                  <span>新建文件</span>
                </button>
                <div className="h-[1px] bg-outline/50 my-1" />
              </>
            )}

            <button
              onClick={() => handleAction('reveal')}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-primary/15 hover:text-primary rounded text-[11px] text-on-surface/80 transition-colors text-left cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5 shrink-0" />
              <span>在资源管理器中显示</span>
            </button>

            <div className="h-[1px] bg-outline/50 my-1" />

            <button
              onClick={() => handleAction('copy')}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-primary/15 hover:text-primary rounded text-[11px] text-on-surface/80 transition-colors text-left cursor-pointer"
            >
              <Copy className="w-3.5 h-3.5 shrink-0" />
              <span>复制 (Copy)</span>
            </button>
            <button
              onClick={() => handleAction('cut')}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-primary/15 hover:text-primary rounded text-[11px] text-on-surface/80 transition-colors text-left cursor-pointer"
            >
              <Scissors className="w-3.5 h-3.5 shrink-0" />
              <span>剪切 (Cut)</span>
            </button>
            <button
              disabled={!clipboard}
              onClick={() => handleAction('paste')}
              className={`flex items-center gap-2 px-2 py-1.5 rounded text-[11px] transition-colors text-left ${
                clipboard 
                  ? 'hover:bg-primary/15 hover:text-primary text-on-surface/80 cursor-pointer' 
                  : 'text-on-surface/30 cursor-not-allowed'
              }`}
            >
              <Clipboard className="w-3.5 h-3.5 shrink-0" />
              <span>粘贴 (Paste)</span>
            </button>

            <div className="h-[1px] bg-outline/50 my-1" />

            <button
              onClick={() => handleAction('rename')}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-primary/15 hover:text-primary rounded text-[11px] text-on-surface/80 transition-colors text-left cursor-pointer"
            >
              <Edit3 className="w-3.5 h-3.5 shrink-0" />
              <span>重命名 (Rename)</span>
            </button>
            <button
              onClick={() => handleAction('delete')}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-red-500/15 hover:text-red-500 rounded text-[11px] text-red-500 transition-colors text-left cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5 shrink-0" />
              <span>删除 (Delete)</span>
            </button>

            <div className="h-[1px] bg-outline/50 my-1" />

            <button
              onClick={() => handleAction('copy_path')}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-primary/15 hover:text-primary rounded text-[11px] text-on-surface/80 transition-colors text-left cursor-pointer"
            >
              <Link2 className="w-3.5 h-3.5 shrink-0" />
              <span>复制绝对路径</span>
            </button>
            <button
              onClick={() => handleAction('add_to_chat')}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-primary/15 hover:text-primary rounded text-[11px] text-primary/85 font-medium transition-colors text-left cursor-pointer"
            >
              <MessageSquarePlus className="w-3.5 h-3.5 shrink-0 text-primary" />
              <span>添加到对话</span>
            </button>
          </div>
        )}

      {/* Interactive Beautiful Prompt Modal Dialogs */}
      <MountTransition show={!!dialog.type} variant="fade-scale" duration={150}>
          <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
            <div
              className="w-full max-w-sm bg-surface border border-outline rounded-xl shadow-2xl p-4 font-sans text-on-surface"
            >
              {dialog.type === 'show_explorer' ? (
                // Reveal in system explorer preview window
                <div>
                  <div className="flex items-center gap-2 text-primary text-xs font-semibold mb-3">
                    <ExternalLink className="w-4 h-4 text-primary" />
                    <span>外部系统资源管理器请求</span>
                  </div>
                  <p className="text-[11px] text-on-surface/70 leading-relaxed mb-4">
                    由于系统浏览器沙箱机制限制，无法直接调用本地文件管理器窗口。已经为您在虚拟宿主机 D 盘映射对应目录：
                  </p>
                  <div className="bg-surface-bright border border-outline/50 p-2.5 rounded text-[10px] text-amber-600 font-mono break-all mb-4">
                    {`${tree.path}\\${dialog.targetPath.replace(/\//g, '\\')}`}
                  </div>
                  <div className="flex justify-end">
                    <button
                      onClick={() => setDialog({ type: null, targetPath: '', inputValue: '' })}
                      className="bg-primary hover:bg-primary/80 text-white text-[11px] font-bold px-4 py-1.5 rounded active:scale-95 transition-transform cursor-pointer"
                    >
                      我明白了
                    </button>
                  </div>
                </div>
              ) : (
                // Input Prompt form
                <div>
                  <h3 className="text-xs font-bold text-on-surface mb-2 tracking-wide">
                    {dialog.type === 'new_file' && '创建新文件'}
                    {dialog.type === 'new_folder' && '创建新文件夹'}
                    {dialog.type === 'rename' && '重命名对象'}
                  </h3>
                  
                  <p className="text-[10px] text-on-surface/40 mb-3">
                    {dialog.type === 'new_file' && `目标路径: ${dialog.targetPath}`}
                    {dialog.type === 'new_folder' && `目标路径: ${dialog.targetPath}`}
                    {dialog.type === 'rename' && `当前路径: ${dialog.targetPath}`}
                  </p>

                  <input
                    type="text"
                    value={dialog.inputValue}
                    onChange={(e) => setDialog(prev => ({ ...prev, inputValue: e.target.value }))}
                    className="w-full bg-surface-bright border border-outline rounded px-2.5 py-1.5 text-xs text-on-surface outline-none focus:border-primary/50 mb-4"
                    autoFocus
                    placeholder={dialog.type === 'new_file' ? '例如 main.py, index.html' : '目录名称'}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') confirmDialog();
                    }}
                  />

                  <div className="flex items-center justify-end gap-2 text-xs font-semibold">
                    <button
                      onClick={() => setDialog({ type: null, targetPath: '', inputValue: '' })}
                      className="px-3 py-1.5 text-on-surface/40 hover:text-on-surface transition-colors cursor-pointer text-[11px]"
                    >
                      取消
                    </button>
                    <button
                      onClick={confirmDialog}
                      className="bg-primary hover:bg-primary/80 text-white rounded px-4 py-1.5 active:scale-95 transition-all cursor-pointer text-[11px]"
                    >
                      确认
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
      </MountTransition>

      {/* Floating system Feedback Toasts */}
      <MountTransition show={toast.show} variant="slide-up" duration={180}>
          <div
            className="absolute bottom-4 left-1/2 bg-emerald-500/90 text-white text-[10px] md:text-[11px] px-3.5 py-1.5 rounded-full shadow-2xl border border-emerald-500/30 font-medium flex items-center gap-1.5 z-40 pointer-events-none whitespace-nowrap"
          >
            <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>{toast.message}</span>
          </div>
      </MountTransition>
    </div>
  );
}
