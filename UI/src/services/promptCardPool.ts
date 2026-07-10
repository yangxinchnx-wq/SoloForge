/**
 * promptCardPool — 通用交互模块实例池
 * 管理所有 PromptCard 实例：创建/更新/解析/超时/自动处理
 * 支持 cooldown 去重、模式适配（ultimate 全自动跳过）
 *
 * 2026-07-03: 从 state/ 移到 services/，因其实质是单例服务而非 zustand store
 * 2026-07-10: 添加 useSyncExternalStore 订阅机制, 替代 StreamPanel 中的手动轮询
 */
import type {
  PromptCardSpec,
  PromptCardInstance,
  PromptAction,
  PermissionMode,
} from '../types/streaming';

class PromptCardPool {
  private instances = new Map<string, PromptCardInstance>();
  private cooldownTimers = new Map<string, number>(); // groupKey -> expiresAt

  // useSyncExternalStore 订阅机制
  private listeners = new Set<() => void>();
  // 按 chatId 缓存快照, 保证 getSnapshot 返回稳定引用
  private chatSnapshots = new Map<string, PromptCardInstance[]>();
  private version = 0;

  /** useSyncExternalStore: 订阅变更 */
  subscribe = (callback: () => void): (() => void) => {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  };

  /** useSyncExternalStore: 获取指定 chatId 的活跃卡片快照 (引用稳定) */
  getSnapshotForChat = (chatId: string): PromptCardInstance[] => {
    const cached = this.chatSnapshots.get(chatId);
    if (cached) return cached;

    const snapshot = [...this.instances.values()]
      .filter(i => i.spec.context?.chatId === chatId && i.status === 'active')
      .sort((a, b) => b.createdAt - a.createdAt);

    this.chatSnapshots.set(chatId, snapshot);
    return snapshot;
  };

  /** 通知所有订阅者变更, 清除快照缓存 */
  private notify(): void {
    this.chatSnapshots.clear();
    this.version++;
    this.listeners.forEach(l => l());
  }

  /** 创建/更新实例，根据 mode 决定是否自动处理 */
  upsert(spec: PromptCardSpec, mode: PermissionMode): void {
    // 全自动模式：不弹卡片，直接自动执行推荐动作
    if (mode === 'ultimate' && spec.priority !== 'custom') {
      this.autoResolve(spec);
      this.notify();
      return;
    }

    // cooldown 去重: 同 groupKey 且冷却期内不重复弹 (含已展示的卡)
    if (spec.cooldown && spec.groupKey) {
      const cooldownUntil = this.cooldownTimers.get(spec.groupKey);
      if (cooldownUntil && Date.now() < cooldownUntil) {
        return; // 冷却期内, 跳过
      }
    }

    const existing = this.instances.get(spec.id);
    if (existing) {
      this.instances.set(spec.id, { ...existing, spec });
    } else {
      this.instances.set(spec.id, {
        spec,
        status: 'active',
        remaining: spec.countdown,
        createdAt: Date.now(),
      });
    }

    // 卡片被展示时, 立即开启 cooldown 计时
    if (spec.cooldown && spec.groupKey) {
      this.cooldownTimers.set(
        spec.groupKey,
        Date.now() + spec.cooldown * 1000,
      );
    }

    this.notify();
  }

  /** 全自动模式：直接标记为自动处理 */
  private autoResolve(spec: PromptCardSpec): void {
    const recommended = spec.options.find(o => o.isRecommended) ?? spec.options[0];
    this.instances.set(spec.id, {
      spec,
      status: 'resolved',
      remaining: 0,
      createdAt: Date.now(),
      resolvedAt: Date.now(),
      resolveAction: recommended?.action ?? spec.defaultAction,
      autoResolved: true,
    });
  }

  /** 用户操作 → 标记已解决，并设置 cooldown */
  resolve(id: string, action: PromptAction): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    inst.status = 'resolved';
    inst.resolveAction = action;
    inst.resolvedAt = Date.now();

    // 设置 cooldown
    if (inst.spec.cooldown && inst.spec.groupKey) {
      this.cooldownTimers.set(
        inst.spec.groupKey,
        Date.now() + inst.spec.cooldown * 1000,
      );
    }

    this.notify();
  }

  /** 超时 → 标记过期，执行默认动作 */
  expire(id: string): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    inst.status = 'expired';
    inst.resolveAction = inst.spec.defaultAction;
    inst.resolvedAt = Date.now();

    if (inst.spec.cooldown && inst.spec.groupKey) {
      this.cooldownTimers.set(
        inst.spec.groupKey,
        Date.now() + (inst.spec.cooldown ?? 0) * 1000,
      );
    }

    this.notify();
  }

  /** 关闭卡片 */
  dismiss(id: string): void {
    const inst = this.instances.get(id);
    if (inst) inst.status = 'dismissed';
    this.notify();
  }

  /** 按 chatId 过滤活跃实例 (兼容旧接口, 内部使用) */
  getActive(chatId: string): PromptCardInstance[] {
    return this.getSnapshotForChat(chatId);
  }

  /** 获取所有实例（含已解决的） */
  getAll(chatId: string): PromptCardInstance[] {
    return [...this.instances.values()]
      .filter(i => i.spec.context?.chatId === chatId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 对话切换时清理 */
  clearChat(chatId: string): void {
    let changed = false;
    for (const [id, inst] of this.instances) {
      if (inst.spec.context?.chatId === chatId) {
        this.instances.delete(id);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  /** 获取单实例 */
  get(id: string): PromptCardInstance | undefined {
    return this.instances.get(id);
  }

  /** 测试用: 清空所有实例 + 冷却计时器 */
  __reset(): void {
    this.instances.clear();
    this.cooldownTimers.clear();
    this.notify();
  }
}

export const promptCardPool = new PromptCardPool();
