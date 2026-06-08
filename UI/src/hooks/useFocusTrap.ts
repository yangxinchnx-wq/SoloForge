// ─────────────────────────────────────────────────────────────────
// 焦点陷阱 (P1-15)
// - overlay 打开时:Tab/Shift+Tab 在内部循环
// - Esc 自动调用 onClose
// - 自动聚焦第一个可聚焦元素
// 用法: const ref = useFocusTrap(open, onClose); <div ref={ref}>...
// ─────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useFocusTrap<T extends HTMLElement>(active: boolean, onEscape?: () => void) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;

    // 找所有可聚焦元素
    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((n) => !n.hasAttribute('disabled') && n.offsetParent !== null);

    // 记录原焦点
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // 自动聚焦第一个
    const first = focusables()[0];
    if (first) first.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onEscape) {
        e.stopPropagation();
        onEscape();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      // 还原焦点
      if (previouslyFocused && previouslyFocused.focus) {
        try { previouslyFocused.focus(); } catch { /* ignore */ }
      }
    };
  }, [active, onEscape]);

  return ref;
}
