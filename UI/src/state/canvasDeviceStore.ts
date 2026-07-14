/**
 * canvasDeviceStore — 画布设备尺寸 + 渲染模式 (按画布独立存储 + localStorage 持久化)
 *
 * 设计:
 *   - 每个画布独立存储设备选择 (canvasId → CanvasDeviceInfo | null)
 *   - 默认无设备约束 (null = 不显示设备边框)
 *   - localStorage 持久化 (断电保留)
 *   - PreviewPanel 写入, useChatStore / aiBackend 读取
 *
 * ★ 2026-07-14: 新增 frameSizes — 画布实际渲染帧尺寸 (运行时, 不持久化)
 *   - PreviewPanel 每次 computeFrame 后写入
 *   - aiBackend 读取并注入到 LLM prompt, 让 LLM 知道画布有多大
 *   - incrementalCanvasPusher 读取用于 canvas.start 的正确参数
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

/** 画布实际渲染帧尺寸 (运行时计算, 不持久化) */
export interface CanvasFrameSize {
  width: number;
  height: number;
}

interface CanvasDeviceStoreState {
  /** canvasId → 设备信息 (null = 无设备约束) */
  devices: Record<string, CanvasDeviceInfo | null>;
  /** 全局渲染模式 (2D/3D) */
  renderMode: '2D' | '3D';
  /** canvasId → 实际渲染帧尺寸 (运行时, 不持久化) */
  frameSizes: Record<string, CanvasFrameSize>;

  // ── Actions ──
  /** 设置画布设备 (canvasId, null 表示清除设备约束) */
  setDevice: (canvasId: string, info: CanvasDeviceInfo | null) => void;
  /** 获取画布设备 (返回 null 表示无约束) */
  getDevice: (canvasId: string) => CanvasDeviceInfo | null;
  /** 设置全局渲染模式 */
  setRenderMode: (mode: '2D' | '3D') => void;
  /** 删除画布设备记录 */
  removeDevice: (canvasId: string) => void;
  /** 设置画布实际帧尺寸 (PreviewPanel 调用) */
  setFrameSize: (canvasId: string, size: CanvasFrameSize) => void;
  /** 获取画布实际帧尺寸 */
  getFrameSize: (canvasId: string) => CanvasFrameSize | null;
}

export const useCanvasDeviceStore = create<CanvasDeviceStoreState>()(
  persist(
    (set, get) => ({
      devices: {},
      renderMode: '2D',
      frameSizes: {},

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

      setFrameSize: (canvasId, size) =>
        set((s) => ({
          frameSizes: { ...s.frameSizes, [canvasId]: size },
        })),

      getFrameSize: (canvasId) => {
        const { frameSizes } = get();
        return frameSizes[canvasId] ?? null;
      },
    }),
    {
      name: 'solo-forge-canvas-devices',
      version: 2,
      // ★ frameSizes 不持久化 (运行时窗口尺寸, 重启后需重新计算)
      partialize: (state) => ({
        devices: state.devices,
        renderMode: state.renderMode,
      }),
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
    const device = state.getDevice(canvasId);
    if (device) return device;

    // ★ FIX 2026-07-14: 精确 key 找不到时, 尝试 fallback key
    //   场景: device 存储在 "canvas-{chatId}" 下, 但 LLM 查询用的是 "canvas_N"
    //   ensureCanvasForChat 创建真实 canvasId 后, device 可能还没迁移到新 key
    if (canvasId.startsWith('canvas_')) {
      for (const [key, dev] of Object.entries(state.devices)) {
        if (key.startsWith('canvas-') && dev) return dev;
      }
    }
    return null;
  }
  // 返回第一个有设备约束的画布
  const entries = Object.entries(state.devices);
  for (const [_, device] of entries) {
    if (device) return device;
  }
  return null;
}

/**
 * ★ 2026-07-14: 获取画布实际渲染尺寸 (供 LLM prompt 注入 + canvas.start 参数)
 *
 * 优先级:
 *   1. 有设备约束 → 返回设备原生尺寸
 *   2. 有 frameSizes 记录 → 返回 PreviewPanel 计算的实际帧尺寸
 *   3. 都没有 → 返回默认值 { width: 430, height: 932 } (iPhone 15 Pro Max)
 *
 * @param canvasId 画布 sessionId (如 canvas_1)
 */
export function getCanvasSize(canvasId?: string): CanvasFrameSize {
  const state = useCanvasDeviceStore.getState();

  // 1. 设备约束优先
  if (canvasId) {
    const device = state.getDevice(canvasId);
    if (device && device.width > 0 && device.height > 0) {
      return { width: device.width, height: device.height };
    }
    // 2. frameSizes 精确匹配
    const frame = state.getFrameSize(canvasId);
    if (frame && frame.width > 0 && frame.height > 0) {
      return frame;
    }

    // ★ FIX 2026-07-14: 精确 key 找不到时, 尝试 fallback key
    //   场景: ensureCanvasForChat 刚把映射从 "canvas-{chatId}" 改成 "canvas_N",
    //   但 PreviewPanel 的 useEffect 还没来得及更新 frameSizes 下的 key
    if (canvasId.startsWith('canvas_')) {
      // 真实 ID (canvas_1) → 尝试所有 fallback key (canvas-{chatId})
      for (const [key, val] of Object.entries(state.frameSizes)) {
        if (key.startsWith('canvas-') && val.width > 0 && val.height > 0) {
          return val;
        }
      }
    }
  } else {
    // 无 canvasId: 尝试从 frameSizes 取第一个
    const frames = Object.values(state.frameSizes);
    if (frames.length > 0 && frames[0].width > 0) {
      return frames[0];
    }
  }

  // ★ FIX 2026-07-14: 最后兜底 — 尝试任意已有的帧尺寸
  //   场景: canvasId 是真实 ID, 但 frameSizes 只有 fallback key 的数据
  const allFrames = Object.values(state.frameSizes);
  if (allFrames.length > 0 && allFrames[0].width > 0) {
    return allFrames[0];
  }

  // 3. 默认值 — 与 PreviewPanel DEFAULT_CANVAS_PRESET 一致 (430×932)
  return { width: 430, height: 932 };
}
