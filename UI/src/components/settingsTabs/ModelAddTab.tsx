import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Globe, Plus, Search, RefreshCw, Key, Eye, EyeOff, X, Layers, Check, AlertCircle, Radio, Trash2, ChevronDown, ChevronUp, Info, Zap, Clock } from '../../utils/icons';
import * as DndKitCore from '@dnd-kit/core';
import * as DndKitModifiers from '@dnd-kit/modifiers';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, arrayMove, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ModelIcon } from '../ModelIcon';
import { AnimalAvatar, loadIconRegistry, addCustomIconToRegistry, removeIconFromRegistry, processUploadedIcon } from '../AnimalAvatar';
import type { IconRegistryItem } from '../AnimalAvatar';
import { SortableProviderCard, ProviderCardInner } from '../ProviderCard';
import type { ModelProvider, CloudModelScanResult, ModelMetadata, ProbeResult } from '../../data/providersRegistry';
import { getLocalModelMetadata } from '../../data/modelMetadata';

const { DndContext, DragOverlay, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors } = DndKitCore;
const { restrictToVerticalAxis, restrictToFirstScrollableAncestor } = DndKitModifiers;
type DragEndEvent = DndKitCore.DragEndEvent;
type DragStartEvent = DndKitCore.DragStartEvent;

// --- 内置服务商列表（与 providers_db.json 保持同步）---
const BASE_PROVIDERS: ModelProvider[] = [
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
    status: 'idle',
    color: '#ff6700'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    desc: 'GPT 系列大语言模型官方服务商',
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    defaultUrl: 'https://api.openai.com/v1',
    models: [],
    customModels: [],
    status: 'idle',
    color: '#10a37f'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    desc: '深度求索：超高性价比与硬核推理模型商',
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultUrl: 'https://api.deepseek.com/v1',
    models: [],
    customModels: [],
    status: 'idle',
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
    status: 'idle',
    color: '#d97706'
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    desc: 'Google 顶尖多模态基础模型系列',
    enabled: false,
    apiKey: '',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: [],
    customModels: [],
    status: 'idle',
    color: '#1a73e8'
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
    status: 'idle',
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
    status: 'idle',
    color: '#f43f5e'
  },
  // ── 国内大模型厂商 ──
  {
    id: 'qwen',
    name: '通义千问',
    desc: '阿里云百炼平台 · Qwen 系列模型',
    enabled: false,
    apiKey: '',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [],
    customModels: [],
    status: 'idle',
    color: '#615ced'
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    desc: '智谱 AI 开放平台 · GLM 系列模型',
    enabled: false,
    apiKey: '',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [],
    customModels: [],
    status: 'idle',
    color: '#3859ff'
  },
  {
    id: 'wenxin',
    name: '百度文心',
    desc: '百度千帆平台 · ERNIE 系列模型',
    enabled: false,
    apiKey: '',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    defaultUrl: 'https://qianfan.baidubce.com/v2',
    models: [],
    customModels: [],
    status: 'idle',
    color: '#2932e1'
  },
  {
    id: 'doubao',
    name: '字节豆包',
    desc: '火山引擎 · 豆包系列模型',
    enabled: false,
    apiKey: '',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [],
    customModels: [],
    status: 'idle',
    color: '#325ab4'
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    desc: '腾讯云 · 混元大模型系列',
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    defaultUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    models: [],
    customModels: [],
    status: 'idle',
    color: '#0053e0'
  },
  {
    id: 'spark',
    name: '讯飞星火',
    desc: '科大讯飞 · Spark 系列模型',
    enabled: false,
    apiKey: '',
    baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    defaultUrl: 'https://spark-api-open.xf-yun.com/v1',
    models: [],
    customModels: [],
    status: 'idle',
    color: '#0070f0'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    desc: '稀宇科技 · MiniMax / abab 系列模型',
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.minimaxi.com/v1',
    defaultUrl: 'https://api.minimaxi.com/v1',
    models: [],
    customModels: [],
    status: 'idle',
    color: '#ff2d55'
  },
  {
    id: 'baichuan',
    name: '百川智能',
    desc: 'Baichuan 系列大语言模型',
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.baichuan-ai.com/v1',
    defaultUrl: 'https://api.baichuan-ai.com/v1',
    models: [],
    customModels: [],
    status: 'idle',
    color: '#f79420'
  },
  {
    id: 'yi',
    name: '零一万物',
    desc: '01.ai · Yi 系列模型',
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.lingyiwanwu.com/v1',
    defaultUrl: 'https://api.lingyiwanwu.com/v1',
    models: [],
    customModels: [],
    status: 'idle',
    color: '#0094a8'
  },
  {
    id: 'stepfun',
    name: '阶跃星辰',
    desc: 'StepFun · step 系列模型',
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.stepfun.com/v1',
    defaultUrl: 'https://api.stepfun.com/v1',
    models: [],
    customModels: [],
    status: 'idle',
    color: '#7c3aed'
  },
  // ── 国外大模型厂商 ──
  {
    id: 'mistral',
    name: 'Mistral AI',
    desc: 'Mistral · 欧洲开源大模型系列',
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultUrl: 'https://api.mistral.ai/v1',
    models: [],
    customModels: [],
    status: 'idle',
    color: '#ff7000'
  },
  {
    id: 'groq',
    name: 'Groq',
    desc: 'Groq · 超低延迟推理加速平台',
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultUrl: 'https://api.groq.com/openai/v1',
    models: [],
    customModels: [],
    status: 'idle',
    color: '#f55036'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    desc: 'OpenRouter · 统一聚合路由 200+ 模型',
    enabled: false,
    apiKey: '',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultUrl: 'https://openrouter.ai/api/v1',
    models: [],
    customModels: [],
    status: 'idle',
    color: '#6469f1'
  },
  {
    id: 'together',
    name: 'Together AI',
    desc: 'Together · 开源模型托管与推理',
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.together.xyz/v1',
    defaultUrl: 'https://api.together.xyz/v1',
    models: [],
    customModels: [],
    status: 'idle',
    color: '#0f6fff'
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    desc: 'Fireworks · 高速开源模型推理',
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    defaultUrl: 'https://api.fireworks.ai/inference/v1',
    models: [],
    customModels: [],
    status: 'idle',
    color: '#e8330a'
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    desc: 'Perplexity · 联网搜索增强模型',
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.perplexity.ai',
    defaultUrl: 'https://api.perplexity.ai',
    models: [],
    customModels: [],
    status: 'idle',
    color: '#20808d'
  },
  {
    id: 'cohere',
    name: 'Cohere',
    desc: 'Cohere · Command 系列企业级模型',
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.cohere.ai/v1',
    defaultUrl: 'https://api.cohere.ai/v1',
    models: [],
    customModels: [],
    status: 'idle',
    color: '#39594d'
  }
];

