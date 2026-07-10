/**
 * persistence.test.ts — 状态持久化测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { streamPersistence } from '../../services/streamPersistence';
import type { RootTask } from '../../types/streaming';

// Mock localStorage for node environment
function createMockLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size; },
  };
}

function makeTask(id: string, chatId: string, phase: RootTask['phase'] = 'EXECUTING'): RootTask {
  return {
    id,
    chatId,
    userInput: 'test task',
    phase,
    progress: 50,
    subTasks: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('StreamPersistenceManager', () => {
  beforeEach(async () => {
    // Mock localStorage
    vi.stubGlobal('localStorage', createMockLocalStorage());
    // Mock indexedDB as undefined (force memory fallback)
    vi.stubGlobal('indexedDB', undefined);

    // Re-import to pick up the mocked globals
    vi.resetModules();
    const { streamPersistence: freshPersistence } = await import('../../services/streamPersistence');
    await freshPersistence.clearAll();
    await freshPersistence.init();
  });

  it('应该在 init 后可用', async () => {
    const { streamPersistence: p } = await import('../../services/streamPersistence');
    const config = p.getConfig();
    expect(config.enabled).toBe(true);
  });

  it('应该支持配置更新', async () => {
    const { streamPersistence: p } = await import('../../services/streamPersistence');
    p.updateConfig({ hotFlushInterval: 5000 });
    expect(p.getConfig().hotFlushInterval).toBe(5000);
  });

  it('应该能 flush 和 restore 热状态', async () => {
    const { streamPersistence: p } = await import('../../services/streamPersistence');
    const tasks: Record<string, RootTask> = {
      'chat-1': makeTask('task-1', 'chat-1', 'EXECUTING'),
    };

    p.scheduleFlush({ tasks });
    p.flushNow();

    const restored = p.restoreHotState();
    expect(restored).not.toBeNull();
    expect(restored!.tasks).toBeDefined();
    expect(restored!.tasks!['chat-1'].id).toBe('task-1');
    expect(restored!.tasks!['chat-1'].phase).toBe('EXECUTING');
  });

  it('应该在没有数据时返回 null', async () => {
    const { streamPersistence: p } = await import('../../services/streamPersistence');
    await p.clearAll();
    const restored = p.restoreHotState();
    expect(restored).toBeNull();
  });

  it('应该能保存和恢复消息 (内存降级)', async () => {
    const { streamPersistence: p } = await import('../../services/streamPersistence');
    await p.init();
    const messages = [
      {
        id: 'msg-1',
        role: 'user' as const,
        parts: [{ type: 'text' as const, text: 'hello' }],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        chatId: 'chat-1',
        status: 'done' as const,
      },
    ];

    await p.saveMessages('chat-1', messages);
    const restored = await p.restoreMessages('chat-1');

    expect(restored).not.toBeNull();
    expect(restored).toHaveLength(1);
    expect(restored![0].id).toBe('msg-1');
  });

  it('应该能追加和读取事件日志', async () => {
    const { streamPersistence: p } = await import('../../services/streamPersistence');
    await p.init();
    const events = [
      { id: 'e1', chatId: 'chat-1', rootTaskId: 'task-1', kind: 'phase_change' as const, content: 'PLANNING', ts: Date.now(), status: 'running' as const },
      { id: 'e2', chatId: 'chat-1', rootTaskId: 'task-1', kind: 'phase_change' as const, content: 'DECOMPOSING', ts: Date.now(), status: 'running' as const },
    ];

    await p.appendEvents('chat-1', events);
    const log = await p.readEventLog('chat-1');

    expect(log).not.toBeNull();
    expect(log).toHaveLength(2);
  });

  it('应该限制事件日志大小', async () => {
    const { streamPersistence: p } = await import('../../services/streamPersistence');
    await p.init();
    p.updateConfig({ maxEventLogSize: 3 });

    // 追加 5 条事件
    for (let i = 0; i < 5; i++) {
      await p.appendEvents('chat-1', [
        { id: `e${i}`, chatId: 'chat-1', rootTaskId: 'task-1', kind: 'text_chunk' as const, content: `chunk-${i}`, ts: Date.now(), status: 'running' as const },
      ]);
    }

    const log = await p.readEventLog('chat-1');
    expect(log).not.toBeNull();
    expect(log).toHaveLength(3); // 限制为 3
  });

  it('应该能清除指定 chatId 的数据', async () => {
    const { streamPersistence: p } = await import('../../services/streamPersistence');
    await p.init();
    await p.saveMessages('chat-1', []);
    await p.appendEvents('chat-1', [
      { id: 'e1', chatId: 'chat-1', rootTaskId: 'task-1', kind: 'phase_change' as const, content: 'PLANNING', ts: Date.now(), status: 'running' as const },
    ]);

    await p.clearChat('chat-1');

    const messages = await p.restoreMessages('chat-1');
    expect(messages).toBeNull();

    const log = await p.readEventLog('chat-1');
    expect(log).toBeNull();
  });
});
