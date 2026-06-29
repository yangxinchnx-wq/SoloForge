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
  /** s1.4: 用户自定义会话名 (可选, 默认从 selectedChatId 或 sessionId 推导) */
  name?: string;
  /** s1.4: 用户备注 (可选) */
  description?: string;
  /** s1.4: 会话创建时间 (ms) */
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