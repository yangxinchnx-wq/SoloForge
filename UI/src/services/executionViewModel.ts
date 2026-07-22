import type {
  UIPart,
  UIModelDelegationPart,
  UIModelActionPart,
  UIAgentLifecyclePart,
  UISubTaskCreatedPart,
  UISubTaskDonePart,
  UISubTaskProgressPart,
  UISubTaskStepPart,
  UITextPart,
  UIAuditFindingPart,
} from '../types/messages';
import type { SubTaskSource, SubTaskStep, TaskPhase } from '../types/streaming';

export type ExecutionStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

export interface ExecutionStepView {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  progress?: number;
  detail?: string;
}

export interface AgentExecutionView {
  id: string;
  caller: string;
  agentId?: string;
  agentName?: string;
  agentAvatar?: string;
  model: string;
  task: string;
  source: SubTaskSource;
  status: ExecutionStatus;
  progress: number;
  steps: ExecutionStepView[];
  latestActivity?: string;
  output?: string;
  lifecycle?: 'created' | 'dissolved';
}

export interface RootModelActionView {
  id: string;
  action: string;
  detail?: string;
  timestamp: number;
}

export interface DelegationView {
  id: string;
  caller: string;
  target: string;
  agentId?: string;
  subTaskId?: string;
  task?: string;
  timestamp: number;
}

export interface ReviewView {
  started: boolean;
  completed: boolean;
  findings: UIAuditFindingPart['finding'][];
}

export interface ExecutionViewModel {
  phase: TaskPhase;
  headline: string;
  progress: number;
  agents: AgentExecutionView[];
  delegations: DelegationView[];
  review: ReviewView;
  rootActions: RootModelActionView[];
  delivery?: string;
  error?: string;
  totalText: number;
}

const STEP_LABELS: Record<SubTaskStep, string> = {
  READ_TASK: '分析需求',
  UNDERSTAND: '理解目标',
  DECIDE: '制定方案',
  EXECUTE: '执行任务',
  COMPLETE: '整理结果',
  SUBMIT_TO_JUDGE: '提交检查',
};

const PHASE_HEADLINES: Record<TaskPhase, string> = {
  CLARIFY: '正在确认需求',
  PLANNING: '正在规划方案',
  DECOMPOSING: '正在拆解任务',
  DISPATCHING: '正在分配工作',
  EXECUTING: 'Agent 正在执行',
  REVIEWING: '正在检查结果',
  AUDITING: '正在进行质量检查',
  DELIVERING: '正在整理结果',
  SINGLE_MODEL: '正在处理任务',
  DONE: '任务已完成',
  ERROR: '执行遇到问题',
};

function statusFromProgress(progress: number): ExecutionStatus {
  return progress >= 100 ? 'done' : progress > 0 ? 'running' : 'pending';
}

function ensureLifecycleAgent(map: Map<string, AgentExecutionView>, part: UIAgentLifecyclePart): AgentExecutionView {
  const id = part.subTaskId || `agent:${part.agentId}`;
  const existing = map.get(id);
  if (existing) return existing;
  const agent: AgentExecutionView = {
    id,
    caller: '主模型',
    agentId: part.agentId,
    agentName: part.name,
    agentAvatar: part.avatar,
    model: '',
    task: '准备执行工作',
    source: 'llm',
    status: 'pending',
    progress: 0,
    steps: [],
    lifecycle: part.action,
    latestActivity: part.action === 'created' ? 'Agent 已创建' : 'Agent 已结束',
  };
  map.set(id, agent);
  return agent;
}

function ensureAgent(map: Map<string, AgentExecutionView>, part: UISubTaskCreatedPart): AgentExecutionView {
  const id = part.subTaskId || `task-${map.size}`;
  const existing = map.get(id) || (part.agentId
    ? [...map.values()].find(agent => agent.agentId === part.agentId)
    : undefined);
  if (existing) {
    if (part.subTaskId && existing.id !== part.subTaskId) {
      map.delete(existing.id);
      map.set(part.subTaskId, existing);
      existing.id = part.subTaskId;
    }
    return existing;
  }
  const agent: AgentExecutionView = {
    id,
    caller: part.assigneeModel || '主模型',
    agentId: part.agentId,
    model: part.assigneeModel || '',
    task: part.description || '执行工作项',
    source: part.source,
    status: 'pending',
    progress: 0,
    steps: [],
  };
  map.set(id, agent);
  return agent;
}

function applyStep(agent: AgentExecutionView, part: UISubTaskStepPart | UISubTaskProgressPart): void {
  const step = 'step' in part ? part.step : part.step;
  if (!step) return;
  const progress = 'progress' in part ? part.progress : agent.progress;
  const status = 'status' in part
    ? part.status
    : progress >= 100 ? 'done' : 'running';
  const id = String(step);
  const next: ExecutionStepView = {
    id,
    label: STEP_LABELS[step] ?? '正在处理',
    status,
    progress,
    detail: part.detail,
  };
  const index = agent.steps.findIndex(item => item.id === id);
  agent.steps = index >= 0
    ? agent.steps.map((item, i) => i === index ? { ...item, ...next } : item)
    : [...agent.steps, next];
  agent.progress = Math.max(agent.progress, progress ?? 0);
  agent.status = status === 'error' ? 'error' : statusFromProgress(agent.progress);
  agent.latestActivity = part.detail || next.label;
}

