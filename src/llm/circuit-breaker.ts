/**
 * circuit-breaker.ts — LLM Provider 熔断器
 *
 * 移植自 Java Agent 的 LlmCommandCenter 熔断器逻辑。
 * 当某个 LLM provider 连续失败 (429/503/5xx) 达到阈值时,
 * 熔断器 OPEN — 短路所有后续请求,避免级联失败。
 * 冷却期后进入 HALF_OPEN — 放一个探测请求通过,
 * 成功则 CLOSED 恢复正常,失败则重新 OPEN。
 *
 * 状态机:
 *   CLOSED  ──(N 次连续 429/5xx)──►  OPEN
 *   OPEN    ──(冷却 30s 后)──────►  HALF_OPEN
 *   HALF_OPEN ──(探测成功)────────►  CLOSED
 *   HALF_OPEN ──(探测失败)────────►  OPEN
 *
 * 使用方式:
 *   import { llmCircuitBreaker } from '../llm/circuit-breaker';
 *
 *   // 调用前检查
 *   const decision = llmCircuitBreaker.evaluate(providerKey);
 *   if (decision.action === 'reject') {
 *     throw new Error(`LLM provider ${providerKey} circuit open: ${decision.reason}`);
 *   }
 *   if (decision.action === 'wait') {
 *     await sleep(decision.waitMs);
 *   }
 *
 *   // 调用后记录结果
 *   llmCircuitBreaker.recordSuccess(providerKey, latencyMs);
 *   llmCircuitBreaker.recordFailure(providerKey, statusCode);
 */

import { logger } from '../core/logger';

// ─── 类型定义 ───────────────────────────────────────────────────────

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitDecision {
  action: 'proceed' | 'wait' | 'reject';
  waitMs?: number;
  reason?: string;
  state: CircuitState;
}

interface ProviderCircuit {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number;       // OPEN 状态开始时间 (ms)
  lastSuccessAt: number;  // 最后一次成功时间 (ms)
  totalRequests: number;
  totalFailures: number;
}

// ─── 配置常量 ───────────────────────────────────────────────────────

const FAILURE_THRESHOLD = 5;        // 连续 5 次失败触发熔断
const COOLDOWN_MS = 30_000;         // OPEN → HALF_OPEN 冷却期 30s
const HALF_OPEN_TIMEOUT_MS = 60_000; // HALF_OPEN 超时回退到 OPEN

// ─── 熔断器实现 ─────────────────────────────────────────────────────

class LlmCircuitBreaker {
  private readonly circuits = new Map<string, ProviderCircuit>();
  private readonly moduleName = 'CircuitBreaker';

  /**
   * 评估是否允许请求通过
   */
  evaluate(providerKey: string): CircuitDecision {
    const circuit = this.getOrCreate(providerKey);

    switch (circuit.state) {
      case 'CLOSED':
        return { action: 'proceed', state: 'CLOSED' };

      case 'OPEN': {
        const elapsed = Date.now() - circuit.openedAt;
        if (elapsed >= COOLDOWN_MS) {
          // 冷却期已过 → 进入 HALF_OPEN, 放一个探测请求
          circuit.state = 'HALF_OPEN';
          logger.info(this.moduleName,
            `HALF_OPEN: provider=${providerKey} (cooled down after ${elapsed}ms)`);
          return { action: 'proceed', state: 'HALF_OPEN' };
        }
        const waitMs = COOLDOWN_MS - elapsed;
        return {
          action: 'reject',
          state: 'OPEN',
          reason: `circuit OPEN (cooldown ${Math.ceil(waitMs / 1000)}s remaining)`,
        };
      }

      case 'HALF_OPEN': {
        // HALF_OPEN 只允许一个探测请求, 如果超时则回退
        const elapsed = Date.now() - circuit.openedAt;
        if (elapsed > HALF_OPEN_TIMEOUT_MS) {
          circuit.state = 'OPEN';
          circuit.openedAt = Date.now();
          logger.warn(this.moduleName,
            `HALF_OPEN timeout → OPEN: provider=${providerKey}`);
          return {
            action: 'reject',
            state: 'OPEN',
            reason: 'half-open probe timeout',
          };
        }
        return { action: 'proceed', state: 'HALF_OPEN' };
      }

      default:
        return { action: 'proceed', state: 'CLOSED' };
    }
  }

  /**
   * 记录请求成功
   */
  recordSuccess(providerKey: string, _latencyMs: number): void {
    const circuit = this.getOrCreate(providerKey);
    circuit.consecutiveFailures = 0;
    circuit.lastSuccessAt = Date.now();
    circuit.totalRequests++;

    if (circuit.state === 'HALF_OPEN') {
      circuit.state = 'CLOSED';
      logger.info(this.moduleName,
        `CLOSED (recovered): provider=${providerKey}`);
    }
  }

