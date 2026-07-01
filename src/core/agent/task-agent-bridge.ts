// ─────────────────────────────────────────────────────────────────
// SoloForge Agent Core: Task Agent Bridge — LLM ↔ Agent 调用桥接
// Path: src/core/agent/task-agent-bridge.ts
//
// 职责: 将 LLM 的高层任务分解为 Agent 可执行的子任务,
//       通过 RACER 选路分配给最合适的 Agent,
//       聚合结果返回给 LLM
// ─────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import { AgentRegistry, AgentDispatchResult } from './agent-registry';
import { AgentDecisionOrchestrator } from './agent-decision-orchestrator';
import { logger } from '../logger';

/**
 * LLM 下发的任务描述
 */
export interface LLMAgentTask {
  /** 任务 ID */
  taskId: string;
  /** 任务类型 (LLM 根据用户请求判断) */
  taskType: 'code_generation' | 'code_review' | 'architecture' | 'testing' | 'documentation' | 'debugging';
  /** 任务描述 (自然语言) */
  description: string;
  /** 复杂度 (0-1, LLM 评估) */
  complexity: number;
  /** 是否需要深度推理 */
  requiresDeepCognition: boolean;
  /** 上下文信息 (代码片段、文件路径等) */
  context?: Record<string, any>;
}

/**
 * Agent 执行结果
 */
export interface LLMAgentResult {
  taskId: string;
  agentId: string;
  strategy: string;
  output: string;
  confidence: number;
  durationMs: number;
}

/**
 * Task Agent Bridge — 让 LLM 可以调用 Agent 系统
 *
 * 使用方式:
 *   const bridge = new TaskAgentBridge(registry, orchestrator);
 *   const result = await bridge.executeTask({
 *     taskId: 'task_001',
 *     taskType: 'code_generation',
 *     description: '生成一个 React Todo 组件',
 *     complexity: 0.6,
 *     requiresDeepCognition: false,
 *     context: { framework: 'react', language: 'typescript' }
 *   });
 */
export class TaskAgentBridge {
  private readonly moduleName = 'TaskAgentBridge';

  constructor(
    private readonly registry: AgentRegistry,
    private readonly orchestrator: AgentDecisionOrchestrator
  ) {}

  /**
   * LLM 调用入口: 执行一个高层任务
   *
   * 流程:
   * 1. 根据任务类型和复杂度选择策略偏好
   * 2. 通过 RACER 选路找到最优 Agent
   * 3. Agent 执行任务 (实际场景中会调用 LLM 生成内容)
   * 4. 返回结果给调用方
   */
  async executeTask(task: LLMAgentTask): Promise<LLMAgentResult> {
    const start = Date.now();

    logger.info(this.moduleName, `LLM task received: [${task.taskType}] ${task.description.slice(0, 60)}...`);

    // 1. 根据任务类型调整 CPU 负载模拟 (影响 RACER 选路)
    const simulatedCpuLoad = this.estimateCpuLoad(task);
    this.registry.setCpuLoad(simulatedCpuLoad);

    // 2. 通过 Orchestrator 派发任务
    const dispatchResult: AgentDispatchResult = await this.orchestrator.dispatchPacket({
      packetUuid: `llm_${task.taskId}`,
      packetSizeKb: Math.ceil(task.description.length / 100), // 描述长度映射为数据包大小
      requiresDeepCognition: task.requiresDeepCognition,
      globalConfidenceMetric: 1.0 - task.complexity, // 复杂度越高，置信度越低
      taskComplexityMetrics: task.complexity,
    });

    // 3. 获取执行 Agent 的详细信息
    const agent = this.registry.getAgent(dispatchResult.winnerAgentId);
    const agentName = agent?.agentId ?? dispatchResult.winnerAgentId;

    logger.info(this.moduleName,
      `Task [${task.taskType}] → Agent [${agentName}] (${dispatchResult.strategy}) ` +
      `score=${dispatchResult.score.toFixed(3)}`
    );

    // 4. 构造返回结果
    // 实际场景中，这里会:
    //   - 将 task.description + context 发送给对应策略的 LLM
    //   - Agent 的策略决定使用哪个 LLM (fast/detailed/balanced)
    //   - 收集 LLM 输出作为 result
    const result: LLMAgentResult = {
      taskId: task.taskId,
      agentId: agentName,
      strategy: dispatchResult.strategy,
      output: dispatchResult.output, // 当前是 HMAC 签名，实际场景中是 LLM 生成的内容
      confidence: dispatchResult.score,
      durationMs: Date.now() - start,
    };

    return result;
  }

  /**
   * 批量执行多个任务 (并行)
   */
  async executeTaskBatch(tasks: LLMAgentTask[]): Promise<LLMAgentResult[]> {
    return Promise.all(tasks.map(task => this.executeTask(task)));
  }

  /**
   * 获取当前 Agent 池状态 (供 LLM 决策参考)
   */
  getAgentPoolStatus(): Array<{
    agentId: string;
    strategy: string;
    reputation: number;
    available: boolean;
  }> {
    return this.registry.snapshot().map(s => ({
      agentId: s.agentId,
      strategy: s.strategyType,
      reputation: s.reputationScore,
      available: s.reputationScore > 0.3, // 信誉太低的不可用
    }));
  }

  /**
   * 根据任务类型估算 CPU 负载 (影响 RACER 选路偏好)
   */
  private estimateCpuLoad(task: LLMAgentTask): number {
    // 复杂任务 → 高 CPU 负载 → RACER 偏好高质量策略
    // 简单任务 → 低 CPU 负载 → RACER 偏好快速策略
    const baseLoad = task.complexity * 0.5;

    switch (task.taskType) {
      case 'architecture':
      case 'code_review':
        return Math.min(1.0, baseLoad + 0.3); // 偏向高质量
      case 'code_generation':
      case 'debugging':
        return baseLoad; // 平衡
      case 'testing':
      case 'documentation':
        return Math.max(0.1, baseLoad - 0.2); // 偏向快速
      default:
        return 0.3;
    }
  }
}
