/**
 * usePartsDerived — 从 uiMessageStore (Data Parts) 派生流送区完整显示状态
 *
 * P0 阶段: 消除双源
 *   旧路径: streamingStore.tasks[chatId] (RootTask 对象, 高频全量更新)
 *   新路径: 本文件从 uiMessageStore.parts[] 派生, 按需更新
 *
 * 派生选择器:
 *   - useSubTasksFromParts: SubTask[] (从 subtask-created/progress/step/done + browser-* 聚合)
 *   - useAuditTaskFromParts: AuditTask | undefined (从 audit-start/finding/done 聚合)
 *   - useDelegationLogFromParts: string[] (从 model-delegation parts 派生)
 *   - useModelActionLogFromParts: string[] (从 model-action parts 派生)
 *   - useTextFromParts: string (从 text parts 按 subTaskId 过滤, 替代 useTextBuffer)
 *   - useDeliverResultFromParts: string | undefined (从 delivery parts 派生)
 *   - useRootTaskFromParts: RootTask | undefined (聚合上述所有字段, 兼容 TaskTree prop)
 *
 * 2026-07-10: P0 实现
 */

import { useMemo } from 'react';
import { useLastAssistantMessage } from './uiMessageStore';
import type { RootTask, SubTask, SubTaskStep, SubTaskSource, AuditTask, AuditFinding, TaskPhase, StepRecord } from '../types/streaming';
import type {
  UITextPart,
  UIPhaseChangePart,
  UISubTaskCreatedPart,
  UISubTaskProgressPart,
  UISubTaskStepPart,
  UISubTaskDonePart,
  UIModelDelegationPart,
  UIModelActionPart,
  UIAuditStartPart,
  UIAuditFindingPart,
  UIAuditDonePart,
  UIDeliveryPart,
  UIBrowserStepPart,
  UIBrowserScreenshotPart,
  UIErrorPart,
  UIClarifyPart,
} from '../types/messages';

// ==================== 空常量 (引用稳定) ====================

const EMPTY_SUBTASKS: SubTask[] = [];
const EMPTY_LOG: string[] = [];
const EMPTY_FINDINGS: AuditFinding[] = [];

// ==================== SubTask 聚合 ====================

/**
 * 从 parts 聚合 SubTask[]
 * 遍历 subtask-created / subtask-progress / subtask-step / subtask-done / browser-* parts
 * 按 subTaskId 聚合, 保持创建顺序
 */
export function deriveSubTasksFromParts(
  parts: ReturnType<typeof useLastAssistantMessage> extends infer M ? M extends { parts: infer P } ? P : never : never,
): SubTask[] {
  if (!parts || parts.length === 0) return EMPTY_SUBTASKS;

  const subTaskMap = new Map<string, SubTask>();
  const subTaskOrder: string[] = [];

  for (const part of parts) {
    switch (part.type) {
      case 'subtask-created': {
        const p = part as UISubTaskCreatedPart;
        if (!subTaskMap.has(p.subTaskId)) {
          subTaskMap.set(p.subTaskId, {
            id: p.subTaskId,
            rootTaskId: '', // parts 不携带 rootTaskId, 由调用方填充
            assigneeModel: p.assigneeModel,
            assigneeModelId: '',
            description: p.description,
            currentStep: 'READ_TASK',
            progress: 0,
            stepHistory: [],
            source: p.source,
            status: 'pending',
          });
          subTaskOrder.push(p.subTaskId);
        }
        break;
      }

      case 'subtask-progress': {
        const p = part as UISubTaskProgressPart;
        const st = subTaskMap.get(p.subTaskId);
        if (!st) break;
        const step = p.step ?? st.currentStep;
        const stepStatus: StepRecord['status'] =
          p.progress >= 100 ? 'done' : 'running';
        const newStep: StepRecord = {
          step,
          startedAt: Date.now(),
          completedAt: stepStatus === 'done' ? Date.now() : undefined,
          progress: p.progress,
          detail: p.detail ?? `步骤: ${step}`,
          status: stepStatus,
        };
        const filtered = st.stepHistory.filter(h => h.step !== step);
        st.stepHistory = [...filtered, newStep];
        st.progress = p.progress;
        st.currentStep = step;
        st.status = p.progress >= 100 ? 'done' : 'running';
        break;
      }

      case 'subtask-step': {
        const p = part as UISubTaskStepPart;
        const st = subTaskMap.get(p.subTaskId);
        if (!st) break;
        const stepStatus: StepRecord['status'] = p.status;
        const newStep: StepRecord = {
          step: p.step,
          startedAt: Date.now(),
          completedAt: stepStatus === 'done' ? Date.now() : undefined,
          progress: st.progress,
          detail: p.detail ?? `步骤: ${p.step}`,
          status: stepStatus,
        };
        const filtered = st.stepHistory.filter(h => h.step !== p.step);
        st.stepHistory = [...filtered, newStep];
        st.currentStep = p.step;
        break;
      }

      case 'subtask-done': {
        const p = part as UISubTaskDonePart;
        const st = subTaskMap.get(p.subTaskId);
        if (!st) break;
        st.status = p.status === 'done' ? 'done' : p.status === 'error' ? 'error' : 'cancelled';
        st.progress = 100;
        st.result = p.result;
        st.completedAt = Date.now();
        break;
      }

      case 'browser-step': {
        const p = part as UIBrowserStepPart;
        const st = subTaskMap.get(p.subTaskId);
        if (!st) break;
        // browser-use 子任务: 如果是首次看到, 补创建 (browser_task_start 可能没有对应 part)
        if (st.source !== 'browser-use') {
          st.source = 'browser-use';
          st.currentStep = 'EXECUTE';
        }
        const rec: StepRecord = {
          step: st.currentStep,
          startedAt: Date.now(),
          progress: p.progress ?? st.progress,
          detail: p.detail,
          status: 'running',
        };
        st.stepHistory = [...st.stepHistory, rec];
        if (p.progress !== undefined) st.progress = p.progress;
        st.currentStepIndex = (st.currentStepIndex ?? 0) + 1;
        st.maxSteps = st.maxSteps ?? 20;
        break;
      }

      case 'browser-screenshot': {
        const p = part as UIBrowserScreenshotPart;
        const st = subTaskMap.get(p.subTaskId);
        if (!st) break;
        st.screenshot_b64 = p.screenshotB64;
        break;
      }
    }
  }

  return subTaskOrder.map(id => subTaskMap.get(id)!).filter(Boolean);
}

