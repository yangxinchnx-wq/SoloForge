import React, { useState, useEffect, useRef } from 'react';
import { Globe, Plus, Search, RefreshCw, Key, Eye, EyeOff, X, Layers, Check, AlertCircle, Radio, Trash2 } from '../../utils/icons';
import * as DndKitCore from '@dnd-kit/core';
import * as DndKitModifiers from '@dnd-kit/modifiers';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, arrayMove, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ModelIcon } from '../ModelIcon';
import { AnimalAvatar, ANIMAL_IDS } from '../AnimalAvatar';
import { ProviderCard } from '../ProviderCard';
import type { ModelProvider, CloudModelScanResult } from '../../data/providersRegistry';

const { DndContext, DragOverlay, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors } = DndKitCore;
const { restrictToVerticalAxis } = DndKitModifiers;
type DragEndEvent = DndKitCore.DragEndEvent;
type DragStartEvent = DndKitCore.DragStartEvent;
type DragOverEvent = DndKitCore.DragOverEvent;
type Modifier = DndKitCore.Modifier;

// 02. 云端大模型服务商配置
export default function ModelAddTab() {
  const [providers, setProviders] = useState<ModelProvider[]>(() => {
    const saved = localStorage.getItem('cherry_providers_v2');
    let baseProviders = [
      {
        id: 'xiaomi',
        name: 'XIAOMIMIMO',
        desc: '小米自研多模态与端侧通用智能模型系列',
        enabled: false,
        apiKey: '',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        defaultUrl: 'https://api.xiaomimimo.com/v1',
        models: [],
        customModels: [],
        status: 'idle' as const,
        color: '#ff6700'
      },
      {
        id: 'openai',
        name: 'OpenAI',
        desc: 'GPT 系列大语言模型官方服务商',
        enabled: true,
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        defaultUrl: 'https://api.openai.com/v1',
        models: [],
        customModels: [],
        status: 'idle' as const,
        delay: undefined,
        color: '#10a37f'
      },
      {
        id: 'deepseek',
        name: 'DeepSeek',
        desc: '深度求索：超高性价比与硬核推理模型商',
        enabled: true,
        apiKey: '',
        baseUrl: 'https://api.deepseek.com/v1',
        defaultUrl: 'https://api.deepseek.com/v1',
        models: [],
        customModels: [],
        status: 'idle' as const,
        delay: undefined,
        color: '#0d6efd'
      },
      {
        id: 'anthropic',
        name: 'Anthropic Claude',
        desc: 'Claude 顶尖逻辑和多模态理解专家',
        enabled: false,
        apiKey: '',
        baseUrl: 'https://api.anthropic.com/v1',
        defaultUrl: 'https://api.anthropic.com/v1',
        models: [],
        customModels: [],
        status: 'idle' as const,
        color: '#d97706'
      },
      {
        id: 'siliconflow',
        name: '硅基流动 SiliconFlow',
        desc: '千亿参数模型一键加速接入平台',
        enabled: false,
        apiKey: '',
        baseUrl: 'https://api.siliconflow.cn/v1',
        defaultUrl: 'https://api.siliconflow.cn/v1',
        models: [],
        customModels: [],
        status: 'idle' as const,
        color: '#a855f7'
      },
      {
        id: 'moonshot',
        name: '月之暗面 Kimi',
        desc: '支持超长无损上下文特性的高品质智能服务',
        enabled: false,
        apiKey: '',
        baseUrl: 'https://api.moonshot.cn/v1',
        defaultUrl: 'https://api.moonshot.cn/v1',
        models: [],
        customModels: [],
        status: 'idle' as const,
        color: '#f43f5e'
      }
    ];

    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          // Strip legacy 'groq' provider entries (no longer supported)
          // Also strip old 'custom' placeholder provider and any existing 'custom_' providers
          const filtered = parsed.filter((p: any) => p && p.id !== 'groq' && p.id !== 'custom' && !String(p.id).startsWith('custom_'));
          // Identify any base providers missing from the loaded parsed array, e.g. newly introduced providers like 'xiaomi'
          const existingIds = new Set(filtered.map((p: any) => p.id));
          const missingProviders = baseProviders.filter(bp => !existingIds.has(bp.id));
          const combined = [...filtered, ...missingProviders];

          // Sort combined based on baseOrder to match the exact sequence in baseProviders
          const baseOrder = baseProviders.map(bp => bp.id);
          combined.sort((a, b) => {
            const idxA = baseOrder.indexOf(a.id);
            const idxB = baseOrder.indexOf(b.id);
            if (idxA === -1 && idxB === -1) return 0;
            if (idxA === -1) return 1;
            if (idxB === -1) return -1;
            return idxA - idxB;
          });

          return combined.map((p: any) => {
            const hasFakeKey =
              p.apiKey === 'sk-proj-4jKls9XjLk9AsDFgHJKLaSDFgHJK' ||
              p.apiKey === 'sk-ds-3jPlkHskOlO8asR9AkjsSJdkOsa9' ||
              p.apiKey === 'AIzaSyA4_PklshSjLkaO8skJdKsa9Ska' ||
              (p.apiKey && p.apiKey.startsWith('sk-proj-4jKls9XjLk9As')) ||
              (p.apiKey && p.apiKey.startsWith('sk-ds-')) ||
              (p.apiKey && p.apiKey.startsWith('AIzaSyA4_'));

            // Force XIAOMIMIMO name if it's xiaomi provider
            let finalName = p.name;
            if (p.id === 'xiaomi') {
              finalName = 'XIAOMIMIMO';
            }

            const cleanedModels = (p.scanned && p.models)
              ? p.models.filter((m: any) => {
                  const idLower = m.id.toLowerCase();
                  return !idLower.startsWith('custom-') &&
                         !idLower.includes('placeholder') &&
                         !idLower.includes('dummy') &&
                         !idLower.includes('fake') &&
                         !idLower.includes('test') &&
                         !idLower.includes('temp');
                })
              : [];

            const cleanedCustomModels = (p.scanned && p.customModels)
              ? p.customModels.filter((m: string) => {
                  const idLower = m.toLowerCase();
                  return !idLower.startsWith('custom-') &&
                         !idLower.includes('placeholder') &&
                         !idLower.includes('dummy') &&
                         !idLower.includes('fake') &&
                         !idLower.includes('test') &&
                         !idLower.includes('temp');
                })
              : [];

            if (hasFakeKey) {
              return {
                ...p,
                name: finalName,
                apiKey: '',
                status: 'idle',
                delay: undefined,
                scanned: p.scanned || false,
                models: cleanedModels,
                customModels: cleanedCustomModels
              };
            }
            return {
              ...p,
              name: finalName,
              scanned: p.scanned || false,
              models: cleanedModels,
              customModels: cleanedCustomModels
            };
          });
        }
      } catch (e) {
        console.error('Error loading providers from localStorage', e);
      }
    }
    return baseProviders;
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // WIP: secrets.ts untracked, 暂时按明文持久化 (build 才能通过)
      const persisted = providers.map((p) => ({ ...p }));
      if (cancelled) return;
      localStorage.setItem('cherry_providers_v2', JSON.stringify(persisted));
      window.dispatchEvent(new CustomEvent('providers_updated'));
    })();
    return () => { cancelled = true; };
  }, [providers]);

  const [activeProviderId, setActiveProviderId] = useState<string>('xiaomi');
  const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({});
  const [customModelVal, setCustomModelVal] = useState('');

  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<CloudModelScanResult | null>(null);

  const scanProviderModels = async (providerId: string) => {
    setIsScanning(true);
    setScanResult(null);

    const targetProv = providers.find(p => p.id === providerId);
    if (!targetProv) {
      setIsScanning(false);
      return;
    }

    const { apiKey, baseUrl, defaultUrl } = targetProv;
    const urlToUse = baseUrl || defaultUrl;

    if (!urlToUse || !/^https?:\/\//i.test(urlToUse)) {
      setIsScanning(false);
      setScanResult({
        success: false,
        providerName: targetProv.name,
        discoveredModels: [],
        error: '请先填写「接口重定向网址」(baseUrl)',
      } as any);
      return;
    }

    try {
      const r = await fetch('/api/providers/scan-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: urlToUse, apiKey, defaultUrl }),
      });
      const data = await r.json();
      if (data?.success && Array.isArray(data.models)) {
        const discovered = data.models.map((m: any) => {
          const existing = targetProv.models.find(x => x.id === m.id);
          return {
            id: m.id,
            name: m.id,
            enabled: existing ? existing.enabled : false,
          };
        });
        setScanResult({
          success: true,
          providerName: targetProv.name,
          discoveredModels: discovered,
          latency: data.latency,
        } as any);
        setProviders(prev => prev.map(p =>
          p.id === providerId
            ? { ...p, models: discovered, scanned: true, status: 'success' as const, errorMessage: undefined }
            : p
        ));
      } else {
        setScanResult({
          success: false,
          providerName: targetProv.name,
          discoveredModels: [],
          error: data?.error || '未扫描到任何模型',
        } as any);
        setProviders(prev => prev.map(p =>
          p.id === providerId ? { ...p, status: 'failed' as const, errorMessage: data?.error || '扫描失败' } : p
        ));
      }
    } catch (err: any) {
      setScanResult({
        success: false,
        providerName: targetProv.name,
        discoveredModels: [],
        error: `请求扫描失败: ${err?.message || err}`,
      } as any);
      setProviders(prev => prev.map(p =>
        p.id === providerId ? { ...p, status: 'failed' as const, errorMessage: '扫描请求失败' } : p
      ));
    } finally {
      setIsScanning(false);
    }
  };

  const toggleProviderEnabled = (id: string) => {
    setProviders(prev => prev.map(p => p.id === id ? { ...p, enabled: !p.enabled } : p));
  };

  const updateProviderApiKey = (id: string, val: string) => {
    setProviders(prev => prev.map(p => p.id === id ? { ...p, apiKey: val } : p));
  };

  const updateProviderBaseUrl = (id: string, val: string) => {
    setProviders(prev => prev.map(p => p.id === id ? { ...p, baseUrl: val } : p));
  };

  const updateProviderIconType = (id: string, iconType: string | undefined) => {
    setProviders(prev => prev.map(p => p.id === id ? { ...p, iconType } : p));
  };

  const resetProviderBaseUrl = (id: string) => {
    setProviders(prev => prev.map(p => p.id === id ? { ...p, baseUrl: p.defaultUrl } : p));
  };

  const toggleModelEnabled = (providerId: string, modelId: string) => {
    setProviders(prev => prev.map(p => {
      if (p.id === providerId) {
        return {
          ...p,
          models: p.models.map(m => m.id === modelId ? { ...m, enabled: !m.enabled } : m)
        };
      }
      return p;
    }));
  };

  const reorderModels = (providerId: string, reordered: { id: string; name: string; enabled: boolean }[]) => {
    setProviders(prev => prev.map(p => {
      if (p.id === providerId) {
        // 用 id 集合做差集，避免过滤掉 enabled 但不在 dragModels 中的模型（如 test/fake 占位符）
        const reorderedIds = new Set(reordered.map(m => m.id));
        const leftovers = p.models.filter(m => !reorderedIds.has(m.id));
        return { ...p, models: [...reordered, ...leftovers] };
      }
      return p;
    }));
  };

  const reorderProviders = (reordered: ModelProvider[]) => {
    setProviders(reordered);
  };

  const cloudModelPageRef = useRef<HTMLDivElement>(null);
  const rightWorkspaceRef = useRef<HTMLDivElement>(null);

  // 右侧详情工作区:滚轮接管 + 边界硬钳制(不允许向上/向下溢出)
  useEffect(() => {
    const el = rightWorkspaceRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      // 向上滚到顶:阻止任何向上溢出
      if (e.deltaY < 0 && el.scrollTop <= 0) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // 向下滚到底:阻止任何向下溢出
      if (e.deltaY > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [activeProviderId]);

  // 云端模型 Tab: 接管滚轮 + 边界硬钳制(强制不让外层右侧大容器滚动)
  useEffect(() => {
    const el = cloudModelPageRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const scrollable = target.closest(
        '.overflow-y-auto, .overflow-x-auto, .overflow-auto'
      ) as HTMLElement | null;
      if (scrollable && el.contains(scrollable)) {
        if (e.deltaY !== 0) scrollable.scrollTop += e.deltaY;
        if (e.deltaX !== 0) scrollable.scrollLeft += e.deltaX;
      }
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  // ==========================================
  // 【服务商列表拖拽基础结构 — 对齐主界面 HistoryAndEditorPanel】
  // - sensors: PointerSensor (distance 5) + KeyboardSensor
  // - modifiers: vertical-axis + parent-element + lockAboveFirst (禁止顶出首项)
  // - transition: Apple HIG spring curve (380ms cubic-bezier(0.34,1.56,0.64,1))
  // - drop animation: 260ms cubic-bezier(0.22,1,0.36,1)
  // - reduced-motion: 自动降级到 180/140ms legacy curve，无 spring overshoot
  // - 自定义 window 'mousemove' + rAF 自动滚动 (EDGE=56, MAX_SPEED=14, k=power(d/EDGE,1.6))
  // - visibility:hidden 源卡 + DragOverlay 克隆 → 永不透明
  // - 滚动容器 sf-scroll-contain + sf-drag-context is-dimming → 拖拽中整列变暗
  // - 目标槽 sf-drop-target 蓝色环 + sf-drop-pulse 落下后脉冲
  // ==========================================
  const providerScrollRef = useRef<HTMLDivElement>(null);
  const providerDragMoveHandlerRef = useRef<((ev: MouseEvent) => void) | null>(null);
  const providerWheelHandlerRef = useRef<((ev: WheelEvent) => void) | null>(null);
  const providerDragRafRef = useRef<number | null>(null);
  const [activeDragProviderId, setActiveDragProviderId] = React.useState<string | null>(null);
  const [overProviderId, setOverProviderId] = React.useState<string | null>(null);
  const [pulsingProviderIds, setPulsingProviderIds] = React.useState<Set<string>>(new Set());
  const providerPulseTimerRef = React.useRef<number | null>(null);
  const activeDragProvider = activeDragProviderId ? providers.find(p => p.id === activeDragProviderId) : null;

  // Honour user OS-level motion preference (Apple HIG + WCAG 2.3.3)
  const providerReducedMotion = React.useMemo(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);
  const providerItemTransition = providerReducedMotion
    ? 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)'
    : 'transform 380ms cubic-bezier(0.34, 1.56, 0.64, 1)';
  const providerDropAnimation = React.useMemo(
    () => ({
      duration: providerReducedMotion ? 140 : 260,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)' as const,
    }),
    [providerReducedMotion],
  );

  // Hard-prevent the dragged card from crossing ABOVE the first item.
  const providerLockAboveFirst: Modifier = React.useCallback(
    (args) => {
      const { active, containerNodeRect, activeNodeRect, transform } = args;
      if (!active || !activeNodeRect || !containerNodeRect) return transform;
      const activeId = String(active.id);
      const activeIndex = providers.findIndex((p) => p.id === activeId);
      if (activeIndex <= 0) {
        return { ...transform, y: Math.max(0, transform.y) };
      }
      const projectedTop = activeNodeRect.top + transform.y;
      if (projectedTop < containerNodeRect.top) {
        const dy = containerNodeRect.top - activeNodeRect.top;
        return { ...transform, y: dy };
      }
      return transform;
    },
    [providers],
  );

  const providerSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleProviderDragOver = (event: DragOverEvent) => {
    const overIdStr = event.over ? String(event.over.id) : null;
    if (overIdStr !== overProviderId) setOverProviderId(overIdStr);
  };

  const triggerProviderPulse = (ids: Iterable<string>) => {
    if (providerPulseTimerRef.current !== null) {
      window.clearTimeout(providerPulseTimerRef.current);
    }
    setPulsingProviderIds(new Set(ids));
    providerPulseTimerRef.current = window.setTimeout(() => {
      setPulsingProviderIds(new Set());
      providerPulseTimerRef.current = null;
    }, 600);
  };

  const handleProviderDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = providers.findIndex((p) => p.id === active.id);
      const newIndex = providers.findIndex((p) => p.id === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        reorderProviders(arrayMove(providers, oldIndex, newIndex));
        // Reorder succeeded: pulse slot + 1-hop neighbours for a sense of
        // "wave" sweeping through the affected area of the list.
        const impacted = new Set<string>();
        impacted.add(String(over.id));
        const lower = Math.max(0, Math.min(oldIndex, newIndex) - 1);
        const upper = Math.min(providers.length - 1, Math.max(oldIndex, newIndex) + 1);
        for (let i = lower; i <= upper; i++) {
          if (i !== oldIndex) impacted.add(providers[i].id);
        }
        triggerProviderPulse(impacted);
      }
    } else {
      // No reorder happened (dropped on self, or on no target).
      // Still play a brief pulse on the source card so the user gets
      // visual confirmation that the drag was received and resolved.
      const droppedId = String(active.id);
      if (providers.some((p) => p.id === droppedId)) {
        triggerProviderPulse([droppedId]);
      }
    }
    setActiveDragProviderId(null);
    setOverProviderId(null);
    if (providerDragMoveHandlerRef.current) {
      window.removeEventListener('mousemove', providerDragMoveHandlerRef.current);
      providerDragMoveHandlerRef.current = null;
    }
    if (providerWheelHandlerRef.current) {
      providerScrollRef.current?.removeEventListener('wheel', providerWheelHandlerRef.current);
      providerWheelHandlerRef.current = null;
    }
    if (providerDragRafRef.current !== null) {
      cancelAnimationFrame(providerDragRafRef.current);
      providerDragRafRef.current = null;
    }
  };

  const handleProviderDragStart = (event: DragStartEvent) => {
    setActiveDragProviderId(String(event.active.id));
    // If a previous dragEnd's pulse is still ticking, cancel it so it
    // doesn't fight with the new drag's visuals.
    if (providerPulseTimerRef.current !== null) {
      window.clearTimeout(providerPulseTimerRef.current);
      providerPulseTimerRef.current = null;
    }
    setPulsingProviderIds(new Set());
    // Synchronous addEventListener in handleDragStart (no React effect delay).
    // Apple-style exponential auto-scroll: softer near center, exponential ramp near edge.
    const onMove = (ev: MouseEvent) => {
      if (providerDragRafRef.current !== null) return; // already a frame scheduled
      providerDragRafRef.current = requestAnimationFrame(() => {
        providerDragRafRef.current = null;
        const sc = providerScrollRef.current;
        if (!sc) return;
        const r = sc.getBoundingClientRect();
        const EDGE = 56;
        const MAX_SPEED = 14;
        const py = ev.clientY;
        if (py < r.top + EDGE) {
          const distance = Math.max(0, r.top + EDGE - py);
          const k = Math.pow(distance / EDGE, 1.6);
          sc.scrollTop -= Math.max(1, Math.round(MAX_SPEED * k));
        } else if (py > r.bottom - EDGE) {
          const distance = Math.max(0, py - (r.bottom - EDGE));
          const k = Math.pow(distance / EDGE, 1.6);
          sc.scrollTop += Math.max(1, Math.round(MAX_SPEED * k));
        }
      });
    };
    providerDragMoveHandlerRef.current = onMove;
    window.addEventListener('mousemove', onMove);

    // Block horizontal wheel events (Mac trackpad two-finger horizontal swipe)
    // from being misinterpreted as vertical scroll while dragging.
    const onWheel = (ev: WheelEvent) => {
      if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) * 1.5) {
        ev.preventDefault();
      }
    };
    providerWheelHandlerRef.current = onWheel;
    providerScrollRef.current?.addEventListener('wheel', onWheel, { passive: false });
  };

  const handleProviderDragCancel = () => {
    setActiveDragProviderId(null);
    setOverProviderId(null);
    if (providerDragMoveHandlerRef.current) {
      window.removeEventListener('mousemove', providerDragMoveHandlerRef.current);
      providerDragMoveHandlerRef.current = null;
    }
    if (providerWheelHandlerRef.current) {
      providerScrollRef.current?.removeEventListener('wheel', providerWheelHandlerRef.current);
      providerWheelHandlerRef.current = null;
    }
    if (providerDragRafRef.current !== null) {
      cancelAnimationFrame(providerDragRafRef.current);
      providerDragRafRef.current = null;
    }
    // Defensive: cancel any in-flight pulse from a prior dragEnd that
    // might still be ticking when the user starts a new drag.
    if (providerPulseTimerRef.current !== null) {
      window.clearTimeout(providerPulseTimerRef.current);
      providerPulseTimerRef.current = null;
    }
    setPulsingProviderIds(new Set());
  };

  React.useEffect(() => {
    return () => {
      if (providerDragMoveHandlerRef.current) {
        window.removeEventListener('mousemove', providerDragMoveHandlerRef.current);
        providerDragMoveHandlerRef.current = null;
      }
      if (providerWheelHandlerRef.current) {
        providerScrollRef.current?.removeEventListener('wheel', providerWheelHandlerRef.current);
        providerWheelHandlerRef.current = null;
      }
      if (providerDragRafRef.current !== null) {
        cancelAnimationFrame(providerDragRafRef.current);
        providerDragRafRef.current = null;
      }
      if (providerPulseTimerRef.current !== null) {
        window.clearTimeout(providerPulseTimerRef.current);
        providerPulseTimerRef.current = null;
      }
    };
  }, []);

  const addCustomModel = (providerId: string) => {
    if (!customModelVal.trim()) return;
    setProviders(prev => prev.map(p => {
      if (p.id === providerId) {
        if (!p.customModels.includes(customModelVal.trim())) {
          return {
            ...p,
            customModels: [...p.customModels, customModelVal.trim()]
          };
        }
      }
      return p;
    }));
    setCustomModelVal('');
  };

  const removeCustomModel = (providerId: string, customModelName: string) => {
    setProviders(prev => prev.map(p => {
      if (p.id === providerId) {
        return {
          ...p,
          customModels: p.customModels.filter(m => m !== customModelName)
        };
      }
      return p;
    }));
  };

  const createNewCustomProvider = () => {
    const customCount = providers.filter(p => p.id.startsWith('custom_')).length;
    const newId = `custom_${Date.now()}`;
    const newProvider: ModelProvider = {
      id: newId,
      name: `自定义提供商 #${customCount + 1}`,
      desc: '自定义/中转等兼容 OpenAI 接口标准的第三方服务商',
      enabled: false,
      apiKey: '',
      baseUrl: '',
      defaultUrl: 'http://localhost:3001/v1',
      models: [],
      customModels: [],
      status: 'idle',
      color: '#64748b',
      iconType: 'animal:cat',
    };
    setProviders(prev => [...prev, newProvider]);
    setActiveProviderId(newId);
    setCustomModelVal('');
  };

  const removeCustomProvider = (providerId: string) => {
    const target = providers.find(p => p.id === providerId);
    // 仅允许删除自定义服务商（id 以 custom_ 开头），保护内置服务商
    if (!target || !providerId.startsWith('custom_')) return;
    const filtered = providers.filter(p => p.id !== providerId);
    setProviders(filtered);
    // 如果删除的是当前选中的服务商，回退到第一个
    if (activeProviderId === providerId) {
      setActiveProviderId(filtered[0]?.id ?? 'xiaomi');
    }
  };

  const testProviderConnection = async (providerId: string) => {
    setProviders(prev => prev.map(p => p.id === providerId ? { ...p, status: 'loading', errorMessage: undefined } : p));
    const target = providers.find(p => p.id === providerId);
    if (!target) {
      setProviders(prev => prev.map(p => p.id === providerId ? { ...p, status: 'idle' } : p));
      return;
    }
    if (!target.apiKey || !target.apiKey.trim()) {
      setProviders(prev => prev.map(p => p.id === providerId ? {
        ...p,
        status: 'failed',
        errorMessage: '请先填写 API 密钥'
      } : p));
      return;
    }
    const urlToUse = target.baseUrl || target.defaultUrl;
    if (!urlToUse || !/^https?:\/\//i.test(urlToUse)) {
      setProviders(prev => prev.map(p => p.id === providerId ? {
        ...p,
        status: 'failed',
        errorMessage: '请先填写「接口重定向网址」'
      } : p));
      return;
    }
    try {
      const probeModel = target.models.find(m => m.enabled)?.id || target.customModels[0];
      const r = await fetch('/api/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: urlToUse, apiKey: target.apiKey, defaultUrl: target.defaultUrl, model: probeModel }),
      });
      const data = await r.json();
      if (data?.success) {
        setProviders(prev => prev.map(p => p.id === providerId ? {
          ...p,
          status: 'success',
          delay: data.latency,
          errorMessage: undefined,
        } : p));
      } else {
        setProviders(prev => prev.map(p => p.id === providerId ? {
          ...p,
          status: 'failed',
          errorMessage: data?.error || '连接失败',
        } : p));
      }
    } catch (err: any) {
      setProviders(prev => prev.map(p => p.id === providerId ? {
        ...p,
        status: 'failed',
        errorMessage: `测试请求失败: ${err?.message || err}`,
      } : p));
    }
  };

  const activeProvider = providers.find(p => p.id === activeProviderId) || providers[0];
  const dragModels = activeProvider.enabled ? activeProvider.models.filter((model) => {
    const idLower = model.id.toLowerCase();
    return model.enabled &&
           !idLower.startsWith('custom-') &&
           !idLower.includes('placeholder') &&
           !idLower.includes('dummy') &&
           !idLower.includes('fake') &&
           !idLower.includes('test') &&
           !idLower.includes('temp');
  }) : [];

  return (
    <div
      ref={cloudModelPageRef}
      className="space-y-5 flex flex-col text-left"
    >
      {/* Tab Title Area */}
      <div className="border-b border-[var(--color-outline)]/20 pb-4 shrink-0 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-extrabold text-[var(--color-on-surface)] tracking-wide">云端大模型服务商配置</h3>
          <p className="text-xs text-on-surface/55 mt-1">配置第三方各大语言模型接口，添加特定鉴权并建立安全的 API 路由连接。</p>
        </div>
      </div>

      {/* Main Twin Panel Construction */}
      <DndContext
        sensors={providerSensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, providerLockAboveFirst]}
        onDragStart={handleProviderDragStart}
        onDragOver={handleProviderDragOver}
        onDragEnd={handleProviderDragEnd}
        onDragCancel={handleProviderDragCancel}
      >
      <div
        className="flex min-h-0 bg-[var(--color-bg)]/60 border border-[var(--color-outline)]/20 rounded-2xl overflow-visible"
        style={{ height: 'calc(85vh - 220px)', flexShrink: 0 }}
      >

        {/* Left Sidebar: Provider Cards Selection */}
        <div className="w-[200px] border-r border-[var(--color-outline)]/15 bg-[var(--color-bg)]/80 flex flex-col shrink-0">
          {/* Fixed: Title */}
          <div className="px-5 py-3 text-[10px] text-on-surface/40 font-bold tracking-wider border-b border-[var(--color-outline)]/10 shrink-0">
            模型服务商列表
          </div>

          {/* Scrollable: Provider list only */}
          <div
            ref={providerScrollRef}
            className={`sf-scroll-contain sf-drag-context flex-1 min-h-0 overflow-y-auto p-2.5 select-none relative [&::-webkit-scrollbar]:hidden ${activeDragProviderId ? 'is-dimming' : ''}`}
            style={{
              overscrollBehavior: 'contain',
              willChange: activeDragProviderId ? 'scroll-position' : 'auto',
              scrollbarWidth: 'none',
              msOverflowStyle: 'none',
            }}
          >
            <SortableContext items={providers.map((p) => p.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-1">
                {providers.map((p) => (
                  <ProviderCard
                    key={p.id}
                    provider={p}
                    isSelected={activeProvider.id === p.id}
                    itemTransition={providerItemTransition}
                    isOverTarget={overProviderId === p.id && activeDragProviderId !== p.id}
                    isPulsing={pulsingProviderIds.has(p.id)}
                    onSelect={(id) => {
                      setActiveProviderId(id);
                      setCustomModelVal('');
                    }}
                    onDelete={removeCustomProvider}
                  />
                ))}
              </div>
            </SortableContext>
          </div>

          {/* Fixed: Plus button */}
          <div className="p-2.5 pt-0 shrink-0">
            <button
              onClick={createNewCustomProvider}
              className="sf-press sf-anim sf-anim-fade w-full py-2.5 rounded-xl border border-dashed border-[var(--color-outline)]/20 hover:border-[var(--color-primary)] bg-[var(--color-primary)]/5 hover:bg-[var(--color-primary)]/10 text-[var(--color-primary)] flex items-center justify-center gap-1.5 text-xs font-bold transition-all cursor-pointer shadow-sm"
              title="添加新的自定义模型通道"
            >
              <Plus className="w-4 h-4" />
              <span>添加自定义端点</span>
            </button>
          </div>
        </div>

        {/* Right Workspace: Details Setup Dynamic Form */}
        <div
          ref={rightWorkspaceRef}
          className="flex-1 flex flex-col min-h-0 bg-[var(--color-surface)]/30 overflow-y-auto"
          style={{ overscrollBehavior: 'none' }}
        >
          <div key={activeProvider.id} className="sf-anim sf-anim-slide-up flex-1 flex flex-col p-6 space-y-6">
            {/* Active Provider Info Panel Header */}
            <div className="flex items-center justify-between pb-4 border-b border-[var(--color-outline)]/15 shrink-0">
              <div className="space-y-1">
                <div className="flex items-center gap-3">
                  {/* ── 图标: 内置服务商用固定图标; 自定义服务商(custom_)用图标选择器 ── */}
                  {activeProvider.id.startsWith('custom_') ? (
                    <IconPicker
                      providerId={activeProvider.id}
                      iconType={activeProvider.iconType}
                      onChange={(v) => updateProviderIconType(activeProvider.id, v)}
                    />
                  ) : (
                    <ModelIcon modelName={activeProvider.id} size={28} className="shrink-0" iconType={activeProvider.iconType} />
                  )}
                  <h4 className="text-xl font-black text-[var(--color-on-surface)]">{activeProvider.name}</h4>
                </div>
                <p className="text-xs text-on-surface/50 leading-relaxed">{activeProvider.desc}</p>
              </div>

              {/* Provider Enable Switcher (Custom Styled Slide Toggle) */}
              <div className="flex items-center gap-3 bg-[var(--color-bg)]/80 px-4 py-2 rounded-2xl border border-[var(--color-outline)]/15">
                <button
                  type="button"
                  onClick={() => toggleProviderEnabled(activeProvider.id)}
                  className={`w-11 h-6 rounded-full p-1 transition-colors duration-300 outline-none focus:ring-1 focus:ring-[var(--color-primary)]/20 ${
                    activeProvider.enabled ? 'bg-emerald-500' : 'bg-on-surface/20'
                  }`}
                >
                  <div
                    className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform duration-300 ${
                      activeProvider.enabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>

            <div className={`flex-1 flex flex-col min-h-0 space-y-6 transition-all duration-300 ${
              activeProvider.enabled ? 'opacity-100 filter-none' : 'opacity-35 pointer-events-none filter grayscale-[20%]'
            }`}>
              {/* Detail Form Fields */}
              <div className="space-y-5 flex-1 select-text">

              {/* API Key Master Credential Input */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-xs text-[var(--color-primary)] font-black tracking-wide flex items-center gap-1.5">
                    <Key className="w-4 h-4 text-[var(--color-primary)]" />
                    <span>API 密钥</span>
                    <span className="text-[10px] text-red-500 font-bold">*必填</span>
                  </label>
                  <span className="text-[10px] text-on-surface/40">输入接口开发者密钥以进行多端鉴权</span>
                </div>

                <div className="relative group">
                  <input
                    type={showApiKey[activeProvider.id] ? 'text' : 'password'}
                    value={activeProvider.apiKey || ''}
                    placeholder="在此处输入 API 密钥"
                    disabled={!activeProvider.enabled}
                    onChange={(e) => {
                      updateProviderApiKey(activeProvider.id, e.target.value);
                      if (!activeProvider.enabled && e.target.value.trim().length > 0) {
                        setProviders(prev => prev.map(p => p.id === activeProvider.id ? { ...p, enabled: true } : p));
                      }
                    }}
                    className="w-full text-xs p-3 pr-11 bg-[var(--color-surface-bright)] border-2 border-[var(--color-outline)]/30 focus:border-[var(--color-primary)] rounded-xl text-[var(--color-on-surface)] font-mono outline-none transition-all disabled:opacity-50"
                  />
                  <button
                    type="button"
                    disabled={!activeProvider.enabled}
                    onClick={() => setShowApiKey(prev => ({ ...prev, [activeProvider.id]: !prev[activeProvider.id] }))}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 p-1 text-on-surface/45 hover:text-[var(--color-on-surface)] transition-colors cursor-pointer disabled:opacity-40"
                  >
                    {showApiKey[activeProvider.id] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-[10.5px] text-on-surface/40 pb-1">
                  注：我们将直接调用上游反向代理链路，不会持久化上传或留存您的私密鉴权信息。
                </p>
              </div>

              {/* Redirect Base URL / Gateway Entry */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-xs text-on-surface/85 font-black flex items-center gap-1.5">
                    <Globe className="w-4 h-4 text-on-surface/50" />
                    <span>接口重定向网址</span>
                  </label>
                  {activeProvider.baseUrl !== activeProvider.defaultUrl && (
                    <button
                      type="button"
                      onClick={() => resetProviderBaseUrl(activeProvider.id)}
                      className="text-[10px] text-[var(--color-primary)] hover:underline font-bold cursor-pointer"
                    >
                      恢复默认路径
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  value={activeProvider.baseUrl || ''}
                  placeholder={activeProvider.defaultUrl}
                  disabled={!activeProvider.enabled}
                  onChange={(e) => {
                    updateProviderBaseUrl(activeProvider.id, e.target.value);
                    if (!activeProvider.enabled && e.target.value.trim().length > 0) {
                      setProviders(prev => prev.map(p => p.id === activeProvider.id ? { ...p, enabled: true } : p));
                    }
                  }}
                  className="w-full text-xs p-2.5 bg-[var(--color-surface-bright)] border border-[var(--color-outline)]/20 focus:border-[var(--color-primary)] rounded-xl text-[var(--color-on-surface)] font-mono outline-none transition-all disabled:opacity-50"
                />
              </div>

              {/* Main Model Directory / Grid Checks */}
              <div className="space-y-3 pt-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-on-surface/75 font-black">已选中模型</span>
                  <button
                    type="button"
                    onClick={() => scanProviderModels(activeProvider.id)}
                    disabled={isScanning || !activeProvider.enabled}
                    className="text-[10px] px-3 py-1.5 bg-[var(--color-primary)]/10 hover:bg-[var(--color-primary)]/20 border border-[var(--color-primary)]/20 text-[var(--color-primary)] hover:text-white rounded-lg font-extrabold flex items-center gap-1.5 cursor-pointer transition-all active:scale-95 disabled:opacity-30 disabled:pointer-events-none"
                  >
                    {isScanning ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                    <span>{isScanning ? '获取中...' : '获取模型列表'}</span>
                  </button>
                </div>

                {/* Scanning Output Result Panel */}
                <div className={scanResult ? 'sf-anim sf-anim-fade' : 'sf-anim sf-anim-fade sf-exit'}>
                  {scanResult && (
                    <div
                      className="bg-[var(--color-primary)]/5 border border-[var(--color-primary)]/20 rounded-xl p-3.5 space-y-2.5 overflow-hidden shadow-inner text-left"
                    >
                      <div className="flex justify-between items-center pb-1.5 border-b border-[var(--color-primary)]/15">
                        <span className="text-[11px] font-extrabold text-[var(--color-primary)] flex items-center gap-2">
                          <span>扫描结果：</span>
                        </span>
                        <button
                          onClick={() => {
                            setScanResult(null);
                          }}
                          className="p-1 hover:bg-[var(--color-primary)]/10 rounded-md text-[var(--color-primary)] cursor-pointer transition-colors"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>

                      {/* search and filter removed — keep raw scan output */}
                      <div className="space-y-1.5 max-h-[140px] overflow-y-auto pr-1">
                        {(() => {
                          const list = scanResult.discoveredModels;
                          if (!list || list.length === 0) {
                            return (
                              <p className="text-[11px] text-on-surface/40 py-2.5 text-center">
                                {(scanResult as any).error || '未检索到该端点的公开大模型实例'}
                              </p>
                            );
                          }
                          return list.map((m) => {
                            const isAlreadySelected = activeProvider.models.some(model => model.id === m.id && model.enabled);

                            return (
                              <div key={m.id} className="flex justify-between items-center px-2.5 py-1.5 rounded-lg bg-[var(--color-bg)]/80 border border-[var(--color-outline)]/10 text-[11px]">
                                <div className="flex items-center gap-2 text-left max-w-[80%] truncate">
                                  <ModelIcon modelName={m.id} size={22} className="shrink-0 animate-pulse" />
                                  <span className="font-mono text-on-surface font-extrabold truncate" title={m.id}>{m.id}</span>
                                </div>

                                <div className="flex items-center shrink-0">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (!isAlreadySelected) {
                                        setProviders(prev => prev.map(p => {
                                          if (p.id === activeProvider.id) {
                                            const modelExists = p.models.some(x => x.id === m.id);
                                            const updatedModels = modelExists
                                              ? p.models.map(x => x.id === m.id ? { ...x, enabled: true } : x)
                                              : [...p.models, { id: m.id, name: m.id, enabled: true }];
                                            return { ...p, models: updatedModels };
                                          }
                                          return p;
                                        }));
                                      }
                                    }}
                                    disabled={isAlreadySelected}
                                    className={`w-5.5 h-5.5 rounded-md flex items-center justify-center font-bold text-xs transition-all select-none ${
                                      isAlreadySelected
                                        ? 'bg-on-surface/5 text-on-surface/30 cursor-not-allowed'
                                        : 'bg-[var(--color-primary)] text-[var(--color-bg)] hover:scale-105 active:scale-95 cursor-pointer shadow-sm'
                                    }`}
                                    title={isAlreadySelected ? "已选中" : "点击加号将其放入下面已选中模型"}
                                  >
                                    +
                                  </button>
                                </div>
                              </div>
                            );
                          });
                        })()}
                      </div>
                    </div>
                  )}
                </div>

                {/* Model Reorder List */}
                <div className="max-h-[220px] overflow-y-auto pr-1">
                  {activeProvider.models.filter(m => m.enabled).length === 0 && activeProvider.customModels.length === 0 && (
                    <div className="py-6 text-center text-xs text-[var(--color-on-surface)]/40 flex flex-col items-center justify-center gap-1.5 border border-dashed border-[var(--color-outline)]/15 rounded-xl bg-[var(--color-surface-bright)]/10">
                      <Layers className="w-5 h-5 opacity-40 animate-pulse text-[var(--color-primary)]" />
                      <span>暂无选中模型</span>
                    </div>
                  )}
                  {activeProvider.enabled && dragModels.length > 0 && (
                    <DndContext
                      sensors={providerSensors}
                      collisionDetection={closestCenter}
                      modifiers={[restrictToVerticalAxis]}
                      onDragEnd={({ active, over }: DragEndEvent) => {
                        if (!over || active.id === over.id) return;
                        const oldIndex = dragModels.findIndex((m) => m.id === active.id);
                        const newIndex = dragModels.findIndex((m) => m.id === over.id);
                        if (oldIndex !== -1 && newIndex !== -1) {
                          reorderModels(activeProvider.id, arrayMove(dragModels, oldIndex, newIndex));
                        }
                      }}
                    >
                      <SortableContext items={dragModels.map((m) => m.id)} strategy={verticalListSortingStrategy}>
                        <div className="space-y-1.5" style={{ overflow: 'visible' }}>
                          {dragModels.map((model) => (
                            <SortableModelItem
                              key={model.id}
                              id={model.id}
                              name={model.name}
                              onRemove={() => toggleModelEnabled(activeProvider.id, model.id)}
                            />
                          ))}
                        </div>
                      </SortableContext>
                    </DndContext>
                  )}

                  {activeProvider.customModels
                    .filter((cm) => {
                      const idLower = cm.toLowerCase();
                      return !idLower.startsWith('custom-') &&
                             !idLower.includes('placeholder') &&
                             !idLower.includes('dummy') &&
                             !idLower.includes('fake') &&
                             !idLower.includes('test') &&
                             !idLower.includes('temp');
                    })
                    .map((cm) => {
                      return (
                        <div
                          key={cm}
                          className="sf-lift flex items-center justify-between p-2.5 rounded-xl border text-xs bg-[var(--color-primary)]/10 border-[var(--color-primary)]/30 text-[var(--color-on-surface)] shadow-inner"
                        >
                          <div className="flex items-center gap-2 truncate font-mono text-[11.5px] text-left max-w-[80%]">
                            <ModelIcon modelName={cm} size={20} className="shrink-0" />
                            <span className="truncate text-on-surface font-bold" title={cm}>{cm}</span>
                          </div>

                          <div className="flex items-center shrink-0">
                            <button
                              disabled={!activeProvider.enabled}
                              onClick={() => removeCustomModel(activeProvider.id, cm)}
                              className="p-1 hover:bg-red-500/10 rounded-md text-on-surface/40 hover:text-red-400 cursor-pointer transition-colors"
                              title="移除此登记模型"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                </div>

                {/* Manual Custom Model Registration */}
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="text"
                    value={customModelVal}
                    onChange={(e) => setCustomModelVal(e.target.value)}
                    placeholder="自定义模型代码，如 deepseek-ai/DeepSeek-V3"
                    disabled={!activeProvider.enabled}
                    className="flex-1 text-xs px-3 py-2 bg-[var(--color-surface-bright)] border border-[var(--color-outline)]/20 focus:border-[var(--color-primary)] rounded-xl text-[var(--color-on-surface)] font-mono outline-none disabled:opacity-50"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addCustomModel(activeProvider.id);
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => addCustomModel(activeProvider.id)}
                    disabled={!activeProvider.enabled || !customModelVal.trim()}
                    className="px-3.5 py-2 bg-[var(--color-primary)]/15 hover:bg-[var(--color-primary)]/25 border border-[var(--color-primary)]/20 text-[var(--color-primary)] hover:text-white rounded-xl text-xs font-bold transition-all shrink-0 disabled:opacity-20 cursor-pointer"
                  >
                    登记模型
                  </button>
                </div>
              </div>
            </div>

            {/* Connection Diagnostic Testing Probe Footbar */}
            <div className="mt-4 p-4 bg-[var(--color-bg)]/60 border border-[var(--color-outline)]/15 rounded-2xl flex items-center justify-between shrink-0 shadow-inner">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => testProviderConnection(activeProvider.id)}
                  disabled={!activeProvider.enabled || activeProvider.status === 'loading'}
                  className="px-4 py-2 bg-[var(--color-primary)] hover:opacity-95 text-[var(--color-bg)] font-extrabold text-xs rounded-xl transition-all flex items-center gap-2 active:scale-95 disabled:opacity-40 cursor-pointer shadow-md"
                >
                  {activeProvider.status === 'loading' ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Radio className="w-4 h-4 animate-pulse" />
                  )}
                  <span>测试网络连通性</span>
                </button>
                <span className="text-[10px] text-on-surface/40 font-medium">
                  发送链路数据校验包测试延迟与握手响应
                </span>
              </div>

              {/* Testing Status Message */}
              <div className="flex items-center shrink-0">
                {activeProvider.status === 'loading' && (
                  <div className="sf-anim sf-anim-fade text-yellow-400 font-bold text-[11px] flex items-center gap-1.5">
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>线路握手中...</span>
                  </div>
                )}
                {activeProvider.status === 'success' && activeProvider.enabled && (
                  <div className="sf-anim sf-anim-fade text-emerald-400 font-extrabold text-[11px] flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1.5 rounded-lg">
                    <Check className="w-4 h-4" />
                    <span>测试成功 ({activeProvider.delay}毫秒)</span>
                  </div>
                )}
                {activeProvider.status === 'failed' && activeProvider.enabled && (
                  <div className="sf-anim sf-anim-fade text-red-400 font-extrabold text-[11px] flex items-center gap-1.5 bg-red-400/10 border border-red-500/20 px-3 py-1.5 rounded-lg cursor-help shrink-0"
                    title={activeProvider.errorMessage}
                  >
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>握手失败</span>
                  </div>
                )}
                {!activeProvider.enabled && (
                  <div className="text-on-surface/30 text-[11px]">
                    服务商未启用
                  </div>
                )}
              </div>
            </div>
            </div>
        </div>
      </div>

      <DragOverlay
        dropAnimation={providerDropAnimation}
        zIndex={9999}
      >
        {activeDragProvider ? (
          <div
            className="sf-drag-overlay"
            style={{
              width: 'var(--sf-overlay-w, auto)',
              willChange: 'transform',
              transform: 'translateZ(0)',
              backfaceVisibility: 'hidden',
              WebkitBackfaceVisibility: 'hidden',
              contain: 'layout paint style',
              pointerEvents: 'none',
            }}
          >
            <ProviderCard
              provider={activeDragProvider}
              isSelected={activeProvider.id === activeDragProvider.id}
              itemTransition={providerItemTransition}
              isOverlayClone
              onSelect={() => {}}
              onDelete={removeCustomProvider}
            />
          </div>
        ) : null}
      </DragOverlay>

      </div>
      </DndContext>
    </div>
  );
}

// =====================================================
// 【可拖拽模型项 — SortableModelItem】
// 遵循项目 dnd-kit 规范（.trae/rules/project_rules.md）：
//   1. visibility:hidden 隐藏源卡（绝不透明）→ 仅 DragOverlay 克隆可见
//   2. GPU 加速（willChange + backfaceVisibility + contain）→ 消除拖拽卡顿
//   3. 180ms cubic-bezier(0.22,1,0.36,1) transform 过渡 → 平滑减速
//   4. 实色背景 bg-surface（避免半透感）+ 主题 token 颜色
//   5. onPointerDown stopPropagation → 删除按钮不触发拖拽
// =====================================================
interface SortableModelItemProps {
  id: string;
  name: string;
  onRemove: () => void;
}

const SortableModelItem: React.FC<SortableModelItemProps> = ({ id, name, onRemove }) => {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)',
    visibility: isDragging ? 'hidden' : 'visible',
    willChange: isDragging ? 'transform' : 'auto',
    backfaceVisibility: 'hidden',
    WebkitBackfaceVisibility: 'hidden',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="sf-lift flex items-center justify-between p-2.5 rounded-xl border text-xs bg-[var(--color-surface)] border-[var(--color-outline)]/20 text-[var(--color-on-surface)] cursor-grab active:cursor-grabbing touch-none select-none"
    >
      <div className="flex items-center gap-2 truncate pointer-events-none">
        <ModelIcon modelName={name} size={20} className="shrink-0" />
        <span className="truncate font-mono font-bold" title={name}>{name}</span>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        className="p-1 hover:bg-red-500/10 rounded-md text-on-surface/40 hover:text-red-400 cursor-pointer transition-colors pointer-events-auto"
        title="从已选中列表移除"
      >
        <X className="w-3.5 h-3.5" />
            </button>
    </div>
  );
};

// =====================================================
// IconPicker — 自定义服务商图标选择器 (仅限 custom_ 开头的提供商)
// 点击当前图标 → 弹出下拉面板: 12 个内置 SVG 动物头像
// 选中后通过 onChange 回调写入 provider.iconType
// =====================================================

const IconPicker: React.FC<{
  providerId: string;
  iconType?: string;
  onChange: (v: string | undefined) => void;
}> = ({ providerId, iconType, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const currentIcon = iconType ?? 'auto';
  const isAnimal = currentIcon.startsWith('animal:');
  const animalId = isAnimal ? currentIcon.slice(7) : '';

  return (
    <div ref={ref} className="relative shrink-0">
      {/* 当前图标按钮 */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="relative rounded-lg transition-transform hover:scale-105 active:scale-95 cursor-pointer"
        title="点击选择图标"
        style={{ width: 28, height: 28 }}
      >
        {isAnimal ? (
          <AnimalAvatar id={animalId} size={28} />
        ) : (
          <ModelIcon modelName={providerId} size={28} className="shrink-0" iconType={iconType} />
        )}
        {/* 右下角小标识 */}
        <span
          className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full flex items-center justify-center text-[7px] font-bold"
          style={{
            background: 'var(--color-primary)',
            color: '#fff',
            border: '1px solid var(--color-surface)',
          }}
        >
          ▾
        </span>
      </button>

      {/* 下拉面板 — 仅动物头像选择 */}
      {open && (
        <div
          className="absolute top-full left-0 mt-2 z-50 rounded-xl border border-[var(--color-outline)]/20 bg-[var(--color-surface-bright)] shadow-2xl p-3 space-y-2"
          style={{ width: 200 }}
        >
          <p className="text-[10px] font-bold text-on-surface/50 px-1">选择头像</p>
          <div className="grid grid-cols-6 gap-1.5">
            {ANIMAL_IDS.map(aid => {
              const selected = isAnimal && animalId === aid;
              return (
                <button
                  key={aid}
                  type="button"
                  onClick={() => { onChange(`animal:${aid}`); setOpen(false); }}
                  className={`rounded-lg p-1 transition-all ${
                    selected
                      ? 'bg-[var(--color-primary)]/20 ring-2 ring-[var(--color-primary)]/40 scale-110'
                      : 'hover:bg-on-surface/8 hover:scale-105'
                  }`}
                  title={aid}
                >
                  <AnimalAvatar id={aid} size={24} />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

