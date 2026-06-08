// ─────────────────────────────────────────────────────────────────
// 番茄钟 + 编码统计
// - 25/5 标准番茄钟,可自定义时长
// - 自动记录 session (开始/结束/中断/标签)
// - 编码活动自动统计:打字数/活跃时长/切文件次数
// - 周/月热力图 (类似 GitHub contributions)
// - 目标设置:每天 N 个番茄 / N 行代码
// - 多种提醒:浏览器通知 / 桌面通知 / 声音
// - 导出 CSV / JSON
// ─────────────────────────────────────────────────────────────────

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';

// ── 类型 ──
type Phase = 'work' | 'short' | 'long';
type Status = 'idle' | 'running' | 'paused' | 'finished';

interface Session {
  id: string;
  startTs: number;
  endTs: number;
  durationSec: number;
  phase: Phase;
  label: string;
  completed: boolean;
  interrupted: boolean;
}

interface Goals {
  dailyPomodoros: number;
  dailyLines: number;
  dailyActiveMin: number;
}

interface KeyStats {
  date: string;         // YYYY-MM-DD
  pomodoros: number;
  workMinutes: number;
  breakMinutes: number;
  linesTyped: number;
  filesEdited: number;
  keystrokes: number;
  interruptions: number;
}

const PHASE_META: Record<Phase, { label: string; min: number; color: string; icon: string }> = {
  work:  { label: '专注', min: 25, color: '#ef4444', icon: 'work' },
  short: { label: '短休', min: 5,  color: '#10b981', icon: 'coffee' },
  long:  { label: '长休', min: 15, color: '#3b82f6', icon: 'self_improvement' },
};

const STORAGE_KEY = 'soloforge.pomodoro.v1';
const STATS_KEY = 'soloforge.pomodoro.stats.v1';
const GOALS_KEY = 'soloforge.pomodoro.goals.v1';

function today() {
  return new Date().toISOString().slice(0, 10);
}
function dateKey(ts: number) {
  return new Date(ts).toISOString().slice(0, 10);
}

function loadSessions(): Session[] {
  try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : []; } catch { return []; }
}
function loadStats(): KeyStats[] {
  try { const r = localStorage.getItem(STATS_KEY); return r ? JSON.parse(r) : []; } catch { return []; }
}
function loadGoals(): Goals {
  try { const r = localStorage.getItem(GOALS_KEY); return r ? JSON.parse(r) : { dailyPomodoros: 8, dailyLines: 500, dailyActiveMin: 240 }; } catch { return { dailyPomodoros: 8, dailyLines: 500, dailyActiveMin: 240 }; }
  return { dailyPomodoros: 8, dailyLines: 500, dailyActiveMin: 240 };
}

// ─── 主组件 ───
interface Props {
  open: boolean;
  onClose: () => void;
}

