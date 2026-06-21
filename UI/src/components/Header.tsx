import React, { useState, useEffect, useMemo, useCallback, memo } from 'react';
import { Layers, ChevronDown, Plus, Minus, X, Laptop, Folder, FileCode, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { SecondaryModel } from '../types';
import { useTheme } from '../context/ThemeContext';
import { ModelIcon } from './ModelIcon';

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

interface SecondaryModelSelectorProps {
  secModels: SecondaryModel[];
  allAvailableModelsList: string[];
  addSecModel: (m: string) => void;
  removeSecModel: (mId: string) => void;
  changeSecModelWeight: (idx: number, delta: number) => void;
  setSecModelWeightDirect: (idx: number, val: number) => void;
  updateSecModelAtIndex: (idx: number, value: string) => void;
  onOpenChange?: (open: boolean) => void;
}

const SecondaryModelSelector = memo(({
  secModels,
  allAvailableModelsList,
  addSecModel,
  removeSecModel,
  changeSecModelWeight,
  setSecModelWeightDirect,
  updateSecModelAtIndex,
  onOpenChange,
}: SecondaryModelSelectorProps) => {
  const [showSubmodelManager, setShowSubmodelManager] = useState(false);

  useEffect(() => {
    onOpenChange?.(showSubmodelManager);
  }, [showSubmodelManager, onOpenChange]);

  const totalWeight = useMemo(() => {
    return secModels.reduce((acc, curr) => acc + curr.weight, 0);
  }, [secModels]);

  const modelStatusResolver = useMemo(() => {
    return getModelStatusResolver();
  }, [showSubmodelManager, secModels]);

  return (
    <div className={`relative ${showSubmodelManager ? 'z-50' : ''}`}>
      <motion.button
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.97 }}
        onClick={() => {
          setShowSubmodelManager(!showSubmodelManager);
        }}
        className={`flex items-center gap-1.5 px-4 h-[30px] rounded-full text-xs font-bold select-none cursor-pointer border whitespace-nowrap flex-nowrap transition-colors duration-150 touch-manipulation ${
          showSubmodelManager 
            ? 'bg-[var(--color-primary)] text-[var(--color-surface)] border-[var(--color-primary)] shadow-lg shadow-primary/25' 
            : 'bg-[var(--color-surface)]/60 hover:bg-[var(--color-surface)]/90 text-[var(--color-primary)] border-[var(--color-outline)]/30 hover:border-[var(--color-outline)]/60'
        }`}
        title="点击展开项目副模型控制台"
      >
        <motion.div
          animate={{ rotate: showSubmodelManager ? [0, -10, 10, 0] : 0 }}
          transition={{ duration: 0.4 }}
          className="flex items-center justify-center shrink-0"
        >
          <Layers className="w-3.5 h-3.5" />
        </motion.div>
        <span>协同副模型</span>
        <motion.div
          animate={{ 
            rotate: showSubmodelManager ? 180 : 0,
            scale: showSubmodelManager ? 1.1 : 1
          }}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
          className="flex items-center justify-center shrink-0"
        >
          <ChevronDown className="w-3.5 h-3.5 opacity-80" />
        </motion.div>
      </motion.button>

      {/* Scientific Submodels Control Panel Popover */}
      <AnimatePresence>
        {showSubmodelManager && (
          <div
            key="overlay"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => {
              setShowSubmodelManager(false);
            }}
          />
        )}
        {showSubmodelManager && (
          <motion.div
            key="popover"
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -4 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className="absolute right-0 mt-3.5 w-80 bg-[var(--color-surface)] border border-[var(--color-outline)]/45 rounded-2xl shadow-[0_24px_64px_rgba(0,0,0,0.15)] p-4 flex flex-col font-sans z-50 text-left cursor-default max-h-[500px] overflow-visible"
          >
            <div className="flex items-center justify-between border-b border-[var(--color-outline)]/20 pb-2.5 mb-3">
                <div className="text-[10px] bg-primary/10 border border-primary/25 text-primary px-2.5 py-0.5 rounded-full font-mono font-bold leading-none">
                  插槽数: {secModels.length}
                </div>
              </div>

              {/* List of active submodel slots */}
              <div className="flex flex-col gap-2.5 overflow-y-auto max-h-[200px] mb-3 pr-1 scrollbar-thin">
                {secModels.length === 0 ? (
                  <div className="text-center py-5 text-on-surface/40 text-[11px] leading-relaxed border border-dashed border-[var(--color-outline)]/30 rounded-xl bg-[var(--color-surface-bright)]/40 select-none font-sans">
                    暂未添加任何副模型插槽<br/>
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
                            
                            {/* Stylized native select dropdown without status dot */}
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
                                  backgroundSize: '8px'
                                }}
                                title="选择并切换此插槽的副模型"
                              >
                                {allAvailableModelsList.map((m) => {
                                  return (
                                    <option key={m} value={m} className="bg-[var(--color-surface)] text-[var(--color-on-surface)] font-sans">
                                      {m}
                                    </option>
                                  );
                                })}
                              </select>
                            </div>
                          </div>

                          {/* Slot Delete Button */}
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

                        {/* Row 2: Tactile interactive weight slider and percentage badge */}
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
                            style={{
                              accentColor: 'var(--color-primary)'
                            }}
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
                          
                          {/* Ratio output badge */}
                          <div className="text-[9px] bg-emerald-500/10 border border-emerald-500/25 text-emerald-600 dark:text-emerald-400 font-mono font-bold rounded px-1.5 min-w-[34px] text-center select-none">
                            {percentage}%
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Interactive dynamic add slot section */}
              <div className="border-t border-[var(--color-outline)]/20 pt-3 flex flex-col">
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
              </div>
            </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
SecondaryModelSelector.displayName = 'SecondaryModelSelector';

interface HeaderProps {
  mainModel: string;
  setMainModel: (m: string) => void;
  secModels: SecondaryModel[];
  setSecModels: (models: SecondaryModel[]) => void;
  mixedTasks: boolean;
  setMixedTasks: (val: boolean) => void;
  permissionMode: 'normal' | 'performance' | 'ultimate' | 'expert';
  sidebarWidth?: number;
  isResizingSidebar?: boolean;
  selectedFile: string;
  setSelectedFile: (file: string) => void;
}

export default function Header({
  mainModel,
  setMainModel,
  secModels,
  setSecModels,
  mixedTasks,
  setMixedTasks,
  permissionMode,
  sidebarWidth = 298,
  isResizingSidebar = false,
  selectedFile,
  setSelectedFile,
}: HeaderProps) {
  const { currentThemeId } = useTheme();
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [isSecModelSelectorOpen, setIsSecModelSelectorOpen] = useState(false);
  const [hoveredMenuItem, setHoveredMenuItem] = useState<string | null>(null);

  const leftPosition = useMemo(() => {
    // If mixedTasks is active, we need more space on the right, so we clamp left position more tightly
    const maxLeft = mixedTasks ? 'calc(100% - 660px)' : 'calc(100% - 500px)';
    return `clamp(160px, ${sidebarWidth}px, ${maxLeft})`;
  }, [sidebarWidth, mixedTasks]);

  // Real-time breadcrumb state and navigation utilities
  const [activeDropdownPath, setActiveDropdownPath] = useState<string | null>(null);

  const segments = useMemo(() => {
    if (!selectedFile) return [];
    return selectedFile.split('/');
  }, [selectedFile]);

  const breadcrumbItems = useMemo(() => {
    return segments.map((seg, idx) => {
      const isLast = idx === segments.length - 1;
      const path = segments.slice(0, idx + 1).join('/');
      return {
        name: seg,
        path,
        isLast,
        type: isLast ? 'file' : 'folder' as 'file' | 'folder'
      };
    });
  }, [segments]);

  interface FileNode {
    name: string;
    type: 'file' | 'folder';
    path: string;
    children?: FileNode[];
  }

  const getFolderChildren = useCallback((folderPath: string): FileNode[] => {
    try {
      const saved = localStorage.getItem('soloforge_fileTree');
      let rootNode: FileNode | null = saved ? JSON.parse(saved) : null;
      
      if (!rootNode) {
        rootNode = { name: 'BlogSystem', type: 'folder', path: 'BlogSystem', children: [] };
        const mockKeys = [
          'BlogSystem/src/App.vue',
          'BlogSystem/src/main.js',
          'BlogSystem/.gitignore',
          'BlogSystem/package.json',
          'BlogSystem/README.md',
          'BlogSystem/vite.config.js',
        ];
        
        const addPathToTree = (fullPath: string, parentNode: FileNode) => {
          const parts = fullPath.split('/');
          let curr = parentNode;
          for (let i = 1; i < parts.length; i++) {
            const part = parts[i];
            const isLatest = i === parts.length - 1;
            let child = curr.children?.find(c => c.name === part);
            if (!child) {
              child = {
                name: part,
                type: isLatest ? 'file' : 'folder',
                path: parts.slice(0, i + 1).join('/'),
                children: isLatest ? undefined : []
              };
              curr.children = curr.children || [];
              curr.children.push(child);
            }
            curr = child;
          }
        };
        
        mockKeys.forEach(k => addPathToTree(k, rootNode!));
      }
      
      const findNode = (node: FileNode, path: string): FileNode | null => {
        if (node.path === path) return node;
        if (node.children) {
          for (const child of node.children) {
            const found = findNode(child, path);
            if (found) return found;
          }
        }
        return null;
      };
      
      const matched = findNode(rootNode, folderPath);
      return matched?.children || [];
    } catch (e) {
      console.error('Error fetching breadcrumb children', e);
      return [];
    }
  }, []);

  const getFirstFileRecursively = useCallback((node: FileNode): string | null => {
    if (node.type === 'file') return node.path;
    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        const file = getFirstFileRecursively(child);
        if (file) return file;
      }
    }
    return null;
  }, []);

  const [logoSrc, setLogoSrc] = useState('/logo.png');
  const [logoError, setLogoError] = useState(false);

  const handleLogoError = () => {
    if (logoSrc === '/logo.png') {
      setLogoSrc('logo.png');
    } else if (logoSrc === 'logo.png') {
      setLogoSrc('/src/assets/logo.png');
    } else {
      setLogoError(true);
    }
  };

  const getDynamicModels = () => {
    try {
      const saved = localStorage.getItem('cherry_providers_v2');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          const enabledList: string[] = [];
          parsed.forEach((prov: any) => {
            if (prov.enabled) {
              if (Array.isArray(prov.models)) {
                prov.models.forEach((m: any) => {
                  if (m.enabled) {
                    enabledList.push(m.id);
                  }
                });
              }
              if (Array.isArray(prov.customModels)) {
                prov.customModels.forEach((cm: any) => {
                  enabledList.push(cm);
                });
              }
            }
          });
          if (enabledList.length > 0) {
            return enabledList;
          }
        }
      }
    } catch (e) {
      console.error('Error loading dynamic models for header', e);
    }
    return ['GPT-4o', 'GPT-4-turbo', 'Claude-3.5-Sonnet', 'Gemini-1.5-Pro', 'DeepSeek-R1'];
  };

  const getDynamicSecondarySubmodels = () => {
    try {
      const saved = localStorage.getItem('cherry_providers_v2');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          const allList: string[] = [];
          parsed.forEach((prov: any) => {
            if (prov.enabled) {
              if (Array.isArray(prov.models)) {
                prov.models.forEach((m: any) => {
                  allList.push(m.id);
                });
              }
              if (Array.isArray(prov.customModels)) {
                prov.customModels.forEach((cm: any) => {
                  allList.push(cm);
                });
              }
            }
          });
          if (allList.length > 0) {
            return allList;
          }
        }
      }
    } catch (e) {
      console.error('Error loading secondary models list', e);
    }
    return [
      'DeepSeek-V3',
      'Gemini-1.5-Pro',
      'Llama-3.1-70B',
      'Claude-3-Haiku',
      'Llama-3.2 (本地)',
      'Qwen-2.5-7B (本地)',
      'DeepSeek-R1-Distill (本地)',
      'Mistral-7B (本地)',
      'GPT-4o',
      'Claude-3.5-Sonnet'
    ];
  };

  const [availableModels, setAvailableModels] = useState<string[]>(() => {
    return getDynamicModels();
  });
  const [allAvailableModelsList, setAllAvailableModelsList] = useState<string[]>(() => {
    return getDynamicSecondarySubmodels();
  });

  useEffect(() => {
    const refreshLists = () => {
      setAvailableModels(getDynamicModels());
      setAllAvailableModelsList(getDynamicSecondarySubmodels());
    };
    refreshLists();
    // Also update on global storage event or custom update event if settings are saved
    window.addEventListener('storage', refreshLists);
    window.addEventListener('providers_updated', refreshLists);
    return () => {
      window.removeEventListener('storage', refreshLists);
      window.removeEventListener('providers_updated', refreshLists);
    };
  }, []);

  const addSecModel = useCallback((m: string) => {
    if (!secModels.some((sm) => sm.name === m)) {
      setSecModels([...secModels, { id: m, name: m, weight: 5 }]);
    }
  }, [secModels, setSecModels]);

  const removeSecModel = useCallback((mId: string) => {
    setSecModels(secModels.filter((sm) => sm.id !== mId));
  }, [secModels, setSecModels]);

  const changeSecModelWeight = useCallback((idx: number, delta: number) => {
    const updated = [...secModels];
    if (!updated[idx]) return;
    const newWeight = Math.min(10, Math.max(1, updated[idx].weight + delta));
    updated[idx] = {
      ...updated[idx],
      weight: newWeight
    };
    setSecModels(updated);
  }, [secModels, setSecModels]);

  const setSecModelWeightDirect = useCallback((idx: number, val: number) => {
    const updated = [...secModels];
    if (!updated[idx]) return;
    updated[idx] = {
      ...updated[idx],
      weight: Math.min(10, Math.max(1, val))
    };
    setSecModels(updated);
  }, [secModels, setSecModels]);

  const updateSecModelAtIndex = useCallback((idx: number, value: string) => {
    const updated = [...secModels];
    if (!updated[idx]) return;
    updated[idx] = { ...updated[idx], id: value, name: value };
    setSecModels(updated);
  }, [secModels, setSecModels]);

  const totalWeight = secModels.reduce((acc, curr) => acc + curr.weight, 0);


  return (
    <header className="relative h-[48px] bg-surface border-b border-outline/50 flex items-center justify-between px-3 shrink-0 select-none text-on-surface font-sans z-[60]">
      {/* Left logo & info and breadcrumbs */}
      <div className="flex items-center gap-2 shrink-0 z-10 mr-4">
        <div className="flex items-center gap-2 cursor-pointer select-none">
          {!logoError ? (
            /* Multi-fallback image loader that probes relative and absolute directory trees */
            <img 
              src={logoSrc} 
              alt="SoloForge" 
              className="h-[28px] w-auto shrink-0 object-contain block"
              onError={handleLogoError}
              referrerPolicy="no-referrer"
            />
          ) : null}

          {/* Render the core branded text and stylized lighting icon if image cannot be resolved/loaded on screen */}
          {(logoSrc === '/src/assets/logo.png' || logoError) && (
            <div className="flex items-center gap-2">
              <div className="flex items-center justify-center p-0.5 shrink-0 text-[#FF4500]">
                <svg className="w-[30px] h-[30px] fill-current" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                  <path d="M51 26 L41 44 L11 49 L39 46.5 L73 46.5 L43 51.5 L18 72 L44 48 L41 44 Z" />
                  <path d="M36 68 L48 56.5 L41 56.5 Z" />
                </svg>
              </div>
              <div className="flex items-baseline font-sans gap-[1px]">
                <span className="font-bold text-[15px] text-on-surface tracking-tight">Solo</span>
                <span className="font-black text-[15px] text-[#FF4500] tracking-tight">Forge</span>
              </div>
            </div>
          )}
        </div>


      </div>

      {/* Center options: Main model & Mixed task settings, aligned with the left panel boundary dynamically and set to overflow-visible to prevent dropdown clipping */}
      <div 
        style={{ 
          left: leftPosition,
          transition: isResizingSidebar ? 'none' : 'left 250ms cubic-bezier(0.16, 1, 0.3, 1), border-color 200ms, background-color 200ms'
        }}
        className={`absolute top-1/2 -translate-y-1/2 flex items-center bg-[var(--color-surface-bright)]/90 backdrop-blur-md border border-[var(--color-outline)]/40 hover:border-[var(--color-outline)]/85 px-5 py-1.5 h-[40px] rounded-full shadow-[0_8px_24px_rgba(0,0,0,0.12)] text-xs md:text-sm font-sans gap-4 overflow-visible transition-all ${(showModelMenu || isSecModelSelectorOpen) ? 'z-50' : 'z-20'}`}
      >
        {/* Main Model Selector */}
        <div className="flex items-center gap-2 shrink-0 pl-0.5">
          <span className="text-xs text-on-surface/50 font-bold tracking-wide font-sans select-none">主模型</span>
          <div className={`relative font-sans ${showModelMenu ? 'z-50' : ''}`}>
            <button
              onClick={() => setShowModelMenu(!showModelMenu)}
              className="flex items-center gap-1.5 bg-[var(--color-surface)]/60 hover:bg-[var(--color-surface)]/90 border border-[var(--color-outline)]/30 hover:border-[var(--color-outline)]/60 px-3 h-[30px] rounded-full text-xs text-[var(--color-on-surface)] active:scale-95 transition-all cursor-pointer font-bold select-none overflow-visible"
            >
              <ModelIcon modelName={mainModel} size={20} className="shrink-0" />
              <div className="h-4 overflow-hidden relative flex items-center justify-center min-w-[84px]">
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={mainModel}
                    initial={{ y: -12, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: 12, opacity: 0 }}
                    transition={{ duration: 0.18, ease: "easeOut" }}
                    className="inline-block whitespace-nowrap text-primary"
                  >
                    {mainModel}
                  </motion.span>
                </AnimatePresence>
              </div>
              <motion.div
                animate={{ rotate: showModelMenu ? 180 : 0 }}
                transition={{ duration: 0.2 }}
                className="flex items-center justify-center shrink-0"
              >
                <ChevronDown className="w-3.5 h-3.5 text-on-surface/40" />
              </motion.div>
            </button>
            <AnimatePresence>
              {showModelMenu && (
                <>
                  <div
                    className="fixed inset-0 z-40 bg-transparent"
                    onClick={() => setShowModelMenu(false)}
                  />
                  <motion.div
                    initial={{ opacity: 0, y: -6, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.96 }}
                    transition={{ duration: 0.12, ease: "easeOut" }}
                    className="absolute left-0 mt-3.5 w-52 bg-[var(--color-surface)] border border-[var(--color-outline)]/35 rounded-xl shadow-[0_16px_48px_rgba(0,0,0,0.15)] z-50 p-1 flex flex-col gap-0.5"
                  >
                    {availableModels.map((m) => {
                      const isSelected = mainModel === m;
                      return (
                        <button
                          key={m}
                          onClick={() => {
                            setMainModel(m);
                            setShowModelMenu(false);
                          }}
                          className={`relative w-full text-left px-3 py-2 rounded-lg text-xs font-semibold flex items-center justify-between select-none cursor-pointer transition-all duration-150 ease-out hover:bg-primary/10 ${
                            isSelected ? 'text-primary font-bold' : 'text-[var(--color-on-surface)]/80 hover:text-[var(--color-on-surface)]'
                          }`}
                        >
                          <span className="relative z-10 flex items-center gap-2">
                            <ModelIcon modelName={m} size={20} className="shrink-0" />
                            <span>{m}</span>
                          </span>
                          {isSelected && (
                            <motion.span 
                              layoutId="active-model-indicator"
                              className="relative z-10 w-1.5 h-1.5 rounded-full bg-primary"
                              transition={{ type: "spring", stiffness: 400, damping: 28 }}
                            />
                          )}
                        </button>
                      );
                    })}
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Divider */}
        <div className="w-[1px] h-4 bg-[var(--color-outline)]/40 shrink-0" />

        {/* Multi-role Hybrid task toggle */}
        <div 
          className={`flex items-center gap-2.5 h-[30px] px-1 transition-all ${
            permissionMode !== 'normal' 
              ? 'opacity-100' 
              : 'opacity-30'
          }`}
          title={
            permissionMode !== 'normal'
              ? "多模型混合任务"
              : "多模型混合在「普通模式」下停用，其他模式均可开启"
          }
        >
          <span className="text-xs text-on-surface/50 font-bold tracking-wide font-sans select-none">混合任务</span>
          <button
            disabled={permissionMode === 'normal'}
            onClick={() => {
              if (permissionMode !== 'normal') {
                setMixedTasks(!mixedTasks);
              }
            }}
            className={`w-[38px] h-[20px] rounded-full p-0.5 transition-all flex items-center shrink-0 ${
              permissionMode === 'normal'
                ? 'bg-neutral-500/20 cursor-not-allowed justify-start'
                : mixedTasks 
                  ? 'bg-[var(--color-primary)] justify-end cursor-pointer shadow-sm shadow-primary/25' 
                  : 'bg-[var(--color-outline)]/30 justify-start cursor-pointer hover:bg-[var(--color-outline)]/50'
            }`}
          >
            <span className={`w-3.5 h-3.5 rounded-full block ${mixedTasks ? 'bg-[var(--color-surface)]' : 'bg-on-surface/60'}`} />
          </button>
        </div>

        {/* Secondary Models dynamic tags */}
        <AnimatePresence>
          {mixedTasks && (
            <motion.div
              initial={{ opacity: 0, width: 0, marginLeft: 0, overflow: "hidden" }}
              animate={{ 
                opacity: 1, 
                width: "auto", 
                marginLeft: 4,
                transitionEnd: { overflow: "visible" }
              }}
              exit={{ opacity: 0, width: 0, marginLeft: 0, overflow: "hidden" }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              className="flex items-center gap-2 border-l border-[var(--color-outline)]/40 pl-3 whitespace-nowrap flex-nowrap"
            >
              <SecondaryModelSelector
                secModels={secModels}
                allAvailableModelsList={allAvailableModelsList}
                addSecModel={addSecModel}
                removeSecModel={removeSecModel}
                changeSecModelWeight={changeSecModelWeight}
                setSecModelWeightDirect={setSecModelWeightDirect}
                updateSecModelAtIndex={updateSecModelAtIndex}
                onOpenChange={setIsSecModelSelectorOpen}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Right User info and window mock controllers */}
      <div className="flex items-center gap-4 shrink-0 z-10 bg-surface">
        {/* User profile avatar info with online indicator */}
        <div className="flex items-center gap-2 border-r border-outline/50 pr-4 py-1">
          <div className="relative">
            <img
              src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=80&fit=crop&q=80"
              alt="SoloDev"
              className="w-6 h-6 rounded-full border border-primary/40 object-cover"
              referrerPolicy="no-referrer"
            />
            <span className="absolute bottom-0 right-0 w-1.5 h-1.5 bg-green-500 rounded-full border border-black" />
          </div>
          <div className="flex flex-col text-left">
            <span className="text-[11px] font-bold text-[var(--color-on-surface)] tracking-wide">SoloDev</span>
            <span className="text-[8px] text-green-600 dark:text-green-400/80 -mt-0.5 font-mono">在线</span>
          </div>
        </div>

        {/* Windows title controller mockup block */}
        <div className="flex items-center gap-2.5 text-on-surface/40">
          <button className="hover:text-[var(--color-on-surface)] transition-colors cursor-pointer">
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button className="hover:text-[var(--color-on-surface)] transition-colors cursor-pointer">
            <Laptop className="w-3.5 h-3.5" />
          </button>
          <button className="hover:text-red-400 transition-colors cursor-pointer">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
}
