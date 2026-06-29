import React, { memo, useId } from 'react';

/**
 * ToggleSwitch — 顶部胶囊栏里的开关
 *
 * 设计选型历史 (2026-06-27):
 *   v1: <label> + <input class="peer"> + .toggle-track/.toggle-thumb 自绘
 *       → 同 label 双 input 互相打架, CSS 状态机错乱
 *   v2: 修掉双 input, 仍是 <input> + 自绘 track+thumb
 *       → 用户判定"像两个圆球" (off 状态颜色对比不足)
 *   v3: 换 lucide ToggleRight (单一 SVG), scaleX(-1) 翻转表达 off
 *       → 用户判定"180 度旋转"反人类, 且整体尺寸小、线条粗
 *   v4 (当前): 自绘 track + thumb, 用 aria-checked 属性选择器
 *       → thumb 圆球在 track 内从左滑到右, 200ms ease-out
 *       → 整体尺寸加大, outline 改细 (1px)
 *       → button 自身就是 [aria-checked] 容器, CSS 直接属性选择器
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
    <button
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
      className={`toggle-switch relative inline-block shrink-0 cursor-pointer active:scale-95 transition-transform disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      <span className="toggle-switch-track" />
      <span className="toggle-switch-thumb" />
    </button>
  );
}

export const ToggleSwitch = memo(ToggleSwitchImpl);
ToggleSwitch.displayName = 'ToggleSwitch';
