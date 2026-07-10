/**
 * R3.3 + R3.4 测试
 * R3.3: uid 改用 crypto.randomUUID()
 * R3.4: dev 出口 (eventBuffer 容量配置已随死代码清理移除)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStreamingStore } from '../streamingStore';
import { installStreamDevHooks } from '../streamingStore';

beforeEach(() => {
  useStreamingStore.getState().__reset();
});

describe('R3.3: uid 唯一性', () => {
  it('createTask 生成的 id 不重复', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const t = useStreamingStore.getState().createTask(`c-${i}`, 'task', 'normal');
      ids.add(t.id);
    }
    expect(ids.size).toBe(50);
  });

  it('subtask_created 多次创建, id 不重复', () => {
    useStreamingStore.getState().createTask('c1', 'x', 'normal');
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      useStreamingStore.getState().applyEvent({
        id: `e-${i}`,
        chatId: 'c1',
        rootTaskId: useStreamingStore.getState().tasks.c1.id,
        kind: 'subtask_created',
        content: `model-${i}`,
        detail: 'd',
        ts: Date.now(),
        status: 'running',
      });
      const sub = useStreamingStore.getState().tasks.c1.subTasks[i];
      ids.add(sub.id);
    }
    expect(ids.size).toBe(50);
  });

  it('id 包含有意义的前缀 (可读性)', () => {
    const t = useStreamingStore.getState().createTask('c1', 'x', 'normal');
    expect(t.id).toMatch(/^task-/);
  });

  it('audit_task 的 id 包含 "audit" 前缀', () => {
    useStreamingStore.getState().createTask('c1', 'x', 'normal');
    useStreamingStore.getState().applyEvent({
      id: 'e1', chatId: 'c1', rootTaskId: useStreamingStore.getState().tasks.c1.id,
      kind: 'audit_start', content: 'main_model', ts: Date.now(), status: 'running',
    });
    expect(useStreamingStore.getState().tasks.c1.auditTask!.id).toMatch(/^audit-/);
  });
});

describe('R3.4: installStreamDevHooks 挂载到 window', () => {
  beforeEach(() => {
    if (typeof window !== 'undefined') {
      delete (window as any).__soloForgeStream;
    }
  });

  it('在浏览器环境挂载 __soloForgeStream 全局对象', () => {
    if (typeof window === 'undefined') return;
    installStreamDevHooks();
    const hook = (window as any).__soloForgeStream;
    expect(hook).toBeDefined();
    expect(typeof hook.getState).toBe('function');
    expect(typeof hook.createTask).toBe('function');
    expect(typeof hook.__reset).toBe('function');
    expect(typeof hook.getTask).toBe('function');
  });

  it('hook.getState 返回的 store 与 useStreamingStore 同一份', () => {
    if (typeof window === 'undefined') return;
    installStreamDevHooks();
    const hook = (window as any).__soloForgeStream;
    expect(hook.getState()).toBe(useStreamingStore.getState());
  });

  it('hook.createTask 创建任务, 可通过 hook.getTask 取回', () => {
    if (typeof window === 'undefined') return;
    installStreamDevHooks();
    const hook = (window as any).__soloForgeStream;
    const task = hook.createTask('dev-chat', 'dev input', 'normal');
    expect(task.id).toMatch(/^task-/);
    expect(hook.getTask('dev-chat')?.id).toBe(task.id);
  });

  it('hook.__reset 清空整个 store', () => {
    if (typeof window === 'undefined') return;
    installStreamDevHooks();
    const hook = (window as any).__soloForgeStream;
    hook.createTask('c-x', 'x', 'normal');
    expect(Object.keys(useStreamingStore.getState().tasks)).toContain('c-x');
    hook.__reset();
    expect(Object.keys(useStreamingStore.getState().tasks)).toEqual([]);
  });

  it('多次调用 installStreamDevHooks 安全 (幂等)', () => {
    if (typeof window === 'undefined') return;
    installStreamDevHooks();
    installStreamDevHooks();
    installStreamDevHooks();
    expect((window as any).__soloForgeStream).toBeDefined();
  });
});