// ==================== AuditTask 聚合 ====================

export function deriveAuditTaskFromParts(
  parts: ReturnType<typeof useLastAssistantMessage> extends infer M ? M extends { parts: infer P } ? P : never : never,
): AuditTask | undefined {
  if (!parts || parts.length === 0) return undefined;

  let auditStart: UIAuditStartPart | undefined;
  const findings: AuditFinding[] = [];
  let auditDone: UIAuditDonePart | undefined;

  for (const part of parts) {
    switch (part.type) {
      case 'audit-start': {
        auditStart = part as UIAuditStartPart;
        break;
      }
      case 'audit-finding': {
        const p = part as UIAuditFindingPart;
        findings.push(p.finding);
        break;
      }
      case 'audit-done': {
        auditDone = part as UIAuditDonePart;
        break;
      }
    }
  }

  if (!auditStart) return undefined;

  return {
    id: auditStart.auditTaskId,
    rootTaskId: '',
    auditorType: auditStart.auditorType,
    status: auditDone ? 'done' : 'reviewing',
    findings: findings.length > 0 ? findings : EMPTY_FINDINGS,
    progress: auditDone ? 100 : Math.min(100, findings.length * 20),
  };
}

// ==================== 日志派生 ====================

export function deriveDelegationLogFromParts(
  parts: ReturnType<typeof useLastAssistantMessage> extends infer M ? M extends { parts: infer P } ? P : never : never,
): string[] {
  if (!parts || parts.length === 0) return EMPTY_LOG;
  const log: string[] = [];
  for (const part of parts) {
    if (part.type === 'model-delegation') {
      const p = part as UIModelDelegationPart;
      const ts = new Date(p.timestamp).toISOString();
      log.push(`${ts} ${p.fromModel} → ${p.toModel}${p.detail ? ` (${p.detail})` : ''}`);
    }
  }
  return log.length > 0 ? log : EMPTY_LOG;
}

export function deriveModelActionLogFromParts(
  parts: ReturnType<typeof useLastAssistantMessage> extends infer M ? M extends { parts: infer P } ? P : never : never,
): string[] {
  if (!parts || parts.length === 0) return EMPTY_LOG;
  const log: string[] = [];
  for (const part of parts) {
    if (part.type === 'model-action') {
      const p = part as UIModelActionPart;
      const ts = new Date(p.timestamp).toISOString();
      log.push(`${ts} ${p.action}${p.detail ? ` (${p.detail})` : ''}`);
    }
  }
  return log.length > 0 ? log : EMPTY_LOG;
}

// ==================== 文本派生 ====================

/**
 * 从 text parts 按 subTaskId 过滤, 拼接完整文本
 * 替代 useTextBuffer (从 streamingStore.textBuffers 读取)
 */
export function deriveTextFromParts(
  parts: ReturnType<typeof useLastAssistantMessage> extends infer M ? M extends { parts: infer P } ? P : never : never,
  subTaskId: string | null | undefined,
): string {
  if (!parts || parts.length === 0 || !subTaskId) return '';
  let text = '';
  for (const part of parts) {
    if (part.type === 'text') {
      const p = part as UITextPart;
      if (p.subTaskId === subTaskId) {
        text += p.text;
      }
    }
  }
  return text;
}

// ==================== 交付结果派生 ====================

