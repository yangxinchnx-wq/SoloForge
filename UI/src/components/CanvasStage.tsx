/**
 * CanvasStage.tsx — 画布渲染舞台
 *
 * 整合 2D (WebAstPreview + PNG 边框) 和 3D (CanvasStage3D + GLB 模型) 两种渲染模式。
 * 根据 canvasDeviceStore 中的 renderMode 和设备信息自动切换。
 *
 * ★ 2026-07-16: 画布重构核心组件，替代旧版 Flutter IPC 渲染层
 * ★ 2026-07-16 修复:
 *   - 2D 模式添加 CSS transform: scale 自适应容器（原版会溢出）
 *   - 3D 模式 bgColor 尊重用户选择（原版强制覆盖白色为深色）
 *   - 3D 降级逻辑：renderMode='3D' 但无设备时降级为 2D（原版会卡在 3D toggle 但渲染 2D）
 *
 * ★ 2026-07-16 anime.js: 模式切换 + 设备切换过渡动画
 *   - 2D→3D / 3D→2D 切换时添加淡入淡出过渡
 *   - 设备切换时添加缩放过渡
 *   - 使用 anime.js animate() 直接操作 DOM 元素 opacity/scale
 *
 * 工作模式：
 *   - 2D 模式：WebAstPreview 直接渲染 DOM，可选 PNG 设备边框 overlay
 *   - 3D 模式：CanvasStage3D 用 R3F 渲染 GLB 模型 + RTT 贴图
 *   - 无设备：纯 WebAstPreview 渲染（开发模式默认）
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { UniversalNode } from '../services/canvas/UniversalAST';
import { useCanvasDeviceStore, type CanvasDeviceInfo } from '../state/canvasDeviceStore';
import { play2DLayoutTransition } from '../services/canvas/canvasAnimations';
import { animate } from 'animejs';
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
  const [scale, setScale] = useState(1);
  const setFrameSize = useCanvasDeviceStore((s) => s.setFrameSize);
  const prevDeviceKey = useRef<string | null>(null);

  // ★ anime.js: 设备切换时缩放过渡
  useEffect(() => {
    const currentKey = device?.sizeKey ?? 'none';
    if (prevDeviceKey.current !== null && prevDeviceKey.current !== currentKey && dslLayerRef.current) {
      // 设备变化 — anime.js 缩放弹跳过渡
      animate(dslLayerRef.current, {
        scale: [0.85, 1],
        opacity: [0.3, 1],
        duration: 400,
        ease: 'easeOutBack',
      });
    }
    prevDeviceKey.current = currentKey;
  }, [device?.sizeKey]);

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
      const s = Math.min(scaleX, scaleY, 1); // 不放大，只缩小
      setScale(s);
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

  const stageStyle: React.CSSProperties = useMemo(() => {
    if (!device) {
      return { width: '100%', height: '100%', position: 'relative' as const };
    }
    return {
      width: `${device.width}px`,
      height: `${device.height}px`,
      position: 'relative' as const,
      transformOrigin: 'center center',
      transform: `scale(${scale})`,
    };
  }, [device, scale]);

  const pngPath = device ? inferPngPath(device) : null;

  return (
    <div
      ref={containerRef}
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
        {/* DSL 渲染层 */}
        <div
          ref={dslLayerRef}
          style={{
            position: 'absolute',
            inset: 0,
            overflow: 'hidden',
            borderRadius: device ? '32px' : 0,
          }}
        >
          <WebAstPreview root={dsl} bgColor={bgColor} />
        </div>

        {/* PNG 设备边框层（仅 2D 模式 + 有设备时） */}
        {pngPath && (
          <img
            src={pngPath}
            alt={device?.label || 'device frame'}
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
      </div>
    </div>
  );
}

// ── 3D 渲染：CanvasStage3D + GLB 模型 ──

interface Stage3DProps {
  dsl: UniversalNode;
  device: CanvasDeviceInfo;
  bgColor: string;
}

function Stage3D({ dsl, device, bgColor }: Stage3DProps) {
  const modelUrl = useMemo(() => {
    if (device.glbFile) return `/canvas/models/3d/${device.glbFile}`;
    return null;
  }, [device]);

  if (!modelUrl) {
    // glbFile 缺失，降级为 2D
    return <Stage2D dsl={dsl} device={null} bgColor={bgColor} />;
  }

  return (
    <div style={{ position: 'absolute', inset: 0, background: bgColor }}>
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
        <CanvasStage3D modelUrl={modelUrl} dsl={dsl} bgColor={bgColor} />
      </React.Suspense>
    </div>
  );
}

// ── 主组件 ──

export interface CanvasStageProps {
  /** DSL 根节点 */
  dsl: UniversalNode;
  /** 画布 ID（用于从 store 读取设备信息，不传则无设备约束） */
  canvasId?: string;
  /** 背景色（默认白色） */
  bgColor?: string;
}

export default function CanvasStage({ dsl, canvasId, bgColor = '#ffffff' }: CanvasStageProps) {
  const device = useCanvasDeviceStore((s) => (canvasId ? s.devices[canvasId] ?? null : null));
  const renderMode = useCanvasDeviceStore((s) => s.renderMode);

  // ★ anime.js: 模式切换过渡
  const stageRef = useRef<HTMLDivElement>(null);
  const prevMode = useRef<string | null>(null);

  useEffect(() => {
    const currentMode = renderMode === '3D' && device?.glbFile ? '3D' : '2D';
    if (prevMode.current !== null && prevMode.current !== currentMode && stageRef.current) {
      // 模式切换 — anime.js 淡入过渡
      animate(stageRef.current, {
        opacity: [0, 1],
        scale: [0.92, 1],
        duration: 500,
        ease: 'easeOutCubic',
      });
    }
    prevMode.current = currentMode;
  }, [renderMode, device?.glbFile]);

  // ★ 修复 3: 3D 模式需要 device 且 device.glbFile 存在，否则降级为 2D
  // 不再强制覆盖 bgColor（修复 5：尊重用户选择）
  const is3D = renderMode === '3D' && device && device.glbFile;

  return (
    <div ref={stageRef} style={{ position: 'absolute', inset: 0 }}>
      {is3D ? (
        <Stage3D dsl={dsl} device={device} bgColor={bgColor} />
      ) : (
        <Stage2D dsl={dsl} device={device} bgColor={bgColor} canvasId={canvasId} />
      )}
    </div>
  );
}
