/**
 * SecondaryModelSelector — 顶部「协同副模型」胶囊按钮 + 椭圆弹出面板 (framer-motion 重构版)
 *
 * 2026-07-02 重构要点:
 *   1. 弹出动画: 用 clip-path: ellipse() 从按钮中心扩散 (macOS Big Sur+ 风格)
 *      - 关闭: clipPath: ellipse(0% 0% at 50% 50%) (收缩到按钮中心一点)
 *      - 开启: clipPath: ellipse(150% 150% at 50% 50%) (扩展到包住整个面板)
 *      - scale 同步 0.6 -> 1, opacity 0 -> 1
 *   2. 内容层: 透明度独立动画, 与 clip 错开 60ms, 让面板有"内容逐出"感
 *   3. AnimatePresence + motion.div 替代 MountTransition, 自动 exit 动画
 *   4. backdrop 用 motion.div + exit 渐出
 *
 * Props: 与原 Header.tsx 内联的 SecondaryModelSelector 一致
 */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Layers, ChevronDown, Minus, Plus, X } from 'lucide-react';
import { ModelIcon } from '../ModelIcon';
import { SecondaryModel } from '../../types';

interface ModelStatus {
  state: 'online' | 'warning' | 'offline';
  message: string;
}

const getProviderIdForModel = (modelName: string): string => {
  const lower = modelName.toLowerCase();
  if (lower.startsWith('milm')) return 'xiaomi';
  if (lower.includes('gpt-') || lower.includes('o1-') || lower.includes('openai')) return 'openai';
  if (lower.includes('deepseek-chat') || lower.includes('deepseek-reasoner') || lower.includes('deepseek-v3') || lower.includes('deepseek-r1')) {
    if (lower.includes('deepseek-ai')) return 'siliconflow';
    return 'deepseek';
  }
  if (lower.includes('claude')) return 'anthropic';
  if (lower.includes('gemini')) return 'gemini';
  if (lower.includes('qwen') || lower.includes('siliconflow')) return 'siliconflow';
  if (lower.includes('moonshot') || lower.includes('kimi')) return 'moonshot';
  if (lower.includes('llama') || lower.includes('mixtral') || lower.includes('gemma')) return 'groq';
  if (lower.includes('(本地)') || lower.includes('local')) return 'local';
  return 'unknown';
};

const getModelStatusResolver = (): ((modelName: string) => ModelStatus) => {
  try {
    const saved = localStorage.getItem('cherry_providers_v2');
    const providers = saved ? JSON.parse(saved) : [];
    const providerMap = Array.isArray(providers)
      ? providers.reduce((acc: Record<string, any>, p: any) => {
          acc[p.id] = p;
          return acc;
        }, {})
      : {};

    return (modelName: string): ModelStatus => {
      const providerId = getProviderIdForModel(modelName);
      if (providerId === 'local') {
        return { state: 'online', message: '本地离线模型，已就绪' };
      }
      const prov = providerMap[providerId];
      if (!prov) {
        return { state: 'warning', message: '服务提供商配置待完善' };
      }
      const isEnabled = !!prov.enabled;
      const hasApiKey = !!(prov.apiKey && prov.apiKey.trim().length > 0);
      const isError = prov.status === 'error';
      if (!isEnabled) {
        return { state: 'offline', message: `提供商 ${prov.name} 未启用` };
      }
      if (!hasApiKey) {
        return { state: 'warning', message: `提供商 ${prov.name} 开启，但未配置密钥` };
      }
      if (isError) {
        return { state: 'offline', message: `提供商 ${prov.name} 服务异常或连接失败` };
      }
      return { state: 'online', message: `提供商 ${prov.name} 服务正常已在线` };
    };
  } catch (e) {
    console.error('Error getting model status map', e);
    return () => ({ state: 'warning', message: '解析服务状态失败' });
  }
};

