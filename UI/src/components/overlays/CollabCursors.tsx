// ─────────────────────────────────────────────────────────────────
// 协同光标 — 模拟多用户实时协作
// - 5 个虚拟队友 (随机游走 + 偶尔聚焦到你的文件)
// - BroadcastChannel 跨窗口同步 (真实环境下可换 WebSocket)
// - 模拟打字/选择事件,带光标位置和用户颜色
// ─────────────────────────────────────────────────────────────────

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';

// ── 虚拟用户配置 ──
interface FakeUser {
  id: string;
  name: string;
  avatar: string;       // emoji
  color: string;        // 主色 (光标 + 标签)
  softColor: string;    // 浅色 (背景)
  role: string;
  personality: 'speedster' | 'thoughtful' | 'idle' | 'reviewer' | 'typer';
}

const FAKE_USERS: FakeUser[] = [
  { id: 'u_alice',  name: 'Alice林',  avatar: '🦊', color: '#ef4444', softColor: 'rgba(239,68,68,0.15)',  role: '前端架构师', personality: 'thoughtful' },
  { id: 'u_bob',    name: 'Bob陈',    avatar: '🐼', color: '#3b82f6', softColor: 'rgba(59,130,246,0.15)', role: '后端主力',   personality: 'speedster' },
  { id: 'u_carol',  name: 'Carol王',  avatar: '🦉', color: '#10b981', softColor: 'rgba(16,185,129,0.15)', role: '测试/QA',    personality: 'reviewer' },
  { id: 'u_david',  name: 'David李',  avatar: '🐯', color: '#f59e0b', softColor: 'rgba(245,158,11,0.15)', role: 'DevOps',     personality: 'idle' },
  { id: 'u_eve',    name: 'Eve周',    avatar: '🐰', color: '#a855f7', softColor: 'rgba(168,85,247,0.15)', role: '产品/设计',  personality: 'typer' },
];

// ── 协同事件类型 ──
export type CollabEventType =
  | 'cursor'    // 移动光标
  | 'select'    // 选中一段
  | 'edit'      // 输入文字
  | 'comment'   // 留下评论
  | 'view'      // 切到某文件
  | 'away';     // 离开

export interface CollabEvent {
  id: string;
  ts: number;
  userId: string;
  type: CollabEventType;
  file?: string;
  line?: number;
  col?: number;
  length?: number;
  text?: string;     // 模拟输入的字符
  message?: string;  // 评论内容
  done?: boolean;    // 编辑结束
}

export interface UserState {
  user: FakeUser;
  active: boolean;   // 在线
  lastSeen: number;  // ts
  currentFile: string | null;
  cursor: { line: number; col: number } | null;
  selection: { start: number; end: number; line: number } | null;
  typing: boolean;
  fps: number;       // 模拟移动的节奏 (越低越快)
}

const STORAGE_KEY = 'soloforge.collab.v1';
const CHANNEL_NAME = 'soloforge.collab';
const MAX_LINE = 80;
const MAX_COL = 90;

interface PersistedState {
  paused: boolean;
  speedMul: number; // 1=正常, 2=2倍速, 0.5=半速
  shareOwnCursor: boolean;
  customActivity: string; // 自由输入的"我现在在做什么"
}

