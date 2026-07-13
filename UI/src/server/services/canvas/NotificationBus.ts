/**
 * CanvasNotificationBus
 * ---------------------------------------------------------------------------
 * 画布修改通知总线 (server 侧, 进程内单例)
 *
 * 设计:
 *   - 按 targetChatSessionId 索引 (who should be notified)
 *   - 每条记录: { id, canvasId, action, actorChatSessionId, ts }
 *   - 60 秒冷却: 同一 (canvasId, action) 60s 内不重复 emit (在 emit 处过滤)
 *   - owner 不通知自己 (requesterChatSessionId === ownerChatSessionId 时跳过)
 *   - 消费模式: GET /api/canvas/notifications?requester=X 拉取后立即 ack 删
 *
 * 触发源:
 *   - canvasTools.ts 中 solo_canvas_add/update/remove/rename/delete
 *     (但写操作已经 ensureWrite 过, 这里就是 owner !== requester)
 *   - canvasSession.ts 中 REST API (PUT transform / POST devices / DELETE / PATCH)
 *
 * 不持久化 (进程重启丢失, 足够用 — 通知是即时反馈, 不需要历史)
 */

export type CanvasAction =
  | 'write_device'    // add / update / transform
  | 'remove_device'
  | 'rename'
  | 'delete';

export interface CanvasNotification {
  id: string;
  /** 谁触发了这个动作 */
  actorChatSessionId: string;
  /** 谁应该收到 (canvas 的 owner) */
  targetChatSessionId: string;
  /** 被操作的画布 ID */
  canvasId: string;
  /** 画布显示名 (e.g. "1") */
  canvasDisplayName: string;
  /** 发生了什么 */
  action: CanvasAction;
  /** 时间戳 (ms) */
  ts: number;
  /** 人类可读说明 (e.g. "chat-B 添加了设备") */
  message: string;
}

const COOLDOWN_MS = 60_000;   // 同一画布同动作 60s 内不重复通知
const MAX_QUEUE = 200;        // 防止内存泄漏 (每 target 最多保留 200 条)

let counter = 0;
const nextId = () => `cn_${Date.now()}_${++counter}`;

class CanvasNotificationBus {
  /** targetChatSessionId -> queue */
  private inbox = new Map<string, CanvasNotification[]>();
  /** cooldown key = `${canvasId}:${action}` -> ts; 但 cooldown 跟 target 有关 */
  private cooldown = new Map<string, number>();

  /**
   * Emit a notification.
   * @returns true if notification was queued, false if suppressed (cooldown or self-write)
   */
  emit(input: {
    actorChatSessionId: string;
    ownerChatSessionId: string | null;
    canvasId: string;
    canvasDisplayName: string;
    action: CanvasAction;
  }): boolean {
    // 无归属画布: 没有 owner 可通知, 跳过
    if (!input.ownerChatSessionId) return false;
    // owner 自己写自己不通知
    if (input.actorChatSessionId === input.ownerChatSessionId) return false;
    // 60s cooldown per (canvasId, action, target)
    const cooldownKey = `${input.canvasId}:${input.action}:${input.ownerChatSessionId}`;
    const last = this.cooldown.get(cooldownKey);
    const now = Date.now();
    if (last && now - last < COOLDOWN_MS) return false;
    this.cooldown.set(cooldownKey, now);

    const note: CanvasNotification = {
      id: nextId(),
      actorChatSessionId: input.actorChatSessionId,
      targetChatSessionId: input.ownerChatSessionId,
      canvasId: input.canvasId,
      canvasDisplayName: input.canvasDisplayName,
      action: input.action,
      ts: now,
      message: this.humanize(input),
    };

    const list = this.inbox.get(input.ownerChatSessionId) || [];
    list.push(note);
    if (list.length > MAX_QUEUE) list.shift();
    this.inbox.set(input.ownerChatSessionId, list);

    return true;
  }

  /** 拉取并消费 (ack 即删除) */
  drain(targetChatSessionId: string): CanvasNotification[] {
    const list = this.inbox.get(targetChatSessionId);
    if (!list || list.length === 0) return [];
    this.inbox.set(targetChatSessionId, []);
    return list;
  }

  /** 仅 peek 不消费 (用于调试 / E2E) */
  peek(targetChatSessionId: string): CanvasNotification[] {
    return [...(this.inbox.get(targetChatSessionId) || [])];
  }

  private humanize(input: {
    actorChatSessionId: string;
    canvasDisplayName: string;
    action: CanvasAction;
  }): string {
    const who = input.actorChatSessionId;
    const n = input.canvasDisplayName;
    switch (input.action) {
      case 'write_device':   return `${who} 修改了画布 ${n}`;
      case 'remove_device':  return `${who} 从画布 ${n} 移除了设备`;
      case 'rename':         return `${who} 修改了画布 ${n} 的备注`;
      case 'delete':         return `${who} 删除了画布 ${n}`;
    }
  }
}

let _bus: CanvasNotificationBus | null = null;
export function getNotificationBus(): CanvasNotificationBus {
  if (!_bus) _bus = new CanvasNotificationBus();
  return _bus;
}
