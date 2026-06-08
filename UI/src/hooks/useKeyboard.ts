// ─────────────────────────────────────────────────────────────────
// 全局键盘快捷键 hook
// ─────────────────────────────────────────────────────────────────

import { useEffect } from 'react';

export interface ShortcutBinding {
  key: string;            // 'k', 'n', 'b' 等单字符，或 'F1'
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;         // Mac Cmd
  handler: (e: KeyboardEvent) => void;
  description: string;
  preventDefault?: boolean;
}

export function useKeyboard(bindings: ShortcutBinding[], enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      // 在 input / textarea / [contenteditable] 内,只允许带 Ctrl/Meta/Alt 的快捷键
      // 单键 ? / Esc / F1 等仍然穿透
      const target = e.target as HTMLElement | null;
      const inEditable = !!target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      );
      for (const b of bindings) {
        const matchKey = b.key.toLowerCase() === e.key.toLowerCase();
        const matchCtrl = !!b.ctrl === (e.ctrlKey || e.metaKey);
        const matchShift = !!b.shift === e.shiftKey;
        const matchAlt = !!b.alt === e.altKey;
        if (matchKey && matchCtrl && matchShift && matchAlt) {
          // 在可编辑元素内,只放行带修饰键的快捷键
          if (inEditable && !b.ctrl && !b.meta && !b.alt) return;
          if (b.preventDefault !== false) e.preventDefault();
          b.handler(e);
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bindings, enabled]);
}

/** 把 KeyboardEvent 转为可读字符串 (e.g. "Ctrl+Shift+P") */
export function formatShortcut(b: ShortcutBinding): string {
  const parts: string[] = [];
  if (b.ctrl) parts.push('Ctrl');
  if (b.shift) parts.push('Shift');
  if (b.alt) parts.push('Alt');
  if (b.meta) parts.push('Cmd');
  if (b.key === ' ') parts.push('Space');
  else if (b.key.length === 1) parts.push(b.key.toUpperCase());
  else parts.push(b.key);
  return parts.join('+');
}
