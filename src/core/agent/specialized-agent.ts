/**
 * specialized-agent.ts — 真正的专业化 Agent
 *
 * 与旧 AutonomousNetworkAgent 的区别:
 *   - 旧: 数据包执行者，策略硬编码，无工具
 *   - 新: 有真实技能的专业专家，能调用工具，能自我进化
 *
 * 每个 Agent:
 *   1. 有专属的角色定义和 System Prompt
 *   2. 有执行策略（Precision/Creative/FastIterate/DeepAnalysis）
 *   3. 有技能库（从历史任务中学习的经验）
 *   4. 能调用工具（读写文件、执行命令、搜索代码）
 *   5. 能自我进化（从执行结果中提炼经验）
 */

import { runAgentLoop, type AgentLoopResult, type AgentExecutionContext } from './tools/agent-loop';
import { AutoTrainingTrigger, type ExecutionTrace } from './evolution/auto-training-trigger';
import { TrainingScheduler } from './evolution/training-scheduler';

// ─── 专业领域 ──────────────────────────────────────────────────────

export type AgentDomain =
  | 'code-dev'
  | 'code-audit'
  | 'ui-design'
  | 'backend'
  | 'database'
  | 'security'
  | 'testing'
  | 'devops'
  | 'ai-ml'
  | 'math-algorithm'
  | 'documentation'
  | 'performance';

export type AgentLevel = 'junior' | 'senior' | 'expert' | 'master';

export type ExecutionStrategy = 'precision' | 'creative' | 'fast-iterate' | 'deep-analysis';

// ─── Agent 配置 ────────────────────────────────────────────────────

export interface SpecializedAgentConfig {
  agentId: string;
  domain: AgentDomain;
  level: AgentLevel;
  role: string;
  capabilities: string[];
  defaultStrategy: ExecutionStrategy;
  systemPrompt: string;
}

// ─── Agent 任务 ────────────────────────────────────────────────────

export interface AgentTask {
  taskId: string;
  description: string;
  context?: Record<string, any>;
  strategy?: ExecutionStrategy;
  maxRounds?: number;
  model?: string;
  /**
   * 可选: 流送区事件注入 (与 AgentExecutionContext.streamHook 同构)
   */
  streamHook?: AgentExecutionContext['streamHook'];
  /**
   * 可选: LLM provider 覆盖 (前端传入的 apiKey + baseUrl + model)
   * 不传时 agent-loop 使用环境变量中的配置
   */
  llmConfig?: { baseUrl: string; apiKey: string; model: string };
  /** 工作区文件夹路径 (用于 AI 作用域限制) */
  workspaceFolder?: string;
  /** 前端选中的工具 ID 列表 (控制 LLM 可用的 tools) */
  activeTools?: string[];
  /** 前端选中的技能 ID 列表 */
  activeSkills?: string[];
  /** 前端选中的知识库 ID 列表 */
  activeKnowledge?: string[];
}

// ─── Agent 任务结果 ────────────────────────────────────────────────

export interface AgentTaskResult {
  taskId: string;
  agentId: string;
  success: boolean;
  answer: string;
  toolCallCount: number;
  durationMs: number;
  usedTools: boolean;
  toolSteps: AgentLoopResult['toolSteps'];
  /** 从这次任务中学到了什么（用于自进化） */
  learnedExperience?: string;
}

// ─── SpecializedAgent 类 ──────────────────────────────────────────

export class SpecializedAgent {
  public readonly config: SpecializedAgentConfig;
  public readonly trigger: AutoTrainingTrigger;
  private readonly skillLibrary: string[] = [];
  private taskCount = 0;
  private successCount = 0;

  constructor(config: SpecializedAgentConfig) {
    this.config = config;
    // 每个 Agent 创建时自动注册训练触发器
    this.trigger = TrainingScheduler.getInstance().registerAgent(config.agentId, config.domain);
  }

  /**
   * 执行一个任务
   *
   * 这是 Agent 的核心方法:
   *   1. 构建执行上下文（角色 + 技能 + 策略参数）
   *   2. 调用 Agent Loop（LLM + 工具循环）
   *   3. 分析结果，提炼经验
   *   4. 返回结果
   */
  async executeTask(task: AgentTask): Promise<AgentTaskResult> {
    this.taskCount++;
    const start = Date.now();

    // 构建执行上下文
    const ctx: AgentExecutionContext = {
      agentId: this.config.agentId,
      domain: this.config.domain,
      role: this.config.role,
      systemPrompt: this.buildSystemPrompt(task),
      skills: this.skillLibrary.slice(-10),
      maxRounds: task.maxRounds ?? this.getDefaultMaxRounds(),
      model: task.model,
      temperature: this.getTemperature(task.strategy ?? this.config.defaultStrategy),
      maxTokens: this.getMaxTokens(task.strategy ?? this.config.defaultStrategy),
      streamHook: task.streamHook,
      llmConfig: task.llmConfig,
      workspaceFolder: task.workspaceFolder,
      activeTools: task.activeTools,
      activeSkills: task.activeSkills,
      activeKnowledge: task.activeKnowledge,
    };

    // 执行 Agent Loop
    const result = await runAgentLoop(ctx, task.description);

    // 分析结果
    const success = result.finalAnswer.length > 50 && !result.finalAnswer.toLowerCase().includes('error');
    if (success) this.successCount++;

    // 提炼经验（自进化）
    const experience = this.extractExperience(task, result);
    if (experience) {
      this.skillLibrary.push(experience);
      // 限制技能库大小
      if (this.skillLibrary.length > 100) {
        this.skillLibrary.shift();
      }
    }

    const taskResult: AgentTaskResult = {
      taskId: task.taskId,
      agentId: this.config.agentId,
      success,
      answer: result.finalAnswer,
      toolCallCount: result.toolCallCount,
      durationMs: Date.now() - start,
      usedTools: result.usedTools,
      toolSteps: result.toolSteps,
      learnedExperience: experience,
    };

    // 自动记录轨迹到训练触发器
    this.recordTrace(task, taskResult);

    return taskResult;
  }