export interface SecondaryModelSelectorProps {
  secModels: SecondaryModel[];
  allAvailableModelsList: string[];
  addSecModel: (m: string) => void;
  removeSecModel: (mId: string) => void;
  changeSecModelWeight: (idx: number, delta: number) => void;
  setSecModelWeightDirect: (idx: number, val: number) => void;
  updateSecModelAtIndex: (idx: number, value: string) => void;
  onOpenChange?: (open: boolean) => void;
}

// 椭圆弹出动画 variants — macOS Big Sur+ 风格, 从按钮中心扩散
const panelVariants = {
  hidden: {
    clipPath: 'ellipse(0% 0% at 50% 0%)',
    opacity: 0,
    scale: 0.6,
    transition: {
      duration: 0.18,
      ease: [0.4, 0, 1, 1] as [number, number, number, number],
      when: 'afterChildren',
    },
  },
  visible: {
    clipPath: 'ellipse(150% 150% at 50% 0%)',
    opacity: 1,
    scale: 1,
    transition: {
      duration: 0.32,
      ease: [0.16, 1, 0.3, 1] as [number, number, number, number],
      when: 'beforeChildren',
      staggerChildren: 0.04,
      delayChildren: 0.08,
    },
  },
};

const contentVariants = {
  hidden: { opacity: 0, y: -4 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  },
};

const backdropVariants = {
  hidden: { opacity: 0, transition: { duration: 0.15 } },
  visible: { opacity: 1, transition: { duration: 0.2 } },
};

