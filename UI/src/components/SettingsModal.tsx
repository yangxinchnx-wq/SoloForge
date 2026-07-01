import React, { useState, useEffect, useRef } from 'react';
import { 
  X, Globe, PlusCircle, Laptop, Cpu, Code2, GitBranch, 
  ShieldCheck, Brain, Download, Navigation, Database, Share2, Save,
  Check, AlertCircle, Play, Pause, Trash2, Edit2, 
  Search, RefreshCw, Layers, Plus, Terminal, Heart, Eye, EyeOff, DownloadCloud, FileText, Link2, Key, Radio, ShieldAlert, Settings,
  Mic, Wrench, Film, Type, Compass, Sliders, Flame
} from 'lucide-react';
import { motion, AnimatePresence, Reorder } from 'motion/react';
import * as DndKitCore from '@dnd-kit/core';
import * as DndKitModifiers from '@dnd-kit/modifiers';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
const { DndContext, DragOverlay, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors } = DndKitCore;
const { restrictToVerticalAxis, restrictToParentElement } = DndKitModifiers;
type DragEndEvent = DndKitCore.DragEndEvent;
type DragStartEvent = DndKitCore.DragStartEvent;
import { ModelIcon } from './ModelIcon';
import { NormalIcon, PerformanceIcon, ExpertIcon, UltimateIcon } from './ChatPanel';
import { useTheme, PRESET_FONTS } from '../context/ThemeContext';

const PROVIDER_MODEL_REGISTRY: Record<string, { id: string; name: string }[]> = {
  xiaomi: [
    { id: 'milm-pro', name: 'milm-pro' },
    { id: 'milm-6b', name: 'milm-6b' },
    { id: 'milm-1.3b', name: 'milm-1.3b' }
  ],
  openai: [
    { id: 'gpt-4o', name: 'gpt-4o' },
    { id: 'gpt-4o-mini', name: 'gpt-4o-mini' },
    { id: 'gpt-4-turbo', name: 'gpt-4-turbo' },
    { id: 'o1-preview', name: 'o1-preview' },
    { id: 'o1-mini', name: 'o1-mini' }
  ],
  deepseek: [
    { id: 'deepseek-chat', name: 'deepseek-chat' },
    { id: 'deepseek-reasoner', name: 'deepseek-reasoner' }
  ],
  anthropic: [
    { id: 'claude-3-5-sonnet', name: 'claude-3-5-sonnet' },
    { id: 'claude-3-5-haiku', name: 'claude-3-5-haiku' },
    { id: 'claude-3-opus', name: 'claude-3-opus' }
  ],
  gemini: [
    { id: 'gemini-1.5-pro', name: 'gemini-1.5-pro' },
    { id: 'gemini-1.5-flash', name: 'gemini-1.5-flash' },
    { id: 'gemini-2.0-flash-exp', name: 'gemini-2.0-flash-exp' }
  ],
  siliconflow: [
    { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen/Qwen2.5-72B-Instruct' },
    { id: 'deepseek-ai/DeepSeek-V3', name: 'deepseek-ai/DeepSeek-V3' },
    { id: 'deepseek-ai/DeepSeek-R1', name: 'deepseek-ai/DeepSeek-R1' }
  ],
  moonshot: [
    { id: 'moonshot-v1-8k', name: 'moonshot-v1-8k' },
    { id: 'moonshot-v1-32k', name: 'moonshot-v1-32k' }
  ],
  custom: []
};

// =====================================================
// 【左面板可拖拽服务商卡片】
// 与 HistoryAndEditorPanel 中 history 项使用同一套 dnd-kit 设计：
//   1. visibility:hidden 隐藏源卡 → 仅 DragOverlay 克隆可见（绝不透明）
//   2. outer / overlay / scroll container 三处 GPU 加速
//   3. modifiers = [restrictToVerticalAxis, restrictToParentElement]
//   4. window 'mousemove' 自定义 auto-scroll（ref 同步绑定，不依赖 React 调度）
//   5. transform 180ms cubic-bezier(0.22,1,0.36,1)，drop animation 140ms
// 不下阴影（用户要求）：
//   - 完全移除 shadow-* / boxShadow / drop-shadow，仅保留主题色 border + bg-surface/bright 区分状态
// =====================================================
interface ProviderCardProps {
  provider: ModelProvider;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
}

const ProviderCard = React.forwardRef<HTMLDivElement, ProviderCardProps>(
  ({ provider, isSelected, onSelect, onDelete }, ref) => {
    const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: provider.id });
    const [showDelHint, setShowDelHint] = React.useState(false);
    const isCustom = provider.id.startsWith('custom_');

    const dndTransition = transition || 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)';
    const style: React.CSSProperties = {
      transform: CSS.Transform.toString(transform),
      transition: dndTransition,
      cursor: isDragging ? 'grabbing' : 'grab',
      visibility: isDragging ? 'hidden' : 'visible',
      willChange: isDragging ? 'transform' : 'auto',
      backfaceVisibility: 'hidden',
      WebkitBackfaceVisibility: 'hidden',
    };

    return (
      <div
        ref={(node) => {
          setNodeRef(node);
          if (typeof ref === 'function') ref(node);
          else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }}
        style={style}
        data-provider-id={provider.id}
        {...attributes}
        {...listeners}
        onClick={(e) => {
          if (isDragging) { e.preventDefault(); e.stopPropagation(); return; }
          onSelect(provider.id);
        }}
        className="w-full relative select-none cursor-pointer touch-none box-border block focus:outline-none outline-none rounded-xl"
      >
        <div
          onMouseEnter={() => setShowDelHint(true)}
          onMouseLeave={() => setShowDelHint(false)}
          className={`w-full flex items-center justify-between text-left px-3 py-3 rounded-xl text-xs font-semibold cursor-pointer active:cursor-grabbing border transition-colors duration-200 ${
            isSelected
              ? provider.enabled
                ? 'bg-[var(--color-surface-bright)] border-[var(--color-primary)] text-[var(--color-primary)] font-black'
                : 'bg-[var(--color-surface)] border-on-surface/30 text-on-surface/55 font-black'
              : provider.enabled
                ? 'bg-[var(--color-surface)] border-transparent text-[var(--color-on-surface)]/75 hover:bg-[var(--color-surface-bright)]/40 hover:text-[var(--color-on-surface)] hover:border-[var(--color-primary)]/30'
                : 'bg-[var(--color-surface)] border-transparent text-[var(--color-on-surface)]/35 hover:text-[var(--color-on-surface)]/50'
          }`}
        >
          <div className="flex items-center gap-2.5 truncate pointer-events-none">
            {provider.id === 'custom' && !isCustom ? (
              <Plus className="shrink-0 opacity-65" style={{ width: 22, height: 22 }} />
            ) : (
              <ModelIcon modelName={provider.id} size={22} className="shrink-0" />
            )}
            <span className="truncate">{provider.name}</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 pointer-events-none">
            {provider.enabled && provider.status === 'success' && provider.delay && (
              <span className="text-[10px] bg-emerald-500/10 text-emerald-400 font-mono px-1 rounded-sm scale-90 shrink-0">
                {provider.delay}毫秒
              </span>
            )}
            {isCustom && onDelete && showDelHint && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onDelete(provider.id);
                }}
                onPointerDown={(e) => { e.stopPropagation(); }}
                onMouseDown={(e) => { e.stopPropagation(); }}
                className="p-1 rounded-md text-on-surface/40 hover:text-rose-400 transition-colors cursor-pointer pointer-events-auto"
                title="删除此自定义通道"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
);
ProviderCard.displayName = 'ProviderCard';

// 仅在文本溢出时接管滚轮,横向滚动,边界硬钳制,不影响行拖拽
const ScrollableText: React.FC<{ children: React.ReactNode; className?: string; title?: string }> = ({ children, className, title }) => {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!el) return;
      // 未溢出就完全放行,让事件继续传给父级滚动容器
      if (el.scrollWidth <= el.clientWidth + 1) return;
      e.preventDefault();
      e.stopPropagation();
      // 优先 deltaY(普通滚轮),其次 deltaX(水平触摸板/水平滚轮)
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      const maxScroll = el.scrollWidth - el.clientWidth;
      const next = el.scrollLeft + delta;
      el.scrollLeft = Math.max(0, Math.min(maxScroll, next));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);
  return (
    <span
      ref={ref}
      title={title}
      className={`block overflow-x-auto overflow-y-hidden whitespace-nowrap max-w-full pointer-events-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] ${className || ''}`}
    >
      {children}
    </span>
  );
};

interface SettingsModalProps {
  onClose: () => void;
  initialTabId?: string;
  permissionMode?: 'normal' | 'performance' | 'ultimate' | 'expert';
}

interface TabItem {
  id: string;
  label: string;
  icon: React.ComponentType<any>;
  dir: string;
}

