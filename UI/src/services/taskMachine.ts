/**
 * taskMachine — 声明式任务状态机 (xstate v5)
 *
 * 设计目标:
 *   1. 把 streaming.ts 的 PHASE_TRANSITIONS 跃迁表升级为声明式 FSM
 *   2. 可可视化 (xstate visualizer)、可单测、防非法转移
 *   3. 提供 guard / action / context 的声明式能力
 *   4. 不破坏 streamingStore.transitionTaskPhase 现有路径 (机器独立可测)
 *
 * 集成策略 (低风险):
 *   - 机器从 PHASE_TRANSITIONS 派生 states (单向依赖, 无循环)
 *   - streamingStore 保持 transitionPhase 主路径
 *   - 新代码可调用 canTransition / getValidTransitions 从机器查询
 *   - 未来可逐步把 streamingStore 迁移到 xstate actor
 *
 * 2026-07-10: P2 实现
 */

import { setup, assign, createActor, type Actor, type SnapshotFrom } from 'xstate';
import { PHASE_TRANSITIONS, type TaskPhase } from '../types/streaming';

// ==================== 类型定义 ====================

export interface TaskMachineContext {
  rootTaskId: string;
  chatId: string;
  /** 进入当前 phase 的时间戳 */
  enteredAt: number;
  /** 累计跃迁次数 (调试/监控用) */
  transitionCount: number;
  /** 最近一次跃迁的 detail (来自 phase_change 事件) */
  lastDetail?: string;
}

export type TaskMachineEvent =
  | { type: 'PHASE_CHANGE'; to: TaskPhase; detail?: string }
  | { type: 'ERROR'; message: string; detail?: string };

// ==================== 从 PHASE_TRANSITIONS 生成 states ====================
//
// xstate v5 的 on 是静态声明的, target 在编译时确定。
// 这里在模块加载时从 PHASE_TRANSITIONS 生成每个状态的 on 映射,
// 保证机器与跃迁表语义一致, 避免重复维护两份跃迁规则。
//
// 每个状态对 PHASE_CHANGE 事件列出所有合法 target,
// 用 guard 精确匹配 event.to === target。
// 无匹配 handler 时 xstate 保持当前状态 (事件被忽略)。

type PhaseStateConfig = {
  on: Record<string, any>;
};

function buildPhaseStates(): Record<TaskPhase, PhaseStateConfig> {
  const states = {} as Record<TaskPhase, PhaseStateConfig>;
  const allPhases = Object.keys(PHASE_TRANSITIONS) as TaskPhase[];

  for (const from of allPhases) {
    const allowed = PHASE_TRANSITIONS[from];
    const on: Record<string, any> = {};

    if (allowed.length > 0) {
      // PHASE_CHANGE: 列出所有合法 target, guard 精确匹配, action 记录跃迁
      on.PHASE_CHANGE = allowed.map((target) => ({
        target,
        guard: ({ event }: { event: TaskMachineEvent }) =>
          event.type === 'PHASE_CHANGE' && event.to === target,
        actions: 'recordTransition',
      }));
    }

    // ERROR 事件: 除 DONE (终态) 和 ERROR (自身) 外都可转 ERROR
    if (from !== 'DONE' && from !== 'ERROR') {
      on.ERROR = { target: 'ERROR', actions: 'recordTransition' };
    }

    states[from] = { on };
  }

  return states;
}

// ==================== Machine 定义 ====================

const taskMachineSetup = setup({
  types: {
    context: {} as TaskMachineContext,
    events: {} as TaskMachineEvent,
    input: {} as TaskMachineContext,
  },
  actions: {
    recordTransition: assign(({ context, event }) => ({
      enteredAt: Date.now(),
      transitionCount: context.transitionCount + 1,
      lastDetail:
        event.type === 'PHASE_CHANGE'
          ? event.detail
          : event.type === 'ERROR'
            ? event.message
            : context.lastDetail,
    })),
  },
});

export const taskMachine = taskMachineSetup.createMachine({
  id: 'task',
  initial: 'CLARIFY',
  context: ({ input }) => ({
    rootTaskId: input.rootTaskId ?? '',
    chatId: input.chatId ?? '',
    enteredAt: input.enteredAt ?? Date.now(),
    transitionCount: input.transitionCount ?? 0,
    lastDetail: input.lastDetail,
  }),
  states: buildPhaseStates(),
});

// ==================== 快照类型 ====================

export type TaskMachineSnapshot = SnapshotFrom<typeof taskMachine>;

// ==================== 工具函数 (从机器查询, 不依赖 streamingStore) ====================

/**
 * 查询从 current 到 target 的跃迁是否合法
 * 直接复用 PHASE_TRANSITIONS (与机器 states 同源, 保证一致)
 */
export function canTransition(current: TaskPhase, target: TaskPhase): boolean {
  return PHASE_TRANSITIONS[current].includes(target);
}

/**
 * 获取指定 phase 的所有合法跃迁目标
 */
export function getValidTransitions(phase: TaskPhase): TaskPhase[] {
  return [...PHASE_TRANSITIONS[phase]];
}

/**
 * 跃迁并返回新 phase, 非法跃迁返回 null
 * (与 streaming.ts transitionPhase 等价, 从机器视角提供)
 */
export function transitionViaMachine(current: TaskPhase, target: TaskPhase): TaskPhase | null {
  return canTransition(current, target) ? target : null;
}

// ==================== Actor 工厂 (可选: 单 task 一个 actor) ====================

/**
 * 为单个 task 创建 xstate actor
 * 用于需要完整 FSM 能力 (context/guard/action/快照) 的场景
 *
 * 使用示例:
 *   const actor = createTaskMachineActor('root-1', 'chat-1');
 *   actor.start();
 *   actor.send({ type: 'PHASE_CHANGE', to: 'PLANNING' });
 *   const snap = actor.getSnapshot();
 *   // snap.value === 'PLANNING', snap.context.transitionCount === 1
 */
export function createTaskMachineActor(
  rootTaskId: string,
  chatId: string,
  initialPhase: TaskPhase = 'CLARIFY',
): Actor<typeof taskMachine> {
  const actor = createActor(taskMachine, {
    input: {
      rootTaskId,
      chatId,
      enteredAt: Date.now(),
      transitionCount: 0,
    },
  });
  // 若初始 phase 非 CLARIFY, 通过事件跃迁到指定 phase (需合法)
  if (initialPhase !== 'CLARIFY' && canTransition('CLARIFY', initialPhase)) {
    actor.send({ type: 'PHASE_CHANGE', to: initialPhase });
  }
  return actor;
}
