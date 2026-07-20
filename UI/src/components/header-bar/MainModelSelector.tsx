/**
 * MainModelSelector — 顶部主模型下拉 (framer-motion 重构版)
 *
 * 2026-07-02 重构要点:
 *   - 下拉面板改用 framer-motion 椭圆弹出动画 (与 SecondaryModelSelector 风格一致)
 *   - 锚点: 按钮中心 (transformOrigin: '50% 50%')
 *   - 关闭: clipPath ellipse(0% 0% at 50% 50%) + scale 0.6
 *   - 开启: clipPath ellipse(150% 150% at 50% 50%) + scale 1
 *   - backdrop 用 motion.div 透明覆盖, fade-in/fade-out
 *   - Esc 关闭、点击外部关闭、选中关闭 三种关闭路径都走 AnimatePresence exit 动画
 *
 * Props 与旧版一致 (由 Header.tsx 透传)
 */

import React, { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useThemedSurface } from './themeColors';
import { ChevronDown } from '../../utils/icons';
import { ModelIcon } from '../ModelIcon';
import { computeAvailableModels, pickModel } from './mainModelSelectorLogic';
// ★ 2026-07-20: 移除 re-export — export { } from 会导致 Fast Refresh 降级为 full page reload

export interface MainModelSelectorProps {
  mainModel: string;
  onChange: (model: string) => void;
  availableModels: readonly string[];
  /** modelId → { providerId, iconType } 映射, 用于自定义服务商图标与设置页对齐 */
  modelIconMap?: Record<string, { providerId: string; iconType?: string }>;
  draggable?: boolean;
  emptyHint?: string;
  className?: string;
  onOpenChange?: (open: boolean) => void;
}

// iOS 风格弹窗 — spring 驱动 scale + opacity + y, 带 overshoot (与 SecondaryModelSelector 统一)
const panelVariants = {
  hidden: {
    opacity: 0,
    scale: 0.85,
    y: 8,
    transition: {
      duration: 0.12,
      ease: [0.4, 0, 1, 1] as [number, number, number, number],
    },
  },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      type: 'spring' as const,
      stiffness: 320,
      damping: 26,
      mass: 0.8,
      staggerChildren: 0.03,
      delayChildren: 0.05,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: -6 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      type: 'spring' as const,
      stiffness: 400,
      damping: 30,
      mass: 0.6,
    },
  },
};

