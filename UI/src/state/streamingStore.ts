/**
 * streamingStore — 流送区任务状态机
 * 管理 RootTask 生命周期、子任务状态、进度计算、事件驱动推进
 */
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type {
  RootTask,
  SubTask,
  SubTaskStep,
  SubTaskSource,
  TaskPhase,
  StepRecord,
  AuditTask,
  AuditFinding,
  SubAgent,
  StreamEvent,
  StreamEventKind,
  PermissionMode,
  PromptCardSpec,
} from '../types/streaming';
import { calcRootProgress, transitionPhase, STEP_PROGRESS } from '../types/streaming';
import { promptCardPool } from '../services/promptCardPool';

interface StreamingState {
  // 当前对话的任务映射
  // @deprecated for display — 高频显示状态 (phase, progress, subtask counts) 已迁移到 uiMessageStore
  //   旧路径: useStreamingStore(s => s.tasks[chatId])
  //   新路径: useStreamSummary(chatId) — 从 Data Parts 派生
  //   保留用于: userInput (原始 prompt), TaskTree 组件, Actor 系统控制流
  tasks: Record<string, RootTask>;       // chatId -> active task
  taskHistory: Record<string, RootTask[]>; // chatId -> completed tasks
  mode: PermissionMode;

  // 流送任务元数据 (按 chatId 隔离, 替代组件级 streamTaskRef)
  // 存储 workerIdx -> subTaskId 的映射, 多 chat 并发时不会串台
  streamTaskMeta: Record<string, { rootTaskId: string; subTaskIds: Map<number, string> }>;

  // R1.1: 子Agent 池 (按 chatId 索引)
  agentsMap: Record<string, SubAgent[]>;

  // 动作
  createTask: (chatId: string, userInput: string, mode: PermissionMode) => RootTask;
  applyEvent: (event: StreamEvent) => void;
  updateSubTaskProgress: (rootTaskId: string, subTaskId: string, step: SubTaskStep, stepInternal: number) => void;
  completeSubTask: (rootTaskId: string, subTaskId: string, result?: string) => void;
  addAuditFinding: (rootTaskId: string, finding: AuditFinding) => void;
  transitionTaskPhase: (rootTaskId: string, phase: TaskPhase) => void;
  getTask: (chatId: string) => RootTask | undefined;
  clearChat: (chatId: string) => void;

  // 流送元数据管理 (C fix: 替代组件级 streamTaskRef)
  bindStreamTask: (chatId: string, rootTaskId: string) => void;
  bindSubTask: (chatId: string, workerIdx: number, subTaskId: string) => void;
  getSubTaskId: (chatId: string, workerIdx: number) => string | undefined;
  getStreamTaskMeta: (chatId: string) => { rootTaskId: string; subTaskIds: Map<number, string> } | undefined;

  // R1.1: 子 Agent 池管理
  addAgent: (chatId: string, agent: SubAgent) => void;
  removeAgent: (chatId: string, agentId: string) => void;
  getAgents: (chatId: string) => SubAgent[];

  // R3.1: 取 chatId 根任务最后创建的 subTaskId (phaseMappers 用)
  getLastSubTaskId: (chatId: string) => string | undefined;

  // R1.4: 测试用 — 一键重置整个 store 到初始空状态
  __reset: () => void;
}

