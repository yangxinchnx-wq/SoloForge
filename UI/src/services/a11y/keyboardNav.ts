/**
 * keyboardNav.ts — 键盘导航与 A11y 工具函数
 *
 * 用法：
 *   import { rovingTabindex, focusTrap, isActionKey, announceToLiveRegion } from '@/services/a11y/keyboardNav';
 *
 *   // 1. 列表 roving tabindex（左右键切换）
 *   <ul onKeyDown={rovingTabindex({ orientation: 'horizontal', itemCount: 5, onSelect: (i) => ... })}>
 *     {items.map((it, i) => <li tabIndex={i === activeIndex ? 0 : -1}>...</li>)}
 *   </ul>
 *
 *   // 2. 焦点陷阱（Modal / Dialog）
 *   <div ref={containerRef} onKeyDown={focusTrap}>
 *     ...
 *   </div>
 *
 *   // 3. 屏幕阅读器公告
 *   announceToLiveRegion('已生成 3 张卡片');
 *
 * 兼容性：
 *   - 无 DOM 依赖：纯函数 + 类型
 *   - 不依赖 React（可被任何框架使用）
 *   - SSR / Node 环境全部是 noop（typeof document === 'undefined'）
 */

export type Orientation = 'horizontal' | 'vertical' | 'both';

export interface RovingTabindexOptions {
  orientation: Orientation;
  itemCount: number;
  /** 当前焦点索引（受控） */
  activeIndex: number;
  /** 切换索引时调用 */
  onChange: (nextIndex: number) => void;
  /** 选中（Enter / Space）时调用 */
  onSelect?: (index: number) => void;
  /** Home / End 跳转边界 */
  wrap?: boolean;
  /** Home 键是否跳到第一个（默认 true） */
  homeEnabled?: boolean;
  /** End 键是否跳到最后一个（默认 true） */
  endEnabled?: boolean;
  /** 跳过 disabled 项（占位） */
  isDisabled?: (index: number) => boolean;
}

/**
 * rovingTabindex 键盘事件 handler
 * 用于 listbox / menu / tablist / grid
 */
export function rovingTabindex(opts: RovingTabindexOptions) {
  const { orientation, itemCount, onChange, onSelect, wrap = true, homeEnabled = true, endEnabled = true } = opts;
  if (itemCount <= 0) return () => {};
  return (e: KeyboardEvent | React.KeyboardEvent) => {
    const activeIndex = opts.activeIndex; // 每次按键重读（支持 getter / 受控状态）
    const k = e.key;
    let next = activeIndex;
    let handled = true;

    const horiz = orientation === 'horizontal' || orientation === 'both';
    const vert = orientation === 'vertical' || orientation === 'both';

    if (horiz && k === 'ArrowRight') next = activeIndex + 1;
    else if (horiz && k === 'ArrowLeft') next = activeIndex - 1;
    else if (vert && k === 'ArrowDown') next = activeIndex + 1;
    else if (vert && k === 'ArrowUp') next = activeIndex - 1;
    else if (homeEnabled && k === 'Home') next = 0;
    else if (endEnabled && k === 'End') next = itemCount - 1;
    else if ((k === 'Enter' || k === ' ') && onSelect) {
      onSelect(activeIndex);
      return; // handled
    } else handled = false;

    if (handled) {
      e.preventDefault();
      if (next < 0) next = wrap ? itemCount - 1 : 0;
      if (next >= itemCount) next = wrap ? 0 : itemCount - 1;
      if (next !== activeIndex) onChange(next);
    }
  };
}

/**
 * focusTrap — 焦点陷阱
 * Tab / Shift+Tab 在容器内循环
 *
 * 用法：
 *   <div ref={containerRef} onKeyDown={(e) => focusTrap(e, containerRef.current)}>
 */
export function focusTrap(e: KeyboardEvent | React.KeyboardEvent, container: HTMLElement | null): void {
  if (e.key !== 'Tab' || !container) return;
  const focusable = container.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = typeof document !== 'undefined' ? document.activeElement as HTMLElement : null;

  if (e.shiftKey) {
    if (active === first || !container.contains(active)) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (active === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

/** 判断是否"动作键"（Enter / Space，用于按钮/菜单项） */
export function isActionKey(e: KeyboardEvent | React.KeyboardEvent): boolean {
  return e.key === 'Enter' || e.key === ' ';
}

/** 判断是否"取消键"（Escape） */
export function isCancelKey(e: KeyboardEvent | React.KeyboardEvent): boolean {
  return e.key === 'Escape' || e.key === 'Esc';
}

/** 屏幕阅读器公告（aria-live） */
let liveRegionEl: HTMLElement | null = null;

export function getLiveRegion(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  if (liveRegionEl) return liveRegionEl;
  let el = document.getElementById('soloforge-a11y-live');
  if (!el) {
    el = document.createElement('div');
    el.id = 'soloforge-a11y-live';
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    el.setAttribute('role', 'status');
    el.style.cssText = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;';
    document.body.appendChild(el);
  }
  liveRegionEl = el;
  return el;
}

export function announceToLiveRegion(message: string, politeness: 'polite' | 'assertive' = 'polite'): void {
  const el = getLiveRegion();
  if (!el) return;
  el.setAttribute('aria-live', politeness);
  // 清空再写，触发 SR 重新读
  el.textContent = '';
  setTimeout(() => { el.textContent = message; }, 50);
}

/** ARIA 属性生成器（消除拼写错误） */
export function ariaProps(label?: string, labelledBy?: string, describedBy?: string, hidden?: boolean) {
  const out: Record<string, string | boolean | undefined> = {};
  if (label) out['aria-label'] = label;
  if (labelledBy) out['aria-labelledby'] = labelledBy;
  if (describedBy) out['aria-describedby'] = describedBy;
  if (hidden) out['aria-hidden'] = true;
  return out;
}

/** 计算颜色对比度（WCAG） */
export function colorContrastRatio(fg: string, bg: string): number {
  const fgL = relativeLuminance(fg);
  const bgL = relativeLuminance(bg);
  const lighter = Math.max(fgL, bgL);
  const darker = Math.min(fgL, bgL);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color: string): number {
  // 支持 #rgb / #rrggbb
  let hex = color.trim();
  if (hex.startsWith('#')) hex = hex.slice(1);
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (hex.length !== 6) return 0;
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function meetsWCAGAA(fg: string, bg: string, largeText = false): boolean {
  const ratio = colorContrastRatio(fg, bg);
  return largeText ? ratio >= 3 : ratio >= 4.5;
}
