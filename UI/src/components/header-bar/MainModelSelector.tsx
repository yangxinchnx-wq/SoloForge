/**
 * MainModelSelector — 顶部主模型下拉
 *
 * 抽离自 Header.tsx, 解决:
 *   1. 原代码 JSX 与业务态强耦合, 单测需 mount 整个 Header
 *   2. 下拉关闭的 backdrop + AnimatePresence 嵌套, 容易泄漏
 *   3. 选中/外部点击/键盘 Esc 三种关闭路径各自实现
 *
 * 设计:
 *   - 受控/非受控两种用法
 *   - openOnHover=false (点开); Esc 关闭; 选完即关
 *   - 暴露纯函数 `filterModels` 以便单测
 *   - props.draggable = true 时返回 data-no-drag 标记
 */

import React, { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { MountTransition } from '../MountTransition';
import { ModelIcon } from '../ModelIcon';
import { computeAvailableModels, pickModel } from './mainModelSelectorLogic';
export { computeAvailableModels, pickModel } from './mainModelSelectorLogic';

// ──────────────── 类型 ────────────────

export interface MainModelSelectorProps {
  /** 当前主模型 id (受控) */
  mainModel: string;
  /** 选中回调, 父组件负责同步到 store */
  onChange: (model: string) => void;
  /** 可用模型 id 列表 (来自 providers) */
  availableModels: readonly string[];
  /** 拖动相关: true 时挂 data-no-drag, 让父 header 知道这里不可拖 */
  draggable?: boolean;
  /** 自定义 placeholder (列表为空时) */
  emptyHint?: string;
  /** 自定义 button 文本 (label 在外部, 这里只渲染按钮) */
  className?: string;
  /** 下拉打开/关闭时通知父组件 (用于 z-index 等协调) */
  onOpenChange?: (open: boolean) => void;
}

// ──────────────── 主组件 ────────────────

function MainModelSelectorImpl({
  mainModel,
  onChange,
  availableModels,
  draggable = true,
  emptyHint = '尚未配置可用模型',
  className = '',
  onOpenChange,
}: MainModelSelectorProps) {
  const [open, setOpenState] = useState(false);
  const setOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setOpenState((prev) => {
        const v = typeof next === 'function' ? next(prev) : next;
        onOpenChange?.(v);
        return v;
      });
    },
    [onOpenChange],
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonId = useId();

  // 列表去重 + 兜底 (空时, fallback = null)
  const { list, fallback } = computeAvailableModels(availableModels);
  const safeMainModel = list.includes(mainModel) ? mainModel : (fallback ?? mainModel);

  // ── 关闭逻辑 ──
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);

  // ── 选完即关 + 通知父组件 ──
  const handleSelect = useCallback(
    (m: string) => {
      const { next, changed } = pickModel(list, safeMainModel, m);
      if (changed) onChange(next);
      setOpen(false);
    },
    [list, safeMainModel, onChange],
  );

  // ── Esc 关闭 ──
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  // ── 点击外部关闭 (用 ref 替代 backdrop, 避免盖住其它面板) ──
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      close();
    };
    // 用 mousedown 不用 click, 避免和 button 的 onClick 抢顺序
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  const dragProps = draggable ? { 'data-no-drag': true } : {};

  return (
    <div
      ref={rootRef}
      className={`relative font-sans ${open ? 'z-50' : ''} ${className}`}
      {...dragProps}
    >
      <button
        id={buttonId}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="选择主模型"
        onClick={toggle}
        className="flex items-center gap-1.5 bg-[var(--color-surface)]/60 hover:bg-[var(--color-surface)]/90 border-[3px] border-primary/45 hover:border-primary/75 px-3 h-[30px] rounded-full text-xs text-[var(--color-on-surface)] active:scale-95 transition-all cursor-pointer font-bold select-none overflow-visible"
      >
        <ModelIcon modelName={safeMainModel} size={20} className="shrink-0" />
        <div className="h-4 overflow-hidden relative flex items-center justify-center min-w-[84px]">
          <span
            key={safeMainModel}
            className="sf-anim sf-anim-slide-right inline-block whitespace-nowrap text-primary"
          >
            {safeMainModel}
          </span>
        </div>
        <div className={`flex items-center justify-center shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : 'rotate-0'}`}>
          <ChevronDown className="w-3.5 h-3.5 text-on-surface/40" />
        </div>
      </button>

      <MountTransition show={open} variant="fade-scale" duration={140}>
        {open && (
          <div
            role="listbox"
            aria-labelledby={buttonId}
            className="absolute left-0 mt-3.5 w-64 bg-[var(--color-surface)] border border-[var(--color-outline)]/25 rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.10)] z-50 p-1 flex flex-col gap-0.5"
          >
            {list.length === 0 ? (
              <div className="px-3 py-4 text-center text-[11px] text-on-surface/55 leading-relaxed select-none">
                <div className="text-on-surface/80 font-bold mb-1">{emptyHint}</div>
                <div className="text-[10px] text-on-surface/40">
                  请前往「设置 → 模型」添加并启用至少一个云端服务商。
                </div>
              </div>
            ) : (
              list.map((m) => {
                const isSelected = safeMainModel === m;
                return (
                  <button
                    key={m}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => handleSelect(m)}
                    className={`relative w-full text-left px-3 py-2 rounded-lg text-xs font-semibold flex items-center justify-between select-none cursor-pointer transition-all duration-150 ease-out hover:bg-primary/10 ${
                      isSelected
                        ? 'text-primary font-bold'
                        : 'text-[var(--color-on-surface)]/80 hover:text-[var(--color-on-surface)]'
                    }`}
                  >
                    <span className="relative z-10 flex items-center gap-2">
                      <ModelIcon modelName={m} size={20} className="shrink-0" />
                      <span>{m}</span>
                    </span>
                    {isSelected && (
                      <span
                        className="sf-anim sf-anim-fade-scale relative z-10 w-1.5 h-1.5 rounded-full bg-primary"
                      />
                    )}
                  </button>
                );
              })
            )}
          </div>
        )}
      </MountTransition>
    </div>
  );
}

export const MainModelSelector = memo(MainModelSelectorImpl);
MainModelSelector.displayName = 'MainModelSelector';
