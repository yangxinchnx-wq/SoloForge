import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  SecondaryModelSelector,
  MainModelSelector,
  CentralControlPill,
  ToggleSwitch,
  UserBadgeSelector,
} from './header-bar';
import { useThemedSurface } from './header-bar/themeColors';
import { SecondaryModel } from '../types';

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

  // ── Providers 持久化读取(主模型可用列表 + 副模型候选 + 图标映射) ──────────────
  // 主模型选择器只显示同时满足以下两关的模型:
  //   第一关: 模型级连通性测试通过 (probeResults[modelId] === true)
  //   第二关: 在设置中已选中启用 (m.enabled)
  // 两个条件缺一不可。通过测试但没选中 → 不显示 (没打算启用)。
  // 向后兼容: probeResults 为 undefined (尚未检测) → 不做模型级过滤
  // 同时构建 modelIconMap: modelId → { providerId, iconType } 用于主选择器图标对齐
  const getDynamicModels = (): string[] => {
    try {
      const saved = localStorage.getItem('cherry_providers_v2');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          const enabledList: string[] = [];
          parsed.forEach((prov: any) => {
            if (prov.enabled && prov.status === 'success' && prov.apiKey) {
              // 模型级连通性测试结果 (modelId → success)
              const probeResults: Record<string, boolean> | undefined = prov.probeResults;
              const hasProbeResults = probeResults !== undefined && probeResults !== null;

              // 第一关: 模型级测试通过 (无 probeResults 时向后兼容, 视为通过)
              const isModelTested = (modelId: string): boolean => {
                if (!hasProbeResults) return true;
                return probeResults![modelId] === true;
              };

              if (Array.isArray(prov.models)) {
                prov.models.forEach((m: any) => {
                  // 第一关 (测试通过) + 第二关 (已选中) 缺一不可
                  if (m.enabled && isModelTested(m.id)) enabledList.push(m.id);
                });
              }
              if (Array.isArray(prov.customModels)) {
                prov.customModels.forEach((cm: any) => {
                  const cmId = typeof cm === 'string' ? cm : (cm?.id ?? '');
                  if (!cmId) return;
                  const cmEnabled = typeof cm === 'string' ? true : cm.enabled !== false;
                  // 第一关 (测试通过) + 第二关 (已选中) 缺一不可
                  if (cmEnabled && isModelTested(cmId)) enabledList.push(cmId);
                });
              }
            }
          });
          return enabledList;
        }
      }
    } catch (e) {
      console.error('Error loading dynamic models for header', e);
    }
    return [];
  };

  // 构建 modelId → { providerId, iconType } 映射, 用于主选择器图标与设置页对齐
  const getModelIconMap = (): Record<string, { providerId: string; iconType?: string }> => {
    const map: Record<string, { providerId: string; iconType?: string }> = {};
    try {
      const saved = localStorage.getItem('cherry_providers_v2');
      if (!saved) return map;
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) return map;
      parsed.forEach((prov: any) => {
        if (!prov.enabled || !prov.apiKey) return;
        const info = { providerId: prov.id, iconType: prov.iconType };
        if (Array.isArray(prov.models)) {
          prov.models.forEach((m: any) => {
            if (m.enabled) map[m.id] = info;
          });
        }
        if (Array.isArray(prov.customModels)) {
          prov.customModels.forEach((cm: any) => {
            const id = typeof cm === 'string' ? cm : (cm?.id ?? '');
            if (id && (typeof cm === 'string' || cm.enabled !== false)) map[id] = info;
          });
        }
      });
    } catch { /* ignore */ }
    return map;
  };

  const getDynamicSecondarySubmodels = (): string[] => {
    try {
      const saved = localStorage.getItem('cherry_providers_v2');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          const allList: string[] = [];
          parsed.forEach((prov: any) => {
            if (prov.enabled && prov.apiKey) {
              if (Array.isArray(prov.models)) prov.models.forEach((m: any) => { if (m.enabled) allList.push(m.id); });
              if (Array.isArray(prov.customModels)) prov.customModels.forEach((cm: any) => {
                if (typeof cm === 'string') allList.push(cm);
                else if (cm && cm.id && cm.enabled !== false) allList.push(cm.id);
              });
            }
          });
          return allList;
        }
      }
    } catch (e) {
      console.error('Error loading secondary models list', e);
    }
    return [];
  };

  const [availableModels, setAvailableModels] = useState<string[]>(() => getDynamicModels());
  const [allAvailableModelsList, setAllAvailableModelsList] = useState<string[]>(() => getDynamicSecondarySubmodels());
  const [modelIconMap, setModelIconMap] = useState<Record<string, { providerId: string; iconType?: string }>>(() => getModelIconMap());

  useEffect(() => {
    const refreshLists = () => {
      const models = getDynamicModels();
      setAvailableModels(models);
      setAllAvailableModelsList(getDynamicSecondarySubmodels());
      setModelIconMap(getModelIconMap());
      // 自动选中第一个可用模型 (当 mainModel 为空或不在可用列表中时)
      if (models.length > 0 && !models.includes(mainModel)) {
        setMainModel(models[0]);
      }
    };
    refreshLists();
    window.addEventListener('storage', refreshLists);
    window.addEventListener('providers_updated', refreshLists);
    return () => {
      window.removeEventListener('storage', refreshLists);
      window.removeEventListener('providers_updated', refreshLists);
    };
  }, [mainModel, setMainModel]);

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

  // ── Logo: 闪电图标 (mask 渲染, 颜色跟随主题) ─────────────────────
  // 与画布待机闪电图标共用同一份 /lightning_logo.png, 用 mask 让颜色跟随主题

  // 2026-07-06 原生窗口拖动 (-webkit-app-region: drag)
  // CSS 在 .soloforge-drag-header 上设置 -webkit-app-region: drag
  // 交互元素 (button, [data-no-drag] 等) 通过 CSS no-drag 排除
  // 原生拖动由 OS 内核处理, 零 IPC, 零 JS, 零 React 重渲染 → 完美丝滑
  // 无需任何 JS mousedown/mouseup 监听

  return (
    <header
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
      {/* ─── 左: Logo + 品牌名(Editorial Glass · 闪电图标 + 字面) ───── */}
      <div className="flex items-center gap-3 shrink-0 z-10 min-w-0">
        <div className="flex items-center gap-2.5 select-none">
          {/* 圆角方框 + 内嵌闪电图标 (mask 渲染, 颜色跟随主题) */}
          <div
            className="flex items-center justify-center shrink-0"
            style={{
              width: 30,
              height: 30,
              borderRadius: 9,
              background: `linear-gradient(135deg, ${rgba('--color-primary-rgb', 0.20)} 0%, ${rgba('--color-primary-rgb', 0.06)} 100%)`,
              border: `1px solid ${rgba('--color-primary-rgb', 0.45)}`,
              boxShadow: `${isDark ? '0 2px 8px rgba(0,0,0,0.30)' : '0 2px 6px rgba(0,0,0,0.06)'}, inset 0 1px 0 ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.50)'}`,
            }}
          >
            <div
              style={{
                width: 22,
                height: 22,
                backgroundColor: 'var(--color-primary)',
                maskImage: 'url(/lightning_logo.png)',
                maskSize: 'contain',
                maskPosition: 'center',
                maskRepeat: 'no-repeat',
                WebkitMaskImage: 'url(/lightning_logo.png)',
                WebkitMaskSize: 'contain',
                WebkitMaskPosition: 'center',
                WebkitMaskRepeat: 'no-repeat',
                filter: `drop-shadow(0 0 8px ${rgba('--color-primary-rgb', 0.55)})`,
              }}
            />
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
          </div>
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
modelIconMap={modelIconMap}
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

        {/* 副模型选择器(仅在混合任务开启时显示) — 纯 CSS transition, 始终挂载避免卸载卡顿 */}
        <div
          className="sec-model-slide"
          data-open={mixedTasks ? 'true' : 'false'}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 0,
          }}
        >
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
        </div>
      </CentralControlPill>

      {/* ─── 右: 用户胶囊(主题色对齐) ────────── */}
      {/* titleBarStyle:'hidden' → 原生 caption buttons 在右上角, 右侧 padding 留出空间 */}
      <div className="flex items-center shrink-0" style={{ height: '100%', position: 'relative', zIndex: 40, isolation: 'isolate', paddingRight: '138px' }}>
        {/* 用户胶囊: 头像下拉 + 名字下拉(主题色轮廓 + 微弱自发光) */}
        <UserBadgeSelector />
      </div>
    </header>
  );
}