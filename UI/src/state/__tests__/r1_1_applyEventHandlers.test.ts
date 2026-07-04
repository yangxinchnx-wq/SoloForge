/**
 * R1.1 专项测试: 21 个新增 StreamEventKind handler
 * 覆盖 model/audit/clarify/delivery/agent/browser/tool 全部新事件
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStreamingStore } from '../streamingStore';
import { promptCardPool } from '../../services/promptCardPool';
import type { StreamEvent, StreamEventKind } from '../../types/streaming';

function makeEvt(partial: Partial<StreamEvent>): StreamEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    chatId: 'c1',
    rootTaskId: 't',
    kind: 'phase_change',
    content: '',
    ts: Date.now(),
    status: 'running',
    ...partial,
  };
}

beforeEach(() => {
  useStreamingStore.getState().__reset();
  promptCardPool.__reset();
  useStreamingStore.getState().createTask('c1', 'test', 'normal');
});

describe('R1.1: Model family', () => {
  it('model_delegation: 追加到 delegationLog', () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'model_delegation',
      content: 'main → Qwen 2.5', detail: '搜索资料',
    }));
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'model_delegation',
      content: 'main → Kimi K2', detail: '长文总结',
    }));
    const log = useStreamingStore.getState().tasks.c1.delegationLog;
    expect(log).toHaveLength(2);
    expect(log![0]).toContain('main → Qwen 2.5');
    expect(log![1]).toContain('main → Kimi K2');
  });

  it('model_action: 追加到 modelActionLog', () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'model_action',
      content: '思考步骤 1', detail: '分析输入',
    }));
    const log = useStreamingStore.getState().tasks.c1.modelActionLog;
    expect(log).toHaveLength(1);
    expect(log![0]).toContain('思考步骤 1');
    expect(log![0]).toContain('分析输入');
  });

  it('model_action 指定 subTaskId 时同步写入子任务 stepHistory', () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'subtask_created',
      content: 'A', detail: 'desc', agentId: 'a-0',
    }));
    const subId = useStreamingStore.getState().tasks.c1.subTasks[0].id;
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'model_action', subTaskId: subId,
      content: '调用工具', detail: 'web_search',
    }));
    const sub = useStreamingStore.getState().tasks.c1.subTasks[0];
    // 至少 1 条 stepHistory (model_action 写入)
    expect(sub.stepHistory.length).toBeGreaterThan(0);
    const lastStep = sub.stepHistory[sub.stepHistory.length - 1];
    expect(lastStep.detail).toContain('调用工具');
  });
});

describe('R1.1: Audit family', () => {
  it('audit_start: 创建 auditTask (sub_agent)', () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'audit_start',
      content: 'sub_agent', detail: 'auditor 1', agentId: 'aud-1',
    }));
    const audit = useStreamingStore.getState().tasks.c1.auditTask;
    expect(audit).toBeDefined();
    expect(audit!.auditorType).toBe('sub_agent');
    expect(audit!.agentId).toBe('aud-1');
    expect(audit!.status).toBe('reviewing');
    expect(audit!.findings).toEqual([]);
  });

  it('audit_start: content="main_model" 时 auditorType=main_model', () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'audit_start', content: 'main_model',
    }));
    expect(useStreamingStore.getState().tasks.c1.auditTask!.auditorType).toBe('main_model');
  });

  it('audit_finding: severity 映射 status → info/warning/error', () => {
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'audit_start', content: 'main_model' }));
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'audit_finding', content: 'sub-1', detail: '建议优化', status: 'success',
    }));
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'audit_finding', content: 'sub-2', detail: '有性能风险', status: 'running',
    }));
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'audit_finding', content: 'sub-3', detail: '逻辑错误', status: 'error',
    }));
    const findings = useStreamingStore.getState().tasks.c1.auditTask!.findings;
    expect(findings).toHaveLength(3);
    expect(findings[0].severity).toBe('info');
    expect(findings[1].severity).toBe('warning');
    expect(findings[2].severity).toBe('error');
  });

  it('audit_done: 标 status=done, progress=100', () => {
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'audit_start', content: 'main_model' }));
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'audit_finding', content: 'sub-1', detail: 'good', status: 'success',
    }));
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'audit_done', content: 'all good' }));
    const audit = useStreamingStore.getState().tasks.c1.auditTask!;
    expect(audit.status).toBe('done');
    expect(audit.progress).toBe(100);
    expect(audit.findings).toHaveLength(1);
  });

  it('audit_done 对没有 auditTask 的情况静默跳过', () => {
    expect(() => {
      useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'audit_done', content: 'x' }));
    }).not.toThrow();
    expect(useStreamingStore.getState().tasks.c1.auditTask).toBeUndefined();
  });
});

describe('R1.1: Clarify family', () => {
  it('clarify_request: 创建 blocking 卡片', () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'clarify_request', content: '你想用哪种颜色?',
    }));
    const cards = promptCardPool.getActive('c1');
    expect(cards).toHaveLength(1);
    expect(cards[0].spec.type).toBe('clarification');
    expect(cards[0].spec.priority).toBe('blocking');
    expect(cards[0].spec.message).toBe('你想用哪种颜色?');
  });

  it('clarify_request: 包含 urgent 时 countdown=30', () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'clarify_request', content: '紧急问题', detail: 'urgent',
    }));
    const cards = promptCardPool.getActive('c1');
    expect(cards[0].spec.countdown).toBe(30);
  });

  it('clarify_response: 追加到 clarifyHistory', () => {
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'clarify_response', content: '蓝色' }));
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'clarify_response', content: '不, 红色' }));
    const history = useStreamingStore.getState().tasks.c1.clarifyHistory;
    expect(history).toEqual(['蓝色', '不, 红色']);
  });
});

describe('R1.1: Delivery', () => {
  it('delivery: 写 deliverResult + 尝试 phase=DONE', () => {
    // 先走到 DELIVERING
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'phase_change', content: 'EXECUTING' }));
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'phase_change', content: 'REVIEWING' }));
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'phase_change', content: 'DELIVERING' }));
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'delivery', content: '这是最终结果',
    }));
    const t = useStreamingStore.getState().tasks.c1;
    expect(t.deliverResult).toBe('这是最终结果');
    expect(t.phase).toBe('DONE');
  });

  it('delivery: 阶段非法 (CLARIFY) 时, 内容写入但 phase 保持', () => {
    // 不切 phase, 直接 delivery
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'delivery', content: '部分结果' }));
    const t = useStreamingStore.getState().tasks.c1;
    expect(t.deliverResult).toBe('部分结果');
    // CLARIFY 不能直接到 DONE, 保持 CLARIFY
    expect(t.phase).toBe('CLARIFY');
  });
});

describe('R1.1: Agent family', () => {
  it('agent_created: 创建 SubAgent (auditor)', () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'agent_created',
      content: 'aud-1', detail: 'auditor', agentId: 'parent-m',
    }));
    const agents = useStreamingStore.getState().getAgents('c1');
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe('aud-1');
    expect(agents[0].role).toBe('auditor');
    expect(agents[0].parentModelId).toBe('parent-m');
  });

  it('agent_created: 默认 role=assistant', () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'agent_created', content: 'a-1',
    }));
    expect(useStreamingStore.getState().getAgents('c1')[0].role).toBe('assistant');
  });

  it('agent_dissolved: 移除 SubAgent', () => {
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'agent_created', content: 'a-1' }));
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'agent_dissolved', content: 'a-1' }));
    expect(useStreamingStore.getState().getAgents('c1')).toEqual([]);
  });

  it('agent_created 重复同 id 时更新 lastActiveAt', async () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'agent_created', content: 'a-1', ts: 1000,
    }));
    await new Promise(r => setTimeout(r, 5));
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'agent_created', content: 'a-1', ts: 2000,
    }));
    const agents = useStreamingStore.getState().getAgents('c1');
    expect(agents).toHaveLength(1);
    expect(agents[0].lastActiveAt).toBeGreaterThan(1000);
  });
});

describe('R1.1: Browser family', () => {
  it('browser_task_start: 创建 source=browser-use 的 SubTask', () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'browser_task_start',
      content: 'bt-1', detail: 'https://example.com',
    }));
    const t = useStreamingStore.getState().tasks.c1;
    expect(t.subTasks).toHaveLength(1);
    const sub = t.subTasks[0];
    expect(sub.source).toBe('browser-use');
    expect(sub.status).toBe('running');
    expect(sub.browserTaskId).toBe('bt-1');
    expect(sub.browserUrl).toBe('https://example.com');
    expect(sub.currentStepIndex).toBe(0);
  });

  it('browser_task_start: 同 browserTaskId 重复触发时去重', () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'browser_task_start', content: 'bt-1', detail: 'https://x.com',
    }));
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'browser_task_start', content: 'bt-1', detail: 'https://x.com',
    }));
    expect(useStreamingStore.getState().tasks.c1.subTasks).toHaveLength(1);
  });

  it('browser_task_step: 推进 currentStepIndex + 写 stepHistory', () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'browser_task_start', content: 'bt-1',
    }));
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'browser_task_step',
      content: 'bt-1', detail: '点击登录按钮', progress: 20,
    }));
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'browser_task_step',
      content: 'bt-1', detail: '输入用户名', progress: 40,
    }));
    const sub = useStreamingStore.getState().tasks.c1.subTasks[0];
    expect(sub.currentStepIndex).toBe(2);
    expect(sub.progress).toBe(40);
    expect(sub.stepHistory.length).toBe(2);
  });

  it('browser_task_screenshot: 写 screenshot_b64', () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'browser_task_start', content: 'bt-1',
    }));
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'browser_task_screenshot',
      content: 'bt-1', detail: 'iVBORw0KGgo...',
    }));
    const sub = useStreamingStore.getState().tasks.c1.subTasks[0];
    expect(sub.screenshot_b64).toBe('iVBORw0KGgo...');
  });

  it('browser_task_done: 标 done + progress=100', () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'browser_task_start', content: 'bt-1',
    }));
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'browser_task_done', content: 'bt-1', detail: '登录成功',
    }));
    const sub = useStreamingStore.getState().tasks.c1.subTasks[0];
    expect(sub.status).toBe('done');
    expect(sub.progress).toBe(100);
    expect(sub.result).toBe('登录成功');
    expect(sub.completedAt).toBeGreaterThan(0);
  });

  it('browser_task_error: 标 error', () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'browser_task_start', content: 'bt-1',
    }));
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'browser_task_error', content: 'bt-1', detail: '页面超时',
    }));
    const sub = useStreamingStore.getState().tasks.c1.subTasks[0];
    expect(sub.status).toBe('error');
    expect(sub.result).toBe('页面超时');
  });

  it('browser_task_cancelled: 标 cancelled', () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'browser_task_start', content: 'bt-1',
    }));
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'browser_task_cancelled', content: 'bt-1', detail: '用户取消',
    }));
    const sub = useStreamingStore.getState().tasks.c1.subTasks[0];
    expect(sub.status).toBe('cancelled');
    expect(sub.completedAt).toBeGreaterThan(0);
  });

  it('browser_enable_request: 创建 non_blocking 卡片', () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'browser_enable_request',
      content: '需要打开外部链接', detail: 'https://example.com',
    }));
    const cards = promptCardPool.getActive('c1');
    expect(cards).toHaveLength(1);
    expect(cards[0].spec.type).toBe('browser_tool_enable');
    expect(cards[0].spec.priority).toBe('non_blocking');
    expect(cards[0].spec.context.url).toBe('https://example.com');
  });
});

describe('R1.1: Tool family', () => {
  it('tool_suggestion: 创建 tool_suggestion 卡片', () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'tool_suggestion',
      content: 'web_search', detail: '搜索最新资料',
    }));
    const cards = promptCardPool.getActive('c1');
    expect(cards).toHaveLength(1);
    expect(cards[0].spec.type).toBe('tool_suggestion');
    expect(cards[0].spec.context.tool).toBe('web_search');
  });

  it('tool_enabled: 追加到 modelActionLog', () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'tool_enabled', content: 'web_search', detail: '深度搜索',
    }));
    const log = useStreamingStore.getState().tasks.c1.modelActionLog;
    expect(log).toHaveLength(1);
    expect(log![0]).toContain('web_search');
  });

  it('tool_skipped: 追加到 modelActionLog', () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'tool_skipped', content: 'web_search', detail: '用户跳过',
    }));
    const log = useStreamingStore.getState().tasks.c1.modelActionLog;
    expect(log![0]).toContain('跳过');
  });

  it('tool_timeout: 追加到 modelActionLog', () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'tool_timeout', content: 'web_search', detail: '30s',
    }));
    const log = useStreamingStore.getState().tasks.c1.modelActionLog;
    expect(log![0]).toContain('超时');
  });

  it('tool_suggestion cooldown 去重: 同 groupKey 冷却期内不重复弹', async () => {
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'tool_suggestion', content: 'web_search', detail: 'd1',
    }));
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'tool_suggestion', content: 'web_search', detail: 'd2',
    }));
    // cooldown 15s 内, 第二次被静默
    expect(promptCardPool.getActive('c1')).toHaveLength(1);
  });
});

describe('R1.1: 全部 kind 都有 handler (穷尽性检查)', () => {
  // 这个测试同时充当"未来加新 kind 时漏改 applyEvent"的回归守门
  const allKinds: StreamEventKind[] = [
    'task_created', 'phase_change', 'subtask_created', 'subtask_step', 'subtask_progress', 'subtask_done',
    'model_delegation', 'model_action',
    'audit_start', 'audit_finding', 'audit_done',
    'clarify_request', 'clarify_response',
    'delivery',
    'agent_created', 'agent_dissolved',
    'browser_task_start', 'browser_task_step', 'browser_task_screenshot',
    'browser_task_done', 'browser_task_error', 'browser_task_cancelled',
    'browser_enable_request',
    'tool_suggestion', 'tool_enabled', 'tool_skipped', 'tool_timeout',
    'error',
  ];
  it.each(allKinds)('kind=%s 不会让 store 抛错 (handler 存在或 default 兜底)', (kind) => {
    expect(() => {
      useStreamingStore.getState().applyEvent(makeEvt({
        chatId: 'c1', kind, content: 'x', detail: 'd',
      }));
    }).not.toThrow();
  });
});