const KNOWN_PROVIDER_IDS = new Set(BASE_PROVIDERS.map(p => p.id));

/** 合并已加载数据与 BASE_PROVIDERS：白名单过滤、补齐缺失、排序、清理脏数据 */
function mergeProviders(loaded: any[]): ModelProvider[] {
  // 白名单过滤：只保留已知内置服务商 + 用户创建的 custom_*
  const filtered = loaded.filter((p: any) =>
    p && (KNOWN_PROVIDER_IDS.has(p.id) || String(p.id).startsWith('custom_'))
  );
  const existingIds = new Set(filtered.map((p: any) => p.id));
  const missing = BASE_PROVIDERS.filter(bp => !existingIds.has(bp.id));
  const combined = [...filtered, ...missing];
  const baseOrder = BASE_PROVIDERS.map(bp => bp.id);
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
    const finalName = p.id === 'xiaomi' ? 'XIAOMIMIMO' : p.name;
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
      return { ...p, name: finalName, apiKey: '', status: 'idle' as const, delay: undefined, scanned: p.scanned || false, models: cleanedModels, customModels: cleanedCustomModels };
    }
    return { ...p, name: finalName, scanned: p.scanned || false, models: cleanedModels, customModels: cleanedCustomModels };
  });
}

// 02. 云端大模型服务商配置
export default function ModelAddTab() {
  const serverLoadedRef = useRef(false);

  const [providers, setProviders] = useState<ModelProvider[]>(() => {
    const saved = localStorage.getItem('cherry_providers_v2');
    if (!saved) return BASE_PROVIDERS;
    try {
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) return BASE_PROVIDERS;
      return mergeProviders(parsed);
    } catch (e) {
      console.error('Error loading providers from localStorage', e);
      return BASE_PROVIDERS;
    }
  });

  // 挂载时从服务端加载 providers_db.json（权威数据源）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/providers/config');
        const data = await r.json();
        if (!cancelled && data?.success && Array.isArray(data.providers) && data.providers.length > 0) {
          setProviders(prev => {
            // 服务端为权威源，但保留本地已有的 apiKey
            const serverMap = new Map(data.providers.map((p: any) => [p.id, p]));
            const merged = prev.map(localP => {
              const serverP = serverMap.get(localP.id);
              if (serverP) {
                return { ...serverP, apiKey: localP.apiKey || serverP.apiKey || '' };
              }
              return localP;
            });
            const existingIds = new Set(merged.map(p => p.id));
            for (const sp of data.providers) {
              if (!existingIds.has(sp.id) && !String(sp.id).startsWith('custom_')) merged.push(sp);
            }
            return mergeProviders(merged);
          });
        }
      } catch {
        // 服务端不可用，继续使用 localStorage 数据
      } finally {
        serverLoadedRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 持久化：localStorage + 服务端（等服务端初始加载完成后才开始）
  useEffect(() => {
    if (!serverLoadedRef.current) return;
    const persisted = providers.map((p) => ({ ...p }));
    localStorage.setItem('cherry_providers_v2', JSON.stringify(persisted));
    window.dispatchEvent(new CustomEvent('providers_updated'));
    fetch('/api/providers/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers: persisted }),
    }).catch(() => {});
  }, [providers]);

  const [activeProviderId, setActiveProviderId] = useState<string>('xiaomi');
  const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({});
  const [customModelVal, setCustomModelVal] = useState('');

  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<CloudModelScanResult | null>(null);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [batchProbeTrigger, setBatchProbeTrigger] = useState(0);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);

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
          // 从扫描结果中提取上游原始元数据
          const raw = m.raw || null;
          const localMeta = getLocalModelMetadata(m.id);
          let metadata: ModelMetadata | undefined;
          if (raw || localMeta) {
            metadata = { ...localMeta };
            if (raw) metadata.raw = raw;
          }
          return {
            id: m.id,
            name: m.id,
            enabled: existing ? existing.enabled : false,
            metadata,
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

  // 启用/禁用时自动排序：
  // - 启用：排到列表最顶部（在所有已启用的前面）
  // - 禁用：沉到底部，组内保持原顺序
  // 在同一次 setProviders 中完成，不使用 useEffect 监听，避免无限循环。
  const toggleProviderEnabled = (id: string) => {
    setProviders(prev => {
      const target = prev.find(p => p.id === id);
      if (!target) return prev;
      const newEnabled = !target.enabled;
      const toggled = prev.map(p => p.id === id ? { ...p, enabled: newEnabled } : p);
      if (newEnabled) {
        // 新启用的 → 提到最前面，其余已启用的保持原顺序跟在后面
        const targetItem = toggled.find(p => p.id === id)!;
        const rest = toggled.filter(p => p.id !== id);
        rest.sort((a, b) => {
          if (a.enabled === b.enabled) return 0;
          return a.enabled ? -1 : 1;
        });
        return [targetItem, ...rest];
      } else {
        // 禁用的 → 排序后自然沉到底部
        return toggled.sort((a, b) => {
          if (a.enabled === b.enabled) return 0;
          return a.enabled ? -1 : 1;
        });
      }
    });
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
  // 【服务商列表拖拽 — 与 HistoryAndEditorPanel 完全对齐】
  // 极简实现：无 onDragOver / 无 pulse / 无自定义 auto-scroll / 无 dropAnimation
  // 依靠 dnd-kit 内置 auto-scroll + restrictToFirstScrollableAncestor
  // ==========================================
  const providerScrollRef = useRef<HTMLDivElement>(null);
  const [activeDragProviderId, setActiveDragProviderId] = React.useState<string | null>(null);
  const activeDragProvider = activeDragProviderId ? providers.find(p => p.id === activeDragProviderId) : null;

  const providerReducedMotion = React.useMemo(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);
  const providerItemTransition = providerReducedMotion
    ? 'transform 150ms cubic-bezier(0.22, 1, 0.36, 1)'
    : 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)';

  const providerSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // useCallback — 稳定引用，配合 React.memo 防止拖拽时全量重渲染
  const handleProviderSelect = React.useCallback((id: string) => {
    setActiveProviderId(id);
    setCustomModelVal('');
  }, []);

  const handleProviderDragStart = React.useCallback((event: DragStartEvent) => {
    setActiveDragProviderId(String(event.active.id));
  }, []);

  const handleProviderDragEnd = React.useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragProviderId(null);
    if (!over || active.id === over.id) return;
    const oldIndex = providers.findIndex((p) => p.id === active.id);
    const newIndex = providers.findIndex((p) => p.id === over.id);
    if (oldIndex !== -1 && newIndex !== -1) {
      reorderProviders(arrayMove(providers, oldIndex, newIndex));
    }
  }, [providers]);

  const handleProviderDragCancel = React.useCallback(() => {
    setActiveDragProviderId(null);
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

    // 从图标注册表中分配第一个未被使用的图标
    const registry = loadIconRegistry();
    const usedIconTypes = new Set(
      providers
        .filter(p => p.id.startsWith('custom_') && p.iconType)
        .map(p => p.iconType!)
    );
    const nextItem = registry.find(item => !usedIconTypes.has(item.iconType)) ?? registry[0];

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
      iconType: nextItem?.iconType ?? 'animal:cat',
    };
    setProviders(prev => [...prev, newProvider]);
    setActiveProviderId(newId);
    setCustomModelVal('');
  };

  // 使用 ref 保持稳定引用，配合 React.memo
  const providersRef = useRef(providers);
  providersRef.current = providers;
  const activeProviderIdRef = useRef(activeProviderId);
  activeProviderIdRef.current = activeProviderId;

  const removeCustomProvider = React.useCallback((providerId: string) => {
    if (!providerId.startsWith('custom_')) return;
    const filtered = providersRef.current.filter(p => p.id !== providerId);
    setProviders(filtered);
    if (activeProviderIdRef.current === providerId) {
      setActiveProviderId(filtered[0]?.id ?? 'xiaomi');
    }
  }, []);

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
        modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
        onDragStart={handleProviderDragStart}
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
            className="sf-scroll-contain flex-1 min-h-0 overflow-y-auto p-2.5 select-none relative [&::-webkit-scrollbar]:hidden"
            style={{
              overscrollBehavior: 'contain',
              scrollbarWidth: 'none',
              msOverflowStyle: 'none',
            }}
          >
            <SortableContext items={providers.map((p) => p.id)} strategy={verticalListSortingStrategy}>
              {/* is-dimming 放在 SortableContext 内部，不放在滚动容器上。
                  DragOverlay 用 position:fixed 跟随鼠标，如果 filter/opacity
                  在祖先元素上，fixed 会退化成 absolute，导致 overlay 不跟鼠标。 */}
              <div className={`sf-drag-context space-y-1 ${activeDragProviderId ? 'is-dimming' : ''}`}>
                {providers.map((p) => (
                  <SortableProviderCard
                    key={p.id}
                    provider={p}
                    isSelected={activeProvider.id === p.id}
                    itemTransition={providerItemTransition}
                    onSelect={handleProviderSelect}
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
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => {
                        if (!showModelPicker && activeProvider.models.length === 0) {
                          scanProviderModels(activeProvider.id);
                        }
                        setShowModelPicker(!showModelPicker);
                      }}
                      disabled={!activeProvider.enabled}
                      className="text-[10px] px-3 py-1.5 bg-[var(--color-primary)]/10 hover:bg-[var(--color-primary)]/20 border border-[var(--color-primary)]/20 text-[var(--color-primary)] hover:text-white rounded-lg font-extrabold flex items-center gap-1.5 cursor-pointer transition-all active:scale-95 disabled:opacity-30 disabled:pointer-events-none"
                    >
                      {isScanning ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                      <span>{isScanning ? '获取中...' : '获取模型列表'}</span>
                    </button>
                    <ModelPickerDropdown
                      isOpen={showModelPicker}
                      onClose={() => setShowModelPicker(false)}
                      provider={activeProvider}
                      onAddModel={(modelId) => {
                        setProviders(prev => prev.map(p => {
                          if (p.id === activeProvider.id) {
                            const modelExists = p.models.some(x => x.id === modelId);
                            const updatedModels = modelExists
                              ? p.models.map(x => x.id === modelId ? { ...x, enabled: true } : x)
                              : [...p.models, { id: modelId, name: modelId, enabled: true }];
                            return { ...p, models: updatedModels };
                          }
                          return p;
                        }));
                      }}
                      onRefresh={() => scanProviderModels(activeProvider.id)}
                      isScanning={isScanning}
                    />
                  </div>
                </div>

                {/* ── 浏览器选项卡式模型列表 ── */}
                <ModelTabBar
                  models={dragModels}
                  customModels={activeProvider.customModels.filter(cm => {
                    const idLower = cm.toLowerCase();
                    return !idLower.startsWith('custom-') &&
                           !idLower.includes('placeholder') &&
                           !idLower.includes('dummy') &&
                           !idLower.includes('fake') &&
                           !idLower.includes('test') &&
                           !idLower.includes('temp');
                  })}
                  selectedModelId={selectedModelId}
                  onSelect={setSelectedModelId}
                  onRemoveModel={(modelId) => {
                    toggleModelEnabled(activeProvider.id, modelId);
                    if (selectedModelId === modelId) setSelectedModelId(null);
                  }}
                  onRemoveCustomModel={(modelId) => {
                    removeCustomModel(activeProvider.id, modelId);
                    if (selectedModelId === modelId) setSelectedModelId(null);
                  }}
                />

                {/* ── 模型详情面板 ── */}
                <div className="rounded-xl border border-[var(--color-outline)]/15 bg-[var(--color-surface)]/50 overflow-hidden flex flex-col">
                  {selectedModelId ? (
                    <ModelDetailPanel
                      key={selectedModelId}
                      modelName={selectedModelId}
                      providerBaseUrl={activeProvider.baseUrl || activeProvider.defaultUrl}
                      providerApiKey={activeProvider.apiKey}
                      providerDefaultUrl={activeProvider.defaultUrl}
                      probeTrigger={batchProbeTrigger}
                      onRemove={() => {
                        const isInModels = activeProvider.models.some(m => m.id === selectedModelId && m.enabled);
                        if (isInModels) {
                          toggleModelEnabled(activeProvider.id, selectedModelId);
                        } else {
                          removeCustomModel(activeProvider.id, selectedModelId);
                        }
                        setSelectedModelId(null);
                      }}
                    />
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-on-surface/30 gap-3 p-6">
                      <Info className="w-8 h-8 opacity-30" />
                      <span className="text-xs text-center">点击上方选项卡查看模型详细信息</span>
                    </div>
                  )}
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
                  onClick={() => {
                    testProviderConnection(activeProvider.id);
                    if (dragModels.length > 0 || activeProvider.customModels.length > 0) {
                      setBatchProbeTrigger(Date.now());
                    }
                  }}
                  disabled={!activeProvider.enabled || activeProvider.status === 'loading'}
                  className="px-4 py-2 bg-[var(--color-primary)] hover:opacity-95 text-[var(--color-bg)] font-extrabold text-xs rounded-xl transition-all flex items-center gap-2 active:scale-95 disabled:opacity-40 cursor-pointer shadow-md"
                >
                  {activeProvider.status === 'loading' ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Radio className="w-4 h-4 animate-pulse" />
                  )}
                  <span>测试连通性</span>
                </button>
                <span className="text-[10px] text-on-surface/40 font-medium">
                  测试网络连通性并探测所有已选模型的真实能力
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
        dropAnimation={null}
        zIndex={9999}
      >
        {activeDragProvider ? (
          <div
            className="cursor-grabbing"
            style={{ width: 'var(--sf-overlay-w, auto)', pointerEvents: 'none' }}
          >
            <ProviderCardInner
              provider={activeDragProvider}
              isSelected={activeProvider.id === activeDragProvider.id}
              isOverlayClone
              onSelect={() => {}}
              onDelete={() => {}}
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
// ModelPickerDropdown — 模型选择下拉弹窗
// 点击「获取模型列表」按钮后弹出，展示从服务端扫描到的所有模型
// 每个模型尾部有 + 按钮，点击添加到已选中模型列表
// =====================================================
interface ModelPickerDropdownProps {
  isOpen: boolean;
  onClose: () => void;
  provider: ModelProvider;
  onAddModel: (modelId: string) => void;
  onRefresh: () => void;
  isScanning: boolean;
}

const ModelPickerDropdown: React.FC<ModelPickerDropdownProps> = ({
  isOpen, onClose, provider, onAddModel, onRefresh, isScanning,
}) => {
  const [search, setSearch] = useState('');

  // 打开时重置搜索
  useEffect(() => { if (isOpen) setSearch(''); }, [isOpen]);

  // ESC 关闭
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const selectedIds = new Set(provider.models.filter(m => m.enabled).map(m => m.id));
  const allModels = provider.models;
  const filtered = search.trim()
    ? allModels.filter(m => m.id.toLowerCase().includes(search.trim().toLowerCase()))
    : allModels;

  return createPortal(
    // 全屏遮罩 — 不关闭，仅遮罩
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      {/* 居中弹窗 */}
      <div
        className="sf-anim sf-anim-scale-in bg-[var(--color-surface)] border border-[var(--color-outline)]/25 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: '560px', maxWidth: '90vw', maxHeight: '70vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--color-outline)]/15 bg-[var(--color-bg)]/60">
          <div className="flex items-center gap-2">
            <span className="text-sm font-black text-[var(--color-on-surface)]">选择模型</span>
            <span className="text-[10px] text-on-surface/40 font-medium">{provider.name}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 hover:bg-red-500/10 rounded-lg text-on-surface/50 hover:text-red-400 cursor-pointer transition-all shrink-0"
            title="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 搜索栏 + 刷新 */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-[var(--color-outline)]/10">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-on-surface/30" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索模型名称..."
              autoFocus
              className="w-full text-sm pl-9 pr-3 py-2.5 bg-[var(--color-surface)] border border-[var(--color-outline)]/20 focus:border-[var(--color-primary)] rounded-lg text-[var(--color-on-surface)] outline-none transition-all"
            />
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isScanning}
            className="p-2.5 hover:bg-[var(--color-primary)]/10 rounded-lg text-on-surface/50 hover:text-[var(--color-primary)] cursor-pointer transition-all disabled:opacity-40 shrink-0"
            title="重新获取模型列表"
          >
            <RefreshCw className={`w-4 h-4 ${isScanning ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* 模型列表 */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {isScanning && (
            <div className="flex items-center justify-center py-12 text-on-surface/50">
              <RefreshCw className="w-5 h-5 animate-spin mr-3" />
              <span className="text-sm">正在从服务器获取模型列表...</span>
            </div>
          )}
          {!isScanning && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-on-surface/40 gap-3">
              <Layers className="w-7 h-7 opacity-40" />
              <span className="text-sm">
                {allModels.length === 0 ? '暂无模型数据，点击刷新按钮获取' : '未找到匹配的模型'}
              </span>
            </div>
          )}
          {!isScanning && filtered.map((m) => {
            const isSelected = selectedIds.has(m.id);
            return (
              <div
                key={m.id}
                className={`flex items-center justify-between px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  isSelected
                    ? 'bg-[var(--color-primary)]/5 opacity-60'
                    : 'hover:bg-[var(--color-primary)]/8'
                }`}
              >
                <div className="flex items-center gap-2.5 text-left min-w-0 flex-1">
                  <ModelIcon modelName={m.id} size={24} className="shrink-0" />
                  <span className="font-mono text-[var(--color-on-surface)] font-bold truncate" title={m.id}>{m.id}</span>
                </div>
                <button
                  type="button"
                  onClick={() => !isSelected && onAddModel(m.id)}
                  disabled={isSelected}
                  className={`shrink-0 ml-2 w-8 h-8 rounded-lg flex items-center justify-center font-bold text-base transition-all select-none ${
                    isSelected
                      ? 'bg-emerald-500/15 text-emerald-400 cursor-not-allowed'
                      : 'bg-[var(--color-primary)] text-[var(--color-bg)] hover:scale-110 active:scale-95 cursor-pointer shadow-sm'
                  }`}
                  title={isSelected ? '已添加到已选列表' : '添加到已选列表'}
                >
                  {isSelected ? <Check className="w-4 h-4" /> : '+'}
                </button>
              </div>
            );
          })}
        </div>

        {/* 底部统计 */}
        {!isScanning && (
          <div className="px-5 py-3 border-t border-[var(--color-outline)]/15 bg-[var(--color-bg)]/40 text-xs text-on-surface/40 font-medium flex items-center justify-between">
            <span>共 {allModels.length} 个模型</span>
            <span>已选 {selectedIds.size} 个</span>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};

// =====================================================
// 【可拖拽模型项 — SortableModelItem (含元数据展开面板)】
// 遵循项目 dnd-kit 规范：
//   1. visibility:hidden 隐藏源卡 → 仅 DragOverlay 克隆可见
//   2. GPU 加速 → 消除拖拽卡顿
//   3. 180ms transform 过渡 → 平滑减速
//   4. onPointerDown stopPropagation → 展开按钮/删除按钮不触发拖拽
//   5. 展开面板与拖拽手柄分离，面板内容不参与拖拽
// =====================================================

/** 格式化 token 数 → 人类可读 */
function fmtTokens(n: number | undefined | null): string {
  if (n == null) return '未能探测';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** 格式化价格 → 美元/百万 tokens */
function fmtPrice(p: number | undefined): string {
  if (p == null) return '—';
  if (p === 0) return '免费';
  if (p < 0.01) return `$${p.toFixed(4)}`;
  return `$${p.toFixed(2)}`;
}

/** 能力状态 → 展示文本 + 颜色 */
function fmtCapability(v: boolean | null): { text: string; color: string } {
  if (v === true) return { text: '✓ 支持', color: 'text-emerald-400' };
  if (v === false) return { text: '✗ 不支持', color: 'text-red-400' };
  return { text: '未能探测', color: 'text-on-surface/40' };
}

// =====================================================
// useModelProbe — 探针 hook (SortableModelItem / CustomModelItem 共享)
// 点击展开时自动发起 /api/providers/model-probe 请求
// =====================================================
function useModelProbe(
  name: string,
  providerBaseUrl: string,
  providerApiKey: string,
  providerDefaultUrl: string,
) {
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const probeIdRef = useRef(0);
  const hasProbed = useRef(false);

  const probe = async () => {
    const currentId = ++probeIdRef.current;
    setLoading(true);
    setError(null);
    setProbeResult(null);
    hasProbed.current = false;
    try {
      const r = await fetch('/api/providers/model-probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: providerBaseUrl,
          apiKey: providerApiKey,
          defaultUrl: providerDefaultUrl,
          modelId: name,
        }),
      });
      const data = await r.json();
      if (probeIdRef.current !== currentId) return;
      if (!r.ok || !data.probed) {
        setError(data?.error || `探测失败 (${r.status})`);
      } else {
        setProbeResult(data as ProbeResult);
        hasProbed.current = true;
      }
    } catch (e: any) {
      if (probeIdRef.current !== currentId) return;
      setError(e?.message || '探测请求失败');
    } finally {
      if (probeIdRef.current === currentId) setLoading(false);
    }
  };

  return { probeResult, loading, error, probe };
}

// =====================================================
// ModelTabBar — 浏览器选项卡式模型列表
// 横向排列，支持鼠标滚轮左右滚动，每个选项卡含 logo + 全名 + X关闭
// =====================================================

interface ModelTabBarProps {
  models: { id: string; name: string }[];
  customModels: string[];
  selectedModelId: string | null;
  onSelect: (modelId: string) => void;
  onRemoveModel: (modelId: string) => void;
  onRemoveCustomModel: (modelId: string) => void;
}

const ModelTabBar: React.FC<ModelTabBarProps> = ({
  models,
  customModels,
  selectedModelId,
  onSelect,
  onRemoveModel,
  onRemoveCustomModel,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  // 鼠标滚轮 → 水平滚动
  const handleWheel = (e: React.WheelEvent) => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  };

  const isEmpty = models.length === 0 && customModels.length === 0;

  return (
    <div
      ref={scrollRef}
      onWheel={handleWheel}
      className="flex items-center gap-1 overflow-x-auto overflow-y-hidden py-1.5 px-1 rounded-lg bg-[var(--color-bg)]/40 border border-[var(--color-outline)]/10"
      style={{
        scrollbarWidth: 'thin',
        msOverflowStyle: 'none',
      }}
    >
      {/* 隐藏 webkit 滚动条但保留滚动功能 */}
      <style>{`.model-tabbar-scroll::-webkit-scrollbar { height: 3px; } .model-tabbar-scroll::-webkit-scrollbar-thumb { background: var(--color-outline); border-radius: 2px; }`}</style>

      {isEmpty && (
        <div className="flex items-center gap-1.5 px-3 py-1 text-[11px] text-on-surface/30 italic">
          <Layers className="w-3.5 h-3.5 opacity-40" />
          <span>暂无选中模型，点击上方「获取模型列表」添加</span>
        </div>
      )}

      {/* 已选模型 (来自扫描) */}
      {models.map((model) => {
        const isActive = selectedModelId === model.id;
        return (
          <div
            key={model.id}
            onClick={() => onSelect(model.id)}
            className={`group inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 rounded-t-lg cursor-pointer transition-all whitespace-nowrap select-none border-b-2 ${
              isActive
                ? 'bg-[var(--color-surface)] border-[var(--color-primary)] text-[var(--color-on-surface)]'
                : 'bg-[var(--color-bg)]/60 border-transparent text-on-surface/60 hover:bg-[var(--color-surface)]/60 hover:text-[var(--color-on-surface)] hover:border-[var(--color-outline)]/30'
            }`}
          >
            <ModelIcon modelName={model.name} size={16} className="shrink-0" />
            <span className="font-mono text-[11px] font-bold">{model.name}</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRemoveModel(model.id); }}
              onPointerDown={(e) => e.stopPropagation()}
              className="shrink-0 w-4 h-4 flex items-center justify-center rounded-full text-on-surface/30 hover:text-red-400 hover:bg-red-500/15 transition-all cursor-pointer"
              title="关闭此模型"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        );
      })}

      {/* 自定义登记模型 */}
      {customModels.map((cm) => {
        const isActive = selectedModelId === cm;
        return (
          <div
            key={cm}
            onClick={() => onSelect(cm)}
            className={`group inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 rounded-t-lg cursor-pointer transition-all whitespace-nowrap select-none border-b-2 ${
              isActive
                ? 'bg-[var(--color-surface)] border-[var(--color-primary)] text-[var(--color-on-surface)]'
                : 'bg-[var(--color-primary)]/5 border-transparent text-on-surface/60 hover:bg-[var(--color-surface)]/60 hover:text-[var(--color-on-surface)] hover:border-[var(--color-outline)]/30'
            }`}
          >
            <ModelIcon modelName={cm} size={16} className="shrink-0" />
            <span className="font-mono text-[11px] font-bold">{cm}</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRemoveCustomModel(cm); }}
              onPointerDown={(e) => e.stopPropagation()}
              className="shrink-0 w-4 h-4 flex items-center justify-center rounded-full text-on-surface/30 hover:text-red-400 hover:bg-red-500/15 transition-all cursor-pointer"
              title="关闭此模型"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
};

// =====================================================
// 【模型详情面板 — ModelDetailPanel】
// 点击选项卡后展示服务端返回的全部信息
// =====================================================

interface ModelDetailPanelProps {
  modelName: string;
  providerBaseUrl: string;
  providerApiKey: string;
  providerDefaultUrl: string;
  probeTrigger?: number;
  onRemove: () => void;
}

/** 能力探测结果 → 中文标签 + 状态颜色 */
function capLabel(v: boolean | null): { text: string; color: string; bg: string } {
  if (v === true) return { text: '支持', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' };
  if (v === false) return { text: '不支持', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20' };
  return { text: '未能探测', color: 'text-on-surface/40', bg: 'bg-on-surface/5 border-on-surface/10' };
}

/** 解析错误信息中是否含 429 限流 */
function isRateLimited(errMsg: string | undefined): boolean {
  if (!errMsg) return false;
  return errMsg.includes('429') || errMsg.toLowerCase().includes('too many requests');
}

const ModelDetailPanel: React.FC<ModelDetailPanelProps> = ({
  modelName,
  providerBaseUrl,
  providerApiKey,
  providerDefaultUrl,
  probeTrigger,
  onRemove,
}) => {
  const { probeResult, loading, error, probe } = useModelProbe(modelName, providerBaseUrl, providerApiKey, providerDefaultUrl);
  const prevTriggerRef = useRef(0);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => { probe(); }, []);

  useEffect(() => {
    if (probeTrigger && probeTrigger !== prevTriggerRef.current) {
      prevTriggerRef.current = probeTrigger;
      probe();
    }
  }, [probeTrigger, probe]);

  // 服务器信息条目
  const serverInfoEntries: Array<[string, string]> = React.useMemo(() => {
    const info = probeResult?.serverInfo;
    if (!info || typeof info !== 'object') return [];
    return Object.entries(info)
      .filter(([, v]) => v != null)
      .map(([k, v]) => {
        const labelMap: Record<string, string> = {
          id: '模型 ID',
          object: '对象类型',
          owned_by: '所属厂商',
          owner: '所有者',
          created: '创建时间',
          permission: '权限',
          root: '根模型',
          parent: '父模型',
          description: '描述',
        };
        const label = labelMap[k] || k;
        let val = typeof v === 'object' ? JSON.stringify(v) : String(v);
        if (k === 'created' && /^\d+$/.test(val)) {
          val = new Date(Number(val) * 1000).toLocaleString('zh-CN');
        }
        return [label, val] as [string, string];
      });
  }, [probeResult]);

  // 错误条目
  const errorEntries: Array<[string, string]> = React.useMemo(() => {
    if (!probeResult?.errors) return [];
    const labelMap: Record<string, string> = {
      basic: '基础连通',
      vision: '视觉输入',
      tools: '工具调用',
      json: 'JSON 模式',
      streaming: '流式输出',
      limits: '上下文限制',
      embeddings: '向量嵌入',
    };
    return Object.entries(probeResult.errors)
      .filter(([, v]) => !!v)
      .map(([k, v]) => [labelMap[k] || k, v] as [string, string]);
  }, [probeResult]);

  // usage 条目
  const usageEntries: Array<[string, string]> = React.useMemo(() => {
    if (!probeResult?.usage) return [];
    const labelMap: Record<string, string> = {
      prompt_tokens: '提示 tokens',
      completion_tokens: '完成 tokens',
      total_tokens: '总 tokens',
      prompt_tokens_details: '提示详情',
      completion_tokens_details: '完成详情',
    };
    return Object.entries(probeResult.usage)
      .filter(([, v]) => v != null)
      .map(([k, v]) => [labelMap[k] || k, typeof v === 'object' ? JSON.stringify(v) : String(v)] as [string, string]);
  }, [probeResult]);

  // pricing 条目
  const pricingEntries: Array<[string, string]> = React.useMemo(() => {
    if (!probeResult?.pricing) return [];
    const labelMap: Record<string, string> = {
      prompt: '输入价格',
      completion: '输出价格',
      image: '图片价格',
      request: '请求价格',
    };
    return Object.entries(probeResult.pricing)
      .filter(([, v]) => v != null && v !== '0' && v !== 0)
      .map(([k, v]) => {
        const label = labelMap[k] || k;
        let val = String(v);
        // 价格通常是美元/token，转成更友好的格式
        const num = parseFloat(val);
        if (!isNaN(num) && num > 0 && num < 1) {
          val = `$${num.toFixed(6)} / token ($${(num * 1_000_000).toFixed(2)} / 百万 tokens)`;
        }
        return [label, val] as [string, string];
      });
  }, [probeResult]);

  // 响应头条目
  const headerEntries: Array<[string, string]> = React.useMemo(() => {
    if (!probeResult?.responseHeaders) return [];
    const labelMap: Record<string, string> = {
      'x-ratelimit-limit-requests': '速率限制 (请求)',
      'x-ratelimit-limit-tokens': '速率限制 (tokens)',
      'x-ratelimit-remaining-requests': '剩余请求',
      'x-ratelimit-remaining-tokens': '剩余 tokens',
      'x-ratelimit-reset-requests': '请求重置',
      'x-ratelimit-reset-tokens': 'tokens 重置',
      'x-request-id': '请求 ID',
      'date': '服务器时间',
      'server': '服务器',
      'content-type': '内容类型',
    };
    return Object.entries(probeResult.responseHeaders)
      .map(([k, v]) => [labelMap[k.toLowerCase()] || k, v] as [string, string]);
  }, [probeResult]);

  // 完整原始 JSON
  const [showRawJson, setShowRawJson] = useState(false);
  const rawJsonText = React.useMemo(() => {
    if (!probeResult) return '';
    try { return JSON.stringify(probeResult, null, 2); } catch { return String(probeResult); }
  }, [probeResult]);

  // 是否有 429 限流
  const hasRateLimit = React.useMemo(() => {
    return errorEntries.some(([, v]) => isRateLimited(v));
  }, [errorEntries]);

  return (
    <div className="flex flex-col">
      {/* ── 头部 ── */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--color-outline)]/15 bg-[var(--color-bg)]/40 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <ModelIcon modelName={modelName} size={22} className="shrink-0" />
          <span className="text-sm font-black text-[var(--color-on-surface)] font-mono truncate" title={modelName}>{modelName}</span>
          {loading && <RefreshCw className="w-3.5 h-3.5 animate-spin text-[var(--color-primary)] shrink-0" />}
          {probeResult && !loading && (
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${
              probeResult.probed.basic
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-red-500/15 text-red-400'
            }`}>
              {probeResult.probed.basic ? '连通正常' : '连通失败'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => probe()}
            disabled={loading}
            className="p-1.5 hover:bg-[var(--color-primary)]/10 rounded-lg text-on-surface/50 hover:text-[var(--color-primary)] cursor-pointer transition-all disabled:opacity-40"
            title="重新探测"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="p-1.5 hover:bg-red-500/10 rounded-lg text-on-surface/50 hover:text-red-400 cursor-pointer transition-all"
            title="移除模型"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── 内容区 ── */}
      <div className="p-3 space-y-3">
        {loading && !probeResult && (
          <div className="flex flex-col items-center justify-center h-full text-on-surface/50 gap-2">
            <RefreshCw className="w-6 h-6 animate-spin text-[var(--color-primary)]" />
            <span className="text-xs">正在发送 API 请求探测模型能力...</span>
          </div>
        )}

        {error && !loading && (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>探测失败: {error}</span>
            </div>
            <button type="button" onClick={() => probe()} className="text-[11px] text-[var(--color-primary)] hover:underline font-bold flex items-center gap-1 cursor-pointer">
              <RefreshCw className="w-3 h-3" /> 重新探测
            </button>
          </div>
        )}

        {probeResult && !loading && !error && (
          <>
            {/* 429 限流提示 */}
            {hasRateLimit && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>部分探测项因 API 限流 (429) 未能完成，建议稍后重试</span>
              </div>
            )}

            {/* 探测概览 */}
            <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[var(--color-bg)]/60 border border-[var(--color-outline)]/10">
              <div className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-on-surface/40" />
                <span className="text-[10px] text-on-surface/40 font-bold">探测延迟</span>
                <span className="text-xs font-bold text-[var(--color-on-surface)]">{probeResult.latency}ms</span>
              </div>
              <div className="w-px h-4 bg-[var(--color-outline)]/15" />
              <div className="flex items-center gap-1.5">
                <Radio className="w-3.5 h-3.5 text-on-surface/40" />
                <span className="text-[10px] text-on-surface/40 font-bold">基础对话</span>
                {probeResult.probed.basic
                  ? <span className="text-xs font-bold text-emerald-400">可用</span>
                  : <span className="text-xs font-bold text-red-400">不可用</span>
                }
              </div>
            </div>

            {/* 上下文限制 */}
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1 px-3 py-2 rounded-lg bg-[var(--color-bg)]/60 border border-[var(--color-outline)]/10">
                <span className="text-[10px] font-bold text-on-surface/40 uppercase tracking-wide flex items-center gap-1">
                  <Layers className="w-3 h-3" /> 上下文窗口
                </span>
                <span className={`text-xs font-bold ${probeResult.limits.contextWindow != null ? 'text-[var(--color-on-surface)]' : 'text-on-surface/40'}`}>
                  {probeResult.limits.contextWindow != null ? fmtTokens(probeResult.limits.contextWindow) + ' tokens' : '未能探测'}
                </span>
              </div>
              <div className="flex flex-col gap-1 px-3 py-2 rounded-lg bg-[var(--color-bg)]/60 border border-[var(--color-outline)]/10">
                <span className="text-[10px] font-bold text-on-surface/40 uppercase tracking-wide flex items-center gap-1">
                  <Zap className="w-3 h-3" /> 最大输出
                </span>
                <span className={`text-xs font-bold ${probeResult.limits.maxOutput != null ? 'text-[var(--color-on-surface)]' : 'text-on-surface/40'}`}>
                  {probeResult.limits.maxOutput != null ? fmtTokens(probeResult.limits.maxOutput) + ' tokens' : '未能探测'}
                </span>
              </div>
            </div>

            {/* 能力矩阵 */}
            <div>
              <div className="text-[10px] font-bold text-on-surface/40 uppercase tracking-wide mb-1.5">模型能力</div>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { label: '视觉输入', key: 'vision' as const },
                  { label: 'Function Calling', key: 'tools' as const },
                  { label: 'JSON 模式', key: 'json' as const },
                  { label: '流式输出', key: 'streaming' as const },
                  { label: '向量嵌入', key: 'embeddings' as const },
                ] as const).map(({ label, key }) => {
                  const cap = capLabel(probeResult.probed[key]);
                  const errForCap = probeResult.errors[key];
                  const rateLimited = isRateLimited(errForCap);
                  return (
                    <div key={key} className={`flex items-center justify-between px-3 py-2 rounded-lg border ${cap.bg}`}>
                      <span className="text-[11px] font-bold text-on-surface/70">{label}</span>
                      <div className="flex items-center gap-1.5">
                        {rateLimited && cap.text === '不支持' && (
                          <span className="text-[8px] font-bold text-amber-400 bg-amber-500/15 px-1.5 py-0.5 rounded-full">限流</span>
                        )}
                        <span className={`text-[11px] font-bold ${cap.color}`}>{cap.text}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Token 用量 */}
            {usageEntries.length > 0 && (
              <div>
                <div className="text-[10px] font-bold text-on-surface/40 uppercase tracking-wide mb-1.5">Token 用量 (ping 测试)</div>
                <div className="grid grid-cols-3 gap-2">
                  {usageEntries.map(([label, val]) => (
                    <div key={label} className="flex flex-col gap-0.5 px-3 py-2 rounded-lg bg-[var(--color-bg)]/60 border border-[var(--color-outline)]/10">
                      <span className="text-[9px] font-bold text-on-surface/40">{label}</span>
                      <span className="text-xs font-bold text-[var(--color-on-surface)] font-mono">{val}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 定价信息 */}
            {pricingEntries.length > 0 && (
              <div>
                <div className="text-[10px] font-bold text-on-surface/40 uppercase tracking-wide mb-1.5">定价信息</div>
                <div className="rounded-lg bg-[var(--color-bg)]/60 border border-[var(--color-outline)]/10 divide-y divide-[var(--color-outline)]/8">
                  {pricingEntries.map(([label, val]) => (
                    <div key={label} className="flex items-center gap-3 px-3 py-1.5">
                      <span className="text-[10px] font-bold text-on-surface/40 shrink-0 w-20">{label}</span>
                      <span className="text-[11px] text-[var(--color-on-surface)] font-mono break-all">{val}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 响应头信息 */}
            {headerEntries.length > 0 && (
              <div>
                <div className="text-[10px] font-bold text-on-surface/40 uppercase tracking-wide mb-1.5">响应头 / 限流信息</div>
                <div className="rounded-lg bg-[var(--color-bg)]/60 border border-[var(--color-outline)]/10 divide-y divide-[var(--color-outline)]/8">
                  {headerEntries.map(([label, val]) => (
                    <div key={label} className="flex items-center gap-3 px-3 py-1.5">
                      <span className="text-[10px] font-bold text-on-surface/40 shrink-0 w-28">{label}</span>
                      <span className="text-[11px] text-[var(--color-on-surface)] font-mono break-all">{val}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 服务器信息 */}
            {serverInfoEntries.length > 0 && (
              <div>
                <div className="text-[10px] font-bold text-on-surface/40 uppercase tracking-wide mb-1.5">服务器信息</div>
                <div className="rounded-lg bg-[var(--color-bg)]/60 border border-[var(--color-outline)]/10 divide-y divide-[var(--color-outline)]/8">
                  {serverInfoEntries.map(([label, val]) => (
                    <div key={label} className="flex items-center gap-3 px-3 py-1.5">
                      <span className="text-[10px] font-bold text-on-surface/40 shrink-0 w-20">{label}</span>
                      <span className="text-[11px] text-[var(--color-on-surface)] font-mono break-all">{val}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 探测错误详情 (可折叠) */}
            {errorEntries.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowErrors(v => !v)}
                  className="text-[10px] text-on-surface/40 hover:text-amber-400 font-bold flex items-center gap-1 cursor-pointer transition-colors"
                >
                  {showErrors ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  <span>探测错误详情 ({errorEntries.length})</span>
                </button>
                {showErrors && (
                  <div className="mt-2 max-h-[200px] overflow-y-auto rounded-lg bg-amber-500/5 border border-amber-500/15 p-2.5 space-y-2">
                    {errorEntries.map(([label, val]) => (
                      <div key={label} className="flex flex-col gap-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-bold text-amber-500/70 shrink-0">{label}</span>
                          {isRateLimited(val) && (
                            <span className="text-[8px] font-bold text-amber-400 bg-amber-500/15 px-1.5 py-0.5 rounded-full">429 限流</span>
                          )}
                        </div>
                        <pre className="text-[9px] font-mono text-on-surface/50 whitespace-pre-wrap break-all ml-3">{val}</pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 完整原始 JSON (可折叠) */}
            <div>
              <button
                type="button"
                onClick={() => setShowRawJson(v => !v)}
                className="text-[10px] text-on-surface/40 hover:text-[var(--color-primary)] font-bold flex items-center gap-1 cursor-pointer transition-colors"
              >
                {showRawJson ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                <span>完整原始 JSON</span>
              </button>
              {showRawJson && (
                <pre className="mt-2 max-h-[300px] overflow-y-auto rounded-lg bg-[var(--color-bg)]/80 border border-[var(--color-outline)]/10 p-2.5 text-[9px] font-mono text-on-surface/60 whitespace-pre-wrap break-all">
                  {rawJsonText}
                </pre>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};


// =====================================================
// IconPicker — 自定义服务商图标选择器 (仅限 custom_ 开头的提供商)
// 功能:
//   1. 从图标注册表加载所有可用图标 (内置动物 + 用户上传)
//   2. 鼠标悬停显示动物名称/文件名
//   3. 末尾 "+" 按钮上传自定义图标 (格式检查器自动校验)
//   4. 删除模式: 点击切换按钮 → 所有图标中心出现删除标记
//      再点一次取消删除模式
//   5. 删除后剩余图标自动补位
// =====================================================

const IconPicker: React.FC<{
  providerId: string;
  iconType?: string;
  onChange: (v: string | undefined) => void;
}> = ({ providerId, iconType, onChange }) => {
  const [open, setOpen] = useState(false);
  const [deleteMode, setDeleteMode] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [registry, setRegistry] = useState<IconRegistryItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);

  // 打开面板时加载注册表
  useEffect(() => {
    if (open) {
      setRegistry(loadIconRegistry());
      setUploadError(null);
    }
  }, [open]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setDeleteMode(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // 当前图标展示
  const currentIconType = iconType;
  const isAnimal = currentIconType?.startsWith('animal:');
  const isCustom = currentIconType?.startsWith('custom:');
  const animalId = isAnimal ? currentIconType!.slice(7) : '';
  const customDataUrl = isCustom ? currentIconType!.slice(7) : '';

  // 渲染单个图标缩略图
  const renderIconThumb = (item: IconRegistryItem, size: number) => {
    if (item.type === 'builtin') {
      return <AnimalAvatar id={item.id} size={size} />;
    }
    // custom → 从 iconType 提取 dataUrl
    const dataUrl = item.iconType.startsWith('custom:') ? item.iconType.slice(7) : '';
    return (
      <img
        src={dataUrl}
        alt={item.name}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover' }}
      />
    );
  };

  // 处理文件上传
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const { dataUrl, name } = await processUploadedIcon(file);
      const updated = addCustomIconToRegistry(registry, dataUrl, name);
      setRegistry(updated);
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setUploading(false);
      // 重置 input 以便可以再次上传同一文件
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // 删除图标
  const handleDeleteIcon = (item: IconRegistryItem) => {
    const updated = removeIconFromRegistry(registry, item.id);
    setRegistry(updated);
    // 如果当前 provider 正好用了被删的图标, 重置为默认
    if (iconType === item.iconType) {
      onChange(undefined);
    }
  };

  // 判断当前是否选中
  const isItemSelected = (item: IconRegistryItem) => {
    return item.iconType === currentIconType;
  };

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
        ) : isCustom ? (
          <img src={customDataUrl} alt="icon" style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' }} />
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

      {/* 下拉面板 */}
      {open && (
        <div
          className="absolute top-full left-0 mt-2 z-50 rounded-xl border border-[var(--color-outline)]/20 bg-[var(--color-surface-bright)] shadow-2xl p-3 space-y-2"
          style={{ width: 280 }}
        >
          {/* 头部: 标题 + 删除模式切换 */}
          <div className="flex items-center justify-between px-1">
            <p className="text-[10px] font-bold text-on-surface/50">选择图标</p>
            <button
              type="button"
              onClick={() => setDeleteMode(v => !v)}
              className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md transition-colors cursor-pointer ${
                deleteMode
                  ? 'bg-rose-500/20 text-rose-400 ring-1 ring-rose-500/40'
                  : 'text-on-surface/40 hover:text-rose-400 hover:bg-rose-500/10'
              }`}
              title={deleteMode ? '取消删除模式' : '进入删除模式'}
            >
              <Trash2 className="w-3 h-3" />
              {deleteMode ? '取消删除' : '删除图标'}
            </button>
          </div>

          {/* 上传错误提示 */}
          {uploadError && (
            <div className="text-[10px] text-rose-400 bg-rose-500/10 rounded-md px-2 py-1">
              {uploadError}
            </div>
          )}

          {/* 图标网格 */}
          <div className="grid grid-cols-6 gap-1.5" style={{ maxHeight: 240, overflowY: 'auto' }}>
            {registry.map(item => {
              const selected = isItemSelected(item);
              return (
                <div key={item.id} className="relative">
                  <button
                    type="button"
                    onClick={() => {
                      if (deleteMode) {
                        handleDeleteIcon(item);
                      } else {
                        onChange(item.iconType);
                        setOpen(false);
                      }
                    }}
                    className={`w-full rounded-lg p-1 transition-all ${
                      deleteMode
                        ? 'hover:bg-rose-500/20'
                        : selected
                          ? 'bg-[var(--color-primary)]/20 ring-2 ring-[var(--color-primary)]/40 scale-110'
                          : 'hover:bg-on-surface/8 hover:scale-105'
                    }`}
                    title={item.name}
                  >
                    {renderIconThumb(item, 24)}
                  </button>
                  {/* 删除模式: 中心红色 X */}
                  {deleteMode && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteIcon(item);
                      }}
                      className="absolute inset-0 flex items-center justify-center rounded-lg bg-rose-500/30 hover:bg-rose-500/50 transition-colors"
                      title={`删除 ${item.name}`}
                    >
                      <span className="w-5 h-5 rounded-full bg-rose-500 flex items-center justify-center text-white">
                        <X className="w-3 h-3" />
                      </span>
                    </button>
                  )}
                </div>
              );
            })}

            {/* 末尾 "+" 上传按钮 */}
            {!deleteMode && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="rounded-lg p-1 transition-all hover:bg-[var(--color-primary)]/10 hover:scale-105 flex items-center justify-center"
                style={{ width: '100%', aspectRatio: '1' }}
                title="上传自定义图标"
              >
                {uploading ? (
                  <RefreshCw className="w-5 h-5 animate-spin text-[var(--color-primary)]" />
                ) : (
                  <Plus className="w-5 h-5 text-[var(--color-primary)]" />
                )}
              </button>
            )}
          </div>

          {/* 提示文字 */}
          <p className="text-[9px] text-on-surface/30 px-1">
            {deleteMode ? '点击图标删除，剩余自动补位' : '支持 PNG/JPG/SVG/WebP，非标准尺寸将自动重绘为 64×64'}
          </p>

          {/* 隐藏文件输入 */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif,image/bmp"
            onChange={handleFileUpload}
            style={{ display: 'none' }}
          />
        </div>
      )}
    </div>
  );
};

