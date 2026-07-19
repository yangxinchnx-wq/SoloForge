/**
 * CanvasStage.tsx — 画布渲染舞台
 *
 * 整合 2D (WebAstPreview + PNG 边框) 和 3D (CanvasStage3D + GLB 模型) 两种渲染模式。
 * 根据 canvasDeviceStore 中的 renderMode 和设备信息自动切换。
 *
 * ★ 2026-07-20 丝滑切换重构:
 *   - 2D↔3D 模式切换: framer-motion AnimatePresence mode="wait" 交叉淡入淡出
 *   - 2D PNG 边框切换: AnimatePresence crossfade (旧边框淡出 + 新边框淡入)
 *   - 设备尺寸变化: CSS transition 让 width/height/borderRadius 平滑变化
 *   - DSL 层切换: framer-motion 淡入 (替代旧 anime.js opacity [0.3→1] 跳变)
 *   - 3D 模型加载: anime.js 容器淡入 (加载完成后 opacity 0→1)
 *
 * 工作模式：
 *   - 2D 模式：WebAstPreview 直接渲染 DOM，可选 PNG 设备边框 overlay
 *   - 3D 模式：CanvasStage3D 用 R3F 渲染 GLB 模型 + Html transform
 *   - 无设备：纯 WebAstPreview 渲染（开发模式默认）
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { UniversalNode } from '../services/canvas/UniversalAST';
import { isContainerLike } from '../services/canvas/UniversalAST';
import { useCanvasDeviceStore, type CanvasDeviceInfo } from '../state/canvasDeviceStore';
import { play2DLayoutTransition } from '../services/canvas/canvasAnimations';
import { animate } from 'animejs';
import { getDefaultTheme, getDefaultFinish, type ThemeId, type MaterialFinish } from '../services/canvas/modelThemes';
import WebAstPreview from './WebAstPreview';

// 3D 模式按需加载（bundle 拆分，避免首屏加载 three.js）
const CanvasStage3D = React.lazy(() => import('./CanvasStage3D'));

// ── 设备 PNG 边框基础路径 ──
const PNG_BASE = '/canvas/models/2d';

/** 根据 device 信息推导 PNG 边框路径 */
function inferPngPath(device: CanvasDeviceInfo): string | null {
  if (device.pngFile) return `${PNG_BASE}/${device.pngFile}`;
  return null;
}

// ── 过渡动画参数 ──

/** 模式切换 (2D↔3D) 过渡参数 */
const MODE_TRANSITION = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.3, ease: [0.4, 0, 0.2, 1] as const },
};

/** PNG 边框 crossfade 参数 */
const PNG_TRANSITION = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.25, ease: [0.4, 0, 0.2, 1] as const },
};

/** DSL 层淡入参数 */
const DSL_TRANSITION = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1 },
  transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] as const },
};

// ── 2D 渲染：WebAstPreview + 可选 PNG 边框 ──

interface Stage2DProps {
  dsl: UniversalNode;
  device: CanvasDeviceInfo | null;
  bgColor: string;
  canvasId?: string;
}