const backdropVariants = {
  hidden: { opacity: 0, transition: { duration: 0.18, ease: [0.4, 0, 1, 1] as [number, number, number, number] } },
  visible: { opacity: 1, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
};

function MainModelSelectorImpl({
  mainModel,
  onChange,
  availableModels,
  modelIconMap,
  draggable = true,
  emptyHint = '尚未配置可用模型',
  className = '',
  onOpenChange,
}: MainModelSelectorProps) {
  const [open, setOpenState] = useState(false);
  // ref 追踪 open 值, 让 setOpen 能在 updater 外计算新值 (updater 必须是纯函数)
  const openRef = useRef(false);
  const setOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      const v = typeof next === 'function' ? next(openRef.current) : next;
      openRef.current = v;
      setOpenState(v);
      // ★ 必须在 updater 外调用: onOpenChange 会触发父组件 setState,
      //   放在 updater 内会在渲染期间更新父组件 → React 警告
      onOpenChange?.(v);
    },
    [onOpenChange],
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonId = useId();
  const { glass, isDark, rgba } = useThemedSurface();

  const { list, fallback } = computeAvailableModels(availableModels);
  const safeMainModel = list.includes(mainModel) ? mainModel : (fallback ?? mainModel);
  const hasModel = !!safeMainModel;

  // 从 modelIconMap 获取当前模型的 iconType (与设置页对齐)
  const currentIconInfo = hasModel ? modelIconMap?.[safeMainModel] : undefined;

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);

  const handleSelect = useCallback(
    (m: string) => {
      const { next, changed } = pickModel(list, safeMainModel, m);
      if (changed) onChange(next);
      setOpen(false);
    },
    [list, safeMainModel, onChange],
  );

  // Esc 关闭
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

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      close();
    };
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
      <motion.button
        id={buttonId}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="选择主模型"
        onClick={toggle}
        whileTap={{ scale: 0.94 }}
        transition={{ type: 'spring', stiffness: 600, damping: 28 }}
        className="group flex items-center gap-1.5 h-[30px] px-3 rounded-full text-xs text-[var(--color-on-surface)] cursor-pointer font-bold select-none overflow-visible"
        style={{
          // ── Editorial Glass 触发按钮(主题色对齐) ──────────────
          background: isDark
            ? `linear-gradient(180deg, ${rgba('--color-surface-bright', 0.55)} 0%, ${rgba('--color-surface', 0.40)} 100%)`
            : `linear-gradient(180deg, ${rgba('--color-surface', 0.75)} 0%, ${rgba('--color-surface-bright', 0.55)} 100%)`,
          backdropFilter: 'blur(8px) saturate(140%)',
          WebkitBackdropFilter: 'blur(8px) saturate(140%)',
          border: `1px solid ${rgba('--color-primary-rgb', glass.hairlineAlpha)}`,
          boxShadow: `inset 0 1px 0 ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.50)'}`,
          transition: 'background 180ms ease, border-color 180ms ease, box-shadow 180ms ease',
        }}
        whileHover={{
          borderColor: rgba('--color-primary-rgb', glass.hairlineHoverAlpha),
          boxShadow: `inset 0 1px 0 ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.60)'}, 0 0 0 3px ${rgba('--color-primary-rgb', isDark ? 0.10 : 0.14)}`,
        }}
      >
        {hasModel ? (
          <ModelIcon modelName={safeMainModel} size={20} className="shrink-0" iconType={currentIconInfo?.iconType} />
        ) : (
          <div className="shrink-0 w-5 h-5 rounded-full border border-on-surface/20 flex items-center justify-center">
            <span className="text-[10px] text-on-surface/30 font-bold">—</span>
          </div>
        )}
        <div className="h-4 overflow-hidden relative flex items-center justify-center min-w-[84px]">
          <motion.span
            key={safeMainModel || 'empty'}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className={`inline-block whitespace-nowrap ${hasModel ? 'text-primary' : 'text-on-surface/35'}`}
          >
            {hasModel ? safeMainModel : '未选择'}
          </motion.span>
        </div>
        <motion.span
          aria-hidden="true"
          initial={false}
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          className="flex items-center justify-center shrink-0"
        >
          <ChevronDown className="w-3.5 h-3.5 text-on-surface/40" />
        </motion.span>
      </motion.button>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              key="backdrop"
              variants={backdropVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              className="fixed inset-0 z-40 bg-transparent"
              onClick={() => setOpen(false)}
            />

            <motion.div
              key="panel"
              role="listbox"
              aria-labelledby={buttonId}
              variants={panelVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              className="absolute left-0 mt-3.5 w-64 p-1 flex flex-col gap-0.5"
              style={{
                // ── 弹出面板(实色不透明, 主题色对齐) ──────────────────
                transformOrigin: '50% 0%',
                willChange: 'transform, opacity',
                transform: 'translateZ(0)',
                backfaceVisibility: 'hidden',
                WebkitBackfaceVisibility: 'hidden',
                background: isDark ? 'var(--color-surface-bright)' : 'var(--color-surface)',
                border: `1px solid ${rgba('--color-primary-rgb', glass.hairlineAlpha)}`,
                borderRadius: 14,
                boxShadow: `${glass.ambientShadow}, ${glass.tightShadow}, inset 0 1px 0 ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.55)'}`,
                zIndex: 50,
              }}
            >
              {list.length === 0 ? (
                <motion.div
                  variants={itemVariants}
                  className="px-3 py-4 text-center text-[11px] text-on-surface/55 leading-relaxed select-none"
                >
                  <div className="text-on-surface/80 font-bold mb-1">{emptyHint}</div>
                  <div className="text-[10px] text-on-surface/40">
                    请前往「设置 → 模型」添加并启用至少一个云端服务商。
                  </div>
                </motion.div>
              ) : (
                list.map((m) => {
                  const isSelected = safeMainModel === m;
                  const iconInfo = modelIconMap?.[m];
                  return (
                    <motion.button
                      key={m}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      variants={itemVariants}
                      onClick={() => handleSelect(m)}
                      whileHover={{ x: 2 }}
                      transition={{ type: 'spring', stiffness: 700, damping: 30 }}
                      className={`relative w-full text-left px-3 py-2 rounded-lg text-xs font-semibold flex items-center justify-between select-none cursor-pointer hover:bg-primary/10 ${
                        isSelected
                          ? 'text-primary font-bold'
                          : 'text-[var(--color-on-surface)]/80 hover:text-[var(--color-on-surface)]'
                      }`}
                    >
                      <span className="relative z-10 flex items-center gap-2">
                        <ModelIcon modelName={m} size={20} className="shrink-0" iconType={iconInfo?.iconType} />
                        <span>{m}</span>
                      </span>
                      {isSelected && (
                        <motion.span
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          transition={{ type: 'spring', stiffness: 700, damping: 24 }}
                          className="relative z-10 w-1.5 h-1.5 rounded-full bg-primary"
                        />
                      )}
                    </motion.button>
                  );
                })
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

export const MainModelSelector = memo(MainModelSelectorImpl);
MainModelSelector.displayName = 'MainModelSelector';