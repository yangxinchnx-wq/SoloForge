/**
 * execGuard — AI 命令执行的统一闸门
 *
 * 流程:
 *   1. 先做 policy 评估 (deny → 直接返回伪造的 stderr 错误, 不走 fetch)
 *   2. mutate 类 + 当前 mode 需要 confirm:
 *        - 已在本会话决策日志中 → 跳过
 *        - 否则 enqueue, 挂在 await 上, 等用户点
 *   3. 用户决策:
 *        deny        → 返回 sandbox_id: 'denied:' 的失败结果
 *        allow-once  → 真跑
 *        allow-for-chat → 真跑 + 写决策日志
 *
 * 用法:
 *   import { guardedExecute } from '@/components/terminal/service/execGuard';
 *   const result = await guardedExecute({
 *     chatId, sandboxId, command, mode,
 *   });
 */

import type { SandboxExecuteResult } from '../../../services/e2b/E2BService';
import { executeInChatWorkdir } from '../../../services/e2b/E2BService';
import type { PermissionMode, PolicyDecision } from './commandPolicy';
import { evaluateCommand } from './commandPolicy';
import { useConfirmQueueStore, type PendingCommand } from '../store/confirmQueueStore';

export interface GuardedOptions {
  chatId: string;
  sandboxId: string;
  command: string;
  mode?: PermissionMode;
  cwd?: string;
  timeout?: number;
  /** 仅单测用: 注入假决策评估, 跳过黑白名单 */
  _bypassPolicy?: boolean;
}

export interface GuardedResult extends SandboxExecuteResult {
  decidedBy?: 'auto' | 'once' | 'session' | 'denied';
  decision?: PolicyDecision;
}

interface Resolver {
  (r: GuardedResult): void;
  (e: Error): void;
}

function deniedResult(sandboxId: string, command: string, reason: string): GuardedResult {
  return {
    sandboxId,
    command,
    stdout: '',
    stderr: `✗ ${reason}`,
    exitCode: 126,
    executionTime: 0,
    decidedBy: 'denied',
  };
}

function autoAllowResult(sandboxId: string, command: string, decision: PolicyDecision): GuardedResult {
  return {
    sandboxId,
    command,
    stdout: '',
    stderr: '',
    exitCode: 0,
    executionTime: 0,
    decidedBy: 'auto',
    decision,
  };
}

const pendingWaiters = new Map<string, (r: GuardedResult) => void>();

useConfirmQueueStore.subscribe((s, prev) => {
  if (s.queue === prev.queue) return;
  for (const item of s.queue) {
    if (item.resolution === 'pending') continue;
    const key = item.id;
    const w = pendingWaiters.get(key);
    if (!w) continue;
    pendingWaiters.delete(key);
    if (item.resolution === 'denied') {
      w(deniedResult(item.chatId, item.command, `用户拒绝: ${item.command.split('\n')[0]}`));
    } else {
      w({ ...(autoAllowResult(item.chatId, item.command, item.decision)), decidedBy: item.decision_label === 'allow-for-chat' ? 'session' : 'once' });
    }
  }
});

export async function guardedExecute(opts: GuardedOptions): Promise<GuardedResult> {
  const { chatId, sandboxId, command } = opts;
  const mode: PermissionMode = opts.mode ?? 'normal';

  const decision: PolicyDecision = opts._bypassPolicy
    ? { risk: 'mutate', reasons: ['bypass'], requiresConfirm: false, blocked: false, label: 'bypass' }
    : evaluateCommand(command, mode);

  if (decision.blocked) {
    return deniedResult(sandboxId, command, `[gatekeeper] 硬拦截 (${decision.label}): ${decision.matchedKeyword ?? decision.reasons.join(';')}`);
  }

  const queue = useConfirmQueueStore.getState();

  if (!decision.requiresConfirm) {
    return runUnderlying({ ...opts, mode, _decision: decision });
  }

  if (queue.isAllowedByLog(chatId, decision, command)) {
    return runUnderlying({ ...opts, mode, _decision: decision, _logHit: true });
  }

  const entry: PendingCommand = queue.enqueue({
    chatId,
    command,
    decision,
    mode,
  });

  return new Promise<GuardedResult>((resolve) => {
    pendingWaiters.set(entry.id, (r: GuardedResult) => {
      if (r.decidedBy === 'denied') {
        resolve(r);
        return;
      }
      runUnderlying({ ...opts, mode, _decision: decision }).then(resolve);
    });
  });
}

async function runUnderlying(
  opts: GuardedOptions & { _decision: PolicyDecision; _logHit?: boolean },
): Promise<GuardedResult> {
  const result = await executeInChatWorkdir(opts.chatId, opts.sandboxId, opts.command, {
    cwd: opts.cwd,
    timeout: opts.timeout,
  });
  return { ...result, decision: opts._decision, decidedBy: opts._logHit ? 'session' : 'once' };
}

export function _clearPendingForTest(): void {
  pendingWaiters.clear();
}
