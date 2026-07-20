/**
 * PreviewPanel.tsx — 画布预览面板（2026-07-16 重构版）
 *
 * ★ 2026-07-16: 画布重构完成 — 用 CanvasStage 替代旧版 Flutter IPC 渲染层
 *   - 2D 模式：WebAstPreview + PNG 设备边框
 *   - 3D 模式：CanvasStage3D + GLB 模型 + RTT 贴图
 *   - 设备选择 + 2D/3D 切换 + 底色选择
 *
 * 旧版 Flutter IPC 代码已废弃，如需恢复查看 git 历史
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CanvasResourceBar } from './CanvasResourceBar';
import CanvasStage from './CanvasStage';
import { usePreviewStreamStore } from '../state/previewStreamStore';
import { useCanvasDeviceStore, type CanvasDeviceInfo } from '../state/canvasDeviceStore';
import { MODEL_THEMES, MATERIAL_FINISHES, type ThemeId, type MaterialFinish } from '../services/canvas/modelThemes';
import type { UniversalNode } from '../services/canvas/UniversalAST';
import { ChevronDown, Check } from '../utils/icons';
import { useAppStore } from '../state/appStore';
import { useRenderTrace } from '../hooks/useRenderTrace';
import { useChatClickCanvasBridge } from '../hooks/useChatClickCanvasBridge';
import { useLayoutState, useLayoutStatus } from '../context/LayoutContext';

// ── 设备预设 ──

interface DevicePreset {
  sizeKey: string;
  label: string;
  width: number;
  height: number;
  group: 'desktop' | 'mobile' | 'tablet' | 'watch';
  pngFile?: string;
  glbFile?: string;
}

// 2D 设备（带 PNG 边框）—— ★ 2026-07-16: 文件名与 resources/canvas/models/2d/ 实际文件对齐
const DEVICES_2D: DevicePreset[] = [
  { sizeKey: 'default', label: '默认尺寸', width: 0, height: 0, group: 'desktop' },
  { sizeKey: 'iphone-16-pro-max', label: 'iPhone 16 Pro Max', width: 430, height: 932, group: 'mobile', pngFile: 'mobile/iphone_16_pro_max.png' },
  { sizeKey: 'iphone-16-pro', label: 'iPhone 16 Pro', width: 402, height: 874, group: 'mobile', pngFile: 'mobile/iphone_16_pro.png' },
  { sizeKey: 'iphone-16', label: 'iPhone 16', width: 390, height: 844, group: 'mobile', pngFile: 'mobile/iphone_16.png' },
  { sizeKey: 'ipad-a16', label: 'iPad A16', width: 820, height: 1180, group: 'tablet', pngFile: 'tablet/ipad_a16.png' },
  { sizeKey: 'macbook-pro-14', label: 'MacBook Pro 14"', width: 1512, height: 982, group: 'desktop', pngFile: 'desktop/macbook_pro_m5_14.png' },
  { sizeKey: 'apple-watch-ultra', label: 'Apple Watch Ultra', width: 502, height: 410, group: 'watch', pngFile: 'watch/apple_watch_ultra_2.png' },
];

// 3D 设备（带 GLB 模型，仅 iphone_15_pro_max 有 screen 命名可直接 RTT）
const DEVICES_3D: DevicePreset[] = [
  { sizeKey: 'default', label: '默认尺寸', width: 0, height: 0, group: 'desktop' },
  { sizeKey: 'iphone-15-pro-max', label: 'iPhone 15 Pro Max', width: 430, height: 932, group: 'mobile', glbFile: 'mobile/iphone_15_pro_max.glb' },
];

// ── 底色预设 ──
const BG_PRESETS = [
  { label: '白', color: '#ffffff' },
  { label: '黑', color: '#1a1a1a' },
  { label: '灰', color: '#f5f5f7' },
  { label: '蓝', color: '#0a1929' },
];

// ── iOS 风格 Toggle ──
function IosToggle({ on, onChange, labels }: { on: boolean; onChange: (v: boolean) => void; labels: [string, string] }) {
  return (
    <div
      onClick={() => {
        console.log('[IosToggle] onClick fired, current on=', on, '→ calling onChange(!on)');
        onChange(!on);
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        cursor: 'pointer',
        userSelect: 'none',
        background: 'var(--color-surface-variant, rgba(0,0,0,0.06))',
        borderRadius: '16px',
        padding: '2px',
        transition: 'background 200ms ease',
      }}
    >
      <motion.div
        animate={{ left: on ? 'calc(50% + 2px)' : '2px' }}
        transition={{ type: 'spring', stiffness: 500, damping: 32, mass: 0.6 }}
        style={{
          position: 'absolute',
          width: 'calc(50% - 2px)',
          height: '28px',
          top: '2px',
          background: 'var(--color-surface, #fff)',
          borderRadius: '14px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.12), 0 1px 1px rgba(0,0,0,0.08)',
        }}
      />
      <span style={{
        position: 'relative',
        flex: 1,
        textAlign: 'center',
        fontSize: '11px',
        fontWeight: 500,
        padding: '6px 12px',
        color: on ? 'var(--color-on-surface-variant, #666)' : 'var(--color-on-surface, #000)',
        transition: 'color 200ms ease',
      }}>{labels[0]}</span>
      <span style={{
        position: 'relative',
        flex: 1,
        textAlign: 'center',
        fontSize: '11px',
        fontWeight: 500,
        padding: '6px 12px',
        color: on ? 'var(--color-on-surface, #fff)' : 'var(--color-on-surface-variant, #666)',
        transition: 'color 200ms ease',
      }}>{labels[1]}</span>
    </div>
  );
}

// ── 设备选择下拉框（与 MainModelSelector 风格统一） ──
function DeviceDropdown({
  devices,
  current,
  onSelect,
}: {
  devices: DevicePreset[];
  current: DevicePreset | null;
  onSelect: (d: DevicePreset) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => {
          console.log('[DeviceDropdown] button onClick, open=', open, '→ setOpen=', !open);
          setOpen(!open);
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '6px 10px',
          fontSize: '12px',
          color: 'var(--color-on-surface)',
          background: 'transparent',
          border: '1px solid var(--color-outline, rgba(0,0,0,0.1))',
          borderRadius: '8px',
          cursor: 'pointer',
          fontFamily: 'inherit',
          position: 'relative',
          zIndex: 101,
        }}
      >
        {current?.label || '选择设备'}
        <ChevronDown className="w-3 h-3 opacity-90" />
      </button>

      <AnimatePresence>
        {open && (
          <>
            {/* 透明遮罩，点击关闭 */}
            <motion.div
              variants={{ hidden: { opacity: 0 }, visible: { opacity: 1 } }}
              initial="hidden"
              animate="visible"
              exit="hidden"
              transition={{ duration: 0.18 }}
              style={{ position: 'fixed', inset: 0, zIndex: 99 }}
              onClick={() => setOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, y: -4 }}
              transition={{ type: 'spring', stiffness: 400, damping: 28, mass: 0.7 }}
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                left: 0,
                minWidth: '180px',
                background: 'var(--color-surface, #fff)',
                border: '1px solid var(--color-outline, rgba(0,0,0,0.1))',
                borderRadius: '10px',
                boxShadow: '0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.08)',
                padding: '4px',
                zIndex: 100,
                overflow: 'hidden',
              }}
            >
              {devices.map((d) => (
                <button
                  key={d.sizeKey}
                  onClick={() => { onSelect(d); setOpen(false); }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    width: '100%',
                    padding: '8px 10px',
                    fontSize: '12px',
                    color: 'var(--color-on-surface)',
                    background: 'transparent',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    textAlign: 'left',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-variant, rgba(0,0,0,0.04))'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <span>{d.label}</span>
                  {current?.sizeKey === d.sizeKey && <Check className="w-3.5 h-3.5 opacity-100" />}
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── 3D 模型主题右键弹出框 (顶部材质切换 + 下方颜色列表) ──
function ThemeContextMenu({
  themes,
  currentTheme,
  onSelectTheme,
  finishes,
  currentFinish,
  onSelectFinish,
  position,
  onClose,
}: {
  themes: { id: ThemeId; label: string; swatch: string }[];
  currentTheme: ThemeId;
  onSelectTheme: (id: ThemeId) => void;
  finishes: { id: MaterialFinish; label: string }[];
  currentFinish: MaterialFinish;
  onSelectFinish: (id: MaterialFinish) => void;
  position: { x: number; y: number };
  onClose: () => void;
}) {
  // 防止菜单溢出视口
  const adjustedX = Math.min(position.x, window.innerWidth - 180);
  const adjustedY = Math.min(position.y, window.innerHeight - 400);
  // 当前颜色名
  const currentThemeLabel = themes.find((t) => t.id === currentTheme)?.label ?? '';

  return (
    <>
      {/* 透明遮罩 — 点击/右键关闭 */}
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.92 }}
        transition={{ type: 'spring', stiffness: 400, damping: 28, mass: 0.7 }}
        style={{
          position: 'fixed',
          left: adjustedX,
          top: adjustedY,
          minWidth: '160px',
          background: 'var(--color-surface, #fff)',
          border: '1px solid var(--color-outline, rgba(0,0,0,0.1))',
          borderRadius: '10px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.08)',
          padding: '6px',
          zIndex: 9999,
          overflow: 'hidden',
        }}
      >
        {/* ★ 顶部: 当前颜色名 + 材质切换按钮组 */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '6px 8px 8px',
          borderBottom: '1px solid var(--color-outline, rgba(0,0,0,0.08))',
          marginBottom: '4px',
        }}>
          <span style={{
            fontSize: '11px',
            fontWeight: 600,
            color: 'var(--color-on-surface)',
            flexShrink: 0,
          }}>
            {currentThemeLabel}
          </span>
          {/* 材质切换按钮组 */}
          <div style={{
            display: 'flex',
            gap: '2px',
            marginLeft: 'auto',
            background: 'var(--color-surface-variant, rgba(0,0,0,0.04))',
            borderRadius: '6px',
            padding: '2px',
          }}>
            {finishes.map((f) => (
              <button
                key={f.id}
                onClick={() => onSelectFinish(f.id)}
                style={{
                  padding: '3px 8px',
                  fontSize: '10px',
                  fontWeight: 500,
                  color: currentFinish === f.id
                    ? 'var(--color-on-surface, #000)'
                    : 'var(--color-on-surface-variant, #999)',
                  background: currentFinish === f.id
                    ? 'var(--color-surface, #fff)'
                    : 'transparent',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  boxShadow: currentFinish === f.id
                    ? '0 1px 2px rgba(0,0,0,0.1)'
                    : 'none',
                  transition: 'all 150ms ease',
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* 下方: 颜色主题列表 */}
        {themes.map((t) => (
          <button
            key={t.id}
            onClick={() => { onSelectTheme(t.id); onClose(); }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              padding: '7px 8px',
              fontSize: '12px',
              color: 'var(--color-on-surface)',
              background: currentTheme === t.id ? 'var(--color-surface-variant, rgba(0,0,0,0.04))' : 'transparent',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              textAlign: 'left',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-variant, rgba(0,0,0,0.06))'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = currentTheme === t.id ? 'var(--color-surface-variant, rgba(0,0,0,0.04))' : 'transparent'; }}
          >
            <span
              style={{
                width: '14px',
                height: '14px',
                borderRadius: '50%',
                background: t.swatch,
                border: '1px solid rgba(0,0,0,0.15)',
                flexShrink: 0,
              }}
            />
            <span style={{ flex: 1 }}>{t.label}</span>
            {currentTheme === t.id && <Check className="w-3.5 h-3.5 opacity-100" />}
          </button>
        ))}
      </motion.div>
    </>
  );
}

// ── 主组件 ──

export default function PreviewPanel() {
  // ★ 调试: 渲染追踪
  useRenderTrace('PreviewPanel');
  // ★ 自包含化: 从 store/LayoutContext/hook 直接读取, 切断 MainLayout props 透传链
  //   原 11 个 props (width/isResizing/dragStartWidth/selectedChatId/canvasId/canvasReady/
  //   canvases/maxCanvases/onSelectCanvas/onCreateCanvas/onRenameCanvas) 全部改由内部订阅
  const selectedChatId = useAppStore(s => s.selectedChatId);
  const { previewWidth } = useLayoutState();
  const { isResizingPreview } = useLayoutStatus();
  const width = previewWidth ?? 472;
  const isResizing = !!isResizingPreview;

  const bridge = useChatClickCanvasBridge({
    chatId: selectedChatId,
    allowCreate: false,
    defaultDescription: '默认画布',
  });
  const canvasId = bridge.canvasId;
  const canvases = bridge.canvases;
  const maxCanvases = bridge.maxCanvases;
  const onSelectCanvas = bridge.selectCanvas;
  const onRenameCanvas = bridge.renameCanvas;

  // ── 从 store 读取 DSL 和设备状态 ──
  const entry = usePreviewStreamStore((s) => (selectedChatId ? s.entries[selectedChatId] : undefined));
  // ★ 修复 2026-07-17: canvasId 为 null 时用虚拟 key '__ephemeral__' 存 device,
  //   这样无选中画布时也能切换 2D/3D 和选择设备 (修复 "点击 3D 毫无反应" bug)
  const deviceKey = canvasId ?? '__ephemeral__';
  const device = useCanvasDeviceStore((s) => s.devices[deviceKey] ?? null);
  const renderMode = useCanvasDeviceStore((s) => s.renderMode);
  const modelTheme = useCanvasDeviceStore((s) => s.modelTheme);
  const modelFinish = useCanvasDeviceStore((s) => s.modelFinish);
  const setDevice = useCanvasDeviceStore((s) => s.setDevice);
  const setRenderMode = useCanvasDeviceStore((s) => s.setRenderMode);
  const setModelTheme = useCanvasDeviceStore((s) => s.setModelTheme);
  const setModelFinish = useCanvasDeviceStore((s) => s.setModelFinish);

  const [bgColor, setBgColor] = useState('#ffffff');
  // ★ 右键主题菜单状态 (仅 3D 模式)
  const [themeMenu, setThemeMenu] = useState<{ x: number; y: number } | null>(null);

  // ★ 修复 2026-07-19: 新对话切换时清除 '__ephemeral__' 残留设备
  //   __ephemeral__ 是 canvasId 为 null 时的临时 key (如新建对话的过渡期)。
  //   如果不清除, 上一次对话在过渡期选的设备会被新对话继承 → “随机设备” bug。
  useEffect(() => {
    useCanvasDeviceStore.getState().setDevice('__ephemeral__', null);
  }, [selectedChatId]);

  // ★ 修复 2026-07-19: 验证持久化的设备是否仍然有效
  //   场景: 用户之前选过 iphone-11-pro-max, 该设备被删除后 localStorage 中仍保存旧选择
  //   恢复时 device.glbFile 指向已删除的文件 → useGLTF 加载失败报错
  //   解决: 检查 device.sizeKey 是否在当前设备列表中, 无效则自动回退
  useEffect(() => {
    if (!device) return;
    const list = renderMode === '3D' ? DEVICES_3D : DEVICES_2D;
    const isValid = list.some((d) => d.sizeKey === device.sizeKey);
    if (!isValid) {
      // ★ fallback 到第一个真实设备 (跳过 'default'); 如果没有真实设备则清空
      const firstReal = list.find((d) => d.sizeKey !== 'default');
      if (firstReal) {
        console.log('[PreviewPanel] device invalid (removed?), auto-fallback:', device.sizeKey, '→', firstReal.sizeKey);
        setDevice(deviceKey, {
          sizeKey: firstReal.sizeKey,
          label: firstReal.label,
          width: firstReal.width,
          height: firstReal.height,
          group: firstReal.group,
          renderMode,
          pngFile: firstReal.pngFile,
          glbFile: firstReal.glbFile,
        });
      } else {
        setDevice(deviceKey, null);
      }
    }
  }, [device, renderMode, deviceKey, setDevice]);

  // DSL 来源：previewStreamStore → 兜底空节点
  const dsl: UniversalNode = useMemo(() => {
    return entry?.ast ?? { type: 'container', children: [] };
  }, [entry?.ast]);

  // ── 设备选择处理 ──
  const handleSelectDevice = useCallback((preset: DevicePreset) => {
    // ★ “默认尺寸” = 清除设备约束，使用当前画布区域
    if (preset.sizeKey === 'default') {
      setDevice(deviceKey, null);
      return;
    }
    const info: CanvasDeviceInfo = {
      sizeKey: preset.sizeKey,
      label: preset.label,
      width: preset.width,
      height: preset.height,
      group: preset.group,
      renderMode,
      pngFile: preset.pngFile,
      glbFile: preset.glbFile,
    };
    setDevice(deviceKey, info);
  }, [deviceKey, renderMode, setDevice]);

  // 当前设备预设（从 store 的 device 反查；device 为 null 时返回“默认尺寸”）
  const currentPreset = useMemo(() => {
    if (!device) return DEVICES_2D[0]; // 'default'
    const list = renderMode === '3D' ? DEVICES_3D : DEVICES_2D;
    return list.find((d) => d.sizeKey === device.sizeKey) ?? null;
  }, [device, renderMode]);

  // 当前模式的设备列表
  const deviceList = renderMode === '3D' ? DEVICES_3D : DEVICES_2D;

  // ── 2D/3D 切换 ──
  const handleToggleMode = useCallback((is3D: boolean) => {
    console.log('[handleToggleMode] called, is3D=', is3D, 'deviceKey=', deviceKey, 'current device=', device);
    const mode = is3D ? '3D' : '2D';
    setRenderMode(mode);
    const list = is3D ? DEVICES_3D : DEVICES_2D;
    const matching = list.find((d) => d.sizeKey === device?.sizeKey);
    console.log('[handleToggleMode] matching=', matching ?? 'NONE', 'list.length=', list.length);
    if (!matching) {
      // ★ 修复 3: 当前设备在新模式下不存在，自动选第一个兼容设备（而非清除）
      // ★ fallback 到第一个真实设备 (跳过 'default')
      const firstReal = list.find((d) => d.sizeKey !== 'default');
      if (firstReal) {
        console.log('[handleToggleMode] setting device=', firstReal.label, 'mode=', mode);
        setDevice(deviceKey, {
          sizeKey: firstReal.sizeKey,
          label: firstReal.label,
          width: firstReal.width,
          height: firstReal.height,
          group: firstReal.group,
          renderMode: mode,
          pngFile: firstReal.pngFile,
          glbFile: firstReal.glbFile,
        });
      } else {
        setDevice(deviceKey, null);
      }
    } else if (device) {
      console.log('[handleToggleMode] updating existing device renderMode=', mode);
      setDevice(deviceKey, {
        ...device,
        renderMode: mode,
        pngFile: matching.pngFile,
        glbFile: matching.glbFile,
      });
    }
  }, [deviceKey, device, setRenderMode, setDevice]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    // 仅 3D 模式拦截右键 → 弹出主题选择菜单
    if (renderMode !== '3D') return;
    e.preventDefault();
    setThemeMenu({ x: e.clientX, y: e.clientY });
  }, [renderMode]);

  const hasDsl = entry?.ast != null;

  return (
    <div
      style={{
        width: `${width}px`,
        transition: isResizing ? 'none' : 'width 250ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}
      className="h-full bg-surface border-l border-outline/50 flex flex-col shrink-0 select-none z-10 overflow-hidden relative"
    >
      {/* 画布选项卡 */}
      {onSelectCanvas && onRenameCanvas && (
        <CanvasResourceBar
          canvases={canvases}
          activeCanvasId={canvasId ?? null}
          maxCanvases={maxCanvases}
          onSelect={onSelectCanvas}
          onRename={onRenameCanvas}
        />
      )}

      {/* 工具栏 */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b border-outline/30"
        style={{ flexShrink: 0 }}
      >
        {/* 2D / 3D 切换 */}
        <div style={{ position: 'relative', width: '120px', height: '32px' }}>
          <IosToggle
            on={renderMode === '3D'}
            onChange={handleToggleMode}
            labels={['2D', '3D']}
          />
        </div>

        {/* 设备选择 */}
        <DeviceDropdown
          devices={deviceList}
          current={currentPreset}
          onSelect={handleSelectDevice}
        />

        {/* 主题选择已移至画布右键菜单 */}

        {/* 底色选择 */}
        <div style={{ display: 'flex', gap: '4px', marginLeft: 'auto' }}>
          {BG_PRESETS.map((preset) => (
            <button
              key={preset.color}
              onClick={() => setBgColor(preset.color)}
              title={preset.label}
              style={{
                width: '18px',
                height: '18px',
                borderRadius: '50%',
                background: preset.color,
                border: bgColor === preset.color
                  ? '2px solid var(--color-primary)'
                  : '1px solid var(--color-outline, rgba(0,0,0,0.15))',
                cursor: 'pointer',
                padding: 0,
                transition: 'border 150ms ease',
              }}
            />
          ))}
        </div>
      </div>

      {/* 画布渲染区 — 3D 模式右键弹出主题菜单 */}
      <div
        className="flex-1 relative overflow-hidden"
        onContextMenu={handleContextMenu}
      >
        {hasDsl || device ? (
          <CanvasStage dsl={dsl} device={device} canvasId={canvasId ?? undefined} bgColor={bgColor} theme={modelTheme} finish={modelFinish} />
        ) : (
          // 无 DSL 且无设备时的占位
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex flex-col items-center justify-center select-none">
              <div
                className="w-16 h-16 opacity-70 mb-4"
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
                等待生成预览...
              </div>
            </div>
          </div>
        )}

        {/* 3D 模式右键主题菜单 (顶部材质切换 + 下方颜色列表) */}
        <AnimatePresence>
          {themeMenu && renderMode === '3D' && (
            <ThemeContextMenu
              themes={MODEL_THEMES}
              currentTheme={modelTheme}
              onSelectTheme={setModelTheme}
              finishes={MATERIAL_FINISHES}
              currentFinish={modelFinish}
              onSelectFinish={setModelFinish}
              position={themeMenu}
              onClose={() => setThemeMenu(null)}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