export default function SettingsModal({ 
  onClose,
  initialTabId = 'language',
  permissionMode = 'normal'
}: SettingsModalProps) {
  const getRuleTabIcon = () => {
    switch (permissionMode) {
      case 'performance':
        return PerformanceIcon;
      case 'expert':
        return ExpertIcon;
      case 'ultimate':
        return UltimateIcon;
      case 'normal':
      default:
        return NormalIcon;
    }
  };

  // 11 Geek System Settings on Left (with removed and remaining numbered 01 to 11)
  const [tabs, setTabs] = useState<TabItem[]>([
    { id: 'language', label: '01. 界面语言', icon: Globe, dir: '01_language' },
    { id: 'model-add', label: '02. 云端模型', icon: PlusCircle, dir: '02_model-add' },
    { id: 'local-model', label: '03. 本地模型', icon: Laptop, dir: '03_local-model' },
    { id: 'mcp', label: '04. MCP 工具', icon: Cpu, dir: '04_mcp' },
    { id: 'environment', label: '05. 运行环境', icon: Code2, dir: '05_environment' },
    { id: 'skills-rules', label: '06. 智能规则', icon: ShieldCheck, dir: '07_skills-rules' },
    { id: 'memory', label: '07. 记忆体设置', icon: Layers, dir: '08_memory' },
    { id: 'proxy', label: '08. 网络代理', icon: Navigation, dir: '10_proxy' },
    { id: 'knowledge-base', label: '09. 知识库', icon: Database, dir: '11_knowledge-base' },
    { id: 'channels', label: '10. 消息连接', icon: Share2, dir: '12_channels' },
    { id: 'data-management', label: '11. 数据备份', icon: Save, dir: '13_data-management' }
  ]);

  const [activeTabId, setActiveTabId] = useState(initialTabId);
  const [selectedLang, setSelectedLang] = useState(() => localStorage.getItem('soloforge_lang') || 'zh-CN');

  const changeLanguage = (lang: string) => {
    setSelectedLang(lang);
    localStorage.setItem('soloforge_lang', lang);
    try {
      const channel = new BroadcastChannel('soloforge-editor-sync-channel');
      channel.postMessage({
        type: 'TOAST',
        toast: lang === 'zh-CN' ? '🇨🇳 选中的显示语言已变更为: 简体中文 (已即时应用)' : '🇺🇸 Preferred language updated: English (US) (Instant load-out applied)'
      });
      channel.close();
    } catch (e) {
      console.warn(e);
    }
  };

  const { customFonts, selectedFont, addCustomFont, deleteCustomFont, setSelectedFont } = useTheme();
  const fontInputRef = React.useRef<HTMLInputElement>(null);

  useEffect(() => {
    // If the initial target tab was theme or font, default to language
    if (initialTabId === 'theme' || initialTabId === 'font-settings') {
      setActiveTabId('language');
    } else if (initialTabId) {
      setActiveTabId(initialTabId);
    }
  }, [initialTabId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [onClose]);



  // Tab 2: Model Add (Fully refactored based on Cherry Studio's robust multi-provider layout)
  interface ModelProvider {
    id: string;
    name: string;
    desc: string;
    enabled: boolean;
    apiKey: string;
    baseUrl: string;
    defaultUrl: string;
    models: { id: string; name: string; enabled: boolean }[];
    customModels: string[];
    status: 'idle' | 'loading' | 'success' | 'failed';
    delay?: number;
    errorMessage?: string;
    color: string;
    scanned?: boolean;
  }

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
        id: 'gemini',
        name: 'Google Gemini',
        desc: 'Google 顶尖多模态智能体基础模型系列',
        enabled: true,
        apiKey: '',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        defaultUrl: 'https://generativelanguage.googleapis.com/v1beta',
        models: [],
        customModels: [],
        status: 'idle' as const,
        delay: undefined,
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
      },
      {
        id: 'custom',
        name: '自定义提供商',
        desc: '自定义/中转等兼容 OpenAI 接口标准的第三方服务商',
        enabled: false,
        apiKey: '',
        baseUrl: '',
        defaultUrl: 'http://localhost:3001/v1',
        models: [],
        customModels: [],
        status: 'idle' as const,
        color: '#64748b'
      }
    ];

    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          // Strip legacy 'groq' provider entries (no longer supported)
          const filtered = parsed.filter((p: any) => p && p.id !== 'groq');
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

  useEffect(() => {
    // WIP: secrets.ts untracked, 暂时不做解密 (build 才能通过)
    // 仅在初始挂载时跑一次
    return;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{
    success: boolean;
    providerName: string;
    discoveredModels: { id: string; name: string }[];
  } | null>(null);

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
        const disabled = p.models.filter(m => !m.enabled);
        return { ...p, models: [...reordered, ...disabled] };
      }
      return p;
    }));
  };

  const reorderProviders = (reordered: ModelProvider[]) => {
    setProviders(reordered);
  };

  const providerListRef = useRef<HTMLUListElement>(null);
  const modelListRef = useRef<HTMLUListElement>(null);
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
    const customCount = providers.filter(p => p.id.startsWith('custom_') || p.id === 'custom').length;
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
      color: '#64748b'
    };
    setProviders(prev => [...prev, newProvider]);
    setActiveProviderId(newId);
    setCustomModelVal('');
  };

  const testProviderConnection = async (providerId: string) => {
    setProviders(prev => prev.map(p => p.id === providerId ? { ...p, status: 'loading', errorMessage: undefined } : p));
    const target = providers.find(p => p.id === providerId);
    if (!target) return;
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

  // Tab 3: Local Model settings
  const [localScanStatus, setLocalScanStatus] = useState<'idle' | 'scanning' | 'done'>('idle');
  const [localModels, setLocalModels] = useState([
    { name: 'Ollama: Qwen-2.5-7B (本地)', status: '已集成', size: '4.7 GB' },
    { name: 'Ollama: Llama-3.2 (本地)', status: '已集成', size: '2.0 GB' },
    { name: 'LM Studio: DeepSeek-R1-Distill (本地)', status: '可追加', size: '8.1 GB' }
  ]);
  const triggerLocalScan = () => {
    setLocalScanStatus('scanning');
    setTimeout(() => {
      setLocalScanStatus('done');
      if (localModels.length < 4) {
        setLocalModels([
          ...localModels,
          { name: 'Ollama: Mistral-7B (新扫描到)', status: '可追加', size: '4.1 GB' }
        ]);
      }
    }, 1800);
  };

  // Tab 4: MCP Tool Integration state
  const [mcpTools, setMcpTools] = useState([
    { name: 'Filesystem MCP', desc: '宿主机沙箱文件读写控制端', route: 'localhost:5011' },
    { name: 'Direct MySQL Query', desc: '数据库元数据反射与分析端', route: 'localhost:5013' }
  ]);
  const [newMcpName, setNewMcpName] = useState('');
  const [newMcpDesc, setNewMcpDesc] = useState('');
  const [newMcpRoute, setNewMcpRoute] = useState('');
  const registerNewMcp = () => {
    if (!newMcpName) return;
    setMcpTools([...mcpTools, { name: newMcpName, desc: newMcpDesc || '自定义本地扩展工具', route: newMcpRoute || 'localhost:8121' }]);
    setNewMcpName('');
    setNewMcpDesc('');
    setNewMcpRoute('');
  };

  // Tab 5: Environments
  const [selectedEnv, setSelectedEnv] = useState('android');
  const [installingStatus, setInstallingStatus] = useState<'idle' | 'installing' | 'completed'>('idle');
  const [installProgress, setInstallProgress] = useState(0);
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);

  const startEnvSetup = () => {
    setInstallingStatus('installing');
    setInstallProgress(0);
    setTerminalLogs(['[SYS] 正在检查本地环境依赖...', '[SYS] 正在准备沙箱目录文件夹结构...']);
    
    const interval = setInterval(() => {
      setInstallProgress(prev => {
        const next = prev + 15;
        if (next >= 100) {
          clearInterval(interval);
          setInstallingStatus('completed');
          setTerminalLogs(l => [
            ...l, 
            `[SYS] 安装包加载已结束. (100%)`,
            `[OK] 极客环境部署成功。可独立运行！`,
            `如无需要请按回车条过`
          ]);
          return 100;
        }
        
        let customLog = '';
        if (next === 30) customLog = `[DOWNLOAD] 提取对应多版本套件包 (240MB)...`;
        if (next === 60) customLog = `[SETUP] 配置本地环境变量 PATH 与符号链接...`;
        if (next === 90) customLog = `[VM] 虚拟沙箱检测通过。`;

        if (customLog) {
          setTerminalLogs(l => [...l, customLog]);
        }
        return next;
      });
    }, 400);
  };

  // Tab 6: 11-Stage Interactive conversation flow
  const [activeStageIdx, setActiveStageIdx] = useState(0);
  const pipelineStages = [
    { name: '输入接收', desc: '创建 sessionId / turnId 等，记录初始快照。' },
    { name: '输入安全校验', desc: '自动检测并拦截违规/有害指令，过滤涉敏词汇或系统注入行为。' },
    { name: '提示词重构', desc: '结合预置 System prompt。拼接模版参数，增强上下文可读性。' },
    { name: '本地检索(RAG)', desc: '检索知识库、向量库及历史记忆切片，加载高度相关的上下文条目。' },
    { name: '上下文编排', desc: '组织并优化最终发送给大模型的完整消息链，压缩过长记忆片段。' },
    { name: '云/端网络请求', desc: '通过 API 密钥直接连接云端模型或通过本地 Ollama 加载会话线程。' },
    { name: '异步流式回调', desc: '接收大模型分块数据，进行流式解码还原，并触发实时 UI 波形同步。' },
    { name: '输出合规校验', desc: '监控大模型输出生成内容，秒级阻断任何可能存在的违规生成泄露。' },
    { name: '长期记忆沉淀', desc: '从当次会话中自动抓取、沉淀出用户开发偏好、系统偏好的事实键值。' },
    { name: '会话保存落库', desc: '更新本地 SQLite / React 状态元会话列表，建立回滚决策索引。' },
    { name: '性能及对齐审计', desc: '核算本轮交互 token 数量、对齐开销与时延，展示网络风控留痕标志。' }
  ];

  // Tab 7: Skills & Rules manager states
  const [skillsList, setSkillsList] = useState([
    { name: 'core-system-prompt.txt', time: '5分钟前', size: '1.8 KB' },
    { name: 'agent-custom-actions.txt', time: '10分钟前', size: '2.5 KB' }
  ]);
  const [newSkillName, setNewSkillName] = useState('');
  const [complianceChecked, setComplianceChecked] = useState(true);

  const uploadSkillMock = () => {
    if (!newSkillName) return;
    setSkillsList([...skillsList, { name: `${newSkillName}.txt`, time: '刚刚上传', size: '1.2 KB' }]);
    setNewSkillName('');
    // Trigger compliance alert simulation
    setComplianceChecked(false);
    setTimeout(() => setComplianceChecked(true), 3000);
  };

  // Tab 8: Global smart memory block manager states
  const [memoryTab, setMemoryTab] = useState<'custom' | 'url'>('custom');
  const [customMemories, setCustomMemories] = useState([
    { id: '1', title: '开发偏好', content: '总是倾向于采用 Tailwind v4 实用工具类及 named TS 进行导出。' },
    { id: '2', title: '组件架构', content: '所有的 RAG 搜索都必须经过 context-bus 进行统一转发保存。' }
  ]);
  const [newMemTitle, setNewMemTitle] = useState('');
  const [newMemContent, setNewMemContent] = useState('');
  const [urlMemoryLines, setUrlMemoryLines] = useState<string>('https://docs.soloforge.cc/guide\nhttps://github.com/soloforge/mcp-registry');

  const addCustomMemoryItem = () => {
    if (!newMemTitle || !newMemContent) return;
    setCustomMemories([...customMemories, { id: Date.now().toString(), title: newMemTitle, content: newMemContent }]);
    setNewMemTitle('');
    setNewMemContent('');
  };

  // Tab 9: Downloads Tracker
  const [downloads, setDownloads] = useState([
    { name: 'gradle-8.5-all.zip', progress: 85, speed: '14.2 MB/s', status: '下载中', size: '112.5 MB' },
    { name: 'ollama-windows-amd64.zip', progress: 100, speed: '0 B/s', status: '已完成', size: '210.4 MB' },
    { name: 'python-3.12-embed.zip', progress: 0, speed: '0 B/s', status: '队列中', size: '32.1 MB' }
  ]);
  const [newDownloadUrl, setNewDownloadUrl] = useState('');
  const triggerNewDownloadMock = () => {
    if (!newDownloadUrl) return;
    const name = newDownloadUrl.substring(newDownloadUrl.lastIndexOf('/') + 1) || 'web-downloaded-resource.zip';
    setDownloads([{ name, progress: 5, speed: '2.5 MB/s', status: '下载中', size: '45.0 MB' }, ...downloads]);
    setNewDownloadUrl('');
  };

  // Tab 10: Proxy proxy mode
  const [proxyMode, setProxyMode] = useState<'none' | 'system' | 'custom'>('none');
  const [proxyServer, setProxyServer] = useState('127.0.0.1');
  const [proxyPort, setProxyPort] = useState('7890');

  // Tab 11: Knowledge Base config
  const [knowledgeSearchTerm, setKnowledgeSearchTerm] = useState('');
  const [knowledgeBases, setKnowledgeBases] = useState([
    { name: 'API文档库', fileCount: 4, size: '2.4 MB' },
    { name: 'SpringCloud设计蓝图', fileCount: 8, size: '14.2 MB' },
    { name: '前端主题库规范', fileCount: 2, size: '640 KB' }
  ]);
  const [newKbName, setNewKbName] = useState('');
  const createNewKbMock = () => {
    if (!newKbName) return;
    setKnowledgeBases([...knowledgeBases, { name: newKbName, fileCount: 0, size: '0 KB' }]);
    setNewKbName('');
  };

  // Tab 12: Channels Authorization Feishu/WeChat/QQ
  const [selectedChannels, setSelectedChannels] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('soloforge_channels_active');
      return saved ? JSON.parse(saved) : { feishu: true, wechat: false, qq: false };
    } catch (_) {
      return { feishu: true, wechat: false, qq: false };
    }
  });

  const [feishuUrl, setFeishuUrl] = useState(() => localStorage.getItem('soloforge_feishu_url') || '');
  const [wechatUrl, setWechatUrl] = useState(() => localStorage.getItem('soloforge_wechat_url') || '');
  const [qqUrl, setQqUrl] = useState(() => localStorage.getItem('soloforge_qq_url') || '');

  // Persistent saving effects
  useEffect(() => {
    localStorage.setItem('soloforge_channels_active', JSON.stringify(selectedChannels));
  }, [selectedChannels]);

  useEffect(() => {
    localStorage.setItem('soloforge_feishu_url', feishuUrl);
  }, [feishuUrl]);

  useEffect(() => {
    localStorage.setItem('soloforge_wechat_url', wechatUrl);
  }, [wechatUrl]);

  useEffect(() => {
    localStorage.setItem('soloforge_qq_url', qqUrl);
  }, [qqUrl]);

  interface ChannelTestLog {
    time: string;
    type: 'info' | 'success' | 'error';
    text: string;
  }
  const [channelLogs, setChannelLogs] = useState<ChannelTestLog[]>([
    { time: new Date().toLocaleTimeString(), type: 'info', text: '消息连接网络诊断系统初始化完毕。' }
  ]);

  const [isTestingChannel, setIsTestingChannel] = useState<string | null>(null);

  const testChannelConnection = async (type: 'feishu' | 'wechat' | 'qq') => {
    const channelNames = { feishu: '飞书机器人', wechat: '企业微信', qq: 'QQ Webhook' };
    const url = type === 'feishu' ? feishuUrl : type === 'wechat' ? wechatUrl : qqUrl;
    
    const timestamp = () => new Date().toLocaleTimeString();

    // Log check active
    if (!selectedChannels[type]) {
      setChannelLogs(prev => [
        { time: timestamp(), type: 'error', text: `[${channelNames[type]}] 通道暂未启用。请先勾选右上角开关以激活此通道。` },
        ...prev
      ]);
      return;
    }

    if (!url) {
      setChannelLogs(prev => [
        { time: timestamp(), type: 'error', text: `[${channelNames[type]}] 诊断失败：未配置 Webhook URL 接口地址。` },
        ...prev
      ]);
      return;
    }

    setIsTestingChannel(type);
    setChannelLogs(prev => [
      { time: timestamp(), type: 'info', text: `[${channelNames[type]}] 正在发起网络诊断连接。请求端终点 -> ${url}` },
      ...prev
    ]);

    try {
      const response = await fetch('/api/channels/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelType: type, webhookUrl: url })
      });

      const data = await response.json();

      if (data.success) {
        setChannelLogs(prev => [
          { time: timestamp(), type: 'success', text: `[${channelNames[type]}] 诊断测试成功！服务器返回成功状态 [HTTP ${data.status}]。远程返回报文: ${data.apiReply || '{}'}` },
          ...prev
        ]);
      } else {
        setChannelLogs(prev => [
          { 
            time: timestamp(), 
            type: 'error', 
            text: `[${channelNames[type]}] 网络测试返回错误 [HTTP ${data.status || 'ERROR'}]。详情: ${data.error || data.apiReply || '未知投递故障'}` 
          },
          ...prev
        ]);
      }
    } catch (err: any) {
      setChannelLogs(prev => [
        { time: timestamp(), type: 'error', text: `[${channelNames[type]}] 本地通讯异常: ${err.message || '连接失败'}` },
        ...prev
      ]);
    } finally {
      setIsTestingChannel(null);
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
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="fixed inset-0 flex items-center justify-center z-[100] p-4 text-on-surface font-sans select-none overflow-hidden"
      style={{ backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', backgroundColor: 'rgba(0, 0, 0, 0.45)' }}
    >
      <motion.div 
        initial={{ opacity: 0, scale: 0.96, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 12 }}
        transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
        className="settings-modal-card bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-2xl w-full max-w-5xl h-[85vh] shadow-[0_12px_45px_rgba(0,0,0,0.4)] overflow-hidden flex flex-col text-[var(--color-on-surface)]"
      >
        {/* Modal Unified Header */}
        <div className="flex items-center justify-between p-4 px-6 border-b border-[var(--color-outline)]/20 bg-[var(--color-bg)] text-[var(--color-on-surface)]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[var(--color-primary)]/10 border border-[var(--color-primary)]/20 flex items-center justify-center">
              <Settings className="text-[var(--color-primary)] w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-[var(--color-on-surface)] tracking-wide">设置</h2>
            </div>
          </div>
          <button 
            onClick={onClose} 
            className="p-1.5 hover:bg-[var(--color-surface-bright)]/40 rounded-lg transition-colors cursor-pointer text-on-surface/50 hover:text-[var(--color-on-surface)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Main Split View: Left list is menu tab links, Right is configurations detail content */}
        <div className="flex-1 flex overflow-hidden">
          
          {/* Left Column function index (width: 250px) - Interactive items */}
          <div className="w-[260px] bg-[var(--color-bg)] border-r border-[var(--color-outline)]/20 flex flex-col overflow-y-auto p-2 scrollbar-none gap-0.5 shrink-0">
            {tabs.map((tab) => {
              const TabIcon = tab.icon;
              const isActive = activeTabId === tab.id;
              
              // Cleanly separate number prefix and clean name
              const match = tab.label.match(/^(\d+)\.\s*(.*)$/);
              const numPrefix = match ? match[1] : '';
              const nameText = match ? match[2] : tab.label;

              return (
                <div 
                  key={tab.id}
                  onClick={() => setActiveTabId(tab.id)}
                  className={`group relative flex items-center px-4 py-2.5 rounded-lg cursor-pointer transition-colors ${
                    isActive 
                      ? 'bg-[var(--color-primary)]/10 text-[var(--color-on-surface)] font-bold' 
                      : 'hover:bg-[var(--color-surface-bright)]/45 text-on-surface/75 hover:text-[var(--color-on-surface)]'
                  }`}
                >
                  {/* Left accent bar for active tab */}
                  {isActive && (
                    <div className="absolute left-0 top-2 bottom-2 w-1 rounded-r bg-[var(--color-primary)]" />
                  )}
                  
                  {/* Icon */}
                  <TabIcon className={`w-4 h-4 shrink-0 mr-3 ${isActive ? 'text-[var(--color-primary)]' : 'text-on-surface/40'}`} />
                  
                  {/* Monospace Number Prefix */}
                  <span className="font-mono text-xs w-6 shrink-0 opacity-55 text-left">{numPrefix}.</span>
                  
                  {/* Tool Name */}
                  <span className="text-[13.5px] md:text-sm font-medium leading-none truncate flex-1">
                    {nameText}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Right Column: Specific Panel details with scrolling */}
          <div className="flex-1 bg-[var(--color-surface)] p-6 overflow-y-auto scrollbar-thin text-left">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTabId}
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -16 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                className="w-full min-h-full flex flex-col"
              >
                {/* 01. Language settings */}
                {activeTabId === 'language' && (
                  <div className="space-y-6 animate-fadeIn text-left pb-6">
                    <div className="border-b border-[var(--color-outline)]/20 pb-3 mb-2">
                      <h3 className="text-base font-bold text-[var(--color-on-surface)]">界面语言与全局字体</h3>
                      <p className="text-xs text-on-surface/50 mt-1">定制界面首选语言以及全局显示字体。支持一键导入并应用本地个性化字体。</p>
                    </div>
                    
                    <div className="bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-xl p-5 space-y-4">
                      <span className="text-xs text-[var(--color-primary)] font-mono tracking-wider font-semibold uppercase block">语言偏好设置</span>
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="text-sm font-bold text-[var(--color-on-surface)]">系统显示语言</span>
                          <p className="text-xs text-on-surface/50 mt-0.5">多国语言自动校准，默认为中文显示</p>
                        </div>
                        <div className="flex gap-2">
                          <button 
                            onClick={() => changeLanguage('zh-CN')}
                            className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                              selectedLang === 'zh-CN'
                                ? 'bg-[var(--color-primary)]/10 border border-[var(--color-primary)]/40 text-[var(--color-primary)] shadow-[0_0_12px_rgba(var(--color-primary-rgb),0.15)] font-extrabold'
                                : 'bg-[var(--color-bg)] border border-[var(--color-outline)]/15 text-on-surface/50 hover:text-white hover:border-[var(--color-outline)]/35'
                            }`}
                          >
                            简体中文 (ZH)
                          </button>
                          <button 
                            onClick={() => changeLanguage('en-US')}
                            className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                              selectedLang === 'en-US'
                                ? 'bg-[var(--color-primary)]/10 border border-[var(--color-primary)]/40 text-[var(--color-primary)] shadow-[0_0_12px_rgba(var(--color-primary-rgb),0.15)] font-extrabold'
                                : 'bg-[var(--color-bg)] border border-[var(--color-outline)]/15 text-on-surface/50 hover:text-white hover:border-[var(--color-outline)]/35'
                            }`}
                          >
                            English (US)
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Font settings nested inline */}
                    <div className="bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-xl p-5 space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="text-xs text-[var(--color-primary)] font-mono tracking-wider font-semibold uppercase block">全局字体设置</span>
                          <p className="text-xs text-on-surface/50 mt-0.5">轻触快速点击切换首选字体样式包，自动全站生效</p>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                        {[...PRESET_FONTS, ...customFonts].map((font, idx) => {
                          const isActive = selectedFont === font.name;
                          
                          // Derive display CSS font family name
                          let displayFontFamily = font.name;
                          if (font.name === '系统默认 (System UI)') {
                            displayFontFamily = 'system-ui, sans-serif';
                          } else if (font.name === '默认 (Default)') {
                            displayFontFamily = 'Inter, sans-serif';
                          } else if (font.name.includes('(')) {
                            const m = font.name.match(/\(([^)]+)\)/);
                            if (m) displayFontFamily = m[1];
                          }

                          return (
                            <div 
                              key={idx}
                              role="button"
                              onClick={() => setSelectedFont(font.name)}
                              className={`p-3.5 rounded-xl border text-left flex flex-col justify-between cursor-pointer transition-all ${
                                isActive 
                                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10 shadow-[0_0_12px_rgba(var(--color-primary-rgb),0.25)]'
                                  : 'border-[var(--color-outline)]/15 bg-[var(--color-bg)] hover:bg-[var(--color-surface-bright)]/30 hover:border-[var(--color-outline)]/35'
                              }`}
                              style={{ fontFamily: displayFontFamily }}
                            >
                              <div className="flex items-start justify-between min-w-0 gap-1.5">
                                <span className="text-xs font-bold text-[var(--color-on-surface)] truncate">
                                  {font.name.replace(/\s*\(Default\)|\s*\(System UI\)/, '')}
                                </span>
                                {isActive && (
                                  <span className="w-4 h-4 rounded-full bg-[var(--color-primary)] text-[var(--color-bg)] flex items-center justify-center shrink-0">
                                    <Check className="w-2.5 h-2.5 font-extrabold stroke-[3.5]" />
                                  </span>
                                )}
                              </div>
                              
                              <div className="mt-3 flex items-center justify-between">
                                <span className="text-[9px] text-on-surface/40 font-mono tracking-wider leading-none">
                                  {font.isPreset ? '系统预设' : '已导入'}
                                </span>
                                {!font.isPreset && (
                                  <button 
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      deleteCustomFont(font.name);
                                    }}
                                    className="p-1 text-on-surface/30 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors cursor-pointer"
                                    title="删除此字体"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}

                        {/* If selected font is custom, show clear delete button */}
                        {!PRESET_FONTS.some(f => f.name === selectedFont) && (
                          <div className="col-span-full mt-2 mb-2 flex justify-start">
                            <button
                              onClick={() => deleteCustomFont(selectedFont)}
                              className="px-3 py-1.5 flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/5 text-red-100 hover:bg-red-500/15 hover:border-red-500/40 transition-colors text-xs cursor-pointer font-medium shrink-0"
                              title="释放/删除当前选中的本地字体资源"
                            >
                              <Trash2 className="w-3.5 h-3.5 text-red-400" />
                              <span className="text-red-400">从缓存中移除选中本地字体资源: {selectedFont.replace(' (Local)', '')}</span>
                            </button>
                          </div>
                        )}

                        {/* Hidden dynamic local font loader input element */}
                        <input 
                          type="file"
                          ref={fontInputRef}
                          accept=".ttf,.otf,.woff,.woff2"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            
                            const reader = new FileReader();
                            reader.onload = (event) => {
                              const result = event.target?.result as string;
                              if (result) {
                                // Extract readable display name without format extension
                                const nameWithoutExt = file.name.replace(/\.[^/.]+$/, "");
                                // Create premium display name, e.g. "MyFont (Local)"
                                const cleanName = `${nameWithoutExt} (Local)`;
                                addCustomFont(cleanName, result);
                                setSelectedFont(cleanName);
                              }
                            };
                            reader.readAsDataURL(file);
                          }}
                          style={{ display: 'none' }}
                        />

                        {/* Plus Add action panel card */}
                        <div 
                          role="button"
                          onClick={() => {
                            onClose();
                            try {
                              const channel = new BroadcastChannel('soloforge-editor-sync-channel');
                              channel.postMessage({
                                type: 'JUMP_TO_EXPLORER',
                                toast: '📂 已为您跳转至资源管理文件夹！在左侧文件树「assets/fonts」中点击任何 .ttf/.otf/.woff 字体文件，即可自动生成样式磁贴，全局快速点击切换！'
                              });
                              channel.close();
                            } catch (e) {
                              console.warn(e);
                            }
                          }}
                          className="p-3.5 rounded-xl border border-dashed border-[var(--color-primary)]/40 hover:border-[var(--color-primary)] hover:bg-[var(--color-primary)]/5 text-center flex flex-col items-center justify-center cursor-pointer transition-all gap-1 text-[var(--color-primary)] group min-h-[72px]"
                          title="从软件资源管理文件夹导入并应用新字体"
                        >
                          <Plus className="w-5 h-5 stroke-[2.5] group-hover:scale-110 transition-transform active:scale-95" />
                          <span className="text-[10.5px] font-bold tracking-tight">导入本地字体</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

            {/* 02. Model Add settings */}
            {activeTabId === 'model-add' && (
                <div
                  ref={cloudModelPageRef}
                  className="space-y-5 flex flex-col h-full text-left"
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
                    modifiers={[restrictToVerticalAxis, restrictToParentElement]}
                    onDragStart={handleProviderDragStart}
                    onDragEnd={handleProviderDragEnd}
                    onDragCancel={handleProviderDragCancel}
                  >
                  <div className="flex-1 flex min-h-0 bg-[var(--color-bg)]/60 border border-[var(--color-outline)]/20 rounded-2xl overflow-visible">
                    
                    {/* Left Sidebar: Provider Cards Selection */}
                    <div className="w-[200px] border-r border-[var(--color-outline)]/15 bg-[var(--color-bg)]/80 flex flex-col shrink-0">
                      {/* Fixed: Title */}
                      <div className="px-5 py-3 text-[10px] text-on-surface/40 font-bold tracking-wider border-b border-[var(--color-outline)]/10 shrink-0">
                        模型服务商列表
                      </div>
                      
                      {/* Scrollable: Provider list only */}
                      <div
                        ref={providerScrollRef}
                        className="flex-1 min-h-0 overflow-y-auto p-2.5 select-none relative [&::-webkit-scrollbar]:hidden"
                        style={{
                          overscrollBehavior: 'contain',
                          contain: 'layout paint',
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
                        <motion.button
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: 0.1 }}
                          whileHover={{ scale: 1.02 }}
                          whileTap={{ scale: 0.98 }}
                          onClick={createNewCustomProvider}
                          className="w-full py-2.5 rounded-xl border border-dashed border-[var(--color-outline)]/20 hover:border-[var(--color-primary)] bg-[var(--color-primary)]/5 hover:bg-[var(--color-primary)]/10 text-[var(--color-primary)] flex items-center justify-center gap-1.5 text-xs font-bold transition-all cursor-pointer shadow-sm"
                          title="添加新的自定义模型通道"
                        >
                          <Plus className="w-4 h-4" />
                          <span>添加自定义端点</span>
                        </motion.button>
                      </div>
                    </div>

                    {/* Right Workspace: Details Setup Dynamic Form */}
                    <div
                      ref={rightWorkspaceRef}
                      className="flex-1 flex flex-col min-h-0 bg-[var(--color-surface)]/30 overflow-y-auto"
                      style={{ overscrollBehavior: 'none' }}
                    >
                      <AnimatePresence mode="wait">
                        <motion.div
                          key={activeProvider.id}
                          initial={{ opacity: 0, y: 12 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -12 }}
                          transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
                          className="flex-1 flex flex-col p-6 space-y-6"
                        >
                          {/* Active Provider Info Panel Header */}
                          <div className="flex items-center justify-between pb-4 border-b border-[var(--color-outline)]/15 shrink-0">
                            <div className="space-y-1">
                              <div className="flex items-center gap-3">
                                <ModelIcon modelName={activeProvider.id} size={28} className="shrink-0" />
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
                              <AnimatePresence>
                                {scanResult && (
                                  <motion.div
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: 'auto' }}
                                    exit={{ opacity: 0, height: 0 }}
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
                                  </motion.div>
                                )}
                              </AnimatePresence>
                              
                              {/* Model Reorder List */}
                              <div className="max-h-[220px] overflow-y-auto pr-1">
                                {activeProvider.models.filter(m => m.enabled).length === 0 && activeProvider.customModels.length === 0 && (
                                  <div className="py-6 text-center text-xs text-[var(--color-on-surface)]/40 flex flex-col items-center justify-center gap-1.5 border border-dashed border-[var(--color-outline)]/15 rounded-xl bg-[var(--color-surface-bright)]/10">
                                    <Layers className="w-5 h-5 opacity-40 animate-pulse text-[var(--color-primary)]" />
                                    <span>暂无选中模型</span>
                                  </div>
                                )}
                                {activeProvider.enabled && dragModels.length > 0 && (
                                  <Reorder.Group
                                    ref={modelListRef}
                                    axis="y"
                                    values={dragModels}
                                    onReorder={(reordered) => reorderModels(activeProvider.id, reordered)}
                                    className="space-y-1.5"
                                    style={{ overflow: 'visible' }}
                                  >
                                    {dragModels.map((model) => (
                                        <Reorder.Item
                                          key={model.id}
                                          value={model}
                                          dragListener={true}
                                          dragElastic={0}
                                          whileDrag={{
                                            zIndex: 50,
                                            opacity: 1,
                                          }}
                                          layout
                                          transition={{
                                            layout: {
                                              type: 'spring',
                                              stiffness: 600,
                                              damping: 35,
                                              mass: 0.3,
                                            },
                                          }}
                                          className="flex items-center justify-between p-2.5 rounded-xl border text-xs cursor-grab active:cursor-grabbing select-none touch-none bg-[var(--color-primary)]/10 border-[var(--color-primary)]/45 text-[var(--color-on-surface)] font-bold shadow-sm"
                                        >
                                          <div className="flex items-center gap-2 flex-1 min-w-0 pointer-events-none">
                                            <ModelIcon modelName={model.id} size={20} className="shrink-0" />
                                            <ScrollableText className="font-mono text-[11.5px] text-on-surface font-extrabold" title={model.id}>{model.name || model.id}</ScrollableText>
                                          </div>

                                          <div className="flex items-center shrink-0 ml-2">
                                            <button
                                              type="button"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                toggleModelEnabled(activeProvider.id, model.id);
                                              }}
                                              className="w-5.5 h-5.5 rounded-md flex items-center justify-center font-bold text-xs bg-rose-500/10 text-rose-550 hover:bg-rose-500 hover:text-white active:scale-95 transition-all cursor-pointer shadow-sm"
                                              title="从已选中模型中移除"
                                            >
                                              -
                                            </button>
                                          </div>
                                        </Reorder.Item>
                                      ))}
                                  </Reorder.Group>
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
                                      <motion.div
                                        key={cm}
                                        whileHover={{ y: -1 }}
                                        className="flex items-center justify-between p-2.5 rounded-xl border text-xs bg-[var(--color-primary)]/10 border-[var(--color-primary)]/30 text-[var(--color-on-surface)] shadow-inner"
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
                                      </motion.div>
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
                              <AnimatePresence mode="wait">
                                {activeProvider.status === 'loading' && (
                                  <motion.div 
                                    initial={{ opacity: 0, x: 5 }} 
                                    animate={{ opacity: 1, x: 0 }} 
                                    exit={{ opacity: 0, x: -5 }} 
                                    className="text-yellow-400 font-bold text-[11px] flex items-center gap-1.5"
                                  >
                                    <RefreshCw className="w-4 h-4 animate-spin" />
                                    <span>线路握手中...</span>
                                  </motion.div>
                                )}
                                {activeProvider.status === 'success' && activeProvider.enabled && (
                                  <motion.div 
                                    initial={{ opacity: 0, scale: 0.95 }} 
                                    animate={{ opacity: 1, scale: 1 }} 
                                    exit={{ opacity: 0, scale: 0.95 }}
                                    className="text-emerald-400 font-extrabold text-[11px] flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1.5 rounded-lg"
                                  >
                                    <Check className="w-4 h-4" />
                                    <span>测试成功 ({activeProvider.delay}毫秒)</span>
                                  </motion.div>
                                )}
                                {activeProvider.status === 'failed' && activeProvider.enabled && (
                                  <motion.div 
                                    initial={{ opacity: 0, scale: 0.95 }} 
                                    animate={{ opacity: 1, scale: 1 }} 
                                    exit={{ opacity: 0, scale: 0.95 }}
                                    className="text-red-400 font-extrabold text-[11px] flex items-center gap-1.5 bg-red-400/10 border border-red-500/20 px-3 py-1.5 rounded-lg cursor-help shrink-0"
                                    title={activeProvider.errorMessage}
                                  >
                                    <AlertCircle className="w-4 h-4 shrink-0" />
                                    <span>握手失败</span>
                                  </motion.div>
                                )}
                                {!activeProvider.enabled && (
                                  <div className="text-on-surface/30 text-[11px]">
                                    服务商未启用
                                  </div>
                                )}
                              </AnimatePresence>
                            </div>
                          </div>
                          </div>
                        </motion.div>
                      </AnimatePresence>
                    </div>

                    <DragOverlay
                      dropAnimation={{
                        duration: 140,
                        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
                      }}
                    >
                      {activeDragProvider ? (
                        <div
                          className="rounded-xl"
                          style={{
                            isolation: 'isolate',
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
                            onSelect={() => {}}
                            onDelete={removeCustomProvider}
                          />
                        </div>
                      ) : null}
                    </DragOverlay>

                  </div>
                  </DndContext>
                </div>
            )}

            {/* 03. Local Model settings */}
            {activeTabId === 'local-model' && (
              <div className="space-y-6 animate-fadeIn">
                <div className="border-b border-[var(--color-outline)]/20 pb-3 mb-2">
                  <h3 className="text-base font-bold text-[var(--color-on-surface)]">本地模型管理</h3>
                  <p className="text-xs text-on-surface/50 mt-1">自动识别并同步本地 Ollama 或 LM Studio 的大模型</p>
                </div>

                <div className="flex items-center justify-between p-4 bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-xl mb-2">
                  <div>
                    <span className="text-sm font-bold text-[var(--color-on-surface)]">快速扫描本地运行端口</span>
                    <p className="text-xs text-on-surface/50 mt-0.5">检测并连接 11434 / 1234 等常用微内核接口</p>
                  </div>
                  <button 
                    onClick={triggerLocalScan}
                    disabled={localScanStatus === 'scanning'}
                    className="bg-[var(--color-primary)] hover:opacity-90 disabled:opacity-50 text-[var(--color-bg)] px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition-all cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${localScanStatus === 'scanning' ? 'animate-spin' : ''}`} />
                    <span>检测本地实例</span>
                  </button>
                </div>

                <div className="space-y-2">
                  <span className="text-xs text-[var(--color-primary)] font-mono font-semibold block">可用模型列表</span>
                  {localModels.map((lm, idx) => (
                    <div key={idx} className="p-3 bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded-xl flex items-center justify-between hover:border-[var(--color-primary)]/20 transition-all">
                      <div className="flex items-center gap-2.5">
                        <div className="w-2.5 h-2.5 rounded-full bg-[var(--color-primary)]/70 shrink-0" />
                        <span className="text-xs font-semibold text-[var(--color-on-surface)]">{lm.name}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-on-surface/50 font-mono">{lm.size}</span>
                        {lm.status === '已集成' ? (
                          <span className="text-xs bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded">自动激活</span>
                        ) : (
                          <button 
                            onClick={() => {
                              const updated = [...localModels];
                              updated[idx].status = '已集成';
                              setLocalModels(updated);
                            }}
                            className="text-xs bg-[var(--color-primary)]/15 hover:bg-[var(--color-primary)]/25 border border-[var(--color-primary)]/30 text-[var(--color-primary)] px-2.5 py-1 rounded cursor-pointer transition-all"
                          >
                            导入
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 04. MCP Plugin Tools */}
            {activeTabId === 'mcp' && (
              <div className="space-y-6 animate-fadeIn">
                <div className="border-b border-[var(--color-outline)]/20 pb-3 mb-2">
                  <h3 className="text-base font-bold text-[var(--color-on-surface)]">MCP 工具注册</h3>
                  <p className="text-xs text-on-surface/50 mt-1">注册并管辖 Model Context Protocol 扩展，协助模型操作外部工具</p>
                </div>

                {/* Listing of MCP tools */}
                <div className="space-y-2">
                  <span className="text-xs text-[var(--color-primary)] font-mono font-semibold block">已加载的 MCP 服务套件</span>
                  {mcpTools.map((mcp, idx) => (
                    <div key={idx} className="p-3 bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded-xl flex items-center justify-between shadow-sm">
                      <div>
                        <span className="text-sm font-bold text-[var(--color-on-surface)] flex items-center gap-2">{mcp.name} <span className="text-xs text-[var(--color-primary)] font-mono bg-[var(--color-primary)]/10 px-1.5 py-0.5 rounded font-normal shrink-0">{mcp.route}</span></span>
                        <p className="text-xs text-on-surface/50 mt-1">{mcp.desc}</p>
                      </div>
                      <button 
                        onClick={() => setMcpTools(mcpTools.filter((_, i) => i !== idx))}
                        className="text-on-surface/40 hover:text-red-400 p-1.5 hover:bg-red-500/10 rounded-lg transition-colors cursor-pointer"
                        title="卸载"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>

                {/* Addition Form */}
                <div className="p-4 bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-xl space-y-3">
                  <span className="text-xs text-[var(--color-primary)] font-mono block font-semibold">注册新 MCP 服务</span>
                  <div className="grid grid-cols-3 gap-3">
                    <input 
                      type="text" 
                      placeholder="服务名称" 
                      value={newMcpName} 
                      onChange={(e) => setNewMcpName(e.target.value)}
                      className="text-sm p-3 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-lg text-[var(--color-on-surface)] focus:border-[var(--color-primary)] outline-none" 
                    />
                    <input 
                      type="text" 
                      placeholder="功能描述" 
                      value={newMcpDesc} 
                      onChange={(e) => setNewMcpDesc(e.target.value)}
                      className="text-sm p-3 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-lg text-[var(--color-on-surface)] focus:border-[var(--color-primary)] outline-none" 
                    />
                    <input 
                      type="text" 
                      placeholder="服务寻址 (如 localhost:8011)" 
                      value={newMcpRoute} 
                      onChange={(e) => setNewMcpRoute(e.target.value)}
                      className="text-sm p-3 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-lg text-[var(--color-on-surface)] font-mono focus:border-[var(--color-primary)] outline-none" 
                    />
                  </div>
                  <button 
                    onClick={registerNewMcp}
                    className="w-full bg-[var(--color-primary)] hover:opacity-90 text-[var(--color-bg)] font-extrabold text-xs py-2.5 rounded-lg transition-all cursor-pointer"
                  >
                    授权并加载至中枢
                  </button>
                </div>

                {/* Recommendations */}
                <div className="bg-[var(--color-surface)]/60 border border-dashed border-[var(--color-outline)]/30 rounded-xl p-4.5 space-y-2">
                  <span className="text-xs text-[var(--color-primary)]/80 font-mono font-semibold block">优质 MCP 数据源推荐</span>
                  <p className="text-xs text-on-surface/50 leading-relaxed font-sans">
                    建议通过拉取以下公共开源插件扩展智能体环境控制边界：<br/>
                    • Tencent Cloud Developer Tools Server: <span className="text-[var(--color-primary)] hover:underline cursor-pointer font-mono">github.com/tencent-mcp/studio-server</span><br/>
                    • Ali Alibaba Qwen RAG Search: <span className="text-[var(--color-primary)] hover:underline cursor-pointer font-mono">github.com/alibaba/qwen-mcp</span>
                  </p>
                </div>
              </div>
            )}

            {/* 05. Environment dependency center */}
            {activeTabId === 'environment' && (
              <div className="space-y-6 animate-fadeIn">
                <div className="border-b border-[var(--color-outline)]/20 pb-3 mb-2">
                  <h3 className="text-base font-bold text-[var(--color-on-surface)]">沙箱环境配置</h3>
                  <p className="text-xs text-on-surface/50 mt-1">初始化及隔离独立编译进程，阻止不同版本物理依赖冲突</p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <span className="text-xs text-on-surface/50 font-semibold block">选择系统目标环境</span>
                    <select 
                      value={selectedEnv} 
                      onChange={(e) => setSelectedEnv(e.target.value)}
                      className="w-full text-sm p-3 bg-[var(--color-surface)] border border-[var(--color-outline)]/25 rounded-xl text-[var(--color-on-surface)] outline-none cursor-pointer focus:border-[var(--color-primary)]"
                    >
                      <option value="android">安卓开发套件 (Android Studio SDK & Gradle)</option>
                      <option value="java">Java 运行环境 (JDK Runtime)</option>
                      <option value="c">C 编译组件 (MinGW-64 简便版)</option>
                      <option value="cpp">C++ 高性能引擎 (GCC 工具链)</option>
                      <option value="python">Python 专业工具链 (Poetry Environment)</option>
                      <option value="custom">通用自定义终端会话 (Bash Shell)</option>
                    </select>
                  </div>

                  <div className="flex flex-col justify-end">
                    <button 
                      onClick={startEnvSetup}
                      className="w-full bg-[var(--color-primary)] hover:opacity-90 text-[var(--color-bg)] font-extrabold text-sm py-3 rounded-xl transition-all cursor-pointer active:scale-95 flex items-center justify-center gap-2 shadow-md"
                    >
                      <Terminal className="w-4 h-4" />
                      <span>配置沙箱文件夹并打包模块</span>
                    </button>
                  </div>
                </div>

                {/* Progress Terminal */}
                <div className="bg-[var(--color-bg)] border border-[var(--color-outline)]/25 rounded-xl p-4 font-mono text-xs h-48 flex flex-col justify-between overflow-hidden shadow-inner">
                  <div className="space-y-1 overflow-y-auto flex-1 scrollbar-none text-left">
                    <span className="text-xs text-emerald-500 block border-b border-[var(--color-outline)]/10 pb-1 mb-2">SANDBOX ENVIRONMENT MONITOR v1.1.0</span>
                    {terminalLogs.length === 0 ? (
                      <span className="text-on-surface/30 italic">等待初始化依赖环境唤醒指令...</span>
                    ) : (
                      terminalLogs.map((log, idx) => (
                        <div key={idx} className={log.includes('[OK]') ? 'text-emerald-500 font-bold' : log.includes('[DOWNLOAD]') ? 'text-blue-500' : 'text-on-surface/60'}>
                          {log}
                        </div>
                      ))
                    )}
                  </div>

                  {installingStatus === 'installing' && (
                    <div className="mt-3 border-t border-[var(--color-outline)]/10 pt-2">
                      <div className="flex justify-between text-xs text-on-surface/40 mb-1">
                        <span>解压与下载所需依赖中...</span>
                        <span>{installProgress}%</span>
                      </div>
                      <div className="w-full bg-[var(--color-surface-bright)] h-1.5 rounded-full overflow-hidden">
                        <div className="bg-[var(--color-primary)] h-full transition-all duration-300" style={{ width: `${installProgress}%` }} />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 07. Skills & Rules manager */}
            {activeTabId === 'skills-rules' && (
              <div className="space-y-6 animate-fadeIn">
                <div className="border-b border-[var(--color-outline)]/20 pb-3 mb-2">
                  <h3 className="text-base font-bold text-[var(--color-on-surface)]">预置智能规则</h3>
                  <p className="text-xs text-on-surface/50 mt-1">定制注入到系统主会话上下文的模式级规则文件与行为约束 (Rules & System Prompts)</p>
                </div>

                <div className="p-4 bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-xl flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {(() => {
                      const ComplianceIcon = getRuleTabIcon();
                      return <ComplianceIcon className={`w-5 h-5 ${complianceChecked ? 'text-[var(--color-primary)]' : 'text-red-400 animate-spin'}`} />;
                    })()}
                    <div>
                      <span className="text-sm font-bold text-[var(--color-on-surface)]">本地内容风控合规校验</span>
                      <p className="text-xs text-on-surface/50 mt-0.5">自动阻断危险脚本和代码逻辑并提供行为留痕</p>
                    </div>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded border font-mono font-bold ${
                    complianceChecked 
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' 
                      : 'bg-red-500/10 border-red-500/30 text-red-400'
                  }`}>
                    {complianceChecked ? '● SAFETY PASSED' : '● AUDITING STATUS'}
                  </span>
                </div>

                {/* Grid section for the 4 interactive operational modes rules */}
                <div className="space-y-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-[var(--color-primary)] font-mono font-semibold">运行模式决策控制规约 (Multi-Mode Safety Rules)</span>
                    <span className="text-[10px] text-on-surface/40 font-mono">规则存放端: BlogSystem/rules/</span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                    {/* Mode 1 - Normal Mode */}
                    <div className="p-4 rounded-xl border border-emerald-500/10 bg-emerald-500/[0.02] flex flex-col justify-between hover:border-emerald-500/25 transition-all gap-3.5 group">
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2">
                          <span className="p-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 shrink-0">
                            <NormalIcon className="w-4 h-4" />
                          </span>
                          <span className="text-xs font-bold text-[var(--color-on-surface)]">普通模式 (安全常态)</span>
                        </div>
                        <p className="text-[11px] text-on-surface/50 leading-relaxed">
                          采用高强度权限沙盒机制。所有关键命令强制要求人工确认。默认阻止未受信域的网络 API 请求与物理路径重置。
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          onClose();
                          try {
                            const channel = new BroadcastChannel('soloforge-editor-sync-channel');
                            channel.postMessage({
                              type: 'FILE_SELECT',
                              file: 'BlogSystem/rules/normal_rules.md',
                              content: `# 普通模式控制规则 (Normal Mode Rules)\n\n## 📌 基础定义与权限沙盒\n普通模式是 SoloForge 平台预设的基础运行模式。此状态下的一切代码执行、AI 生成都以「安全、合规」为绝对优先级。\n\n## 🔒 核心控制限制\n1. **指令阻断**：所有涉敏、可能修改系统内核、注册表的脚本会在底层自动丢弃。\n2. **沙盒防御**：网络端口、外部链接请求需要用户确认或由虚拟代理接管。\n3. **用户手动确认**：自动执行开关关闭，所有命令均需点击确认，确保完全受控。`
                            });
                            channel.postMessage({
                              type: 'JUMP_TO_EXPLORER',
                              toast: '📂 已为您快速打开普通模式规则文件: BlogSystem/rules/normal_rules.md'
                            });
                            channel.close();
                          } catch (e) {
                            console.warn(e);
                          }
                        }}
                        className="w-full py-2 flex items-center justify-center gap-1.5 rounded-lg text-[10.5px] font-bold border border-emerald-500/20 text-emerald-400 bg-emerald-500/5 hover:bg-emerald-500/10 transition-colors cursor-pointer shrink-0"
                      >
                        <Compass className="w-3.5 h-3.5 transition-transform group-hover:rotate-45" />
                        创建并快速打开规则文件
                      </button>
                    </div>

                    {/* Mode 2 - Performance Mode */}
                    <div className="p-4 rounded-xl border border-purple-500/10 bg-purple-500/[0.02] flex flex-col justify-between hover:border-purple-500/25 transition-all gap-3.5 group">
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2">
                          <span className="p-1 rounded-lg bg-purple-500/10 border border-purple-500/20 text-purple-400 shrink-0">
                            <PerformanceIcon className="w-4 h-4" />
                          </span>
                          <span className="text-xs font-bold text-[var(--color-on-surface)]">性能模式 (半自动)</span>
                        </div>
                        <p className="text-[11px] text-on-surface/50 leading-relaxed">
                          降低流式缓存上下文的时效审计。启用极速后台线程增量更新机制。最大化保留富文本 UI 框架首屏计算效能。
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          onClose();
                          try {
                            const channel = new BroadcastChannel('soloforge-editor-sync-channel');
                            channel.postMessage({
                              type: 'FILE_SELECT',
                              file: 'BlogSystem/rules/performance_rules.md',
                              content: `# 性能模式控制规则 (Performance Mode Rules)\n\n## 📌 基础定义与性能对齐\n性能模式致力于通过低时延开销、增量式解析来满足极高强度的开发体验。\n\n## ⚡ 核心控制限制\n1. **流式缓存**：启用全流式输入/输出过滤，去除冗余的上下文留痕与全量标记校验。\n2. **多线程并发**：在后台线程中预处理文件更改，对常规静态资源开启惰性加载机制。\n3. **内存压缩**：对 10 轮前的历史交互信息执行有损向量切片压缩，节省内存开销。`
                            });
                            channel.postMessage({
                              type: 'JUMP_TO_EXPLORER',
                              toast: '📂 已为您快速打开性能模式规则文件: BlogSystem/rules/performance_rules.md'
                            });
                            channel.close();
                          } catch (e) {
                            console.warn(e);
                          }
                        }}
                        className="w-full py-2 flex items-center justify-center gap-1.5 rounded-lg text-[10.5px] font-bold border border-purple-500/20 text-purple-400 bg-purple-500/5 hover:bg-purple-500/10 transition-colors cursor-pointer shrink-0"
                      >
                        <Compass className="w-3.5 h-3.5 transition-transform group-hover:rotate-45" />
                        创建并快速打开规则文件
                      </button>
                    </div>

                    {/* Mode 3 - Expert Mode */}
                    <div className="p-4 rounded-xl border border-amber-500/10 bg-amber-500/[0.02] flex flex-col justify-between hover:border-amber-500/25 transition-all gap-3.5 group">
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2">
                          <span className="p-1 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 shrink-0">
                            <ExpertIcon className="w-4 h-4" />
                          </span>
                          <span className="text-xs font-bold text-[var(--color-on-surface)]">专家模式 (自动感知)</span>
                        </div>
                        <p className="text-[11px] text-on-surface/50 leading-relaxed">
                          自适应中度编译流。IDE 后台自动开展 AST 抽象树静态扫描、逻辑异常检验以及依赖未定义自动修复。
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          onClose();
                          try {
                            const channel = new BroadcastChannel('soloforge-editor-sync-channel');
                            channel.postMessage({
                              type: 'FILE_SELECT',
                              file: 'BlogSystem/rules/expert_rules.md',
                              content: `# 专家模式控制规则 (Expert Mode Rules)\n\n## 📌 基础定义与自动化赋能\n专家模式下，IDE 具备中等强度的全自动处理指令权限，专门用于深度代码解构、重构。\n\n## 🧠 核心控制限制\n1. **自动前置验证**：编辑代码后，后台静默执行 AST 树检验、接口对齐以及未引用变量扫描。\n2. **智能合并与拆分**：主动重构组件结构，对高耦合的 Vue/React 模块推荐或自动应用微服务化重塑。\n3. **静默依赖修补**：当遇到依赖缺失时，IDE 可静默调用本地加速源包补全，避免构建阻断。`
                            });
                            channel.postMessage({
                              type: 'JUMP_TO_EXPLORER',
                              toast: '📂 已为您快速打开专家模式规则文件: BlogSystem/rules/expert_rules.md'
                            });
                            channel.close();
                          } catch (e) {
                            console.warn(e);
                          }
                        }}
                        className="w-full py-2 flex items-center justify-center gap-1.5 rounded-lg text-[10.5px] font-bold border border-amber-500/20 text-amber-400 bg-amber-500/5 hover:bg-amber-500/10 transition-colors cursor-pointer shrink-0"
                      >
                        <Compass className="w-3.5 h-3.5 transition-transform group-hover:rotate-45" />
                        创建并快速打开规则文件
                      </button>
                    </div>

                    {/* Mode 4 - Ultimate Mode */}
                    <div className="p-4 rounded-xl border border-red-500/10 bg-red-500/[0.02] flex flex-col justify-between hover:border-red-500/25 transition-all gap-3.5 group">
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2">
                          <span className="p-1 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 shrink-0">
                            <UltimateIcon className="w-4 h-4" />
                          </span>
                          <span className="text-xs font-bold text-[var(--color-on-surface)]">极致模式 (全域自动)</span>
                        </div>
                        <p className="text-[11px] text-on-surface/50 leading-relaxed">
                          完全松开 CPU 并发限制，保障最高等级重试，多路调用并启用全局跨资产 RAG 重组注入。
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          onClose();
                          try {
                            const channel = new BroadcastChannel('soloforge-editor-sync-channel');
                            channel.postMessage({
                              type: 'FILE_SELECT',
                              file: 'BlogSystem/rules/ultimate_rules.md',
                              content: `# 极致模式控制规则 (Ultimate Mode Rules)\n\n## 📌 基础定义与火力无限\n解开全部 CPU、GPU 算力限制，实现 100% 全自动专家决策与重试回路。\n\n## 🔥 核心控制限制\n1. **全力并发计算**：开启 CPU 超线程任务管线与本地并行 GPU 加速渲染对齐。\n2. **自我纠错重试**：当后台编译报错或测试未通过时，允许 AI 在不干扰前台的前提下自主回溯并重试最多 5 次。\n3. **无缝混合大上下文**：开启跨多向量库全量召回检索，提供 100% RAG 全景记忆注入。\n4. **极致发烧狂热**：针对编写的所有基础文件施加最优算法，极光代码即刻生成。`
                            });
                            channel.postMessage({
                              type: 'JUMP_TO_EXPLORER',
                              toast: '📂 已为您快速打开极致模式规则文件: BlogSystem/rules/ultimate_rules.md'
                            });
                            channel.close();
                          } catch (e) {
                            console.warn(e);
                          }
                        }}
                        className="w-full py-2 flex items-center justify-center gap-1.5 rounded-lg text-[10.5px] font-bold border border-red-500/20 text-red-500 bg-red-500/5 hover:bg-red-500/10 transition-colors cursor-pointer shrink-0"
                      >
                        <Compass className="w-3.5 h-3.5 transition-transform group-hover:rotate-45" />
                        创建并快速打开规则文件
                      </button>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <span className="text-xs text-[var(--color-primary)] font-mono font-semibold block">上传外部控制规则/约束脚本 (.txt)</span>
                  <div className="flex gap-2">
                    <input 
                      type="text" 
                      placeholder="外部脚本名称" 
                      value={newSkillName}
                      onChange={(e) => setNewSkillName(e.target.value)}
                      className="flex-1 text-sm px-3.5 py-3 bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-xl text-[var(--color-on-surface)] outline-none focus:border-[var(--color-primary)]" 
                    />
                    <button 
                      onClick={uploadSkillMock}
                      className="bg-[var(--color-primary)] hover:opacity-90 text-[var(--color-bg)] font-extrabold text-xs px-4 py-2 rounded-xl transition-all cursor-pointer"
                    >
                      导入规则
                    </button>
                  </div>
                </div>

                <div className="space-y-2 pt-2">
                  <span className="text-xs text-on-surface/50 font-mono block">当前已加载的自动化脚本</span>
                  {skillsList.map((skill, idx) => (
                    <div key={idx} className="p-3 bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded-xl flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <FileText className="w-3.5 h-3.5 text-on-surface/40" />
                        <span className="text-xs font-semibold text-[var(--color-on-surface)]">{skill.name}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-on-surface/50 font-mono">{skill.size}</span>
                        <span className="text-xs text-[var(--color-primary)]/70 font-mono">{skill.time}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 08. Memory block manager */}
            {activeTabId === 'memory' && (
              <div className="space-y-6 animate-fadeIn">
                <div className="border-b border-[var(--color-outline)]/20 pb-3 mb-2">
                  <h3 className="text-base font-bold text-[var(--color-on-surface)]">记忆体管理</h3>
                  <p className="text-xs text-on-surface/50 mt-1">跨轮会话时自动沉淀高价值事实和约束限制条件</p>
                </div>

                <div className="flex border-b border-[var(--color-outline)]/20 gap-4 mb-2">
                  <button 
                    onClick={() => setMemoryTab('custom')} 
                    className={`pb-2 text-sm font-bold border-b-2 transition-all ${memoryTab === 'custom' ? 'border-[var(--color-primary)] text-[var(--color-primary)]' : 'border-transparent text-on-surface/40'}`}
                  >
                    偏好事实
                  </button>
                  <button 
                    onClick={() => setMemoryTab('url')} 
                    className={`pb-2 text-sm font-bold border-b-2 transition-all ${memoryTab === 'url' ? 'border-[var(--color-primary)] text-[var(--color-primary)]' : 'border-transparent text-on-surface/40'}`}
                  >
                    在线参考源
                  </button>
                </div>

                {memoryTab === 'custom' && (
                  <div className="space-y-4">
                    <div className="bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-xl p-4 gap-3 flex flex-col">
                      <span className="text-xs text-on-surface/50 font-mono block">录入一个全局常驻记忆</span>
                      <div className="grid grid-cols-2 gap-3">
                        <input 
                          type="text" 
                          placeholder="标题概要 (例如：运行端口)" 
                          value={newMemTitle}
                          onChange={(e) => setNewMemTitle(e.target.value)}
                          className="text-sm p-3 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-lg text-[var(--color-on-surface)] font-sans outline-none focus:border-[var(--color-primary)]" 
                        />
                        <input 
                          type="text" 
                          placeholder="细节描述 (例如：始终开启 3000 端映射)" 
                          value={newMemContent}
                          onChange={(e) => setNewMemContent(e.target.value)}
                          className="text-sm p-3 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-lg text-[var(--color-on-surface)] font-sans outline-none focus:border-[var(--color-primary)]" 
                        />
                      </div>
                      <button 
                        onClick={addCustomMemoryItem}
                        className="w-full text-[var(--color-bg)] bg-[var(--color-primary)] hover:opacity-90 font-extrabold text-xs py-2 rounded-lg cursor-pointer transition-all"
                      >
                        写入上下文常驻记忆
                      </button>
                    </div>

                    <div className="space-y-2">
                       {customMemories.map((m) => (
                        <div key={m.id} className="p-3 bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded-xl text-xs flex justify-between items-start gap-4">
                          <div>
                            <span className="font-bold text-[var(--color-primary)] text-sm block">{m.title}</span>
                            <p className="text-on-surface/70 text-xs mt-1">{m.content}</p>
                          </div>
                          <button 
                            onClick={() => setCustomMemories(customMemories.filter(item => item.id !== m.id))}
                            className="p-1 hover:bg-white/5 rounded text-on-surface/40 hover:text-red-400 cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {memoryTab === 'url' && (
                  <div className="space-y-4 font-sans">
                    <span className="text-xs text-on-surface/50 font-mono block">设置要自动爬取的 API、博客与文本文档 (每行一个首选 URL)</span>
                    <textarea
                      rows={4}
                      value={urlMemoryLines}
                      onChange={(e) => setUrlMemoryLines(e.target.value)}
                      className="w-full bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-xl p-3.5 text-sm text-[var(--color-on-surface)] outline-none font-mono focus:border-[var(--color-primary)]"
                    />
                    <div className="flex justify-between items-center bg-[var(--color-surface)] p-3 border border-[var(--color-outline)]/15 rounded-xl">
                      <span className="text-xs text-[var(--color-primary)]/75 font-mono">保存时将自动执行异步抓取并写入语义检索库</span>
                      <button className="bg-[var(--color-primary)]/15 border border-[var(--color-primary)]/30 text-[var(--color-primary)] hover:text-[var(--color-on-surface)] text-xs font-bold px-4 py-2 rounded-lg active:scale-95 cursor-pointer animate-pulse">
                        同步知识源
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}



            {/* 10. Proxy settings */}
            {activeTabId === 'proxy' && (
              <div className="space-y-6 animate-fadeIn">
                <div className="border-b border-[var(--color-outline)]/20 pb-3 mb-2">
                  <h3 className="text-base font-bold text-[var(--color-on-surface)]">网络与代理配置</h3>
                  <p className="text-xs text-on-surface/50 mt-1">由于跨区域网络通路差异，可为云运算节点配置代理中转</p>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <button 
                    onClick={() => setProxyMode('none')}
                    className={`p-4 rounded-xl border text-center cursor-pointer transition-all ${proxyMode === 'none' ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-on-surface)] font-bold' : 'border-[var(--color-outline)]/20 text-on-surface/50'}`}
                  >
                    <span className="text-sm font-semibold block">直连模式 (No Proxy)</span>
                    <span className="text-xs mt-1 block opacity-50">网络物理链路直接连通</span>
                  </button>

                  <button 
                    onClick={() => setProxyMode('system')}
                    className={`p-4 rounded-xl border text-center cursor-pointer transition-all ${proxyMode === 'system' ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-on-surface)] font-bold' : 'border-[var(--color-outline)]/20 text-on-surface/50'}`}
                  >
                    <span className="text-sm font-semibold block">系统环境变量代理</span>
                    <span className="text-xs mt-1 block opacity-50">自适应读取环境路由配置</span>
                  </button>

                  <button 
                    onClick={() => setProxyMode('custom')}
                    className={`p-4 rounded-xl border text-center cursor-pointer transition-all ${proxyMode === 'custom' ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-on-surface)] font-bold' : 'border-[var(--color-outline)]/20 text-on-surface/50'}`}
                  >
                    <span className="text-sm font-semibold block">手动自定义通道</span>
                    <span className="text-xs mt-1 block opacity-50">配置自建 HTTP/SOCKS 转发</span>
                  </button>
                </div>

                {proxyMode === 'custom' && (
                  <div className="p-4 bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded-xl grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <span className="text-xs text-[var(--color-primary)]/85 font-mono block">代代理地址 (Server Host)</span>
                      <input 
                        type="text" 
                        value={proxyServer}
                        onChange={(e) => setProxyServer(e.target.value)}
                        className="w-full text-sm p-3 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-lg text-[var(--color-on-surface)] font-mono focus:border-[var(--color-primary)] outline-none" 
                      />
                    </div>
                    <div className="space-y-2">
                      <span className="text-xs text-[var(--color-primary)]/85 font-mono block">连接监听端口 (Port Code)</span>
                      <input 
                        type="text" 
                        value={proxyPort}
                        onChange={(e) => setProxyPort(e.target.value)}
                        className="w-full text-sm p-3 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-lg text-[var(--color-on-surface)] font-mono focus:border-[var(--color-primary)] outline-none" 
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 11. Knowledge Base RAG settings */}
            {activeTabId === 'knowledge-base' && (
              <div className="space-y-6 animate-fadeIn">
                <div className="border-b border-[var(--color-outline)]/20 pb-3 mb-2">
                  <h3 className="text-base font-bold text-[var(--color-on-surface)]">知识库控制</h3>
                  <p className="text-xs text-on-surface/50 mt-1">新建并部署专属本地知识库，上传高价值代码文档或 PDF 参与 RAG 语义检索</p>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2 space-y-2">
                    <span className="text-xs text-on-surface/50 block">按名称过滤外部知识分片</span>
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-on-surface/40" />
                      <input 
                        type="text" 
                        placeholder="输入关键字开始全局模糊检索..."
                        value={knowledgeSearchTerm}
                        onChange={(e) => setKnowledgeSearchTerm(e.target.value)}
                        className="w-full text-sm pl-9 p-2.5 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-xl text-[var(--color-on-surface)] outline-none focus:border-[var(--color-primary)]" 
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <span className="text-xs text-[var(--color-primary)] font-mono block font-semibold">快速新建索引区</span>
                    <div className="flex gap-1.5">
                      <input 
                        type="text" 
                        placeholder="分类名称"
                        value={newKbName}
                        onChange={(e) => setNewKbName(e.target.value)}
                        className="text-sm p-2 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-lg text-[var(--color-on-surface)] font-sans outline-none focus:border-[var(--color-primary)] w-full"
                      />
                      <button 
                        onClick={createNewKbMock}
                        className="bg-[var(--color-primary)] hover:opacity-90 text-[var(--color-bg)] font-extrabold text-xs px-3.5 rounded-lg cursor-pointer transition-all"
                      >
                        创建
                      </button>
                    </div>
                  </div>
                </div>

                <div className="space-y-2 pt-1">
                  {knowledgeBases
                    .filter(kb => kb.name.toLowerCase().includes(knowledgeSearchTerm.toLowerCase()))
                    .map((kb, idx) => (
                      <div key={idx} className="p-3.5 bg-[var(--color-surface)] border border-[var(--color-outline)]/23 rounded-xl flex items-center justify-between hover:border-[var(--color-primary)]/30 transition-all shadow-sm">
                        <div className="flex items-center gap-3">
                          <Database className="w-4 h-4 text-[var(--color-primary)] animate-pulse" />
                          <div>
                            <span className="text-sm font-bold text-[var(--color-on-surface)] block">{kb.name}</span>
                            <span className="text-xs text-on-surface/50 font-mono mt-0.5">挂载结构: {kb.fileCount} 个分卷 / {kb.size} 共用缓冲区</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <button className="text-xs bg-[var(--color-surface-bright)] hover:bg-[var(--color-on-surface)]/5 text-[var(--color-on-surface)] border border-[var(--color-outline)]/15 py-1 px-3 rounded-lg cursor-pointer transition-all">
                            上传文档
                          </button>
                          <button 
                            onClick={() => setKnowledgeBases(knowledgeBases.filter((_, i) => i !== idx))}
                            className="p-1 hover:bg-red-500/10 rounded text-on-surface/40 hover:text-red-400 cursor-pointer transition-all"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                  ))}
                </div>
              </div>
            )}

            {/* 12. Channels Authorization page */}
            {activeTabId === 'channels' && (
              <div className="space-y-4 animate-fadeIn flex flex-col h-full max-h-[580px] overflow-hidden">
                <div className="border-b border-[var(--color-outline)]/20 pb-3 shrink-0">
                  <h3 className="text-base font-bold text-[var(--color-on-surface)]">消息连接注入</h3>
                  <p className="text-xs text-on-surface/50 mt-1">关联飞书、企业微信机器人或自定义 QQ Webhook，提供一击即合的主信道报警与事件归档</p>
                </div>

                {/* 3 columns Channels configuration row */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 shrink-0">
                  {/* Channel Card: Feishu */}
                  <div className="p-4 bg-[var(--color-surface-bright)]/45 border border-[var(--color-outline)]/15 rounded-xl flex flex-col gap-3 relative overflow-hidden group">
                    <div className="flex items-center justify-between">
                      <span className="text-[13.5px] font-bold text-[var(--color-on-surface)] flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${selectedChannels.feishu ? 'bg-blue-400 animate-pulse shadow-[0_0_8px_rgba(96,165,250,0.6)]' : 'bg-on-surface/30'}`} />
                        <span>飞书机器人</span>
                      </span>
                      <input 
                        type="checkbox" 
                        id="feishu-active-chk"
                        className="accent-[var(--color-primary)] cursor-pointer w-4 h-4 rounded"
                        checked={selectedChannels.feishu}
                        onChange={() => setSelectedChannels({...selectedChannels, feishu: !selectedChannels.feishu})}
                      />
                    </div>
                    
                    <div className="space-y-1">
                      <label htmlFor="feishu-url-input" className="text-[10px] uppercase font-mono tracking-wider text-on-surface/40">Webhook URL 地址</label>
                      <input 
                        type="text"
                        id="feishu-url-input"
                        placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
                        className="w-full bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded px-2.5 py-1 text-xs font-mono text-[var(--color-on-surface)] focus:border-[var(--color-primary)]/50 focus:outline-none transition-all placeholder:text-on-surface/20"
                        value={feishuUrl}
                        onChange={(e) => setFeishuUrl(e.target.value)}
                      />
                    </div>

                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[10px] text-on-surface/40 leading-tight">支持飞书群自定义助手机器人</span>
                      <button 
                        onClick={() => testChannelConnection('feishu')}
                        disabled={isTestingChannel !== null}
                        className="text-[11px] font-semibold bg-[var(--color-primary)]/15 hover:bg-[var(--color-primary)]/20 active:scale-95 text-[var(--color-primary)] hover:text-[var(--color-on-surface)] px-3 py-1 rounded transition-all cursor-pointer font-sans flex items-center gap-1.5 disabled:opacity-40"
                      >
                        {isTestingChannel === 'feishu' ? (
                          <>
                            <span className="w-2 h-2 border-2 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin" />
                            <span>诊断中</span>
                          </>
                        ) : (
                          <span>测试连接</span>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Channel Card: WeChat */}
                  <div className="p-4 bg-[var(--color-surface-bright)]/45 border border-[var(--color-outline)]/15 rounded-xl flex flex-col gap-3 relative overflow-hidden group">
                    <div className="flex items-center justify-between">
                      <span className="text-[13.5px] font-bold text-[var(--color-on-surface)] flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${selectedChannels.wechat ? 'bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.6)]' : 'bg-on-surface/30'}`} />
                        <span>企业微信</span>
                      </span>
                      <input 
                        type="checkbox" 
                        id="wechat-active-chk"
                        className="accent-[var(--color-primary)] cursor-pointer w-4 h-4 rounded"
                        checked={selectedChannels.wechat}
                        onChange={() => setSelectedChannels({...selectedChannels, wechat: !selectedChannels.wechat})}
                      />
                    </div>
                    
                    <div className="space-y-1">
                      <label htmlFor="wechat-url-input" className="text-[10px] uppercase font-mono tracking-wider text-on-surface/40">Webhook Key/地址</label>
                      <input 
                        type="text"
                        id="wechat-url-input"
                        placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send..."
                        className="w-full bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded px-2.5 py-1 text-xs font-mono text-[var(--color-on-surface)] focus:border-[var(--color-primary)]/50 focus:outline-none transition-all placeholder:text-on-surface/20"
                        value={wechatUrl}
                        onChange={(e) => setWechatUrl(e.target.value)}
                      />
                    </div>

                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[10px] text-on-surface/40 leading-tight">兼容 WxPusher / 企微 Webhook</span>
                      <button 
                        onClick={() => testChannelConnection('wechat')}
                        disabled={isTestingChannel !== null}
                        className="text-[11px] font-semibold bg-[var(--color-primary)]/15 hover:bg-[var(--color-primary)]/20 active:scale-95 text-[var(--color-primary)] hover:text-[var(--color-on-surface)] px-3 py-1 rounded transition-all cursor-pointer font-sans flex items-center gap-1.5 disabled:opacity-40"
                      >
                        {isTestingChannel === 'wechat' ? (
                          <>
                            <span className="w-2 h-2 border-2 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin" />
                            <span>诊断中</span>
                          </>
                        ) : (
                          <span>测试连接</span>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Channel Card: QQ Webhook */}
                  <div className="p-4 bg-[var(--color-surface-bright)]/45 border border-[var(--color-outline)]/15 rounded-xl flex flex-col gap-3 relative overflow-hidden group">
                    <div className="flex items-center justify-between">
                      <span className="text-[13.5px] font-bold text-[var(--color-on-surface)] flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${selectedChannels.qq ? 'bg-red-400 animate-pulse shadow-[0_0_8px_rgba(248,113,113,0.6)]' : 'bg-on-surface/30'}`} />
                        <span>QQ Webhook</span>
                      </span>
                      <input 
                        type="checkbox" 
                        id="qq-active-chk"
                        className="accent-[var(--color-primary)] cursor-pointer w-4 h-4 rounded"
                        checked={selectedChannels.qq}
                        onChange={() => setSelectedChannels({...selectedChannels, qq: !selectedChannels.qq})}
                      />
                    </div>
                    
                    <div className="space-y-1">
                      <label htmlFor="qq-url-input" className="text-[10px] uppercase font-mono tracking-wider text-on-surface/40">HTTP Webhook 地址</label>
                      <input 
                        type="text"
                        id="qq-url-input"
                        placeholder="http://127.0.0.1:5700/send_private_msg?..."
                        className="w-full bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded px-2.5 py-1 text-xs font-mono text-[var(--color-on-surface)] focus:border-[var(--color-primary)]/50 focus:outline-none transition-all placeholder:text-on-surface/20"
                        value={qqUrl}
                        onChange={(e) => setQqUrl(e.target.value)}
                      />
                    </div>

                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[10px] text-on-surface/40 leading-tight">挂载 QBot 常用轻量事件回调</span>
                      <button 
                        onClick={() => testChannelConnection('qq')}
                        disabled={isTestingChannel !== null}
                        className="text-[11px] font-semibold bg-[var(--color-primary)]/15 hover:bg-[var(--color-primary)]/20 active:scale-95 text-[var(--color-primary)] hover:text-[var(--color-on-surface)] px-3 py-1 rounded transition-all cursor-pointer font-sans flex items-center gap-1.5 disabled:opacity-40"
                      >
                        {isTestingChannel === 'qq' ? (
                          <>
                            <span className="w-2 h-2 border-2 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin" />
                            <span>诊断中</span>
                          </>
                        ) : (
                          <span>测试连接</span>
                        )}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Connection Logger terminal section */}
                <div className="flex-1 flex flex-col min-h-0 bg-black/90 rounded-2xl border border-[var(--color-outline)]/15 p-4 font-mono select-text relative">
                  {/* Console Header */}
                  <div className="flex items-center justify-between border-b border-white/5 pb-2.5 mb-2.5 shrink-0 select-none">
                    <div className="flex items-center gap-2 text-xs text-zinc-400 font-semibold font-sans">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                      <span>📡 消息连接网络诊断控制台 (Persistent Webhook Logger)</span>
                    </div>

                    <button 
                      onClick={() => setChannelLogs([{ time: new Date().toLocaleTimeString(), type: 'info', text: '终端日志已清空。消息网络连接引擎就绪。' }])}
                      className="text-[10px] text-zinc-550 hover:text-white transition-all bg-white/5 hover:bg-white/10 px-2 py-0.5 rounded cursor-pointer font-sans"
                    >
                      清空终端
                    </button>
                  </div>

                  {/* Lines Scroll area */}
                  <div className="flex-1 overflow-y-auto space-y-1.5 text-xs text-zinc-300 pr-1 select-text scrollbar-thin">
                    {channelLogs.map((log, lIdx) => (
                      <div key={lIdx} className="flex gap-2.5 items-start leading-relaxed hover:bg-white/5 px-1 py-0.5 rounded transition-colors break-all">
                        <span className="text-zinc-500 select-none shrink-0">[{log.time}]</span>
                        <span className={`shrink-0 font-bold select-none ${
                          log.type === 'success' 
                            ? 'text-emerald-400' 
                            : log.type === 'error' 
                            ? 'text-rose-400' 
                            : 'text-sky-400'
                        }`}>
                          {log.type === 'success' ? '✔ [SUCCESS]' : log.type === 'error' ? '✘ [ERROR]' : 'ℹ [INFO]'}
                        </span>
                        <span className="flex-1 text-zinc-300 font-sans text-[11.5px] leading-relaxed">{log.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* 13. Data backup management page */}
            {activeTabId === 'data-management' && (
              <div className="space-y-6 animate-fadeIn">
                <div className="border-b border-[var(--color-outline)]/20 pb-3 mb-2">
                  <h3 className="text-base font-bold text-[var(--color-on-surface)]">数据备份</h3>
                  <p className="text-xs text-on-surface/50 mt-1">一键打包冷备份或本地还原当前沙箱的所有参数与配置选项</p>
                </div>

                <div className="bg-[var(--color-surface)] border border-[var(--color-outline)]/20 p-5 rounded-2xl flex items-center justify-between">
                  <div className="space-y-1">
                    <span className="text-sm font-bold text-[var(--color-on-surface)] block">全站配置冷备份 (.json)</span>
                    <p className="text-xs text-on-surface/50 leading-relaxed">打包导出所有本地模型挂载目录、自定义 API、记忆体、自动化脚本以及风控状态</p>
                  </div>

                  <button className="bg-[var(--color-primary)] hover:opacity-90 text-[var(--color-bg)] font-extrabold text-sm px-4 py-3 rounded-xl transition-all font-mono shadow-md flex items-center gap-2 cursor-pointer active:scale-95">
                    <Save className="w-4 h-4" />
                    <span>EXPORT_CONFIG_DATA.JSON</span>
                  </button>
                </div>
              </div>
            )}
              </motion.div>
            </AnimatePresence>

          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
