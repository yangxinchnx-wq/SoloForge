import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  SecondaryModelSelector,
  MainModelSelector,
  CentralControlPill,
  ToggleSwitch,
  UserBadgeSelector,
} from './header-bar';
import { useThemedSurface } from './header-bar/themeColors';
import { SecondaryModel } from '../types';
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
}: HeaderProps) {
  const themed = useThemedSurface();
  const { glass, isDark, rgba, headerSurface } = themed;
  const [isSecModelSelectorOpen, setIsSecModelSelectorOpen] = useState(false);
  const [hasMainModelOpen, setHasMainModelOpen] = useState(false);
  const anyDropdownOpen = hasMainModelOpen || isSecModelSelectorOpen;

  // ── 中心胶囊的左偏移(根据 sidebar 宽度 + 混合任务状态) ──────────────
  const leftPosition = useMemo(() => {
    const maxLeft = mixedTasks ? 'calc(100% - 700px)' : 'calc(100% - 540px)';
    return `clamp(180px, ${sidebarWidth}px, ${maxLeft})`;
  }, [sidebarWidth, mixedTasks]);

  // ── Providers 持久化读取(主模型可用列表 + 副模型候选) ──────────────
  const getDynamicModels = () => {
    try {
      const saved = localStorage.getItem('cherry_providers_v2');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          const enabledList: string[] = [];
          parsed.forEach((prov: any) => {
            if (prov.enabled && prov.status === 'success') {
              if (Array.isArray(prov.models)) {
                prov.models.forEach((m: any) => {
                  if (m.enabled) enabledList.push(m.id);
                });
              }
              if (Array.isArray(prov.customModels)) {
                prov.customModels.forEach((cm: any) => {
                  if (typeof cm === 'string') enabledList.push(cm);
                  else if (cm && cm.id && cm.enabled !== false) enabledList.push(cm.id);
                });
              }
            }
          });
          if (enabledList.length > 0) return enabledList;
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
              if (Array.isArray(prov.models)) prov.models.forEach((m: any) => allList.push(m.id));
              if (Array.isArray(prov.customModels)) prov.customModels.forEach((cm: any) => allList.push(cm));
            }
          });
          if (allList.length > 0) return allList;
        }
      }
    } catch (e) {
      console.error('Error loading secondary models list', e);
    }
    return [
      'DeepSeek-V3', 'Gemini-1.5-Pro', 'Llama-3.1-70B', 'Claude-3-Haiku',
      'Llama-3.2 (本地)', 'Qwen-2.5-7B (本地)', 'DeepSeek-R1-Distill (本地)',
      'Mistral-7B (本地)', 'GPT-4o', 'Claude-3.5-Sonnet',
    ];
  };

  const [availableModels, setAvailableModels] = useState<string[]>(() => getDynamicModels());
  const [allAvailableModelsList, setAllAvailableModelsList] = useState<string[]>(() => getDynamicSecondarySubmodels());

  useEffect(() => {
    const refreshLists = () => {
      setAvailableModels(getDynamicModels());
      setAllAvailableModelsList(getDynamicSecondarySubmodels());
    };
    refreshLists();
    window.addEventListener('storage', refreshLists);
    window.addEventListener('providers_updated', refreshLists);
    return () => {
      window.removeEventListener('storage', refreshLists);
      window.removeEventListener('providers_updated', refreshLists);
    };
  }, []);

  // ── 副模型集合的增删改 ──────────────────────────────────────────────
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
    updated[idx] = { ...updated[idx], weight: Math.min(10, Math.max(1, updated[idx].weight + delta)) };
    setSecModels(updated);
  }, [secModels, setSecModels]);

  const setSecModelWeightDirect = useCallback((idx: number, val: number) => {
    const updated = [...secModels];
    if (!updated[idx]) return;
    updated[idx] = { ...updated[idx], weight: Math.min(10, Math.max(1, val)) };
    setSecModels(updated);
  }, [secModels, setSecModels]);

  const updateSecModelAtIndex = useCallback((idx: number, value: string) => {
    const updated = [...secModels];
    if (!updated[idx]) return;
    updated[idx] = { ...updated[idx], id: value, name: value };
    setSecModels(updated);
  }, [secModels, setSecModels]);

  // ── Logo 多回退 ─────────────────────────────────────────────────────
  const [logoSrc, setLogoSrc] = useState('/logo.png');
  const [logoError, setLogoError] = useState(false);
  const handleLogoError = () => {
    if (logoSrc === '/logo.png') setLogoSrc('logo.png');
    else if (logoSrc === 'logo.png') setLogoSrc('/src/assets/logo.png');
    else setLogoError(true);
  };

  // 2026-07-04 主进程轮询模式 (根治 mousemove 事件风暴 + 卡死)
  // 旧方案: renderer 监听 mousemove → 每帧 IPC moveWindow → 主进程 setPosition
  //   问题: 每秒 100+ 次 IPC 往返 + setPosition 触发 resize 事件 → 整个 React 树重渲染 → 卡死 + 风扇起飞
  //
  // 新方案: renderer mousedown 时一次 IPC drag-start, mouseup 时一次 IPC drag-stop
  //   主进程用 setInterval(16ms) 自己读 screen.getCursorScreenPoint() + setPosition
  //   渲染器零事件监听, 零 IPC 往返 (拖动期间)
  const draggingRef = useRef(false);

  const onHeaderMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest('button, input, select, textarea, a, [role="button"], [role="combobox"], [role="listbox"], [role="menuitem"], [data-no-drag]')) {
      return;
    }
    if (t.closest('[data-window-controls]')) {
      return;
    }
    // 仅响应主键 (左键)
    if (e.button !== 0) return;
    e.preventDefault();
    const api = (window as any).soloforge;
    const dragStart = api?.dragStart;
    const dragStop = api?.dragStop;
    if (typeof dragStart !== 'function' || typeof dragStop !== 'function') return;
    draggingRef.current = true;
    document.body.style.userSelect = 'none';
    dragStart().catch(() => {});
  };

  // 全局 mouseup — 拖拽结束, 一次 IPC drag-stop
  useEffect(() => {
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.userSelect = '';
      const dragStop = (window as any).soloforge?.dragStop;
      if (typeof dragStop === 'function') {
        dragStop().catch(() => {});
      }
    };
    // 防止鼠标拖出窗口后释放未触发: 同时监听窗口失焦
    const onBlur = () => {
      if (!draggingRef.current) return;
      onUp();
    };
    window.addEventListener('mouseup', onUp, { passive: true });
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  return (
    <header
      onMouseDown={onHeaderMouseDown}
      className="soloforge-drag-header relative h-[52px] flex items-center justify-between pl-4 pr-0 shrink-0 select-none font-sans z-[60]"
      style={{
        // ── Editorial Glass Header 底色(主题色对齐) ──────────────
        // 顶部 1px 内 highlight + 半透明 surface + 底部 1px hairline 金色
        background: headerSurface,
        backdropFilter: 'blur(18px) saturate(140%)',
        WebkitBackdropFilter: 'blur(18px) saturate(140%)',
        borderBottom: `1px solid ${rgba('--color-primary-rgb', glass.hairlineAlpha * 0.6)}`,
        boxShadow: `0 1px 0 ${isDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.65)'} inset, ${isDark ? '0 6px 18px rgba(0,0,0,0.18)' : '0 4px 12px rgba(0,0,0,0.04)'}`,
        color: 'var(--color-on-surface)',
      }}
    >
      {/* ─── 左: Logo + 品牌名(Editorial Glass · 字面 + 字符记号) ───── */}
      <div className="flex items-center gap-3 shrink-0 z-10 min-w-0">
        <div className="flex items-center gap-2.5 select-none">
          {!logoError && (
            <img
              src={logoSrc}
              alt="SoloForge"
              className="h-[26px] w-auto shrink-0 object-contain block"
              onError={handleLogoError}
              referrerPolicy="no-referrer"
            />
          )}

          {(logoSrc === '/src/assets/logo.png' || logoError) && (
            <>
              {/* Editorial 字符记号: S/F 字母配金条, 字距紧 + 微微光晕 */}
              <div
                className="flex items-center justify-center shrink-0"
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 9,
                  background: `linear-gradient(135deg, ${rgba('--color-primary-rgb', 0.20)} 0%, ${rgba('--color-primary-rgb', 0.06)} 100%)`,
                  border: `1px solid ${rgba('--color-primary-rgb', 0.45)}`,
                  boxShadow: `${isDark ? '0 2px 8px rgba(0,0,0,0.30)' : '0 2px 6px rgba(0,0,0,0.06)'}, inset 0 1px 0 ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.50)'}`,
                  fontFamily: 'var(--font-display)',
                  fontWeight: 800,
                  fontSize: 13,
                  letterSpacing: '-0.04em',
                  color: 'var(--color-primary)',
                  textShadow: `0 0 12px ${rgba('--color-primary-rgb', 0.45)}`,
                }}
              >
                SF
              </div>
              <div className="flex items-baseline gap-[3px]">
                <span
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 700,
                    fontSize: 15,
                    letterSpacing: '-0.02em',
                    color: 'var(--color-on-surface)',
                  }}
                >
                  Solo
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 900,
                    fontSize: 15,
                    letterSpacing: '-0.02em',
                    color: 'var(--color-primary)',
                    textShadow: `0 0 14px ${rgba('--color-primary-rgb', 0.35)}`,
                  }}
                >
                  Forge
                </span>
                <span
                  className="ml-1 px-1.5 py-0.5 text-[8px] font-mono font-bold tracking-widest uppercase rounded"
                  style={{
                    color: rgba('--color-primary-rgb', 0.85),
                  background: rgba('--color-primary-rgb', 0.08),
                  border: `1px solid ${rgba('--color-primary-rgb', 0.25)}`,
                    letterSpacing: '0.12em',
                  }}
                >
                  IDE
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ─── 中: Editorial Glass 胶囊(主模型 + 混合开关 + 副模型) ────── */}
      <CentralControlPill
        leftPosition={leftPosition}
        isResizing={isResizingSidebar}
        hasOpenDropdown={anyDropdownOpen}
      >
        {/* 主模型下拉 */}
        <div className="flex items-center gap-2 shrink-0">
          <span
            className="select-none"
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.10em',
              textTransform: 'uppercase',
              color: rgba('--color-primary-rgb', 0.75),
            }}
          >
            主模型
          </span>
          <MainModelSelector
            mainModel={mainModel}
            onChange={setMainModel}
            availableModels={availableModels}
            onOpenChange={setHasMainModelOpen}
            draggable
          />
        </div>

        {/* 中线分隔 — Editorial: 1px hairline + 顶部/底部内 highlight 让它"看起来像玻璃缝" */}
        <div
          aria-hidden="true"
          style={{
            width: 1,
            height: 22,
            background:
              `linear-gradient(180deg, transparent 0%, ${rgba('--color-primary-rgb', 0.32)} 50%, transparent 100%)`,
          }}
        />

        {/* 混合任务开关 */}
        <div
          className="flex items-center gap-2.5 shrink-0"
          title={
            permissionMode !== 'normal'
              ? '多模型混合任务'
              : '多模型混合在「普通模式」下停用，其他模式均可开启'
          }
        >
          <span
            className="select-none"
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.10em',
              textTransform: 'uppercase',
              color: rgba('--color-primary-rgb', 0.75),
            }}
          >
            混合任务
          </span>
          <ToggleSwitch
            checked={mixedTasks}
            onChange={(v) => {
              if (permissionMode !== 'normal') setMixedTasks(v);
            }}
            disabled={permissionMode === 'normal'}
            label="多模型混合任务开关"
          />
        </div>

        {/* 副模型选择器(仅在混合任务开启时显示) */}
        {mixedTasks && (
          <>
            <div
              aria-hidden="true"
              style={{
                width: 1,
                height: 22,
                background:
                  `linear-gradient(180deg, transparent 0%, ${rgba('--color-primary-rgb', 0.32)} 50%, transparent 100%)`,
              }}
            />
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
          </>
        )}
      </CentralControlPill>

      {/* ─── 右: 用户 + 窗口控件(主题色对齐) ────────── */}
      <div className="flex items-center shrink-0" style={{ height: '100%', position: 'relative', zIndex: 40, isolation: 'isolate' }}>
        {/* 用户胶囊: 头像下拉 + 名字下拉(主题色轮廓 + 微弱自发光) */}
        <UserBadgeSelector />

        {/* 自定义窗口控件 — 不变, 已经在 Editorial 体系里 */}
        <WindowControls />
      </div>
    </header>
  );
}