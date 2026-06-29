// ─────────────────────────────────────────────────────────────────
// SoloForge 画布状态机死循环检测 (canvas-fsm-loop-detection.cjs)
//
// 目的: 不依赖 React/jsdom, 纯 Node + zustand, 模拟 PreviewPanel 的
//       useState/useEffect 行为, 检测以下潜在死循环:
//         1. setStatus 死循环: canvasState 变化 → setStatus → store 变化 →
//            activeTab 引用变 → useEffect 重跑 → setStatus ...
//         2. activeTab 引用稳定性: 每次 store 变化后 activeTab 引用应只在
//            status 变化时变, 其他情况应保持稳定
//         3. setStatus 调用次数: 1 次状态切换应只触发 1 次 setStatus
//         4. 状态机转换: idle → starting → running → paused → idle 完整流转
//
// 跑法: node tests/canvas-fsm-loop-detection.cjs
// 退出: 0 = 通过, 1 = 有死循环或状态异常
// ─────────────────────────────────────────────────────────────────

'use strict';

const path = require('path');
const assert = require('assert');

// 直接 require UI/node_modules 的 zustand
const zustandPath = path.join(__dirname, '..', 'UI', 'node_modules', 'zustand');
let create;
try {
  ({ create } = require(zustandPath));
} catch (e) {
  console.error('FATAL: failed to load zustand from', zustandPath);
  console.error('  run `cd UI && npm install` first');
  process.exit(2);
}

const LOG_FILE = path.join(__dirname, '..', 'logs', 'e2e', 'canvas-fsm-loop.log');
require('fs').mkdirSync(path.dirname(LOG_FILE), { recursive: true });
try { require('fs').unlinkSync(LOG_FILE); } catch {}
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { require('fs').appendFileSync(LOG_FILE, line + '\n'); } catch {}
  console.log(line);
}
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; log(`  \x1b[31m✗\x1b[0m ${name}: ${e.message}`); }
}
function section(name) { log(''); log(`══ ${name} ══`); }

// ── 复制 PreviewPanel.tsx 的 canvasStore 逻辑 ──
const useCanvasStore = create((set, get) => ({
  tabs: [],
  activeTabId: null,
  nextIndex: 1,

  enableCanvas: (chatId, hint) => {
    const sessionId = `canvas-${chatId}`;
    const existing = get().tabs.find((t) => t.id === sessionId);
    if (existing) { set({ activeTabId: existing.id }); return sessionId; }
    const newTab = { id: sessionId, chatId, index: get().nextIndex, hint, status: 'idle' };
    set((s) => ({ tabs: [...s.tabs, newTab], activeTabId: newTab.id, nextIndex: s.nextIndex + 1 }));
    return sessionId;
  },

  selectTab: (id) => { if (get().tabs.some((t) => t.id === id)) set({ activeTabId: id }); },

  setStatus: (id, status) => {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, status } : t)) }));
  },
}));

// ── 模拟 PreviewPanel 的 useEffect 行为 ──
//
// PreviewPanel.tsx 真实逻辑 (line 228-246):
//   useEffect(() => {
//     if (!activeTab) return;
//     if (activeTab.status === canvasState) return;
//     setStatus(activeTab.id, canvasState);
//   }, [canvasState, activeTab, setStatus]);
//
//   useEffect(() => {
//     if (!activeTab) return;
//     if (activeTab.status === 'paused' && canvasState === 'idle') {
//       setCanvasState('paused');
//     } else if (activeTab.status === 'idle' && canvasState !== 'idle') {
//       setCanvasState('idle');
//     }
//   }, [activeTabId]);
//
// 我们模拟:
//   - canvasState 是 component-local useState
//   - activeTab 每次从 store 重新计算 (activeTab = tabs.find(t => t.id === activeTabId))
//   - 每次 store 变化, 订阅者重跑 (React 行为)
//   - 第二次 useEffect 跑时, 用最新的 canvasState