function loadPersisted(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { paused: false, speedMul: 1, shareOwnCursor: true, customActivity: '', ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { paused: false, speedMul: 1, shareOwnCursor: true, customActivity: '' };
}

function savePersisted(s: PersistedState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

// ── 模拟生成器 ──
const SAMPLE_FILES = [
  'src/index.ts', 'src/App.tsx', 'src/hooks/useChat.ts',
  'src/components/overlays/TaskScheduler.tsx',
  'src/components/overlays/CodeReview.tsx',
  'src/api/terminal.ts', 'src/data/repositories/DecisionTraceRepository.ts',
  'migrations/v4_governor.surql', 'rust_core/src/scheduler.rs',
  'README.md', 'package.json',
];

const SAMPLE_COMMENTS = [
  '这段可以拆成更小的函数',
  '这里缺个错误处理',
  '注释有点过时了,要不要更新下?',
  '这个命名读起来很顺 👍',
  '建议加个 unit test',
  '考虑下边界情况:空数组',
  '重命名一下:`processRequest` 更好',
  '可以走 hook 复用',
  '⚠️ 这里的 SQL 有注入风险',
  '性能 OK 但还能再优化',
  '我刚改了一个相关 PR,看眼冲突',
  'rest 一下 ☕',
  '🎉 这个 feature 终于合并了',
  'LGTM',
  'oncall 收到',
];

const SAMPLE_TYPING = 'abcdefghijklmnopqrstuvwxyz(){};,. _-_=<>!'.split('');

class FakeUserSim {
  state: UserState;
  // 上次操作时间
  private lastActionAt = 0;
  // 当前打字进度
  private typingBuffer = '';
  private typingTarget = '';
  // 移动目标
  private moveTarget: { line: number; col: number } | null = null;

  constructor(user: FakeUser) {
    this.state = {
      user,
      active: Math.random() > 0.15,
      lastSeen: Date.now() - Math.floor(Math.random() * 60000),
      currentFile: SAMPLE_FILES[Math.floor(Math.random() * SAMPLE_FILES.length)],
      cursor: { line: 1, col: 1 },
      selection: null,
      typing: false,
      fps: 800 + Math.random() * 1500,
    };
  }

  /** 产生下一步事件 (返回 null 表示此 tick 无事发生) */
  tick(now: number, yourActivity: string): CollabEvent | null {
    if (!this.state.active) {
      // 偶发上线
      if (Math.random() < 0.01) {
        this.state.active = true;
        this.state.lastSeen = now;
        return { id: cuid(), ts: now, userId: this.state.user.id, type: 'view', file: SAMPLE_FILES[Math.floor(Math.random() * SAMPLE_FILES.length)] };
      }
      return null;
    }
    this.state.lastSeen = now;

    const dt = now - this.lastActionAt;
    if (dt < this.state.fps) return null;
    this.lastActionAt = now;
    // 重新计算 fps 让节奏起伏
    this.state.fps = 500 + Math.random() * 2000;

    const p = this.state.user.personality;
    const r = Math.random();

    // personality 决定行为分布
    if (p === 'idle' && r < 0.6) {
      // 大部分时间不动
      this.moveTarget = null;
      return null;
    }

    if (p === 'reviewer' && r < 0.18) {
      // 留评论
      return {
        id: cuid(), ts: now, userId: this.state.user.id, type: 'comment',
        file: this.state.currentFile || SAMPLE_FILES[0],
        line: this.state.cursor?.line,
        message: SAMPLE_COMMENTS[Math.floor(Math.random() * SAMPLE_COMMENTS.length)],
      };
    }

    if (p === 'typer' && r < 0.35) {
      // 模拟输入
      if (!this.state.typing) {
        this.typingTarget = Array.from({ length: 6 + Math.floor(Math.random() * 16) }, () =>
          SAMPLE_TYPING[Math.floor(Math.random() * SAMPLE_TYPING.length)]
        ).join('');
        this.typingBuffer = '';
        this.state.typing = true;
      }
      const ch = this.typingTarget[this.typingBuffer.length] || '';
      if (!ch) {
        this.state.typing = false;
        return { id: cuid(), ts: now, userId: this.state.user.id, type: 'edit', file: this.state.currentFile || '', text: this.typingBuffer, done: true };
      }
      this.typingBuffer += ch;
      if (this.state.cursor) this.state.cursor.col += 1;
      return { id: cuid(), ts: now, userId: this.state.user.id, type: 'edit', file: this.state.currentFile || '', text: ch, done: false };
    }

    if (p === 'thoughtful' && r < 0.25) {
      // 切文件
      const newFile = SAMPLE_FILES[Math.floor(Math.random() * SAMPLE_FILES.length)];
      this.state.currentFile = newFile;
      this.state.cursor = { line: 1, col: 1 };
      this.state.selection = null;
      return { id: cuid(), ts: now, userId: this.state.user.id, type: 'view', file: newFile };
    }

    if (p === 'speedster' && r < 0.4) {
      // 快速移动
      if (!this.moveTarget) {
        this.moveTarget = { line: 1 + Math.floor(Math.random() * MAX_LINE), col: 1 + Math.floor(Math.random() * MAX_COL) };
      }
      const cur = this.state.cursor || { line: 1, col: 1 };
      const dl = Math.sign(this.moveTarget.line - cur.line);
      const dc = Math.sign(this.moveTarget.col - cur.col);
      cur.line = Math.max(1, Math.min(MAX_LINE, cur.line + dl));
      cur.col = Math.max(1, Math.min(MAX_COL, cur.col + dc));
      this.state.cursor = cur;
      if (cur.line === this.moveTarget.line && cur.col === this.moveTarget.col) {
        this.moveTarget = null;
      }
      return { id: cuid(), ts: now, userId: this.state.user.id, type: 'cursor', file: this.state.currentFile || '', line: cur.line, col: cur.col };
    }

    // 默认: cursor 微移
    const cur = this.state.cursor || { line: 1, col: 1 };
    cur.col = Math.max(1, Math.min(MAX_COL, cur.col + (Math.random() < 0.5 ? 1 : -1) * Math.floor(Math.random() * 3)));
    if (Math.random() < 0.1) cur.line = Math.max(1, Math.min(MAX_LINE, cur.line + (Math.random() < 0.5 ? 1 : -1)));
    this.state.cursor = cur;
    return { id: cuid(), ts: now, userId: this.state.user.id, type: 'cursor', file: this.state.currentFile || '', line: cur.line, col: cur.col };
  }
}

function cuid() {
  return 'ev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

// ── 共享画布 (主区可视) ──
interface Canvas {
  width: number;
  height: number;
}

// ─── 主组件 ───
interface Props {
  open: boolean;
  onClose: () => void;
  activeFile?: string;
  onShareActivity?: (text: string) => void;
}

export function CollabCursors({ open, onClose, activeFile = 'src/App.tsx', onShareActivity }: Props) {
  const [persisted, setPersisted] = useState<PersistedState>(loadPersisted);
  const [userStates, setUserStates] = useState<Record<string, UserState>>(() => {
    const m: Record<string, UserState> = {};
    FAKE_USERS.forEach(u => { m[u.id] = new FakeUserSim(u).state; });
    return m;
  });
  const [events, setEvents] = useState<CollabEvent[]>([]);
  const [filter, setFilter] = useState<'all' | CollabEventType>('all');
  const [showAvatars, setShowAvatars] = useState(true);
  const [canvas, setCanvas] = useState<Canvas>({ width: 800, height: 480 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const simsRef = useRef<FakeUserSim[]>(FAKE_USERS.map(u => new FakeUserSim(u)));
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => { savePersisted(persisted); }, [persisted]);

  // 监听 canvas 尺寸
  useEffect(() => {
    if (!open) return;
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setCanvas({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  // 主循环: 250ms 一帧
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => {
      if (persisted.paused) return;
      const now = Date.now();
      const newEvents: CollabEvent[] = [];
      simsRef.current.forEach(sim => {
        // speedMul 影响 sim 的 tick 频率 (粗略:通过调节 fps)
        const ev = sim.tick(now, persisted.customActivity);
        if (ev) newEvents.push(ev);
      });
      if (newEvents.length > 0) {
        setUserStates(prev => {
          const next = { ...prev };
          simsRef.current.forEach(s => { next[s.state.user.id] = { ...s.state }; });
          return next;
        });
        setEvents(prev => [...newEvents, ...prev].slice(0, 200));
      }
    }, 250 / persisted.speedMul);
    return () => clearInterval(t);
  }, [open, persisted.paused, persisted.speedMul]);

  // 跨窗口同步
  useEffect(() => {
    if (!open) return;
    const ch = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = ch;
    ch.onmessage = (e) => {
      const msg = e.data as { type: string; payload?: any };
      if (msg.type === 'collab:broadcast' && msg.payload) {
        // 收到来自其他窗口的"我在干啥"
        setEvents(prev => [{ id: cuid(), ts: Date.now(), userId: 'you', type: 'comment' as const, message: msg.payload, file: activeFile }, ...prev].slice(0, 200));
      }
    };
    return () => { ch.close(); channelRef.current = null; };
  }, [open, activeFile]);

  const handleShare = useCallback(() => {
    if (!persisted.customActivity.trim()) return;
    if (channelRef.current) {
      channelRef.current.postMessage({ type: 'collab:broadcast', payload: persisted.customActivity });
    }
    setEvents(prev => [{ id: cuid(), ts: Date.now(), userId: 'you', type: 'comment' as const, file: activeFile, message: persisted.customActivity }, ...prev].slice(0, 200));
    onShareActivity?.(persisted.customActivity);
    setPersisted(p => ({ ...p, customActivity: '' }));
  }, [persisted.customActivity, activeFile, onShareActivity]);

  const kickAll = useCallback(() => {
    simsRef.current.forEach(s => { s.state.active = true; s.state.lastSeen = Date.now(); });
    setUserStates(prev => {
      const next = { ...prev };
      simsRef.current.forEach(s => { next[s.state.user.id] = { ...s.state }; });
      return next;
    });
  }, []);

  const kickOne = useCallback((id: string) => {
    const s = simsRef.current.find(x => x.state.user.id === id);
    if (!s) return;
    s.state.active = !s.state.active;
    setUserStates(prev => ({ ...prev, [id]: { ...s.state } }));
  }, []);

  const onlineCount = useMemo(() => Object.values(userStates).filter(s => s.active).length, [userStates]);

  const filteredEvents = useMemo(() => {
    if (filter === 'all') return events;
    return events.filter(e => e.type === filter);
  }, [events, filter]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[min(96vw,1100px)] h-[min(92vh,780px)] bg-bg-elevated border border-border rounded-xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center px-5 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">group</span>
            <h2 className="text-base font-semibold">协同光标</h2>
            <span className="text-xs text-text-secondary ml-2">模拟实时协作 · {onlineCount}/{FAKE_USERS.length} 在线</span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => setPersisted(p => ({ ...p, paused: !p.paused }))}
              className="px-2.5 py-1 text-xs rounded border border-border hover:bg-bg-dim flex items-center gap-1"
              title={persisted.paused ? '继续' : '暂停'}
            >
              <span className="material-symbols-outlined text-sm">{persisted.paused ? 'play_arrow' : 'pause'}</span>
              {persisted.paused ? '继续' : '暂停'}
            </button>
            <select
              value={persisted.speedMul}
              onChange={e => setPersisted(p => ({ ...p, speedMul: parseFloat(e.target.value) }))}
              className="px-2 py-1 text-xs rounded border border-border bg-bg"
            >
              <option value="0.5">0.5×</option>
              <option value="1">1×</option>
              <option value="2">2×</option>
              <option value="4">4×</option>
            </select>
            <button onClick={kickAll} className="px-2.5 py-1 text-xs rounded border border-border hover:bg-bg-dim flex items-center gap-1" title="所有人上线">
              <span className="material-symbols-outlined text-sm">bolt</span>
              全员唤醒
            </button>
            <button
              onClick={() => setShowAvatars(v => !v)}
              className="px-2.5 py-1 text-xs rounded border border-border hover:bg-bg-dim flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-sm">face</span>
              {showAvatars ? '隐藏头像' : '显示头像'}
            </button>
            <button onClick={onClose} className="px-2 py-1 rounded hover:bg-bg-dim text-text-secondary ml-1">
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          </div>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* 左侧: 在线列表 */}
          <div className="w-56 border-r border-border flex flex-col shrink-0">
            <div className="px-3 py-2 text-xs text-text-secondary uppercase tracking-wide border-b border-border">在线成员</div>
            <div className="flex-1 overflow-auto">
              {FAKE_USERS.map(u => {
                const st = userStates[u.id];
                return (
                  <div key={u.id} className="px-3 py-2 hover:bg-bg-dim flex items-center gap-2 group">
                    <div className="relative">
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center text-base"
                        style={{ backgroundColor: u.softColor }}
                      >
                        {u.avatar}
                      </div>
                      <div
                        className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-bg-elevated"
                        style={{ backgroundColor: st.active ? '#22c55e' : '#6b7280' }}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate" style={{ color: st.active ? u.color : undefined }}>{u.name}</div>
                      <div className="text-xs text-text-secondary truncate">{u.role} · {st.active ? st.currentFile?.split('/').pop() : '离线'}</div>
                    </div>
                    <button
                      onClick={() => kickOne(u.id)}
                      className="opacity-0 group-hover:opacity-100 text-text-secondary hover:text-text p-0.5"
                      title={st.active ? '踢下线' : '拉回来'}
                    >
                      <span className="material-symbols-outlined text-sm">{st.active ? 'logout' : 'login'}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 中间: 模拟编辑器画布 (光标可视化) */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="px-3 py-2 border-b border-border text-xs text-text-secondary flex items-center gap-2">
              <span className="material-symbols-outlined text-sm">code</span>
              <span>实时编辑视图 · {activeFile}</span>
              <span className="ml-auto">5 个光标移动中</span>
            </div>
            <div ref={canvasRef} className="flex-1 relative overflow-hidden bg-bg-dim/30 font-mono text-xs">
              {/* 模拟代码行 */}
              <div className="absolute inset-0 p-4 leading-5 select-none pointer-events-none">
                {Array.from({ length: Math.floor(canvas.height / 20) }, (_, i) => (
                  <div key={i} className="flex">
                    <div className="w-10 text-right pr-3 text-text-secondary/40">{i + 1}</div>
                    <div className="flex-1 text-text-secondary/30">
                      {Array.from({ length: Math.floor((canvas.width - 60) / 7) }, () => '·').join('')}
                    </div>
                  </div>
                ))}
              </div>
              {/* 光标层 */}
              {showAvatars && FAKE_USERS.map(u => {
                const st = userStates[u.id];
                if (!st.active || !st.cursor) return null;
                const x = 50 + (st.cursor.col - 1) * 7;
                const y = 16 + (st.cursor.line - 1) * 20;
                if (x > canvas.width - 80 || y > canvas.height - 40) return null;
                return (
                  <div key={u.id} className="absolute pointer-events-none" style={{ left: x, top: y }}>
                    {/* 光标竖线 */}
                    <div className="w-0.5 h-4" style={{ backgroundColor: u.color }} />
                    {/* 标签 */}
                    <div
                      className="absolute -top-5 left-0 px-1.5 py-0.5 rounded text-[10px] text-white whitespace-nowrap flex items-center gap-1"
                      style={{ backgroundColor: u.color }}
                    >
                      <span>{u.avatar}</span>
                      <span>{u.name}</span>
                    </div>
                  </div>
                );
              })}
              {persisted.paused && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="px-3 py-1.5 rounded bg-bg-elevated/80 border border-border text-xs text-text-secondary flex items-center gap-1">
                    <span className="material-symbols-outlined text-sm">pause</span>
                    协同已暂停
                  </div>
                </div>
              )}
            </div>

            {/* 分享自己的活动 */}
            <div className="border-t border-border p-3 flex gap-2">
              <input
                type="text"
                value={persisted.customActivity}
                onChange={e => setPersisted(p => ({ ...p, customActivity: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') handleShare(); }}
                placeholder="广播一条消息给队友 (Enter 发送)"
                className="flex-1 px-3 py-1.5 rounded border border-border bg-bg text-sm"
              />
              <button
                onClick={handleShare}
                disabled={!persisted.customActivity.trim()}
                className="px-3 py-1.5 rounded bg-primary text-bg text-sm disabled:opacity-50 flex items-center gap-1"
              >
                <span className="material-symbols-outlined text-sm">send</span>
                发送
              </button>
            </div>
          </div>

          {/* 右侧: 活动流 */}
          <div className="w-72 border-l border-border flex flex-col shrink-0">
            <div className="px-3 py-2 border-b border-border text-xs text-text-secondary flex items-center gap-2">
              <span className="material-symbols-outlined text-sm">timeline</span>
              <span>活动流 ({events.length})</span>
            </div>
            <div className="px-2 py-1.5 border-b border-border flex gap-1 overflow-auto">
              {(['all', 'cursor', 'edit', 'view', 'comment'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={'px-2 py-0.5 rounded text-xs shrink-0 ' + (filter === f ? 'bg-primary/20 text-primary' : 'hover:bg-bg-dim text-text-secondary')}
                >
                  {f === 'all' ? '全部' : f === 'cursor' ? '光标' : f === 'edit' ? '编辑' : f === 'view' ? '切文件' : '评论'}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-auto">
              {filteredEvents.length === 0 && (
                <div className="px-4 py-8 text-center text-xs text-text-secondary">暂无活动</div>
              )}
              {filteredEvents.map(ev => {
                const u = ev.userId === 'you' ? null : FAKE_USERS.find(x => x.id === ev.userId);
                const color = u?.color || '#94a3b8';
                const name = u?.name || '你';
                const avatar = u?.avatar || '🙋';
                const ago = Math.max(0, Math.floor((Date.now() - ev.ts) / 1000));
                return (
                  <div key={ev.id} className="px-3 py-1.5 border-b border-border/50 flex items-start gap-2 text-xs">
                    <div className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-sm"
                      style={{ backgroundColor: u?.softColor || 'rgba(148,163,184,0.15)' }}
                    >{avatar}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-1.5">
                        <span className="font-medium" style={{ color }}>{name}</span>
                        <span className="text-text-secondary">
                          {ev.type === 'cursor' && `移动到 ${ev.file?.split('/').pop()}:${ev.line}:${ev.col}`}
                          {ev.type === 'edit' && (ev.done ? `完成编辑 (${ev.text?.length} 字符)` : `输入 "${ev.text}"`)}
                          {ev.type === 'view' && `打开 ${ev.file?.split('/').pop()}`}
                          {ev.type === 'comment' && ev.message}
                        </span>
                      </div>
                      <div className="text-text-secondary/70 text-[10px] mt-0.5">{ago < 60 ? `${ago}秒前` : `${Math.floor(ago / 60)}分钟前`}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* 底部状态条 */}
        <div className="px-4 py-2 border-t border-border text-xs text-text-secondary flex items-center gap-3 shrink-0">
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
            实时同步
          </span>
          <span>·</span>
          <span>当前 {events.length} 条事件</span>
          <span>·</span>
          <span className="text-text-secondary/70">支持 Ctrl+Shift+G 快捷键</span>
        </div>
      </div>
    </div>
  );
}
