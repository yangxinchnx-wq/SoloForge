/**
 * R3.3 + R3.4 测试
 * R3.3: uid 改用 crypto.randomUUID()
 * R3.4: eventBuffer 容量可配置 + dev 出口
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStreamingStore } from '../streamingStore';
import { setBufferCapacity, getBufferCapacity, DEFAULT_BUFFER_CAPACITY } from '../streamingStore';
import { installStreamDevHooks } from '../streamingStore';

function makeEvt(content: string) {
  return {
    id: `e-${Math.random()}`,
    chatId: 'c1',
    rootTaskId: 't',
    kind: 'phase_change' as const,
    content,
    ts: Date.now(),
    status: 'running' as const,
  };
}

beforeEach(() => {
  useStreamingStore.getState().__reset();
  setBufferCapacity(DEFAULT_BUFFER_CAPACITY);
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

describe('R3.4: eventBuffer 容量可配置', () => {
  it('默认容量 = 500', () => {
    expect(getBufferCapacity()).toBe(500);
    expect(DEFAULT_BUFFER_CAPACITY).toBe(500);
  });

  it('setBufferCapacity 动态调整', () => {
    setBufferCapacity(100);
    expect(getBufferCapacity()).toBe(100);
    setBufferCapacity(1000);
    expect(getBufferCapacity()).toBe(1000);
  });

  it('setBufferCapacity < 10 时兜底为 10', () => {
    setBufferCapacity(1);
    expect(getBufferCapacity()).toBe(10);
    setBufferCapacity(-5);
    expect(getBufferCapacity()).toBe(10);
  });

  it('容量生效: 100 时超 100 自动丢弃最早的', () => {
    setBufferCapacity(100);
    useStreamingStore.getState().createTask('c1', 'x', 'normal');
    for (let i = 0; i < 150; i++) {
      useStreamingStore.getState().applyEvent(makeEvt(`EVT-${i}`));
    }
    const buf = useStreamingStore.getState().eventBuffer.c1;
    expect(buf.length).toBe(100);
    expect(buf[0].content).toBe('EVT-50');
    expect(buf[99].content).toBe('EVT-149');
  });

  it('容量调小: 已存在 buffer 不会被自动截断, 但后续 append 仍按新容量', () => {
    setBufferCapacity(500);
    useStreamingStore.getState().createTask('c1', 'x', 'normal');
    for (let i = 0; i < 200; i++) {
      useStreamingStore.getState().applyEvent(makeEvt(`A-${i}`));
    }
    expect(useStreamingStore.getState().eventBuffer.c1).toHaveLength(200);

    // 调小到 50
    setBufferCapacity(50);
    for (let i = 0; i < 30; i++) {
      useStreamingStore.getState().applyEvent(makeEvt(`B-${i}`));
    }
    // 总数应 <= 50 (从末尾保留)
    const buf = useStreamingStore.getState().eventBuffer.c1;
    expect(buf.length).toBe(50);
    expect(buf[49].content).toBe('B-29');
  });
});

describe('R3.4: dev 出口 (window.__streamStore)', () => {
  it('在 jsdom/node 环境跳过, 仅在浏览器跑', () => {
    // 浏览器环境才验证 window.__streamStore
    // node 环境跳过 (无 window 对象)
    if (typeof window === 'undefined') return;
    (window as any).__streamStore = useStreamingStore;
    expect((window as any).__streamStore).toBe(useStreamingStore);
    expect((window as any).__streamStore.getState().tasks).toBeDefined();
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
    expect(typeof hook.setBufferCapacity).toBe('function');
    expect(typeof hook.getBufferCapacity).toBe('function');
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

  it('hook.setBufferCapacity / getBufferCapacity 与顶层导出同步', () => {
    if (typeof window === 'undefined') return;
    installStreamDevHooks();
    const hook = (window as any).__soloForgeStream;
    hook.setBufferCapacity(42);
    expect(hook.getBufferCapacity()).toBe(42);
    expect(getBufferCapacity()).toBe(42);
  });

  it('多次调用 installStreamDevHooks 安全 (幂等)', () => {
    if (typeof window === 'undefined') return;
    installStreamDevHooks();
    installStreamDevHooks();
    installStreamDevHooks();
    expect((window as any).__soloForgeStream).toBeDefined();
  });
});