function Stage2D({ dsl, device, bgColor, canvasId }: Stage2DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dslLayerRef = useRef<HTMLDivElement>(null);
  // ★ autoScale: 自动适配容器的缩放比例 (有设备时计算, 无设备时=1)
  // ★ userZoom: 用户滚轮手动缩放倍数 (相对于 autoScale, 默认1=不额外缩放)
  const [autoScale, setAutoScale] = useState(1);
  const [userZoom, setUserZoom] = useState(1);
  const setFrameSize = useCanvasDeviceStore((s) => s.setFrameSize);

  // ★ 检测 DSL 是否为空容器（容器类型且无子节点）
  //   非容器类型（text/button/image 等）自身就是内容，不算空
  const isEmptyDsl = isContainerLike(dsl) ? (!dsl.children || dsl.children.length === 0) : false;

  // ★ 最终缩放 = 自动适配 × 用户手动缩放
  const effectiveScale = autoScale * userZoom;

  // ★ anime.js: DSL 更新时 FLIP 布局过渡
  const prevDslRef = useRef<UniversalNode>(dsl);
  useEffect(() => {
    if (dslLayerRef.current && prevDslRef.current !== dsl) {
      prevDslRef.current = dsl;
      play2DLayoutTransition(dslLayerRef.current);
    }
  }, [dsl]);

  // ★ 修复 2: 计算缩放比例，让设备原生尺寸适配容器
  useEffect(() => {
    if (!device || !containerRef.current) {
      // 无设备时记录容器尺寸
      if (containerRef.current && canvasId) {
        const rect = containerRef.current.getBoundingClientRect();
        setFrameSize(canvasId, { width: rect.width, height: rect.height });
      }
      return;
    }

    const computeScale = () => {
      if (!containerRef.current || !device) return;
      const rect = containerRef.current.getBoundingClientRect();
      // 留 4px 边距给 PNG 边框
      const availableW = rect.width - 8;
      const availableH = rect.height - 8;
      const scaleX = availableW / device.width;
      const scaleY = availableH / device.height;
      const s = Math.min(scaleX, scaleY, 1); // 自动适配不放大，只缩小
      setAutoScale(s);
      // ★ 修复 5: 记录实际渲染帧尺寸（供 LLM prompt 注入）
      if (canvasId) {
        setFrameSize(canvasId, { width: device.width, height: device.height });
      }
    };

    computeScale();
    // 监听容器尺寸变化
    const resizeObserver = new ResizeObserver(computeScale);
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, [device, canvasId, setFrameSize]);

  // ★ 滚轮缩放: 上滚放大, 下滚缩小, 范围 0.3~3
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); // 阻止页面滚动
      const delta = -e.deltaY;
      const step = 0.1;
      setUserZoom((prev) => {
        const next = prev + (delta > 0 ? step : -step);
        return Math.min(3, Math.max(0.3, Math.round(next * 100) / 100));
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ★ 双击重置缩放到 100%
  const handleDoubleClick = useCallback(() => {
    setUserZoom(1);
  }, []);

  // ★ 设备尺寸 + 缩放 — 加 CSS transition 让尺寸变化平滑
  const stageStyle: React.CSSProperties = useMemo(() => {
    const base: React.CSSProperties = {
      position: 'relative' as const,
      transformOrigin: 'center center',
      transform: `scale(${effectiveScale})`,
      transition: 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1), height 0.3s cubic-bezier(0.4, 0, 0.2, 1), border-radius 0.3s ease',
    };
    if (!device) {
      return { ...base, width: '100%', height: '100%' };
    }
    return { ...base, width: `${device.width}px`, height: `${device.height}px` };
  }, [device, effectiveScale]);

  const pngPath = device ? inferPngPath(device) : null;
  // ★ 用 sizeKey 作为 AnimatePresence 的 key，设备切换时触发 crossfade
  const pngKey = device?.sizeKey ?? 'none';

  return (
    <div
      ref={containerRef}
      onDoubleClick={handleDoubleClick}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: bgColor,
        overflow: 'hidden',
      }}
    >
      <div style={stageStyle}>
        {/* DSL 渲染层 — 用 framer-motion 淡入 */}
        <motion.div
          ref={dslLayerRef}
          key={dsl === prevDslRef.current ? undefined : 'stable'}
          style={{
            position: 'absolute',
            inset: 0,
            overflow: 'hidden',
            borderRadius: device ? '32px' : 0,
          }}
          initial={DSL_TRANSITION.initial}
          animate={DSL_TRANSITION.animate}
          transition={DSL_TRANSITION.transition}
        >
          {isEmptyDsl ? (
            // ★ 空 DSL 占位：在设备屏幕内显示提示文字
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              width: '100%',
              height: '100%',
              background: bgColor,
              gap: '12px',
            }}>
              <div
                style={{
                  width: '48px',
                  height: '48px',
                  opacity: 0.5,
                  backgroundColor: 'var(--color-primary, #6366f1)',
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
              <div style={{
                fontSize: '11px',
                fontFamily: 'monospace',
                color: 'rgba(128,128,128,0.5)',
              }}>
                等待生成预览...
              </div>
            </div>
          ) : (
            <WebAstPreview root={dsl} bgColor={bgColor} />
          )}
        </motion.div>

        {/* ★ 缩放比例指示器 (用户缩放后显示) */}
        {userZoom !== 1 && (
          <div
            style={{
              position: 'absolute',
              bottom: 8,
              right: 8,
              padding: '2px 8px',
              background: 'rgba(0,0,0,0.6)',
              color: 'rgba(255,255,255,0.9)',
              fontSize: '11px',
              fontFamily: 'monospace',
              borderRadius: '4px',
              pointerEvents: 'none',
              zIndex: 20,
            }}
          >
            {Math.round(effectiveScale * 100)}% · 双击重置
          </div>
        )}

        {/* ★ PNG 设备边框层 — AnimatePresence crossfade */}
        <AnimatePresence mode="sync">
          {pngPath && (
            <motion.img
              key={pngKey}
              src={pngPath}
              alt={device?.label || 'device frame'}
              initial={PNG_TRANSITION.initial}
              animate={PNG_TRANSITION.animate}
              exit={PNG_TRANSITION.exit}
              transition={PNG_TRANSITION.transition}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                objectFit: 'contain',
                zIndex: 10,
              }}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ── 3D 渲染：CanvasStage3D + GLB 模型 ──

interface Stage3DProps {
  dsl: UniversalNode;
  device: CanvasDeviceInfo;
  bgColor: string;
  theme: ThemeId;
  finish: MaterialFinish;
}

function Stage3D({ dsl, device, bgColor, theme, finish }: Stage3DProps) {
  const modelUrl = useMemo(() => {
    if (device.glbFile) return `/canvas/models/3d/${device.glbFile}`;
    return null;
  }, [device]);

  // ★ 3D 容器淡入: 模型加载完成后 anime.js opacity 0→1
  const containerRef = useRef<HTMLDivElement>(null);
  const prevUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!containerRef.current || !modelUrl) return;
    // 首次加载或模型切换时淡入
    if (prevUrl.current !== modelUrl) {
      prevUrl.current = modelUrl;
      animate(containerRef.current, {
        opacity: [0, 1],
        duration: 500,
        ease: 'outCubic',
      });
    }
  }, [modelUrl]);

  if (!modelUrl) {
    // glbFile 缺失，降级为 2D
    return <Stage2D dsl={dsl} device={null} bgColor={bgColor} />;
  }

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0, background: bgColor, opacity: 0 }}>
      <React.Suspense
        fallback={
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'rgba(255,255,255,0.5)',
              fontSize: '12px',
              fontFamily: 'monospace',
            }}
          >
            加载 3D 引擎...
          </div>
        }
      >
        <CanvasStage3D modelUrl={modelUrl} dsl={dsl} bgColor={bgColor} theme={theme} finish={finish} />
      </React.Suspense>
    </div>
  );
}

