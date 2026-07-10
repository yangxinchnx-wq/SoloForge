/**
 * useWorkspaceStore — 文件树工作区全局状态
 *
 * 2026-07-10 从 FileExplorer.tsx 的 useState 提升到 Zustand store。
 *
 * 原因:
 *   FileExplorer 只在 activeTab === 'explorer' 时渲染。
 *   切换到 git/search 等选项卡时组件卸载, workspaces state 丢失。
 *   重新挂载时虽从 localStorage 恢复, 但 tempId→realId 迁移 effect 不触发。
 *
 * 提升到全局 store 后:
 *   - 组件卸载/重新挂载不影响 workspaces 数据
 *   - chatsStore.createChat 可直接调用 migrateWorkspace 完成 tempId→realId 迁移
 *   - BroadcastChannel 接收方可直接调 store setter, 不依赖组件闭包
 */

import { create } from 'zustand';
import type { FileNode } from '../shared/types/file';

export interface WorkspaceData {
  name: string;
  tree: FileNode;
  openFolders: Record<string, boolean>;
}

interface WorkspaceState {
  workspaces: Record<string, WorkspaceData>;
  setWorkspaces: (
    v: Record<string, WorkspaceData> | ((prev: Record<string, WorkspaceData>) => Record<string, WorkspaceData>),
  ) => void;
  setWorkspaceTree: (chatId: string, tree: FileNode | ((prev: FileNode) => FileNode)) => void;
  setOpenFolders: (
    chatId: string,
    openFolders: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>),
  ) => void;
  removeWorkspace: (chatId: string) => void;
  migrateWorkspace: (fromId: string, toId: string) => void;
  /**
   * 确保指定 chatId 的工作区数据存在。
   * 1. 已有数据 → 直接返回
   * 2. 按 workspaceFolder 名称在其他 chatId 下查找 → 复制过来
   * 3. 从服务端 /api/files/list 恢复
   */
  ensureWorkspace: (chatId: string, workspaceFolder: string) => void;
}