function SecondaryModelSelectorImpl({
  secModels,
  allAvailableModelsList,
  addSecModel,
  removeSecModel,
  changeSecModelWeight,
  setSecModelWeightDirect,
  updateSecModelAtIndex,
  onOpenChange,
}: SecondaryModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // 通知父组件 open 状态 (用于 z-index 协调)
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  const totalWeight = useMemo(
    () => secModels.reduce((acc, curr) => acc + curr.weight, 0),
    [secModels],
  );

  const modelStatusResolver = useMemo(
    () => getModelStatusResolver(),
    // 依赖 secModels 触发重新读取 providers (因为 model 列表变了)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, secModels],
  );

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const toggle = useCallback(() => setOpen((o) => !o), []);

  return (
    <div className={`relative ${open ? 'z-50' : ''}`}>
      <motion.button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="协同副模型"
        whileTap={{ scale: 0.94 }}
        transition={{ type: 'spring', stiffness: 600, damping: 28 }}
        className={`sf-press flex items-center gap-1.5 px-4 h-[30px] rounded-full text-xs font-bold select-none cursor-pointer border whitespace-nowrap flex-nowrap touch-manipulation ${
          open
            ? 'bg-[var(--color-primary)] text-[var(--color-surface)] border-[var(--color-primary)] shadow-lg shadow-primary/25'
            : 'bg-[var(--color-surface)]/60 hover:bg-[var(--color-surface)]/90 text-[var(--color-primary)] border-[var(--color-outline)]/30 hover:border-[var(--color-outline)]/60'
        }`}
        title="点击展开项目副模型控制台"
      >
        <motion.span
          aria-hidden="true"
          initial={false}
          animate={{ rotate: open ? 20 : 0 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          className="flex items-center justify-center shrink-0"
        >
          <Layers className="w-3.5 h-3.5" />
        </motion.span>
        <span>协同副模型</span>
        <motion.span
          aria-hidden="true"
          initial={false}
          animate={{ rotate: open ? 180 : 0, scale: open ? 1.1 : 1 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          className="flex items-center justify-center shrink-0"
        >
          <ChevronDown className="w-3.5 h-3.5 opacity-80" />
        </motion.span>
      </motion.button>

      <AnimatePresence>
        {open && (
          <>
            {/* 透明 backdrop 仅用于承载 click-outside + z-index */}
            <motion.div
              key="backdrop"
              variants={backdropVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              className="fixed inset-0 z-40 cursor-default"
              onClick={() => setOpen(false)}
            />

            {/* 椭圆弹出面板: 关键动画 (clipPath ellipse + scale + opacity) */}
            <motion.div
              key="panel"
              ref={panelRef}
              variants={panelVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              style={{
                transformOrigin: '50% 0%', // 锚点: 按钮底边中心
                willChange: 'clip-path, transform, opacity',
                transform: 'translateZ(0)',
                backfaceVisibility: 'hidden',
                WebkitBackfaceVisibility: 'hidden',
              }}
              className="absolute right-0 mt-3.5 w-80 bg-[var(--color-surface)] border border-[var(--color-outline)]/45 rounded-2xl shadow-[0_24px_64px_rgba(0,0,0,0.15)] p-4 flex flex-col font-sans z-50 text-left cursor-default max-h-[500px]"
              role="dialog"
              aria-label="协同副模型控制台"
            >
              <motion.div variants={contentVariants} className="flex items-center justify-between border-b border-[var(--color-outline)]/20 pb-2.5 mb-3">
                <div className="text-[10px] bg-primary/10 border border-primary/25 text-primary px-2.5 py-0.5 rounded-full font-mono font-bold leading-none">
                  插槽数: {secModels.length}
                </div>
              </motion.div>

              {/* List of active submodel slots */}
              <motion.div
                variants={contentVariants}
                className="flex flex-col gap-2.5 overflow-y-auto max-h-[200px] mb-3 pr-1 scrollbar-thin"
              >
                {secModels.length === 0 ? (
                  <div className="text-center py-5 text-on-surface/40 text-[11px] leading-relaxed border border-dashed border-[var(--color-outline)]/30 rounded-xl bg-[var(--color-surface-bright)]/40 select-none font-sans">
                    暂未添加任何副模型插槽<br />
                    <span className="text-[10px] text-primary/50">请在下方选择模型直接集成</span>
                  </div>
                ) : (
                  secModels.map((sm, idx) => {
                    const percentage = totalWeight > 0 ? Math.round((sm.weight / totalWeight) * 100) : 0;
                    const modelStatus = modelStatusResolver(sm.name);
                    return (
                      <div
                        key={`${sm.id}-${idx}`}
                        className="group/item relative flex flex-col gap-2 bg-[var(--color-surface-bright)]/30 hover:bg-[var(--color-surface-bright)]/60 border border-[var(--color-outline)]/25 hover:border-primary/45 rounded-xl p-2.5 transition-all duration-200"
                      >
                        {/* Row 1: Model Slot identity & Dropdown Selector & Delete */}
                        <div className="flex items-center justify-between min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-[8px] font-mono font-bold text-primary/70 bg-primary/10 px-1.5 py-0.5 rounded shrink-0">
                              通道 {String(idx + 1).padStart(2, '0')}
                            </span>

                            <div className="relative flex items-center gap-1.5 bg-[var(--color-surface)] hover:bg-[var(--color-surface-bright)] border border-[var(--color-outline)]/30 rounded px-2 py-[3px] cursor-pointer outline-none transition-all">
                              <ModelIcon modelName={sm.name} size={20} className="shrink-0" />
                              <select
                                value={sm.name}
                                onChange={(e) => {
                                  updateSecModelAtIndex(idx, e.target.value);
                                }}
                                onClick={(e) => e.stopPropagation()}
                                className="text-[11px] font-bold text-[var(--color-primary)] hover:text-[var(--color-on-surface)] bg-transparent border-none py-0 cursor-pointer outline-none transition-all appearance-none pr-4 font-sans block select-none"
                                style={{
                                  backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='m4 6 4 4 4-4'/></svg>")`,
                                  backgroundRepeat: 'no-repeat',
                                  backgroundPosition: 'right 0px center',
                                  backgroundSize: '8px',
                                }}
                                title="选择并切换此插槽的副模型"
                              >
                                {allAvailableModelsList.map((m) => (
                                  <option key={m} value={m} className="bg-[var(--color-surface)] text-[var(--color-on-surface)] font-sans">
                                    {m}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>

                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              removeSecModel(sm.id);
                            }}
                            className="text-on-surface/40 hover:text-red-400 p-1 rounded-md hover:bg-red-500/10 transition-colors cursor-pointer shrink-0 ml-4"
                            title="移除此副模型槽位"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        {/* Row 2: weight slider */}
                        <div className="flex items-center gap-1.5 bg-[var(--color-surface)]/60 rounded-lg p-1.5 border border-[var(--color-outline)]/20">
                          <span className="text-[10px] text-primary/70 font-sans font-bold w-12 select-none shrink-0 border-none">
                            权重: {sm.weight}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              changeSecModelWeight(idx, -1);
                            }}
                            disabled={sm.weight <= 1}
                            className="p-1 rounded bg-[var(--color-surface)]/40 hover:bg-[var(--color-surface-bright)] text-[var(--color-on-surface)] hover:text-primary disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[var(--color-on-surface)] transition-all cursor-pointer active:scale-90"
                            title="降低本槽位调用权重"
                          >
                            <Minus className="w-2.5 h-2.5" />
                          </button>
                          <input
                            type="range"
                            min="1"
                            max="10"
                            step="1"
                            value={sm.weight}
                            onChange={(e) => {
                              e.stopPropagation();
                              setSecModelWeightDirect(idx, parseInt(e.target.value));
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="flex-1 h-1 rounded-lg appearance-none cursor-pointer bg-[var(--color-outline)]/30 block w-full focus:outline-none"
                            style={{ accentColor: 'var(--color-primary)' }}
                          />
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              changeSecModelWeight(idx, 1);
                            }}
                            disabled={sm.weight >= 10}
                            className="p-1 rounded bg-[var(--color-surface)]/40 hover:bg-[var(--color-surface-bright)] text-[var(--color-on-surface)] hover:text-primary disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[var(--color-on-surface)] transition-all cursor-pointer active:scale-90"
                            title="提升本槽位调用权重"
                          >
                            <Plus className="w-2.5 h-2.5" />
                          </button>

                          <div className="text-[9px] bg-emerald-500/10 border border-emerald-500/25 text-emerald-600 dark:text-emerald-400 font-mono font-bold rounded px-1.5 min-w-[34px] text-center select-none">
                            {percentage}%
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </motion.div>

              {/* Add slot section */}
              <motion.div
                variants={contentVariants}
                className="border-t border-[var(--color-outline)]/20 pt-3 flex flex-col"
              >
                <span className="text-[9px] text-on-surface/40 font-mono font-bold uppercase tracking-widest mb-2 leading-none">
                  添加副模型槽位
                </span>
                <div className="grid grid-cols-2 gap-1.5 py-0.5 max-h-[120px] overflow-y-auto pr-1">
                  {allAvailableModelsList
                    .filter((m) => !secModels.some((sm) => sm.name === m))
                    .map((m) => {
                      const addModelStatus = modelStatusResolver(m);
                      return (
                        <button
                          key={m}
                          onClick={() => {
                            addSecModel(m);
                          }}
                          className="text-left px-2.5 py-1.5 bg-[var(--color-surface-bright)]/40 hover:bg-primary/10 border border-[var(--color-outline)]/20 hover:border-primary/30 text-[10px] text-[var(--color-on-surface)]/80 hover:text-primary transition-all duration-200 rounded-lg cursor-pointer truncate font-semibold shadow-sm flex items-center gap-1.5"
                          title={`追加 ${m}`}
                        >
                          <ModelIcon modelName={m} size={16} className="shrink-0" />
                          <span className="truncate">+ {m}</span>
                        </button>
                      );
                    })}
                  {allAvailableModelsList.filter((m) => !secModels.some((sm) => sm.name === m)).length === 0 && (
                    <span className="col-span-2 text-[10px] text-on-surface/35 italic text-center py-2 bg-[var(--color-surface-bright)]/40 border border-dashed border-[var(--color-outline)]/20 rounded-lg">
                      已集成所有可用模型 ⚡
                    </span>
                  )}
                </div>
              </motion.div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

export const SecondaryModelSelector = memo(SecondaryModelSelectorImpl);
SecondaryModelSelector.displayName = 'SecondaryModelSelector';