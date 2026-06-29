/**
 * ThemeSwitchOverlay — 主题切换视觉遮罩层 (GPU 加速)
 *
 * 三阶段过渡:
 *  1. Cover:  overlay 用旧主题 bg 色铺满 (opacity 0→1, compositor-only)
 *  2. (ThemeContext 改 data-theme, 全页重绘被遮罩盖住)
 *  3. Reveal: overlay 换成新主题 bg 色后淡出 (opacity 1→0)
 *
 * GPU 加速:
 *  - position:fixed + will-change:opacity → 独立 compositor 层
 *  - contain:strict → style/layout/paint 完全隔离, 不影响其他元素
 *  - opacity 变化只走 compositor, 不触发 layout/paint
 */

import { useEffect, useRef, useCallback } from 'react';

export default function ThemeSwitchOverlay() {
  const ref = useRef<HTMLDivElement>(null);

  const handleTransition = useCallback((e: Event) => {
    const el = ref.current;
    if (!el) return;
    const { bg, phase } = (e as CustomEvent).detail || {};

    if (phase === 'cover') {
      // Phase 1: 立刻铺满旧主题 bg 色 (compositor-only, 零开销)
      el.style.transition = 'none';
      el.style.backgroundColor = bg || '#09090b';
      el.style.opacity = '1';
    } else {
      // Phase 3 (reveal) 或兼容旧调用: 换成新主题 bg 色后淡出
      el.style.transition = 'none';
      el.style.backgroundColor = bg || '#09090b';
      el.style.opacity = '1';
      requestAnimationFrame(() => {
        el.style.transition = 'opacity 280ms cubic-bezier(0.22, 1, 0.36, 1)';
        el.style.opacity = '0';
      });
    }
  }, []);

  useEffect(() => {
    window.addEventListener('soloforge:theme-transition-start', handleTransition);
    return () => window.removeEventListener('soloforge:theme-transition-start', handleTransition);
  }, [handleTransition]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99998,
        pointerEvents: 'none',
        opacity: 0,
        willChange: 'opacity',
        contain: 'strict',
      }}
    />
  );
}
