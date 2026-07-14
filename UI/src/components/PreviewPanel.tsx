import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  RefreshCw, Play, Square, Loader2,
  AlertCircle, Monitor, Smartphone, Tablet, Watch,
  Palette, MonitorSmartphone, Info, ChevronDown, Check, Maximize2,
  Code2, Box, Square as SquareIcon
} from '../utils/icons';
import { useCanvasDeviceStore, type CanvasDeviceInfo } from '../state/canvasDeviceStore';
import { MountTransition } from './MountTransition';
import { usePreviewStreamStore, restoreDslFromHotStore, restoreDslFromChatHistory } from '../state/previewStreamStore';
import WebAstPreview from './WebAstPreview';
import {
  selectModel as apiSelectModel,
  deleteCanvas as apiDeleteCanvas,
  type CanvasResource,
} from '../services/canvas/sessionApi';
import { CanvasResourceBar } from './CanvasResourceBar';
import { setCanvasSessionId, clearCanvasSessionId, clearByCanvasSessionId } from '../services/incrementalCanvasPusher';

// ── 设备下拉框动画 variants (与协同副模型 SecondaryModelSelector 完全一致) ──
// 柔和推出: y 位移 + opacity 同步淡入 + scale 微调, 顶部锚点
const devicePanelVariants = {
  hidden: {
    opacity: 0,
    scale: 0.94,
    y: 20,
    transition: {
      duration: 0.14,
      ease: [0.4, 0, 1, 1] as [number, number, number, number],
    },
  },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      duration: 0.38,
      ease: [0.16, 1, 0.3, 1] as [number, number, number, number],
    },
  },
};

const deviceContentVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.32,
      ease: [0.16, 1, 0.3, 1] as [number, number, number, number],
      delay: 0.08,
    },
  },
};

