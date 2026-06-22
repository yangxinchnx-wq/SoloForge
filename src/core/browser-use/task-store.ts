// ============================================================
// Browser-Use task store — 内存级任务注册表
// ============================================================
//
// 任务状态在 Python 端是权威 (browser-use 在那里), 这里只是镜像
// 用途: 列出历史任务 / 调试时给 UI 看

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'success'
  | 'error'
  | 'cancelled';

export interface TaskRecord {
  taskId: string;
  task: string;
  status: TaskStatus;
  currentStep: number;
  result: string;
  error: string;
  startedAt: number;
  finishedAt: number | null;
}

const tasks = new Map<string, TaskRecord>();

export function upsertTask(record: Partial<TaskRecord> & { taskId: string; task: string }): TaskRecord {
  const existing = tasks.get(record.taskId);
  const merged: TaskRecord = {
    taskId: record.taskId,
    task: record.task ?? existing?.task ?? '',
    status: record.status ?? existing?.status ?? 'queued',
    currentStep: record.currentStep ?? existing?.currentStep ?? 0,
    result: record.result ?? existing?.result ?? '',
    error: record.error ?? existing?.error ?? '',
    startedAt: existing?.startedAt ?? Date.now(),
    finishedAt: record.finishedAt ?? existing?.finishedAt ?? null,
  };
  tasks.set(record.taskId, merged);
  return merged;
}

export function patchTask(taskId: string, patch: Partial<TaskRecord>): TaskRecord | null {
  const existing = tasks.get(taskId);
  if (!existing) return null;
  const next = { ...existing, ...patch };
  if (['success', 'error', 'cancelled'].includes(patch.status ?? '') && !existing.finishedAt) {
    next.finishedAt = Date.now();
  }
  tasks.set(taskId, next);
  return next;
}

export function getTask(taskId: string): TaskRecord | null {
  return tasks.get(taskId) ?? null;
}

export function listTasks(): TaskRecord[] {
  return Array.from(tasks.values()).sort((a, b) => b.startedAt - a.startedAt);
}

export function pruneTasks(maxAgeMs: number = 7 * 24 * 3600 * 1000): number {
  const cutoff = Date.now() - maxAgeMs;
  let n = 0;
  for (const [id, t] of tasks) {
    if (t.finishedAt !== null && t.finishedAt < cutoff) {
      tasks.delete(id);
      n++;
    }
  }
  return n;
}
