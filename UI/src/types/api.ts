// ─────────────────────────────────────────────────────────────────
// SoloForge 公共 API 类型 (P0-2)
// - 这里集中放跨组件共享的领域类型
// - 组件内部的 `any` 不在此约束,只约束跨边界数据
// - 命名规则: 领域 + 实体
// ─────────────────────────────────────────────────────────────────

// ── 通用 ──
export type ID = string;
export type Timestamp = number;
export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [k: string]: JsonValue };

// ── 文件 ──
export interface FileMeta {
  id: ID;
  name: string;
  path: string;
  type: 'file' | 'folder';
  size?: number;
  mtime?: Timestamp;
  language?: string;
  children?: FileMeta[];
}

// ── 会话 / 消息 ──
export type ChatRole = 'user' | 'assistant' | 'system';
export interface ToolCall {
  name: string;
  status: 'pending' | 'success' | 'error';
  result?: JsonValue;
}
export interface ChatMsg {
  id: ID;
  role: ChatRole;
  content: string;
  timestamp: Timestamp;
  model?: string;
  streaming?: boolean;
  toolCalls?: ToolCall[];
}

// ── 流式事件 ──
export type StreamKind = 'thinking' | 'tool' | 'text' | 'error' | 'system';
export interface StreamChunk {
  id: ID;
  type: StreamKind;
  content: string;
  timestamp: Timestamp;
  meta?: JsonValue;
}

// ── 内核 / 调度 ──
export interface KernelStatus {
  state: string;
  mode: string;
  version: number;
  currentTick: number;
  startedAt: Timestamp;
  uptime: number;
}
export interface SchedulerStats {
  mode: string;
  queueSize: number;
  stats: Record<string, number>;
  connected: boolean;
  error: string | null;
}

// ── 智能体 ──
export type AgentStatus = 'idle' | 'busy' | 'error' | 'offline';
export interface Agent {
  id: ID;
  name: string;
  type: string;
  status: AgentStatus;
  tasks: number;
}

// ── 通用错误 ──
export interface ApiErrorBody {
  code?: string;
  message: string;
  details?: JsonValue;
}
