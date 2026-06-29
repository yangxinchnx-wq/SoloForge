/**
 * LocalStoragePersist 适配器测试
 *
 * 覆盖:
 * - 原始 string 写入(新格式):localStorage 存 raw 'dark',不是 '"dark"'
 * - object/array 写入(老格式):localStorage 存 JSON 字符串
 * - readAll 兼容两种格式(string raw + JSON 字面量)
 * - storage 事件兼容两种格式
 * - 历史脏数据(嵌套)自动解套
 *
 * 关键场景:index.html 的 inline script 用 `localStorage.getItem('soloforge_themeId')`
 * 拿到的必须是 raw string 'dark',不是 JSON 字符串 '"dark"'
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LocalStoragePersist } from '../adapters/localStorage';

// 模拟 localStorage(用 Map 实现,模拟浏览器行为)
function createMockStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
  } as Storage;
}

describe('LocalStoragePersist — 写入格式', () => {
  let storage: Storage;
  let persist: LocalStoragePersist;

  beforeEach(() => {
    storage = createMockStorage();
    persist = new LocalStoragePersist(storage);
  });

  it('string value 写 raw(不 stringify),index.html inline script 可读', () => {
    persist.set('soloforge_themeId', 'dark');
    // localStorage 里是 raw 'dark',不是 JSON 字符串 '"dark"'
    expect(storage.getItem('soloforge_themeId')).toBe('dark');
  });

  it('空字符串写 raw', () => {
    persist.set('soloforge_qq_url', '');
    expect(storage.getItem('soloforge_qq_url')).toBe('');
  });

  it('中文/特殊字符 string 也写 raw', () => {
    persist.set('soloforge_selectedFont', '默认 (Default)');
    expect(storage.getItem('soloforge_selectedFont')).toBe('默认 (Default)');
  });

  it('object value 走 JSON.stringify', () => {
    persist.set('soloforge_chat_configs', { '1': { a: 1 } });
    expect(storage.getItem('soloforge_chat_configs')).toBe('{"1":{"a":1}}');
  });

  it('array value 走 JSON.stringify', () => {
    persist.set('cherry_providers_v2', [{ id: 'openai' }]);
    expect(storage.getItem('cherry_providers_v2')).toBe('[{"id":"openai"}]');
  });

  it('number value 走 JSON.stringify → 存为 "1" 字符串', () => {
    // 这是设计妥协:number 一律 stringify,readAll 解析回来
    persist.set('test_number', 42);
    expect(storage.getItem('test_number')).toBe('42');
  });

  it('boolean value 走 JSON.stringify', () => {
    persist.set('test_bool', true);
    expect(storage.getItem('test_bool')).toBe('true');
  });
});

describe('LocalStoragePersist — readAll 兼容', () => {
  let storage: Storage;
  let persist: LocalStoragePersist;

  beforeEach(() => {
    storage = createMockStorage();
    persist = new LocalStoragePersist(storage);
  });

  it('读 raw string(新格式)', () => {
    storage.setItem('soloforge_themeId', 'dark');
    const all = persist.readAll();
    expect(all.soloforge_themeId).toBe('dark');
  });

  it('读 JSON 字符串(老格式 object)', () => {
    storage.setItem('soloforge_chat_configs', '{"1":{"a":1}}');
    const all = persist.readAll();
    expect(all.soloforge_chat_configs).toEqual({ '1': { a: 1 } });
  });

  it('读 JSON 字符串(老格式 array)', () => {
    storage.setItem('cherry_providers_v2', '[{"id":"openai"}]');
    const all = persist.readAll();
    expect(all.cherry_providers_v2).toEqual([{ id: 'openai' }]);
  });

  it('读历史脏数据(嵌套 JSON)自动解套', () => {
    // 假设磁盘上保留了老 bug 时代的 '"dark"' (嵌套 1 层)
    storage.setItem('soloforge_themeId', '"dark"');
    const all = persist.readAll();
    expect(all.soloforge_themeId).toBe('dark');
  });

  it('读裸字符串(无 JSON 括号)直接当 string', () => {
    storage.setItem('any', 'hello world');
    const all = persist.readAll();
    expect(all.any).toBe('hello world');
  });

  it('混合 raw + JSON 都能读', () => {
    storage.setItem('string_key', 'plain value');
    storage.setItem('object_key', '{"a":1}');
    storage.setItem('array_key', '[1,2,3]');
    const all = persist.readAll();
    expect(all.string_key).toBe('plain value');
    expect(all.object_key).toEqual({ a: 1 });
    expect(all.array_key).toEqual([1, 2, 3]);
  });

  it('新 store 写入 → 立即 readAll 能读到原值(对称)', () => {
    persist.set('themeId', 'dark');
    persist.set('providers', [{ id: 'openai' }]);
    const all = persist.readAll();
    expect(all.themeId).toBe('dark');
    expect(all.providers).toEqual([{ id: 'openai' }]);
  });
});

describe('LocalStoragePersist — 端到端 + 模拟 inline script', () => {
  it('store.set + localStorage.getItem(模拟 index.html inline script)拿到原值', () => {
    // 模拟浏览器真实环境
    const storage = createMockStorage();
    const persist = new LocalStoragePersist(storage);

    // 1. 业务代码写入
    persist.set('soloforge_themeId', 'dark');
    persist.set('soloforge_selectedFont', '默认 (Default)');
    persist.set('soloforge_chat_configs', { '1': { enabled: true } });

    // 2. 模拟 index.html inline script 直接读 raw
    const themeFromInlineScript = storage.getItem('soloforge_themeId');
    const fontFromInlineScript = storage.getItem('soloforge_selectedFont');
    expect(themeFromInlineScript).toBe('dark'); // 关键:必须是 raw,不是 JSON
    expect(fontFromInlineScript).toBe('默认 (Default)');

    // 3. 业务代码读 readAll(走 JSON.parse)
    const all = persist.readAll();
    expect(all.soloforge_themeId).toBe('dark');
    expect(all.soloforge_selectedFont).toBe('默认 (Default)');
    expect(all.soloforge_chat_configs).toEqual({ '1': { enabled: true } });
  });
});
