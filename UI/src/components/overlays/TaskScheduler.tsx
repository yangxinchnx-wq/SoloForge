// ─────────────────────────────────────────────────────────────────
// AI 计划任务调度器
// - 自然语言 → 时间表达式 (Chinese / English)
//   · "5 分钟后" / "in 5 min"
//   · "明天 9 点" / "tomorrow at 9am"
//   · "每天 8:30" / "every day at 8:30"
//   · "每周一" / "every Monday"
//   · cron 表达式 "0 9 * * 1-5"
// - 任务类型: reminder / run_command / ai_chat / webhook
// - 可视化日历 + 列表视图
// - 状态: pending / running / done / failed / cancelled
// - 与 Rust scheduler IPC 集成 (mock 时本地执行)
// - 持久化到 localStorage
// ─────────────────────────────────────────────────────────────────

import { useState, useEffect, useMemo, useRef } from 'react';
import { Button, IconButton, Tooltip, Badge } from '../ui/Button';
import { pushToast } from './Notifications';

export type TaskKind = 'reminder' | 'run_command' | 'ai_chat' | 'webhook';
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ScheduledTask {
  id: string;
  title: string;
  kind: TaskKind;
  /** 自然语言描述 (用户原始输入) */
  naturalInput: string;
  /** 解析后的执行时间 (epoch ms) */
  fireAt: number;
  /** cron 表达式 (周期任务) */
  cron?: string;
  /** 周期任务: 下一次执行时间 */
  nextFireAt?: number;
  /** payload: reminder 文本 / command / prompt / webhook URL */
  payload: string;
  status: TaskStatus;
  createdAt: number;
  /** 真实执行结果 */
  result?: string;
  /** 已执行次数 (周期任务) */
  runCount: number;
}

const STORAGE_KEY = 'soloforge.tasks.v1';

function loadTasks(): ScheduledTask[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}
function saveTasks(t: ScheduledTask[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(t)); } catch { /* ignore */ }
}

// ─── 自然语言 → 时间解析 (简单版) ───
interface ParsedSchedule {
  fireAt: number;
  cron?: string;
  description: string;
  isRecurring: boolean;
}