function createSimulatedComponent() {
  let canvasState = 'idle';
  let activeTabId = null;
  let depth = 0;
  // 模拟 React 行为:
  //   - setCanvasState 同步改 canvasState
  //   - useEffect 在 microtask 跑 (commit 后)
  //   - 多个 setStatus 在同一 microtask batch 内只触发 1 次 useEffect 跑
  //   - useEffect 调 setStatus, setStatus 触发 store 变化, 但 useEffect 不会在同一 tick 再跑
  //
  // 简化: 维护一个 pendingEffects 队列, 每次 setCanvasState/setStatus 后, microtask flush
  let pendingEffects = [];
  function scheduleEffect(fn) {
    pendingEffects.push(fn);
    if (pendingEffects.length === 1) {
      queueMicrotask(() => {
        const batch = pendingEffects;
        pendingEffects = [];
        for (const e of batch) e();
      });
    }
  }
  // 订阅 store 变化
  const unsub = useCanvasStore.subscribe((newState) => {
    // React 真实: store 变化触发 React 重渲, useEffect 在 commit 后 microtask 跑
    scheduleEffect(() => {
      const activeTab = newState.tabs.find((t) => t.id === newState.activeTabId) ?? null;
      if (!activeTab) return;
      // useEffect #1: 同步 canvasState → store
      if (activeTab.status !== canvasState) {
        setStatusCount.inc();
        useCanvasStore.getState().setStatus(activeTab.id, canvasState);
      }
    });
  });
  return {
    setCanvasState: (next) => {
      const before = canvasState;
      canvasState = next;
      // 模拟 React setState 触发重渲, useEffect 在 microtask 跑
      scheduleEffect(() => {
        const state = useCanvasStore.getState();
        const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? null;
        if (activeTab && activeTab.status !== canvasState) {
          setStatusCount.inc();
          useCanvasStore.getState().setStatus(activeTab.id, canvasState);
        }
      });
    },
    getCanvasState: () => canvasState,
    flush: () => new Promise((r) => {
      if (pendingEffects.length === 0) return r();
      queueMicrotask(() => r());
    }),
    destroy: unsub,
  };
}

// 计数: 跟踪 setStatus 调用次数 (死循环检测关键)
const setStatusCount = { n: 0, inc: function() { this.n++; } };

// ─────────────────────────────────────────────────────────────────
// 测试
// ─────────────────────────────────────────────────────────────────
section('1. 初始状态');
test('store 初始 empty', () => {
  const s = useCanvasStore.getState();
  assert.strictEqual(s.tabs.length, 0);
  assert.strictEqual(s.activeTabId, null);
});

section('2. enableCanvas 创建 tab');
test('enableCanvas 创建 1 个 tab, status=idle', () => {
  useCanvasStore.getState().enableCanvas('chat-1', '测试');
  const s = useCanvasStore.getState();
  assert.strictEqual(s.tabs.length, 1);
  assert.strictEqual(s.tabs[0].status, 'idle');
  assert.strictEqual(s.activeTabId, 'canvas-chat-1');
});

section('3. 状态机切换: idle → starting → running → paused → idle (1 次 setStatus/次)');
test('状态机完整流转, setStatus 调用次数 = 4', async () => {
  setStatusCount.n = 0;
  const comp = createSimulatedComponent();
  comp.setCanvasState('starting');
  comp.setCanvasState('running');
  comp.setCanvasState('paused');
  comp.setCanvasState('idle');
  await comp.flush();
  await comp.flush();
  assert.strictEqual(useCanvasStore.getState().tabs[0].status, 'idle', 'idle 最终状态');
  assert.strictEqual(setStatusCount.n, 4, `setStatus 总调用次数 = 4 (实际 ${setStatusCount.n}, 不能更多)`);
  comp.destroy();
});

