import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  RefreshCw, Play, Square, Loader2,
  CircleDot, AlertCircle, Monitor, Smartphone, Tablet, Watch,
  Palette, MonitorSmartphone, Info, ChevronDown, Check, Maximize2,
  Code2, Box
} from '../utils/icons';
import { MountTransition } from './MountTransition';
import { CanvasNotificationStack } from './CanvasNotificationBubble';
import { usePreviewStreamStore } from '../state/previewStreamStore';
import WebAstPreview from './WebAstPreview';
import {
  drainCanvasNotifications,
  type CanvasNotification,
} from '../services/canvas/sessionApi';

interface PreviewPanelProps {
  width?: number;
  isResizing?: boolean;
  dragStartWidth?: number;
  selectedChatId?: string;
  /** P0: 由 useChatClickCanvasBridge 解析出的画布 ID (canvas_1 ... canvas_10) */
  canvasId?: string | null;
  /** P0: 画布 ID 是否已就绪 (首次进入 chat 时, 后台拉取+建画布可能耗时) */
  canvasReady?: boolean;
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
        onExited: (callback: (info: CanvasExitedInfo) => void) => () => void;
      };
    };
  }
}

/** main.cjs child.on('exit') 推送的画布退出信息 */
interface CanvasExitedInfo {
  sessionId: string;
  exitCode: number | null;
  signal: string | null;
  isCrash: boolean;
  stderr: string;
  message: string;
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

export default function PreviewPanel({ width = 385, isResizing = false, dragStartWidth = 385, selectedChatId, canvasId, canvasReady }: PreviewPanelProps) {
  // 2026-07-06 阶段3: 订阅 AST 预览流状态
  const previewEntry = usePreviewStreamStore(s => selectedChatId ? s.entries[selectedChatId] : undefined);
  const previewIsStreaming = previewEntry?.isStreaming ?? false;
  const previewPayload = previewEntry?.payload ?? null;
  const previewAst = previewEntry?.ast;
  const previewSourceCode = previewEntry?.sourceCode ?? '';
  const previewLanguage = previewEntry?.language ?? '';
  const previewRawBytes = previewEntry?.rawBytes ?? 0;
  const previewPushError = previewEntry?.pushError ?? null;
  const [showSourceCode, setShowSourceCode] = useState(false);

  const [canvasState, setCanvasState] = useState<CanvasState>('idle');
  const [canvasError, setCanvasError] = useState<string>('');
  // P0: 优先使用 App.tsx 解析出的画布 ID (canvas_1 ... canvas_10)
  //   - 解析期间 fallback 到旧派生 ID 保证不会白屏
  //   - canvasReady 后再切到真实 ID (canvas.stop 老 + canvas.start 新)
  const fallbackId = `canvas-${selectedChatId || 'default'}`;
  const effectiveCanvasId = canvasId || fallbackId;
  // 待机状态已废弃: 始终显示工具栏 + 占位区, 用户可手动启动画布
  const noCanvas = false;
  const sessionIdRef = useRef<string>(effectiveCanvasId);
  const [canvasInfo, setCanvasInfo] = useState<{ port: number; pid: number } | null>(null);
  const [bgColor, setBgColor] = useState<string>(BG_PRESETS[0].value);
  const [customColor, setCustomColor] = useState<string>('#FFFFFF');
  const [activeSizeKey, setActiveSizeKey] = useState<string>(DEFAULT_SIZE_KEY);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [renderMode, setRenderMode] = useState<'2D' | '3D'>('2D');
  const [showElectronHint, setShowElectronHint] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const activePreset = getSizePreset(activeSizeKey) || SIZE_PRESETS[0];

  // 画布跟随应用默认启用 — Electron 环境下自动启动
  // 防重入: autoStartRef 防止同一生命周期内重复触发
  // 失败不重试: autoStartFailed 标记防止 error→idle 循环
  const autoStartRef = useRef(false);
  const autoStartFailedRef = useRef(false);
  useEffect(() => {
    if (autoStartRef.current || autoStartFailedRef.current) return;
    if (isElectron() && canvasState === 'idle' && selectedChatId && sessionIdRef.current) {
      autoStartRef.current = true;
      void startCanvas();
    }
  }, [canvasState, selectedChatId]);

  // ─────────────────────────────────────────
  // ★ 画布进程崩溃检测 (2026-07-08)
  //   - 监听 main.cjs 推送的 'canvas:exited' IPC 事件
  //   - 崩溃时: 更新 UI 状态 + 显示友好错误 + 允许重启
  //   - 正常退出 (用户点停止): 不显示错误, 仅同步状态
  // ─────────────────────────────────────────
  const canvasStateRef = useRef(canvasState);
  useEffect(() => { canvasStateRef.current = canvasState; }, [canvasState]);
  const isStoppingRef = useRef(false);

  useEffect(() => {
    if (!isElectron() || !window.soloforge?.canvas?.onExited) return;
    const unsubscribe = window.soloforge.canvas.onExited((info) => {
      // 只处理当前 session 的退出事件
      if (info.sessionId !== sessionIdRef.current) return;
      // 用户主动停止 → 不显示崩溃错误
      if (isStoppingRef.current) {
        isStoppingRef.current = false;
        return;
      }
      // 画布已不在 running 状态 → 无需处理 (避免重复设置)
      if (canvasStateRef.current !== 'running' && canvasStateRef.current !== 'starting') {
        return;
      }
      if (info.isCrash) {
        console.error('[canvas] 进程崩溃:', info);
        setCanvasState('error');
        setCanvasInfo(null);
        // 显示友好的崩溃信息 (而不是裸露的退出码如 100488)
        const stderrHint = info.stderr
          ? info.stderr.split('\n').filter(l => l.trim()).slice(-3).join(' | ')
          : '';
        setCanvasError(
          stderrHint
            ? `画布进程崩溃 (${info.message})\n${stderrHint}`
            : info.message
        );
        // 允许用户手动重启 (清除 autoStartFailed 标记)
        autoStartFailedRef.current = false;
        autoStartRef.current = false;
      } else {
        // 正常退出 → 回到 idle
        setCanvasState('idle');
        setCanvasInfo(null);
        setCanvasError('');
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    // P0: 仅在 canvasReady 后才切到真实画布 ID
    //   - ready=false 时保留 fallback (旧 canvas-${chatId})
    //   - ready=true 时切到 canvas_1 ... canvas_10
    if (canvasReady && canvasId) {
      sessionIdRef.current = canvasId;
    } else if (canvasReady && !canvasId) {
      // 无画布待机: 清空 sessionId, 画布不会启动
      sessionIdRef.current = '';
    } else {
      sessionIdRef.current = fallbackId;
    }
  }, [canvasId, canvasReady, fallbackId]);

  // ─────────────────────────────────────────
  // P0: 画布修改通知 (owner 轮询拉取 + 气泡队列)
  // ─────────────────────────────────────────
  //   - 每 3s 拉一次 GET /api/canvas/notifications?requester=<chatId>
  //   - 拿到的 push 到 queue, queue[0] 渲染气泡
  //   - 子组件 3s 后回调 onExpire → queue.shift
  //   - 当前 chat 没变 / 不在 owner chat 时停止轮询
  const [notifQueue, setNotifQueue] = useState<CanvasNotification[]>([]);
  useEffect(() => {
    if (!selectedChatId) {
      setNotifQueue([]);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const list = await drainCanvasNotifications(selectedChatId);
      if (cancelled || !list || list.length === 0) return;
      setNotifQueue((prev) => [...prev, ...list]);
    };
    // 立即拉一次, 然后每 3s
    void tick();
    const timer = window.setInterval(tick, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedChatId]);

  const handleNotifExpire = useCallback((id: string) => {
    setNotifQueue((prev) => prev.filter((n) => n.id !== id));
  }, []);

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

  // 2026-07-09: 自动推送 AST 预览到 Flutter 画布
  //   - previewPayload 确认后 → 推送完整 DSL (最终渲染)
  //   - previewAst 流式更新中 → 节流推送部分 AST (实时构建效果)
  const lastStreamPushRef = useRef(0);

  // 1) 完整 payload → 一次性推送最终结果
  useEffect(() => {
    if (!isElectron() || canvasState !== 'running') return;
    const root = previewPayload?.preview?.root;
    if (!root) return;
    const dsl = {
      ...root,
      platform: previewPayload?.framework || previewPayload?.language || 'material',
    };
    window.soloforge!.canvas.push(sessionIdRef.current, dsl).catch(() => {});
  }, [previewPayload, canvasState]);

  // 2) 流式 AST → 节流推送 (100ms), 让画布实时看到 UI 构建过程
  useEffect(() => {
    if (!isElectron() || canvasState !== 'running') return;
    if (!previewAst) return;
    // 如果已有确认的 payload, 不再推流式 AST (避免覆盖最终结果)
    if (previewPayload?.preview?.root) return;
    const now = Date.now();
    if (now - lastStreamPushRef.current < 100) return;
    lastStreamPushRef.current = now;
    window.soloforge!.canvas.push(sessionIdRef.current, previewAst).catch(() => {});
  }, [previewAst, canvasState, previewPayload]);

  // 计算画布实际宽高（w=0 表示填满 PreviewPanel 宽度）
  const computeFrame = useCallback((preset: typeof activePreset) => {
    if (preset.w > 0) return { w: preset.w, h: preset.h };
    return { w: Math.max(320, Math.floor(width - 32)), h: 640 };
  }, [width]);

  // 启动画布 — 带 30s 超时保护，防止 IPC 卡死导致 UI 永远停在 "启动中"
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
      // 30s 超时：主进程 findWindowByPid 循环 + embed 可能慢，但不能无限等
      const timeoutP = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('画布启动超时（30s），请检查 canvas_preview.exe 是否正常运行')), 30000)
      );
      const res = await Promise.race([
        window.soloforge!.canvas.start(sessionIdRef.current, frameW, frameH),
        timeoutP,
      ]);
      if (!res.ok) {
        setCanvasError(res.error || '启动失败');
        setCanvasState('error');
        autoStartFailedRef.current = true;
        return;
      }
      setCanvasInfo({ port: res.session.port, pid: res.session.pid });
      setCanvasState('running');
      await pushBackground(bgColor);
    } catch (e: any) {
      setCanvasError(e?.message || String(e));
      setCanvasState('error');
      autoStartFailedRef.current = true;
    }
  }, [activePreset, bgColor, pushBackground, computeFrame]);

  const stopCanvas = useCallback(async () => {
    if (!isElectron()) return;
    // 标记为用户主动停止 → 崩溃检测收到 exit 事件时不会误判为崩溃
    isStoppingRef.current = true;
    setCanvasState('idle');
    setCanvasInfo(null);
    setCanvasError('');
    await window.soloforge!.canvas.stop(sessionIdRef.current).catch(() => {});
  }, []);

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

  // 待机渲染 — 无画布时显示闪电 logo (色调跟随主题)
  const renderStandby = () => (
    <div className="absolute inset-0 flex flex-col items-center justify-center select-none">
      <div
        className="w-20 h-20 opacity-40 transition-opacity duration-300"
        style={{
          backgroundColor: 'var(--color-primary)',
          maskImage: 'url(/lightning_logo.png)',
          maskSize: 'contain',
          maskPosition: 'center',
          maskRepeat: 'no-repeat',
          WebkitMaskImage: 'url(/lightning_logo.png)',
          WebkitMaskSize: 'contain',
          WebkitMaskPosition: 'center',
          WebkitMaskRepeat: 'no-repeat',
        }}
      />
    </div>
  );

  // 占位渲染
  const renderPlaceholder = () => {
    // 2026-07-06 阶段3: 如果有 AST 预览流数据, 优先用 Web AST 预览
    if (previewAst || previewPayload) {
      const root = previewPayload?.preview?.root || previewAst;
      if (root) {
        return <WebAstPreview root={root} bgColor={bgColor} />;
      }
    }
    // 流式中 (还没有 AST 但正在生成)
    if (previewIsStreaming && !previewAst) {
      return (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 select-none"
          style={{ background: bgColor, transition: 'background 200ms ease' }}
        >
          <Loader2 className="w-8 h-8 animate-spin mb-3" style={{ color: pickFg(bgColor) }} />
          <div className="text-[11px] font-mono mb-1" style={{ color: pickFg(bgColor) + 'AA' }}>
            正在生成 AST 预览…
          </div>
          <div className="text-[9px] font-mono" style={{ color: pickFg(bgColor) + '66' }}>
            {previewLanguage} · {previewRawBytes} bytes
          </div>
          {previewPushError && (
            <div className="text-[9px] text-red-400 mt-2 max-w-[200px]">
              推送错误: {previewPushError}
            </div>
          )}
        </div>
      );
    }
    // 预览失败 — 有错误但没有生成 AST
    if (previewPushError && !previewAst && !previewPayload && !previewIsStreaming) {
      return (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 select-none"
          style={{ background: bgColor, transition: 'background 200ms ease' }}
        >
          <div className="w-14 h-14 rounded-2xl border-2 border-dashed flex items-center justify-center mb-3"
               style={{ borderColor: '#ef444440', color: '#ef4444AA' }}>
            <AlertCircle className="w-7 h-7" />
          </div>
          <div className="font-display font-bold text-sm mb-1" style={{ color: pickFg(bgColor) }}>
            AST 预览生成失败
          </div>
          <div className="text-[11px] max-w-[260px] leading-relaxed mb-3" style={{ color: pickFg(bgColor) + 'AA' }}>
            {previewPushError}
          </div>
          <div className="text-[9px] font-mono" style={{ color: pickFg(bgColor) + '66' }}>
            请检查后端 /api/llm/stream 是否可用 · {previewLanguage}
          </div>
        </div>
      );
    }
    if (canvasState === 'error' || canvasState === 'idle') {
      return (
        <div
          className="absolute inset-0 flex items-center justify-center select-none"
          style={{ background: bgColor, transition: 'background 200ms ease' }}
        >
          <div
            className="w-16 h-16 opacity-40 transition-opacity duration-300"
            style={{
              backgroundColor: 'var(--color-primary)',
              maskImage: 'url(/lightning_logo.png)',
              maskSize: 'contain',
              maskPosition: 'center',
              maskRepeat: 'no-repeat',
              WebkitMaskImage: 'url(/lightning_logo.png)',
              WebkitMaskSize: 'contain',
              WebkitMaskPosition: 'center',
              WebkitMaskRepeat: 'no-repeat',
            }}
          />
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
        // 拖动期间 width 直接跟随鼠标实时变化, 让用户看到边缘被拉伸而非整体平移
        width: `${width}px`,
        transition: isResizing ? 'none' : 'width 250ms cubic-bezier(0.16, 1, 0.3, 1)'
      }}
      className="h-full bg-surface border-l border-outline/50 flex flex-col shrink-0 select-none z-10 overflow-hidden relative"
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          overflow: 'hidden'
        }}
      >
        {/* TOP BAR — 无画布待机时隐藏 */}
        {!noCanvas && (
        <div className="p-2.5 px-3 border-b border-outline/40 flex items-center justify-between bg-surface shrink-0">
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${previewIsStreaming ? 'bg-blue-500 animate-pulse' : 'bg-emerald-500 animate-pulse'}`} />
            <span className="font-display font-semibold text-[11px] text-on-surface tracking-wide">
              {previewIsStreaming ? 'AST 流式生成中' : '实时预览 · 画布'}
            </span>
            {previewIsStreaming && (
              <span className="text-[9px] font-mono text-blue-500/70 ml-1">
                {previewLanguage} · {previewRawBytes}B
              </span>
            )}
            {previewPayload && !previewIsStreaming && (
              <span className="text-[9px] font-mono text-emerald-500/70 ml-1 flex items-center gap-0.5">
                <Code2 className="w-2.5 h-2.5" />
                {previewPayload.framework || previewPayload.language}
              </span>
            )}
          </div>
          {renderCanvasStatus()}
        </div>
        )}

        {/* TOOLBAR — 无画布待机时隐藏 */}
        {!noCanvas && (
        <div className="px-3 py-2 bg-surface-bright/35 border-b border-outline/30 flex items-center gap-1.5 shrink-0 flex-wrap">
          {canvasState !== 'running' ? (
            <button
              onClick={() => { autoStartFailedRef.current = false; void startCanvas(); }}
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
            <MountTransition show={showColorPicker} variant="fade" duration={140}>
              <div
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
              </div>
            </MountTransition>
          </div>

          {/* 2D / 3D 渲染模式切换 — 并排两个按钮 */}
          <div className="flex items-center rounded-md overflow-hidden border border-outline/30">
            <button
              onClick={() => setRenderMode('2D')}
              className={`flex items-center gap-1 px-2 py-1 text-[10px] font-mono font-semibold transition-colors ${
                renderMode === '2D'
                  ? 'bg-primary/15 text-primary'
                  : 'bg-surface-bright/60 text-on-surface/50 hover:text-on-surface'
              }`}
              title="2D 渲染模式"
            >
              <Square className="w-3 h-3" />
              <span>2D</span>
            </button>
            <button
              onClick={() => setRenderMode('3D')}
              className={`flex items-center gap-1 px-2 py-1 text-[10px] font-mono font-semibold transition-colors border-l border-outline/30 ${
                renderMode === '3D'
                  ? 'bg-primary/15 text-primary'
                  : 'bg-surface-bright/60 text-on-surface/50 hover:text-on-surface'
              }`}
              title="3D 渲染模式"
            >
              <Box className="w-3 h-3" />
              <span>3D</span>
            </button>
          </div>

          {canvasError && (
            <span
              className="flex-1 text-[10px] text-red-400 font-mono min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
              title={canvasError}
            >
              {canvasError}
            </span>
          )}
        </div>
        )}

        {/* CANVAS AREA — 整个剩余空间都是画布区 */}
        <div className="flex-1 relative overflow-hidden">
          {noCanvas ? renderStandby() : renderPlaceholder()}

          {/* 2026-07-06 阶段3: AST 源码查看 toggle — 左下角悬浮 */}
          {(previewSourceCode || previewPayload?.source_code) && (
            <div className="absolute bottom-2 left-2 z-40">
              <button
                onClick={() => setShowSourceCode(s => !s)}
                title="查看/隐藏源码"
                className={`flex items-center gap-1.5 px-2 py-1 rounded-md backdrop-blur-md text-[10px] font-mono transition-colors border ${
                  showSourceCode
                    ? 'bg-primary/80 border-primary text-white'
                    : 'bg-black/50 hover:bg-black/65 border-white/15 text-white'
                }`}
              >
                <Code2 className="w-3 h-3" />
                <span>源码</span>
              </button>
            </div>
          )}

          {/* 源码查看覆盖层 */}
          {showSourceCode && (previewSourceCode || previewPayload?.source_code) && (
            <div className="absolute inset-0 z-45 bg-bg/95 backdrop-blur-sm overflow-auto p-3">
              <div className="flex items-center justify-between mb-2 sticky top-0 bg-bg/90 backdrop-blur py-1">
                <span className="text-[10px] font-mono text-on-surface/60">
                  {previewLanguage} · {previewPayload?.framework || ''}
                </span>
                <button
                  onClick={() => setShowSourceCode(false)}
                  className="text-on-surface/50 hover:text-on-surface text-[10px] px-1.5 py-0.5 rounded hover:bg-surface-bright"
                >
                  ✕ 关闭
                </button>
              </div>
              <pre className="text-[10px] font-mono text-on-surface/80 whitespace-pre-wrap break-all leading-relaxed">
                {previewPayload?.source_code || previewSourceCode}
              </pre>
            </div>
          )}
        </div>
      </div>

      {/* P0: 画布修改通知气泡层 — 覆盖整个 PreviewPanel */}
      <CanvasNotificationStack notes={notifQueue} onExpire={handleNotifExpire} />
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
