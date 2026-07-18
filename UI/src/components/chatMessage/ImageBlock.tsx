/**
 * ImageBlock — 大模型返回图片的展示组件
 *
 * 功能:
 *   1. 图片容器 + 加载状态 (loading / error)
 *   2. ★ 不压缩画质: 原图原始尺寸显示, 用滚动容器承载大图
 *   3. ★ 等比例放大缩小: 滚轮缩放 + +/- 按钮控件, 保持宽高比
 *   4. ★ 支持所有图像格式: SVG/WebP/AVIF/GIF/BMP/TIFF/PNG/JPEG... (浏览器原生支持的都行)
 *   5. ★ 大尺寸图片: 100MB 也能显示, 容器最大高度限制 + 内部滚动, 不裁剪不压缩
 *   6. 尺寸指示器: 图片加载后在容器底部显示 "宽 × 高 px · 缩放比例%"
 *   7. 右键菜单: 复制图片 / 另存为 / 在新标签页打开 / 重置缩放
 *
 * 安全:
 *   - 仅渲染 http/https/data:image 协议的图片 (调用方已过滤)
 *   - 复制和另存为通过 fetch→blob 实现, 跨域失败时降级提示
 *
 * 2026-07-19: 初版
 * 2026-07-19 v2: 移除画质压缩, 添加等比例缩放, 支持大尺寸图片
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  Copy, Download, ExternalLink, AlertCircle, Loader2,
  ZoomIn, ZoomOut, Plus, Minus, RotateCcw,
} from '../../utils/icons';

export interface ImageBlockProps {
  src: string;
  alt?: string;
}

// 缩放范围: 10% ~ 500% (原始尺寸的 0.1 ~ 5 倍)
const MIN_SCALE = 0.1;
const MAX_SCALE = 5;
// 滚轮每次缩放步长
const WHEEL_STEP = 0.1;
// 按钮每次缩放步长
const BUTTON_STEP = 0.25;
// 容器最大高度 (超出滚动), 不压缩图片本身
const CONTAINER_MAX_HEIGHT = 600;

export function ImageBlock({ src, alt }: ImageBlockProps) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // ── 图片加载完成 ──
  const handleLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setDimensions({ w: img.naturalWidth, h: img.naturalHeight });
    setStatus('loaded');
    // ★ 初始缩放: 如果图片宽度 > 容器宽度, 自动缩放到适配容器宽度
    //   但不强制缩小小图片, 保持原始尺寸
    if (containerRef.current && img.naturalWidth > containerRef.current.clientWidth) {
      const fitScale = containerRef.current.clientWidth / img.naturalWidth;
      setScale(Math.max(MIN_SCALE, fitScale));
    } else {
      setScale(1);
    }
  }, []);

  const handleError = useCallback(() => {
    setStatus('error');
  }, []);

  // ── 等比例缩放 (限制范围) ──
  const clampScale = useCallback((s: number) => {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  }, []);

  // ── 滚轮缩放 (等比例, 以鼠标位置为中心) ──
  const handleWheel = useCallback((e: React.WheelEvent) => {
    // 只有按住 Ctrl 键才缩放, 避免干扰普通滚动
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    const delta = e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP;
    setScale(prev => clampScale(prev + delta * prev));
  }, [clampScale]);

  // ── 按钮缩放 ──
  const zoomIn = useCallback(() => {
    setScale(prev => clampScale(prev + BUTTON_STEP));
  }, [clampScale]);

  const zoomOut = useCallback(() => {
    setScale(prev => clampScale(prev - BUTTON_STEP));
  }, [clampScale]);

  const resetZoom = useCallback(() => {
    setScale(1);
  }, []);

  // ── 右键菜单 ──
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // ── 关闭菜单 ──
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    // 延迟绑定, 避免触发菜单的 contextmenu 事件本身立即关闭
    const timer = setTimeout(() => {
      window.addEventListener('click', close);
      window.addEventListener('contextmenu', close);
      window.addEventListener('scroll', close, true);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  // ── ESC 关闭菜单 ──
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  // ── toast 自动消失 ──
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(timer);
  }, [toast]);

  // ── fetch → blob (用于复制和另存为) ──
  const fetchBlob = useCallback(async (): Promise<Blob | null> => {
    try {
      const response = await fetch(src, { mode: 'cors' });
      if (!response.ok) return null;
      return await response.blob();
    } catch {
      return null;
    }
  }, [src]);

  // ── 复制图片到剪贴板 ──
  const handleCopy = useCallback(async () => {
    setMenu(null);
    const blob = await fetchBlob();
    if (!blob) {
      setToast('复制失败: 无法获取图片数据');
      return;
    }
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob }),
      ]);
      setToast('已复制到剪贴板');
    } catch {
      setToast('复制失败: 浏览器不支持或权限被拒');
    }
  }, [fetchBlob]);

  // ── 另存为 ──
  const handleSave = useCallback(async () => {
    setMenu(null);
    // 从 src 中提取文件扩展名, 支持所有图像格式
    let ext = 'png';
    // data:image/webp;base64,... → webp
    const dataMatch = src.match(/^data:image\/([\w.+-]+)/);
    // https://.../image.avif?query → avif
    const urlMatch = src.match(/\.([\w.+-]+)(?:\?|#|$)/);
    if (dataMatch) {
      ext = dataMatch[1];
    } else if (urlMatch) {
      ext = urlMatch[1].toLowerCase();
    }
    const fileName = (alt && alt.trim()) || `image-${Date.now()}`;
    const fullName = `${fileName}.${ext}`;

    const blob = await fetchBlob();
    if (blob) {
      // fetch 成功: 用 blob URL 下载 (跨域也能工作)
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = fullName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      setToast('已保存');
      return;
    }

    // fetch 失败 (CORS): 降级为直接 <a download>
    try {
      const a = document.createElement('a');
      a.href = src;
      a.download = fullName;
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setToast('已保存');
    } catch {
      setToast('保存失败: 无法下载图片');
    }
  }, [src, alt, fetchBlob]);

  // ── 在新标签页打开 ──
  const handleOpen = useCallback(() => {
    setMenu(null);
    window.open(src, '_blank', 'noopener,noreferrer');
  }, [src]);

  // ── 右键菜单: 重置缩放 ──
  const handleResetFromMenu = useCallback(() => {
    setMenu(null);
    resetZoom();
  }, [resetZoom]);

  return (
    <>
      <div
        className="relative inline-block max-w-full group"
        onContextMenu={handleContextMenu}
      >
        {/* ── 图片滚动容器 ──
            ★ 不压缩画质: 容器限制最大高度并滚动, 图片本身保持原始尺寸
            ★ 大尺寸图片 (100MB): 容器滚动, 图片不裁剪 */}
        <div
          ref={containerRef}
          className="relative rounded-lg overflow-auto"
          style={{
            maxHeight: `${CONTAINER_MAX_HEIGHT}px`,
            outline: '1px solid rgba(255,255,255,0.06)',
          }}
          onWheel={handleWheel}
        >
          {status !== 'error' ? (
            <img
              src={src}
              alt={alt || ''}
              onLoad={handleLoad}
              onError={handleError}
              className="block"
              style={{
                // ★ 不压缩: 移除 maxHeight / objectFit, 用 transform scale 缩放
                //   transform 不改变图片数据, 画质无损
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
                // 确保图片以原始尺寸渲染, 不被 CSS 压缩
                width: 'auto',
                height: 'auto',
                maxWidth: 'none',
              }}
              // ★ 大图片不使用 lazy loading, 避免延迟加载大图时的卡顿
              loading="eager"
              draggable={false}
            />
          ) : (
            <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-500/5 border border-red-500/15 text-[11px] text-red-400/80">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span>图片加载失败</span>
            </div>
          )}

          {/* loading 占位 */}
          {status === 'loading' && (
            <div className="flex items-center justify-center bg-on-surface/5 min-h-[80px] min-w-[120px]">
              <Loader2 className="w-4 h-4 text-on-surface/30 animate-spin" />
            </div>
          )}
        </div>

        {/* ── 缩放控件 ── (hover 显示, 位于图片右上角) */}
        {status === 'loaded' && (
          <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 px-1 py-0.5 rounded-md bg-bg/80 backdrop-blur border border-outline/20 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={zoomOut}
              disabled={scale <= MIN_SCALE}
              title="缩小 (Ctrl+滚轮)"
              className="p-0.5 rounded text-on-surface/60 hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Minus className="w-3 h-3" />
            </button>
            <span className="text-[9px] font-mono text-on-surface/50 tabular-nums w-9 text-center select-none">
              {Math.round(scale * 100)}%
            </span>
            <button
              type="button"
              onClick={zoomIn}
              disabled={scale >= MAX_SCALE}
              title="放大 (Ctrl+滚轮)"
              className="p-0.5 rounded text-on-surface/60 hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Plus className="w-3 h-3" />
            </button>
            <div className="w-px h-3 bg-outline/20 mx-0.5" />
            <button
              type="button"
              onClick={resetZoom}
              title="重置缩放 (100%)"
              className="p-0.5 rounded text-on-surface/60 hover:text-primary hover:bg-primary/10 transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* ── 尺寸指示器 ── (图片外围底部) */}
        {status === 'loaded' && dimensions && (
          <div className="flex items-center justify-between gap-2 mt-1 px-1 text-[9px] font-mono text-on-surface/35 tabular-nums">
            <span>
              {dimensions.w} × {dimensions.h} px
              {scale !== 1 && (
                <span className="text-on-surface/25 ml-1">
                  · 显示 {Math.round(dimensions.w * scale)} × {Math.round(dimensions.h * scale)}
                </span>
              )}
            </span>
            <span className="opacity-0 group-hover:opacity-100 transition-opacity">
              Ctrl+滚轮缩放 · 右键更多操作
            </span>
          </div>
        )}
      </div>

      {/* 右键菜单 */}
      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[140px] py-1 rounded-lg bg-surface border border-outline/30 shadow-[0_8px_24px_rgba(0,0,0,0.35)] text-[11px]"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={handleCopy}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-on-surface/80 hover:bg-primary/10 hover:text-primary transition-colors"
          >
            <Copy className="w-3 h-3 shrink-0" />
            <span>复制图片</span>
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-on-surface/80 hover:bg-primary/10 hover:text-primary transition-colors"
          >
            <Download className="w-3 h-3 shrink-0" />
            <span>另存为</span>
          </button>
          <button
            type="button"
            onClick={handleOpen}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-on-surface/80 hover:bg-primary/10 hover:text-primary transition-colors"
          >
            <ExternalLink className="w-3 h-3 shrink-0" />
            <span>在新标签页打开</span>
          </button>
          <div className="h-px bg-outline/20 my-0.5" />
          <button
            type="button"
            onClick={handleResetFromMenu}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-on-surface/80 hover:bg-primary/10 hover:text-primary transition-colors"
          >
            <RotateCcw className="w-3 h-3 shrink-0" />
            <span>重置缩放</span>
          </button>
        </div>
      )}

      {/* toast 反馈 */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-3 py-1.5 rounded-lg bg-surface border border-outline/30 shadow-[0_4px_16px_rgba(0,0,0,0.3)] text-[11px] text-on-surface/80 pointer-events-none">
          {toast}
        </div>
      )}
    </>
  );
}