export function deriveExecutionView(
  parts: UIPart[] | undefined,
  agentNames?: Record<string, { name?: string; avatar?: string }>,
  phase: TaskPhase = 'CLARIFY',
): ExecutionViewModel {
  const agents = new Map<string, AgentExecutionView>();
  const delegations: DelegationView[] = [];
  const rootActions: RootModelActionView[] = [];
  const review: ReviewView = { started: false, completed: false, findings: [] };
  let currentPhase = phase;
  let delivery: string | undefined;
  let error: string | undefined;
  let totalText = 0;

  for (const part of parts ?? []) {
    switch (part.type) {
      case 'phase-change':
        currentPhase = part.to;
        break;
      case 'subtask-created': {
        const agent = ensureAgent(agents, part);
        agent.task = part.description || agent.task;
        agent.model = part.assigneeModel || agent.model;
        agent.caller = part.assigneeModel || agent.caller;
        agent.source = part.source;
        break;
      }
      case 'subtask-progress': {
        const agent = agents.get(part.subTaskId);
        if (agent) applyStep(agent, part);
        break;
      }
      case 'subtask-step': {
        const agent = agents.get(part.subTaskId);
        if (agent) applyStep(agent, part);
        break;
      }
      case 'subtask-done': {
        const agent = agents.get(part.subTaskId);
        if (agent) {
          agent.status = part.status;
          agent.progress = part.status === 'done' ? 100 : agent.progress;
          agent.output = part.result;
          agent.latestActivity = part.status === 'done' ? '工作已完成' : '执行未完成';
        }
        break;
      }
      case 'model-delegation':
        delegations.push({
          id: `${part.timestamp}-${delegations.length}`,
          caller: part.fromModel || '主模型',
          target: part.toModel || 'Agent',
          agentId: part.agentId,
          subTaskId: part.subTaskId,
          task: part.detail,
          timestamp: part.timestamp,
        });
        break;
      case 'model-action': {
        const agent = part.subTaskId ? agents.get(part.subTaskId) : undefined;
        if (agent) agent.latestActivity = part.detail || part.action;
        else rootActions.push({
          id: `${part.timestamp}-${rootActions.length}`,
          action: part.action,
          detail: part.detail,
          timestamp: part.timestamp,
        });
        break;
      }
      case 'agent-lifecycle': {
        const agent = ensureLifecycleAgent(agents, part);
        agent.agentId = part.agentId;
        if (part.name) agent.agentName = part.name;
        if (part.avatar) agent.agentAvatar = part.avatar;
        agent.lifecycle = part.action;
        agent.latestActivity = part.action === 'created' ? 'Agent 已创建' : 'Agent 已结束';
        if (part.action === 'dissolved' && agent.status !== 'error' && agent.status !== 'done') {
          agent.status = 'cancelled';
        }
        break;
      }
      case 'text':
        totalText += part.text.length;
        if (part.subTaskId) {
          const agent = agents.get(part.subTaskId);
          if (agent) agent.output = `${agent.output ?? ''}${part.text}`;
        }
        break;
      case 'audit-start':
        review.started = true;
        break;
      case 'audit-finding':
        review.findings.push(part.finding);
        break;
      case 'audit-done':
        review.completed = true;
        break;
      case 'delivery':
        delivery = part.result;
        break;
      case 'error':
        error = part.message;
        break;
    }
  }

  const hydratedAgents = [...agents.values()].map(agent => ({
    ...agent,
    agentName: agent.agentName || (agent.agentId ? agentNames?.[agent.agentId]?.name : undefined),
    agentAvatar: agent.agentAvatar || (agent.agentId ? agentNames?.[agent.agentId]?.avatar : undefined),
  }));
  const progress = hydratedAgents.length === 0
    ? currentPhase === 'DONE' ? 100 : 0
    : Math.round(hydratedAgents.reduce((sum, agent) => sum + agent.progress, 0) / hydratedAgents.length);

  return {
    phase: currentPhase,
    headline: PHASE_HEADLINES[currentPhase] ?? '正在处理任务',
    progress,
    agents: hydratedAgents,
    delegations,
    review,
    rootActions,
    delivery,
    error,
    totalText,
  };
}

export function getDelegationForAgent(view: ExecutionViewModel, agent: AgentExecutionView): DelegationView | undefined {
  return view.delegations.find(item => item.agentId === agent.agentId) ||
    view.delegations.find(item => item.target === agent.model && item.task === agent.task);
}
