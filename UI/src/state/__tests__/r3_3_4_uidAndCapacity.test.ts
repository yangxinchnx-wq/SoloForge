/**
 * R3.3 + R3.4 测试
 * R3.3: uid 改用 crypto.randomUUID()
 * R3.4: dev 出口 (eventBuffer 容量配置已随死代码清理移除)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStreamingStore, installStreamDevHooks } from '../streamingStore';

beforeEach(() => {
  useStreamingStore.getState().__reset();
});

describe('R3.3: uid 唯一性', () => {
  it('createTask 生成的 rootTaskId 不重复', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const t = useStreamingStore.getState().createTask(`c-${i}`, 'task', 'normal');
      ids.add(t.id);
    }
    expect(ids.size).toBe(50);
  });

  it('streamTaskMeta[chatId].rootTaskId 与 createTask 返回的 id 一致', () => {
    const t = useStreamingStore.getState().createTask('c1', 'x', 'normal');
    const meta = useStreamingStore.getState().streamTaskMeta['c1'];
    expect(meta).toBeDefined();
    expect(meta!.rootTaskId).toBe(t.id);
  });

  it('id 包含有意义的前缀 (可读性)', () => {
    const t = useStreamingStore.getState().createTask('c1', 'x', 'normal');
    expect(t.id).toMatch(/^task-/);
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
  });

  it('hook.getState 返回的 store 与 useStreamingStore 同一份', () => {
    if (typeof window === 'undefined') return;
    installStreamDevHooks();
    const hook = (window as any).__soloForgeStream;
    expect(hook.getState()).toBe(useStreamingStore.getState());
  });

  it('hook.createTask 创建任务后, streamTaskMeta 有值', () => {
    if (typeof window === 'undefined') return;
    installStreamDevHooks();
    const hook = (window as any).__soloForgeStream;
    const task = hook.createTask('dev-chat', 'dev input', 'normal');
    expect(task.id).toMatch(/^task-/);
    const meta = useStreamingStore.getState().streamTaskMeta['dev-chat'];
    expect(meta).toBeDefined();
    expect(meta!.rootTaskId).toBe(task.id);
    expect(meta!.userInput).toBe('dev input');
  });

  it('hook.__reset 清空整个 store', () => {
    if (typeof window === 'undefined') return;
    installStreamDevHooks();
    const hook = (window as any).__soloForgeStream;
    hook.createTask('c-x', 'x', 'normal');
    expect(Object.keys(useStreamingStore.getState().streamTaskMeta)).toContain('c-x');
    hook.__reset();
    expect(Object.keys(useStreamingStore.getState().streamTaskMeta)).toEqual([]);
  });

  it('多次调用 installStreamDevHooks 安全 (幂等)', () => {
    if (typeof window === 'undefined') return;
    installStreamDevHooks();
    installStreamDevHooks();
    installStreamDevHooks();
    expect((window as any).__soloForgeStream).toBeDefined();
  });
});
