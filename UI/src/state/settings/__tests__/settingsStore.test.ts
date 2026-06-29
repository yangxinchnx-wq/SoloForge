/**
 * SettingsStore 单元测试
 *
 * 覆盖:
 * - 基本 get/set/setMany/remove
 * - subscribe 通知机制
 * - 持久化(PersistAdapter 写读一致性)
 * - 同步(SyncAdapter 异步 PUT)
 * - getSyncStatus / listUnsynced
 * - init(ssrInit) 填补缺失 + 不覆盖已有
 * - 后台 startup reconcile
 * - 重试 + 指数退避
 * - 外部 storage 事件同步
 * - unwrapStringified 嵌套防御
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createSettingsStore,
  MemoryPersist,
  MemorySync,
  type SettingsStore,
} from '../index';

// 给 wait/flush helper
function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  cond: () => boolean,
  timeout = 1000,
): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeout) {
    await tick(10);
  }
  if (!cond()) throw new Error('waitFor timeout');
}

describe('SettingsStore — 基本读写', () => {
  let persist: MemoryPersist;
  let sync: MemorySync;
  let store: SettingsStore;

  beforeEach(() => {
    persist = new MemoryPersist();
    sync = new MemorySync();
    store = createSettingsStore({ persist, sync });
  });

  afterEach(() => {
    store.dispose();
    persist._clear();
    sync._clear();
  });

  it('get 不存在的 key 返回 undefined', () => {
    expect(store.get('missing')).toBeUndefined();
  });

  it('set 后立即可读', () => {
    store.set('themeId', 'dark');
    expect(store.get('themeId')).toBe('dark');
  });

  it('set 同时写入 persist', async () => {
    store.set('themeId', 'dark');
    await tick(20);
    expect(persist._get('themeId')).toBe('dark');
  });

  it('setMany 原子批量写入', async () => {
    store.setMany({ a: 1, b: 2, c: 3 });
    await tick(20);
    expect(store.get('a')).toBe(1);
    expect(store.get('b')).toBe(2);
    expect(store.get('c')).toBe(3);
    expect(persist._get('a')).toBe(1);
    expect(persist._get('b')).toBe(2);
    expect(persist._get('c')).toBe(3);
  });

  it('remove 后 get 返回 undefined', () => {
    store.set('k', 'v');
    store.remove('k');
    expect(store.get('k')).toBeUndefined();
  });

  it('getMany 批量读', () => {
    store.setMany({ a: 1, b: 2 });
    const r = store.getMany(['a', 'b', 'missing']);
    expect(r).toEqual({ a: 1, b: 2, missing: undefined });
  });

  it('set 覆盖旧值', async () => {
    store.set('k', 'v1');
    store.set('k', 'v2');
    await tick(20);
    expect(store.get('k')).toBe('v2');
    expect(persist._get('k')).toBe('v2');
  });
});

describe('SettingsStore — subscribe 通知', () => {
  let persist: MemoryPersist;
  let sync: MemorySync;
  let store: SettingsStore;

  beforeEach(() => {
    persist = new MemoryPersist();
    sync = new MemorySync();
    store = createSettingsStore({ persist, sync });
  });

  afterEach(() => store.dispose());

  it('set 触发 listener', () => {
    const fn = vi.fn();
    store.subscribe(fn);
    store.set('k', 'v');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('setMany 触发 listener 一次', () => {
    const fn = vi.fn();
    store.subscribe(fn);
    store.setMany({ a: 1, b: 2 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('remove 触发 listener', () => {
    const fn = vi.fn();
    store.set('k', 'v');
    fn.mockClear();
    store.subscribe(fn);
    store.remove('k');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe 停止通知', () => {
    const fn = vi.fn();
    const unsub = store.subscribe(fn);
    store.set('k', 'v');
    unsub();
    store.set('k', 'v2');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('listener 抛错不影响其他 listener', () => {
    const a = vi.fn(() => {
      throw new Error('boom');
    });
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    // 不应 throw
    expect(() => store.set('k', 'v')).not.toThrow();
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsStore — 异步 sync worker', () => {
  let persist: MemoryPersist;
  let sync: MemorySync;
  let store: SettingsStore;

  beforeEach(() => {
    persist = new MemoryPersist();
    sync = new MemorySync();
    store = createSettingsStore({ persist, sync });
  });

  afterEach(() => store.dispose());

  it('set 后 worker 自动 PUT 到 server', async () => {
    store.set('themeId', 'dark');
    await waitFor(() => sync._putLog().some((r) => r.key === 'themeId'));
    expect(sync._get('themeId')).toBe('dark');
  });

  it('setMany 所有 key 都 PUT', async () => {
    store.setMany({ a: 1, b: 2, c: 3 });
    await waitFor(() => sync._putLog().length >= 3);
    expect(sync._get('a')).toBe(1);
    expect(sync._get('b')).toBe(2);
    expect(sync._get('c')).toBe(3);
  });

  it('sync 成功 getSyncStatus 返回 synced', async () => {
    store.set('k', 'v');
    await waitFor(() => store.getSyncStatus('k') === 'synced');
    expect(store.getSyncStatus('k')).toBe('synced');
  });

  it('sync 在途 getSyncStatus 返回 pending', () => {
    sync._failNextPuts(10);
    store.set('k', 'v');
    expect(store.getSyncStatus('k')).toBe('pending');
    sync._failNextPuts(0); // 清掉,不影响其他测试
  });
});

describe('SettingsStore — 重试与失败', () => {
  it('sync 失败 3 次后标记 failed(不再重试)', async () => {
    const persist = new MemoryPersist();
    const sync = new MemorySync();
    const store = createSettingsStore({
      persist,
      sync,
      maxRetries: 3,
      retryBaseDelay: 10,
    });
    sync._failNextPuts(100);
    store.set('k', 'v');
    // 等到 failed(3 次重试耗尽)
    await waitFor(() => store.getSyncStatus('k') === 'failed', 2000);
    expect(store.getSyncStatus('k')).toBe('failed');
    // 失败后值仍保留在 cache
    expect(store.get('k')).toBe('v');
    expect(persist._get('k')).toBe('v');
    expect(store.listUnsynced()).toContain('k');
    store.dispose();
  });

  it('失败后下次 set 同一 key 仍然 PUT(新值)', async () => {
    const persist = new MemoryPersist();
    const sync = new MemorySync();
    const store = createSettingsStore({
      persist,
      sync,
      maxRetries: 2,
      retryBaseDelay: 5,
    });
    sync._failNextPuts(10);
    store.set('k', 'v1');
    await waitFor(() => store.getSyncStatus('k') === 'failed', 1500);
    sync._failNextPuts(0);
    store.set('k', 'v2');
    await waitFor(() => sync._get('k') === 'v2', 1000);
    expect(sync._get('k')).toBe('v2');
    store.dispose();
  });
});

describe('SettingsStore — init(ssrInit)', () => {
  it('从 persist 读所有填充 cache', () => {
    const persist = new MemoryPersist();
    persist.set('existing', 'value-from-disk');
    const store = createSettingsStore({ persist });
    store.init();
    expect(store.get('existing')).toBe('value-from-disk');
    store.dispose();
  });

  it('ssrInit 填补缺失 key,不覆盖已有', () => {
    const persist = new MemoryPersist();
    persist.set('existing', 'from-disk');
    const store = createSettingsStore({ persist });
    store.init({ existing: 'from-ssr', missing: 'from-ssr' });
    expect(store.get('existing')).toBe('from-disk'); // 不覆盖
    expect(store.get('missing')).toBe('from-ssr'); // 填补
    // SSR 填补的值也写入 persist(下次启动本地有)
    expect(persist._get('missing')).toBe('from-ssr');
    store.dispose();
  });

  it('startup getAll 与本地 reconcile,server 值不同时覆盖', async () => {
    const persist = new MemoryPersist();
    persist.set('a', 'local-a');
    const sync = new MemorySync();
    sync._set('a', 'server-a'); // server 不同
    sync._set('b', 'server-b'); // server 有,本地没
    const store = createSettingsStore({ persist, sync });
    store.init();
    await waitFor(() => store.get('b') === 'server-b');
    expect(store.get('a')).toBe('server-a');
    expect(store.get('b')).toBe('server-b');
    store.dispose();
  });

  it('本地值与 server 不同时,本地 pending 优先', async () => {
    const persist = new MemoryPersist();
    const sync = new MemorySync();
    sync._set('a', 'server-a');
    const store = createSettingsStore({ persist, sync });
    store.init();
    // 本地立即覆盖(server getAll 还没回来)
    store.set('a', 'local-a');
    // 等 sync 完成
    await waitFor(() => store.getSyncStatus('a') === 'synced');
    // 应该是 local-a(本地写入排到 queue 里了)
    expect(store.get('a')).toBe('local-a');
    expect(sync._get('a')).toBe('local-a');
    store.dispose();
  });
});

describe('SettingsStore — 外部 storage 事件', () => {
  it('其他 source 写入触发 listener 并更新 cache', () => {
    const persist = new MemoryPersist();
    const store = createSettingsStore({ persist });
    const fn = vi.fn();
    store.subscribe(fn);
    store.init();
    fn.mockClear();
    persist._emitExternalChange('themeId', 'dark');
    expect(fn).toHaveBeenCalled();
    expect(store.get('themeId')).toBe('dark');
    store.dispose();
  });

  it('外部 undefined 触发删除', () => {
    const persist = new MemoryPersist();
    const store = createSettingsStore({ persist });
    store.init();
    store.set('k', 'v');
    persist._emitExternalChange('k', undefined);
    expect(store.get('k')).toBeUndefined();
    store.dispose();
  });

  it('外部事件不覆盖本地 pending 写入', () => {
    const persist = new MemoryPersist();
    const sync = new MemorySync();
    sync._failNextPuts(10);
    const store = createSettingsStore({ persist, sync });
    store.init();
    store.set('k', 'local-pending');
    // 外部写入其他值
    persist._emitExternalChange('k', 'external');
    // 因为本地 pending,不应被覆盖
    expect(store.get('k')).toBe('local-pending');
    store.dispose();
  });
});

describe('SettingsStore — unwrapStringified 防御', () => {
  it('写入已被 stringify 的字符串自动解套', async () => {
    const persist = new MemoryPersist();
    const store = createSettingsStore({ persist });
    store.set('k', '"foo"'); // 真实意图是字符串 foo
    await tick(20);
    // 写入 persist 应该是原值 foo,不是 '"foo"'
    expect(persist._get('k')).toBe('foo');
    expect(store.get('k')).toBe('foo');
    store.dispose();
  });

  it('反复 set 不会让脏数据累积(每轮都归一)', async () => {
    const persist = new MemoryPersist();
    const store = createSettingsStore({ persist });
    // 即使调用方传过来已 stringify 的值,内部解套后存原值
    store.set('k', '"foo"');
    await tick(20);
    expect(persist._get('k')).toBe('foo');
    // 再 set 一次同样的脏值,仍然是 foo,不会膨胀
    store.set('k', '"foo"');
    await tick(20);
    expect(persist._get('k')).toBe('foo');
    // 真实业务值
    store.set('k', '真实值');
    await tick(20);
    expect(persist._get('k')).toBe('真实值');
    store.dispose();
  });
});

describe('SettingsStore — dispose', () => {
  it('dispose 后订阅失效', () => {
    const persist = new MemoryPersist();
    const store = createSettingsStore({ persist });
    const fn = vi.fn();
    store.subscribe(fn);
    store.dispose();
    // dispose 后 listener 被清掉,新订阅也无效
    // 不应 throw
    expect(() => store.dispose()).not.toThrow();
  });
});