// ── 主组件 ──

export interface CanvasStageProps {
  /** DSL 根节点 */
  dsl: UniversalNode;
  /** 设备信息 (由 PreviewPanel 传入, 解耦 canvasId 依赖) */
  device: CanvasDeviceInfo | null;
  /** 画布 ID (仅用于 setFrameSize, 可选) */
  canvasId?: string;
  /** 背景色 (默认白色) */
  bgColor?: string;
  /** 3D 模型颜色主题 (仅 3D 模式生效) */
  theme?: ThemeId;
  /** 3D 模型材质工艺 (仅 3D 模式生效) */
  finish?: MaterialFinish;
}

export default function CanvasStage({ dsl, device, canvasId, bgColor = '#ffffff', theme, finish }: CanvasStageProps) {
  const renderMode = useCanvasDeviceStore((s) => s.renderMode);

  // ★ 修复 3: 3D 模式需要 device 且 device.glbFile 存在，否则降级为 2D
  const is3D = renderMode === '3D' && device && device.glbFile;

  // ★ 模式 key — AnimatePresence 用此 key 判断是否切换
  const modeKey = is3D ? '3d' : '2d';

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <AnimatePresence mode="wait">
        <motion.div
          key={modeKey}
          initial={MODE_TRANSITION.initial}
          animate={MODE_TRANSITION.animate}
          exit={MODE_TRANSITION.exit}
          transition={MODE_TRANSITION.transition}
          style={{ position: 'absolute', inset: 0 }}
        >
          {is3D ? (
            <Stage3D dsl={dsl} device={device!} bgColor={bgColor} theme={theme ?? getDefaultTheme()} finish={finish ?? getDefaultFinish()} />
          ) : (
            <Stage2D dsl={dsl} device={device} bgColor={bgColor} canvasId={canvasId} />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
