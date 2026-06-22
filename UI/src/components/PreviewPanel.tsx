import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  RefreshCw, Play, Square, Loader2,
  CircleDot, AlertCircle, Monitor, Smartphone, Tablet, Watch,
  Palette, MonitorSmartphone, Info, ChevronDown, Check, Maximize2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface PreviewPanelProps {
  width?: number;
  isResizing?: boolean;
  dragStartWidth?: number;
  selectedChatId?: string;
}

type CanvasState = 'idle' | 'starting' | 'running' | 'error';

declare global {
  interface Window {
    soloforge?: {
      platform: string;
      versions: { electron: string; chrome: string; node: string };
      canvas: {
        start: (sessionId: string, width: number, height: number) => Promise<{ ok: boolean; error?: string; session?: any; reused?: boolean }>;
        resize: (sessionId: string, width: number, height: number) => Promise<{ ok: boolean; error?: string }>;
        stop: (sessionId: string) => Promise<{ ok: boolean; notFound?: boolean }>;
        push: (sessionId: string, dsl: any) => Promise<{ ok: boolean; status?: number; body?: string; error?: string }>;
        status: (sessionId: string) => Promise<{ ok: boolean; active: boolean; info?: any }>;
        reportBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<{ ok: boolean; error?: string }>;
        hostInfo: () => Promise<{ ok: boolean; bounds: { x: number; y: number; width: number; height: number } }>;
      };
    };
  }
}

const isElectron = () => typeof window !== 'undefined' && !!window.soloforge;

// 预设底色 — 满足"干净"要求
const BG_PRESETS: { name: string; value: string; fg: string }[] = [
  { name: '纯白', value: '#FFFFFF', fg: '#1f2937' },
  { name: '纯黑', value: '#000000', fg: '#f3f4f6' },
  { name: '深夜', value: '#0B1020', fg: '#cbd5e1' },
  { name: '雪灰', value: '#F1F5F9', fg: '#1e293b' },
  { name: '护眼', value: '#E8F0E8', fg: '#2f4f4f' },
  { name: '暖灰', value: '#F4ECE0', fg: '#3a2e1f' },
];

// ── 画布尺寸预设（平铺，不分组） ──
type SizeGroup = 'desktop' | 'mobile' | 'tablet' | 'watch';

const SIZE_PRESETS: {
  key: string; group: SizeGroup; groupLabel: string; icon: React.ComponentType<any>;
  label: string; w: number; h: number;
}[] = [
  // 桌面
  { key: 'fill',     group: 'desktop', groupLabel: '桌面', icon: Maximize2, label: '填满当前宽度', w: 0, h: 0 },
  { key: '1920x1080', group: 'desktop', groupLabel: '桌面', icon: Monitor,   label: 'Full HD',      w: 1920, h: 1080 },
  { key: '1440x900',  group: 'desktop', groupLabel: '桌面', icon: Monitor,   label: 'MacBook',      w: 1440, h: 900 },
  { key: '1366x768',  group: 'desktop', groupLabel: '桌面', icon: Monitor,   label: '标准笔记本',   w: 1366, h: 768 },
  { key: '1280x720',  group: 'desktop', groupLabel: '桌面', icon: Monitor,   label: 'HD',           w: 1280, h: 720 },
  { key: '1024x768',  group: 'desktop', groupLabel: '桌面', icon: Monitor,   label: 'XGA',          w: 1024, h: 768 },
  { key: '2560x1440', group: 'desktop', groupLabel: '桌面', icon: Monitor,   label: '2K',           w: 2560, h: 1440 },
  // 手机
  { key: 'm-iphone14pro',   group: 'mobile', groupLabel: '手机', icon: Smartphone, label: 'iPhone 14 Pro',     w: 393, h: 852 },
  { key: 'm-iphone14',      group: 'mobile', groupLabel: '手机', icon: Smartphone, label: 'iPhone 14',         w: 390, h: 844 },
  { key: 'm-iphone14promax',group: 'mobile', groupLabel: '手机', icon: Smartphone, label: 'iPhone 14 Pro Max', w: 430, h: 932 },
  { key: 'm-iphonese',      group: 'mobile', groupLabel: '手机', icon: Smartphone, label: 'iPhone SE',         w: 375, h: 667 },
  { key: 'm-galaxys23',     group: 'mobile', groupLabel: '手机', icon: Smartphone, label: 'Galaxy S23',        w: 360, h: 780 },
  { key: 'm-pixel7',        group: 'mobile', groupLabel: '手机', icon: Smartphone, label: 'Pixel 7',           w: 412, h: 915 },
  { key: 'm-xiaomi13',      group: 'mobile', groupLabel: '手机', icon: Smartphone, label: 'Xiaomi 13',         w: 393, h: 873 },
  // 平板
  { key: 't-ipadpro129', group: 'tablet', groupLabel: '平板', icon: Tablet, label: 'iPad Pro 12.9"',  w: 1024, h: 1366 },
  { key: 't-ipadair',    group: 'tablet', groupLabel: '平板', icon: Tablet, label: 'iPad Air',       w: 820,  h: 1180 },
  { key: 't-ipadmini',   group: 'tablet', groupLabel: '平板', icon: Tablet, label: 'iPad Mini',      w: 768,  h: 1024 },
  { key: 't-surfacepro', group: 'tablet', groupLabel: '平板', icon: Tablet, label: 'Surface Pro',    w: 912,  h: 1368 },
  { key: 't-galaxytabs8',group: 'tablet', groupLabel: '平板', icon: Tablet, label: 'Galaxy Tab S8',  w: 800,  h: 1280 },
  // 手表
  { key: 'w-apple41',  group: 'watch', groupLabel: '手表', icon: Watch, label: 'Apple Watch 41mm',        w: 176, h: 176 },
  { key: 'w-apple45',  group: 'watch', groupLabel: '手表', icon: Watch, label: 'Apple Watch 45mm',        w: 198, h: 198 },
  { key: 'w-apple49',  group: 'watch', groupLabel: '手表', icon: Watch, label: 'Apple Watch Ultra 49mm',  w: 205, h: 251 },
  { key: 'w-galaxy6',  group: 'watch', groupLabel: '手表', icon: Watch, label: 'Galaxy Watch 6',          w: 240, h: 240 },
];