  /**
   * 记录执行轨迹到训练触发器
   * 每次任务执行后自动调用
   */
  recordTrace(task: AgentTask, result: AgentTaskResult): void {
    const toolsUsed = result.toolSteps.map(s => s.tool);
    const strategyUsed = task.strategy ?? this.config.defaultStrategy;
    const maxRounds = task.maxRounds ?? this.getDefaultMaxRounds();

    // 计算奖励 (与 agent_env.py 对齐)
    let reward = 0;
    for (const tool of toolsUsed) {
      if (['read_file', 'write_file', 'list_files'].includes(tool)) {
        reward += 0.3;
      } else if (['search_code', 'execute_cmd'].includes(tool)) {
        reward += 0.2;
      }
    }
    if (result.success) reward += 2.0;
    reward += (1.0 - result.durationMs / (maxRounds * 30000)) * 0.5;

    this.trigger.recordTrace({
      agentId: this.config.agentId,
      taskId: task.taskId,
      timestamp: Date.now(),
      observation: {
        taskComplexity: task.context?.complexity ?? 0.5,
        taskDomainMatch: 1.0,
        taskCodeLines: (task.context?.estimatedLines ?? 100) / 1000,
        taskRequiresTools: 0.8,
        agentSkillCount: this.skillLibrary.length / 100,
        agentSuccessRate: this.taskCount > 0 ? this.successCount / this.taskCount : 0.5,
        agentCurrentRound: 0,
        agentToolErrorRate: result.toolSteps.filter(s => !s.success).length / Math.max(1, result.toolSteps.length),
        contextHasExistingCode: task.context?.hasExistingCode ? 1.0 : 0.0,
        contextFileCount: (task.context?.fileCount ?? 0) / 100,
      },
      toolsUsed,
      strategyUsed,
      success: result.success,
      durationMs: result.durationMs,
      toolCallCount: result.toolCallCount,
      reward,
    });
  }

  /**
   * 从用户反馈中学习
   */
  learnFromFeedback(feedback: { taskId: string; rating: number; comment?: string }): void {
    if (feedback.rating >= 4 && feedback.comment) {
      this.skillLibrary.push(`[反馈] ${feedback.comment}`);
    }
  }

  /**
   * 获取 Agent 状态
   */
  getStatus(): {
    agentId: string;
    domain: AgentDomain;
    level: AgentLevel;
    taskCount: number;
    successRate: number;
    skillCount: number;
  } {
    return {
      agentId: this.config.agentId,
      domain: this.config.domain,
      level: this.config.level,
      taskCount: this.taskCount,
      successRate: this.taskCount > 0 ? this.successCount / this.taskCount : 0,
      skillCount: this.skillLibrary.length,
    };
  }

  // ─── 私有方法 ──────────────────────────────────────────────────

  private buildSystemPrompt(task: AgentTask): string {
    const parts: string[] = [];

    // 角色定义
    parts.push(this.config.systemPrompt);

    // 能力说明
    parts.push(`你的专业能力包括：${this.config.capabilities.join('、')}`);

    // 任务上下文
    if (task.context) {
      parts.push(`\n## 任务上下文\n${JSON.stringify(task.context, null, 2)}`);
    }

    // 行为规则
    parts.push(`
## 行为规则

1. 你是一个能使用工具的真实 Agent，不是文本生成器
2. 不要猜测文件内容，用 read_file 或 search_code 查看
3. 生成代码后，用 execute_cmd 运行验证
4. 遇到错误时，分析原因并修复
5. 完成后给出清晰的总结`);

    return parts.join('\n\n');
  }

  private getDefaultMaxRounds(): number {
    switch (this.config.level) {
      case 'master': return 15;
      case 'expert': return 10;
      case 'senior': return 8;
      case 'junior': return 5;
    }
  }

  private getTemperature(strategy: ExecutionStrategy): number {
    switch (strategy) {
      case 'precision': return 0.1;
      case 'creative': return 0.7;
      case 'fast-iterate': return 0.3;
      case 'deep-analysis': return 0.2;
    }
  }

  private getMaxTokens(strategy: ExecutionStrategy): number {
    switch (strategy) {
      case 'precision': return 4096;
      case 'creative': return 8192;
      case 'fast-iterate': return 2048;
      case 'deep-analysis': return 8192;
    }
  }

  private extractExperience(task: AgentTask, result: AgentLoopResult): string | undefined {
    if (!result.usedTools || result.toolSteps.length === 0) return undefined;

    const successfulTools = result.toolSteps.filter(s => s.success);
    if (successfulTools.length === 0) return undefined;

    return `[${this.config.domain}] ${task.description.slice(0, 60)} → 使用了 ${successfulTools.map(s => s.tool).join(', ')}`;
  }
}
