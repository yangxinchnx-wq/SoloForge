/**
 * tokenRotationService.ts — 定时轮换 worker
 *
 * 启动后挂载到 api-server, 每 5 分钟 tick 一次:
 *   1. 扫描 vault, 找出 expiresAt 临近的 active token
 *   2. 为每个即将过期的 token 生成新 active kid
 *      旧 token 自动进入 rotating (grace period 内仍可用)
 *   3. 清理已过 grace period 的 rotating token (标记 revoked)
 *   4. 审计日志输出 token.rotation.*
 *
 * 触发条件:
 *   - 默认: 距 expiresAt 不足 TTL * 0.1 (90 天 TTL → 提前 9 天)
 *   - 可由环境变量 SOLOFORGE_ROTATION_LEAD_MS 覆盖
 *
 * 关闭:
 *   - SOLOFORGE_ROTATION_DISABLED=1  (例如测试环境, 避免时间漂移)
 *
 * 复用安全:
 *   - 轮换只创建新 active, 不会复用已有 kid
 *   - 每次轮换都建立 parent 链, 审计可追溯
 */

import { logger } from '../core/logger';
import {
  createToken,
  gcExpiredTokens,
  listActiveKids,
  type TokenRecord,
  DEFAULT_TTL_MS,
  DEFAULT_GRACE_PERIOD_MS,
  DEFAULT_ROTATION_CHECK_INTERVAL_MS,
} from './tokenStore';

const LEAD_RATIO = 0.1; // 提前 10% TTL 开始轮换

export interface RotationTickResult {
  rotatedKids: string[];
  gcRemoved: number;
  durationMs: number;
}

export interface RotationServiceOptions {
  intervalMs?: number;
  leadMs?: number;
  ttlMs?: number;
  graceMs?: number;
  /** 注入的 tick 回调, 方便测试 */
  onRotate?: (old: TokenRecord, fresh: TokenRecord) => void;
  onError?: (err: Error) => void;
}

export class TokenRotationService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;
  private opts: Required<Omit<RotationServiceOptions, 'onRotate' | 'onError'>> & {
    onRotate?: RotationServiceOptions['onRotate'];
    onError?: RotationServiceOptions['onError'];
  };

  constructor(opts: RotationServiceOptions = {}) {
    this.opts = {
      intervalMs: opts.intervalMs ?? DEFAULT_ROTATION_CHECK_INTERVAL_MS,
      leadMs: opts.leadMs ?? DEFAULT_TTL_MS * LEAD_RATIO,
      ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
      graceMs: opts.graceMs ?? DEFAULT_GRACE_PERIOD_MS,
      onRotate: opts.onRotate,
      onError: opts.onError,
    };
  }

  /**
   * 启动后台 worker。幂等: 重复调用不会创建多个 timer。
   */
  start(): void {
    if (this.running) return;
    if (process.env.SOLOFORGE_ROTATION_DISABLED === '1') {
      logger.info('TokenRotation', 'disabled by SOLOFORGE_ROTATION_DISABLED=1');
      return;
    }
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.opts.intervalMs);
    // unref: 不阻塞进程退出
    this.timer.unref?.();
    logger.info('TokenRotation', `started, interval=${this.opts.intervalMs}ms lead=${this.opts.leadMs}ms`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    logger.info('TokenRotation', 'stopped');
  }

  /**
   * 立即执行一次 tick (供启动时主动触发 / 测试)。
   */
  async tickOnce(now: number = Date.now()): Promise<RotationTickResult> {
    return this.runTick(now);
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return; // 防止 tick 重叠
    this.inFlight = true;
    try {
      await this.runTick();
    } catch (e) {
      const err = e as Error;
      logger.error('TokenRotation', `tick failed: ${err.message}`);
      this.opts.onError?.(err);
    } finally {
      this.inFlight = false;
    }
  }

  private async runTick(now: number = Date.now()): Promise<RotationTickResult> {
    const t0 = Date.now();
    const active = await listActiveKids();
    const lead = this.opts.leadMs;
    const rotated: string[] = [];

    for (const info of active) {
      if (info.status !== 'active') continue;
      if (info.expiresAt - now > lead) continue;

      // 找完整 record
      const { findByKid } = await import('./tokenStore');
      const old = await findByKid(info.kid);
      if (!old || old.status !== 'active') continue;

      const fresh = await createToken({
        parentKid: old.kid,
        source: 'rotate',
        ttlMs: this.opts.ttlMs,
        graceMs: this.opts.graceMs,
        now,
      });
      rotated.push(`${old.kid}→${fresh.kid}`);
      logger.info('TokenRotation', `rotated ${old.kid} → ${fresh.kid} (family=${fresh.familyId})`);
      this.opts.onRotate?.(old, fresh);
    }

    const gcRemoved = await gcExpiredTokens(now);

    const result: RotationTickResult = {
      rotatedKids: rotated,
      gcRemoved,
      durationMs: Date.now() - t0,
    };
    if (rotated.length > 0 || gcRemoved > 0) {
      logger.info('TokenRotation', `tick done: rotated=${rotated.length} gc=${gcRemoved} took=${result.durationMs}ms`);
    }
    return result;
  }
}

// 单例
let singleton: TokenRotationService | null = null;
export function getTokenRotationService(): TokenRotationService {
  if (!singleton) singleton = new TokenRotationService();
  return singleton;
}

export function resetTokenRotationServiceForTest(): void {
  if (singleton) singleton.stop();
  singleton = null;
}