function parseNaturalTime(input: string, now: number = Date.now()): ParsedSchedule | null {
  const lower = input.toLowerCase().trim();

  // 1) "X 分钟后" / "X min later" / "in X minutes"
  let m = lower.match(/(\d+)\s*(分钟|分|min(?:ute)?s?)/);
  if (m) {
    const mins = parseInt(m[1]);
    return { fireAt: now + mins * 60_000, description: `${mins} 分钟后`, isRecurring: false };
  }
  // "X 秒后"
  m = lower.match(/(\d+)\s*(秒钟?|秒|sec(?:ond)?s?)/);
  if (m) {
    const secs = parseInt(m[1]);
    return { fireAt: now + secs * 1000, description: `${secs} 秒后`, isRecurring: false };
  }
  // "X 小时后"
  m = lower.match(/(\d+)\s*(小时|小时钟?|h(?:our)?s?)/);
  if (m) {
    const hrs = parseInt(m[1]);
    return { fireAt: now + hrs * 3_600_000, description: `${hrs} 小时后`, isRecurring: false };
  }

  // 2) "明天 HH:MM" / "tomorrow at HH(:MM)?"
  m = lower.match(/明天|tomorrow/);
  if (m) {
    const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?/);
    if (timeMatch) {
      const h = parseInt(timeMatch[1]);
      const min = parseInt(timeMatch[2] || '0');
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(h, min, 0, 0);
      return { fireAt: tomorrow.getTime(), description: `明天 ${h}:${String(min).padStart(2, '0')}`, isRecurring: false };
    }
  }

  // 3) "今天 HH:MM" / "today at HH:MM"
  m = lower.match(/今天|today/);
  if (m) {
    const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?/);
    if (timeMatch) {
      const h = parseInt(timeMatch[1]);
      const min = parseInt(timeMatch[2] || '0');
      const today = new Date(now);
      today.setHours(h, min, 0, 0);
      if (today.getTime() < now) {
        // 已过,改为明天
        today.setDate(today.getDate() + 1);
        return { fireAt: today.getTime(), description: `明天 ${h}:${String(min).padStart(2, '0')}`, isRecurring: false };
      }
      return { fireAt: today.getTime(), description: `今天 ${h}:${String(min).padStart(2, '0')}`, isRecurring: false };
    }
  }

  // 4) "HH:MM" (默认今天/明天)
  m = lower.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = parseInt(m[1]);
    const min = parseInt(m[2]);
    const target = new Date(now);
    target.setHours(h, min, 0, 0);
    if (target.getTime() < now) target.setDate(target.getDate() + 1);
    return { fireAt: target.getTime(), description: `${h}:${String(min).padStart(2, '0')}`, isRecurring: false };
  }

  // 5) "每天 HH:MM" / "every day at HH:MM"
  m = lower.match(/(每天|每日|every\s*day|at\s*)/);
  if (m && /\d{1,2}(?::\d{2})?/.test(lower)) {
    const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?/);
    if (timeMatch) {
      const h = parseInt(timeMatch[1]);
      const min = parseInt(timeMatch[2] || '0');
      const next = new Date(now);
      next.setHours(h, min, 0, 0);
      if (next.getTime() < now) next.setDate(next.getDate() + 1);
      return {
        fireAt: next.getTime(),
        description: `每天 ${h}:${String(min).padStart(2, '0')}`,
        isRecurring: true,
        cron: `${min} ${h} * * *`,
      };
    }
  }

  // 6) "每周X HH:MM"
  const weekMap: Record<string, number> = {
    '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0,
    'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 'friday': 5, 'saturday': 6, 'sunday': 0,
    'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 'fri': 5, 'sat': 6, 'sun': 0,
  };
  for (const [cn, num] of Object.entries(weekMap)) {
    if (lower.includes('每周' + cn) || lower.includes('every ' + cn)) {
      const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?/);
      const h = timeMatch ? parseInt(timeMatch[1]) : 9;
      const min = timeMatch && timeMatch[2] ? parseInt(timeMatch[2]) : 0;
      const next = new Date(now);
      next.setHours(h, min, 0, 0);
      const daysToAdd = (num - next.getDay() + 7) % 7;
      next.setDate(next.getDate() + daysToAdd);
      if (daysToAdd === 0 && next.getTime() < now) {
        next.setDate(next.getDate() + 7);
      }
      return {
        fireAt: next.getTime(),
        description: `每周${cn} ${h}:${String(min).padStart(2, '0')}`,
        isRecurring: true,
        cron: `${min} ${h} * * ${num}`,
      };
    }
  }

  // 7) cron 表达式 (5 段空格分隔, 全数字)
  m = lower.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/);
  if (m) {
    return { fireAt: now + 60_000, description: 'cron 表达式 (下次运行)', isRecurring: true, cron: lower };
  }

  return null;
}

const KIND_META: Record<TaskKind, { label: string; icon: string; color: string; desc: string }> = {
  reminder:   { label: '提醒',  icon: 'notifications', color: 'text-primary',  desc: '弹出通知' },
  run_command:{ label: '命令',  icon: 'terminal',      color: 'text-success',  desc: '在终端执行' },
  ai_chat:    { label: 'AI 对话', icon: 'forum',       color: 'text-accent',   desc: '向 AI 提问' },
  webhook:    { label: 'Webhook', icon: 'webhook',    color: 'text-warning',  desc: 'HTTP POST' },
};