// ── 从 localStorage 加载 (lazy init) ──────────────────
function loadWorkspaces(): Record<string, WorkspaceData> {
  if (typeof window === 'undefined') return {};
  try {
    const saved = localStorage.getItem('soloforge_workspaces');
    if (saved) {
      const parsed = JSON.parse(saved);
      // 迁移: 清除旧 BlogSystem 数据
      for (const key of Object.keys(parsed)) {
        if (parsed[key]?.tree?.name === 'BlogSystem') {
          parsed[key].tree = {
            name: parsed[key].name || '工作区',
            type: 'folder',
            path: parsed[key].name || '工作区',
            children: [],
          };
        }
      }
      return parsed;
    }
  } catch {}
  return {};
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  workspaces: loadWorkspaces(),

  setWorkspaces: (v) =>
    set((state) => ({
      workspaces: typeof v === 'function' ? v(state.workspaces) : v,
    })),

  setWorkspaceTree: (chatId, tree) =>
    set((state) => {
      const ws = state.workspaces[chatId];
      if (!ws) return state;
      const next = typeof tree === 'function' ? (tree as (p: FileNode) => FileNode)(ws.tree) : tree;
      return { workspaces: { ...state.workspaces, [chatId]: { ...ws, tree: next } } };
    }),

  setOpenFolders: (chatId, openFolders) =>
    set((state) => {
      const ws = state.workspaces[chatId];
      if (!ws) return state;
      const next =
        typeof openFolders === 'function'
          ? (openFolders as (p: Record<string, boolean>) => Record<string, boolean>)(ws.openFolders)
          : openFolders;
      return { workspaces: { ...state.workspaces, [chatId]: { ...ws, openFolders: next } } };
    }),

  removeWorkspace: (chatId) =>
    set((state) => {
      if (!state.workspaces[chatId]) return state;
      const next = { ...state.workspaces };
      delete next[chatId];
      return { workspaces: next };
    }),

  migrateWorkspace: (fromId, toId) =>
    set((state) => {
      // 目标已有数据 or 源不存在 → 不迁移
      if (state.workspaces[toId] || !state.workspaces[fromId]) return state;
      const next = { ...state.workspaces };
      next[toId] = next[fromId];
      delete next[fromId];
      return { workspaces: next };
    }),

  ensureWorkspace: (chatId, workspaceFolder) => {
    const state = useWorkspaceStore.getState();
    const sf = typeof window !== 'undefined' ? (window as any).soloforge : null;
    const diag = {
      chatId, workspaceFolder,
      hasData: !!state.workspaces[chatId],
      hasValidTree: !!(state.workspaces[chatId]?.tree?.children?.length && state.workspaces[chatId].tree.children.length > 0),
      childCount: state.workspaces[chatId]?.tree?.children?.length ?? 0,
      allKeys: Object.keys(state.workspaces),
      hasSoloforge: !!sf,
      soloforgeKeys: sf ? Object.keys(sf) : [],
      hasReadDirTree: !!sf?.readDirTree,
    };
    console.log('[ensureWorkspace]', diag);
    // 诊断: 发到服务端 console
    try { fetch('/api/debug-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'ensureWorkspace', ...diag }) }); } catch {}
    const folderName = workspaceFolder.split(/[\\/]/).pop() || workspaceFolder;

    // 辅助: 判断工作区数据是否 "有效" (树有子节点)
    const hasValidTree = (ws?: WorkspaceData) =>
      !!ws && !!ws.tree && Array.isArray(ws.tree.children) && ws.tree.children.length > 0;

    // 1. 已有有效数据 → 不处理
    //    注意: 如果已有数据但树为空 (可能来自 localStorage 旧数据), 需要重新加载
    if (hasValidTree(state.workspaces[chatId])) return;

    // 2. 按 workspaceFolder 名称在其他 chatId 下查找孤立数据
    //    常见场景: 数据存在 "1" / "default" / "temp-xxx" 等旧 key 下
    //    仅当源数据也有有效树时才复制, 避免复制空树
    const entries = Object.entries(state.workspaces);
    const match = entries.find(
      ([, ws]) =>
        (ws?.name === folderName || ws?.name === workspaceFolder) && hasValidTree(ws),
    );
    if (match) {
      const [, wsData] = match;
      set((s) => ({
        workspaces: { ...s.workspaces, [chatId]: { ...wsData } },
      }));
      return;
    }

    // 3. 尝试通过 Electron IPC 恢复 (workspaceFolder 可能是完整路径或仅文件夹名)
    if (sf?.readDirTree) {
      sf.readDirTree(workspaceFolder)
        .then((result: any) => {
          if (result?.success && result.tree) {
            // 如果 IPC 返回了 resolvedPath (搜索到的完整路径), 更新 chat 元数据
            if (result.resolvedPath) {
              import('../state/chatsStore').then(({ useChatsStore }) => {
                useChatsStore.getState().updateChat(chatId, { workspaceFolder: result.resolvedPath });
              });
            }
            set((s) => {
              // 仅当目标不存在 OR 已有数据但树为空时才覆盖
              if (hasValidTree(s.workspaces[chatId])) return s;
              const childCount = result.tree?.children?.length ?? 0;
              console.log(`[ensureWorkspace] IPC 成功, 写入树: ${folderName}, children=${childCount}`);
              try { fetch('/api/debug-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'ensureWorkspace IPC success', chatId, folderName, childCount }) }); } catch {}
              return {
                workspaces: {
                  ...s.workspaces,
                  [chatId]: {
                    name: folderName,
                    tree: result.tree as FileNode,
                    openFolders: { [folderName]: true },
                  },
                },
              };
            });
            return;
          }
          // IPC 失败 → 尝试服务端
          tryServerRestore();
        })
        .catch(() => {
          tryServerRestore();
        });
      return;
    }

    // 4. 从服务端恢复 (文件夹在项目根目录下时有效)
    function tryServerRestore() {
      fetch(`/api/files/list?dir=${encodeURIComponent(folderName)}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.success && Array.isArray(data.files) && data.files.length > 0) {
            const prefixPaths = (node: FileNode): FileNode => ({
              ...node,
              path: `${folderName}/${node.path}`,
              children: node.children?.map(prefixPaths),
            });
            const restoredTree: FileNode = {
              name: folderName,
              type: 'folder',
              path: folderName,
              children: data.files.map(prefixPaths),
            };
            set((s) => {
              // 再次检查, 避免竞态; 同时检查树是否有效
              if (hasValidTree(s.workspaces[chatId])) return s;
              return {
                workspaces: {
                  ...s.workspaces,
                  [chatId]: {
                    name: folderName,
                    tree: restoredTree,
                    openFolders: { [folderName]: true },
                  },
                },
              };
            });
          }
        })
        .catch(() => {}); // 静默失败
    }

    // 如果 Electron IPC 不可用, 直接走服务端
    if (!sf?.readDirTree) {
      tryServerRestore();
    }
  },
}));

// ── 持久化到 localStorage (订阅 store 变化) ──────────
if (typeof window !== 'undefined') {
  useWorkspaceStore.subscribe((state) => {
    try {
      localStorage.setItem('soloforge_workspaces', JSON.stringify(state.workspaces));
    } catch {}
  });
}