// R3.3: 用 crypto.randomUUID() 替代模块级计数器
// 优势: 跨 HMR 不重置、跨测试不重置、跨 iframe/worker 不冲突
function uid(prefix: string): string {
  // 浏览器 + Node 19+ 都有 crypto.randomUUID
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  // 退化方案: 时间戳 + 随机后缀 (旧环境兜底)
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const subUid = (): string => uid('sub');

// ==================== R1.2: 事件 handler 字典 ====================
// 加新 StreamEventKind 时, 编译器会强制要求补 handler (穷尽性检查)

type HandlerCtx = {
  get: () => StreamingState;
  set: (fn: (s: StreamingState) => Partial<StreamingState>) => void;
  task: RootTask;
};

type EventHandler = (event: StreamEvent, ctx: HandlerCtx) => void;

const SUBTASK_VALID_STEPS: SubTaskStep[] = ['READ_TASK','UNDERSTAND','DECIDE','EXECUTE','COMPLETE','SUBMIT_TO_JUDGE'];

function inferSubTaskStep(event: StreamEvent, fallback: SubTaskStep): SubTaskStep {
  if (event.content && (SUBTASK_VALID_STEPS as string[]).includes(event.content)) {
    return event.content as SubTaskStep;
  }
  if (event.progress !== undefined) {
    for (const k of SUBTASK_VALID_STEPS) {
      const [lo, hi] = STEP_PROGRESS[k];
      if (event.progress >= lo && event.progress <= hi) return k;
    }
  }
  return fallback;
}

function findSubTaskById(t: RootTask, subTaskId: string): SubTask | undefined {
  return t.subTasks.find(st => st.id === subTaskId);
}

function findSubTaskByBrowserId(t: RootTask, browserTaskId: string): SubTask | undefined {
  return t.subTasks.find(st => st.browserTaskId === browserTaskId);
}

function updateTask(set: HandlerCtx['set'], chatId: string, mutator: (t: RootTask) => RootTask) {
  set(s => {
    const t = s.tasks[chatId];
    if (!t) return s;
    const updated = mutator(t);
    updated.progress = calcRootProgress(updated);
    return { tasks: { ...s.tasks, [chatId]: updated } };
  });
}

const EVENT_HANDLERS: Record<StreamEventKind, EventHandler> = {
  // ============== Phase ==============
  task_created: () => { /* already handled by createTask */ },

  phase_change: (event, { get, task }) => {
    get().transitionTaskPhase(task.id, event.content as TaskPhase);
  },

  // ============== SubTask lifecycle ==============

  subtask_created: (event, { set, task }) => {
    updateTask(set, event.chatId, t => {
      const sub: SubTask = {
        id: subUid(),
        rootTaskId: task.id,
        assigneeModel: event.content,
        assigneeModelId: event.agentId ?? '',
        description: event.detail ?? '',
        currentStep: 'READ_TASK',
        progress: 0,
        stepHistory: [],
        source: 'llm',
        status: 'pending',
        startedAt: event.ts,
      };
      return { ...t, subTasks: [...t.subTasks, sub], updatedAt: event.ts };
    });
  },

  subtask_progress: (event, { set }) => {
    if (!event.subTaskId || event.progress === undefined) return;
    updateTask(set, event.chatId, t => {
      const newSubTasks = t.subTasks.map(st => {
        if (st.id !== event.subTaskId) return st;
        const step = inferSubTaskStep(event, st.currentStep);
        const stepStatus: StepRecord['status'] =
          event.status === 'success' || event.status === 'done' || event.progress! >= 100
            ? 'done'
            : event.status === 'error' ? 'error' : 'running';
        const newStep: StepRecord = {
          step,
          startedAt: event.ts,
          completedAt: stepStatus === 'done' || stepStatus === 'error' ? event.ts : undefined,
          progress: event.progress!,
          detail: event.detail ?? `步骤: ${step}`,
          status: stepStatus,
        };
        const filtered = st.stepHistory.filter(h => h.step !== step);
        const subStatus: SubTask['status'] =
          event.status === 'error' ? 'error'
          : event.progress! >= 100 ? 'done' : 'running';
        return {
          ...st,
          progress: event.progress!,
          currentStep: step,
          status: subStatus,
          stepHistory: [...filtered, newStep],
          updatedAt: event.ts,
        };
      });
      return { ...t, subTasks: newSubTasks, updatedAt: event.ts };
    });
  },

  subtask_step: (event, { set }) => {
    if (!event.subTaskId || !event.content) return;
    if (!(SUBTASK_VALID_STEPS as string[]).includes(event.content)) return;
    const step = event.content as SubTaskStep;
    updateTask(set, event.chatId, t => {
      const newSubTasks = t.subTasks.map(st => {
        if (st.id !== event.subTaskId) return st;
        const stepStatus: StepRecord['status'] = event.status === 'success' || event.status === 'done' ? 'done' : 'running';
        const newStep: StepRecord = {
          step,
          startedAt: event.ts,
          completedAt: stepStatus === 'done' ? event.ts : undefined,
          progress: event.progress ?? STEP_PROGRESS[step][0],
          detail: event.detail ?? `步骤: ${step}`,
          status: stepStatus,
        };
        const filtered = st.stepHistory.filter(h => h.step !== step);
        return {
          ...st,
          currentStep: step,
          stepHistory: [...filtered, newStep],
          updatedAt: event.ts,
        };
      });
      return { ...t, subTasks: newSubTasks, updatedAt: event.ts };
    });
  },

  subtask_done: (event, { get, task }) => {
    if (event.subTaskId) {
      get().completeSubTask(task.id, event.subTaskId, event.content);
    }
  },

  // ============== Model family ==============

  model_delegation: (event, { set }) => {
    updateTask(set, event.chatId, t => {
      const log = t.delegationLog ?? [];
      return {
        ...t,
        delegationLog: [...log, `${new Date(event.ts).toISOString()} ${event.content}${event.detail ? ` (${event.detail})` : ''}`],
        updatedAt: event.ts,
      };
    });
  },

  model_action: (event, { set }) => {
    updateTask(set, event.chatId, t => {
      const log = t.modelActionLog ?? [];
      const actionLine = `${new Date(event.ts).toISOString()} ${event.content}${event.detail ? ` (${event.detail})` : ''}`;
      const newSubTasks = event.subTaskId
        ? t.subTasks.map(st => {
            if (st.id !== event.subTaskId) return st;
            const rec: StepRecord = {
              step: st.currentStep,
              startedAt: event.ts,
              progress: st.progress,
              detail: event.content + (event.detail ? ` (${event.detail})` : ''),
              status: 'running',
            };
            return { ...st, stepHistory: [...st.stepHistory, rec], updatedAt: event.ts };
          })
        : t.subTasks;
      return { ...t, modelActionLog: [...log, actionLine], subTasks: newSubTasks, updatedAt: event.ts };
    });
  },

  // ============== Audit family ==============

  audit_start: (event, { set, task }) => {
    updateTask(set, event.chatId, t => {
      const auditorType: AuditTask['auditorType'] = event.content === 'main_model' ? 'main_model' : 'sub_agent';
      const audit: AuditTask = {
        id: uid('audit'),
        rootTaskId: task.id,
        auditorType,
        agentId: event.agentId,
        status: 'reviewing',
        findings: [],
        progress: 0,
      };
      return { ...t, auditTask: audit, updatedAt: event.ts };
    });
  },

  audit_finding: (event, { get, task }) => {
    const severity: AuditFinding['severity'] =
      event.status === 'error' ? 'error' : event.status === 'running' ? 'warning' : 'info';
    get().addAuditFinding(task.id, {
      severity,
      target: event.content,
      suggestion: event.detail ?? '',
    });
  },

  audit_done: (event, { set }) => {
    updateTask(set, event.chatId, t => {
      if (!t.auditTask) return t;
      return {
        ...t,
        auditTask: { ...t.auditTask, status: 'done', progress: 100, findings: t.auditTask.findings },
        updatedAt: event.ts,
      };
    });
  },

  // ============== Clarify family ==============

  clarify_request: (event, { get }) => {
    const spec: PromptCardSpec = {
      id: `clarify-${event.id}`,
      type: 'clarification',
      title: '需要你补充信息',
      message: event.content,
      countdown: event.detail?.includes('urgent') ? 30 : 120,
      options: [
        { id: 'answer', label: '回答', action: { kind: 'custom', payload: { chatId: event.chatId } }, isRecommended: true },
        { id: 'skip', label: '跳过', action: { kind: 'skip' } },
      ],
      defaultAction: { kind: 'skip' },
      context: { chatId: event.chatId, eventId: event.id },
      priority: 'blocking',
    };
    promptCardPool.upsert(spec, get().mode);
  },

  clarify_response: (event, { set }) => {
    updateTask(set, event.chatId, t => {
      const history = t.clarifyHistory ?? [];
      return { ...t, clarifyHistory: [...history, event.content], updatedAt: event.ts };
    });
  },

  // ============== Delivery ==============
  // Fix: 将 phase 变更合并到 updateTask 中, 避免内外 set 竞态覆盖
  // 之前: updateTask(set, ...) + get().transitionTaskPhase(...) → 外层 set 的 taskPatch
  //        覆盖了内层 transitionTaskPhase 的 phase 变更 (预存在 bug)
  // 现在: 单次 updateTask 同时写入 deliverResult + phase, 无竞态

  delivery: (event, { set }) => {
    updateTask(set, event.chatId, t => {
      const nextPhase = transitionPhase(t.phase, 'DONE');
      return { ...t, deliverResult: event.content, phase: nextPhase ?? t.phase, updatedAt: event.ts };
    });
  },

  // ============== Agent family ==============

  agent_created: (event, { get }) => {
    const role: SubAgent['role'] = event.detail === 'auditor' ? 'auditor' : 'assistant';
    get().addAgent(event.chatId, {
      id: event.content,
      chatId: event.chatId,
      role,
      parentModelId: event.agentId ?? '',
      reputation: 0,
      createdAt: event.ts,
      lastActiveAt: event.ts,
    });
  },

  agent_dissolved: (event, { get }) => {
    get().removeAgent(event.chatId, event.content);
  },

  // ============== Browser family ==============

  browser_task_start: (event, { set, task }) => {
    updateTask(set, event.chatId, t => {
      // 同 browserTaskId 重复触发时去重
      if (t.subTasks.some(st => st.browserTaskId === event.content)) return t;
      const sub: SubTask = {
        id: subUid(),
        rootTaskId: task.id,
        assigneeModel: 'browser-use',
        assigneeModelId: 'browser',
        description: event.detail ?? event.content,
        currentStep: 'EXECUTE',
        progress: 0,
        stepHistory: [],
        source: 'browser-use',
        status: 'running',
        startedAt: event.ts,
        browserTaskId: event.content,
        browserUrl: event.detail,
        maxSteps: 20,
        currentStepIndex: 0,
      };
      return { ...t, subTasks: [...t.subTasks, sub], updatedAt: event.ts };
    });
  },

  browser_task_step: (event, { set }) => {
    if (!event.content) return;
    updateTask(set, event.chatId, t => {
      const newSubTasks = t.subTasks.map(st => {
        if (st.browserTaskId !== event.content) return st;
        const newIdx = (st.currentStepIndex ?? 0) + 1;
        const rec: StepRecord = {
          step: st.currentStep,
          startedAt: event.ts,
          progress: event.progress ?? st.progress,
          detail: event.detail ?? `步骤 ${newIdx}`,
          status: 'running',
        };
        return {
          ...st,
          progress: event.progress ?? st.progress,
          currentStepIndex: newIdx,
          stepHistory: [...st.stepHistory, rec],
          updatedAt: event.ts,
        };
      });
      return { ...t, subTasks: newSubTasks, updatedAt: event.ts };
    });
  },

  browser_task_screenshot: (event, { set }) => {
    if (!event.content) return;
    updateTask(set, event.chatId, t => {
      const newSubTasks = t.subTasks.map(st => {
        if (st.browserTaskId !== event.content) return st;
        const rec: StepRecord = {
          step: st.currentStep,
          startedAt: event.ts,
          progress: st.progress,
          detail: '截图已捕获',
          status: 'running',
        };
        return {
          ...st,
          screenshot_b64: event.detail,
          stepHistory: [...st.stepHistory, rec],
          updatedAt: event.ts,
        };
      });
      return { ...t, subTasks: newSubTasks, updatedAt: event.ts };
    });
  },

  browser_task_done: (event, { set }) => {
    if (!event.content) return;
    updateTask(set, event.chatId, t => {
      const now = event.ts;
      const newSubTasks = t.subTasks.map(st => {
        if (st.browserTaskId !== event.content) return st;
        return { ...st, status: 'done' as const, progress: 100, result: event.detail, completedAt: now };
      });
      return { ...t, subTasks: newSubTasks, updatedAt: now };
    });
  },

  browser_task_error: (event, { set }) => {
    if (!event.content) return;
    updateTask(set, event.chatId, t => {
      const now = event.ts;
      const newSubTasks = t.subTasks.map(st => {
        if (st.browserTaskId !== event.content) return st;
        return { ...st, status: 'error' as const, result: event.detail, completedAt: now };
      });
      return { ...t, subTasks: newSubTasks, updatedAt: now };
    });
  },

  browser_task_cancelled: (event, { set }) => {
    if (!event.content) return;
    updateTask(set, event.chatId, t => {
      const now = event.ts;
      const newSubTasks = t.subTasks.map(st => {
        if (st.browserTaskId !== event.content) return st;
        return { ...st, status: 'cancelled' as const, completedAt: now };
      });
      return { ...t, subTasks: newSubTasks, updatedAt: now };
    });
  },

  browser_enable_request: (event, { get }) => {
    const spec: PromptCardSpec = {
      id: `browser-enable-${event.id}`,
      type: 'browser_tool_enable',
      title: '启用浏览器自动化',
      message: event.content,
      countdown: 60,
      options: [
        { id: 'enable', label: '启用', action: { kind: 'accept' }, isRecommended: true },
        { id: 'skip', label: '跳过', action: { kind: 'skip' } },
      ],
      defaultAction: { kind: 'skip' },
      context: { chatId: event.chatId, url: event.detail, eventId: event.id },
      priority: 'non_blocking',
      cooldown: 30,
      groupKey: `browser-enable-${event.detail ?? 'default'}`,
    };
    promptCardPool.upsert(spec, get().mode);
  },

  // ============== Tool family ==============

  tool_suggestion: (event, { get }) => {
    const spec: PromptCardSpec = {
      id: `tool-suggest-${event.id}`,
      type: 'tool_suggestion',
      title: `建议使用工具: ${event.content}`,
      message: event.detail ?? `模型建议使用工具 ${event.content}`,
      countdown: 90,
      options: [
        { id: 'accept', label: '使用', action: { kind: 'accept' }, isRecommended: true },
        { id: 'skip', label: '跳过', action: { kind: 'skip' } },
      ],
      defaultAction: { kind: 'skip' },
      context: { chatId: event.chatId, tool: event.content, eventId: event.id },
      priority: 'non_blocking',
      cooldown: 15,
      groupKey: `tool-suggest-${event.content}`,
    };
    promptCardPool.upsert(spec, get().mode);
  },

  tool_enabled: (event, { set }) => {
    updateTask(set, event.chatId, t => {
      const log = t.modelActionLog ?? [];
      return {
        ...t,
        modelActionLog: [...log, `工具启用: ${event.content}${event.detail ? ` (${event.detail})` : ''}`],
        updatedAt: event.ts,
      };
    });
  },

  tool_skipped: (event, { set }) => {
    updateTask(set, event.chatId, t => {
      const log = t.modelActionLog ?? [];
      return {
        ...t,
        modelActionLog: [...log, `工具跳过: ${event.content}${event.detail ? ` (${event.detail})` : ''}`],
        updatedAt: event.ts,
      };
    });
  },

  tool_timeout: (event, { set }) => {
    updateTask(set, event.chatId, t => {
      const log = t.modelActionLog ?? [];
      return {
        ...t,
        modelActionLog: [...log, `工具超时: ${event.content}${event.detail ? ` (${event.detail})` : ''}`],
        updatedAt: event.ts,
      };
    });
  },

  // ============== Text chunk (流式文本累积) ==============

  text_chunk: (event, { set, task }) => {
    if (!event.content) return;
    if (task.subTasks.length === 0) return;
    const targetId = event.subTaskId ?? task.subTasks[task.subTasks.length - 1].id;

    // 文本累积已迁移到 uiMessageStore text parts, 这里仅处理 subtask 状态 pending → running 一次性更新
    const target = task.subTasks.find(st => st.id === targetId);
    if (!target || target.status !== 'pending') return;

    set(s => {
      const newSubTasks = task.subTasks.map(st => {
        if (st.id !== targetId) return st;
        return { ...st, status: 'running' as const, updatedAt: event.ts };
      });
      const updated = { ...task, subTasks: newSubTasks, updatedAt: event.ts };
      updated.progress = calcRootProgress(updated);
      return { tasks: { ...s.tasks, [event.chatId]: updated } };
    });
  },

  // ============== Error ==============

  error: (event, { get, task }) => {
    get().transitionTaskPhase(task.id, 'ERROR');
  },
};

export const useStreamingStore = create<StreamingState>((set, get) => ({
  tasks: {},
  taskHistory: {},
  mode: 'normal',
  streamTaskMeta: {},
  agentsMap: {},

  createTask: (chatId: string, userInput: string, mode: PermissionMode) => {
    // R2.2 fix: 同 chatId 若已有未完成任务 (DONE/ERROR 以外), 先归档到 history 再建新任务
    // 避免: 用户连发 / 切 chat 后回来重发, 旧任务被静默覆盖丢失
    const existing = get().tasks[chatId];
    const isTerminal = existing && (existing.phase === 'DONE' || existing.phase === 'ERROR');
    const shouldArchive = existing && !isTerminal;

    const task: RootTask = {
      id: uid('task'),
      chatId,
      userInput,
      phase: 'CLARIFY',
      progress: 0,
      subTasks: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    set(s => {
      const next: Partial<StreamingState> = {
        tasks: { ...s.tasks, [chatId]: task },
        mode,
        // C fix: 同步绑定流送元数据 (替代组件级 ref)
        streamTaskMeta: {
          ...s.streamTaskMeta,
          [chatId]: { rootTaskId: task.id, subTaskIds: new Map() },
        },
      };
      if (shouldArchive && existing) {
        const existingHistory = s.taskHistory[chatId] ?? [];
        next.taskHistory = { ...s.taskHistory, [chatId]: [...existingHistory, existing] };
      }
      return next;
    });
    return task;
  },

  applyEvent: (event: StreamEvent) => {
    const state = get();
    const task = state.tasks[event.chatId];
    if (!task) return;

    // R1.2 fix: 字典派发 + 穷尽性类型检查
    // 加新 StreamEventKind 时, Record<StreamEventKind, Handler> 会编译报错, 强制补 handler
    //
    // 注意: tasks[chatId] 的 phase/progress/subTasks 字段 UI 已不订阅 (从 uiMessageStore.parts 派生)
    // 这里更新仅维持控制流方法 (getLastSubTaskId 等) 所需的影子状态
    //
    // handler 有两种 set 模式:
    //   1. ctx.set (大多数 handler) — 变更捕获到 taskPatch, 外层 set 返回 taskPatch
    //   2. get().transitionTaskPhase() 等 (phase_change/error/audit_finding) — 直接改 store, 外层 set 返回 {} 不覆盖
    const handler = EVENT_HANDLERS[event.kind];
    set(s => {
      let taskPatch: Partial<StreamingState> | null = null;
      handler(event, {
        get: () => ({ ...(s as StreamingState), task }),
        set: (fn) => { taskPatch = fn(s); },
        task,
      });
      // 返回 {} 而非 s: 若 handler 通过 get().xxx() 已直接改 store, 返回 s 会回滚
      return taskPatch ?? {};
    });
  },

  updateSubTaskProgress: (rootTaskId: string, subTaskId: string, step: SubTaskStep, stepInternal: number) => {
    set(s => {
      const entry = Object.entries(s.tasks).find(([, t]) => t.id === rootTaskId);
      if (!entry) return s;
      const [chatId, task] = entry;
      const now = Date.now();
      const updated = {
        ...task,
        subTasks: task.subTasks.map(st => {
          if (st.id !== subTaskId) return st;
          const existingStep = st.stepHistory.find(h => h.step === step);
          const newStep: StepRecord = {
            step,
            startedAt: existingStep?.startedAt ?? now,
            completedAt: stepInternal >= 100 ? now : undefined,
            progress: stepInternal,
            detail: `步骤: ${step}`,
            status: stepInternal >= 100 ? 'done' as const : 'running' as const,
          };
          const filtered = st.stepHistory.filter(h => h.step !== step);
          return {
            ...st,
            currentStep: step,
            status: stepInternal >= 100 && step === 'SUBMIT_TO_JUDGE' ? 'done' : 'running',
            stepHistory: [...filtered, newStep],
          };
        }),
        updatedAt: now,
      };
      updated.progress = calcRootProgress(updated);
      return { tasks: { ...s.tasks, [chatId]: updated } };
    });
  },

  completeSubTask: (rootTaskId: string, subTaskId: string, result?: string) => {
    set(s => {
      const entry = Object.entries(s.tasks).find(([, t]) => t.id === rootTaskId);
      if (!entry) return s;
      const [chatId, task] = entry;
      const now = Date.now();
      const updated = {
        ...task,
        subTasks: task.subTasks.map(st =>
          st.id === subTaskId
            ? { ...st, status: 'done' as const, progress: 100, result, completedAt: now }
            : st
        ),
        updatedAt: now,
      };
      updated.progress = calcRootProgress(updated);
      return { tasks: { ...s.tasks, [chatId]: updated } };
    });
  },

  addAuditFinding: (rootTaskId: string, finding: AuditFinding) => {
    set(s => {
      const entry = Object.entries(s.tasks).find(([, t]) => t.id === rootTaskId);
      if (!entry) return s;
      const [chatId, task] = entry;
      const audit: AuditTask = task.auditTask ?? {
        id: uid('audit'),
        rootTaskId,
        auditorType: 'sub_agent',
        status: 'reviewing',
        findings: [],
        progress: 0,
      };
      return {
        tasks: {
          ...s.tasks,
          [chatId]: {
            ...task,
            auditTask: {
              ...audit,
              findings: [...audit.findings, finding],
              progress: Math.min(100, audit.progress + 20),
            },
            updatedAt: Date.now(),
          },
        },
      };
    });
  },

  transitionTaskPhase: (rootTaskId: string, phase: TaskPhase) => {
    set(s => {
      const entry = Object.entries(s.tasks).find(([, t]) => t.id === rootTaskId);
      if (!entry) return s;
      const [chatId, task] = entry;
      const next = transitionPhase(task.phase, phase);
      if (!next) return s;
      return {
        tasks: {
          ...s.tasks,
          [chatId]: { ...task, phase: next, updatedAt: Date.now() },
        },
      };
    });
  },

  getTask: (chatId: string) => {
    return get().tasks[chatId];
  },

  clearChat: (chatId: string) => {
    set(s => {
      const removed = s.tasks[chatId];
      if (!removed && !s.streamTaskMeta[chatId] && !s.agentsMap[chatId]) return s;
      const { [chatId]: _removed, ...restTasks } = s.tasks;
      const { [chatId]: _meta, ...restMeta } = s.streamTaskMeta;
      const { [chatId]: _agents, ...restAgents } = s.agentsMap;
      const existingHistory = s.taskHistory[chatId] ?? [];
      // 同步清掉 promptCardPool 里同 chatId 的所有卡片
      promptCardPool.clearChat(chatId);
      return {
        tasks: restTasks,
        taskHistory: removed ? { ...s.taskHistory, [chatId]: [...existingHistory, removed] } : s.taskHistory,
        streamTaskMeta: restMeta,
        agentsMap: restAgents,
      };
    });
  },

  // ============== 流送元数据管理 (C fix) ==============

  bindStreamTask: (chatId: string, rootTaskId: string) => {
    set(s => ({
      streamTaskMeta: {
        ...s.streamTaskMeta,
        [chatId]: { rootTaskId, subTaskIds: new Map() },
      },
    }));
  },

  bindSubTask: (chatId: string, workerIdx: number, subTaskId: string) => {
    set(s => {
      const cur = s.streamTaskMeta[chatId];
      if (!cur) return s;
      const nextMap = new Map(cur.subTaskIds);
      nextMap.set(workerIdx, subTaskId);
      return {
        streamTaskMeta: {
          ...s.streamTaskMeta,
          [chatId]: { ...cur, subTaskIds: nextMap },
        },
      };
    });
  },

  getSubTaskId: (chatId: string, workerIdx: number) => {
    return get().streamTaskMeta[chatId]?.subTaskIds.get(workerIdx);
  },

  getStreamTaskMeta: (chatId: string) => {
    return get().streamTaskMeta[chatId];
  },

  // ============== R1.1: 子 Agent 池管理 ==============

  addAgent: (chatId: string, agent: SubAgent) => {
    set(s => {
      const list = s.agentsMap[chatId] ?? [];
      // 同 id 重复添加时, 更新 lastActiveAt
      const existing = list.findIndex(a => a.id === agent.id);
      const next = existing >= 0
        ? list.map((a, i) => i === existing ? { ...a, ...agent, lastActiveAt: agent.lastActiveAt } : a)
        : [...list, agent];
      return { agentsMap: { ...s.agentsMap, [chatId]: next } };
    });
  },

  removeAgent: (chatId: string, agentId: string) => {
    set(s => {
      const list = s.agentsMap[chatId];
      if (!list) return s;
      const next = list.filter(a => a.id !== agentId);
      if (next.length === 0) {
        const { [chatId]: _removed, ...rest } = s.agentsMap;
        return { agentsMap: rest };
      }
      return { agentsMap: { ...s.agentsMap, [chatId]: next } };
    });
  },

  getAgents: (chatId: string) => {
    return get().agentsMap[chatId] ?? [];
  },

  getLastSubTaskId: (chatId: string) => {
    const task = get().tasks[chatId];
    if (!task || task.subTasks.length === 0) return undefined;
    return task.subTasks[task.subTasks.length - 1].id;
  },

  // R1.4: 重置整个 store 到初始空状态 (测试用, HMR 用)
  __reset: () => {
    set(() => ({
      tasks: {},
      taskHistory: {},
      mode: 'normal',
      streamTaskMeta: {},
      agentsMap: {},
    }));
  },
}));

// R3.4: dev 模式全局 hook, 给控制台手测用
//   window.__soloForgeStream.getState() / .createTask() / .__reset()
export function installStreamDevHooks(): void {
  if (typeof window === 'undefined') return;
  (window as any).__soloForgeStream = {
    getState: () => useStreamingStore.getState(),
    setState: useStreamingStore.setState,
    getTask: (chatId: string) => useStreamingStore.getState().getTask(chatId),
    createTask: (chatId: string, input = 'dev task', mode: PermissionMode = 'normal') =>
      useStreamingStore.getState().createTask(chatId, input, mode),
    applyEvent: (event: StreamEvent) => useStreamingStore.getState().applyEvent(event),
    __reset: () => useStreamingStore.getState().__reset(),
  };
}

// ==================== P0: 选择器 hooks 清理 ====================
// 以下 hooks 已迁移到 usePartsDerived.ts (从 uiMessageStore.parts 派生):
//   - useTaskByChatId → useRootTaskFromParts
//   - useSubTasksByChatId → useSubTasksFromParts
//   - useAuditTaskByChatId → useAuditTaskFromParts
//   - useTaskPhase / useTaskProgress → useStreamSummary
//   - useDeliverResult → useDeliverResultFromParts
//   - useDelegationLog → useDelegationLogFromParts
//   - useModelActionLog → useModelActionLogFromParts
//   - useTextBuffer → useTextFromParts
//   - useAgentsByChatId → 保留 (控制流字段, 仍从 streamingStore 读)

/** 保留: 子 Agent 池订阅 (控制流字段) */
export const useAgentsByChatId = (chatId: string | null | undefined) =>
  useStreamingStore(useShallow((s) => (chatId ? s.agentsMap[chatId] ?? [] : [])));