/**
 * eventToUIPart — StreamEvent → UIMessage Part 适配器
 *
 * 将现有的扁平 StreamEvent 转换为类型化的 UIPart
 * 这是旧事件系统 → 新 Data Parts 模式的过渡桥梁
 *
 * 设计原则:
 *   1. 纯函数, 无副作用, 易于测试
 *   2. 对齐 Vercel AI SDK 5 的 part 语义
 *   3. 未知事件类型返回 null (不静默丢弃, 由调用方决定)
 */

import type { StreamEvent } from '../types/streaming';
import type {
  UIPart,
  UITextPart,
  UITaskSummaryPart,
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
  UIClarifyPart,
  UIBrowserStepPart,
  UIBrowserScreenshotPart,
  UIErrorPart,
} from '../types/messages';
import type {
  TaskPhase,
  SubTaskStep,
  SubTaskSource,
  AuditFinding,
} from '../types/streaming';

/**
 * 将 StreamEvent 转换为 UIPart
 * 返回 null 表示该事件不映射为独立 part (如 task_created 由 store 直接处理)
 */
export function streamEventToUIPart(event: StreamEvent, prevPhase?: TaskPhase): UIPart | null {
  switch (event.kind) {
    // ── Text ──
    case 'text_chunk': {
      const part: UITextPart = {
        type: 'text',
        text: event.content,
        streaming: event.status === 'running',
        subTaskId: event.subTaskId,
      };
      return part;
    }

    // ── Phase ──
    case 'phase_change': {
      const toPhase = event.content as TaskPhase;
      const part: UIPhaseChangePart = {
        type: 'phase-change',
        from: prevPhase ?? 'CLARIFY',
        to: toPhase,
        detail: event.detail,
        timestamp: event.ts,
      };
      return part;
    }

    // ── SubTask ──
    case 'subtask_created': {
      const part: UISubTaskCreatedPart = {
        type: 'subtask-created',
        subTaskId: event.subTaskId ?? '',
        assigneeModel: event.content,
        agentId: event.agentId,
        description: event.detail ?? '',
        source: 'llm' as SubTaskSource,
      };
      return part;
    }

    case 'subtask_progress': {
      const part: UISubTaskProgressPart = {
        type: 'subtask-progress',
        subTaskId: event.subTaskId ?? '',
        progress: event.progress ?? 0,
        step: event.content as SubTaskStep | undefined,
        detail: event.detail,
      };
      return part;
    }

    case 'subtask_step': {
      const part: UISubTaskStepPart = {
        type: 'subtask-step',
        subTaskId: event.subTaskId ?? '',
        step: event.content as SubTaskStep,
        detail: event.detail,
        status: event.status === 'success' ? 'done' : event.status === 'error' ? 'error' : 'running',
      };
      return part;
    }

    case 'subtask_done': {
      const part: UISubTaskDonePart = {
        type: 'subtask-done',
        subTaskId: event.subTaskId ?? '',
        result: event.content,
        status: event.status === 'error' ? 'error' : 'done',
      };
      return part;
    }

    // ── Model ──
    case 'model_delegation': {
      const part: UIModelDelegationPart = {
        type: 'model-delegation',
        fromModel: '', // 由调用方填充
        toModel: event.content,
        agentId: event.agentId,
        detail: event.detail,
        timestamp: event.ts,
      };
      return part;
    }

    case 'model_action': {
      const part: UIModelActionPart = {
        type: 'model-action',
        action: event.content,
        detail: event.detail,
        subTaskId: event.subTaskId,
        timestamp: event.ts,
      };
      return part;
    }

    // ── Audit ──
    case 'audit_start': {
      const part: UIAuditStartPart = {
        type: 'audit-start',
        auditTaskId: event.subTaskId ?? '',
        auditorType: event.content === 'main_model' ? 'main_model' : 'sub_agent',
      };
      return part;
    }

    case 'audit_finding': {
      const severity: AuditFinding['severity'] =
        event.status === 'error' ? 'error' : event.status === 'running' ? 'warning' : 'info';
      const finding: AuditFinding = {
        severity,
        target: event.content,
        suggestion: event.detail ?? '',
      };
      const part: UIAuditFindingPart = {
        type: 'audit-finding',
        auditTaskId: event.subTaskId ?? '',
        finding,
      };
      return part;
    }

    case 'audit_done': {
      const part: UIAuditDonePart = {
        type: 'audit-done',
        auditTaskId: event.subTaskId ?? '',
      };
      return part;
    }

    // ── Delivery ──
    case 'delivery': {
      const part: UIDeliveryPart = {
        type: 'delivery',
        result: event.content,
        timestamp: event.ts,
      };
      return part;
    }

    // ── Clarify ──
    case 'clarify_request':
    case 'clarify_response': {
      const part: UIClarifyPart = {
        type: 'clarify',
        question: event.kind === 'clarify_request' ? event.content : '',
        response: event.kind === 'clarify_response' ? event.content : undefined,
        timestamp: event.ts,
      };
      return part;
    }

    // ── Browser ──
    case 'browser_task_start':
    case 'browser_task_step': {
      const part: UIBrowserStepPart = {
        type: 'browser-step',
        subTaskId: event.subTaskId ?? '',
        stepIndex: 0, // 由调用方填充
        detail: event.detail ?? event.content,
        progress: event.progress,
      };
      return part;
    }

    case 'browser_task_screenshot': {
      const part: UIBrowserScreenshotPart = {
        type: 'browser-screenshot',
        subTaskId: event.subTaskId ?? '',
        screenshotB64: event.detail ?? '',
      };
      return part;
    }

    // ── Error ──
    case 'error': {
      const part: UIErrorPart = {
        type: 'error',
        message: event.content,
        detail: event.detail,
        timestamp: event.ts,
      };
      return part;
    }

    // ── 不映射为独立 part 的事件 ──
    // task_created: 由 store createTask 直接处理, 不需要 part
    // agent_created / agent_dissolved: 元数据, 不在 UI 消息流展示
    // browser_task_done / error / cancelled: 由 subtask_done 统一处理
    // browser_enable_request / tool_suggestion: 走 promptCardPool, 不走 part
    // tool_enabled / tool_skipped / tool_timeout: 由 model_action 统一处理
    default:
      return null;
  }
}

/**
 * 批量转换: 将 StreamEvent[] 转换为 UIPart[]
 * 过滤掉返回 null 的事件
 */
export function streamEventsToUIParts(events: StreamEvent[], prevPhase?: TaskPhase): UIPart[] {
  const parts: UIPart[] = [];
  let currentPhase = prevPhase;
  for (const event of events) {
    const part = streamEventToUIPart(event, currentPhase);
    if (part) {
      parts.push(part);
    }
    // 跟踪 phase 变化, 供后续事件使用
    if (event.kind === 'phase_change') {
      currentPhase = event.content as TaskPhase;
    }
  }
  return parts;
}
