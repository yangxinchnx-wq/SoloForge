/**
 * MainModelSelector 纯函数单元测试
 *
 * 覆盖:
 * - computeAvailableModels: 去重 / 排序保持 / 空白 / null / undefined
 * - pickModel: 选合法 / 选不合法 / 选当前 / 选回原值
 *
 * 备注: 测试不 mount 组件 (跳过 ModelIcon + lobehub 重依赖, 用纯函数覆盖即可)
 */

import { describe, it, expect } from 'vitest';
import { computeAvailableModels, pickModel } from '../mainModelSelectorLogic';

describe('computeAvailableModels — 去重与兜底', () => {
  it('基本展平: 保持首次出现顺序', () => {
    const r = computeAvailableModels(['gpt-4o', 'claude-3-5-sonnet', 'gpt-4o']);
    expect(r.list).toEqual(['gpt-4o', 'claude-3-5-sonnet']);
    expect(r.fallback).toBe('gpt-4o');
  });

  it('去重: 多次出现同一 id 只保留首次', () => {
    const r = computeAvailableModels(['a', 'b', 'a', 'c', 'b']);
    expect(r.list).toEqual(['a', 'b', 'c']);
  });

  it('去除空白字符串', () => {
    const r = computeAvailableModels(['', 'a', '   ', 'b']);
    expect(r.list).toEqual(['a', 'b']);
  });

  it('去除非字符串元素', () => {
    const r = computeAvailableModels([null as any, undefined as any, 0 as any, 'a']);
    expect(r.list).toEqual(['a']);
  });

  it('trim 前后空白: "  a  " 视为 "a"', () => {
    const r = computeAvailableModels(['  a  ', 'a']);
    expect(r.list).toEqual(['a']);
  });

  it('空数组 / null / undefined → fallback=null', () => {
    expect(computeAvailableModels([])).toEqual({ list: [], fallback: null });
    expect(computeAvailableModels(null)).toEqual({ list: [], fallback: null });
    expect(computeAvailableModels(undefined)).toEqual({ list: [], fallback: null });
  });

  it('全为空白 → fallback=null', () => {
    const r = computeAvailableModels(['', '   ', '\t']);
    expect(r.fallback).toBeNull();
    expect(r.list).toEqual([]);
  });
});

describe('pickModel — 选择与回退', () => {
  const list = ['a', 'b', 'c'];

  it('当前主模型= "a", 选 "b" → 切到 b, changed=true', () => {
    expect(pickModel(list, 'a', 'b')).toEqual({ next: 'b', changed: true });
  });

  it('当前主模型= "a", 再选 "a" → 不变, changed=false', () => {
    expect(pickModel(list, 'a', 'a')).toEqual({ next: 'a', changed: false });
  });

  it('当前主模型= "x" (不在列表), 选 "b" → 切到 b, changed=true (因为之前是 x)', () => {
    expect(pickModel(list, 'x', 'b')).toEqual({ next: 'b', changed: true });
  });

  it('选列表里不存在的 id (防御性) → 保持原 mainModel, changed=false', () => {
    expect(pickModel(list, 'a', 'evil-id')).toEqual({ next: 'a', changed: false });
  });

  it('空列表 + 任何输入 → 保持原 mainModel', () => {
    expect(pickModel([], 'a', 'x')).toEqual({ next: 'a', changed: false });
  });
});
