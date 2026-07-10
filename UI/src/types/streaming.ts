/**
 * SoloForge 流送区核心类型定义
 * 覆盖任务状态机、子任务、步骤记录、审查、子Agent、PromptCard 等完整类型体系
 */

// ==================== 对话模型配置 ====================

export interface ChatModelConfig {
  chatId: string;
  mainModel: string;
  secondaryModels: string[];
  modelCount: number; // 1 / 2 / 3+
  subAgents: SubAgent[];
}

// ==================== 任务阶段 ====================

export type TaskPhase =
  | 'CLARIFY'       // 追问用户
  | 'PLANNING'      // AI社会评判/规划
  | 'DECOMPOSING'   // 任务分层拆解中
  | 'DISPATCHING'   // 子任务分配中
  | 'EXECUTING'     // 子任务执行中
  | 'REVIEWING'     // 裁判审查中
  | 'AUDITING'      // 审计检查中 (phaseMappers 已推送, 之前缺失)
  | 'DELIVERING'    // 交付结果中
  | 'SINGLE_MODEL'  // 单模型直跑模式 (跳过拆解/分发/审查)
  | 'DONE'          // 完成
  | 'ERROR';        // 出错

// 合法跃迁表
// 设计原则:
//   1. 允许跳过中间阶段(单模型任务不需要 PLANNING / DISPATCHING)
//   2. 同阶段事件是幂等的(允许重复 phase_change 保持当前阶段)
//   3. DONE 是终态只能保留不变
//   4. 任意运行中阶段 (除 DONE) 都可跃迁到 ERROR —
//      错误恢复路径统一由 ERROR 状态机处理, 不允许在某个阶段被卡死无法上报失败
//   5. SINGLE_MODEL 是单模型直跑分支: 进入后直入 EXECUTING → DELIVERING → DONE
//      (SINGLE_MODEL 本身不是终态, 它只是"工作模式"标记, 后端会接着推 worker 进度)
export const PHASE_TRANSITIONS: Record<TaskPhase, TaskPhase[]> = {
  CLARIFY:       ['PLANNING', 'DECOMPOSING', 'SINGLE_MODEL', 'EXECUTING', 'CLARIFY', 'ERROR'],
  PLANNING:      ['DECOMPOSING', 'EXECUTING', 'PLANNING', 'ERROR'],
  DECOMPOSING:   ['DISPATCHING', 'EXECUTING', 'DECOMPOSING', 'ERROR'],
  DISPATCHING:   ['EXECUTING', 'REVIEWING', 'AUDITING', 'DISPATCHING', 'ERROR'],
  EXECUTING:     ['REVIEWING', 'AUDITING', 'EXECUTING', 'ERROR'],
  REVIEWING:     ['DELIVERING', 'AUDITING', 'EXECUTING', 'REVIEWING', 'ERROR'],
  AUDITING:      ['DELIVERING', 'REVIEWING', 'EXECUTING', 'AUDITING', 'ERROR'],
  DELIVERING:    ['DONE', 'DELIVERING', 'ERROR'],
  SINGLE_MODEL:  ['EXECUTING', 'DELIVERING', 'DONE', 'SINGLE_MODEL', 'ERROR'],
  DONE:          [],
  ERROR:         ['CLARIFY', 'PLANNING', 'DECOMPOSING', 'DISPATCHING', 'REVIEWING', 'AUDITING', 'DELIVERING'],
};

// ==================== 子任务步骤 ====================

export type SubTaskStep =
  | 'READ_TASK'       // 正在阅读任务
  | 'UNDERSTAND'      // 理解任务
  | 'DECIDE'          // 进行决定
  | 'EXECUTE'         // 开始任务
  | 'COMPLETE'        // 任务完成
  | 'SUBMIT_TO_JUDGE'; // 提交到裁判

export const STEP_PROGRESS: Record<SubTaskStep, [number, number]> = {
  READ_TASK:       [0, 15],
  UNDERSTAND:      [15, 30],
  DECIDE:          [30, 40],
  EXECUTE:         [40, 90],
  COMPLETE:        [90, 100],
  SUBMIT_TO_JUDGE: [100, 100],
};

// ==================== 子任务来源 ====================

export type SubTaskSource = 'llm' | 'browser-use' | 'tool' | 'skill';

// ==================== 根任务 ====================

export interface RootTask {
  id: string;
  chatId: string;
  userInput: string;
  phase: TaskPhase;
  progress: number; // 0-100
  subTasks: SubTask[];
  auditTask?: AuditTask;
  // R1.1 扩展
  deliverResult?: string;     // 最终交付内容 (delivery 事件写入)
  clarifyHistory?: string[];  // 用户追问历史 (clarify_response 写入)
  delegationLog?: string[];   // 模型委派日志 (model_delegation 写入)
  modelActionLog?: string[];  // 模型推理动作日志 (model_action 写入)
  createdAt: number;
  updatedAt: number;
}

// ==================== 子任务 ====================

export interface SubTask {
  id: string;
  rootTaskId: string;
  assigneeModel: string;    // 分配给哪个模型
  assigneeModelId: string;
  description: string;      // 子目标描述
  currentStep: SubTaskStep;
  progress: number;         // 0-100
  stepHistory: StepRecord[];
  source: SubTaskSource;
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
  result?: string;
  startedAt?: number;
  completedAt?: number;
  // browser-use 特有字段
  browserTaskId?: string;
  browserUrl?: string;
  screenshot_b64?: string;
  maxSteps?: number;
  currentStepIndex?: number;
  // 流式文本累积缓冲 — 已弃用, 改用 streamingStore.textBuffers (解耦缓冲)
  // 保留字段是为了类型兼容, 新代码应使用 useTextBuffer(subTaskId) 选择器
  textBuffer?: string;
}

