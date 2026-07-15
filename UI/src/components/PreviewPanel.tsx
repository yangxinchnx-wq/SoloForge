/**
 * PreviewPanel.tsx — 画布预览面板
 *
 * ★ 2026-07-16: 画布重构中 — 旧版 Flutter IPC + 设备选择 + 3D 渲染代码已全部注释掉
 *   恢复方法: git checkout HEAD -- UI/src/components/PreviewPanel.tsx
 *   或查看本文件底部 OLD CODE 注释块
 *
 * 当前状态: 仅保留面板容器 + CanvasResourceBar（画布选项卡）+ 占位提示
 */

import React from 'react';
import { CanvasResourceBar } from './CanvasResourceBar';
import { usePreviewStreamStore } from '../state/previewStreamStore';
import type { CanvasResource } from '../services/canvas/sessionApi';

// ★ 以下 import 已注释掉 — 画布重构期间不需要
// import { motion, AnimatePresence } from 'framer-motion';
// import {
//   RefreshCw, Play, Square, Loader2,
//   AlertCircle, Monitor, Smartphone, Tablet, Watch,
//   Palette, MonitorSmartphone, Info, ChevronDown, Check, Maximize2,
//   Code2
// } from '../utils/icons';
// import { useCanvasDeviceStore, type CanvasDeviceInfo } from '../state/canvasDeviceStore';
// import { MountTransition } from './MountTransition';
// import { restoreDslFromHotStore, restoreDslFromChatHistory } from '../state/previewStreamStore';
// import WebAstPreview from './WebAstPreview';
// import { scaleDsl } from '../services/canvas/scaleDsl';
// import {
//   selectModel as apiSelectModel,
//   deleteCanvas as apiDeleteCanvas,
// } from '../services/canvas/sessionApi';
// import { setCanvasSessionId, clearCanvasSessionId, clearByCanvasSessionId } from '../services/incrementalCanvasPusher';
// import { useLayoutMeta } from '../context/LayoutContext';

interface PreviewPanelProps {
  width?: number;
  isResizing?: boolean;
  dragStartWidth?: number;
  selectedChatId?: string;
  canvasId?: string | null;
  canvasReady?: boolean;
  canvases?: CanvasResource[];
  maxCanvases?: number;
  onSelectCanvas?: (canvasId: string) => void;
  onCreateCanvas?: () => Promise<string | null>;
  onRenameCanvas?: (canvasId: string, description: string) => Promise<boolean>;
  onDeleteCanvas?: (canvasId: string) => Promise<boolean>;
}

export default function PreviewPanel({
  width = 472,
  isResizing = false,
  canvases = [],
  maxCanvases = 10,
  onSelectCanvas,
  onRenameCanvas,
}: PreviewPanelProps) {
  // ★ 画布重构占位 — 仅保留面板容器 + 选项卡 + 占位提示
  return (
    <div
      style={{
        width: `${width}px`,
        transition: isResizing ? 'none' : 'width 250ms cubic-bezier(0.16, 1, 0.3, 1)'
      }}
      className="h-full bg-surface border-l border-outline/50 flex flex-col shrink-0 select-none z-10 overflow-hidden relative"
    >
      {/* 画布选项卡 — 用户明确要求保留 */}
      {onSelectCanvas && onRenameCanvas && (
        <CanvasResourceBar
          canvases={canvases}
          activeCanvasId={null}
          maxCanvases={maxCanvases}
          onSelect={onSelectCanvas}
          onRename={onRenameCanvas}
        />
      )}

      {/* 画布重构占位区 */}
      <div className="flex-1 relative overflow-hidden flex items-center justify-center p-3">
        <div className="flex flex-col items-center justify-center select-none">
          <div
            className="w-16 h-16 opacity-30 mb-4"
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
          <div className="text-[11px] font-mono text-on-surface/40">
            画布重构中…
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// OLD CODE — 画布重构期间注释掉, 恢复方法:
//   git checkout HEAD -- UI/src/components/PreviewPanel.tsx
//
// 以下为旧版 PreviewPanel 的完整实现 (Flutter IPC + 2D/3D 设备选择 + 崩溃检测等)
// 已全部注释掉, 不参与编译
// ═══════════════════════════════════════════════════════════════

/* OLD CODE START — see git history for full implementation
*
* // ── 设备下拉框动画 variants ──
* const devicePanelVariants = { ... };
* const deviceContentVariants = { ... };
* const deviceBackdropVariants = { ... };
*
* type CanvasState = 'idle' | 'starting' | 'running' | 'error';
* const isElectron = () => typeof window !== 'undefined' && !!window.soloforge;
*
* // 预设底色
* const BG_PRESETS = [ ... ];
*
* // 2D/3D 设备列表
* const DEVICES_2D: DevicePreset[] = [ ... ];
* const DEVICES_3D: DevicePreset[] = [ ... ];
*
* // 完整组件实现:
* // - canvasState / canvasError / canvasInfo 状态管理
* // - DSL 恢复链路 (GarnetStore → 聊天历史降级)
* // - handleSelectDevice / handleSelectSizeKey (IPC selectDevice)
* // - toggleDeviceDropdown (BrowserWindow 弹窗)
* // - onDeviceSelected 监听 (IPC 回调)
* // - canvasAreaSize ResizeObserver
* // - 自动启动画布 useEffect
* // - 崩溃检测 onExited useEffect
* // - sessionIdRef 同步 useLayoutEffect
* // - reportBounds useEffect
* // - 卸载时 stop useEffect
* // - pushBackground / startCanvas / stopCanvas
* // - handlePickColor / handlePickCustom
* // - handleDeleteCanvas
* // - renderStandby / renderPlaceholder
* // - 完整 JSX: 工具栏 + 底色选择器 + 2D/3D 切换 + 画布区域 + PNG 边框
*
* OLD CODE END */
