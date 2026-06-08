// ─────────────────────────────────────────────────────────────────
// SoloForge 前端类型定义（与后端 api-server.ts 对齐）
// ─────────────────────────────────────────────────────────────────

export interface KernelStatus {
  state: string;
  mode: string;
  version: number;
  currentTick: number;
  startedAt: number;
  uptime: number;
}

export interface SystemStatus {
  cpu: number;
  memory: number;
  memoryUsed: string;
  memoryTotal: string;
  uptime: number;
  platform: string;
  nodeVersion: string;
  network: { up: number; down: number };
  kernel: { state: string; version: number };
  agents: { active: number; total: number };
  loadAvg?: [number, number, number];
}

export interface DbStats {
  garnet: {
    sessions: number;
    tasks: number;
    counters: number;
    totalKeys?: number;
    connected: boolean;
    healthy: boolean;
  };
  surrealdb: {
    records: number;
    hot: number;
    connected: boolean;
    healthy: boolean;
    tables?: Record<string, number>;
  };
  jsonl: {
    records: number;
    size: string;
    healthy: boolean;
    files?: number;
  };
}

export interface Agent {
  id: string;
  name: string;
  type: string;
  status: string;
  tasks: number;
}

export interface KernelEvent {
  event: string;
  payload: any;
  timestamp: number;
}

export interface HealthStatus {
  healthy: boolean;
  state: string;
}

export interface ObservationData {
  isObserving: boolean;
  lastUpdate: string;
  observations: Array<{
    cycleId: number;
    timestamp: string;
    entropy: number;
    interventions: number;
    courtCases: number;
    coalitions: number;
  }>;
  kernelVersion: number;
  currentTick: number;
  uptime: number;
  stats?: {
    totalEvents: number;
    interventions: number;
    courtCases: number;
    coalitions: number;
  };
}

export interface SchedulerStats {
  mode: string;
  queueSize: number;
  stats: {
    total_push: number;
    total_pop: number;
    total_ping: number;
    aging_boosts: number;
  };
  connected: boolean;
  error: string | null;
}

// ─── 文件资源树（本地） ───
export interface FileNode {
  id: string;
  name: string;
  type: 'file' | 'folder';
  path: string;
  children?: FileNode[];
  language?: string;
  size?: number;
}

// ─── 对话消息 ───
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  model?: string;       // 主/副模型标签
  streaming?: boolean;
  toolCalls?: Array<{
    name: string;
    status: 'pending' | 'success' | 'error';
    result?: any;
  }>;
}

// ─── 流式块（用于流送区显示） ───
export interface StreamChunk {
  id: string;
  type: 'thinking' | 'tool' | 'text' | 'error' | 'system';
  content: string;
  timestamp: number;
  meta?: any;
}

// ─── 实时预览 ───
export type PreviewKind = 'markdown' | 'html' | 'svg' | 'log' | 'metrics' | 'empty';

export interface PreviewTab {
  id: string;
  title: string;
  kind: PreviewKind;
  content?: string;
  pinned?: boolean;
}
