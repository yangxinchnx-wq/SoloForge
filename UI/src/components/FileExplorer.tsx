import React, { useState, useEffect, useRef } from 'react';
import { 
  ChevronDown, 
  ChevronRight, 
  Folder, 
  FolderOpen, 
  FileCode, 
  Plus, 
  RefreshCw, 
  Terminal, 
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
  AlertCircle,
  Search,
  FileText
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface FileNode {
  name: string;
  type: 'file' | 'folder';
  path: string;
  children?: FileNode[];
}

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
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({
    'BlogSystem': true,
    'BlogSystem/src': true,
    'BlogSystem/src/components': false,
    'BlogSystem/src/pages': false,
    'BlogSystem/src/styles': false,
  });

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

  // Tree State
  // ==========================================
  // 【后端对接提示 - 文件树初始加载方案】
  // 原先通过 localStorage 来储存静态模拟文件树。
  // 后期接入真实后端磁盘或云存储（如网盘/工程空间）时：
  // 1. 可以发出 API Get 接口请求: GET /api/files/tree
  // 2. 后端递归读取宿主物理路径，返回符合 FileNode 标准的树状 JSON 结构并执行 setTree
  // ==========================================
  // Function to ensure assets/fonts and rules folders always exist with core files
  const ensureRequiredFolders = (root: FileNode) => {
    if (!root.children) {
      root.children = [];
    }
    
    // 1. Ensure assets/fonts exists
    let assetsNode = root.children.find(c => c.name === 'assets');
    if (!assetsNode) {
      assetsNode = {
        name: 'assets',
        type: 'folder',
        path: `${root.path}/assets`,
        children: []
      };
      root.children.push(assetsNode);
    }
    
    if (!assetsNode.children) {
      assetsNode.children = [];
    }
    
    let fontsNode = assetsNode.children.find(c => c.name === 'fonts');
    if (!fontsNode) {
      fontsNode = {
        name: 'fonts',
        type: 'folder',
        path: `${assetsNode.path}/fonts`,
        children: []
      };
      assetsNode.children.push(fontsNode);
    }
    
    if (!fontsNode.children) {
      fontsNode.children = [];
    }
    
    const requiredFontFiles = [
      'Custom-GeekFont.ttf',
      'TechMono-Retro.woff2'
    ];
    
    requiredFontFiles.forEach(filename => {
      if (!fontsNode!.children!.some(c => c.name === filename)) {
        fontsNode!.children!.push({
          name: filename,
          type: 'file',
          path: `${fontsNode!.path}/${filename}`
        });
      }
    });

    // 2. Ensure rules exists
    let rulesNode = root.children.find(c => c.name === 'rules');
    if (!rulesNode) {
      rulesNode = {
        name: 'rules',
        type: 'folder',
        path: `${root.path}/rules`,
        children: []
      };
      root.children.push(rulesNode);
    }
    
    if (!rulesNode.children) {
      rulesNode.children = [];
    }
    
    const requiredRuleFiles = [
      'normal_rules.md',
      'performance_rules.md',
      'expert_rules.md',
      'ultimate_rules.md'
    ];
    
    requiredRuleFiles.forEach(filename => {
      if (!rulesNode!.children!.some(c => c.name === filename)) {
        rulesNode!.children!.push({
          name: filename,
          type: 'file',
          path: `${rulesNode!.path}/${filename}`
        });
      }
    });
  };

  const getDefaultTree = (): FileNode => {
    return {
      name: 'BlogSystem',
      type: 'folder',
      path: 'BlogSystem',
      children: [
        {
          name: 'docs',
          type: 'folder',
          path: 'BlogSystem/docs',
          children: []
        },
        {
          name: 'public',
          type: 'folder',
          path: 'BlogSystem/public',
          children: []
        },
        {
          name: 'src',
          type: 'folder',
          path: 'BlogSystem/src',
          children: [
            {
              name: 'components',
              type: 'folder',
              path: 'BlogSystem/src/components',
              children: []
            },
            {
              name: 'pages',
              type: 'folder',
              path: 'BlogSystem/src/pages',
              children: []
            },
            {
              name: 'styles',
              type: 'folder',
              path: 'BlogSystem/src/styles',
              children: []
            },
            {
              name: 'App.vue',
              type: 'file',
              path: 'BlogSystem/src/App.vue'
            },
            {
              name: 'main.js',
              type: 'file',
              path: 'BlogSystem/src/main.js'
            }
          ]
        },
        {
          name: '.gitignore',
          type: 'file',
          path: 'BlogSystem/.gitignore'
        },
        {
          name: 'package.json',
          type: 'file',
          path: 'BlogSystem/package.json'
        },
        {
          name: 'README.md',
          type: 'file',
          path: 'BlogSystem/README.md'
        },
        {
          name: 'vite.config.js',
          type: 'file',
          path: 'BlogSystem/vite.config.js'
        }
      ]
    };
  };

  const [tree, setTree] = useState<FileNode>(() => {
    let base: FileNode;
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('soloforge_fileTree');
        if (saved) {
          base = JSON.parse(saved);
        } else {
          base = getDefaultTree();
        }
      } catch (e) {
        console.warn(e);
        base = getDefaultTree();
      }
    } else {
      base = getDefaultTree();
    }
    
    ensureRequiredFolders(base);
    return base;
  });

  // Keep tree in sync with localStorage and trigger channel broadcast
  // ==========================================
  // 【后端对接提示 - 文件树同步与变动回调】
  // 此处在 tree 变化时在 localStorage 中进行了持久化并向广播通道同步。
  // 后期后端介入时，可将 tree 的变更操作通过 API 同步至服务器。
  // 考虑到部分复杂操作（如批量剪切、创建、删除、重命名文件），
  // 应该直接在前端向特定的文件操作 API 发送请求，成功后再更新 tree 的状态。
  // ==========================================
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('soloforge_fileTree', JSON.stringify(tree));
        const channel = new BroadcastChannel('soloforge-editor-sync-channel');
        channel.postMessage({
          type: 'TREE_UPDATE',
          tree: tree
        });
        channel.close();
      } catch (e) {
        console.warn(e);
      }
    }
  }, [tree]);

  // Listen to external tree changes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const channel = new BroadcastChannel('soloforge-editor-sync-channel');
      const handleMessage = (event: MessageEvent) => {
        const msg = event.data;
        if (msg && msg.type === 'TREE_UPDATE') {
          // Compare JSON representation to avoid infinite loop
          setTree(prev => {
            if (JSON.stringify(prev) !== JSON.stringify(msg.tree)) {
              return msg.tree;
            }
            return prev;
          });
        } else if (msg && msg.type === 'REQUEST_SYNC') {
          // Send current tree state when other window requests it
          channel.postMessage({
            type: 'TREE_UPDATE',
            tree: tree
          });
        }
      };
      channel.addEventListener('message', handleMessage);
      return () => {
        channel.removeEventListener('message', handleMessage);
        channel.close();
      };
    } catch (e) {
      console.warn(e);
    }
  }, [tree]);

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
    targetPath: 'BlogSystem',
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
  useEffect(() => {
    const handleGlobalClick = () => {
      setContextMenu(prev => prev.visible ? { ...prev, visible: false } : prev);
    };
    window.addEventListener('click', handleGlobalClick);
    return () => {
      window.removeEventListener('click', handleGlobalClick);
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
      const activeFolder = targetType === 'folder' ? targetPath : 'BlogSystem';
      setDialog({
        type: 'new_file',
        targetPath: activeFolder,
        inputValue: 'index.js'
      });
    } else if (action === 'new_folder') {
      const activeFolder = targetType === 'folder' ? targetPath : 'BlogSystem';
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
      if (targetPath === 'BlogSystem') {
        triggerToast("不可删除工作区根节点！");
        return;
      }
      setTree(prev => deleteNodeByPath(prev, targetPath));
      if (selectedFile === targetPath) {
        setSelectedFile('BlogSystem/package.json');
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
      const destFolder = targetType === 'folder' ? targetPath : 'BlogSystem';
      
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
      const pseudoPath = `D:\\AI-Projects\\BlogSystem\\${targetPath.replace(/\//g, '\\')}`;
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

    const isOpen = isSearchActive ? (openFolders[node.path] ?? true) : openFolders[node.path];
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
              className={`flex items-center justify-between py-1 px-2.5 rounded-md cursor-grab active:cursor-grabbing group transition-all duration-300 relative ${
                draggedNodePath === node.path
                  ? 'opacity-20 bg-[#151719]/10 border-dashed border-red-500/10 scale-95'
                  : dragOverNodePath === node.path
                    ? 'bg-[#ffde82]/10 border border-[#ffde82]/40 scale-102 shadow-lg text-[#ffde82]'
                    : isSelected ? 'bg-primary/8 text-primary font-semibold' : 'hover:bg-[#1a1c1e] text-on-surface/80'
              }`}
            >
              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                {isOpen ? (
                  <ChevronDown className="w-3.5 h-3.5 text-on-surface/40 shrink-0" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-on-surface/40 shrink-0" />
                )}
                {isOpen ? (
                  <FolderOpen className="w-4 h-4 text-primary shrink-0 text-[#ffde82]" />
                ) : (
                  <Folder className="w-4 h-4 text-primary/80 shrink-0 text-[#ffde82]" />
                )}
                <span className="text-[12px] truncate">{node.name}</span>
                {dragOverNodePath === node.path && draggedNodePath !== node.path && (
                  <span className="text-[9px] font-bold text-[#ffde82] bg-[#ffde82]/15 border border-[#ffde82]/30 px-1.5 py-0.2 rounded ml-1.5 select-none animate-pulse shrink-0">
                    移动至此
                  </span>
                )}
              </div>

              {/* Hover visual options trigger button */}
              <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 mr-1 transition-opacity z-10">
                <button 
                  onClick={(e) => { e.stopPropagation(); openCustomMenu(e, node.path, 'folder'); }}
                  className="p-1 hover:bg-[#2b2d30] text-on-surface/40 hover:text-white rounded transition-colors"
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
            className={`flex items-center justify-between py-1 px-2.5 rounded-md cursor-grab active:cursor-grabbing group transition-all duration-300 relative ${
              draggedNodePath === node.path
                ? 'opacity-20 bg-[#151719]/10 border-dashed border-red-500/10 scale-95'
                : dragOverNodePath === node.path
                  ? 'bg-[#ffde82]/10 border border-[#ffde82]/40 scale-102 shadow-lg text-[#ffde82]'
                  : isSelected 
                    ? 'bg-[#ffe08b]/15 text-primary font-bold border-l-2 border-primary' 
                    : 'hover:bg-[#191b1d] text-on-surface/70 hover:text-on-surface'
            }`}
          >
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <FileCode className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-primary' : fileColorClass}`} />
              <span className="text-[12px] truncate">{node.name}</span>
              {dragOverNodePath === node.path && draggedNodePath !== node.path && (
                <span className="text-[9px] font-bold text-[#ffde82] bg-[#ffde82]/15 border border-[#ffde82]/30 px-1.5 py-0.2 rounded ml-1.5 select-none animate-pulse shrink-0">
                  同级移动
                </span>
              )}
              <span className="text-[10px] text-on-surface/35 font-mono shrink-0 select-none ml-1.5 px-1 py-0.2 bg-[#17191b] rounded border border-white/5">
                {getFileSize(node.path)}
              </span>
            </div>

            {/* Hover visual template trigger */}
            <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 mr-1 transition-opacity z-10">
              <button 
                onClick={(e) => { e.stopPropagation(); openCustomMenu(e, node.path, 'file'); }}
                className="p-1 hover:bg-[#2b2d30] text-on-surface/40 hover:text-white rounded transition-colors"
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
        <span className="font-display font-bold text-[12px] text-on-surface">资源管理</span>
        <div className="flex items-center gap-1.5">
          <motion.button 
            type="button"
            onClick={handleRefresh}
            className="p-1 hover:bg-surface-bright rounded text-on-surface/50 hover:text-primary transition-colors cursor-pointer flex items-center justify-center animate-none"
            title="刷新工作区"
            animate={{ rotate: isRefreshing ? 360 : 0 }}
            transition={{ duration: 0.5, ease: "easeInOut" }}
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </motion.button>

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
        onContextMenu={(e) => openCustomMenu(e, 'BlogSystem', 'root_blank')}
        className="flex-1 overflow-y-auto p-1.5 space-y-0.5 scrollbar-thin scrollbar-thumb-[#2c2f33] relative min-h-[150px]"
      >
        <motion.div
          key={refreshKey}
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        >
          {renderNode(tree)}
        </motion.div>
      </div>

      {/* Context Menu Overlay Option Cards */}
      <AnimatePresence>
        {contextMenu.visible && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.12 }}
            style={{ 
              position: 'fixed',
              left: `${contextMenu.x}px`,
              top: `${contextMenu.y}px`,
            }}
            className="z-50 w-[190px] bg-[#141517] border border-[#2b2d30] rounded-lg shadow-2xl p-1.5 flex flex-col font-sans select-none"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Folder / Blank only operations */}
            {contextMenu.targetType !== 'file' && (
              <>
                <button
                  onClick={() => handleAction('new_folder')}
                  className="flex items-center gap-2 px-2 py-1.5 hover:bg-[#2563eb] hover:text-white rounded text-[11px] text-on-surface/85 transition-colors text-left cursor-pointer"
                >
                  <FolderPlus className="w-3.5 h-3.5 shrink-0" />
                  <span>新建文件夹</span>
                </button>
                <button
                  onClick={() => handleAction('new_file')}
                  className="flex items-center gap-2 px-2 py-1.5 hover:bg-[#2563eb] hover:text-white rounded text-[11px] text-on-surface/85 transition-colors text-left cursor-pointer"
                >
                  <FilePlus className="w-3.5 h-3.5 shrink-0" />
                  <span>新建文件</span>
                </button>
                <div className="h-[1px] bg-[#222426] my-1" />
              </>
            )}

            <button
              onClick={() => handleAction('reveal')}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-[#2563eb] hover:text-white rounded text-[11px] text-on-surface/85 transition-colors text-left cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5 shrink-0" />
              <span>在资源管理器中显示</span>
            </button>

            <div className="h-[1px] bg-[#222426] my-1" />

            <button
              onClick={() => handleAction('copy')}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-[#2563eb] hover:text-white rounded text-[11px] text-on-surface/85 transition-colors text-left cursor-pointer"
            >
              <Copy className="w-3.5 h-3.5 shrink-0" />
              <span>复制 (Copy)</span>
            </button>
            <button
              onClick={() => handleAction('cut')}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-[#2563eb] hover:text-white rounded text-[11px] text-on-surface/85 transition-colors text-left cursor-pointer"
            >
              <Scissors className="w-3.5 h-3.5 shrink-0" />
              <span>剪切 (Cut)</span>
            </button>
            <button
              disabled={!clipboard}
              onClick={() => handleAction('paste')}
              className={`flex items-center gap-2 px-2 py-1.5 rounded text-[11px] transition-colors text-left ${
                clipboard 
                  ? 'hover:bg-[#2563eb] hover:text-white text-on-surface/85 cursor-pointer' 
                  : 'text-on-surface/30 cursor-not-allowed'
              }`}
            >
              <Clipboard className="w-3.5 h-3.5 shrink-0" />
              <span>粘贴 (Paste)</span>
            </button>

            <div className="h-[1px] bg-[#222426] my-1" />

            <button
              onClick={() => handleAction('rename')}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-[#2563eb] hover:text-white rounded text-[11px] text-on-surface/85 transition-colors text-left cursor-pointer"
            >
              <Edit3 className="w-3.5 h-3.5 shrink-0" />
              <span>重命名 (Rename)</span>
            </button>
            <button
              onClick={() => handleAction('delete')}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-red-600 hover:text-white rounded text-[11px] text-red-500 transition-colors text-left cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5 shrink-0" />
              <span>删除 (Delete)</span>
            </button>

            <div className="h-[1px] bg-[#222426] my-1" />

            <button
              onClick={() => handleAction('copy_path')}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-[#2563eb] hover:text-white rounded text-[11px] text-on-surface/85 transition-colors text-left cursor-pointer"
            >
              <Link2 className="w-3.5 h-3.5 shrink-0" />
              <span>复制绝对路径</span>
            </button>
            <button
              onClick={() => handleAction('add_to_chat')}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-primary/90 hover:text-black rounded text-[11px] text-primary/85 font-medium transition-colors text-left cursor-pointer"
            >
              <MessageSquarePlus className="w-3.5 h-3.5 shrink-0 text-primary" />
              <span>添加到对话</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Interactive Beautiful Prompt Modal Dialogs */}
      <AnimatePresence>
        {dialog.type && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="w-full max-w-sm bg-[#111214] border border-[#2c2f33] rounded-xl shadow-2xl p-4 font-sans text-white"
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
                  <div className="bg-black/40 border border-[#222426] p-2.5 rounded text-[10px] text-amber-300 font-mono break-all mb-4">
                    {`D:\\AI-Projects\\BlogSystem\\${dialog.targetPath.replace(/\//g, '\\')}`}
                  </div>
                  <div className="flex justify-end">
                    <button
                      onClick={() => setDialog({ type: null, targetPath: '', inputValue: '' })}
                      className="bg-primary hover:bg-[#ffd561] text-black text-[11px] font-bold px-4 py-1.5 rounded active:scale-95 transition-transform cursor-pointer"
                    >
                      我明白了
                    </button>
                  </div>
                </div>
              ) : (
                // Input Prompt form
                <div>
                  <h3 className="text-xs font-bold text-white mb-2 tracking-wide">
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
                    className="w-full bg-[#1e2022] border border-[#2c2f33] rounded px-2.5 py-1.5 text-xs text-white outline-none focus:border-primary/50 mb-4"
                    autoFocus
                    placeholder={dialog.type === 'new_file' ? '例如 main.py, index.html' : '目录名称'}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') confirmDialog();
                    }}
                  />

                  <div className="flex items-center justify-end gap-2 text-xs font-semibold">
                    <button
                      onClick={() => setDialog({ type: null, targetPath: '', inputValue: '' })}
                      className="px-3 py-1.5 text-on-surface/40 hover:text-white transition-colors cursor-pointer text-[11px]"
                    >
                      取消
                    </button>
                    <button
                      onClick={confirmDialog}
                      className="bg-blue-600 hover:bg-blue-500 text-white rounded px-4 py-1.5 active:scale-95 transition-all cursor-pointer text-[11px]"
                    >
                      确认
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Floating system Feedback Toasts */}
      <AnimatePresence>
        {toast.show && (
          <motion.div
            initial={{ opacity: 0, y: 15, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 15, x: '-50%' }}
            className="absolute bottom-4 left-1/2 bg-[#1b5e20] text-white text-[10px] md:text-[11px] px-3.5 py-1.5 rounded-full shadow-2xl border border-emerald-500/20 font-medium flex items-center gap-1.5 z-40 pointer-events-none whitespace-nowrap"
          >
            <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>{toast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