  /**
   * 记录请求失败
   * @param statusCode HTTP 状态码 (429, 503, 500, 0=网络错误)
   */
  recordFailure(providerKey: string, statusCode: number): void {
    const circuit = this.getOrCreate(providerKey);
    circuit.totalRequests++;
    circuit.totalFailures++;

    // 只对 429/503/5xx/网络错误 计入熔断 (4xx 其他不算)
    const isCircuitBreakerError =
      statusCode === 429 ||
      statusCode === 503 ||
      (statusCode >= 500 && statusCode < 600) ||
      statusCode === 0;

    if (!isCircuitBreakerError) return;

    circuit.consecutiveFailures++;

    if (circuit.state === 'HALF_OPEN') {
      // 探测失败 → 重新 OPEN
      circuit.state = 'OPEN';
      circuit.openedAt = Date.now();
      logger.warn(this.moduleName,
        `HALF_OPEN probe failed (${statusCode}) → OPEN: provider=${providerKey}`);
      return;
    }

    if (circuit.consecutiveFailures >= FAILURE_THRESHOLD && circuit.state === 'CLOSED') {
      circuit.state = 'OPEN';
      circuit.openedAt = Date.now();
      logger.error(this.moduleName,
        `CIRCUIT OPEN: provider=${providerKey} (${circuit.consecutiveFailures} consecutive failures, last=${statusCode})`);
    }
  }

  /**
   * 获取 provider 的熔断器状态 (用于监控/诊断)
   */
  getStatus(providerKey: string): { state: CircuitState; consecutiveFailures: number; totalRequests: number; totalFailures: number } | null {
    const circuit = this.circuits.get(providerKey);
    if (!circuit) return null;
    return {
      state: circuit.state,
      consecutiveFailures: circuit.consecutiveFailures,
      totalRequests: circuit.totalRequests,
      totalFailures: circuit.totalFailures,
    };
  }

  /**
   * 获取所有 provider 的熔断器状态
   */
  getAllStatuses(): Array<{ providerKey: string; state: CircuitState; consecutiveFailures: number }> {
    const result: Array<{ providerKey: string; state: CircuitState; consecutiveFailures: number }> = [];
    for (const [key, circuit] of this.circuits) {
      result.push({
        providerKey: key,
        state: circuit.state,
        consecutiveFailures: circuit.consecutiveFailures,
      });
    }
    return result;
  }

  /**
   * 生成 provider key (与 function-calling-client 的 baseUrl|model 格式一致)
   */
  static providerKey(baseUrl: string, model: string): string {
    return `${baseUrl}|${model}`;
  }

  /**
   * 从错误对象中提取 HTTP 状态码
   */
  static extractStatusCode(error: unknown): number {
    if (error instanceof Error) {
      const msg = error.message;
      // 匹配 "LLM HTTP 429" 格式
      const match = msg.match(/HTTP\s+(\d+)/);
      if (match) return parseInt(match[1], 10);
      // 网络错误 (fetch failed, ECONNRESET 等)
      if (msg.includes('fetch') || msg.includes('ECONNRESET') || msg.includes('network')) {
        return 0;
      }
    }
    return 0;
  }

  private getOrCreate(providerKey: string): ProviderCircuit {
    let circuit = this.circuits.get(providerKey);
    if (!circuit) {
      circuit = {
        state: 'CLOSED',
        consecutiveFailures: 0,
        openedAt: 0,
        lastSuccessAt: 0,
        totalRequests: 0,
        totalFailures: 0,
      };
      this.circuits.set(providerKey, circuit);
    }
    return circuit;
  }
}

// ─── 单例导出 ───────────────────────────────────────────────────────

export const llmCircuitBreaker = new LlmCircuitBreaker();

// ─── 独立工具函数 ───────────────────────────────────────────────────

/**
 * 生成 provider key (baseUrl|model 格式)
 */
export function circuitProviderKey(baseUrl: string, model: string): string {
  return `${baseUrl}|${model}`;
}

/**
 * 从错误对象中提取 HTTP 状态码
 */
export function extractStatusCode(error: unknown): number {
  if (error instanceof Error) {
    const msg = error.message;
    // 匹配 "LLM HTTP 429" 格式
    const match = msg.match(/HTTP\s+(\d+)/);
    if (match) return parseInt(match[1], 10);
    // 网络错误 (fetch failed, ECONNRESET 等)
    if (msg.includes('fetch') || msg.includes('ECONNRESET') || msg.includes('network')) {
      return 0;
    }
  }
  return 0;
}
