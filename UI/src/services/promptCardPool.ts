/**
 * promptCardPool — 通用交互模块实例池
 * 管理所有 PromptCard 实例：创建/更新/解析/超时/自动处理
 * 支持 cooldown 去重、模式适配（ultimate 全自动跳过）
 *
 * 2026-07-03: 从 state/ 移到 services/，因其实质是单例服务而非 zustand store
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

  /** 创建/更新实例，根据 mode 决定是否自动处理 */
  upsert(spec: PromptCardSpec, mode: PermissionMode): void {
    // 全自动模式：不弹卡片，直接自动执行推荐动作
    if (mode === 'ultimate' && spec.priority !== 'custom') {
      this.autoResolve(spec);
      return;
    }

    // cooldown 去重: 同 groupKey 且冷却期内不重复弹 (含已展示的卡)
    // 注意: 必须放在 existing 检查之前, 否则同 group 但 spec.id 不同的卡仍会创建
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

    // 卡片被展示时, 立即开启 cooldown 计时 (R1.1)
    // 防止后端重复发同 groupKey 卡片刷屏
    if (spec.cooldown && spec.groupKey) {
      this.cooldownTimers.set(
        spec.groupKey,
        Date.now() + spec.cooldown * 1000,
      );
    }
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
  }

  /** 关闭卡片 */
  dismiss(id: string): void {
    const inst = this.instances.get(id);
    if (inst) inst.status = 'dismissed';
  }

  /** 按 chatId 过滤活跃实例 */
  getActive(chatId: string): PromptCardInstance[] {
    return [...this.instances.values()]
      .filter(i => i.spec.context?.chatId === chatId && i.status === 'active')
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 获取所有实例（含已解决的） */
  getAll(chatId: string): PromptCardInstance[] {
    return [...this.instances.values()]
      .filter(i => i.spec.context?.chatId === chatId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 对话切换时清理 */
  clearChat(chatId: string): void {
    for (const [id, inst] of this.instances) {
      if (inst.spec.context?.chatId === chatId) {
        this.instances.delete(id);
      }
    }
  }

  /** 获取单实例 */
  get(id: string): PromptCardInstance | undefined {
    return this.instances.get(id);
  }

  /** 测试用: 清空所有实例 + 冷却计时器 */
  __reset(): void {
    this.instances.clear();
    this.cooldownTimers.clear();
  }
}

export const promptCardPool = new PromptCardPool();
