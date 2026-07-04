/**
 * confirmQueueStore — AI 触发的命令待确认队列
 *
 * 设计:
 *   - 一个 FIFO 队列, 每个 entry = { id, chatId, command, decision, ... }
 *   - 决策:
 *       'allow'           立即执行 (一次)
 *       'allow-for-chat'  本会话所有同风险命令自动通过 (入决策日志)
 *       'deny'            拒绝 + 返回失败结果
 *   - 持久化 'allow-for-chat' 的决策日志到 localStorage; 重启后仍生效
 *   - 暴露 unconfirmedCount 给 StatusBar 红点
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PolicyDecision, PermissionMode } from '../service/commandPolicy';

export type ConfirmResolution = 'pending' | 'allowed' | 'denied';
export type UserDecision = 'allow-once' | 'allow-for-chat' | 'deny';

export interface PendingCommand {
  id: string;
  chatId: string;
  command: string;
  decision: PolicyDecision;
  mode: PermissionMode;
  createdAt: number;
  resolution: ConfirmResolution;
  decidedAt?: number;
  /** 用户最终选择的按钮 */
  decision_label?: UserDecision;
}

interface DecisionLogEntry {
  chatId: string;
  /** 与 PolicyDecision.label 对齐 (例如 '写盘/安装') */
  riskLabel: string;
  /** 简化匹配: 命中的首个 mutate keyword */
  signature: string;
  decidedAt: number;
}

interface ConfirmQueueState {
  queue: PendingCommand[];
  /** 持久化的 '本会话永远信任' 决策 */
  decisionLog: DecisionLogEntry[];
  enqueue: (p: Omit<PendingCommand, 'id' | 'createdAt' | 'resolution'>) => PendingCommand;
  resolve: (id: string, decision: UserDecision) => PendingCommand | undefined;
  /** 弹回拒绝结果给 execGuard, 不真执行 */
  snapshot: (chatId: string) => PendingCommand | undefined;
  pendingCount: () => number;
  isAllowedByLog: (chatId: string, decision: PolicyDecision, command: string) => boolean;
  remove: (chatId: string) => void;
}

function genId(): string {
  return `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function signatureOf(decision: PolicyDecision, command: string): string {
  const firstLine = command.split('\n')[0].trim().slice(0, 40);
  return decision.matchedKeyword ?? firstLine;
}

export const useConfirmQueueStore = create<ConfirmQueueState>()(
  persist(
    (set, get) => ({
      queue: [],
      decisionLog: [],

      pendingCount: () => get().queue.filter(q => q.resolution === 'pending').length,

      isAllowedByLog: (chatId, decision, command) => {
        const sig = signatureOf(decision, command);
        return get().decisionLog.some(
          e => e.chatId === chatId && e.riskLabel === decision.label && e.signature === sig,
        );
      },

      enqueue: (p) => {
        const id = genId();
        const entry: PendingCommand = { ...p, id, createdAt: Date.now(), resolution: 'pending' };
        set(s => ({ queue: [...s.queue, entry] }));
        emitBadge();
        return entry;
      },

      resolve: (id, decision) => {
        let resolved: PendingCommand | undefined;
        set(s => {
          const queue = s.queue.map(q => {
            if (q.id !== id) return q;
            const r: ConfirmResolution = decision === 'deny' ? 'denied' : 'allowed';
            resolved = { ...q, resolution: r, decidedAt: Date.now(), decision_label: decision };
            return resolved;
          });
          let decisionLog = s.decisionLog;
          if (decision === 'allow-for-chat' && resolved) {
            const sig = signatureOf(resolved.decision, resolved.command);
            decisionLog = [
              ...decisionLog,
              { chatId: resolved.chatId, riskLabel: resolved.decision.label, signature: sig, decidedAt: Date.now() },
            ];
          }
          return { queue, decisionLog };
        });
        emitBadge();
        return resolved;
      },

      snapshot: (chatId) => get().queue.find(q => q.chatId === chatId && q.resolution === 'pending'),

      remove: (chatId) => {
        set(s => ({ queue: s.queue.filter(q => q.chatId !== chatId) }));
        emitBadge();
      },
    }),
    {
      name: 'soloforge_confirm_queue',
      version: 1,
      partialize: (state) => ({ decisionLog: state.decisionLog, queue: [] }),
    },
  ),
);

function emitBadge(): void {
  if (typeof window === 'undefined') return;
  try {
    const count = useConfirmQueueStore.getState().pendingCount();
    window.dispatchEvent(new CustomEvent('soloforge-pending-confirms', { detail: { count } }));
  } catch {
    /* ignore */
  }
}
