import React, { memo, useId } from 'react';
import { motion } from 'framer-motion';

/**
 * ToggleSwitch — 顶部胶囊栏里的开关 (framer-motion 重构版)
 *
 * 2026-07-02 重构要点:
 *   v5 (当前): 用 framer-motion 弹簧动画驱动 thumb 滑动, 用 transform: translateX
 *              完全替代 CSS keyframes. 状态机: aria-checked → thumb x 偏移
 *              - 弹簧: stiffness=500, damping=30 → Apple 风格轻反弹
 *              - 进入 disabled: opacity 200ms 渐入 (CSS transition 即可)
 *              - 按下: scale 0.95 spring (active feedback)
 *
 *   设计历史:
 *     v1-v3: <label>+<input> + .peer + 自绘 → 状态机错乱
 *     v4:    单一 <button> + aria-checked 属性选择器 + CSS keyframes
 *     v5:    引入 framer-motion, 用 spring 替换 keyframes (与 SecondaryModelSelector 同源)
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
      // 按下时 0.95 弹簧反馈
      whileTap={disabled ? undefined : { scale: 0.94 }}
      transition={{ type: 'spring', stiffness: 600, damping: 28 }}
      className={`toggle-switch relative inline-block shrink-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      style={{
        width: 44,
        height: 24,
        borderRadius: 9999,
        // 关闭: outline 灰; 开启: primary 主色 (椭圆填充)
        backgroundColor: checked ? 'var(--color-primary)' : 'var(--color-outline)',
        opacity: disabled ? 0.4 : 1,
        transition: 'background-color 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 200ms ease-out',
        border: '1px solid transparent',
      }}
    >
      {/* Thumb: 椭圆 -> 圆球, 用 framer-motion 弹簧驱动 x 偏移 */}
      <motion.span
        aria-hidden="true"
        initial={false}
        animate={{
          // 关闭: x = 4px (左); 开启: x = 24px (右). 总宽 44, 圆球 16, 间隙 4
          x: checked ? 24 : 4,
          // 副带缩放反馈 (开 -> 关瞬间 0.85, 弹簧回弹到 1)
          scale: 1,
        }}
        transition={{
          type: 'spring',
          stiffness: 700,
          damping: 32,
          mass: 0.6,
        }}
        style={{
          position: 'absolute',
          top: 3,
          left: 0,
          width: 16,
          height: 16,
          borderRadius: 9999,
          backgroundColor: 'var(--color-surface)',
          // 让 thumb 浮在 track 上, 加一点阴影
          boxShadow:
            '0 1px 3px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.05) inset',
          // GPU 加速
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