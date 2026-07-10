/**
 * taskMachine.test.ts — 声明式 FSM (xstate v5) 测试
 *
 * 覆盖:
 *   1. 合法/非法跃迁 (canTransition / transitionViaMachine)
 *   2. getValidTransitions 返回与 PHASE_TRANSITIONS 一致
 *   3. createTaskMachineActor 完整生命周期 (send → snapshot)
 *   4. 非法事件被 actor 忽略 (不抛错, 不转态)
 *   5. recordTransition action 正确更新 context (transitionCount / enteredAt / lastDetail)
 *   6. ERROR 事件从任意运行态可转 ERROR (除 DONE)
 */

import { describe, it, expect } from 'vitest';
import {
  taskMachine,
  canTransition,
  getValidTransitions,
  transitionViaMachine,
  createTaskMachineActor,
} from '../taskMachine';
import { PHASE_TRANSITIONS, type TaskPhase } from '../../types/streaming';

const ALL_PHASES = Object.keys(PHASE_TRANSITIONS) as TaskPhase[];

describe('taskMachine — canTransition / getValidTransitions', () => {
  it('canTransition 与 PHASE_TRANSITIONS 完全一致', () => {
    for (const from of ALL_PHASES) {
      for (const to of ALL_PHASES) {
        const expected = PHASE_TRANSITIONS[from].includes(to);
        expect(canTransition(from, to)).toBe(expected);
      }
    }
  });

  it('getValidTransitions 返回所有合法目标', () => {
    for (const from of ALL_PHASES) {
      const valid = getValidTransitions(from);
      expect(valid).toEqual(PHASE_TRANSITIONS[from]);
    }
  });

  it('transitionViaMachine 合法返回 target, 非法返回 null', () => {
    expect(transitionViaMachine('CLARIFY', 'PLANNING')).toBe('PLANNING');
    expect(transitionViaMachine('CLARIFY', 'DONE')).toBeNull();
    expect(transitionViaMachine('DONE', 'CLARIFY')).toBeNull(); // DONE 是终态
  });
});