const DEFAULT_SIZE_KEY = 'fill';
function getSizePreset(key: string) {
  return SIZE_PRESETS.find(p => p.key === key);
}

export default function PreviewPanel({ width = 385, isResizing = false, dragStartWidth = 385, selectedChatId }: PreviewPanelProps) {
  const [canvasState, setCanvasState] = useState<CanvasState>('idle');
  const [canvasError, setCanvasError] = useState<string>('');
  const sessionIdRef = useRef<string>(`canvas-${selectedChatId || 'default'}`);
  const [canvasInfo, setCanvasInfo] = useState<{ port: number; pid: number } | null>(null);
  const [bgColor, setBgColor] = useState<string>(BG_PRESETS[0].value);
  const [customColor, setCustomColor] = useState<string>('#FFFFFF');
  const [activeSizeKey, setActiveSizeKey] = useState<string>(DEFAULT_SIZE_KEY);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showSizeMenu, setShowSizeMenu] = useState(false);
  const [showElectronHint, setShowElectronHint] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sizeMenuRef = useRef<HTMLDivElement | null>(null);

  const activePreset = getSizePreset(activeSizeKey) || SIZE_PRESETS[0];

  // 点外面关闭尺寸下拉
  useEffect(() => {
    if (!showSizeMenu) return;
    const close = (e: MouseEvent) => {
      if (sizeMenuRef.current && !sizeMenuRef.current.contains(e.target as Node)) {
        setShowSizeMenu(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [showSizeMenu]);

  useEffect(() => {
    sessionIdRef.current = `canvas-${selectedChatId || 'default'}`;
  }, [selectedChatId]);

  // 上报 PreviewPanel 区域的位置和尺寸给主进程
  useEffect(() => {
    if (!isElectron() || !containerRef.current) return;
    const report = () => {
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      window.soloforge!.canvas.reportBounds({
        x: Math.round(r.left), y: Math.round(r.top),
        width: Math.round(r.width), height: Math.round(r.height),
      }).catch(() => {});
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(containerRef.current);
    window.addEventListener('resize', report);
    window.addEventListener('scroll', report);
    return () => { ro.disconnect(); window.removeEventListener('resize', report); window.removeEventListener('scroll', report); };
  }, [width]);

  // 卸载时自动停掉画布
  useEffect(() => {
    return () => {
      if (isElectron() && canvasState === 'running') {
        window.soloforge!.canvas.stop(sessionIdRef.current).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 把根容器 backgroundColor 合并进最近一次 DSL 重新 push
  const pushBackground = useCallback(async (color: string) => {
    if (!isElectron() || canvasState !== 'running') return;
    const dsl = {
      ui: {
        type: 'container',
        props: { padding: 16, backgroundColor: color, layout: 'column', spacing: 8 },
        children: [
          { type: 'text', props: { content: '🎨 画布已就绪', fontSize: 18, fontWeight: 700, color: pickFg(color) } },
          { type: 'text', props: { content: `当前底色: ${color}`, fontSize: 12, color: pickFg(color), opacity: 0.75 } },
          { type: 'text', props: { content: `Session: ${sessionIdRef.current}`, fontSize: 11, color: pickFg(color), opacity: 0.6 } },
          { type: 'text', props: { content: `Port: ${canvasInfo?.port ?? '-'}  PID: ${canvasInfo?.pid ?? '-'}`, fontSize: 11, color: pickFg(color), opacity: 0.6 } },
          { type: 'divider', props: { color: pickFg(color), opacity: 0.2 } },
          { type: 'text', props: { content: '通过左侧聊天窗口生成 UI 描述，会自动推送到这里', fontSize: 12, color: pickFg(color), opacity: 0.55 } },
          { type: 'button', props: { label: '示例按钮', variant: 'filled', color: '#3b82f6' } },
          { type: 'progress', props: { value: 0.7, color: '#3b82f6' } },
        ],
      },
      platform: 'material',
    };
    await window.soloforge!.canvas.push(sessionIdRef.current, dsl).catch(() => {});
  }, [canvasState, canvasInfo]);

  // 计算画布实际宽高（w=0 表示填满 PreviewPanel 宽度）
  const computeFrame = useCallback((preset: typeof activePreset) => {
    if (preset.w > 0) return { w: preset.w, h: preset.h };
    return { w: Math.max(320, Math.floor(width - 32)), h: 640 };
  }, [width]);

  // 启动画布
  const startCanvas = useCallback(async () => {
    if (!isElectron()) {
      setCanvasError('需要 Electron 环境运行画布（请使用 npm run dev 启动 IDE）');
      setCanvasState('error');
      setShowElectronHint(true);
      return;
    }
    setCanvasState('starting');
    setCanvasError('');
    setShowElectronHint(false);
    try {
      const { w: frameW, h: frameH } = computeFrame(activePreset);
      const res = await window.soloforge!.canvas.start(sessionIdRef.current, frameW, frameH);
      if (!res.ok) {
        setCanvasError(res.error || '启动失败');
        setCanvasState('error');
        return;
      }
      setCanvasInfo({ port: res.session.port, pid: res.session.pid });
      setCanvasState('running');
      await pushBackground(bgColor);
    } catch (e: any) {
      setCanvasError(e?.message || String(e));
      setCanvasState('error');
    }
  }, [activePreset, bgColor, pushBackground, computeFrame]);

  const stopCanvas = useCallback(async () => {
    if (!isElectron()) return;
    await window.soloforge!.canvas.stop(sessionIdRef.current).catch(() => {});
    setCanvasState('idle');
    setCanvasInfo(null);
  }, []);

  // 切换尺寸预设：画布运行中时实时 resize，否则只更新 state
  const pickSize = useCallback((key: string) => {
    const preset = getSizePreset(key);
    if (!preset) return;
    setActiveSizeKey(key);
    setShowSizeMenu(false);
    if (isElectron() && canvasState === 'running') {
      const { w, h } = computeFrame(preset);
      window.soloforge!.canvas.resize(sessionIdRef.current, w, h).catch(() => {});
    }
  }, [canvasState, computeFrame]);

  const handlePickColor = (color: string) => {
    setBgColor(color);
    setShowColorPicker(false);
    if (canvasState === 'running') pushBackground(color);
  };

  const handlePickCustom = () => {
    setBgColor(customColor);
    setShowColorPicker(false);
    if (canvasState === 'running') pushBackground(customColor);
  };

  // 按 groupLabel 聚合
  const groupedSizes = SIZE_PRESETS.reduce<Record<string, typeof SIZE_PRESETS>>((acc, p) => {
    (acc[p.groupLabel] = acc[p.groupLabel] || []).push(p);
    return acc;
  }, {});

  // 画布状态指示器
  const renderCanvasStatus = () => {
    if (canvasState === 'running') {
      return (
        <span className="flex items-center gap-1.5 text-emerald-500">
          <CircleDot className="w-2.5 h-2.5 animate-pulse" />
          <span className="font-mono text-[10px]">CANVAS · :{canvasInfo?.port}</span>
        </span>
      );
    }
    if (canvasState === 'starting') {
      return (
        <span className="flex items-center gap-1.5 text-amber-500">
          <Loader2 className="w-2.5 h-2.5 animate-spin" />
          <span className="font-mono text-[10px]">启动中...</span>
        </span>
      );
    }
    if (canvasState === 'error') {
      return (
        <span className="flex items-center gap-1.5 text-red-500" title={canvasError}>
          <AlertCircle className="w-2.5 h-2.5" />
          <span className="font-mono text-[10px]">错误</span>
        </span>
      );
    }
    return (
      <span className="flex items-center gap-1.5 text-on-surface/40">
        <span className="w-1.5 h-1.5 rounded-full bg-on-surface/30" />
        <span className="font-mono text-[10px]">未启动</span>
      </span>
    );
  };

  // 占位渲染
  const renderPlaceholder = () => {
    if (canvasState === 'error' || (canvasState === 'idle' && !isElectron())) {
      return (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 select-none"
          style={{ background: bgColor, transition: 'background 200ms ease' }}
        >
          <div className="w-14 h-14 rounded-2xl border-2 border-dashed flex items-center justify-center mb-3"
               style={{ borderColor: pickFg(bgColor) + '40', color: pickFg(bgColor) + 'AA' }}>
            <MonitorSmartphone className="w-7 h-7" />
          </div>
          <div className="font-display font-bold text-sm mb-1" style={{ color: pickFg(bgColor) }}>
            画布区域
          </div>
          <div className="text-[11px] max-w-[260px] leading-relaxed mb-4" style={{ color: pickFg(bgColor) + 'AA' }}>
            {showElectronHint
              ? '当前不是 Electron 环境，画布无法启动。请用 npm run dev 启动 IDE 后再打开此面板。'
              : '点击"启动画布"开始实时预览；左下角切换底色。'}
          </div>
          <div className="text-[9px] font-mono uppercase tracking-widest" style={{ color: pickFg(bgColor) + '55' }}>
            {isElectron() ? `底色: ${bgColor}` : 'Requires Electron'}
          </div>
        </div>
      );
    }
    if (canvasState === 'starting') {
      return (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 select-none"
          style={{ background: bgColor, transition: 'background 200ms ease' }}
        >
          <Loader2 className="w-8 h-8 animate-spin mb-3" style={{ color: pickFg(bgColor) }} />
          <div className="text-[11px] font-mono" style={{ color: pickFg(bgColor) + 'AA' }}>
            正在启动画布进程…
          </div>
        </div>
      );
    }
    // running: 透明背景 — 真正画布由嵌入的 canvasHostWindow 渲染
    return (
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: 'transparent' }}
      />
    );
  };

  return (
    <div
      ref={containerRef}
      style={{
        width,
        transition: isResizing ? 'none' : 'width 250ms cubic-bezier(0.16, 1, 0.3, 1)'
      }}
      className="h-full bg-surface border-l border-outline/50 flex flex-col shrink-0 select-none z-10 overflow-hidden relative"
    >
      <div
        style={{
          width: isResizing ? `${dragStartWidth}px` : '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          overflow: 'hidden'
        }}
      >
        {/* TOP BAR */}
        <div className="p-2.5 px-3 border-b border-outline/40 flex items-center justify-between bg-surface shrink-0">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="font-display font-semibold text-[11px] text-on-surface tracking-wide">
              实时预览 · 画布
            </span>
          </div>
          {renderCanvasStatus()}
        </div>

        {/* TOOLBAR — 只保留启动/停止 + 底色 */}
        <div className="px-3 py-2 bg-surface-bright/35 border-b border-outline/30 flex items-center gap-1.5 shrink-0 flex-wrap">
          {canvasState !== 'running' ? (
            <button
              onClick={startCanvas}
              disabled={canvasState === 'starting'}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-500 text-[10px] font-mono font-semibold disabled:opacity-50 transition-colors"
            >
              {canvasState === 'starting' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              <span>{canvasState === 'starting' ? '启动中' : '启动画布'}</span>
            </button>
          ) : (
            <button
              onClick={stopCanvas}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-red-500/15 hover:bg-red-500/25 text-red-500 text-[10px] font-mono font-semibold transition-colors"
            >
              <Square className="w-3 h-3" />
              <span>停止</span>
            </button>
          )}

          {/* 底色选择器 */}
          <div className="relative">
            <button
              onClick={() => setShowColorPicker(s => !s)}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-surface-bright/60 hover:bg-surface-bright text-on-surface text-[10px] font-mono transition-colors"
              title="底色"
            >
              <Palette className="w-3 h-3" />
              <span
                className="inline-block w-3 h-3 rounded-sm border border-outline/60"
                style={{ background: bgColor }}
              />
              <span className="text-on-surface/70">{bgColor}</span>
            </button>
            <AnimatePresence>
              {showColorPicker && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  className="absolute top-full left-0 mt-1 z-50 bg-surface border border-outline rounded-lg shadow-2xl p-2 min-w-[200px]"
                >
                  <div className="grid grid-cols-3 gap-1.5 mb-2">
                    {BG_PRESETS.map(p => (
                      <button
                        key={p.value}
                        onClick={() => handlePickColor(p.value)}
                        className={`flex flex-col items-center gap-0.5 p-1.5 rounded border transition-all ${bgColor.toLowerCase() === p.value.toLowerCase() ? 'border-primary ring-1 ring-primary/40' : 'border-outline/50 hover:border-outline'}`}
                      >
                        <span className="w-9 h-6 rounded" style={{ background: p.value, border: '1px solid rgba(0,0,0,0.1)' }} />
                        <span className="text-[9px] text-on-surface/70 font-mono">{p.name}</span>
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5 pt-1.5 border-t border-outline/50">
                    <input
                      type="color"
                      value={customColor}
                      onChange={e => setCustomColor(e.target.value)}
                      className="w-7 h-7 rounded cursor-pointer bg-transparent border-0 p-0"
                    />
                    <input
                      type="text"
                      value={customColor}
                      onChange={e => setCustomColor(e.target.value)}
                      className="flex-1 px-1.5 py-1 text-[10px] font-mono bg-bg border border-outline rounded text-on-surface"
                    />
                    <button
                      onClick={handlePickCustom}
                      className="px-2 py-1 text-[10px] font-mono bg-primary/15 hover:bg-primary/25 text-primary rounded"
                    >
                      应用
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {canvasError && (
            <span className="flex-1 text-[10px] text-red-400 font-mono truncate min-w-0" title={canvasError}>
              {canvasError}
            </span>
          )}
        </div>

        {/* CANVAS AREA — 整个剩余空间都是画布区 */}
        <div className="flex-1 relative overflow-hidden">
          {renderPlaceholder()}

          {/* 内置尺寸选择器 — 画布右下角悬浮 */}
          {canvasState === 'running' && (
            <div ref={sizeMenuRef} className="absolute bottom-2 right-2 z-40">
              <button
                onClick={() => setShowSizeMenu(s => !s)}
                title="画布尺寸"
                className={`flex items-center gap-1.5 px-2 py-1 rounded-md backdrop-blur-md text-[10px] font-mono transition-colors border ${
                  showSizeMenu
                    ? 'bg-primary/80 border-primary text-white'
                    : 'bg-black/50 hover:bg-black/65 border-white/15 text-white'
                }`}
              >
                <Maximize2 className="w-3 h-3" />
                <span>
                  {activePreset.w === 0
                    ? `填满 · ${computeFrame(activePreset).w}×${computeFrame(activePreset).h}`
                    : `${activePreset.w} × ${activePreset.h}`}
                </span>
                <ChevronDown className={`w-3 h-3 transition-transform ${showSizeMenu ? 'rotate-180' : ''}`} />
              </button>

              <AnimatePresence>
                {showSizeMenu && (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 4 }}
                    className="absolute bottom-full right-0 mb-1.5 bg-surface border border-outline rounded-lg shadow-2xl min-w-[220px] max-h-[420px] overflow-y-auto"
                  >
                    {Object.entries(groupedSizes).map(([groupLabel, items]) => {
                      const firstIcon = items[0].icon;
                      const Icon = firstIcon;
                      return (
                        <div key={groupLabel} className="border-b border-outline/40 last:border-b-0">
                          <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-bright/30 sticky top-0">
                            <Icon className="w-3 h-3 text-on-surface/70" />
                            <span className="text-[10px] font-display font-semibold text-on-surface/80 uppercase tracking-wider">{groupLabel}</span>
                            <span className="text-[9px] text-on-surface/40 font-mono ml-auto">{items.length}</span>
                          </div>
                          {items.map(p => {
                            const isSel = p.key === activeSizeKey;
                            return (
                              <button
                                key={p.key}
                                onClick={() => pickSize(p.key)}
                                className={`w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-surface-bright/60 transition-colors text-left ${isSel ? 'bg-primary/10' : ''}`}
                              >
                                <span className="flex-1 min-w-0">
                                  <span className="block text-[10px] text-on-surface truncate">{p.label}</span>
                                  <span className="block text-[9px] text-on-surface/50 font-mono">
                                    {p.w === 0 ? '与面板等宽' : `${p.w} × ${p.h}`}
                                  </span>
                                </span>
                                {isSel && <Check className="w-3 h-3 text-primary shrink-0" />}
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// 根据背景色自动选前景色（深底浅字 / 浅底深字）
function pickFg(bg: string): string {
  const hex = bg.replace('#', '');
  if (hex.length !== 6) return '#1f2937';
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  // YIQ 亮度
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 140 ? '#1f2937' : '#f3f4f6';
}
