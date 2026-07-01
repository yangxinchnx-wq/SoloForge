/**
 * tokenFamily.ts — Token Family 复用检测 + Grace Period
 *
 * 设计动机:
 *   - 即使 token 会定期轮换, 也存在"被窃取后立刻使用"的风险
 *   - 业界方案 (Auth0, Okta, Keycloak): 每次合法 refresh 后旧 token 立即作废,
 *     但保留"grace period"容忍客户端网络抖动 (典型 10-30 秒)
 *   - 若同一 token 在 grace period 外被使用 → 强信号: 有人偷了 token
 *   - 处置: 整族吊销 (Family revoke), 强制所有相关客户端重新认证
 *
 * 关键不变量:
 *   1. 同一 token 在 grace period 内可被重发 (网络抖动)
 *   2. 同一 token 在 grace period 外被使用 → 整族吊销
 *   3. revoked token 任何使用都应被拒 (由 evaluateRequest 提前拦截)
 *
 * 数据来源: tokenStore.ts 提供的内存快照 (v2 schema)
 */

import { findByKid, findByToken, revokeFamily, type TokenRecord, type FamilyRecord } from './tokenStore';

const DEFAULT_GRACE_PERIOD_MS = 30 * 1000; // 30 秒 (业界典型值, 10-60s)

export interface ReuseCheckResult {
  /**
   * 'allow'           : token 有效, 可继续使用
   * 'allow_in_grace'  : token 已 "rotated", 但仍在 grace period 内 (网络重试)
   * 'reuse_detected'  : token 已 "rotated" 且过了 grace period → 攻击信号
   * 'revoked'         : token 已被吊销
   * 'unknown'         : token 不在 vault 中 (可能来自 env 或未知源)
   */
  decision: 'allow' | 'allow_in_grace' | 'reuse_detected' | 'revoked' | 'unknown';
  record: TokenRecord | null;
  family: FamilyRecord | null;
  reason: string;
  graceUntil: number | null;
}

/**
 * 核心检查: 客户端用某个 token 来请求, 服务端判断是否允许。
 *
 * @param bearer   客户端传的明文 token
 * @param now      可选, 测试用注入当前时间
 */
export async function checkReuse(bearer: string, now: number = Date.now()): Promise<ReuseCheckResult> {
  if (!bearer) {
    return { decision: 'unknown', record: null, family: null, reason: 'empty_bearer', graceUntil: null };
  }

  const record = await findByToken(bearer);
  if (!record) {
    return { decision: 'unknown', record: null, family: null, reason: 'not_in_vault', graceUntil: null };
  }

  if (record.status === 'revoked') {
    return {
      decision: 'revoked',
      record,
      family: null,
      reason: 'token_revoked',
      graceUntil: null,
    };
  }

  if (record.status === 'active') {
    return {
      decision: 'allow',
      record,
      family: null,
      reason: 'active',
      graceUntil: null,
    };
  }

  if (record.status === 'rotating') {
    const grace = record.graceUntil ?? record.rotatedAt ?? 0;
    if (now <= grace) {
      return {
        decision: 'allow_in_grace',
        record,
        family: null,
        reason: 'in_grace_period',
        graceUntil: grace,
      };
    }
    // 已过 grace period, 有人偷了 token 来用
    return {
      decision: 'reuse_detected',
      record,
      family: null,
      reason: 'past_grace_period',
      graceUntil: grace,
    };
  }

  return { decision: 'unknown', record, family: null, reason: 'unknown_status', graceUntil: null };
}

/**
 * 检测到复用攻击后, 吊销整族。
 * 返回被吊销的 token 数量。
 */
export async function handleReuseDetected(record: TokenRecord, now: number = Date.now()): Promise<number> {
  const result = await revokeFamily({
    familyId: record.familyId,
    reason: 'reuse_detected',
    now,
  });
  return result.revokedTokens;
}

/**
 * 批量: 对某个 kid 检查 + 自动吊销其 family (如果命中复用)。
 * 用于 evaluateRequest 主路径, 单次调用搞定。
 */
export interface ProcessTokenOptions {
  bearer: string;
  now?: number;
  /** 是否在命中 reuse_detected 时自动吊销整族, 默认 true */
  autoRevokeFamily?: boolean;
}

export interface ProcessTokenResult extends ReuseCheckResult {
  autoRevokedTokens: number;
}

export async function processBearerToken(opts: ProcessTokenOptions): Promise<ProcessTokenResult> {
  const now = opts.now ?? Date.now();
  const result = await checkReuse(opts.bearer, now);

  if (result.decision !== 'reuse_detected' || !result.record) {
    return { ...result, autoRevokedTokens: 0 };
  }
  if (opts.autoRevokeFamily === false) {
    return { ...result, autoRevokedTokens: 0 };
  }
  const autoRevoked = await handleReuseDetected(result.record, now);
  return { ...result, autoRevokedTokens: autoRevoked };
}

export { DEFAULT_GRACE_PERIOD_MS, findByKid, findByToken };
