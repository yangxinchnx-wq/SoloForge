// ─────────────────────────────────────────────────────────────────
// SoloForge Electron Preload Script
// 安全地暴露 API 给渲染进程
// ─────────────────────────────────────────────────────────────────

import { contextBridge, ipcRenderer } from 'electron';

// 暴露给渲染进程的 API
const electronAPI = {
  // 平台信息
  platform: process.platform,

  // 内核状态
  kernel: {
    getStatus: () => ipcRenderer.invoke('kernel:status'),
    getComponents: () => ipcRenderer.invoke('kernel:components'),
    getHealth: () => ipcRenderer.invoke('kernel:health'),
    getEvents: (limit?: number) => ipcRenderer.invoke('kernel:events', limit),
    getOwnership: (domain: string) => ipcRenderer.invoke('kernel:ownership', domain)
  },

  // 数据库操作
  database: {
    query: (sql: string, params?: unknown[]) => ipcRenderer.invoke('db:query', sql, params),
    getSchema: () => ipcRenderer.invoke('db:schema'),
    getTables: () => ipcRenderer.invoke('db:tables')
  },

  // 调度器
  scheduler: {
    getStats: () => ipcRenderer.invoke('scheduler:stats'),
    getQueue: () => ipcRenderer.invoke('scheduler:queue')
  },

  // 事件订阅
  events: {
    subscribe: (eventName: string) => ipcRenderer.invoke('event:subscribe', eventName),
    unsubscribe: (eventName: string) => ipcRenderer.invoke('event:unsubscribe', eventName),
    list: () => ipcRenderer.invoke('event:list')
  },

  // 监听内核事件
  onKernelEvent: (callback: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on('kernel:event', handler);
    return () => ipcRenderer.removeListener('kernel:event', handler);
  },

  // 监听菜单事件
  onMenuEvent: (callback: (event: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: string) => callback(data);
    ipcRenderer.on('menu:new-task', () => callback('new-task'));
    return () => {
      ipcRenderer.removeListener('menu:new-task', handler);
    };
  }
};

// 使用 contextBridge 安全地暴露 API
contextBridge.exposeInMainWorld('soloforge', electronAPI);

// 声明全局类型
declare global {
  interface Window {
    soloforge: typeof electronAPI;
  }
}

console.log('[Preload] SoloForge API 已暴露');