const deviceBackdropVariants = {
  hidden: { opacity: 0, transition: { duration: 0.18, ease: [0.4, 0, 1, 1] as [number, number, number, number] } },
  visible: { opacity: 1, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
};

interface PreviewPanelProps {
  width?: number;
  isResizing?: boolean;
  dragStartWidth?: number;
  selectedChatId?: string;
  /** P0: 由 useChatClickCanvasBridge 解析出的画布 ID (canvas_1 ... canvas_10) */
  canvasId?: string | null;
  /** P0: 画布 ID 是否已就绪 (首次进入 chat 时, 后台拉取+建画布可能耗时) */
  canvasReady?: boolean;
  /** P0: 画布池资源列表 (用于 CanvasResourceBar chip 栏) */
  canvases?: CanvasResource[];
  /** P0: 画布池上限 */
  maxCanvases?: number;
  /** P0: 切换画布 */
  onSelectCanvas?: (canvasId: string) => void;
  /** P0: 新建画布 (返回新画布 ID; 已满返回 null) */
  onCreateCanvas?: () => Promise<string | null>;
  /** P0: 改画布描述 */
  onRenameCanvas?: (canvasId: string, description: string) => Promise<boolean>;
  /** P0: 删除画布 (仅 owner) */
  onDeleteCanvas?: (canvasId: string) => Promise<boolean>;
}

type CanvasState = 'idle' | 'starting' | 'running' | 'error';

declare global {
  interface Window {
    soloforge?: {
      platform: string;
      versions: { electron: string; chrome: string; node: string };
      canvas: {
        start: (sessionId: string, width: number, height: number) => Promise<{ ok: boolean; error?: string; session?: any; reused?: boolean }>;
        resize: (sessionId: string, width: number, height: number) => Promise<{ ok: boolean; error?: string }>;
        stop: (sessionId: string) => Promise<{ ok: boolean; notFound?: boolean }>;
        push: (sessionId: string, dsl: any) => Promise<{ ok: boolean; status?: number; body?: string; error?: string }>;
        status: (sessionId: string) => Promise<{ ok: boolean; active: boolean; info?: any }>;
        reportBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<{ ok: boolean; error?: string }>;
        hostInfo: () => Promise<{ ok: boolean; created?: boolean; bounds: { x: number; y: number; width: number; height: number } }>;
        ensureHost: () => Promise<{ ok: boolean; created?: boolean; hwnd?: number; bounds?: any; error?: string }>;
        pushUI: (sessionId: string, dsl: any, deviceId?: string | null) => Promise<{ ok: boolean; error?: string }>;
        selectDevice: (sessionId: string, modelKey: string, file: string, nativeSize: { w: number; h: number }) => Promise<{ ok: boolean; error?: string }>;
        setHostVisible: (visible: boolean) => Promise<{ ok: boolean; error?: string }>;
        openDevicePopup: (x: number, y: number, items: Array<{key:string; label:string; w:number; h:number; glbFile?:string; icon?:string}>, activeKey: string) => Promise<{ ok: boolean }>;
        closeDevicePopup: () => Promise<{ ok: boolean }>;
        onDeviceSelected: (callback: (data: { key: string; glbFile?: string }) => void) => () => void;
        transformDevice: (sessionId: string, deviceId: string, transform: any) => Promise<{ ok: boolean; error?: string }>;
        clearDevices: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
        setBackground: (sessionId: string, color: string) => Promise<{ ok: boolean; error?: string }>;
        screenshot: (sessionId: string) => Promise<{ ok: boolean; dataUrl?: string; width?: number; height?: number; error?: string }>;
        getDeviceConfig: () => Promise<{ ok: boolean; config?: any; modelsDir?: string }>;
        listModels: () => Promise<{ ok: boolean; models?: any[] }>;
        embedStatus: (sessionId: string) => Promise<{ ok: boolean; sessionId?: string; embedded?: boolean; hwnd?: number; pid?: number; width?: number; height?: number; error?: string }>;
        onExited: (callback: (info: CanvasExitedInfo) => void) => () => void;
      };
    };
  }
}

/** main.cjs child.on('exit') 推送的画布退出信息 */
interface CanvasExitedInfo {
  sessionId: string;
  exitCode: number | null;
  signal: string | null;
  isCrash: boolean;
  stderr: string;
  message: string;
}

const isElectron = () => typeof window !== 'undefined' && !!window.soloforge;

// 预设底色 — 满足"干净"要求
const BG_PRESETS: { name: string; value: string; fg: string }[] = [
  { name: '纯白', value: '#FFFFFF', fg: '#1f2937' },
  { name: '纯黑', value: '#000000', fg: '#f3f4f6' },
  { name: '深夜', value: '#0B1020', fg: '#cbd5e1' },
  { name: '雪灰', value: '#F1F5F9', fg: '#1e293b' },
  { name: '护眼', value: '#E8F0E8', fg: '#2f4f4f' },
  { name: '暖灰', value: '#F4ECE0', fg: '#3a2e1f' },
];

// ── 设备分组类型 ──
type SizeGroup = 'desktop' | 'mobile' | 'tablet' | 'watch';

interface DevicePreset {
  key: string; group: SizeGroup; groupLabel: string; icon: React.ComponentType<any>;
  label: string; w: number; h: number;
  /** 3D 模型的 GLB 文件路径 (相对于 models/3d/) */
  glbFile?: string;
  /** 2D 边框的 PNG 文件路径 (相对于 models/2d/) */
  pngFile?: string;
}

// ── 2D 设备列表 (有 PNG 边框的设备) ──
const DEVICES_2D: DevicePreset[] = [
  // 手机
  { key: 'd2-iphone16',        group: 'mobile',  groupLabel: '手机',   icon: Smartphone, label: 'iPhone 16',          w: 393, h: 852, pngFile: 'mobile/iphone_16.png' },
  { key: 'd2-iphone16plus',    group: 'mobile',  groupLabel: '手机',   icon: Smartphone, label: 'iPhone 16 Plus',      w: 430, h: 932, pngFile: 'mobile/iphone_16_plus.png' },
  { key: 'd2-iphone16pro',     group: 'mobile',  groupLabel: '手机',   icon: Smartphone, label: 'iPhone 16 Pro',       w: 402, h: 869, pngFile: 'mobile/iphone_16_pro.png' },
  { key: 'd2-iphone16promax',  group: 'mobile',  groupLabel: '手机',   icon: Smartphone, label: 'iPhone 16 Pro Max',   w: 440, h: 956, pngFile: 'mobile/iphone_16_pro_max.png' },
  // 平板
  { key: 'd2-ipada16',         group: 'tablet',  groupLabel: '平板',   icon: Tablet,     label: 'iPad A16 (竖屏)',     w: 820, h: 1180, pngFile: 'tablet/ipad_a16.png' },
  { key: 'd2-ipada16ls',       group: 'tablet',  groupLabel: '平板',   icon: Tablet,     label: 'iPad A16 (横屏)',     w: 1180, h: 820, pngFile: 'tablet/ipad_a16_landscape.png' },
  // 桌面
  { key: 'd2-imac',            group: 'desktop', groupLabel: '桌面',   icon: Monitor,    label: 'iMac M4 24"',         w: 2560, h: 1440, pngFile: 'desktop/imac_m4.png' },
  { key: 'd2-macbookneo',      group: 'desktop', groupLabel: '桌面',   icon: Monitor,    label: 'MacBook Neo',         w: 1512, h: 982, pngFile: 'desktop/macbook_neo.png' },
  { key: 'd2-macbookpro14',    group: 'desktop', groupLabel: '桌面',   icon: Monitor,    label: 'MacBook Pro M5 14"',  w: 1512, h: 982, pngFile: 'desktop/macbook_pro_m5_14.png' },
  { key: 'd2-macbookpro16',    group: 'desktop', groupLabel: '桌面',   icon: Monitor,    label: 'MacBook Pro M5 16"',  w: 1728, h: 1117, pngFile: 'desktop/macbook_pro_m5_16.png' },
  { key: 'd2-studiodisplay',   group: 'desktop', groupLabel: '桌面',   icon: Monitor,    label: 'Studio Display',      w: 2560, h: 1440, pngFile: 'desktop/studio_display.png' },
  { key: 'd2-appletv',         group: 'desktop', groupLabel: '桌面',   icon: Monitor,    label: 'Apple TV 4K',         w: 1920, h: 1080, pngFile: 'desktop/apple_tv_4k.png' },
  // 手表
  { key: 'd2-watchs11_42',     group: 'watch',   groupLabel: '手表',   icon: Watch,      label: 'Apple Watch S11 42mm', w: 352, h: 352, pngFile: 'watch/apple_watch_s11_42.png' },
  { key: 'd2-watchs11_46',     group: 'watch',   groupLabel: '手表',   icon: Watch,      label: 'Apple Watch S11 46mm', w: 396, h: 396, pngFile: 'watch/apple_watch_s11_46.png' },
  { key: 'd2-watchultra2',     group: 'watch',   groupLabel: '手表',   icon: Watch,      label: 'Apple Watch Ultra 2',  w: 502, h: 410, pngFile: 'watch/apple_watch_ultra_2.png' },
  { key: 'd2-watchultra3',     group: 'watch',   groupLabel: '手表',   icon: Watch,      label: 'Apple Watch Ultra 3',  w: 502, h: 410, pngFile: 'watch/apple_watch_ultra_3.png' },
];

// ── 3D 设备列表 (仅有真实 GLB 模型的设备, 文件 >10KB 才算真实) ──
const DEVICES_3D: DevicePreset[] = [
  // 手机 — 仅有真实 GLB 文件的
  { key: 'm-iphone14pro',    group: 'mobile',  groupLabel: '手机',   icon: Smartphone, label: 'iPhone 14 Pro',      w: 393, h: 852, glbFile: 'mobile/iphone_14_pro.glb' },
  { key: 'm-iphone15promax', group: 'mobile',  groupLabel: '手机',   icon: Smartphone, label: 'iPhone 15 Pro Max',  w: 430, h: 932, glbFile: 'mobile/iphone_15_pro_max.glb' },
  { key: 'm-iphone11promax', group: 'mobile',  groupLabel: '手机',   icon: Smartphone, label: 'iPhone 11 Pro Max',  w: 414, h: 896, glbFile: 'mobile/iphone_11_pro_max.glb' },
];

const FILL_PRESET: DevicePreset = {
  key: 'fill', group: 'desktop', groupLabel: '', icon: Maximize2, label: '填满当前宽度', w: 0, h: 0,
};

function findDevicePreset(key: string): DevicePreset {
  if (key === 'fill') return FILL_PRESET;
  return [...DEVICES_2D, ...DEVICES_3D].find(p => p.key === key) || FILL_PRESET;
}

export default function PreviewPanel({
  width = 385, isResizing = false, dragStartWidth = 385,
  selectedChatId, canvasId, canvasReady,
  canvases = [], maxCanvases = 10,
  onSelectCanvas, onRenameCanvas, onDeleteCanvas,
}: PreviewPanelProps) {
  // 2026-07-06 阶段3: 订阅 AST 预览流状态
  const previewEntry = usePreviewStreamStore(s => selectedChatId ? s.entries[selectedChatId] : undefined);
  const previewIsStreaming = previewEntry?.isStreaming ?? false;
  const previewPayload = previewEntry?.payload ?? null;
  const previewAst = previewEntry?.ast;
  const previewSourceCode = previewEntry?.sourceCode ?? '';
  const previewLanguage = previewEntry?.language ?? '';
  const previewRawBytes = previewEntry?.rawBytes ?? 0;
  const previewPushError = previewEntry?.pushError ?? null;
  const [showSourceCode, setShowSourceCode] = useState(false);

  const [canvasState, setCanvasState] = useState<CanvasState>('idle');
  const [canvasError, setCanvasError] = useState<string>('');
  // P0: 优先使用 App.tsx 解析出的画布 ID (canvas_1 ... canvas_10)
  //   - 解析期间 fallback 到旧派生 ID 保证不会白屏
  //   - canvasReady 后再切到真实 ID (canvas.stop 老 + canvas.start 新)
  const fallbackId = `canvas-${selectedChatId || 'default'}`;
  const effectiveCanvasId = canvasId || fallbackId;

  // ★ 2026-07-13: 画布 DSL 恢复链路 (三级降级)
  //   1. previewStreamStore 已有数据 → 不做任何事
  //   2. GarnetStore 热存储 (24h TTL) → 快速恢复
  //   3. 聊天历史 rawContent (持久) → 从最后一条 assistant 消息提取代码块重新翻译
  useEffect(() => {
    if (!selectedChatId) return;
    const existing = usePreviewStreamStore.getState().entries[selectedChatId];
    if (existing?.ast || existing?.payload) return; // 已有数据, 不覆盖
    let cancelled = false;

    // 公共: 将恢复的 DSL 写入 previewStreamStore
    const applyRestored = (restored: { dsl: any; language: string; sourceCode: string }) => {
      if (cancelled) return;
      const ps = usePreviewStreamStore.getState();
      ps.initEntry(selectedChatId, { language: restored.language, sessionId: effectiveCanvasId });
      ps.updateStream(selectedChatId, {
        raw: restored.sourceCode,
        payload: {
          language: restored.language,
          framework: restored.language,
          source_code: restored.sourceCode,
          preview: { root: restored.dsl },
        } as any,
        errors: [],
        done: true,
      });
      ps.confirmPayload(selectedChatId, {
        language: restored.language,
        framework: restored.language,
        source_code: restored.sourceCode,
        preview: { root: restored.dsl },
      } as any);
      console.log(`[PreviewPanel] DSL restored from ${restored.language}, sourceLen=${restored.sourceCode.length}`);
    };

    // Step 1: 尝试 GarnetStore 热存储
    restoreDslFromHotStore(selectedChatId, effectiveCanvasId).then((hotResult) => {
      if (cancelled) return;
      if (hotResult) {
        applyRestored(hotResult);
        return;
      }
      // Step 2: 热存储没有 → 从聊天历史降级恢复
      //   通过 window 全局引用获取 useChatStore.getState (避免循环依赖)
      let messages: Array<{ sender: string; rawContent?: string; content: string }> = [];
      const chatGetState = (window as any).__chatStoreGetState;
      if (typeof chatGetState === 'function') {
        const store = chatGetState();
        if (store?.conversations?.[selectedChatId]) {
          messages = store.conversations[selectedChatId];
        }
      }
      if (messages.length === 0) return; // 没有聊天记录, 无法降级

      const chatResult = restoreDslFromChatHistory(messages);
      if (chatResult) {
        console.log('[PreviewPanel] hot store empty, restoring from chat history fallback');
        applyRestored(chatResult);
      }
    });

    return () => { cancelled = true; };
  }, [selectedChatId, effectiveCanvasId]);
  // 待机状态已废弃: 始终显示工具栏 + 占位区, 用户可手动启动画布
  const noCanvas = false;
  const sessionIdRef = useRef<string>(effectiveCanvasId);
  const [canvasInfo, setCanvasInfo] = useState<{ port: number; pid: number } | null>(null);
  const [bgColor, setBgColor] = useState<string>(BG_PRESETS[0].value);
  const [customColor, setCustomColor] = useState<string>('#FFFFFF');
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showDeviceDropdown, setShowDeviceDropdown] = useState(false);
  // ★ 下拉框 fixed 定位坐标 (基于按钮 getBoundingClientRect, 避免 overflow-hidden 裁剪)
  const [devicePanelPos, setDevicePanelPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });

  // ★ 设备下拉框 ref (用于点击外部关闭 + Esc 关闭, 与协同副模型一致)
  const deviceBtnRef = useRef<HTMLDivElement | null>(null);
  const devicePanelRef = useRef<HTMLDivElement | null>(null);

  // ★ 从 store 读取当前画布的设备信息 (按 canvasId 独立存储)
  const deviceStore = useCanvasDeviceStore();
  const currentDevice = effectiveCanvasId ? deviceStore.devices[effectiveCanvasId] ?? null : null;
  const renderMode = deviceStore.renderMode;
  const setRenderMode = deviceStore.setRenderMode;
  const setDeviceInStore = deviceStore.setDevice;

  // ★ 从设备信息反推当前 preset (用于兼容现有逻辑)
  const activeSizeKey = currentDevice?.sizeKey ?? 'none';
  const activePreset = currentDevice ? findDevicePreset(currentDevice.sizeKey) : null;
  const activeDeviceList = renderMode === '2D' ? DEVICES_2D : DEVICES_3D;

  // ★ canvasStateRef — 提前声明, 供 handleSelectDevice / 崩溃检测使用 (避免 TDZ)
  const canvasStateRef = useRef(canvasState);
  useEffect(() => { canvasStateRef.current = canvasState; }, [canvasState]);
  const isStoppingRef = useRef(false);

  // ★ 3D 设备选择: 通过 /render 端点加载 GLB 模型到当前画布
  //   用 canvasStateRef.current 代替 canvasState, 避免闭包陷阱
  const handleSelectDevice = useCallback(async (preset: DevicePreset) => {
    if (!sessionIdRef.current || !canvasId) return;
    // 调用后端 selectModel (仅当前 canvas session) — 必须带 requester header (ACL)
    if (selectedChatId) {
      await apiSelectModel(sessionIdRef.current, preset.key, selectedChatId).catch(() => {});
    }
    // 通过 IPC selectDevice → POST /render → Flutter 加载 GLB 模型
    // ★ 用 ref 读取最新 canvasState, 避免捕获旧 state
    if (isElectron() && canvasStateRef.current === 'running' && preset.glbFile) {
      try {
        await window.soloforge!.canvas.selectDevice(
          sessionIdRef.current,
          preset.key,
          preset.glbFile,
          { w: preset.w, h: preset.h },
        );
      } catch (e) {
        console.warn('[handleSelectDevice] selectDevice failed:', e);
      }
    }
  }, [canvasId, selectedChatId]);

  // ★ 选择设备时写入 store (按 canvasId)
  const handleSelectSizeKey = useCallback((key: string) => {
    if (!effectiveCanvasId) return;
    if (key === 'none') {
      setDeviceInStore(effectiveCanvasId, null);
      return;
    }
    const preset = findDevicePreset(key);
    const deviceInfo: CanvasDeviceInfo = {
      sizeKey: preset.key,
      label: preset.label,
      width: preset.w,
      height: preset.h,
      group: preset.group,
      renderMode,
      pngFile: preset.pngFile,
      glbFile: preset.glbFile,
    };
    setDeviceInStore(effectiveCanvasId, deviceInfo);
    // 3D 模式下选中设备 → 加载 GLB 模型到当前画布
    if (renderMode === '3D' && preset.glbFile) {
      void handleSelectDevice(preset);
    }
  }, [effectiveCanvasId, renderMode, setDeviceInStore, handleSelectDevice]);

  // ★ 下拉框/颜色选择器打开时隐藏 Flutter 原生窗口, 避免拦截点击 + 视觉遮挡
  useEffect(() => {
    if (!isElectron()) return;
    const anyDropdownOpen = showDeviceDropdown || showColorPicker;
    window.soloforge?.canvas.setHostVisible?.(!anyDropdownOpen).catch(() => {});
  }, [showDeviceDropdown, showColorPicker]);

  // ★ 按钮 toggle: 先隐藏 Flutter 窗口再打开下拉框, 避免 fixed panel 被 HWND 盖住
  const toggleDeviceDropdown = useCallback(() => {
    if (!showDeviceDropdown && isElectron()) {
      // 即将打开 → 先隐藏 Flutter 窗口 (异步, 但尽早发出)
      window.soloforge?.canvas.setHostVisible?.(false).catch(() => {});
    }
    setShowDeviceDropdown(s => !s);
  }, [showDeviceDropdown]);

  // ★ 设备下拉框 Esc 关闭 (与协同副模型一致)
  useEffect(() => {
    if (!showDeviceDropdown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setShowDeviceDropdown(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showDeviceDropdown]);

  // ★ 设备下拉框点击外部关闭 (与协同副模型一致)
  useEffect(() => {
    if (!showDeviceDropdown) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (deviceBtnRef.current?.contains(target)) return;
      if (devicePanelRef.current?.contains(target)) return;
      setShowDeviceDropdown(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showDeviceDropdown]);

  // ★ 打开下拉框时计算 fixed 定位坐标 (避免被祖先 overflow-hidden 裁剪)
  useEffect(() => {
    if (!showDeviceDropdown) return;
    const updatePos = () => {
      const btn = deviceBtnRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      // 面板右对齐到按钮右边, 顶部在按钮下方 14px (mt-3.5)
      setDevicePanelPos({
        top: rect.bottom + 14,
        right: window.innerWidth - rect.right,
      });
    };
    updatePos();
    // 窗口滚动/resize 时重新计算
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, true);
    return () => {
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', updatePos, true);
    };
  }, [showDeviceDropdown]);

  // ★ 监听 Electron 弹窗的设备选择回调
  useEffect(() => {
    if (!isElectron()) return;
    const unsub = window.soloforge!.canvas.onDeviceSelected((data) => {
      handleSelectSizeKey(data.key);
      setShowDeviceDropdown(false);
    });
    return () => { unsub(); };
  }, [handleSelectSizeKey]);

  const [showElectronHint, setShowElectronHint] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // ★ canvas 区域专用 ref — reportBounds 只上报此区域, 避免Flutter窗口覆盖工具栏
  const canvasAreaRef = useRef<HTMLDivElement | null>(null);

  // 画布跟随应用默认启用 — Electron 环境下自动启动
  // 防重入: autoStartRef 防止同一生命周期内重复触发
  // 失败不重试: autoStartFailed 标记防止 error→idle 循环
  // ★ 2026-07-11: sessionId 变化时重置 autoStartRef + autoStartFailedRef
  //   原因: 第一次用 fallbackId (canvas-1) 启动失败 → autoStartFailed=true
  //   canvasReady 后 sessionId 切换为 canvas_1, 但 autoStartFailed 仍 true → 永远不自动启动
  const autoStartRef = useRef(false);
  const autoStartFailedRef = useRef(false);
  const lastAutoStartSessionId = useRef<string>('');
  useEffect(() => {
    const prevId = lastAutoStartSessionId.current;
    const newId = sessionIdRef.current;
    // sessionId 变化 → 切换画布
    if (newId && newId !== prevId) {
      const wasRunning = canvasState === 'running';
      // ★ 不立即停旧画布, 保持旧画布可见 (避免白屏 + "启动中"闪烁)
      //   先启动新画布, 成功后再停旧画布
      lastAutoStartSessionId.current = newId;
      autoStartRef.current = false;
      autoStartFailedRef.current = false;

      if (wasRunning && isElectron() && prevId) {
        // 切换模式: 后台启动新画布, 成功后停旧画布
        //   不设 starting 状态 → 用户不会看到全屏"启动中"
        (async () => {
          try {
            const { w: frameW, h: frameH } = computeFrame(activePreset);
            const res = await window.soloforge!.canvas.start(newId, frameW, frameH);
            if (!res.ok) {
              // 新画布启动失败 → 保持旧画布运行, 显示错误
              setCanvasError(res.error || '切换画布失败');
              autoStartFailedRef.current = true;
              return;
            }
            // 新画布启动成功 → 停旧画布
            window.soloforge?.canvas.stop(prevId).catch(() => {});
            setCanvasInfo({ port: res.session.port, pid: res.session.pid });
            await pushBackground(bgColor);
          } catch (e: any) {
            setCanvasError(e?.message || String(e));
            autoStartFailedRef.current = true;
          }
        })();
      } else {
        // 首次启动 (非切换): 正常走 idle → starting → running
        if (canvasState !== 'idle') {
          setCanvasState('idle');
          canvasStateRef.current = 'idle';
          setCanvasInfo(null);
          setCanvasError('');
        }
        // 停掉旧画布 (如果存在)
        if (prevId && isElectron()) {
          window.soloforge?.canvas.stop(prevId).catch(() => {});
        }
      }
    }
    if (autoStartRef.current || autoStartFailedRef.current) return;
    // ★ 2026-07-13: 只在有真实画布 ID 时自动启动 (不再用 fallback ID)
    //   sessionIdRef 由 useLayoutEffect 同步更新, 保证此处的值是最新的
    if (isElectron() && canvasState === 'idle' && selectedChatId && sessionIdRef.current && canvasReady && canvasId) {
      autoStartRef.current = true;
      void startCanvas();
    }
  }, [canvasState, selectedChatId, canvasId, canvasReady]);

  // ─────────────────────────────────────────
  // ★ 画布进程崩溃检测 (2026-07-08)
  //   - 监听 main.cjs 推送的 'canvas:exited' IPC 事件
  //   - 崩溃时: 更新 UI 状态 + 显示友好错误 + 允许重启
  //   - 正常退出 (用户点停止): 不显示错误, 仅同步状态
  // ─────────────────────────────────────────

  useEffect(() => {
    if (!isElectron() || !window.soloforge?.canvas?.onExited) return;
    const unsubscribe = window.soloforge.canvas.onExited((info) => {
      // 只处理当前 session 的退出事件
      if (info.sessionId !== sessionIdRef.current) return;
      // 用户主动停止 → 不显示崩溃错误
      if (isStoppingRef.current) {
        isStoppingRef.current = false;
        return;
      }
      // 画布已不在 running 状态 → 无需处理 (避免重复设置)
      if (canvasStateRef.current !== 'running' && canvasStateRef.current !== 'starting') {
        return;
      }
      if (info.isCrash) {
        console.error('[canvas] 进程崩溃:', info);
        setCanvasState('error');
        setCanvasInfo(null);
        // 显示友好的崩溃信息 (而不是裸露的退出码如 100488)
        const stderrHint = info.stderr
          ? info.stderr.split('\n').filter(l => l.trim()).slice(-3).join(' | ')
          : '';
        setCanvasError(
          stderrHint
            ? `画布进程崩溃 (${info.message})\n${stderrHint}`
            : info.message
        );
        // 允许用户手动重启 (清除 autoStartFailed 标记)
        autoStartFailedRef.current = false;
        autoStartRef.current = false;
      } else {
        // 正常退出 → 回到 idle
        setCanvasState('idle');
        setCanvasInfo(null);
        setCanvasError('');
      }
    });
    return unsubscribe;
  }, []);

  // ★ 2026-07-13: 改用 useLayoutEffect — 在 useEffect(自动启动) 之前同步执行
  //   原因: React effect 按定义顺序执行, 自动启动 effect 在前, sessionId 更新 effect 在后
  //   导致自动启动读到旧的 fallback ID (canvas-{chatId}), 而非真实画布 ID (canvas_1)
  //   useLayoutEffect 在 useEffect 之前同步执行, 保证 sessionIdRef.current 始终是最新的
  useLayoutEffect(() => {
    // P0: 仅在 canvasReady 后才切到真实画布 ID
    //   - ready=false 时保留 fallback (旧 canvas-${chatId})
    //   - ready=true 时切到 canvas_1 ... canvas_10
    if (canvasReady && canvasId) {
      sessionIdRef.current = canvasId;
    } else if (canvasReady && !canvasId) {
      // 无画布待机: 清空 sessionId, 画布不会启动
      sessionIdRef.current = '';
    } else {
      sessionIdRef.current = fallbackId;
    }
    // ★ 2026-07-11: 注册 canvas sessionId 到全局映射,
    //   让 IncrementalCanvasPusher 能推送到正确的画布
    if (selectedChatId && sessionIdRef.current) {
      setCanvasSessionId(selectedChatId, sessionIdRef.current);
    }
  }, [canvasId, canvasReady, fallbackId, selectedChatId]);

  // ─────────────────────────────────────────
  // ★ 上报 canvas 区域 (不含工具栏) 的位置和尺寸给主进程
  //   Flutter 原生窗口只覆盖此区域, 不遮挡工具栏按钮
  useEffect(() => {
    if (!isElectron()) return;
    const report = () => {
      const el = canvasAreaRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      window.soloforge!.canvas.reportBounds({
        x: Math.round(r.left), y: Math.round(r.top),
        width: Math.round(r.width), height: Math.round(r.height),
      }).catch(() => {});
    };
    // 延迟一帧确保 layout 完成
    const timer = setTimeout(report, 50);
    const ro = new ResizeObserver(report);
    if (canvasAreaRef.current) ro.observe(canvasAreaRef.current);
    window.addEventListener('resize', report);
    window.addEventListener('scroll', report);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
      window.removeEventListener('resize', report);
      window.removeEventListener('scroll', report);
    };
  }, [width, canvasId, canvasReady]);

  // 卸载时自动停掉画布
  useEffect(() => {
    return () => {
      if (isElectron() && canvasState === 'running') {
        window.soloforge!.canvas.stop(sessionIdRef.current).catch(() => {});
      }
      if (selectedChatId) {
        clearCanvasSessionId(selectedChatId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 把根容器 backgroundColor 合并进最近一次 DSL 重新 push
  // ★ 2026-07-11: 去掉 canvasState 依赖 — 闭包陷阱!
  //   startCanvas 调用 pushBackground 时, setCanvasState('running') 还没生效
  //   pushBackground 闭包中的 canvasState 仍是 'idle' → 直接 return → 画布空白
  //   修复: 不检查 canvasState, 调用方自己保证画布已运行
  const pushBackground = useCallback(async (color: string) => {
    if (!isElectron() || !sessionIdRef.current) return;
    const dsl = {
      ui: {
        type: 'container',
        props: { padding: 16, backgroundColor: color, layout: 'column', spacing: 8 },
        children: [
          { type: 'text', props: { content: '画布已就绪', fontSize: 18, fontWeight: 700, color: pickFg(color) } },
          { type: 'text', props: { content: `当前底色: ${color}`, fontSize: 12, color: pickFg(color), opacity: 0.75 } },
          { type: 'text', props: { content: `Session: ${sessionIdRef.current}`, fontSize: 11, color: pickFg(color), opacity: 0.6 } },
          { type: 'text', props: { content: `通过左侧聊天窗口生成 UI 描述，会自动推送到这里`, fontSize: 12, color: pickFg(color), opacity: 0.55 } },
        ],
      },
      platform: 'material',
    };
    try {
      const r = await window.soloforge!.canvas.push(sessionIdRef.current, dsl);
      if (!r.ok) {
        // "session not found" 是 startCanvas 返回后、画布进程立即崩溃的竞态:
        //   main.cjs exit handler 已从 canvasSessions 删除 session,
        //   但 canvas:exited IPC 事件尚未到达渲染层。
        //   onExited 监听器会显示真正的崩溃原因, 此处无需重复告警。
        if (String(r.error).includes('session not found')) return;
        console.warn('[pushBackground] push failed:', r.error);
      }
    } catch (e: any) {
      console.warn('[pushBackground] exception:', e?.message || e);
    }
  }, []);

  // 2026-07-11: IncrementalCanvasPusher 已经在 useChatStore 中直接推画布,
  //   PreviewPanel 不再重复推送 — 避免双推冲突 + WebAstPreview 覆盖 Flutter 画布

  // ★ FIX 2026-07-14: 追踪 canvas 实际区域尺寸 (替代硬编码 640 高度)
  const [canvasAreaSize, setCanvasAreaSize] = useState<{ w: number; h: number }>({ w: 360, h: 640 });
  useEffect(() => {
    const el = canvasAreaRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setCanvasAreaSize({ w: Math.floor(r.width), h: Math.floor(r.height) });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 计算画布实际宽高（无设备约束时填满 PreviewPanel 宽度 + 实际高度）
  const computeFrame = useCallback((preset: DevicePreset | null) => {
    if (preset && preset.w > 0) return { w: preset.w, h: preset.h };
    return {
      w: Math.max(320, Math.floor(width - 32)),
      h: Math.max(400, canvasAreaSize.h - 16),
    };
  }, [width, canvasAreaSize]);

  // ★ 2026-07-14: 将画布实际帧尺寸写入 store, 供 aiBackend (LLM prompt 注入) + incrementalCanvasPusher (canvas.start 参数) 读取
  // ★ FIX 2026-07-14: 同时写入 fallback key, 确保时序不一致时 aiBackend 也能找到
  const setFrameSizeInStore = deviceStore.setFrameSize;
  useEffect(() => {
    if (!effectiveCanvasId || !selectedChatId) return;
    const { w, h } = computeFrame(activePreset);
    const size = { width: w, height: h };
    setFrameSizeInStore(effectiveCanvasId, size);
    // ★ 同时写入 fallback key, 确保即使 bridge 还没更新, aiBackend 也能找到帧尺寸
    const fallbackKey = `canvas-${selectedChatId}`;
    if (effectiveCanvasId !== fallbackKey) {
      setFrameSizeInStore(fallbackKey, size);
    }
  }, [effectiveCanvasId, activePreset, computeFrame, setFrameSizeInStore, selectedChatId]);

  // 启动画布 — 带 30s 超时保护，防止 IPC 卡死导致 UI 永远停在 "启动中"
  const startCanvas = useCallback(async () => {
    if (!isElectron()) {
      setCanvasError('需要 Electron 环境运行画布（请使用 npm run dev 启动 IDE）');
      setCanvasState('error');
      setShowElectronHint(true);
      return;
    }
    setCanvasState('starting');
    canvasStateRef.current = 'starting';
    setCanvasError('');
    setShowElectronHint(false);
    try {
      const { w: frameW, h: frameH } = computeFrame(activePreset);
      // 30s 超时：主进程 findWindowByPid 循环 + embed 可能慢，但不能无限等
      const timeoutP = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('画布启动超时（30s），请检查 canvas_preview.exe 是否正常运行')), 30000)
      );
      const res = await Promise.race([
        window.soloforge!.canvas.start(sessionIdRef.current, frameW, frameH),
        timeoutP,
      ]);
      if (!res.ok) {
        setCanvasError(res.error || '启动失败');
        setCanvasState('error');
        canvasStateRef.current = 'error';
        autoStartFailedRef.current = true;
        return;
      }
      setCanvasInfo({ port: res.session.port, pid: res.session.pid });
      setCanvasState('running');
      canvasStateRef.current = 'running';
      // ★ 同步更新 ref 后再 pushBackground, 避免闭包陷阱
      await pushBackground(bgColor);
      // ★ 2026-07-14: 画布启动成功后, 自动加载 deviceStore 中已选择的 3D 设备 GLB 模型
      //   修复"用户在画布未启动时选 3D 设备, 模型不加载"的问题
      //   用 getState() 读取最新设备状态, 避免闭包陷阱
      const deviceState = useCanvasDeviceStore.getState();
      const savedDevice = deviceState.devices[sessionIdRef.current];
      if (savedDevice && savedDevice.renderMode === '3D' && savedDevice.glbFile) {
        try {
          await window.soloforge!.canvas.selectDevice(
            sessionIdRef.current,
            savedDevice.sizeKey,
            savedDevice.glbFile,
            { w: savedDevice.width, h: savedDevice.height },
          );
          // 同步通知后端 selectModel (ACL)
          if (selectedChatId) {
            await apiSelectModel(sessionIdRef.current, savedDevice.sizeKey, selectedChatId).catch(() => {});
          }
        } catch (e) {
          console.warn('[startCanvas] auto-load 3D device failed:', e);
        }
      }
    } catch (e: any) {
      setCanvasError(e?.message || String(e));
      setCanvasState('error');
      canvasStateRef.current = 'error';
      autoStartFailedRef.current = true;
    }
  }, [activePreset, bgColor, pushBackground, computeFrame, selectedChatId]);

  const stopCanvas = useCallback(async () => {
    if (!isElectron()) return;
    // 标记为用户主动停止 → 崩溃检测收到 exit 事件时不会误判为崩溃
    isStoppingRef.current = true;
    setCanvasState('idle');
    setCanvasInfo(null);
    setCanvasError('');
    await window.soloforge!.canvas.stop(sessionIdRef.current).catch(() => {});
  }, []);

  const handlePickColor = (color: string) => {
    setBgColor(color);
    setShowColorPicker(false);
    if (canvasState === 'running') pushBackground(color);
  };

  const handlePickCustom = () => {
    setBgColor(customColor);
    setShowColorPicker(false);
    if (canvasState === 'running') pushBackground(customColor);
  };

  // ★ 删除画布 — 彻底清理: 后端数据库 + Electron 子进程 + 前端所有缓存
  const handleDeleteCanvas = useCallback(async (targetCanvasId: string): Promise<boolean> => {
    if (!selectedChatId) return false;
    // 1. 停掉被删除画布的 Electron 子进程
    if (isElectron()) {
      window.soloforge?.canvas.stop(targetCanvasId).catch(() => {});
    }
    // 2. 调后端 DELETE — 清理内存 states/dirty + Garnet 热存储 + SurrealDB 持久层
    const ok = await apiDeleteCanvas(targetCanvasId, selectedChatId);
    if (ok) {
      // 3. 前端缓存清理 — incrementalCanvasPusher (chatId→canvasId 映射 + _startedSessions)
      clearByCanvasSessionId(targetCanvasId);
      // 4. 前端缓存清理 — canvasDeviceStore (设备尺寸/渲染模式记录)
      useCanvasDeviceStore.getState().removeDevice(targetCanvasId);
      // 5. 前端缓存清理 — previewStreamStore (当前 chat 的流式预览数据)
      usePreviewStreamStore.getState().clearEntry(selectedChatId);
      // 6. 如果删除的是当前画布, 清除当前选中状态
      if (canvasId === targetCanvasId) {
        clearCanvasSessionId(selectedChatId);
      }
      // 7. 刷新画布列表 — 通过 bridge 的 refresh
      window.dispatchEvent(new CustomEvent('soloforge-canvas-deleted', { detail: { canvasId: targetCanvasId } }));
    }
    return ok;
  }, [selectedChatId, canvasId]);

  // 画布状态指示器 — 已移除 (不再显示绿点)
  const renderCanvasStatus = () => null;

  // 待机渲染 — 无画布时显示闪电 logo (色调跟随主题)
  const renderStandby = () => (
    <div className="absolute inset-0 flex flex-col items-center justify-center select-none">
      <div
        className="w-20 h-20 opacity-40 transition-opacity duration-300"
        style={{
          backgroundColor: 'var(--color-primary)',
          maskImage: 'url(/lightning_logo.png)',
          maskSize: 'contain',
          maskPosition: 'center',
          maskRepeat: 'no-repeat',
          WebkitMaskImage: 'url(/lightning_logo.png)',
          WebkitMaskSize: 'contain',
          WebkitMaskPosition: 'center',
          WebkitMaskRepeat: 'no-repeat',
        }}
      />
    </div>
  );

  // 占位渲染
  const renderPlaceholder = () => {
    // ★ FIX 2026-07-12: 当有 AST 预览数据时, 优先显示 WebAstPreview,
    //   即使 canvasState === 'running'。原因: Flutter 嵌入窗口可能不可见
    //   (嵌入失败 / 位置错误 / SVG 渲染不支持), 导致用户看到空白。
    //   WebAstPreview 作为通用渲染层, 保证用户总能看到内容。
    //   Flutter 画布仍在底层并行渲染 (如果可见则作为补充)。
    if (previewAst || previewPayload) {
      const root = previewPayload?.preview?.root || previewAst;
      if (root) {
        return <WebAstPreview root={root} bgColor={bgColor} />;
      }
    }
    // canvas running 且无预览数据: Flutter 嵌入窗口在底层渲染
    if (canvasState === 'running' && !previewPushError) {
      // Flutter 画布在底层渲染, 这里只放透明占位
      // 流式状态信息已由 top bar 的 previewIsStreaming / previewLanguage 显示
      return (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: 'transparent' }}
        />
      );
    }
    // 流式中 (还没有 AST 但正在生成)
    if (previewIsStreaming && !previewAst) {
      return (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 select-none"
          style={{ background: bgColor, transition: 'background 200ms ease' }}
        >
          <Loader2 className="w-8 h-8 animate-spin mb-3" style={{ color: pickFg(bgColor) }} />
          <div className="text-[11px] font-mono mb-1" style={{ color: pickFg(bgColor) + 'AA' }}>
            正在生成 AST 预览…
          </div>
          <div className="text-[9px] font-mono" style={{ color: pickFg(bgColor) + '66' }}>
            {previewLanguage} · {previewRawBytes} bytes
          </div>
          {previewPushError && (
            <div className="text-[9px] text-red-400 mt-2 max-w-[200px]">
              推送错误: {previewPushError}
            </div>
          )}
        </div>
      );
    }
    // 预览失败 — 有错误但没有生成 AST
    if (previewPushError && !previewAst && !previewPayload && !previewIsStreaming) {
      return (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 select-none"
          style={{ background: bgColor, transition: 'background 200ms ease' }}
        >
          <div className="w-14 h-14 rounded-2xl border-2 border-dashed flex items-center justify-center mb-3"
               style={{ borderColor: '#ef444440', color: '#ef4444AA' }}>
            <AlertCircle className="w-7 h-7" />
          </div>
          <div className="font-display font-bold text-sm mb-1" style={{ color: pickFg(bgColor) }}>
            AST 预览生成失败
          </div>
          <div className="text-[11px] max-w-[260px] leading-relaxed mb-3" style={{ color: pickFg(bgColor) + 'AA' }}>
            {previewPushError}
          </div>
          <div className="text-[9px] font-mono" style={{ color: pickFg(bgColor) + '66' }}>
            请检查后端 /api/llm/stream 是否可用 · {previewLanguage}
          </div>
        </div>
      );
    }
    if (canvasState === 'error' || canvasState === 'idle') {
      return (
        <div
          className="absolute inset-0 flex items-center justify-center select-none"
          style={{ background: bgColor, transition: 'background 200ms ease' }}
        >
          <div
            className="w-16 h-16 opacity-40 transition-opacity duration-300"
            style={{
              backgroundColor: 'var(--color-primary)',
              maskImage: 'url(/lightning_logo.png)',
              maskSize: 'contain',
              maskPosition: 'center',
              maskRepeat: 'no-repeat',
              WebkitMaskImage: 'url(/lightning_logo.png)',
              WebkitMaskSize: 'contain',
              WebkitMaskPosition: 'center',
              WebkitMaskRepeat: 'no-repeat',
            }}
          />
        </div>
      );
    }
    if (canvasState === 'starting') {
      return (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 select-none"
          style={{ background: bgColor, transition: 'background 200ms ease' }}
        >
          <Loader2 className="w-8 h-8 animate-spin mb-3" style={{ color: pickFg(bgColor) }} />
          <div className="text-[11px] font-mono" style={{ color: pickFg(bgColor) + 'AA' }}>
            正在启动画布进程…
          </div>
        </div>
      );
    }
    // running: 透明背景 — 真正画布由嵌入的 canvasHostWindow 渲染
    return (
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: 'transparent' }}
      />
    );
  };

  return (
    <div
      ref={containerRef}
      style={{
        // 拖动期间 width 直接跟随鼠标实时变化, 让用户看到边缘被拉伸而非整体平移
        width: `${width}px`,
        transition: isResizing ? 'none' : 'width 250ms cubic-bezier(0.16, 1, 0.3, 1)'
      }}
      className="h-full bg-surface border-l border-outline/50 flex flex-col shrink-0 select-none z-10 overflow-hidden relative"
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          overflow: 'hidden'
        }}
      >
        {/* P0: 画布资源池 chip 栏 — 切换画布 (置顶, 与 ChatPanel 头部对齐) */}
        {!noCanvas && onSelectCanvas && onRenameCanvas && (
          <CanvasResourceBar
            canvases={canvases}
            activeCanvasId={canvasId ?? null}
            maxCanvases={maxCanvases}
            onSelect={onSelectCanvas}
            onRename={onRenameCanvas}
            onDelete={handleDeleteCanvas}
          />
        )}



        {/* TOOLBAR — 无画布待机时隐藏 */}
        {!noCanvas && (
        <div className="px-3 py-2 bg-surface-bright/35 border-b border-outline/30 flex items-center gap-1.5 shrink-0 flex-wrap">
          {canvasState !== 'running' ? (
            <button
              onClick={() => { autoStartFailedRef.current = false; void startCanvas(); }}
              disabled={canvasState === 'starting'}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-500 text-[10px] font-mono font-semibold disabled:opacity-50 transition-colors"
            >
              {canvasState === 'starting' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              <span>{canvasState === 'starting' ? '启动中' : '启动画布'}</span>
            </button>
          ) : (
            <button
              onClick={stopCanvas}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-red-500/15 hover:bg-red-500/25 text-red-500 text-[10px] font-mono font-semibold transition-colors"
            >
              <Square className="w-3 h-3" />
              <span>停止</span>
            </button>
          )}

          {/* 底色选择器 */}
          <div className="relative">
            <button
              onClick={() => setShowColorPicker(s => !s)}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-surface-bright/60 hover:bg-surface-bright text-on-surface text-[10px] font-mono transition-colors"
              title="底色"
            >
              <Palette className="w-3 h-3" />
              <span
                className="inline-block w-3 h-3 rounded-sm border border-outline/60"
                style={{ background: bgColor }}
              />
              <span className="text-on-surface/70">{bgColor}</span>
            </button>
            <MountTransition show={showColorPicker} variant="fade" duration={140}>
              <div
                className="absolute top-full left-0 mt-1 z-50 bg-surface border border-outline rounded-lg shadow-2xl p-2 min-w-[200px]"
              >
                <div className="grid grid-cols-3 gap-1.5 mb-2">
                  {BG_PRESETS.map(p => (
                    <button
                      key={p.value}
                      onClick={() => handlePickColor(p.value)}
                      className={`flex flex-col items-center gap-0.5 p-1.5 rounded border transition-all ${bgColor.toLowerCase() === p.value.toLowerCase() ? 'border-primary ring-1 ring-primary/40' : 'border-outline/50 hover:border-outline'}`}
                    >
                      <span className="w-9 h-6 rounded" style={{ background: p.value, border: '1px solid rgba(0,0,0,0.1)' }} />
                      <span className="text-[9px] text-on-surface/70 font-mono">{p.name}</span>
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5 pt-1.5 border-t border-outline/50">
                  <input
                    type="color"
                    value={customColor}
                    onChange={e => setCustomColor(e.target.value)}
                    className="w-7 h-7 rounded cursor-pointer bg-transparent border-0 p-0"
                  />
                  <input
                    type="text"
                    value={customColor}
                    onChange={e => setCustomColor(e.target.value)}
                    className="flex-1 px-1.5 py-1 text-[10px] font-mono bg-bg border border-outline rounded text-on-surface"
                  />
                  <button
                    onClick={handlePickCustom}
                    className="px-2 py-1 text-[10px] font-mono bg-primary/15 hover:bg-primary/25 text-primary rounded"
                  >
                    应用
                  </button>
                </div>
              </div>
            </MountTransition>
          </div>

          {/* 2D / 3D 渲染模式 + 设备选择 — DOM 下拉框 (与协同副模型同款 framer-motion 动画) */}
          <div
            ref={deviceBtnRef}
            className={`relative ${showDeviceDropdown ? 'z-50' : ''}`}
            data-device-btn
          >
            <div className="flex items-center rounded-md overflow-hidden border border-[var(--color-outline)]/30">
              <button
                onClick={() => {
                  setRenderMode('2D');
                  toggleDeviceDropdown();
                }}
                className={`flex items-center gap-1 px-2 py-1 text-[10px] font-mono font-semibold transition-colors ${
                  renderMode === '2D'
                    ? 'bg-[var(--color-primary)]/15 text-[var(--color-primary)]'
                    : 'bg-[var(--color-surface-bright)]/60 text-[var(--color-on-surface)]/50 hover:text-[var(--color-on-surface)]'
                }`}
                title="2D 模式 — 点击选择设备"
              >
                <SquareIcon className="w-3 h-3" />
                <span>2D</span>
              </button>
              <button
                onClick={() => {
                  setRenderMode('3D');
                  toggleDeviceDropdown();
                }}
                className={`flex items-center gap-1 px-2 py-1 text-[10px] font-mono font-semibold transition-colors border-l border-[var(--color-outline)]/30 ${
                  renderMode === '3D'
                    ? 'bg-[var(--color-primary)]/15 text-[var(--color-primary)]'
                    : 'bg-[var(--color-surface-bright)]/60 text-[var(--color-on-surface)]/50 hover:text-[var(--color-on-surface)]'
                }`}
                title="3D 模式 — 点击选择设备"
              >
                <Box className="w-3 h-3" />
                <span>3D</span>
              </button>
              <motion.button
                onClick={toggleDeviceDropdown}
                whileTap={{ scale: 0.94 }}
                transition={{ type: 'spring', stiffness: 600, damping: 28 }}
                className={`flex items-center px-1.5 py-1 text-[10px] font-mono transition-colors border-l border-[var(--color-outline)]/30 ${
                  showDeviceDropdown
                    ? 'bg-[var(--color-primary)]/15 text-[var(--color-primary)]'
                    : 'bg-[var(--color-surface-bright)]/60 text-[var(--color-on-surface)]/70 hover:text-[var(--color-on-surface)]'
                }`}
                title="选择设备"
              >
                <motion.span
                  aria-hidden="true"
                  initial={false}
                  animate={{ rotate: showDeviceDropdown ? 180 : 0 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                  className="flex items-center justify-center"
                >
                  <ChevronDown className="w-2.5 h-2.5" />
                </motion.span>
              </motion.button>
            </div>

            {/* 设备下拉框 — framer-motion clip-path ellipse 扩散动画 (与协同副模型一致) */}
            <AnimatePresence>
              {showDeviceDropdown && (
                <>
                  {/* 半透明 backdrop: 承载 click-outside + 遮暗背景让 panel 更突出 */}
                  <motion.div
                    key="device-backdrop"
                    variants={deviceBackdropVariants}
                    initial="hidden"
                    animate="visible"
                    exit="hidden"
                    className="fixed inset-0 z-40 cursor-default bg-black/20"
                    onClick={() => setShowDeviceDropdown(false)}
                  />

                  {/* 椭圆弹出面板 — fixed 定位避免被祖先 overflow-hidden 裁剪 */}
                  <motion.div
                    key="device-panel"
                    ref={devicePanelRef}
                    variants={devicePanelVariants}
                    initial="hidden"
                    animate="visible"
                    exit="hidden"
                    style={{
                      position: 'fixed',
                      top: `${devicePanelPos.top}px`,
                      right: `${devicePanelPos.right}px`,
                      transformOrigin: '50% 0%',
                      willChange: 'clip-path, transform, opacity',
                      transform: 'translateZ(0)',
                      backfaceVisibility: 'hidden',
                      WebkitBackfaceVisibility: 'hidden',
                      // ★ 强制不透明背景, 避免被 Flutter HWND 盖住时透出底层内容
                      backgroundColor: 'var(--color-surface)',
                    }}
                    className="w-80 bg-[var(--color-surface)] border border-[var(--color-outline)]/45 rounded-2xl shadow-[0_24px_64px_rgba(0,0,0,0.15)] p-4 flex flex-col font-sans z-50 text-left cursor-default max-h-[500px]"
                    role="dialog"
                    aria-label="设备选择"
                  >
                    {/* 标题栏 */}
                    <motion.div
                      variants={deviceContentVariants}
                      className="flex items-center justify-between border-b border-[var(--color-outline)]/20 pb-2.5 mb-3"
                    >
                      <div className="text-[10px] bg-[var(--color-primary)]/10 border border-[var(--color-primary)]/25 text-[var(--color-primary)] px-2.5 py-0.5 rounded-full font-mono font-bold leading-none">
                        {renderMode} · {activeDeviceList.length} 款设备
                      </div>
                      {activePreset && activePreset.w > 0 && (
                        <div className="text-[10px] text-[var(--color-on-surface)]/50 font-mono truncate ml-2">
                          当前: {activePreset.label}
                        </div>
                      )}
                    </motion.div>

                    {/* 无设备约束 */}
                    <motion.div variants={deviceContentVariants} className="mb-2.5">
                      <button
                        onClick={() => { handleSelectSizeKey('none'); setShowDeviceDropdown(false); }}
                        className={`flex items-center gap-2 w-full px-2.5 py-1.5 rounded-xl text-[10px] font-mono font-semibold transition-all duration-200 ${
                          activeSizeKey === 'none'
                            ? 'bg-[var(--color-primary)]/15 text-[var(--color-primary)] border border-[var(--color-primary)]/40'
                            : 'text-[var(--color-on-surface)]/70 hover:bg-[var(--color-surface-bright)]/60 border border-transparent'
                        }`}
                      >
                        <Maximize2 className="w-3 h-3 shrink-0" />
                        <span className="flex-1 text-left">无设备约束</span>
                        {activeSizeKey === 'none' && <Check className="w-2.5 h-2.5 shrink-0" />}
                      </button>
                    </motion.div>

                    {/* 设备分组列表 */}
                    <motion.div
                      variants={deviceContentVariants}
                      className="flex flex-col gap-2.5 overflow-y-auto max-h-[320px] pr-1 scrollbar-thin"
                    >
                      {(['mobile', 'tablet', 'desktop', 'watch'] as SizeGroup[]).map(group => {
                        const presets = activeDeviceList.filter(p => p.group === group);
                        if (presets.length === 0) return null;
                        return (
                          <div key={group} className="flex flex-col gap-1.5">
                            <div className="text-[9px] font-mono font-bold uppercase tracking-widest text-[var(--color-on-surface)]/40 px-1 leading-none">
                              {presets[0].groupLabel}
                            </div>
                            {presets.map(p => {
                              const Icon = p.icon;
                              const active = p.key === activeSizeKey;
                              return (
                                <button
                                  key={p.key}
                                  onClick={() => {
                                    handleSelectSizeKey(p.key);
                                    setShowDeviceDropdown(false);
                                  }}
                                  className={`group/item flex items-center gap-2 w-full px-2.5 py-1.5 rounded-xl text-[10px] font-mono font-semibold transition-all duration-200 border ${
                                    active
                                      ? 'bg-[var(--color-primary)]/15 text-[var(--color-primary)] border-[var(--color-primary)]/40'
                                      : 'text-[var(--color-on-surface)]/80 hover:bg-[var(--color-surface-bright)]/60 hover:text-[var(--color-primary)] border-[var(--color-outline)]/20 hover:border-[var(--color-primary)]/30'
                                  }`}
                                >
                                  <Icon className="w-3 h-3 shrink-0" />
                                  <span className="flex-1 text-left truncate">{p.label}</span>
                                  <span className="text-[var(--color-on-surface)]/40 text-[9px]">{p.w}×{p.h}</span>
                                  {active && <Check className="w-2.5 h-2.5 shrink-0" />}
                                </button>
                              );
                            })}
                          </div>
                        );
                      })}
                      {activeDeviceList.length === 0 && (
                        <div className="text-center py-5 text-[var(--color-on-surface)]/40 text-[11px] leading-relaxed border border-dashed border-[var(--color-outline)]/30 rounded-xl bg-[var(--color-surface-bright)]/40 select-none font-sans">
                          当前模式暂无可用设备
                        </div>
                      )}
                    </motion.div>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>

          {canvasError && (
            <span
              className="flex-1 text-[10px] text-red-400 font-mono min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
              title={canvasError}
            >
              {canvasError}
            </span>
          )}
        </div>
        )}

        {/* CANVAS AREA — 整个剩余空间都是画布区 */}
        <div ref={canvasAreaRef} className="flex-1 relative overflow-hidden flex items-center justify-center">
          {noCanvas ? renderStandby() : (
            <div
              className="relative flex items-center justify-center"
              style={(() => {
                // ★ 设备尺寸约束: 选中具体设备时, 画布区域被限制在设备尺寸内
                if (activePreset && activePreset.w > 0 && activePreset.h > 0) {
                  // 计算缩放比例, 让设备框架适配可用空间
                  const parentEl = containerRef.current;
                  const availW = parentEl ? parentEl.clientWidth - 48 : 360;
                  const availH = parentEl ? parentEl.clientHeight - 120 : 600;
                  const scale = Math.min(availW / activePreset.w, availH / activePreset.h, 1);
                  const scaledW = Math.round(activePreset.w * scale);
                  const scaledH = Math.round(activePreset.h * scale);
                  return {
                    width: `${scaledW}px`,
                    height: `${scaledH}px`,
                    overflow: 'hidden',
                    transition: 'all 250ms cubic-bezier(0.16, 1, 0.3, 1)',
                  } as React.CSSProperties;
                }
                return { width: '100%', height: '100%' } as React.CSSProperties;
              })()}
            >
              {renderPlaceholder()}
              {/* 2D 设备 PNG 边框图片 — 覆盖在内容上方 */}
              {renderMode === '2D' && activePreset?.pngFile && (
                <img
                  src={`/canvas/models/2d/${activePreset.pngFile}`}
                  alt={activePreset.label}
                  className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                  style={{ zIndex: 10 }}
                />
              )}
              {/* 设备尺寸标签 */}
              {activePreset && activePreset.w > 0 && (
                <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-[9px] font-mono text-on-surface/40 whitespace-nowrap pointer-events-none">
                  {activePreset.label} · {activePreset.w}×{activePreset.h}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// 根据背景色自动选前景色（深底浅字 / 浅底深字）
function pickFg(bg: string): string {
  const hex = bg.replace('#', '');
  if (hex.length !== 6) return '#1f2937';
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  // YIQ 亮度
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 140 ? '#1f2937' : '#f3f4f6';
}