// ==================== 步骤记录 ====================

export interface StepRecord {
  step: SubTaskStep;
  startedAt: number;
  completedAt?: number;
  progress: number;        // 此步骤完成时的总进度
  detail: string;          // 具体动作描述（可折叠）
  status: 'running' | 'done' | 'error';
}

// ==================== 审查任务 ====================

export interface AuditTask {
  id: string;
  rootTaskId: string;
  auditorType: 'sub_agent' | 'main_model';
  agentId?: string;
  status: 'pending' | 'reviewing' | 'done' | 'error';
  findings: AuditFinding[];
  progress: number;
}

export interface AuditFinding {
  severity: 'info' | 'warning' | 'error';
  target: string; // 指向哪个子任务
  suggestion: string;
}

/**
 * 混合裁决结果（子Agent 评分 → 主模型仲裁 → AI社会制度校验）
 * 类型从此处导出，原 state/arbitration.ts 的实现已删除（死代码）
 */
export interface ArbitrationResult {
  verdict: 'accept' | 'revise' | 'reject';
  finalScore: number;
  layerScores: {
    subAgent: number;
    mainModel: number;
    society: number;
  };
  findings: AuditFinding[];
  reasoning: string;
}

// ==================== 子Agent ====================

export interface SubAgent {
  id: string;
  chatId: string;
  role: 'auditor' | 'assistant';
  parentModelId: string;
  reputation: number;
  createdAt: number;
  lastActiveAt: number;
}

// ==================== 流送事件 ====================

export type StreamEventKind =
  | 'task_created'
  | 'phase_change'
  | 'subtask_created'
  | 'subtask_step'
  | 'subtask_progress'
  | 'subtask_done'
  | 'model_delegation'
  | 'model_action'
  | 'audit_start'
  | 'audit_finding'
  | 'audit_done'
  | 'clarify_request'
  | 'clarify_response'
  | 'delivery'
  | 'agent_created'
  | 'agent_dissolved'
  | 'browser_task_start'
  | 'browser_task_step'
  | 'browser_task_screenshot'
  | 'browser_task_done'
  | 'browser_task_error'
  | 'browser_task_cancelled'
  | 'browser_enable_request'
  | 'tool_suggestion'
  | 'tool_enabled'
  | 'tool_skipped'
  | 'tool_timeout'
  | 'text_chunk'
  | 'error';

export interface StreamEvent {
  id: string;
  chatId: string;
  rootTaskId: string;
  subTaskId?: string;
  agentId?: string;
  kind: StreamEventKind;
  content: string;
  detail?: string;
  progress?: number;
  ts: number;
  status: 'running' | 'success' | 'error';
}

// ==================== PromptCard 通用交互模块 ====================

export type PromptCardType =
  | 'clarification'
  | 'tool_suggestion'
  | 'skill_suggestion'
  | 'knowledge_suggestion'
  | 'model_suggestion'
  | 'permission_confirm'
  | 'browser_tool_enable'
  | 'custom';

export interface PromptCardSpec {
  id: string;
  type: PromptCardType;
  title: string;
  message: string;
  countdown: number;           // 倒计时秒数
  options: PromptOption[];
  defaultAction: PromptAction;
  context?: Record<string, any>;
  priority: 'blocking' | 'non_blocking';
  cooldown?: number;           // 冷却秒数（同 group 不重复弹）
  groupKey?: string;           // 分组 key（同 group 共享决策）
}

export interface PromptOption {
  id: string;
  label: string;
  action: PromptAction;
  isRecommended?: boolean;
}

export interface PromptAction {
  kind: 'accept' | 'decline' | 'skip' | 'always' | 'custom';
  payload?: Record<string, any>;
}

export interface PromptCardInstance {
  spec: PromptCardSpec;
  status: 'active' | 'expired' | 'resolved' | 'dismissed';
  remaining: number;
  createdAt: number;
  resolvedAt?: number;
  resolveAction?: PromptAction;
  autoResolved?: boolean; // 全自动模式标记
}

// ==================== 权限模式 ====================

export type PermissionMode = 'normal' | 'performance' | 'ultimate' | 'expert';

// ==================== 工具帮助函数 ====================

export function stepProgress(step: SubTaskStep, stepInternal: number): number {
  const [lo, hi] = STEP_PROGRESS[step];
  return Math.round(lo + (hi - lo) * (stepInternal / 100));
}

export function calcRootProgress(rootTask: RootTask): number {
  if (rootTask.subTasks.length === 0) return 0;
  const weights = rootTask.subTasks.map(s => {
    const lenWeight = Math.min(s.description.length / 50, 3);
    return Math.max(lenWeight, 1);
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const weighted = rootTask.subTasks.reduce((sum, s, i) => {
    return sum + (s.progress / 100) * weights[i];
  }, 0);
  return Math.round((weighted / totalWeight) * 100);
}

export function transitionPhase(current: TaskPhase, next: TaskPhase): TaskPhase | null {
  if (PHASE_TRANSITIONS[current].includes(next)) return next;
  return null;
}