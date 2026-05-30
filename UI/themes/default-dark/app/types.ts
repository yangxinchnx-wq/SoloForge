// ─────────────────────────────────────────────────────────────────
// SoloForge Electron API Types
// 前端类型声明
// ─────────────────────────────────────────────────────────────────

export interface KernelStatus {
  state: string;
  mode: string;
  version: number;
  startedAt: number;
}

export interface HealthStatus {
  healthy: boolean;
  state?: string;
  error?: string;
}

export interface KernelEvent {
  event: string;
  payload: any;
  timestamp: number;
}

export interface DbQueryResult {
  success: boolean;
  data?: any;
  error?: string;
}

export interface SchedulerStats {
  mode: string;
  queueSize?: number;
  stats?: any;
  error?: string;
}

export interface SchemaInfo {
  tables: string[];
  namespaces: string[];
  databases: string[];
}

// Electron API 接口
export interface ElectronAPI {
  kernel: {
    getStatus: () => Promise<KernelStatus>;
    getComponents: () => Promise<string[]>;
    getHealth: () => Promise<HealthStatus>;
    getEvents: (limit?: number) => Promise<KernelEvent[]>;
    getOwnership: (domain: string) => Promise<{ domain: string; patterns: string[] }>;
  };

  events: {
    subscribe: (eventName: string) => Promise<{ subscribed: string; success: boolean }>;
    unsubscribe: (eventName: string) => Promise<{ unsubscribed: string; success: boolean }>;
    list: () => Promise<string[]>;
    onEvent: (callback: (event: KernelEvent) => void) => () => void;
  };

  db: {
    query: (sql: string, params?: Record<string, any>) => Promise<DbQueryResult>;
    getSchema: () => Promise<SchemaInfo>;
    getTables: () => Promise<string[]>;
  };

  scheduler: {
    getStats: () => Promise<SchedulerStats>;
    getQueue: () => Promise<any[]>;
  };

  menu: {
    onNewTask: (callback: () => void) => () => void;
  };
}

// 全局类型声明
declare global {
  interface Window {
    soloforge: ElectronAPI;
  }
}
