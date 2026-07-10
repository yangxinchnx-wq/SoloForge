/**
 * streamingStore 单元测试
 *
 * 重构后职责:
 *   - streamTaskMeta: rootTaskId / subTaskIds / userInput / mode (控制流元数据)
 *   - agentsMap: 子 Agent 池
 *   - 显示数据从 uiMessageStore.parts 派生, 事件分发由 dispatchStreamEvent 处理
 *
 * 覆盖:
 *   - createTask 返回轻量句柄 + 写入 streamTaskMeta
 *   - clearChat 清理 streamTaskMeta
 *   - __reset 重置整个 store
 *   - transitionPhase 纯函数 (来自 types/streaming, 状态机跃迁规则)
 *   - 多 chat 隔离 (streamTaskMeta 互不串扰)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStreamingStore } from '../streamingStore';
import { transitionPhase } from '../../types/streaming';

beforeEach(() => {
  useStreamingStore.getState().__reset();
});

describe('streamingStore — 任务创建', () => {
  it('createTask: 返回轻量句柄 { id, chatId, phase: CLARIFY }', () => {
    const task = useStreamingStore.getState().createTask('c1', 'hello', 'normal');
    expect(task.chatId).toBe('c1');
    expect(task.phase).toBe('CLARIFY');
    expect(task.id).toMatch(/^task-/);
    // streamTaskMeta 已写入
    const meta = useStreamingStore.getState().streamTaskMeta['c1'];
    expect(meta).toBeDefined();
    expect(meta!.rootTaskId).toBe(task.id);
    expect(meta!.userInput).toBe('hello');
    expect(meta!.mode).toBe('normal');
    expect(meta!.subTaskIds).toBeInstanceOf(Map);
    expect(meta!.subTaskIds.size).toBe(0);
  });

  it('createTask: 同 chatId 二次创建覆盖旧 streamTaskMeta', () => {
    const t1 = useStreamingStore.getState().createTask('c1', 'first', 'normal');
    const t2 = useStreamingStore.getState().createTask('c1', 'second', 'yolo');
    // 新 meta 覆盖旧 meta
    const meta = useStreamingStore.getState().streamTaskMeta['c1'];
    expect(meta!.rootTaskId).toBe(t2.id);
    expect(meta!.rootTaskId).not.toBe(t1.id);
    expect(meta!.userInput).toBe('second');
    expect(meta!.mode).toBe('yolo');
  });

  it('createTask: 不同 chatId 互不干扰', () => {
    useStreamingStore.getState().createTask('chatA', 'A', 'normal');
    useStreamingStore.getState().createTask('chatB', 'B', 'yolo');
    const metaA = useStreamingStore.getState().streamTaskMeta['chatA'];
    const metaB = useStreamingStore.getState().streamTaskMeta['chatB'];
    expect(metaA!.userInput).toBe('A');
    expect(metaB!.userInput).toBe('B');
    expect(metaA!.rootTaskId).not.toBe(metaB!.rootTaskId);
  });
});

describe('streamingStore — 状态机跃迁 (transitionPhase 纯函数)', () => {
  it('CLARIFY → DECOMPOSING 合法', () => {
    expect(transitionPhase('CLARIFY', 'DECOMPOSING')).toBe('DECOMPOSING');
  });

  it('CLARIFY → DONE 非法', () => {
    expect(transitionPhase('CLARIFY', 'DONE')).toBeNull();
  });

  it('EXECUTING → ERROR 合法 (错误恢复路径可达)', () => {
    expect(transitionPhase('EXECUTING', 'ERROR')).toBe('ERROR');
  });

  it('ERROR → CLARIFY 应允许 (重试)', () => {
    expect(transitionPhase('ERROR', 'CLARIFY')).toBe('CLARIFY');
  });

  it('DONE 是终态, 任何跃迁都拒绝', () => {
    expect(transitionPhase('DONE', 'EXECUTING')).toBeNull();
    expect(transitionPhase('DONE', 'DONE')).toBeNull();
  });
});

describe('streamingStore — clearChat', () => {
  it('clearChat 后 streamTaskMeta[chatId] 被清除', () => {
    useStreamingStore.getState().createTask('c1', 'x', 'normal');
    expect(useStreamingStore.getState().streamTaskMeta['c1']).toBeDefined();
    useStreamingStore.getState().clearChat('c1');
    expect(useStreamingStore.getState().streamTaskMeta['c1']).toBeUndefined();
  });

  it('clearChat 只清目标 chat, 不影响其他 chat', () => {
    useStreamingStore.getState().createTask('c1', 'x', 'normal');
    useStreamingStore.getState().createTask('c2', 'y', 'normal');
    useStreamingStore.getState().clearChat('c1');
    expect(useStreamingStore.getState().streamTaskMeta['c1']).toBeUndefined();
    expect(useStreamingStore.getState().streamTaskMeta['c2']).toBeDefined();
  });

  it('clearChat 对不存在的 chatId 静默忽略', () => {
    expect(() => {
      useStreamingStore.getState().clearChat('nonexistent');
    }).not.toThrow();
  });
});

describe('streamingStore — __reset', () => {
  it('__reset 清空整个 store', () => {
    useStreamingStore.getState().createTask('c1', 'x', 'normal');
    useStreamingStore.getState().createTask('c2', 'y', 'normal');
    expect(Object.keys(useStreamingStore.getState().streamTaskMeta)).toHaveLength(2);
    useStreamingStore.getState().__reset();
    expect(Object.keys(useStreamingStore.getState().streamTaskMeta)).toEqual([]);
    expect(Object.keys(useStreamingStore.getState().agentsMap)).toEqual([]);
  });
});
