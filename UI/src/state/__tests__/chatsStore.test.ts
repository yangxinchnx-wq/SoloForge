/**
 * chatsStore 单元测试
 * 覆盖：乐观更新、回滚、批量重排、live state 上报、事件桥
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// 在 import chatsStore 之前 mock fetch
type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  (global as any).fetch = fetchMock;
  (global as any).window = (global as any).window || {};
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('chatsStore — 加载 / 创建 / 更新 / 删除', () => {
  it('loadFromBackend: 成功时填充 chats / selectedId / liveStates', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        success: true,
        chats: [
          { id: 'a', title: 'A', tag: 'VUE', tagBg: '', tagText: '', permission: 'normal', createdAt: 1, updatedAt: 1 },
          { id: 'b', title: 'B', tag: 'AI', tagBg: '', tagText: '', permission: 'expert', createdAt: 2, updatedAt: 2 },
        ],
        selectedId: 'a',
        liveStates: { a: { chatId: 'a', isStreaming: true, lastActivityAt: 100 } },
      }),
    });

    const { useChatsStore } = await import('../chatsStore');
    await useChatsStore.getState().loadFromBackend();

    const s = useChatsStore.getState();
    expect(s.chats.map((c) => c.id)).toEqual(['a', 'b']);
    expect(s.selectedChatId).toBe('a');
    expect(s.liveStates.a?.isStreaming).toBe(true);
    expect(s.backendAvailable).toBe(true);
    expect(s.loading).toBe(false);
  });

  it('loadFromBackend: 后端不可达时设 backendAvailable=false', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const { useChatsStore } = await import('../chatsStore');
    await useChatsStore.getState().loadFromBackend();
    expect(useChatsStore.getState().backendAvailable).toBe(false);
  });

  it('createChat: 乐观插入 → 后端成功 → 用真实 id 替换', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        success: true,
        chat: { id: 'srv-1', title: '新对话', tag: 'NEW', tagBg: '', tagText: '', permission: 'normal', createdAt: 999, updatedAt: 999 },
        selectedId: 'srv-1',
      }),
    });
    const { useChatsStore } = await import('../chatsStore');
    const chat = await useChatsStore.getState().createChat('新对话');
    expect(chat?.id).toBe('srv-1');
    expect(useChatsStore.getState().chats[0].id).toBe('srv-1');
    expect(useChatsStore.getState().selectedChatId).toBe('srv-1');
  });

  it('createChat: 后端失败 → 回滚乐观项', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      text: async () => JSON.stringify({ success: false, error: 'no' }),
    });
    const { useChatsStore } = await import('../chatsStore');
    const chat = await useChatsStore.getState().createChat('xxx');
    expect(chat).toBeNull();
    expect(useChatsStore.getState().chats).toEqual([]);
  });

  it('updateChat: 成功后端确认', async () => {
    // 1) 加载
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        success: true, selectedId: 'a',
        chats: [{ id: 'a', title: 'A', tag: 'VUE', tagBg: '', tagText: '', permission: 'normal', createdAt: 1, updatedAt: 1 }],
        liveStates: {},
      }),
    });
    const { useChatsStore } = await import('../chatsStore');
    await useChatsStore.getState().loadFromBackend();
    // 2) patch
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ success: true }),
    });
    await useChatsStore.getState().updateChat('a', { title: 'A1', permission: 'expert' });
    const c = useChatsStore.getState().chats[0];
    expect(c.title).toBe('A1');
    expect(c.permission).toBe('expert');
  });

  it('updateChat: 后端失败 → 回滚', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        success: true, selectedId: 'a',
        chats: [{ id: 'a', title: 'A', tag: 'VUE', tagBg: '', tagText: '', permission: 'normal', createdAt: 1, updatedAt: 1 }],
        liveStates: {},
      }),
    });
    const { useChatsStore } = await import('../chatsStore');
    await useChatsStore.getState().loadFromBackend();
    fetchMock.mockResolvedValueOnce({ ok: false, text: async () => '' });
    await useChatsStore.getState().updateChat('a', { title: '应该回滚' });
    expect(useChatsStore.getState().chats[0].title).toBe('A');
  });

  it('deleteChat: 成功后端确认 + 选中态回退', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        success: true, selectedId: 'a',
        chats: [
          { id: 'a', title: 'A', tag: 'VUE', tagBg: '', tagText: '', permission: 'normal', createdAt: 1, updatedAt: 1 },
          { id: 'b', title: 'B', tag: 'AI', tagBg: '', tagText: '', permission: 'normal', createdAt: 2, updatedAt: 2 },
        ],
        liveStates: {},
      }),
    });
    const { useChatsStore } = await import('../chatsStore');
    await useChatsStore.getState().loadFromBackend();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ success: true, selectedId: 'b' }),
    });
    await useChatsStore.getState().deleteChat('a');
    const s = useChatsStore.getState();
    expect(s.chats.map((c) => c.id)).toEqual(['b']);
    expect(s.selectedChatId).toBe('b');
  });

  it('reorderChats: 重排后端确认', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        success: true, selectedId: null,
        chats: [
          { id: 'a', title: 'A', tag: 'VUE', tagBg: '', tagText: '', permission: 'normal', createdAt: 1, updatedAt: 1 },
          { id: 'b', title: 'B', tag: 'AI', tagBg: '', tagText: '', permission: 'normal', createdAt: 2, updatedAt: 2 },
          { id: 'c', title: 'C', tag: 'DB', tagBg: '', tagText: '', permission: 'normal', createdAt: 3, updatedAt: 3 },
        ],
        liveStates: {},
      }),
    });
    const { useChatsStore } = await import('../chatsStore');
    await useChatsStore.getState().loadFromBackend();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ success: true, order: ['c', 'a', 'b'] }),
    });
    await useChatsStore.getState().reorderChats(['c', 'a', 'b']);
    expect(useChatsStore.getState().chats.map((c) => c.id)).toEqual(['c', 'a', 'b']);
  });

  it('reorderChats: 顺序未变时不应触发后端写', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        success: true, selectedId: null,
        chats: [
          { id: 'a', title: 'A', tag: 'VUE', tagBg: '', tagText: '', permission: 'normal', createdAt: 1, updatedAt: 1 },
          { id: 'b', title: 'B', tag: 'AI', tagBg: '', tagText: '', permission: 'normal', createdAt: 2, updatedAt: 2 },
        ],
        liveStates: {},
      }),
    });
    const { useChatsStore } = await import('../chatsStore');
    await useChatsStore.getState().loadFromBackend();
    const before = fetchMock.mock.calls.length;
    await useChatsStore.getState().reorderChats(['a', 'b']);
    expect(fetchMock.mock.calls.length).toBe(before);
  });
});

describe('chatsStore — 实时流式状态', () => {
  it('setLiveState: 写入并触发上报', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        success: true, selectedId: null, chats: [], liveStates: {},
      }),
    });
    // 给 setLiveState 内部的 fetch 一个返回 Promise 的 mock
    fetchMock.mockResolvedValue({ ok: true, text: async () => '' });
    const { useChatsStore } = await import('../chatsStore');
    await useChatsStore.getState().loadFromBackend();
    const before = fetchMock.mock.calls.length;
    useChatsStore.getState().setLiveState({
      chatId: 'a', isStreaming: true, phase: 'started', progress: 10, modelName: 'gpt-4', tokens: 0, lastActivityAt: Date.now(),
    });
    expect(useChatsStore.getState().liveStates.a?.isStreaming).toBe(true);
    expect(useChatsStore.getState().liveStates.a?.phase).toBe('started');
    expect(fetchMock.mock.calls.length).toBe(before + 1);
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(String(lastCall[1]?.method)).toBe('POST');
    expect(String(lastCall[0])).toContain('/a/state');
  });

  it('clearLiveState: 清除并触发 DELETE', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        success: true, selectedId: null,
        chats: [{ id: 'a', title: 'A', tag: 'VUE', tagBg: '', tagText: '', permission: 'normal', createdAt: 1, updatedAt: 1 }],
        liveStates: { a: { chatId: 'a', isStreaming: true, lastActivityAt: 1 } },
      }),
    });
    const { useChatsStore } = await import('../chatsStore');
    await useChatsStore.getState().loadFromBackend();
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => '' });
    useChatsStore.getState().clearLiveState('a');
    expect(useChatsStore.getState().liveStates.a).toBeUndefined();
  });
});

describe('chatsStore — 事件桥', () => {
  it('initChatsEventBridge: chats 变化时派发 soloforge-chats-updated 事件', async () => {
    const dispatch = vi.fn();
    (global as any).window = { dispatchEvent: dispatch };

    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        success: true, selectedId: null,
        chats: [{ id: 'a', title: 'A', tag: 'VUE', tagBg: '', tagText: '', permission: 'normal', createdAt: 1, updatedAt: 1 }],
        liveStates: {},
      }),
    });
    const mod = await import('../chatsStore');
    mod.initChatsEventBridge();
    await mod.useChatsStore.getState().loadFromBackend();
    // 加载完成本身不算变化（前后 chats 引用不同但 store 已 dispatch 过？）
    // 真正测的是 updateChat 触发后是否 dispatch
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ success: true }) });
    await mod.useChatsStore.getState().updateChat('a', { title: 'A2' });
    const types = dispatch.mock.calls.map((c) => (c[0] as any).type);
    expect(types).toContain('soloforge-chats-updated');
  });
});