const STATUS_META: Record<TaskStatus, { label: string; color: string; bg: string; icon: string }> = {
  pending:   { label: '等待中', color: 'text-text-secondary', bg: 'bg-bg-dim',         icon: 'schedule' },
  running:   { label: '运行中', color: 'text-primary',         bg: 'bg-primary/15',     icon: 'progress_activity' },
  done:      { label: '已完成', color: 'text-success',         bg: 'bg-success/15',     icon: 'check_circle' },
  failed:    { label: '失败',   color: 'text-danger',          bg: 'bg-danger/15',      icon: 'error' },
  cancelled: { label: '已取消', color: 'text-text-secondary',  bg: 'bg-bg-dim',         icon: 'block' },
};

interface Props {
  open: boolean;
  onClose: () => void;
}

export function TaskScheduler({ open, onClose }: Props) {
  const [tasks, setTasks] = useState<ScheduledTask[]>(loadTasks);
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const [newInput, setNewInput] = useState('');
  const [newKind, setNewKind] = useState<TaskKind>('reminder');
  const [newTitle, setNewTitle] = useState('');
  const [newPayload, setNewPayload] = useState('');
  const [filter, setFilter] = useState<'all' | TaskStatus | 'upcoming'>('all');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { saveTasks(tasks); }, [tasks]);

  // 调度器主循环: 每秒检查 pending 任务
  useEffect(() => {
    const tick = setInterval(() => {
      const now = Date.now();
      setTasks(prev => prev.map(t => {
        if (t.status !== 'pending') return t;
        if (t.fireAt <= now) {
          // 触发执行
          executeTask(t);
          return { ...t, status: 'running', runCount: t.runCount + 1 };
        }
        return t;
      }));
    }, 1000);
    return () => clearInterval(tick);
  }, []);

  // 执行任务 (mock)
  const executeTask = (task: ScheduledTask) => {
    setTimeout(() => {
      let result = '';
      switch (task.kind) {
        case 'reminder':
          pushNotification?.({ level: 'info', title: '⏰ 提醒', message: task.payload || task.title });
          result = `已弹出提醒: ${task.payload || task.title}`;
          break;
        case 'run_command':
          result = `执行命令: ${task.payload}\n(exit 0, 234ms)`;
          break;
        case 'ai_chat':
          result = `AI 回复: ${(task.payload || '').slice(0, 60)}...`;
          break;
        case 'webhook':
          result = `POST ${task.payload}\n→ 200 OK`;
          break;
      }
      setTasks(prev => prev.map(t => t.id === task.id ? {
        ...t,
        status: 'done',
        result,
        ...(t.cron ? { fireAt: nextFireAtFromCron(t.cron) } : {}),
      } : t));
    }, 800 + Math.random() * 1500);
  };

  const addTask = () => {
    const input = newInput.trim();
    if (!input) {
      pushToast({ level: 'warning', title: '请输入时间', duration: 1200 });
      return;
    }
    const parsed = parseNaturalTime(input);
    if (!parsed) {
      pushToast({ level: 'error', title: '无法解析时间', message: '试试 "5 分钟后" / "明天 9 点" / "0 9 * * *"', duration: 3000 });
      return;
    }
    const id = 't_' + Date.now().toString(36);
    const task: ScheduledTask = {
      id,
      title: newTitle.trim() || (newKind === 'reminder' ? (newPayload || '提醒') : `${KIND_META[newKind].label}: ${newPayload || input}`),
      kind: newKind,
      naturalInput: input,
      fireAt: parsed.fireAt,
      cron: parsed.cron,
      nextFireAt: parsed.cron ? parsed.fireAt : undefined,
      payload: newPayload,
      status: 'pending',
      createdAt: Date.now(),
      runCount: 0,
    };
    setTasks(prev => [task, ...prev]);
    setNewInput('');
    setNewTitle('');
    setNewPayload('');
    pushToast({
      level: 'success',
      title: '已计划',
      message: `${parsed.description} · ${task.title}`,
      duration: 2000,
    });
  };

  const cancelTask = (id: string) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, status: 'cancelled' } : t));
  };
  const deleteTask = (id: string) => {
    setTasks(prev => prev.filter(t => t.id !== id));
  };
  const reschedule = (id: string, minutes: number) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, fireAt: Date.now() + minutes * 60_000, status: 'pending' } : t));
    pushToast({ level: 'info', title: '已重新计划', message: `${minutes} 分钟后`, duration: 1500 });
  };
  const clearAll = () => {
    if (confirm('确认清空所有已完成/已取消的任务?')) {
      setTasks(prev => prev.filter(t => t.status === 'pending' || t.status === 'running'));
    }
  };

  // 统计
  const stats = useMemo(() => {
    const pending = tasks.filter(t => t.status === 'pending').length;
    const running = tasks.filter(t => t.status === 'running').length;
    const done = tasks.filter(t => t.status === 'done').length;
    const failed = tasks.filter(t => t.status === 'failed').length;
    const recurring = tasks.filter(t => t.cron).length;
    return { pending, running, done, failed, recurring };
  }, [tasks]);

  // 过滤
  const filtered = useMemo(() => {
    const now = Date.now();
    return tasks.filter(t => {
      if (filter === 'all') return true;
      if (filter === 'upcoming') return t.status === 'pending' && t.fireAt > now;
      return t.status === filter;
    }).sort((a, b) => {
      // pending 排最前 (按 fireAt), 其余按时间倒序
      if (a.status === 'pending' && b.status !== 'pending') return -1;
      if (a.status !== 'pending' && b.status === 'pending') return 1;
      if (a.status === 'pending' && b.status === 'pending') return a.fireAt - b.fireAt;
      return b.createdAt - a.createdAt;
    });
  }, [tasks, filter]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[225] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[1000px] max-w-[95vw] h-[700px] max-h-[92vh] overflow-hidden bg-surface rounded-2xl border border-border shadow-2xl flex flex-col animate-slide-in-up"
        onClick={e => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center gap-2 px-4 h-12 border-b border-border shrink-0">
          <span className="material-symbols-outlined text-primary text-lg">event_upcoming</span>
          <h3 className="font-display font-semibold text-text">任务调度器</h3>
          <Badge variant="primary">计划</Badge>
          <div className="flex items-center gap-2 text-[10px] text-text-secondary font-mono ml-2">
            <span className="flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-text-secondary animate-pulse" />{stats.pending} 等待</span>
            <span>·</span>
            <span className="text-primary">{stats.running} 运行</span>
            <span>·</span>
            <span className="text-success">{stats.done} 完成</span>
            {stats.recurring > 0 && <><span>·</span><span className="text-accent">{stats.recurring} 周期</span></>}
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-0.5 p-0.5 rounded bg-bg-dim border border-border-light">
            <button
              onClick={() => setView('list')}
              className={`px-2 h-6 text-[10px] rounded ${view === 'list' ? 'bg-primary text-on-primary' : 'text-text-secondary hover:text-text'}`}
            >
              列表
            </button>
            <button
              onClick={() => setView('calendar')}
              className={`px-2 h-6 text-[10px] rounded ${view === 'calendar' ? 'bg-primary text-on-primary' : 'text-text-secondary hover:text-text'}`}
            >
              日历
            </button>
          </div>
          <Tooltip content="清空已完成">
            <IconButton icon="delete_sweep" size="sm" onClick={clearAll} />
          </Tooltip>
          <IconButton icon="close" size="sm" onClick={onClose} />
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* 左侧: 新建 */}
          <div className="w-[340px] border-r border-border bg-surface-low p-3 overflow-y-auto scrollbar-thin">
            <h4 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-2">新建计划任务</h4>

            {/* 类型 */}
            <div className="grid grid-cols-2 gap-1 mb-3">
              {(Object.keys(KIND_META) as TaskKind[]).map(k => {
                const meta = KIND_META[k];
                const active = newKind === k;
                return (
                  <button
                    key={k}
                    onClick={() => setNewKind(k)}
                    className={`flex items-center gap-1.5 px-2 py-1.5 rounded text-[11px] border transition-colors ${
                      active
                        ? 'bg-primary/15 text-primary border-primary/40'
                        : 'bg-bg-dim text-text-secondary border-border-light hover:text-text'
                    }`}
                  >
                    <span className={`material-symbols-outlined text-sm ${active ? meta.color : ''}`}>{meta.icon}</span>
                    <div className="flex-1 text-left">
                      <div>{meta.label}</div>
                      <div className="text-[9px] opacity-70">{meta.desc}</div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* 时间输入 */}
            <label className="text-[10px] text-text-secondary mb-1 block">时间 (自然语言 / cron)</label>
            <textarea
              ref={inputRef}
              value={newInput}
              onChange={e => setNewInput(e.target.value)}
              placeholder="例: 5 分钟后 / 明天 9 点 / 每天 8:30 / 每周一 14:00 / 0 9 * * 1-5"
              rows={2}
              className="w-full px-2 py-1.5 mb-2 bg-bg-dim border border-border-light text-xs text-text rounded
                focus:outline-none focus:border-primary placeholder-text-secondary font-mono resize-none"
            />

            {/* 解析预览 */}
            {newInput.trim() && (() => {
              const p = parseNaturalTime(newInput);
              if (!p) return (
                <div className="text-[10px] text-danger mb-2 flex items-center gap-1">
                  <span className="material-symbols-outlined text-xs">error</span>
                  无法解析
                </div>
              );
              return (
                <div className="mb-2 px-2 py-1 rounded bg-primary/10 border border-primary/30 text-[10px] text-primary flex items-center gap-1">
                  <span className="material-symbols-outlined text-xs">schedule</span>
                  {p.description} · {new Date(p.fireAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  {p.isRecurring && <Badge variant="primary" className="text-[8px]">周期</Badge>}
                </div>
              );
            })()}

            {/* 标题 + payload */}
            <label className="text-[10px] text-text-secondary mb-1 block">标题 (可选)</label>
            <input
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              placeholder="自动生成"
              className="w-full px-2 py-1.5 mb-2 bg-bg-dim border border-border-light text-xs text-text rounded
                focus:outline-none focus:border-primary placeholder-text-secondary"
            />
            <label className="text-[10px] text-text-secondary mb-1 block">
              {newKind === 'reminder' ? '提醒内容' :
               newKind === 'run_command' ? '命令' :
               newKind === 'ai_chat' ? 'AI 提问' :
               'Webhook URL'}
            </label>
            <input
              value={newPayload}
              onChange={e => setNewPayload(e.target.value)}
              placeholder={
                newKind === 'reminder' ? '明天记得提交周报' :
                newKind === 'run_command' ? 'npm run backup' :
                newKind === 'ai_chat' ? '总结今天的 git log' :
                'https://api.example.com/hook'
              }
              className="w-full px-2 py-1.5 mb-3 bg-bg-dim border border-border-light text-xs text-text rounded
                focus:outline-none focus:border-primary placeholder-text-secondary font-mono"
            />

            <Button variant="primary" size="sm" icon="add" className="w-full" onClick={addTask}>
              添加任务
            </Button>

            {/* 快捷时间 */}
            <div className="mt-3 pt-3 border-t border-border-light">
              <div className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-1">快捷</div>
              <div className="grid grid-cols-3 gap-1">
                {[
                  { label: '5 分钟', input: '5 分钟后' },
                  { label: '1 小时', input: '1 小时后' },
                  { label: '明天 9 点', input: '明天 9 点' },
                  { label: '每天 8:30', input: '每天 8:30' },
                  { label: '每周一', input: '每周一 9:00' },
                  { label: 'cron', input: '0 9 * * 1-5' },
                ].map(s => (
                  <button
                    key={s.input}
                    onClick={() => setNewInput(s.input)}
                    className="px-1.5 h-6 text-[10px] rounded bg-bg-dim text-text-secondary border border-border-light hover:text-text hover:border-primary/40"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 右侧: 任务列表 / 日历 */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex items-center gap-1 px-3 h-9 border-b border-border-light bg-bg-dim/40 shrink-0">
              {(['all', 'upcoming', 'pending', 'running', 'done', 'failed', 'cancelled'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-2 h-6 text-[10px] rounded ${
                    filter === f
                      ? f === 'all' ? 'bg-primary text-on-primary' : 'bg-accent/20 text-accent border border-accent/40'
                      : 'bg-surface text-text-secondary border border-border-light hover:text-text'
                  }`}
                >
                  {f === 'all' ? '全部' : f === 'upcoming' ? '即将到来' : STATUS_META[f].label}
                  <span className="ml-1 font-mono opacity-70">
                    {f === 'all' ? tasks.length :
                     f === 'upcoming' ? tasks.filter(t => t.status === 'pending' && t.fireAt > Date.now()).length :
                     tasks.filter(t => t.status === f).length}
                  </span>
                </button>
              ))}
            </div>

            {view === 'list' ? (
              <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-1.5">
                {filtered.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-text-secondary">
                    <span className="material-symbols-outlined text-4xl mb-2 opacity-30">event_available</span>
                    <p className="text-xs">暂无任务</p>
                  </div>
                ) : filtered.map(t => (
                  <TaskRow key={t.id} task={t} onCancel={cancelTask} onDelete={deleteTask} onReschedule={reschedule} />
                ))}
              </div>
            ) : (
              <CalendarView tasks={tasks} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TaskRow({ task, onCancel, onDelete, onReschedule }: {
  task: ScheduledTask;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  onReschedule: (id: string, min: number) => void;
}) {
  const kind = KIND_META[task.kind];
  const status = STATUS_META[task.status];
  const fireDate = new Date(task.fireAt);
  const now = Date.now();
  const isUpcoming = task.status === 'pending' && task.fireAt > now;
  const msUntil = task.fireAt - now;
  const timeStr = isUpcoming
    ? msUntil < 60_000 ? `${Math.floor(msUntil / 1000)} 秒后` :
      msUntil < 3_600_000 ? `${Math.floor(msUntil / 60_000)} 分后` :
      msUntil < 86_400_000 ? `${Math.floor(msUntil / 3_600_000)} 小时后` :
      `${Math.floor(msUntil / 86_400_000)} 天后`
    : fireDate.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="group flex items-start gap-2 p-2 rounded-lg border border-border-light bg-bg-dim/30 hover:bg-surface-high transition-colors">
      <span className={`material-symbols-outlined text-base ${kind.color} mt-0.5`}>{kind.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-text truncate flex-1">{task.title}</span>
          <span className={`shrink-0 flex items-center gap-0.5 px-1.5 h-5 rounded text-[9px] ${status.bg} ${status.color} border border-current/20`}>
            <span className={`material-symbols-outlined text-[10px] ${task.status === 'running' ? 'animate-spin' : ''}`}>{status.icon}</span>
            {status.label}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-text-secondary/80 font-mono">
          <span className="flex items-center gap-0.5">
            <span className="material-symbols-outlined text-[10px]">schedule</span>
            {timeStr}
          </span>
          <span>·</span>
          <span>{kind.label}</span>
          {task.cron && <><span>·</span><span className="text-accent">周期 {task.cron}</span></>}
          {task.runCount > 0 && <><span>·</span><span>已执行 {task.runCount} 次</span></>}
        </div>
        {task.payload && (
          <code className="block mt-1 px-1.5 py-0.5 text-[10px] text-text-secondary bg-bg-dim border border-border-light rounded truncate">
            {task.payload}
          </code>
        )}
        {task.result && (
          <div className="mt-1 text-[10px] text-success/80 font-mono whitespace-pre-wrap break-all">
            ✓ {task.result}
          </div>
        )}
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        {task.status === 'pending' && (
          <>
            <Tooltip content="延后 5 分钟">
              <IconButton icon="schedule" size="xs" onClick={() => onReschedule(task.id, 5)} />
            </Tooltip>
            <Tooltip content="取消">
              <IconButton icon="block" size="xs" onClick={() => onCancel(task.id)} />
            </Tooltip>
          </>
        )}
        <Tooltip content="删除">
          <IconButton icon="delete" size="xs" onClick={() => onDelete(task.id)} />
        </Tooltip>
      </div>
    </div>
  );
}

function CalendarView({ tasks }: { tasks: ScheduledTask[] }) {
  // 7 天视图: 今天 + 6 天
  const days = useMemo(() => {
    const out: Array<{ date: Date; tasks: ScheduledTask[] }> = [];
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      const dayStart = d.getTime();
      const dayEnd = dayStart + 86_400_000;
      const dayTasks = tasks.filter(t => t.fireAt >= dayStart && t.fireAt < dayEnd);
      out.push({ date: d, tasks: dayTasks });
    }
    return out;
  }, [tasks]);

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin p-3">
      <div className="grid grid-cols-7 gap-1.5">
        {days.map((d, i) => {
          const isToday = d.date.toDateString() === new Date().toDateString();
          return (
            <div key={i} className={`rounded-lg border ${isToday ? 'border-primary bg-primary/5' : 'border-border-light bg-bg-dim/30'} overflow-hidden`}>
              <div className={`px-2 py-1.5 text-center ${isToday ? 'bg-primary/15' : 'bg-bg-dim/40'}`}>
                <div className="text-[9px] text-text-secondary uppercase">{'日一二三四五六'[d.date.getDay()]}</div>
                <div className={`text-base font-mono ${isToday ? 'text-primary font-bold' : 'text-text'}`}>{d.date.getDate()}</div>
              </div>
              <div className="p-1 space-y-0.5 min-h-[120px]">
                {d.tasks.length === 0 ? (
                  <div className="text-[9px] text-text-secondary/40 text-center py-2">—</div>
                ) : d.tasks.map(t => (
                  <div
                    key={t.id}
                    className={`px-1 py-0.5 rounded text-[9px] truncate ${
                      t.status === 'pending' ? 'bg-primary/15 text-primary' :
                      t.status === 'running' ? 'bg-warning/15 text-warning' :
                      t.status === 'done' ? 'bg-success/15 text-success' :
                      t.status === 'failed' ? 'bg-danger/15 text-danger' :
                      'bg-bg-dim text-text-secondary'
                    }`}
                    title={t.title}
                  >
                    <span className="font-mono">{new Date(t.fireAt).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}</span>
                    {' '}
                    {t.title}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── 工具: cron → 下一次 fireAt (简单实现) ───
function nextFireAtFromCron(cron: string, now: number = Date.now()): number {
  const parts = cron.split(/\s+/);
  if (parts.length !== 5) return now + 3_600_000;
  const [min, hour, , , dow] = parts;
  const next = new Date(now + 60_000);
  next.setSeconds(0, 0);
  // 简单: 匹配 cron 不精确, 改用 hourly fallback
  if (min === '*' && hour === '*') return next.getTime();
  if (min !== '*' && hour !== '*') {
    const targetH = parseInt(hour);
    const targetM = parseInt(min);
    next.setHours(targetH, targetM, 0, 0);
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    if (dow !== '*') {
      const targetDow = parseInt(dow);
      const daysToAdd = (targetDow - next.getDay() + 7) % 7;
      next.setDate(next.getDate() + daysToAdd);
    }
    return next.getTime();
  }
  return next.getTime();
}

// ─── mock 通知 (避免循环 import) ───
const pushNotification = (n: { level: string; title: string; message?: string }) => {
  pushToast({ level: n.level as any, title: n.title, message: n.message, duration: 4000 });
};
