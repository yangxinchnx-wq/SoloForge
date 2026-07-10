/**
 * UIMessage / ModelMessage 分离类型体系
 *
 * 设计参考: Vercel AI SDK 5 UIMessage 模式
 *   - ModelMessage: 与 LLM API 通信的消息格式 (role + content string)
 *   - UIMessage: UI 渲染用的消息格式 (id + parts[]), 每个 part 有明确类型
 *
 * 核心价值:
 *   1. 模型协议变更不影响 UI 组件 (UI 只消费 UIMessage.Parts)
 *   2. UI 交互数据 (进度/审计/步骤) 不污染模型上下文 (只发 ModelMessage)
 *   3. 流式增量更新映射为 part 级别 append/update, 而非全量替换
 */

import type {
  TaskPhase,
  SubTaskStep,
  SubTaskSource,
  AuditFinding,
  PromptCardSpec,
} from './streaming';

// ==================== ModelMessage (模型通信层) ====================

export type ModelMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ModelMessage {
  role: ModelMessageRole;
  content: string;
  /** 工具调用时的 tool_call_id (role=tool 时必填) */
  toolCallId?: string;
  /** 工具调用名 (role=assistant 且有 tool_calls 时) */
  toolCalls?: ModelToolCall[];
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

// ==================== UIMessage Part 类型 ====================

export type UIPartType =
  | 'text'              // 文本内容 (流式累积)
  | 'task-summary'      // 任务摘要
  | 'phase-change'      // 阶段变更
  | 'subtask-created'   // 子任务创建
  | 'subtask-progress'  // 子任务进度
  | 'subtask-step'      // 子任务步骤
  | 'subtask-done'      // 子任务完成
  | 'model-delegation'  // 模型委派
  | 'model-action'      // 模型动作
  | 'audit-start'       // 审计开始
  | 'audit-finding'     // 审计发现
  | 'audit-done'        // 审计完成
  | 'delivery'          // 交付结果
  | 'clarify'           // 追问
  | 'prompt-card'       // 交互卡片
  | 'browser-step'      // 浏览器步骤
  | 'browser-screenshot'// 浏览器截图
  | 'error'             // 错误
  | 'metadata';         // 元数据

// ==================== UIMessage Part 联合类型 ====================

export interface UITextPart {
  type: 'text';
  text: string;
  /** 是否正在流式输出 */
  streaming?: boolean;
  /** P0: 关联的 subTaskId (text_chunk 事件携带, 用于 SubTaskNode 从 parts 派生文本) */
  subTaskId?: string;
}

export interface UITaskSummaryPart {
  type: 'task-summary';
  taskId: string;
  userInput: string;
  phase: TaskPhase;
  progress: number;
}

export interface UIPhaseChangePart {
  type: 'phase-change';
  from: TaskPhase;
  to: TaskPhase;
  detail?: string;
  timestamp: number;
}

export interface UISubTaskCreatedPart {
  type: 'subtask-created';
  subTaskId: string;
  assigneeModel: string;
  description: string;
  source: SubTaskSource;
}

export interface UISubTaskProgressPart {
  type: 'subtask-progress';
  subTaskId: string;
  progress: number;
  step?: SubTaskStep;
  detail?: string;
}

export interface UISubTaskStepPart {
  type: 'subtask-step';
  subTaskId: string;
  step: SubTaskStep;
  detail?: string;
  status: 'running' | 'done' | 'error';
}

export interface UISubTaskDonePart {
  type: 'subtask-done';
  subTaskId: string;
  result?: string;
  status: 'done' | 'error' | 'cancelled';
}

export interface UIModelDelegationPart {
  type: 'model-delegation';
  fromModel: string;
  toModel: string;
  detail?: string;
  timestamp: number;
}

export interface UIModelActionPart {
  type: 'model-action';
  action: string;
  detail?: string;
  subTaskId?: string;
  timestamp: number;
}

export interface UIAuditStartPart {
  type: 'audit-start';
  auditTaskId: string;
  auditorType: 'sub_agent' | 'main_model';
}

export interface UIAuditFindingPart {
  type: 'audit-finding';
  auditTaskId: string;
  finding: AuditFinding;
}

export interface UIAuditDonePart {
  type: 'audit-done';
  auditTaskId: string;
}

export interface UIDeliveryPart {
  type: 'delivery';
  result: string;
  timestamp: number;
}

export interface UIClarifyPart {
  type: 'clarify';
  question: string;
  response?: string;
  timestamp: number;
}

export interface UIPromptCardPart {
  type: 'prompt-card';
  spec: PromptCardSpec;
  status: 'active' | 'resolved' | 'expired' | 'dismissed';
  resolvedAction?: string;
}

export interface UIBrowserStepPart {
  type: 'browser-step';
  subTaskId: string;
  stepIndex: number;
  detail: string;
  progress?: number;
}

export interface UIBrowserScreenshotPart {
  type: 'browser-screenshot';
  subTaskId: string;
  screenshotB64: string;
}

export interface UIErrorPart {
  type: 'error';
  message: string;
  detail?: string;
  timestamp: number;
}

export interface UIMetadataPart {
  type: 'metadata';
  key: string;
  value: unknown;
}

export type UIPart =
  | UITextPart
  | UITaskSummaryPart
  | UIPhaseChangePart
  | UISubTaskCreatedPart
  | UISubTaskProgressPart
  | UISubTaskStepPart
  | UISubTaskDonePart
  | UIModelDelegationPart
  | UIModelActionPart
  | UIAuditStartPart
  | UIAuditFindingPart
  | UIAuditDonePart
  | UIDeliveryPart
  | UIClarifyPart
  | UIPromptCardPart
  | UIBrowserStepPart
  | UIBrowserScreenshotPart
  | UIErrorPart
  | UIMetadataPart;

// ==================== UIMessage (UI 渲染层) ====================

export interface UIMessage {
  id: string;
  role: ModelMessageRole;
  parts: UIPart[];
  /** 创建时间 */
  createdAt: number;
  /** 最后更新时间 */
  updatedAt: number;
  /** 关联的 chatId */
  chatId: string;
  /** 关联的 rootTaskId (可选, assistant 消息关联任务) */
  rootTaskId?: string;
  /** 消息状态 */
  status: 'pending' | 'streaming' | 'done' | 'error';
}

// ==================== 转换函数 ====================

/**
 * 将 UIMessage 转换为 ModelMessage (发给 LLM API)
 * 规则:
 *   - 只保留 text/delivery/clarify response 类型的 part
 *   - tool-call 类型的 part 转换为 toolCalls 字段
 *   - 进度/审计/UI 交互 part 不进入模型上下文 (避免污染)
 */
export function uiMessageToModelMessage(msg: UIMessage): ModelMessage {
  const textParts: string[] = [];
  const toolCalls: ModelToolCall[] = [];

  for (const part of msg.parts) {
    switch (part.type) {
      case 'text':
        textParts.push(part.text);
        break;
      case 'delivery':
        textParts.push(part.result);
        break;
      case 'clarify':
        if (part.response) textParts.push(part.response);
        break;
      // 以下 part 不进入模型上下文
      case 'task-summary':
      case 'phase-change':
      case 'subtask-created':
      case 'subtask-progress':
      case 'subtask-step':
      case 'subtask-done':
      case 'model-delegation':
      case 'model-action':
      case 'audit-start':
      case 'audit-finding':
      case 'audit-done':
      case 'prompt-card':
      case 'browser-step':
      case 'browser-screenshot':
      case 'error':
      case 'metadata':
        // 跳过 — 这些是 UI 专用 part
        break;
    }
  }

  return {
    role: msg.role,
    content: textParts.join('\n'),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

/**
 * 将多个 UIMessage 转换为 ModelMessage[] (构建完整对话历史)
 * 过滤掉空内容消息 (无 text/delivery/clarify response)
 */
export function uiMessagesToModelMessages(messages: UIMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];
  for (const msg of messages) {
    const modelMsg = uiMessageToModelMessage(msg);
    if (modelMsg.content || modelMsg.toolCalls?.length) {
      result.push(modelMsg);
    }
  }
  return result;
}

/**
 * 从 text parts 中提取完整文本 (用于快速渲染纯文本视图)
 */
export function extractTextFromUIMessage(msg: UIMessage): string {
  return msg.parts
    .filter((p): p is UITextPart => p.type === 'text')
    .map(p => p.text)
    .join('');
}

/**
 * 判断 UIMessage 是否包含指定类型的 part
 */
export function hasPartType(msg: UIMessage, type: UIPartType): boolean {
  return msg.parts.some(p => p.type === type);
}

/**
 * 获取指定类型的所有 parts
 */
export function getPartsByType<T extends UIPart>(
  msg: UIMessage,
  type: UIPartType,
): T[] {
  return msg.parts.filter((p): p is T => p.type === type) as T[];
}