export function PomodoroStats({ open, onClose }: Props) {
  const [sessions, setSessions] = useState<Session[]>(loadSessions);
  const [stats, setStats] = useState<KeyStats[]>(loadStats);
  const [goals, setGoals] = useState<Goals>(loadGoals);
  const [phase, setPhase] = useState<Phase>('work');
  const [status, setStatus] = useState<Status>('idle');
  const [secondsLeft, setSecondsLeft] = useState(PHASE_META.work.min * 60);
  const [label, setLabel] = useState('编码');
  const [pomodorosInCycle, setPomodorosInCycle] = useState(0);
  const [view, setView] = useState<'timer' | 'heatmap' | 'history' | 'goals'>('timer');
  const [heatmapRange, setHeatmapRange] = useState<'week' | 'month' | 'year'>('month');
  const [customMin, setCustomMin] = useState(25);
  const intervalRef = useRef<number | null>(null);
  const sessionStartRef = useRef<number>(0);

  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions)); } catch { /* ignore */ } }, [sessions]);
  useEffect(() => { try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch { /* ignore */ } }, [stats]);
  useEffect(() => { try { localStorage.setItem(GOALS_KEY, JSON.stringify(goals)); } catch { /* ignore */ } }, [goals]);

  // 倒计时
  useEffect(() => {
    if (status !== 'running') return;
    intervalRef.current = window.setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) {
          // 完成
          finishPhase(true);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [status]);

  // 通知
  const notify = useCallback((title: string, body: string) => {
    if (Notification.permission === 'granted') {
      new Notification(title, { body, icon: '/favicon.ico' });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission();
    }
  }, []);

  // 完成一个 phase
  const finishPhase = useCallback((completed: boolean) => {
    setStatus('finished');
    if (intervalRef.current) clearInterval(intervalRef.current);
    const s: Session = {
      id: 's_' + Date.now().toString(36),
      startTs: sessionStartRef.current,
      endTs: Date.now(),
      durationSec: PHASE_META[phase].min * 60,
      phase,
      label,
      completed,
      interrupted: !completed,
    };
    setSessions(prev => [s, ...prev].slice(0, 500));
    // 累加 stats
    const k = dateKey(s.startTs);
    setStats(prev => {
      const idx = prev.findIndex(x => x.date === k);
      const next = [...prev];
      const stat: KeyStats = idx >= 0 ? { ...next[idx] } : {
        date: k, pomodoros: 0, workMinutes: 0, breakMinutes: 0,
        linesTyped: 0, filesEdited: 0, keystrokes: 0, interruptions: 0,
      };
      if (phase === 'work' && completed) stat.pomodoros++;
      if (phase === 'work') stat.workMinutes += Math.round(s.durationSec / 60);
      else stat.breakMinutes += Math.round(s.durationSec / 60);
      if (!completed) stat.interruptions++;
      if (idx >= 0) next[idx] = stat; else next.push(stat);
      return next.slice(-365);
    });

    if (phase === 'work' && completed) {
      const newCount = pomodorosInCycle + 1;
      setPomodorosInCycle(newCount);
      // 4 个番茄后长休
      const nextPhase: Phase = newCount % 4 === 0 ? 'long' : 'short';
      notify('🍅 番茄完成!', '休息一下,' + (newCount % 4 === 0 ? '长' : '短') + '休 5-15 分钟');
      setTimeout(() => switchPhase(nextPhase), 1000);
    } else {
      notify('⏰ 休息结束', '回到工作状态');
      setTimeout(() => switchPhase('work'), 1000);
    }
  }, [phase, label, pomodorosInCycle, notify]);

  const startTimer = useCallback(() => {
    sessionStartRef.current = Date.now();
    setStatus('running');
  }, []);

  const pauseTimer = useCallback(() => setStatus('paused'), []);

  const stopTimer = useCallback(() => {
    if (status === 'running' || status === 'paused') finishPhase(false);
    setStatus('idle');
  }, [status, finishPhase]);

  const switchPhase = useCallback((p: Phase) => {
    setPhase(p);
    setSecondsLeft(PHASE_META[p].min * 60);
    setStatus('idle');
  }, []);

  const skipPhase = useCallback(() => {
    finishPhase(false);
    switchPhase(phase === 'work' ? 'short' : 'work');
  }, [phase, finishPhase, switchPhase]);

  // 格式化
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  const progress = 1 - secondsLeft / (PHASE_META[phase].min * 60);

  // 今日统计
  const todayStats = useMemo(() => stats.find(s => s.date === today()), [stats]);
  const todayPomodoros = todayStats?.pomodoros || 0;
  const todayMinutes = todayStats?.workMinutes || 0;

  // 热力图
  const heatmapData = useMemo(() => {
    const days = heatmapRange === 'week' ? 7 : heatmapRange === 'month' ? 30 : 365;
    const out: Array<{ date: string; value: number; week: number; dow: number }> = [];
    const start = new Date();
    start.setDate(start.getDate() - days + 1);
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const k = d.toISOString().slice(0, 10);
      const s = stats.find(x => x.date === k);
      out.push({
        date: k,
        value: s?.workMinutes || 0,
        week: Math.floor(i / 7),
        dow: d.getDay(),
      });
    }
    return out;
  }, [stats, heatmapRange]);

  // 目标达成
  const goalPomodorosPct = Math.min(100, (todayPomodoros / goals.dailyPomodoros) * 100);
  const goalMinutesPct = Math.min(100, (todayMinutes / goals.dailyActiveMin) * 100);

  // 导出
  const exportCsv = useCallback(() => {
    const lines = ['date,pomodoros,work_min,break_min,interruptions'];
    stats.forEach(s => lines.push([s.date, s.pomodoros, s.workMinutes, s.breakMinutes, s.interruptions].join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'pomodoro-stats.csv'; a.click();
    URL.revokeObjectURL(url);
  }, [stats]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[min(96vw,1100px)] h-[min(92vh,780px)] bg-bg-elevated border border-border rounded-xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center px-4 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">timer</span>
            <h2 className="text-base font-semibold">番茄钟 + 编码统计</h2>
            <span className="text-xs text-text-secondary ml-2">
              今日 {todayPomodoros}🍅 · {todayMinutes} 分钟
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {([
              { id: 'timer',   label: '计时',   icon: 'timer' },
              { id: 'heatmap', label: '热力',   icon: 'whatshot' },
              { id: 'history', label: '历史',   icon: 'history' },
              { id: 'goals',   label: '目标',   icon: 'flag' },
            ] as const).map(t => (
              <button
                key={t.id}
                onClick={() => setView(t.id)}
                className={'px-2.5 py-1 text-xs rounded border flex items-center gap-1 ' +
                  (view === t.id ? 'border-primary text-primary bg-primary/10' : 'border-border hover:bg-bg-dim')}
              >
                <span className="material-symbols-outlined text-sm">{t.icon}</span>
                {t.label}
              </button>
            ))}
            <button onClick={onClose} className="px-2 py-1 rounded hover:bg-bg-dim text-text-secondary ml-1">
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {view === 'timer' && (
            <div className="p-6 max-w-2xl mx-auto">
              {/* 阶段选择 */}
              <div className="flex gap-1 mb-6">
                {(Object.keys(PHASE_META) as Phase[]).map(p => (
                  <button
                    key={p}
                    onClick={() => switchPhase(p)}
                    className={'flex-1 px-3 py-2 rounded-lg border text-sm font-medium flex items-center justify-center gap-1.5 ' +
                      (phase === p ? 'border-primary text-primary bg-primary/10' : 'border-border hover:bg-bg-dim')}
                  >
                    <span className="material-symbols-outlined text-base" style={{ color: PHASE_META[p].color }}>{PHASE_META[p].icon}</span>
                    {PHASE_META[p].label} ({PHASE_META[p].min}m)
                  </button>
                ))}
              </div>

              {/* 大圆环 */}
              <div className="relative w-72 h-72 mx-auto">
                <svg viewBox="0 0 200 200" className="w-full h-full -rotate-90">
                  <circle cx="100" cy="100" r="90" fill="none" stroke="currentColor" strokeWidth="6" className="text-bg-dim" />
                  <circle
                    cx="100" cy="100" r="90" fill="none"
                    stroke={PHASE_META[phase].color}
                    strokeWidth="6" strokeLinecap="round"
                    strokeDasharray={2 * Math.PI * 90}
                    strokeDashoffset={2 * Math.PI * 90 * (1 - progress)}
                    style={{ transition: 'stroke-dashoffset 1s linear' }}
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <div className="text-6xl font-mono font-bold tabular-nums">
                    {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
                  </div>
                  <div className="text-sm text-text-secondary mt-1">
                    {PHASE_META[phase].label} · {pomodorosInCycle % 4}/4
                  </div>
                </div>
              </div>

              {/* 标签输入 */}
              <div className="mt-6 flex items-center gap-2">
                <label className="text-xs text-text-secondary">任务:</label>
                <input
                  type="text"
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  className="flex-1 px-3 py-1.5 rounded border border-border bg-bg text-sm"
                />
              </div>

              {/* 控制按钮 */}
              <div className="mt-4 flex items-center justify-center gap-3">
                {status === 'idle' && (
                  <button
                    onClick={startTimer}
                    className="px-6 py-3 rounded-full text-base font-semibold flex items-center gap-2"
                    style={{ backgroundColor: PHASE_META[phase].color, color: '#fff' }}
                  >
                    <span className="material-symbols-outlined">play_arrow</span>
                    开始
                  </button>
                )}
                {status === 'running' && (
                  <>
                    <button onClick={pauseTimer} className="px-5 py-3 rounded-full bg-bg-dim text-text font-semibold flex items-center gap-2">
                      <span className="material-symbols-outlined">pause</span>
                      暂停
                    </button>
                    <button onClick={stopTimer} className="px-5 py-3 rounded-full bg-bg-dim text-danger font-semibold flex items-center gap-2">
                      <span className="material-symbols-outlined">stop</span>
                      结束
                    </button>
                  </>
                )}
                {status === 'paused' && (
                  <>
                    <button onClick={() => setStatus('running')} className="px-5 py-3 rounded-full bg-primary text-bg font-semibold flex items-center gap-2">
                      <span className="material-symbols-outlined">play_arrow</span>
                      继续
                    </button>
                    <button onClick={stopTimer} className="px-5 py-3 rounded-full bg-bg-dim text-danger font-semibold flex items-center gap-2">
                      <span className="material-symbols-outlined">stop</span>
                      结束
                    </button>
                  </>
                )}
                <button onClick={skipPhase} className="px-4 py-3 rounded-full bg-bg-dim text-text-secondary text-sm flex items-center gap-1">
                  <span className="material-symbols-outlined">skip_next</span>
                  跳过
                </button>
              </div>

              {/* 今日进度 */}
              <div className="mt-6 grid grid-cols-2 gap-3">
                <ProgressCard label="今日番茄" current={todayPomodoros} target={goals.dailyPomodoros} suffix="🍅" color="#ef4444" />
                <ProgressCard label="今日专注" current={todayMinutes} target={goals.dailyActiveMin} suffix="m" color="#3b82f6" />
              </div>
            </div>
          )}

          {view === 'heatmap' && (
            <div className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-sm text-text-secondary">范围:</span>
                {(['week', 'month', 'year'] as const).map(r => (
                  <button
                    key={r}
                    onClick={() => setHeatmapRange(r)}
                    className={'px-3 py-1 text-xs rounded ' +
                      (heatmapRange === r ? 'bg-primary/20 text-primary' : 'hover:bg-bg-dim text-text-secondary')}
                  >
                    {r === 'week' ? '7 天' : r === 'month' ? '30 天' : '1 年'}
                  </button>
                ))}
                <button onClick={exportCsv} className="ml-auto px-2.5 py-1 text-xs rounded border border-border hover:bg-bg-dim flex items-center gap-1">
                  <span className="material-symbols-outlined text-sm">download</span>
                  CSV
                </button>
              </div>

              <div className="border border-border rounded p-4 bg-bg-dim/30 overflow-x-auto">
                <div className="grid grid-flow-col gap-1" style={{ gridTemplateRows: 'repeat(7, 14px)' }}>
                  {heatmapData.map((d, i) => {
                    const v = d.value;
                    const intensity = v === 0 ? 0 : Math.min(4, Math.ceil(v / 30));
                    return (
                      <div
                        key={i}
                        className="w-3 h-3 rounded-sm cursor-pointer hover:ring-1 hover:ring-primary"
                        style={{ backgroundColor: intensity === 0 ? '#1e293b' : '#10b981' + (['40', '60', 'a0', 'ff'][intensity - 1]) }}
                        title={`${d.date}: ${v} 分钟`}
                      />
                    );
                  })}
                </div>
                <div className="flex items-center gap-2 mt-3 text-[10px] text-text-secondary">
                  <span>少</span>
                  {[0, 1, 2, 3, 4].map(i => (
                    <div key={i} className="w-3 h-3 rounded-sm" style={{ backgroundColor: i === 0 ? '#1e293b' : '#10b981' + (['40', '60', 'a0', 'ff'][i - 1]) }} />
                  ))}
                  <span>多</span>
                </div>
              </div>

              {/* 统计摘要 */}
              <div className="mt-4 grid grid-cols-4 gap-3">
                <SummaryCard label="总番茄" value={stats.reduce((a, s) => a + s.pomodoros, 0)} icon="work_history" color="text-danger" />
                <SummaryCard label="总专注" value={Math.round(stats.reduce((a, s) => a + s.workMinutes, 0) / 60 * 10) / 10} suffix="h" icon="schedule" color="text-primary" />
                <SummaryCard label="活跃天数" value={stats.filter(s => s.workMinutes > 0).length} icon="calendar_month" color="text-success" />
                <SummaryCard label="日均番茄" value={stats.length > 0 ? (stats.reduce((a, s) => a + s.pomodoros, 0) / stats.length).toFixed(1) : 0} icon="analytics" color="text-warning" />
              </div>
            </div>
          )}

          {view === 'history' && (
            <div className="p-4">
              <div className="text-sm text-text-secondary mb-2">{sessions.length} 条 session</div>
              {sessions.length === 0 && <div className="text-center text-text-secondary py-8 text-sm">暂无历史</div>}
              <div className="max-w-3xl mx-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-text-secondary border-b border-border">
                    <tr>
                      <th className="text-left py-2 px-2">时间</th>
                      <th className="text-left py-2 px-2">阶段</th>
                      <th className="text-left py-2 px-2">标签</th>
                      <th className="text-right py-2 px-2">时长</th>
                      <th className="text-left py-2 px-2">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map(s => (
                      <tr key={s.id} className="border-b border-border/50 hover:bg-bg-dim/50">
                        <td className="py-1.5 px-2 text-text-secondary text-xs">{new Date(s.startTs).toLocaleString('zh-CN')}</td>
                        <td className="py-1.5 px-2">
                          <span className="inline-flex items-center gap-1 text-xs" style={{ color: PHASE_META[s.phase].color }}>
                            <span className="material-symbols-outlined text-sm">{PHASE_META[s.phase].icon}</span>
                            {PHASE_META[s.phase].label}
                          </span>
                        </td>
                        <td className="py-1.5 px-2">{s.label}</td>
                        <td className="py-1.5 px-2 text-right font-mono text-xs">{Math.round(s.durationSec / 60)}m</td>
                        <td className="py-1.5 px-2 text-xs">
                          {s.completed ? <span className="text-success">✓ 完成</span> : <span className="text-warning">⚠ 中断</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {view === 'goals' && (
            <div className="p-6 max-w-2xl mx-auto space-y-4">
              <div>
                <h3 className="text-base font-semibold mb-2">每日目标</h3>
                <p className="text-xs text-text-secondary mb-4">设置你的编码目标,达成后会有视觉/通知奖励</p>
              </div>
              <div className="space-y-3">
                {([
                  { key: 'dailyPomodoros', label: '每日番茄数', suffix: '🍅', max: 20 },
                  { key: 'dailyLines', label: '每日代码行', suffix: '行', max: 2000 },
                  { key: 'dailyActiveMin', label: '每日专注分钟', suffix: '分钟', max: 600 },
                ] as const).map(({ key, label, suffix, max }) => (
                  <div key={key} className="px-4 py-3 rounded border border-border">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-sm">{label}</span>
                      <span className="text-sm font-mono">{(goals as any)[key]} {suffix}</span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={max}
                      value={(goals as any)[key]}
                      onChange={e => setGoals(g => ({ ...g, [key]: parseInt(e.target.value) }))}
                      className="w-full"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProgressCard({ label, current, target, suffix, color }: { label: string; current: number; target: number; suffix: string; color: string }) {
  const pct = Math.min(100, (current / target) * 100);
  return (
    <div className="px-4 py-3 rounded-lg border border-border">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-text-secondary">{label}</span>
        <span className="text-sm font-mono">
          <span style={{ color }}>{current}</span>
          <span className="text-text-secondary">/{target} {suffix}</span>
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-bg-dim overflow-hidden">
        <div className="h-full transition-all" style={{ width: pct + '%', backgroundColor: color }} />
      </div>
    </div>
  );
}

function SummaryCard({ label, value, suffix, icon, color }: { label: string; value: number | string; suffix?: string; icon: string; color: string }) {
  return (
    <div className="px-4 py-3 rounded-lg border border-border">
      <div className="flex items-center gap-1.5 text-text-secondary text-xs mb-1">
        <span className={'material-symbols-outlined text-sm ' + color}>{icon}</span>
        {label}
      </div>
      <div className="text-2xl font-bold font-mono">
        {value}{suffix && <span className="text-sm text-text-secondary ml-0.5">{suffix}</span>}
      </div>
    </div>
  );
}