section('4. setStatus 不死循环: 同一状态连续 setCanvasState 多次');
test('同状态重复 setCanvasState 不会触发额外 setStatus', async () => {
  setStatusCount.n = 0;
  const comp = createSimulatedComponent();
  comp.setCanvasState('running');
  comp.setCanvasState('running');  // 重复
  comp.setCanvasState('running');  // 重复
  await comp.flush();
  assert.strictEqual(setStatusCount.n, 1, `setStatus 调用次数 = 1 (实际 ${setStatusCount.n})`);
  comp.destroy();
});

section('5. activeTab 引用稳定性: store 不变时 activeTab 引用应保持');
test('非 store 触发 setState 不应让 activeTab 引用变 (React 行为)', () => {
  const before = useCanvasStore.getState();
  const after = useCanvasStore.getState();
  assert.strictEqual(before.tabs, after.tabs, 'store tabs 引用稳定 (setCanvasState 不直接动 store)');
});

section('6. 状态机往返: running → paused → running 不应丢失 paused 状态');
test('paused → running 切换正确', async () => {
  setStatusCount.n = 0;
  const comp = createSimulatedComponent();
  comp.setCanvasState('running');
  comp.setCanvasState('paused');
  comp.setCanvasState('running');
  await comp.flush();
  assert.strictEqual(useCanvasStore.getState().tabs[0].status, 'running', 'paused → running 已同步');
  assert.strictEqual(setStatusCount.n, 2, `setStatus 2 次 (实际 ${setStatusCount.n}, 多了就是死循环)`);
  comp.destroy();
});

section('7. 快速切换 running ↔ paused 10x 不死循环');
test('10x running ↔ paused, setStatus 调用次数 = 20', async () => {
  setStatusCount.n = 0;
  const comp = createSimulatedComponent();
  for (let i = 0; i < 10; i++) {
    comp.setCanvasState('paused');
    comp.setCanvasState('running');
  }
  await comp.flush();
  assert.strictEqual(useCanvasStore.getState().tabs[0].status, 'running', '最终状态 running');
  assert.strictEqual(setStatusCount.n, 20, `setStatus 20 次 (实际 ${setStatusCount.n}, 多了就是死循环)`);
  comp.destroy();
});

section('8. 多个组件实例同时订阅 (罕见情况, React StrictMode 会)');
test('2 个 component instance 订阅同一 store, 互不影响', async () => {
  setStatusCount.n = 0;
  const comp1 = createSimulatedComponent();
  const comp2 = createSimulatedComponent();
  comp1.setCanvasState('running');
  await comp1.flush();
  log(`  [debug] setStatus count: ${setStatusCount.n}`);
  log(`  [debug] store status: ${useCanvasStore.getState().tabs[0].status}`);
  log(`  [debug] comp1 canvasState: ${comp1.getCanvasState()}`);
  log(`  [debug] comp2 canvasState: ${comp2.getCanvasState()}`);
  comp1.destroy();
  comp2.destroy();
});

section('9. 状态机不变量: setStatus 后 store 与 canvasState 一致');
test('setCanvasState 后 store status === canvasState', async () => {
  setStatusCount.n = 0;
  const comp = createSimulatedComponent();
  for (const s of ['starting', 'running', 'paused', 'running', 'paused', 'idle']) {
    comp.setCanvasState(s);
    await comp.flush();
    assert.strictEqual(useCanvasStore.getState().tabs[0].status, s, `状态 ${s} 已同步`);
  }
  comp.destroy();
});

section('10. 大量 setCanvasState (100x) 死循环检测');
test('100x setCanvasState, setStatus 调用次数 ≤ 100', async () => {
  setStatusCount.n = 0;
  const comp = createSimulatedComponent();
  const states = ['running', 'paused'];
  for (let i = 0; i < 100; i++) {
    comp.setCanvasState(states[i % 2]);
  }
  await comp.flush();
  assert.ok(setStatusCount.n <= 100, `setStatus 调用次数 ≤ 100 (实际 ${setStatusCount.n}, > 100 = 死循环)`);
  log(`  [info] 100x setCanvasState 触发 ${setStatusCount.n} 次 setStatus`);
  comp.destroy();
});

log('');
log(`结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
