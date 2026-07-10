import React, { memo, useId } from 'react';
import { motion } from 'framer-motion';

/**
 * ToggleSwitch — iOS 风格开关 (v6, 2026-07-10 重构)
 *
 * 对标 iOS Settings Toggle:
 *   - 尺寸 50×30 (iOS 原生 51×31 等比缩放), thumb 24×24, 四周 3px 间隙
 *   - thumb 纯白 + 三层柔和阴影 (ambient + key + inset), 浮于 track 之上
 *   - 关闭色: rgba(120,120,128,0.32) (iOS systemGray3 半透明)
 *   - 开启色: var(--color-primary) (品牌主色, 替代 iOS #34C759)
 *   - spring: stiffness=500, damping=30, mass=0.7 → 轻微 overshoot (iOS 灵魂)
 *   - whileTap: thumb scale 0.92 (iOS 13+ 按下反馈, 只缩 thumb 不缩 track)
 *   - 背景色用 250ms ease (比 thumb 慢, 形成"色先变球后到"的层次感)
 *
 * Props:
 *   - checked:    受控值
 *   - onChange:   (next: boolean) => void
 *   - disabled:   普通模式锁住混合模式用
 *   - label:      aria-label (无障碍 + 自动化测试 snapshot 可定位)
 *   - title:      tooltip
 *   - className:  追加到外层 button
 */
export interface ToggleSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
  title?: string;
  className?: string;
}

// 几何参数 (iOS 比例: track 50×30, thumb 24, 间隙 3)
const TRACK_W = 50;
const TRACK_H = 30;
const THUMB_SIZE = 24;
const THUMB_GAP = 3; // top/left 间隙
const THUMB_TRAVEL = TRACK_W - THUMB_SIZE - THUMB_GAP * 2; // = 20px 滑动行程

function ToggleSwitchImpl({
  checked,
  onChange,
  disabled = false,
  label,
  title,
  className = '',
}: ToggleSwitchProps) {
  const id = useId();
  return (
    <motion.button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange(!checked);
      }}
      // iOS: track 不缩放, 只变背景色
      className={`toggle-switch relative inline-block shrink-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      style={{
        width: TRACK_W,
        height: TRACK_H,
        borderRadius: 9999,
        // iOS 关闭色: 半透明灰; 开启色: 品牌主色
        backgroundColor: checked
          ? 'var(--color-primary)'
          : 'rgba(120, 120, 128, 0.32)',
        opacity: disabled ? 0.4 : 1,
        // 背景色比 thumb 慢 ~30ms, 形成"色先变球后到"的层次
        transition:
          'background-color 250ms cubic-bezier(0.22, 1, 0.36, 1), opacity 200ms ease-out',
        border: 'none',
        // track 自身不加阴影, 让 thumb 的阴影承担立体感
        boxShadow: 'none',
      }}
    >
      {/* Thumb: 纯白圆球 + iOS 三层阴影, spring 带 overshoot */}
      <motion.span
        aria-hidden="true"
        initial={false}
        animate={{
          // 关闭: x = 3 (左); 开启: x = 23 (右). 行程 20px
          x: checked ? THUMB_GAP + THUMB_TRAVEL : THUMB_GAP,
          // 按下时 thumb 缩放 0.92 (iOS 13+ 反馈), 松开回弹到 1
          scale: 1,
        }}
        whileTap={disabled ? undefined : { scale: 0.92 }}
        transition={{
          type: 'spring',
          stiffness: 500,
          damping: 30,
          mass: 0.7, // 略大质量 → 更明显的 overshoot
        }}
        style={{
          position: 'absolute',
          top: THUMB_GAP,
          left: 0,
          width: THUMB_SIZE,
          height: THUMB_SIZE,
          borderRadius: 9999,
          // iOS thumb 纯白 (不跟随主题)
          backgroundColor: '#FFFFFF',
          // iOS 三层阴影: ambient (大范围柔光) + key (聚焦) + inset (边缘高光)
          boxShadow:
            '0 3px 8px rgba(0, 0, 0, 0.15), 0 1px 1px rgba(0, 0, 0, 0.16), 0 3px 1px rgba(0, 0, 0, 0.06), inset 0 0 0 0.5px rgba(0, 0, 0, 0.04)',
          willChange: 'transform',
          transform: 'translateZ(0)',
          backfaceVisibility: 'hidden',
          WebkitBackfaceVisibility: 'hidden',
        }}
      />
    </motion.button>
  );
}

export const ToggleSwitch = memo(ToggleSwitchImpl);
ToggleSwitch.displayName = 'ToggleSwitch';