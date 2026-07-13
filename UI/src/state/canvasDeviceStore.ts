/**
 * canvasDeviceStore — 画布设备尺寸 + 渲染模式 (按画布独立存储 + localStorage 持久化)
 *
 * 设计:
 *   - 每个画布独立存储设备选择 (canvasId → CanvasDeviceInfo | null)
 *   - 默认无设备约束 (null = 不显示设备边框)
 *   - localStorage 持久化 (断电保留)
 *   - PreviewPanel 写入, useChatStore / aiBackend 读取
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface CanvasDeviceInfo {
  /** 设备 key (如 'd2-iphone16', 'm-iphone14pro') */
  sizeKey: string;
  /** 设备显示名 (如 'iPhone 16', 'iPhone 14 Pro') */
  label: string;
  /** 设备原生宽度 (px) */
  width: number;
  /** 设备原生高度 (px) */
  height: number;
  /** 设备分组 */
  group: 'desktop' | 'mobile' | 'tablet' | 'watch';
  /** 渲染模式 */
  renderMode: '2D' | '3D';
  /** PNG 边框图路径 (2D 模式) */
  pngFile?: string;
  /** GLB 模型路径 (3D 模式) */
  glbFile?: string;
}

interface CanvasDeviceStoreState {
  /** canvasId → 设备信息 (null = 无设备约束) */
  devices: Record<string, CanvasDeviceInfo | null>;
  /** 全局渲染模式 (2D/3D) */
  renderMode: '2D' | '3D';

  // ── Actions ──
  /** 设置画布设备 (canvasId, null 表示清除设备约束) */
  setDevice: (canvasId: string, info: CanvasDeviceInfo | null) => void;
  /** 获取画布设备 (返回 null 表示无约束) */
  getDevice: (canvasId: string) => CanvasDeviceInfo | null;
  /** 设置全局渲染模式 */
  setRenderMode: (mode: '2D' | '3D') => void;
  /** 删除画布设备记录 */
  removeDevice: (canvasId: string) => void;
}

export const useCanvasDeviceStore = create<CanvasDeviceStoreState>()(
  persist(
    (set, get) => ({
      devices: {},
      renderMode: '2D',

      setDevice: (canvasId, info) =>
        set((s) => ({
          devices: { ...s.devices, [canvasId]: info },
        })),

      getDevice: (canvasId) => {
        const { devices } = get();
        return devices[canvasId] ?? null;
      },

      setRenderMode: (mode) =>
        set({ renderMode: mode }),

      removeDevice: (canvasId) =>
        set((s) => {
          const { [canvasId]: _, ...rest } = s.devices;
          return { devices: rest };
        }),
    }),
    {
      name: 'solo-forge-canvas-devices',
      version: 1,
    }
  )
);

/**
 * 获取指定画布的设备约束 (供 LLM prompt 注入)
 * 如果不传 canvasId，返回第一个有设备约束的画布
 * 返回 null 表示无约束
 */
export function getDeviceConstraint(canvasId?: string): CanvasDeviceInfo | null {
  const state = useCanvasDeviceStore.getState();
  if (canvasId) {
    return state.getDevice(canvasId);
  }
  // 返回第一个有设备约束的画布
  const entries = Object.entries(state.devices);
  for (const [_, device] of entries) {
    if (device) return device;
  }
  return null;
}