export function deriveDeliverResultFromParts(
  parts: ReturnType<typeof useLastAssistantMessage> extends infer M ? M extends { parts: infer P } ? P : never : never,
): string | undefined {
  if (!parts || parts.length === 0) return undefined;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === 'delivery') {
      return (parts[i] as UIDeliveryPart).result;
    }
  }
  return undefined;
}

// ==================== Phase 派生 ====================

export function derivePhaseFromParts(
  parts: ReturnType<typeof useLastAssistantMessage> extends infer M ? M extends { parts: infer P } ? P : never : never,
): TaskPhase | null {
  if (!parts || parts.length === 0) return null;
  let phase: TaskPhase | null = null;
  for (const part of parts) {
    if (part.type === 'phase-change') {
      phase = (part as UIPhaseChangePart).to;
    }
  }
  return phase;
}

// ==================== React Hooks ====================

/**
 * 订阅指定 chatId 的 SubTask[] (从 parts 派生)
 */
export function useSubTasksFromParts(chatId: string | null | undefined): SubTask[] {
  const message = useLastAssistantMessage(chatId);
  return useMemo(() => deriveSubTasksFromParts(message?.parts), [message]);
}

/**
 * 订阅指定 chatId 的 AuditTask (从 parts 派生)
 */
export function useAuditTaskFromParts(chatId: string | null | undefined): AuditTask | undefined {
  const message = useLastAssistantMessage(chatId);
  return useMemo(() => deriveAuditTaskFromParts(message?.parts), [message]);
}

/**
 * 订阅指定 chatId 的模型委派日志 (从 parts 派生)
 */
export function useDelegationLogFromParts(chatId: string | null | undefined): string[] {
  const message = useLastAssistantMessage(chatId);
  return useMemo(() => deriveDelegationLogFromParts(message?.parts), [message]);
}

/**
 * 订阅指定 chatId 的模型动作日志 (从 parts 派生)
 */
export function useModelActionLogFromParts(chatId: string | null | undefined): string[] {
  const message = useLastAssistantMessage(chatId);
  return useMemo(() => deriveModelActionLogFromParts(message?.parts), [message]);
}

/**
 * 订阅指定 subTaskId 的流式文本 (从 parts 派生)
 * 替代 useTextBuffer (从 streamingStore.textBuffers 读取)
 */
export function useTextFromParts(chatId: string | null | undefined, subTaskId: string | null | undefined): string {
  const message = useLastAssistantMessage(chatId);
  return useMemo(() => deriveTextFromParts(message?.parts, subTaskId), [message]);
}

/**
 * 订阅指定 chatId 的交付结果 (从 parts 派生)
 */
export function useDeliverResultFromParts(chatId: string | null | undefined): string | undefined {
  const message = useLastAssistantMessage(chatId);
  return useMemo(() => deriveDeliverResultFromParts(message?.parts), [message]);
}

/**
 * 聚合: 从 parts 派生完整 RootTask 对象
 * 用于兼容 TaskTree 组件的 task prop
 *
 * 注意: userInput 和 rootTaskId 从 streamingStore 读取 (控制流字段, 不在 parts 中)
 */
export function useRootTaskFromParts(
  chatId: string | null | undefined,
  userInput: string | undefined,
  rootTaskId: string | undefined,
): RootTask | undefined {
  const message = useLastAssistantMessage(chatId);
  return useMemo<RootTask | undefined>(() => {
    if (!message || message.parts.length === 0) return undefined;
    if (!chatId) return undefined;

    const phase = derivePhaseFromParts(message.parts) ?? 'CLARIFY';
    const subTasks = deriveSubTasksFromParts(message.parts);
    const auditTask = deriveAuditTaskFromParts(message.parts);
    const deliverResult = deriveDeliverResultFromParts(message.parts);
    const delegationLog = deriveDelegationLogFromParts(message.parts);
    const modelActionLog = deriveModelActionLogFromParts(message.parts);

    // 填充 rootTaskId
    for (const st of subTasks) {
      st.rootTaskId = rootTaskId ?? '';
    }

    // 计算进度
    let progress = 0;
    if (subTasks.length > 0) {
      const weights = subTasks.map(s => Math.max(Math.min(s.description.length / 50, 3), 1));
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      const weighted = subTasks.reduce((sum, s, i) => sum + (s.progress / 100) * weights[i], 0);
      progress = Math.round((weighted / totalWeight) * 100);
    }

    // clarifyHistory
    const clarifyHistory: string[] = [];
    for (const part of message.parts) {
      if (part.type === 'clarify') {
        const p = part as UIClarifyPart;
        if (p.response) clarifyHistory.push(p.response);
      }
    }

    const now = Date.now();
    return {
      id: rootTaskId ?? `derived-${chatId}`,
      chatId,
      userInput: userInput ?? '',
      phase,
      progress,
      subTasks,
      auditTask,
      deliverResult,
      clarifyHistory: clarifyHistory.length > 0 ? clarifyHistory : undefined,
      delegationLog,
      modelActionLog,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    };
  }, [message, chatId, userInput, rootTaskId]);
}