describe('taskMachine — actor 生命周期', () => {
  it('初始状态为 CLARIFY, transitionCount=0', () => {
    const actor = createTaskMachineActor('root-1', 'chat-1');
    actor.start();
    const snap = actor.getSnapshot();
    expect(snap.value).toBe('CLARIFY');
    expect(snap.context.transitionCount).toBe(0);
    expect(snap.context.rootTaskId).toBe('root-1');
    expect(snap.context.chatId).toBe('chat-1');
    actor.stop();
  });

  it('合法 PHASE_CHANGE 跃迁后 context 更新', () => {
    const actor = createTaskMachineActor('root-1', 'chat-1');
    actor.start();

    actor.send({ type: 'PHASE_CHANGE', to: 'PLANNING', detail: '开始规划' });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe('PLANNING');
    expect(snap.context.transitionCount).toBe(1);
    expect(snap.context.lastDetail).toBe('开始规划');

    actor.stop();
  });

  it('非法 PHASE_CHANGE 被 actor 忽略 (保持当前状态)', () => {
    const actor = createTaskMachineActor('root-1', 'chat-1');
    actor.start();

    // CLARIFY → DONE 是非法的
    actor.send({ type: 'PHASE_CHANGE', to: 'DONE' });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe('CLARIFY');
    expect(snap.context.transitionCount).toBe(0); // 未触发 entry action

    actor.stop();
  });

  it('ERROR 事件从任意运行态可转 ERROR (除 DONE)', () => {
    const phases: TaskPhase[] = ['CLARIFY', 'PLANNING', 'EXECUTING', 'REVIEWING', 'DELIVERING'];
    for (const from of phases) {
      // 用合法路径先到达 from
      const actor = createTaskMachineActor('root-1', 'chat-1');
      actor.start();
      // 先合法转到 PLANNING (CLARIFY → PLANNING 合法)
      if (from !== 'CLARIFY') {
        actor.send({ type: 'PHASE_CHANGE', to: 'PLANNING' });
        // 再尝试转到目标 from (若不合法, actor 保持 PLANNING)
        if (canTransition('PLANNING', from)) {
          actor.send({ type: 'PHASE_CHANGE', to: from });
        }
      }
      // 发 ERROR
      actor.send({ type: 'ERROR', message: '出错了' });
      const snap = actor.getSnapshot();
      expect(snap.value).toBe('ERROR');
      expect(snap.context.lastDetail).toBe('出错了');
      actor.stop();
    }
  });

  it('完整跃迁链: CLARIFY → PLANNING → DECOMPOSING → DISPATCHING → EXECUTING → REVIEWING → DELIVERING → DONE', () => {
    const actor = createTaskMachineActor('root-1', 'chat-1');
    actor.start();

    // PHASE_TRANSITIONS: EXECUTING 只能到 REVIEWING/AUDITING/EXECUTING/ERROR, 不能直接到 DELIVERING
    const chain: TaskPhase[] = ['PLANNING', 'DECOMPOSING', 'DISPATCHING', 'EXECUTING', 'REVIEWING', 'DELIVERING', 'DONE'];
    for (const to of chain) {
      actor.send({ type: 'PHASE_CHANGE', to });
      expect(actor.getSnapshot().value).toBe(to);
    }

    // 7 次 PHASE_CHANGE, 每次 +1, 初始 CLARIFY 不计数
    const finalSnap = actor.getSnapshot();
    expect(finalSnap.context.transitionCount).toBe(7);

    actor.stop();
  });

  it('SINGLE_MODEL 分支: CLARIFY → SINGLE_MODEL → EXECUTING → REVIEWING → DELIVERING → DONE', () => {
    const actor = createTaskMachineActor('root-1', 'chat-1');
    actor.start();

    actor.send({ type: 'PHASE_CHANGE', to: 'SINGLE_MODEL' });
    expect(actor.getSnapshot().value).toBe('SINGLE_MODEL');

    actor.send({ type: 'PHASE_CHANGE', to: 'EXECUTING' });
    expect(actor.getSnapshot().value).toBe('EXECUTING');

    // EXECUTING → DELIVERING 非法, 必须经 REVIEWING
    actor.send({ type: 'PHASE_CHANGE', to: 'DELIVERING' });
    expect(actor.getSnapshot().value).toBe('EXECUTING'); // 保持不变

    actor.send({ type: 'PHASE_CHANGE', to: 'REVIEWING' });
    expect(actor.getSnapshot().value).toBe('REVIEWING');

    actor.send({ type: 'PHASE_CHANGE', to: 'DELIVERING' });
    expect(actor.getSnapshot().value).toBe('DELIVERING');

    actor.send({ type: 'PHASE_CHANGE', to: 'DONE' });
    expect(actor.getSnapshot().value).toBe('DONE');

    actor.stop();
  });

  it('ERROR 状态可恢复到运行态 (ERROR → CLARIFY/PLANNING 等)', () => {
    const actor = createTaskMachineActor('root-1', 'chat-1');
    actor.start();
    actor.send({ type: 'ERROR', message: '失败' });
    expect(actor.getSnapshot().value).toBe('ERROR');

    // ERROR → CLARIFY 合法 (重试)
    actor.send({ type: 'PHASE_CHANGE', to: 'CLARIFY' });
    expect(actor.getSnapshot().value).toBe('CLARIFY');

    actor.stop();
  });

  it('initialPhase 参数: 传入合法 phase 时直接跃迁', () => {
    // CLARIFY → PLANNING 合法, 应该成功
    const actor = createTaskMachineActor('root-1', 'chat-1', 'PLANNING');
    actor.start();
    // 注意: start 前已经 send 了 PHASE_CHANGE, start 后 actor 处理
    expect(actor.getSnapshot().value).toBe('PLANNING');
    actor.stop();
  });
});

describe('taskMachine — 机器完整性', () => {
  it('taskMachine 有 11 个状态', () => {
    // xstate v5 machine states 在 options 中
    const stateIds = Object.keys(taskMachine.states);
    expect(stateIds.length).toBe(11);
    expect(stateIds).toContain('CLARIFY');
    expect(stateIds).toContain('DONE');
    expect(stateIds).toContain('ERROR');
    expect(stateIds).toContain('SINGLE_MODEL');
  });

  it('DONE 状态无任何合法跃迁 (终态)', () => {
    expect(getValidTransitions('DONE')).toEqual([]);
  });
});
