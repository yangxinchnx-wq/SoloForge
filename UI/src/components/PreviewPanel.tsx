import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  RefreshCw, Wifi, Search, Play, Square, Loader2,
  CircleDot, AlertCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useTheme } from '../context/ThemeContext';

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
      };
    };
  }
}

const isElectron = () => typeof window !== 'undefined' && !!window.soloforge;

export default function PreviewPanel({ width = 385, isResizing = false, dragStartWidth = 385, selectedChatId }: PreviewPanelProps) {
  const { activeTheme } = useTheme();
  const [activeProjectTag, setActiveProjectTag] = useState<string>('VUE');
  const [device, setDevice] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [hmrState, setHmrState] = useState<'idle' | 'updating' | 'success'>('idle');
  const [blogTitle, setBlogTitle] = useState('MyBlog');
  const [activeTab, setActiveTab] = useState('home');
  const [selectedPost, setSelectedPost] = useState<any>(null);

  // 画布状态
  const [canvasState, setCanvasState] = useState<CanvasState>('idle');
  const [canvasError, setCanvasError] = useState<string>('');
  const sessionIdRef = useRef<string>(`canvas-${selectedChatId || 'default'}`);
  const [canvasInfo, setCanvasInfo] = useState<{ port: number; pid: number } | null>(null);

  // Load project type context from local storage
  const checkChatType = () => {
    try {
      const saved = localStorage.getItem('soloforge_chats_list');
      if (saved) {
        const chats = JSON.parse(saved);
        const currentChat = chats.find((c: any) => c.id === selectedChatId);
        if (currentChat) {
          const tag = currentChat.tag || 'NEW';
          setActiveProjectTag(tag);
          return;
        }
      }
      if (selectedChatId === '1') setActiveProjectTag('VUE');
      else if (selectedChatId === '2') setActiveProjectTag('AUTH');
      else if (selectedChatId === '3') setActiveProjectTag('AI');
      else setActiveProjectTag('NEW');
    } catch (e) {
      console.warn('Error fetching active chat tag context:', e);
    }
  };

  useEffect(() => {
    sessionIdRef.current = `canvas-${selectedChatId || 'default'}`;
    checkChatType();
  }, [selectedChatId]);

  useEffect(() => {
    window.addEventListener('soloforge-chats-updated', checkChatType);
    return () => {
      window.removeEventListener('soloforge-chats-updated', checkChatType);
    };
  }, [selectedChatId]);

  // 卸载时自动停掉画布
  useEffect(() => {
    return () => {
      if (isElectron() && canvasState === 'running') {
        window.soloforge!.canvas.stop(sessionIdRef.current).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const triggerHmr = useCallback(() => {
    if (hmrState === 'updating') return;
    setHmrState('updating');
    setTimeout(() => {
      setHmrState('success');
      setTimeout(() => setHmrState('idle'), 2000);
    }, 1500);
  }, [hmrState]);

  // 启动画布
  const startCanvas = useCallback(async () => {
    if (!isElectron()) {
      setCanvasError('画布需要 Electron 环境（请通过 npm run dev:electron 启动）');
      setCanvasState('error');
      return;
    }
    setCanvasState('starting');
    setCanvasError('');
    try {
      const w = Math.max(320, Math.floor(width - 20));
      const h = 600;
      const res = await window.soloforge!.canvas.start(sessionIdRef.current, w, h);
      if (!res.ok) {
        setCanvasError(res.error || '启动失败');
        setCanvasState('error');
        return;
      }
      setCanvasInfo({ port: res.session.port, pid: res.session.pid });
      setCanvasState('running');

      // 推一份初始 DSL（默认 Vue 博客模板）
      const initialDSL = {
        platform: 'material',
        root: {
          type: 'container',
          props: { padding: 16 },
          children: [
            { type: 'text', props: { text: '🎨 Flutter Canvas 已就绪', fontSize: 18, fontWeight: 700, color: '#3b82f6' } },
            { type: 'spacer', props: { height: 8 } },
            { type: 'text', props: { text: `Session: ${sessionIdRef.current}`, fontSize: 11, color: '#6b7280' } },
            { type: 'text', props: { text: `Port: ${res.session.port}  PID: ${res.session.pid}`, fontSize: 11, color: '#6b7280' } },
            { type: 'divider', props: {} },
            { type: 'text', props: { text: '点击 "推送 DSL" 把 UI 描述发送到画布', fontSize: 12, color: '#9ca3af' } },
            { type: 'progress', props: { value: 0.7, label: '示例进度条 70%' } },
          ],
        },
      };
      await window.soloforge!.canvas.push(sessionIdRef.current, initialDSL);
    } catch (e: any) {
      setCanvasError(e?.message || String(e));
      setCanvasState('error');
    }
  }, [width]);

  // 推送样例 DSL（演示用）
  const pushSampleDSL = useCallback(async () => {
    if (!isElectron() || canvasState !== 'running') return;
    const dsl = {
      platform: 'material',
      root: {
        type: 'container',
        props: { padding: 16, background: '#0f172a' },
        children: [
          { type: 'text', props: { text: '🚀 推送的 DSL 渲染', fontSize: 20, fontWeight: 800, color: '#22d3ee' } },
          { type: 'spacer', props: { height: 12 } },
          { type: 'text', props: { text: `时间戳: ${new Date().toLocaleTimeString()}`, fontSize: 12, color: '#94a3b8' } },
          { type: 'spacer', props: { height: 16 } },
          { type: 'button', props: { label: '点我（演示按钮）', primary: true, onClick: 'sample-click' } },
          { type: 'spacer', props: { height: 12 } },
          { type: 'input', props: { label: '示例输入框', placeholder: '在这里输入...' } },
          { type: 'spacer', props: { height: 12 } },
          { type: 'progress', props: { value: Math.random(), label: '随机进度' } },
          { type: 'spacer', props: { height: 12 } },
          { type: 'divider', props: {} },
          { type: 'text', props: { text: '平台: Material 3  •  来自 IDE IPC', fontSize: 10, color: '#64748b' } },
        ],
      },
    };
    await window.soloforge!.canvas.push(sessionIdRef.current, dsl);
  }, [canvasState]);

  const stopCanvas = useCallback(async () => {
    if (!isElectron()) return;
    await window.soloforge!.canvas.stop(sessionIdRef.current);
    setCanvasState('idle');
    setCanvasInfo(null);
  }, []);

  const getWidthClass = () => {
    if (device === 'mobile') return 'max-w-[280px] w-full';
    if (device === 'tablet') return 'max-w-[340px] w-full';
    return 'w-full';
  };

  const posts = [
    { id: 'vue3', title: '探索 Vue3 的组合式 API', category: '前端开发', date: '2024-05-20', reads: 1234, bg: 'from-emerald-500 to-teal-700', description: '深入理解 Vue3 组合式 API 的设计思想和使用方法, 探究 ref & reactive 响应式底层原理性能优势...', content: ['', ''] },
    { id: 'nodejs', title: 'Node.js 后端开发实践', category: '后端开发', date: '2024-05-18', reads: 856, bg: 'from-green-600 to-neutral-700', description: '使用 Node.js + Express 搭建 RESTful API, 结合中间件开发, 设计全链路异常拦截与安全沙箱防护。', content: ['', ''] }
  ];

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

  return (
    <div
      style={{
        width,
        transition: isResizing ? 'none' : 'width 250ms cubic-bezier(0.16, 1, 0.3, 1)'
      }}
      className="h-full bg-surface border-l border-outline/50 flex flex-col shrink-0 select-none z-10 overflow-hidden"
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
        {/* TOP BAR / VIEW TOGGLE */}
        <div className="p-2.5 px-3 border-b border-outline/40 flex items-center justify-between bg-surface shrink-0">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="font-display font-semibold text-[11px] text-on-surface tracking-wide">
              实时预览
            </span>
          </div>
          {renderCanvasStatus()}
        </div>

        {/* 画布控制条 */}
        <div className="px-3 py-2 bg-surface-bright/35 border-b border-outline/30 flex items-center gap-1.5 shrink-0">
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
            <>
              <button
                onClick={pushSampleDSL}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-blue-500/15 hover:bg-blue-500/25 text-blue-500 text-[10px] font-mono font-semibold transition-colors"
              >
                <RefreshCw className="w-3 h-3" />
                <span>推送 DSL</span>
              </button>
              <button
                onClick={stopCanvas}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-red-500/15 hover:bg-red-500/25 text-red-500 text-[10px] font-mono font-semibold transition-colors"
              >
                <Square className="w-3 h-3" />
                <span>停止</span>
              </button>
            </>
          )}
          {canvasError && (
            <span className="flex-1 text-[10px] text-red-400 font-mono truncate" title={canvasError}>
              {canvasError}
            </span>
          )}
        </div>

        {/* WEB VIEW MODE */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="p-1 px-3 bg-surface-bright/45 border-b border-outline/30 flex items-center gap-2 shrink-0">
            <button className="text-on-surface/30 hover:text-on-surface font-mono text-[11px]">&larr;</button>
            <button className="text-on-surface/30 hover:text-on-surface font-mono text-[11px]">&rarr;</button>
            <button onClick={triggerHmr} className="text-on-surface/30 hover:text-on-surface font-mono text-[11px] disabled:opacity-50" disabled={hmrState === 'updating'}>&#x21BB;</button>
            <div className="flex-1 bg-bg rounded px-2.5 py-0.5 border border-outline text-[10px] text-on-surface/50 font-mono overflow-hidden whitespace-nowrap select-all flex items-center gap-1.5">
              <Wifi className="w-2.5 h-2.5 text-green-500" />
              <span>http://localhost:5173</span>
            </div>
          </div>

          <div className="flex-1 bg-bg p-3.5 flex items-start justify-center overflow-auto relative scrollbar-thin">
            <div className={`${getWidthClass()} bg-[#111214] border border-[#222426]/80 rounded-xl overflow-hidden shadow-2xl flex flex-col min-h-[480px] max-h-[580px] transition-all duration-300`}>
              <div className="bg-[#17181c] border-b border-[#222426]/60 p-3 flex items-center justify-between px-4">
                <span
                  onClick={() => { setSelectedPost(null); setActiveTab('home'); }}
                  className="font-display font-black text-xs text-white tracking-tight cursor-pointer hover:opacity-80"
                >
                  {blogTitle}
                </span>
                <div className="flex items-center gap-3 text-[10px] font-medium text-on-surface/60">
                  <span
                    onClick={() => { setSelectedPost(null); setActiveTab('home'); }}
                    className={`cursor-pointer hover:text-white ${activeTab === 'home' && !selectedPost ? 'text-[#3b82f6]' : ''}`}
                  >
                    首页
                  </span>
                  <span className="cursor-pointer hover:text-white">文章</span>
                  <span className="cursor-pointer hover:text-white_80">分类</span>
                  <Search className="w-3 h-3 text-on-surface/40 hover:text-white cursor-pointer" />
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4 select-text scrollbar-thin">
                {!selectedPost ? (
                  <>
                    <div className="bg-gradient-to-r from-[#203a43] to-[#2c5364] text-white p-5 rounded-lg text-center relative overflow-hidden flex flex-col justify-center items-center py-6 shadow-md border border-[#222426]/40">
                      <div className="absolute top-0 right-0 bg-[#e5c158]/20 text-[#ffe08b] text-[8px] font-mono font-bold px-2 py-0.5 rounded-bl">New Post</div>
                      <h2 className="text-sm font-extrabold tracking-wide mb-1 flex items-center gap-1 justify-center">
                        记录生活，分享技术
                      </h2>
                      <p className="text-[10px] text-white/70 max-w-[210px] leading-tight mb-3 text-center">
                        这里是我的技术博客，分享前端、后端、数据库等技术文章
                      </p>
                    </div>

                    <div className="space-y-3.5">
                      <div className="flex items-center justify-between border-b border-[#2c2f33] pb-1">
                        <span className="text-[11px] font-bold text-white tracking-wide">最新文章</span>
                      </div>
                      <div className="space-y-3">
                        {posts.map((post) => (
                          <div
                            key={post.id}
                            onClick={() => setSelectedPost(post)}
                            className="bg-[#17191d] hover:bg-[#1a1c22] border border-[#222426]/60 hover:border-[#ffe08b]/20 p-3 rounded-lg flex gap-3 transition-all cursor-pointer group"
                          >
                            <div className={`w-12 h-12 rounded-md bg-gradient-to-tr ${post.bg} shrink-0 opacity-80 group-hover:opacity-100 flex items-center justify-center font-bold text-[10px] text-white font-mono`}>
                              {post.category}
                            </div>
                            <div className="flex-1 min-w-0 space-y-1">
                              <h3 className="text-xs font-bold text-white group-hover:text-primary transition-colors leading-snug truncate">
                                {post.title}
                              </h3>
                              <p className="text-[10px] text-on-surface/50 line-clamp-2 leading-normal">
                                {post.description}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <motion.div initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} className="space-y-3 p-1">
                    <button onClick={() => setSelectedPost(null)} className="text-[10px] text-primary/80 hover:text-primary font-mono flex items-center gap-1 mb-2 cursor-pointer">
                      &larr; 返回首页
                    </button>
                    <h2 className="text-sm font-extrabold text-white leading-snug">{selectedPost.title}</h2>
                  </motion.div>
                )}
              </div>
              <div className="bg-[#17181c] border-t border-[#222426]/60 p-2.5 text-center text-[9px] text-on-surface/30">
                &copy; 2026 SoloDev Technology Blogs
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
