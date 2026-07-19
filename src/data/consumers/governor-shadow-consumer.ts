// ─────────────────────────────────────────────────────────────────
// SoloForge Data Layer: Governor Shadow Consumer
// Path: src/data/consumers/governor-shadow-consumer.ts
//
// 功能：消费 RuntimeEvent.TransactionCommitted 事件，冷沉淀 PPO 决策到 SurrealDB
// 模式：异步非阻塞，绝不反向挂起内核主时钟链路
// ─────────────────────────────────────────────────────────────────

import { RuntimeKernel } from '../../kernel/runtime-kernel';
import { RuntimeEvent } from '../../core/events/runtime-events';
import { SurrealPersistence } from '../surreal_persistence';
import { logger } from '../../core/logger';

/**
 * 🧱 统一落库飞轮基础设施：处于控制宇宙最外围（Infrastructure 事实层）
 * 专职负责将原子事务提交流事件异步、非阻塞地冷沉淀至主项目温表，
 * 完全隔离高频遥测对内核控制热路径的冲击
 *
 * ⚠️ 宪法红线：此库操作专属主项目 SurrealDB 温数据层，
 *            绝不触碰 AI 社会的 LanceDB/SQLite 文档/向量层
 */
export function initializeGovernorShadowConsumer(kernel: RuntimeKernel): void {
  if (!kernel || !kernel.eventBus) {
    logger.error('GovernorShadowConsumer', '❌ 内核或事件总线未就绪，跳过消费者初始化');
    return;
  }

  logger.info('GovernorShadowConsumer', '🚀 初始化治理影子消费者，订阅 TransactionCommitted 事件');

  // 🔒 全量订阅 RuntimeEvent.TransactionCommitted 标准原子提交流事实通知
  kernel.eventBus.on(RuntimeEvent.TransactionCommitted, async (txPayload: any) => {
    // 仅处理 AIRuntime 域的事务
    if (!txPayload || txPayload.domain !== 'AIRuntime') {
      return;
    }

    // 采用立即执行函数（IIFE）切断 Promise 链，
    // 在后台异步平摊落库压力，绝对不反向挂起内核主时钟链路
    (async () => {
      try {
        const { data, version, txId } = txPayload;

        if (!data || !data.ppo_action) {
          logger.debug('GovernorShadowConsumer', '跳过无效载荷');
          return;
        }

        // 🧱 持久化 PPO 决策到 SurrealDB governor_shadow_decision 表
        const surrealPersistence = new SurrealPersistence();

        await surrealPersistence.commitShadowDecision({
          id: `shadow_${txId}_${Date.now()}`,
          traceId: data.traceId || '',
          telemetrySnapshot: data.telemetry_snapshot,
          ruleAction: 0, // Rule 决策（暂未实现）
          ruleActionName: 'rule_fallback',
          ppoAction: data.ppo_action === 'no_op' ? 0 :
                     data.ppo_action === 'spawn_agent' ? 1 :
                     data.ppo_action === 'pause_background' ? 2 :
                     data.ppo_action === 'switch_small_model' ? 3 :
                     data.ppo_action === 'reduce_context' ? 4 :
                     data.ppo_action === 'enable_gc' ? 5 : 0,
          ppoActionName: data.ppo_action || 'no_op',
          ppoProb: data.probability || 0.0,
          ppoValue: data.value,
          winner: 'ppo',
          confidence: data.confidence || 1.0,
          version: version || 0,
          timestamp: data.committed_at || Date.now()
        });

        logger.debug('GovernorShadowConsumer', `✅ 冷沉淀 PPO 决策: ${data.ppo_action} (prob: ${data.probability})`);

      } catch (dbErr: any) {
        logger.error('GovernorShadowConsumer', '💥 异步流冷沉淀写入主温状态宇宙遭受 I/O 阻断，指标抛弃自愈处理', {
          error: dbErr.message,
          traceId: txPayload?.data?.traceId
        });
      }
    })();
  });

  logger.info('GovernorShadowConsumer', '✅ 治理影子消费者初始化完成');
}

/**
 * 直接查询影子决策记录
 */
export async function queryGovernorShadowDecisions(
  surrealPersistence: SurrealPersistence,
  traceId: string
): Promise<any[]> {
  return surrealPersistence.queryShadowDecisions(traceId);
}

export default initializeGovernorShadowConsumer;
