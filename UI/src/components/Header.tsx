import React, { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react';
import { ChevronDown, Folder, FileCode, ChevronRight } from 'lucide-react';
import { SecondaryModelSelector } from './header-bar';
import { SecondaryModel } from '../types';
import { useTheme } from '../context/ThemeContext';
import { ModelIcon } from './ModelIcon';
import { WindowControls } from './WindowControls';

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
            // 顶部主模型下拉要求:服务商已启用 AND 测试通过 AND 模型已启用
            if (prov.enabled && prov.status === 'success') {
              if (Array.isArray(prov.models)) {
                prov.models.forEach((m: any) => {
                  if (m.enabled) {
                    enabledList.push(m.id);
                  }
                });
              }
              if (Array.isArray(prov.customModels)) {
                prov.customModels.forEach((cm: any) => {
                  if (typeof cm === 'string') {
                    enabledList.push(cm);
                  } else if (cm && cm.id && cm.enabled !== false) {
                    enabledList.push(cm.id);
                  }
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

  // 2026: 自定义窗口拖动(完全绕过 OS drag,消除 Win11 snap layout 的尺寸说明 tooltip)
  // 之前用 CSS -webkit-app-region:drag,OS 收到 WM_ENTERSIZEMOVE → DWM 画 snap tooltip
  // 改成:Header 自己抓 mousedown,走 IPC 调 setPosition,OS 永远收不到 drag event
  const dragRef = useRef<{ startX: number; startY: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      e.preventDefault();
      const dx = e.screenX - cur.startX;
      const dy = e.screenY - cur.startY;
      cur.startX = e.screenX;
      cur.startY = e.screenY;
      const api = (window as any).soloforge?.moveWindow;
      if (typeof api === 'function') api(dx, dy).catch(() => {});
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);
  const onHeaderMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    // 排除所有交互元素(按钮/输入框/链接/下拉等),让点击能正常触发
    const t = e.target as HTMLElement;
    if (t.closest('button, input, select, textarea, a, [role="button"], [role="combobox"], [role="listbox"], [role="menuitem"], [data-no-drag]')) return;
    // 排除 WindowControls(右上角自定义窗口按钮区)
    if (t.closest('[data-window-controls]')) return;
    e.preventDefault();
    dragRef.current = { startX: e.screenX, startY: e.screenY };
    document.body.style.userSelect = 'none';
  };


  return (
    <header
      onMouseDown={onHeaderMouseDown}
      className="soloforge-drag-header relative h-[48px] bg-surface border-b border-outline/50 flex items-center justify-between pl-3 shrink-0 select-none text-on-surface font-sans z-[60]"
    >
      {/* 2026: 不再使用 Electron titleBarOverlay(native "−/□/×" 在 Win11 22H2+ 会被 DWM 强行加暗色 tint)
          改用 <WindowControls /> 在 React 端画按钮,背景 100% 跟 --color-surface 一致,主题色切换时自动跟随
          注意:Header 父级 .soloforge-drag-header 是 -webkit-app-region: drag;
                WindowControls 自己内部用 WebkitAppRegion:'no-drag' 阻止按钮区域被 drag 捕获 */}
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
                <span
                  key={mainModel}
                  className="sf-anim sf-anim-slide-right inline-block whitespace-nowrap text-primary"
                >
                  {mainModel}
                </span>
              </div>
              <div className={`flex items-center justify-center shrink-0 transition-transform duration-200 ${showModelMenu ? 'rotate-180' : 'rotate-0'}`}>
                <ChevronDown className="w-3.5 h-3.5 text-on-surface/40" />
              </div>
            </button>
            <MountTransition show={showModelMenu} variant="fade-scale" duration={140}>
              {showModelMenu && (
                <>
                  <div
                    className="fixed inset-0 z-40 bg-transparent"
                    onClick={() => setShowModelMenu(false)}
                  />
                  <div
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
                            <span
                              className="sf-anim sf-anim-fade-scale relative z-10 w-1.5 h-1.5 rounded-full bg-primary"
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </MountTransition>
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
        <div
          className={`sf-anim sf-anim-fade flex items-center gap-2 border-l border-[var(--color-outline)]/40 pl-3 whitespace-nowrap flex-nowrap ${mixedTasks ? '' : 'opacity-0 w-0 ml-0 overflow-hidden'}`}
        >
          {mixedTasks && (
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
          )}
        </div>
      </div>

      {/* Right User info + 自定义窗口控制按钮 */}
      <div className="flex items-center shrink-0 z-10 bg-surface">
        {/* User profile avatar info with online indicator */}
        <div className="flex items-center gap-2 border-r border-outline/50 pr-4 py-1 mr-2">
          <div className="relative">
            <div
              role="img"
              aria-label="SoloDev"
              className="w-6 h-6 rounded-full border border-primary/40 flex items-center justify-center"
              style={{
                background:
                  'linear-gradient(135deg, #ffde82 0%, #f5b461 50%, #c97f3a 100%)',
                color: '#121414',
                fontSize: 11,
                fontWeight: 700,
                lineHeight: 1,
              }}
            >
              S
            </div>
            <span className="absolute bottom-0 right-0 w-1.5 h-1.5 bg-green-500 rounded-full border border-black" />
          </div>
          <div className="flex flex-col text-left">
            <span className="text-[11px] font-bold text-[var(--color-on-surface)] tracking-wide">SoloDev</span>
            <span className="text-[8px] text-green-600 dark:text-green-400/80 -mt-0.5 font-mono">在线</span>
          </div>
        </div>

        {/* 2026: 自定义窗口控件(替代 Electron titleBarOverlay)
            按钮背景 100% 跟 Header 的 bg-surface 一致 → 不再有 DWM 暗 tint → 跟主页面颜色完美融合 */}
        <WindowControls />
      </div>
    </header>
  );
}
