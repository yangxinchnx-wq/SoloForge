/**
 * StreamContextMenu — 流送区右键菜单 (字体颜色 + 字体大小调节)
 *
 * ★ 2026-07-19 新增
 * ★ 2026-07-20 重构:
 *   - 字体大小固定 (不受 --stream-font-size CSS 变量影响, 因为渲染在 .stream-process-root 外部)
 *   - 可拖动 (点击头部拖动面板)
 *   - z-index 最高 (z-[9999])
 *   - 默认在鼠标处出现
 *
 * 功能:
 *   - 字体颜色: 预设色板 + 自定义颜色选择器 + "跟随默认"按钮
 *   - 字体大小: 滑块 (8-18px) + 预设按钮 + 当前值显示
 *   - 设置持久化到 localStorage (streamAppearanceStore)
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, X, RotateCcw, GripVertical } from '../utils/icons';
import { useStreamAppearanceStore } from '../state/streamAppearanceStore';

interface StreamContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
}

// ── 预设颜色色板 ──
const PRESET_COLORS: { label: string; value: string }[] = [
  { label: '默认', value: '' },
  { label: '白色', value: '#ffffff' },
  { label: '黑色', value: '#18181b' },
  { label: '灰色', value: '#9ca3af' },
  { label: '蓝色', value: '#3b82f6' },
  { label: '绿色', value: '#22c55e' },
  { label: '橙色', value: '#f97316' },
  { label: '紫色', value: '#a855f7' },
  { label: '红色', value: '#ef4444' },
  { label: '青色', value: '#06b6d4' },
  { label: '粉色', value: '#ec4899' },
  { label: '黄色', value: '#eab308' },
];

// ── 预设字号 ──
const PRESET_SIZES: number[] = [10, 12, 14, 16, 18, 20, 24];

export const StreamContextMenu = React.memo(function StreamContextMenu({ x, y, onClose }: StreamContextMenuProps) {
  const fontColor = useStreamAppearanceStore(s => s.fontColor);
  const fontSize = useStreamAppearanceStore(s => s.fontSize);
  const setFontColor = useStreamAppearanceStore(s => s.setFontColor);
  const setFontSize = useStreamAppearanceStore(s => s.setFontSize);
  const reset = useStreamAppearanceStore(s => s.reset);

  const menuRef = useRef<HTMLDivElement>(null);

  // ★ 2026-07-20: 可拖动 — 面板位置状态
  const [pos, setPos] = useState({ x, y });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, posX: 0, posY: 0 });

  // 初始位置: 鼠标坐标, 边界修正
  useEffect(() => {
    const adjX = Math.min(x, window.innerWidth - 240);
    const adjY = Math.min(y, window.innerHeight - 380);
    setPos({ x: adjX, y: adjY });
  }, [x, y]);

  // 点击外部 / 右键 / ESC 关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleContextMenu = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    const id = requestAnimationFrame(() => {
      window.addEventListener('click', handleClickOutside);
      window.addEventListener('contextmenu', handleContextMenu);
      window.addEventListener('keydown', handleEsc);
    });

    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('click', handleClickOutside);
      window.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  // ★ 拖动逻辑
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    // 只在点击头部 (非按钮区域) 时开始拖动
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, posX: pos.x, posY: pos.y };
  }, [pos]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      const newX = Math.max(0, Math.min(dragStart.current.posX + dx, window.innerWidth - 240));
      const newY = Math.max(0, Math.min(dragStart.current.posY + dy, window.innerHeight - 100));
      setPos({ x: newX, y: newY });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const handleColorPickerChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setFontColor(e.target.value);
  }, [setFontColor]);

  const handleSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setFontSize(Number(e.target.value));
  }, [setFontSize]);

  const handleReset = useCallback(() => {
    reset();
  }, [reset]);

  const handleStopPropagation = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return (
    <div
      ref={menuRef}
      className="fixed z-[9999] w-[220px] rounded-xl bg-surface border border-outline/40 shadow-[0_8px_32px_rgba(0,0,0,0.28)] overflow-hidden select-none"
      style={{ left: pos.x, top: pos.y }}
      onClick={handleStopPropagation}
      onContextMenu={handleStopPropagation}
    >
      {/* 头部 — 可拖动 */}
      <div
        onMouseDown={handleDragStart}
        className="flex items-center justify-between px-3 py-2 border-b border-outline/20 cursor-move"
      >
        <div className="flex items-center gap-1.5">
          <GripVertical className="w-3 h-3 text-on-surface/30" />
          <span className="text-[11px] font-bold text-on-surface/80">流送区外观</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            title="重置为默认"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); handleReset(); }}
            className="p-1 rounded-md text-on-surface/40 hover:text-primary hover:bg-primary/10 transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
          <button
            type="button"
            title="关闭"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            className="p-1 rounded-md text-on-surface/40 hover:text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* 字体颜色 */}
      <div className="px-3 py-2 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold text-on-surface/60">字体颜色</span>
          {fontColor ? (
            <span className="text-[9px] font-mono text-on-surface/40">{fontColor}</span>
          ) : (
            <span className="text-[9px] text-on-surface/30">跟随默认</span>
          )}
        </div>
        {/* 预设色板 */}
        <div className="grid grid-cols-6 gap-1">
          {PRESET_COLORS.map(color => (
            <button
              key={color.label}
              type="button"
              title={color.label}
              onClick={() => setFontColor(color.value)}
              className={`relative w-7 h-7 rounded-lg border-2 transition-all ${
                fontColor === color.value
                  ? 'border-primary scale-110 shadow-[0_0_6px_rgba(var(--color-primary-rgb),0.4)]'
                  : 'border-outline/30 hover:border-primary/50 hover:scale-105'
              }`}
              style={{
                backgroundColor: color.value === '' ? 'transparent' : color.value,
                backgroundImage: color.value === ''
                  ? 'linear-gradient(135deg, transparent 45%, #ef4444 45%, #ef4444 55%, transparent 55%)'
                  : undefined,
              }}
            >
              {color.value === '' && (
                <span className="absolute inset-0 flex items-center justify-center text-[8px] text-on-surface/40 font-bold">
                  Aa
                </span>
              )}
              {fontColor === color.value && color.value !== '' && (
                <Check className="absolute inset-0 m-auto w-3 h-3 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]" />
              )}
            </button>
          ))}
        </div>
        {/* 自定义颜色选择器 */}
        <div className="flex items-center gap-2 pt-0.5">
          <label className="relative cursor-pointer">
            <input
              type="color"
              value={fontColor || '#9ca3af'}
              onChange={handleColorPickerChange}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
            <div className="w-7 h-7 rounded-lg border-2 border-outline/30 hover:border-primary/50 transition-colors flex items-center justify-center">
              <span
                className="w-4 h-4 rounded-full border border-white/20"
                style={{ backgroundColor: fontColor || 'transparent' }}
              />
            </div>
          </label>
          <span className="text-[9px] text-on-surface/40">自定义颜色</span>
          {fontColor && (
            <button
              type="button"
              onClick={() => setFontColor('')}
              className="ml-auto text-[9px] px-1.5 py-0.5 rounded text-on-surface/50 hover:text-primary hover:bg-primary/10 transition-colors"
            >
              清除
            </button>
          )}
        </div>
      </div>

      {/* 分隔线 */}
      <div className="h-px bg-outline/20" />

      {/* 字体大小 */}
      <div className="px-3 py-2 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold text-on-surface/60">字体大小</span>
          <span className="text-[10px] font-mono font-bold text-primary tabular-nums">{fontSize}px</span>
        </div>
        {/* 滑块 */}
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-on-surface/30 font-mono shrink-0">10</span>
          <input
            type="range"
            min={10}
            max={28}
            step={1}
            value={fontSize}
            onChange={handleSliderChange}
            className="flex-1 h-1.5 rounded-full appearance-none accent-primary cursor-pointer bg-on-surface/15"
          />
          <span className="text-[9px] text-on-surface/30 font-mono shrink-0">28</span>
        </div>
        {/* 预设字号 */}
        <div className="flex items-center gap-1 flex-wrap">
          {PRESET_SIZES.map(size => (
            <button
              key={size}
              type="button"
              onClick={() => setFontSize(size)}
              className={`px-1.5 py-0.5 rounded text-[9px] font-mono tabular-nums transition-all ${
                fontSize === size
                  ? 'bg-primary/15 text-primary font-bold'
                  : 'text-on-surface/40 hover:bg-primary/10 hover:text-primary'
              }`}
            >
              {size}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
});
