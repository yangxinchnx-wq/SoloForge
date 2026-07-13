/**
 * canvasDeviceStore — 画布设备尺寸 + 渲染模式共享状态
 *
 * 设计:
 *   - PreviewPanel 写入 (用户选择设备/切换 2D-3D)
 *   - useChatStore / aiBackend 读取 (注入 LLM prompt)
 *   - 轻量 zustand store, 无持久化 (刷新后回到默认 fill/2D)
 */

import { create } from 'zustand';

export interface CanvasDeviceInfo {
  /** 设备 key (与 SIZE_PRESETS 对应, 如 'fill', 'm-iphone14pro') */
  sizeKey: string;
  /** 设备显示名 (如 'iPhone 14 Pro', '填满当前宽度') */
  label: string;
  /** 屏幕宽度 (px, 0=填满) */
  width: number;
  /** 屏幕高度 (px, 0=填满) */
  height: number;
  /** 设备分组 */
  group: 'desktop' | 'mobile' | 'tablet' | 'watch';
  /** 渲染模式 */
  renderMode: '2D' | '3D';
}

const DEFAULT_DEVICE: CanvasDeviceInfo = {
  sizeKey: 'fill',
  label: '填满当前宽度',
  width: 0,
  height: 0,
  group: 'desktop',
  renderMode: '2D',
};

interface CanvasDeviceStoreState {
  device: CanvasDeviceInfo;
  /** PreviewPanel 调用: 更新当前设备 */
  setDevice: (info: Partial<CanvasDeviceInfo>) => void;
  /** 设置渲染模式 */
  setRenderMode: (mode: '2D' | '3D') => void;
}

export const useCanvasDeviceStore = create<CanvasDeviceStoreState>((set) => ({
  device: { ...DEFAULT_DEVICE },
  setDevice: (info) =>
    set((s) => ({ device: { ...s.device, ...info } })),
  setRenderMode: (mode) =>
    set((s) => ({ device: { ...s.device, renderMode: mode } })),
}));

/**
 * 获取当前设备约束描述 (供 LLM prompt 注入)
 * 返回 null 表示无约束 (fill 模式)
 */
export function getDeviceConstraint(): CanvasDeviceInfo | null {
  const { device } = useCanvasDeviceStore.getState();
  if (device.width === 0 || device.height === 0) return null;
  return device;
}
