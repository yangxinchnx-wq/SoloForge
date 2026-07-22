import { describe, expect, it } from 'vitest';
import { deriveExecutionView } from '../executionViewModel';
import type { UIPart } from '../../types/messages';

const base = { timestamp: 1 };

describe('deriveExecutionView', () => {
  it('合并乱序的 Agent 生命周期和子任务事件', () => {
    const parts: UIPart[] = [
      { type: 'agent-lifecycle', agentId: 'agent-1', name: '代码 Agent', action: 'created', subTaskId: 'sub-1', ...base },
      { type: 'model-delegation', fromModel: '主模型', toModel: 'worker-model', agentId: 'agent-1', subTaskId: 'sub-1', detail: '分析项目', ...base },
      { type: 'subtask-created', subTaskId: 'sub-1', assigneeModel: 'worker-model', agentId: 'agent-1', description: '分析项目', source: 'llm' },
      { type: 'subtask-step', subTaskId: 'sub-1', step: 'EXECUTE', status: 'running', detail: '开始分析' },
      { type: 'agent-lifecycle', agentId: 'agent-1', name: '代码 Agent', action: 'dissolved', subTaskId: 'sub-1', timestamp: 2 },
    ];

    const view = deriveExecutionView(parts);
    expect(view.agents).toHaveLength(1);
    expect(view.agents[0].id).toBe('sub-1');
    expect(view.agents[0].agentName).toBe('代码 Agent');
    expect(view.agents[0].lifecycle).toBe('dissolved');
    expect(view.delegations).toHaveLength(1);
    expect(view.delegations[0].target).toBe('worker-model');
  });

  it('保留无 subTaskId 的根模型动作', () => {
    const view = deriveExecutionView([
      { type: 'model-action', action: 'planning', detail: '主模型正在规划方案', timestamp: 1 },
      { type: 'phase-change', from: 'CLARIFY', to: 'PLANNING', timestamp: 2 },
    ]);
    expect(view.rootActions).toEqual([
      { id: '1-0', action: 'planning', detail: '主模型正在规划方案', timestamp: 1 },
    ]);
  });

  it('错误子任务保持错误状态，不被 Agent 结束事件覆盖', () => {
    const view = deriveExecutionView([
      { type: 'subtask-created', subTaskId: 'sub-1', assigneeModel: 'worker', agentId: 'agent-1', description: '执行', source: 'tool' },
      { type: 'subtask-step', subTaskId: 'sub-1', step: 'EXECUTE', status: 'error', detail: '调用失败' },
      { type: 'agent-lifecycle', agentId: 'agent-1', action: 'dissolved', subTaskId: 'sub-1', timestamp: 2 },
    ]);
    expect(view.agents[0].status).toBe('error');
  });
});
;
