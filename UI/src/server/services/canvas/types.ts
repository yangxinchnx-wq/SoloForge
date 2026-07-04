/**
 * Canvas 3D 设备相关的 TypeScript 类型定义(服务端完整版)
 *
 * 服务端模块使用,包含后端配置项 (SessionStoreConfig)。
 * 前端组件只用前端版 `src/services/canvas/types.ts`(已剥离配置)。
 */

export interface ScreenUVPoint {
  x: number;
  y: number;
}

export interface ScreenUV {
  bl: ScreenUVPoint;
  br: ScreenUVPoint;
  tr: ScreenUVPoint;
  tl: ScreenUVPoint;
}

export interface DeviceNativeSize {
  w: number;
  h: number;
}

export interface DeviceModelConfig {
  key: string;
  label: string;
  group: 'desktop' | 'mobile' | 'tablet' | 'watch';
  type: '2d' | '3d';
  file: string;
  screenUV: ScreenUV;
  nativeSize: DeviceNativeSize;
  official?: string;
  community?: string;
  note?: string;
}

export interface DeviceInstance {
  id: string;
  modelKey: string;
  xRatio: number;
  yRatio: number;
  rotationX: number;
  rotationY: number;
  rotationZ: number;
  displayScale: number;
  isSelected: boolean;
  highlightColor: string;
  /**
   * s3.2c: 设备独立 UI session
   *   - null/undefined: 共享 UI (所有设备同屏)
   *   - 有值: 该设备走独立 UI session
   */
  uiSessionId?: string | null;
}

export interface SessionState {
  sessionId: string;
  /**
   * 画布名称 (零填充 2 位序号, UI 不显示前导零)
   * 例: "01", "02", ..., "10"
   * 全 chat 全局最小可用 (删除后序号可复用)
   * 由系统分配, 用户不能通过 PATCH 改名 (改名为禁用)
   */
  name: string;
  /** 用户备注 (可选) */
  description?: string;
  /** 会话创建时间 (ms) */
  createdAt?: number;
  selectedDeviceKey: string;
  devices: DeviceInstance[];
  bgColor: string;
  selectedDeviceId: string | null;
  /**
   * s2.2: 多选设备 ID 集合
   *
   * 语义: 包含 selectedDeviceId + Shift 加选 + 框选的所有设备
   * selectedDeviceId 是"主选"(即最后点中的那个), 用于键盘单键操作
   * selectedDeviceIds 是"群组选"(用于群组变换/批量删除)
   * 单一选择时, selectedDeviceIds 长度为 1, 内容等于 selectedDeviceId
   */
  selectedDeviceIds: string[];
  lastUpdated: number;
  /**
   * P0: 归属字段 - 创建该画布的 chat session ID
   * 决定写权限 (改设备/改名/删除) 仅 owner 可做
   * 例: "chat-abc123"
   */
  ownerChatSessionId: string;
  /**
   * P0: 可见性
   * 当前固定 'public' (所有 chat 默认可见, 仅写权限受 owner 限制)
   */
  visibility: 'public';
  /**
   * P0: 各 chat 最后访问时间戳 (ms), 用于自动切回
   * key: chatSessionId, value: timestamp
   */
  lastAccessedBy?: Record<string, number>;
}

/**
 * Canvas 全局配额
 */
export const CANVAS_LIMITS = {
  /** 每个 chat 最多创建画布数 (全局共享, 1..N 序号) */
  MAX_CANVASES: 10,
  /** 序号零填充位数 (UI 显示时去掉前导零) */
  NAME_PAD: 2,
} as const;

/**
 * 把数字转成零填充的名称字符串
 * 例: 1 -> "01", 10 -> "10"
 */
export function formatCanvasName(sequence: number): string {
  return String(sequence).padStart(CANVAS_LIMITS.NAME_PAD, '0');
}

/**
 * 把零填充名称转回数字 (用于排序/比较)
 * 例: "01" -> 1, "10" -> 10
 * 非法字符串返回 -1
 */
export function parseCanvasName(name: string | undefined | null): number {
  if (!name || !/^\d+$/.test(name)) return -1;
  return parseInt(name, 10);
}

/**
 * UI 显示用: 去掉前导零
 * 例: "01" -> "1", "10" -> "10"
 */
export function displayCanvasName(name: string | undefined | null): string {
  const n = parseCanvasName(name);
  return n > 0 ? String(n) : (name ?? '');
}

/**
 * 服务端会话存储配置(包含 Garnet 连接信息)
 * 仅 server 模块使用,不能进入前端 bundle
 */
export interface SessionStoreConfig {
  ttlSeconds: number;
  flushIntervalMs: number;
  garnetHost: string;
  garnetPort: number;
  surrealUrl: string;
  surrealNamespace: string;
  surrealDatabase: string;
}

export const DEFAULT_SESSION_CONFIG: SessionStoreConfig = {
  ttlSeconds: 86400,        // 24h
  flushIntervalMs: 30000,   // 30s
  garnetHost: '127.0.0.1',
  garnetPort: 6379,
  surrealUrl: 'rocksdb://data/soloforge_db',
  surrealNamespace: 'soloforge_core',
  surrealDatabase: 'canvas_state',
};