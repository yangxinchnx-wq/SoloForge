/**
 * Canvas 3D 设备相关的 TypeScript 类型定义(前端版)
 *
 * 严格遵守 AGENTS.md: 禁止 any, 必须完整接口
 *
 * 仅包含前端组件渲染所需的类型。
 * 服务端配置项 (SessionStoreConfig / DEFAULT_SESSION_CONFIG) 在 server 模块里,
 * 详见 `src/server/services/canvas/types.ts`。
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
  xRatio: number;        // 0~1, 画布宽度比例
  yRatio: number;        // 0~1, 画布高度比例
  rotationX: number;     // 弧度
  rotationY: number;
  rotationZ: number;
  displayScale: number;  // 显示缩放 (1.0 = 原生)
  isSelected: boolean;
  highlightColor: string; // HEX 颜色
  /**
   * s2.x 扩展: 设备独立 UI session
   *   - undefined/null: 用 SessionState.sessionId (所有设备共享 UI)
   *   - 有值: 单独走 /api/canvas/ui?deviceId=... 路径
   * 用途: 不同设备显示不同 UI 状态 (iOS 看 iOS UI, iPadOS 看 iPadOS UI)
   * 当前未启用 — 仅数据层就位, API 路由仍用 sessionId
   */
  uiSessionId?: string | null;
}

export interface SessionState {
  sessionId: string;
  selectedDeviceKey: string;
  devices: DeviceInstance[];
  bgColor: string;
  selectedDeviceId: string | null;
  lastUpdated: number;
}