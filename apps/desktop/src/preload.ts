// ─────────────────────────────────────────────────────────────────
// SoloForge Electron Preload Script
// 通过 contextBridge 安全暴露 API 给渲染进程
// ─────────────────────────────────────────────────────────────────

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

interface KernelEvent {
  event: string;
  payload: any;
  timestamp: number;
}

interface KernelStatus {
  state: string;
  mode: string;
  version: number;
  startedAt: number;
}

interface HealthStatus {
  healthy: boolean;
  state?: string;
  error?: string;
}

// 订阅回调类型
type EventCallback = (event: KernelEvent) => void;

/**
 * 安全暴露给渲染进程的 API
 */
const electronAPI = {
  // ========== 内核查询 ==========
  kernel: {
    getStatus: (): Promise<KernelStatus> => ipcRenderer.invoke('kernel:status'),
    getComponents: (): Promise<string[]> => ipcRenderer.invoke('kernel:components'),
    getHealth: (): Promise<HealthStatus> => ipcRenderer.invoke('kernel:health'),
    getEvents: (limit?: number): Promise<any[]> => ipcRenderer.invoke('kernel:events', limit),
    getOwnership: (domain: string): Promise<{ domain: string; patterns: string[] }> =>
      ipcRenderer.invoke('kernel:ownership', domain)
  },

  // ========== 事件订阅 ==========
  events: {
    subscribe: (eventName: string): Promise<{ subscribed: string; success: boolean }> =>
      ipcRenderer.invoke('event:subscribe', eventName),

    unsubscribe: (eventName: string): Promise<{ unsubscribed: string; success: boolean }> =>
      ipcRenderer.invoke('event:unsubscribe', eventName),

    list: (): Promise<string[]> => ipcRenderer.invoke('event:list'),

    onEvent: (callback: EventCallback): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: KernelEvent) => callback(data);
      ipcRenderer.on('kernel:event', handler);
      // 返回取消订阅函数
      return () => ipcRenderer.removeListener('kernel:event', handler);
    }
  },

  // ========== 数据库操作 ==========
  db: {
    query: (sql: string, params?: Record<string, any>): Promise<any> =>
      ipcRenderer.invoke('db:query', sql, params),

    getSchema: (): Promise<any> => ipcRenderer.invoke('db:schema'),

    getTables: (): Promise<string[]> => ipcRenderer.invoke('db:tables')
  },

  // ========== 调度器 ==========
  scheduler: {
    getStats: (): Promise<any> => ipcRenderer.invoke('scheduler:stats'),
    getQueue: (): Promise<any[]> => ipcRenderer.invoke('scheduler:queue')
  },

  // ========== 菜单事件 ==========
  menu: {
    onNewTask: (callback: () => void): (() => void) => {
      const handler = () => callback();
      ipcRenderer.on('menu:new-task', handler);
      return () => ipcRenderer.removeListener('menu:new-task', handler);
    }
  }
};

// 暴露给渲染进程
contextBridge.exposeInMainWorld('soloforge', electronAPI);

// 类型声明供渲染进程使用
export type ElectronAPI = typeof electronAPI;
