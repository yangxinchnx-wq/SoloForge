// ─────────────────────────────────────────────────────────────────
// 断点调试器 — 模拟 IDE 调试体验
// - 代码视图,可在行号上点击切换断点
// - 单步执行 (step over/into/out/continue)
// - 调用栈 / 变量 / 监视 / 控制台 / 断点 5 个面板
// - 模拟 "断点命中",逐步走过代码,带变量变更动画
// - 支持 3 个预置"运行场景",自动生成命中事件
// ─────────────────────────────────────────────────────────────────

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';

// ── 类型 ──
interface Variable {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'function' | 'null';
  value: string;
  prevValue?: string;  // 用于动画高亮变更
  scope: 'local' | 'global' | 'closure';
}

interface CallFrame {
  id: string;
  function: string;
  file: string;
  line: number;
  args: Array<{ name: string; value: string }>;
}

interface WatchEntry {
  id: string;
  expr: string;
  value: string;
  changed: boolean;
}

interface Breakpoint {
  id: string;
  file: string;
  line: number;
  enabled: boolean;
  hitCount: number;
  condition?: string;
}

interface ConsoleEntry {
  id: string;
  ts: number;
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
}

interface SceneStep {
  /** 行号 (在 sampleCode 中的行号) */
  line: number;
  /** 变量状态 */
  vars: Variable[];
  /** 活动栈 */
  stack: CallFrame[];
  /** 命中的断点 id (null=未命中) */
  breakId?: string;
  /** 是否有控制台输出 */
  console?: Omit<ConsoleEntry, 'id' | 'ts'>[];
  /** 当前活动 watch 表达式结果 */
  watchUpdates?: Array<{ id: string; value: string }>;
  /** 描述当前步骤 */
  description: string;
}

interface Scene {
  id: string;
  name: string;
  icon: string;
  file: string;
  language: 'typescript' | 'javascript' | 'python' | 'rust';
  code: string;
  steps: SceneStep[];
  initialBreakpoints: Array<{ line: number; condition?: string }>;
}

// ── 预置场景 ──
const SAMPLE_TYPE_SCRIPT: Scene = {
  id: 'ts-quicksort',
  name: 'Quicksort 排序演示',
  icon: 'sort',
  file: 'src/algorithms/quicksort.ts',
  language: 'typescript',
  code: `export function quicksort(arr: number[], lo = 0, hi = arr.length - 1): number[] {
  if (lo < hi) {
    const p = partition(arr, lo, hi);
    quicksort(arr, lo, p - 1);
    quicksort(arr, p + 1, hi);
  }
  return arr;
}

function partition(arr: number[], lo: number, hi: number): number {
  const pivot = arr[hi];
  let i = lo - 1;
  for (let j = lo; j < hi; j++) {
    if (arr[j] <= pivot) {
      i++;
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
  [arr[i + 1], arr[hi]] = [arr[hi], arr[i + 1]];
  return i + 1;
}

const input = [5, 3, 8, 1, 9, 2, 7];
const sorted = quicksort([...input]);
console.log('sorted:', sorted);`,
  initialBreakpoints: [
    { line: 2 },
    { line: 11, condition: 'j === 3' },
    { line: 21 },
  ],
  steps: [
    {
      line: 21,
      description: '入口: 准备调用 quicksort',
      stack: [
        { id: 'f0', function: '<module>', file: 'src/algorithms/quicksort.ts', line: 21, args: [] },
      ],
      vars: [
        { name: 'input', type: 'array', value: '[5, 3, 8, 1, 9, 2, 7]', scope: 'global' },
      ],
      watchUpdates: [{ id: 'w_len', value: '7' }],
    },
    {
      line: 2,
      description: 'quicksort([5,3,8,1,9,2,7], 0, 6)',
      breakId: 'bp0',
      stack: [
        { id: 'f0', function: '<module>', file: 'src/algorithms/quicksort.ts', line: 21, args: [] },
        { id: 'f1', function: 'quicksort', file: 'src/algorithms/quicksort.ts', line: 2, args: [
          { name: 'arr', value: '[5, 3, 8, 1, 9, 2, 7]' },
          { name: 'lo',  value: '0' },
          { name: 'hi',  value: '6' },
        ] },
      ],
      vars: [
        { name: 'arr', type: 'array', value: '[5, 3, 8, 1, 9, 2, 7]', scope: 'local' },
        { name: 'lo',  type: 'number', value: '0', scope: 'local' },
        { name: 'hi',  type: 'number', value: '6', scope: 'local' },
        { name: 'p',   type: 'number', value: 'undefined', scope: 'local' },
      ],
    },
    {
      line: 3,
      description: '计算 partition(0, 6) — 选 pivot = arr[6] = 7',
      stack: [
        { id: 'f0', function: '<module>', file: 'src/algorithms/quicksort.ts', line: 21, args: [] },
        { id: 'f1', function: 'quicksort', file: 'src/algorithms/quicksort.ts', line: 3, args: [
          { name: 'arr', value: '[5, 3, 8, 1, 9, 2, 7]' },
          { name: 'lo',  value: '0' },
          { name: 'hi',  value: '6' },
        ] },
      ],
      vars: [
        { name: 'arr', type: 'array', value: '[5, 3, 8, 1, 9, 2, 7]', scope: 'local' },
        { name: 'lo',  type: 'number', value: '0', scope: 'local' },
        { name: 'hi',  type: 'number', value: '6', scope: 'local' },
      ],
      watchUpdates: [{ id: 'w_pivot', value: '7' }],
    },
    {
      line: 12,
      description: 'partition: pivot = 7, i = -1, 遍历 j=0..5',
      stack: [
        { id: 'f0', function: '<module>', file: 'src/algorithms/quicksort.ts', line: 21, args: [] },
        { id: 'f1', function: 'quicksort', file: 'src/algorithms/quicksort.ts', line: 3, args: [{ name: 'arr', value: '[...]' }] },
        { id: 'f2', function: 'partition', file: 'src/algorithms/quicksort.ts', line: 12, args: [
          { name: 'arr', value: '[5, 3, 8, 1, 9, 2, 7]' },
          { name: 'lo',  value: '0' },
          { name: 'hi',  value: '6' },
          { name: 'pivot', value: '7' },
          { name: 'i',   value: '-1' },
        ] },
      ],
      vars: [
        { name: 'pivot', type: 'number', value: '7', scope: 'local' },
        { name: 'i',     type: 'number', value: '-1', scope: 'local' },
        { name: 'j',     type: 'number', value: '0', scope: 'local' },
      ],
    },
    {
      line: 13,
      description: 'j=0: arr[0]=5 ≤ 7 ✓, i++ → 0, 交换 arr[0] 和 arr[0]',
      stack: [
        { id: 'f0', function: '<module>', file: 'src/algorithms/quicksort.ts', line: 21, args: [] },
        { id: 'f1', function: 'quicksort', file: 'src/algorithms/quicksort.ts', line: 3, args: [] },
        { id: 'f2', function: 'partition', file: 'src/algorithms/quicksort.ts', line: 13, args: [] },
      ],
      vars: [
        { name: 'pivot', type: 'number', value: '7', scope: 'local' },
        { name: 'i',     type: 'number', value: '0', prevValue: '-1', scope: 'local' },
        { name: 'j',     type: 'number', value: '0', scope: 'local' },
      ],
      console: [{ level: 'log', text: 'swap arr[0]<->arr[0]: no change' }],
    },
    {
      line: 13,
      description: 'j=1: arr[1]=3 ≤ 7 ✓, i++ → 1, 交换 arr[1] 和 arr[1]',
      breakId: 'bp1',
      stack: [
        { id: 'f0', function: '<module>', file: 'src/algorithms/quicksort.ts', line: 21, args: [] },
        { id: 'f1', function: 'quicksort', file: 'src/algorithms/quicksort.ts', line: 3, args: [] },
        { id: 'f2', function: 'partition', file: 'src/algorithms/quicksort.ts', line: 13, args: [] },
      ],
      vars: [
        { name: 'pivot', type: 'number', value: '7', scope: 'local' },
        { name: 'i',     type: 'number', value: '1', prevValue: '0', scope: 'local' },
        { name: 'j',     type: 'number', value: '1', scope: 'local' },
      ],
    },
    {
      line: 13,
      description: 'j=2: arr[2]=8 > 7 ✗, 跳过',
      stack: [
        { id: 'f0', function: '<module>', file: 'src/algorithms/quicksort.ts', line: 21, args: [] },
        { id: 'f1', function: 'quicksort', file: 'src/algorithms/quicksort.ts', line: 3, args: [] },
        { id: 'f2', function: 'partition', file: 'src/algorithms/quicksort.ts', line: 13, args: [] },
      ],
      vars: [
        { name: 'pivot', type: 'number', value: '7', scope: 'local' },
        { name: 'i',     type: 'number', value: '1', scope: 'local' },
        { name: 'j',     type: 'number', value: '2', scope: 'local' },
      ],
    },
    {
      line: 17,
      description: 'j=5 结束, 把 pivot 放到 i+1=2 位置: 交换 arr[2] 和 arr[6]',
      stack: [
        { id: 'f0', function: '<module>', file: 'src/algorithms/quicksort.ts', line: 21, args: [] },
        { id: 'f1', function: 'quicksort', file: 'src/algorithms/quicksort.ts', line: 3, args: [] },
        { id: 'f2', function: 'partition', file: 'src/algorithms/quicksort.ts', line: 17, args: [] },
      ],
      vars: [
        { name: 'pivot', type: 'number', value: '7', scope: 'local' },
        { name: 'i',     type: 'number', value: '1', scope: 'local' },
        { name: 'j',     type: 'number', value: '5', prevValue: '4', scope: 'local' },
      ],
      watchUpdates: [{ id: 'w_arr', value: '[5, 3, 7, 1, 9, 2, 8]' }],
    },
    {
      line: 18,
      description: '返回 i+1 = 2 (pivot 位置)',
      stack: [
        { id: 'f0', function: '<module>', file: 'src/algorithms/quicksort.ts', line: 21, args: [] },
        { id: 'f1', function: 'quicksort', file: 'src/algorithms/quicksort.ts', line: 4, args: [] },
        { id: 'f2', function: 'partition', file: 'src/algorithms/quicksort.ts', line: 18, args: [
          { name: 'return', value: '2' },
        ] },
      ],
      vars: [
        { name: 'pivot', type: 'number', value: '7', scope: 'local' },
        { name: 'i',     type: 'number', value: '1', scope: 'local' },
      ],
    },
    {
      line: 22,
      description: '完成! 排序结果: [1, 2, 3, 5, 7, 8, 9]',
      breakId: 'bp2',
      stack: [
        { id: 'f0', function: '<module>', file: 'src/algorithms/quicksort.ts', line: 22, args: [] },
      ],
      vars: [
        { name: 'input',  type: 'array', value: '[5, 3, 8, 1, 9, 2, 7]', scope: 'global' },
        { name: 'sorted', type: 'array', value: '[1, 2, 3, 5, 7, 8, 9]', prevValue: 'undefined', scope: 'global' },
      ],
      console: [{ level: 'log', text: 'sorted: [1, 2, 3, 5, 7, 8, 9]' }],
      watchUpdates: [{ id: 'w_len', value: '7' }, { id: 'w_pivot', value: '7' }, { id: 'w_arr', value: '[1, 2, 3, 5, 7, 8, 9]' }],
    },
  ],
};

const SAMPLE_PYTHON: Scene = {
  id: 'py-binary-search',
  name: 'Binary Search 二分查找',
  icon: 'search',
  file: 'src/algorithms/binary_search.py',
  language: 'python',
  code: `def binary_search(arr, target):
    lo, hi = 0, len(arr) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if arr[mid] == target:
            return mid
        elif arr[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1

arr = [1, 3, 5, 7, 9, 11, 13]
idx = binary_search(arr, 7)
print(f"found at index {idx}")`,
  initialBreakpoints: [
    { line: 3 },
    { line: 5 },
  ],
  steps: [
    { line: 13, description: '入口', stack: [{ id: 'f0', function: '<module>', file: 'binary_search.py', line: 13, args: [] }],
      vars: [{ name: 'arr', type: 'array', value: '[1, 3, 5, 7, 9, 11, 13]', scope: 'global' }] },
    { line: 2, breakId: 'bp0', description: 'binary_search([1,3,5,7,9,11,13], 7)', stack: [
        { id: 'f0', function: '<module>', file: 'binary_search.py', line: 13, args: [] },
        { id: 'f1', function: 'binary_search', file: 'binary_search.py', line: 2, args: [
          { name: 'arr', value: '[1, 3, 5, 7, 9, 11, 13]' },
          { name: 'target', value: '7' },
        ] },
      ],
      vars: [
        { name: 'arr', type: 'array', value: '[1, 3, 5, 7, 9, 11, 13]', scope: 'local' },
        { name: 'target', type: 'number', value: '7', scope: 'local' },
      ] },
    { line: 3, description: 'lo=0, hi=6', stack: [
        { id: 'f0', function: '<module>', file: 'binary_search.py', line: 13, args: [] },
        { id: 'f1', function: 'binary_search', file: 'binary_search.py', line: 3, args: [] },
      ],
      vars: [
        { name: 'lo', type: 'number', value: '0', scope: 'local' },
        { name: 'hi', type: 'number', value: '6', scope: 'local' },
      ] },
    { line: 4, description: 'mid = 3, arr[3] = 7 == target ✓', stack: [
        { id: 'f0', function: '<module>', file: 'binary_search.py', line: 13, args: [] },
        { id: 'f1', function: 'binary_search', file: 'binary_search.py', line: 4, args: [] },
      ],
      vars: [
        { name: 'lo', type: 'number', value: '0', scope: 'local' },
        { name: 'hi', type: 'number', value: '6', scope: 'local' },
        { name: 'mid', type: 'number', value: '3', scope: 'local' },
      ] },
    { line: 5, breakId: 'bp1', description: 'arr[3] = 7, 命中!', stack: [
        { id: 'f0', function: '<module>', file: 'binary_search.py', line: 13, args: [] },
        { id: 'f1', function: 'binary_search', file: 'binary_search.py', line: 5, args: [] },
      ],
      vars: [
        { name: 'lo', type: 'number', value: '0', scope: 'local' },
        { name: 'hi', type: 'number', value: '6', scope: 'local' },
        { name: 'mid', type: 'number', value: '3', scope: 'local' },
      ] },
    { line: 6, description: 'return 3', stack: [
        { id: 'f0', function: '<module>', file: 'binary_search.py', line: 14, args: [] },
        { id: 'f1', function: 'binary_search', file: 'binary_search.py', line: 6, args: [{ name: 'return', value: '3' }] },
      ],
      vars: [
        { name: 'idx', type: 'number', value: '3', scope: 'global' },
      ],
      console: [{ level: 'log', text: 'found at index 3' }] },
  ],
};

const SAMPLE_RUST: Scene = {
  id: 'rust-fib',
  name: 'Fibonacci (Rust)',
  icon: 'calculate',
  file: 'rust_core/src/fib.rs',
  language: 'rust',
  code: `pub fn fib(n: u32) -> u64 {
    if n < 2 {
        return n as u64;
    }
    let mut a: u64 = 0;
    let mut b: u64 = 1;
    for _ in 0..n - 1 {
        let tmp = a + b;
        a = b;
        b = tmp;
    }
    b
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_fib() {
        let result = fib(10);
        assert_eq!(result, 55);
    }
}`,
  initialBreakpoints: [
    { line: 8 },
    { line: 10 },
  ],
  steps: [
    { line: 14, description: '调用 fib(10)', stack: [
        { id: 'f0', function: 'test_fib', file: 'fib.rs', line: 14, args: [] },
      ],
      vars: [] },
    { line: 1, description: 'fib(10) 入口', stack: [
        { id: 'f0', function: 'test_fib', file: 'fib.rs', line: 14, args: [] },
        { id: 'f1', function: 'fib', file: 'fib.rs', line: 1, args: [{ name: 'n', value: '10' }] },
      ],
      vars: [{ name: 'n', type: 'number', value: '10', scope: 'local' }] },
    { line: 5, description: 'a=0, b=1', stack: [
        { id: 'f0', function: 'test_fib', file: 'fib.rs', line: 14, args: [] },
        { id: 'f1', function: 'fib', file: 'fib.rs', line: 5, args: [] },
      ],
      vars: [
        { name: 'a', type: 'number', value: '0', scope: 'local' },
        { name: 'b', type: 'number', value: '1', scope: 'local' },
      ] },
    { line: 7, breakId: 'bp0', description: 'iter 0: tmp=1, a=1, b=1', stack: [
        { id: 'f0', function: 'test_fib', file: 'fib.rs', line: 14, args: [] },
        { id: 'f1', function: 'fib', file: 'fib.rs', line: 7, args: [] },
      ],
      vars: [
        { name: 'a', type: 'number', value: '1', prevValue: '0', scope: 'local' },
        { name: 'b', type: 'number', value: '1', prevValue: '1', scope: 'local' },
        { name: 'tmp', type: 'number', value: '1', scope: 'local' },
      ] },
    { line: 7, description: 'iter 1: tmp=2, a=1, b=2', stack: [
        { id: 'f0', function: 'test_fib', file: 'fib.rs', line: 14, args: [] },
        { id: 'f1', function: 'fib', file: 'fib.rs', line: 7, args: [] },
      ],
      vars: [
        { name: 'a', type: 'number', value: '1', scope: 'local' },
        { name: 'b', type: 'number', value: '2', prevValue: '1', scope: 'local' },
        { name: 'tmp', type: 'number', value: '2', prevValue: '1', scope: 'local' },
      ] },
    { line: 10, breakId: 'bp1', description: 'iter 4: a=5, b=8', stack: [
        { id: 'f0', function: 'test_fib', file: 'fib.rs', line: 14, args: [] },
        { id: 'f1', function: 'fib', file: 'fib.rs', line: 10, args: [] },
      ],
      vars: [
        { name: 'a', type: 'number', value: '5', prevValue: '3', scope: 'local' },
        { name: 'b', type: 'number', value: '8', prevValue: '5', scope: 'local' },
      ] },
    { line: 11, description: '返回 b = 55', stack: [
        { id: 'f0', function: 'test_fib', file: 'fib.rs', line: 15, args: [] },
        { id: 'f1', function: 'fib', file: 'fib.rs', line: 11, args: [{ name: 'return', value: '55' }] },
      ],
      vars: [
        { name: 'result', type: 'number', value: '55', scope: 'closure' },
      ],
      console: [{ level: 'info', text: 'assert_eq!(55, 55) ✓' }] },
  ],
};

const SCENES: Scene[] = [SAMPLE_TYPE_SCRIPT, SAMPLE_PYTHON, SAMPLE_RUST];

// ─── 主组件 ───
interface Props {
  open: boolean;
  onClose: () => void;
}

export function BreakpointDebugger({ open, onClose }: Props) {
  const [sceneId, setSceneId] = useState<string>(SCENES[0].id);
  const scene = useMemo(() => SCENES.find(s => s.id === sceneId) || SCENES[0], [sceneId]);

  // 断点
  const [breakpoints, setBreakpoints] = useState<Breakpoint[]>(() =>
    scene.initialBreakpoints.map((bp, i) => ({
      id: 'bp' + i, file: scene.file, line: bp.line, enabled: true, hitCount: 0, condition: bp.condition,
    }))
  );
  // 监视
  const [watches, setWatches] = useState<WatchEntry[]>([
    { id: 'w_len',   expr: 'arr.length', value: '', changed: false },
    { id: 'w_pivot', expr: 'pivot',     value: '', changed: false },
    { id: 'w_arr',   expr: 'arr',       value: '', changed: false },
  ]);
  const [newWatch, setNewWatch] = useState('');
  // 调试状态
  const [stepIdx, setStepIdx] = useState<number>(-1);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [activeTab, setActiveTab] = useState<'vars' | 'watch' | 'stack' | 'breakpoints' | 'console'>('vars');
  // 派生状态
  const step = stepIdx >= 0 ? scene.steps[stepIdx] : null;
  // 控制台
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);

  // 切换场景时重置
  useEffect(() => {
    setBreakpoints(scene.initialBreakpoints.map((bp, i) => ({
      id: 'bp' + i, file: scene.file, line: bp.line, enabled: true, hitCount: 0, condition: bp.condition,
    })));
    setStepIdx(-1);
    setRunning(false);
    setPaused(false);
    setConsoleEntries([]);
    setWatches(ws => ws.map(w => ({ ...w, value: '', changed: false })));
  }, [sceneId, scene]);

  // 派生当前变量 (合并全局 + 当前栈帧局部)
  const currentVars = useMemo(() => {
    if (!step) return [];
    return step.vars;
  }, [step]);

  // 自动执行
  useEffect(() => {
    if (!running || paused) return;
    if (stepIdx >= scene.steps.length - 1) {
      setRunning(false);
      return;
    }
    const t = setTimeout(() => {
      const next = stepIdx + 1;
      setStepIdx(next);
      applyStep(scene.steps[next]);
    }, 1200);
    return () => clearTimeout(t);
  }, [running, paused, stepIdx, scene]);

  const applyStep = useCallback((s: SceneStep) => {
    // 命中计数
    if (s.breakId) {
      setBreakpoints(bps => bps.map(bp => bp.id === s.breakId ? { ...bp, hitCount: bp.hitCount + 1 } : bp));
      setPaused(true);
      setRunning(false);
    }
    // 控制台
    if (s.console) {
      const newEntries: ConsoleEntry[] = s.console.map((c, i) => ({
        ...c, id: 'c_' + Date.now() + '_' + i, ts: Date.now(),
      }));
      setConsoleEntries(prev => [...newEntries, ...prev].slice(0, 100));
    }
    // watch
    if (s.watchUpdates) {
      setWatches(ws => ws.map(w => {
        const upd = s.watchUpdates?.find(u => u.id === w.id);
        if (!upd) return w;
        return { ...w, value: upd.value, changed: w.value !== '' && w.value !== upd.value };
      }));
    }
  }, []);

  const stepOver = useCallback(() => {
    if (stepIdx >= scene.steps.length - 1) return;
    setPaused(false);
    const next = stepIdx + 1;
    setStepIdx(next);
    applyStep(scene.steps[next]);
  }, [stepIdx, scene, applyStep]);

  const stepInto = useCallback(() => {
    // 简化: 同 stepOver
    stepOver();
  }, [stepOver]);

  const stepOut = useCallback(() => {
    // 简化: 跳 3 步
    if (stepIdx >= scene.steps.length - 1) return;
    setPaused(false);
    const next = Math.min(stepIdx + 3, scene.steps.length - 1);
    setStepIdx(next);
    applyStep(scene.steps[next]);
  }, [stepIdx, scene, applyStep]);

  const continueRun = useCallback(() => {
    setPaused(false);
    setRunning(true);
  }, []);

  const restart = useCallback(() => {
    setStepIdx(-1);
    setConsoleEntries([]);
    setPaused(false);
    setRunning(true);
    setBreakpoints(bps => bps.map(bp => ({ ...bp, hitCount: 0 })));
  }, []);

  const toggleBreakpoint = useCallback((line: number) => {
    setBreakpoints(bps => {
      const existing = bps.find(bp => bp.line === line);
      if (existing) return bps.filter(bp => bp.line !== line);
      return [...bps, { id: 'bp_' + Date.now().toString(36), file: scene.file, line, enabled: true, hitCount: 0 }];
    });
  }, [scene.file]);

  const toggleBreakpointEnabled = useCallback((id: string) => {
    setBreakpoints(bps => bps.map(bp => bp.id === id ? { ...bp, enabled: !bp.enabled } : bp));
  }, []);

  const removeBreakpoint = useCallback((id: string) => {
    setBreakpoints(bps => bps.filter(bp => bp.id !== id));
  }, []);

  const addWatch = useCallback(() => {
    if (!newWatch.trim()) return;
    setWatches(ws => [...ws, { id: 'w_' + Date.now().toString(36), expr: newWatch.trim(), value: '<未求值>', changed: false }]);
    setNewWatch('');
  }, [newWatch]);

  const removeWatch = useCallback((id: string) => {
    setWatches(ws => ws.filter(w => w.id !== id));
  }, []);

  // ── 渲染 ──
  if (!open) return null;

  const lines = scene.code.split('\n');
  const currentLine = step?.line || 0;
  const currentBreakId = step?.breakId;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[min(98vw,1280px)] h-[min(94vh,820px)] bg-bg-elevated border border-border rounded-xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center px-4 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">bug_report</span>
            <h2 className="text-base font-semibold">断点调试器</h2>
            <span className="text-xs text-text-secondary ml-2">{scene.name} · 模拟运行</span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {/* 场景选择 */}
            <select
              value={sceneId}
              onChange={e => setSceneId(e.target.value)}
              className="px-2 py-1 text-xs rounded border border-border bg-bg"
            >
              {SCENES.map(s => (
                <option key={s.id} value={s.id}>{s.icon} {s.name}</option>
              ))}
            </select>

            {/* 调试按钮 */}
            <div className="flex items-center gap-0.5 ml-2 px-1 py-0.5 rounded border border-border">
              <button
                onClick={stepInto}
                disabled={stepIdx >= scene.steps.length - 1}
                className="p-1 hover:bg-bg-dim rounded disabled:opacity-30"
                title="Step Into (F11)"
              >
                <span className="material-symbols-outlined text-base">arrow_downward</span>
              </button>
              <button
                onClick={stepOver}
                disabled={stepIdx >= scene.steps.length - 1}
                className="p-1 hover:bg-bg-dim rounded disabled:opacity-30"
                title="Step Over (F10)"
              >
                <span className="material-symbols-outlined text-base">redo</span>
              </button>
              <button
                onClick={stepOut}
                disabled={stepIdx >= scene.steps.length - 1}
                className="p-1 hover:bg-bg-dim rounded disabled:opacity-30"
                title="Step Out (Shift+F11)"
              >
                <span className="material-symbols-outlined text-base">arrow_upward</span>
              </button>
              <button
                onClick={continueRun}
                disabled={!paused && !running}
                className="p-1 hover:bg-bg-dim rounded disabled:opacity-30"
                title="Continue (F5)"
              >
                <span className="material-symbols-outlined text-base text-success">play_arrow</span>
              </button>
              <button
                onClick={restart}
                className="p-1 hover:bg-bg-dim rounded"
                title="Restart"
              >
                <span className="material-symbols-outlined text-base">refresh</span>
              </button>
            </div>

            <button onClick={onClose} className="px-2 py-1 rounded hover:bg-bg-dim text-text-secondary ml-1">
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          </div>
        </div>

        {/* 状态条 */}
        {step && (
          <div className="px-4 py-1.5 border-b border-border bg-bg-dim/50 text-xs text-text-secondary flex items-center gap-3 shrink-0">
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
              {paused ? '已暂停' : '运行中'}
            </span>
            <span>·</span>
            <span>第 {stepIdx + 1}/{scene.steps.length} 步</span>
            <span>·</span>
            <span className="text-text truncate">{step.description}</span>
            {currentBreakId && (
              <>
                <span>·</span>
                <span className="text-warning">▶ 命中 {currentBreakId}</span>
              </>
            )}
          </div>
        )}

        <div className="flex-1 flex min-h-0">
          {/* 左侧: 代码视图 */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="px-3 py-1.5 border-b border-border text-xs text-text-secondary flex items-center gap-2 shrink-0">
              <span className="material-symbols-outlined text-sm">code</span>
              <span className="truncate">{scene.file}</span>
              <span className="ml-auto text-text-secondary/70">{scene.language}</span>
            </div>
            <div className="flex-1 overflow-auto font-mono text-xs">
              {lines.map((line, i) => {
                const ln = i + 1;
                const bp = breakpoints.find(b => b.line === ln);
                const isCurrent = currentLine === ln;
                return (
                  <div
                    key={ln}
                    onClick={() => toggleBreakpoint(ln)}
                    className={
                      'flex items-center group cursor-pointer hover:bg-bg-dim/40 ' +
                      (isCurrent ? 'bg-warning/15' : '')
                    }
                  >
                    {/* 行号 + 断点槽 */}
                    <div className="w-14 flex items-center justify-end pr-2 py-0.5 text-text-secondary/50 select-none relative">
                      <span className="group-hover:opacity-0 transition-opacity">{ln}</span>
                      {bp ? (
                        <span
                          className="absolute right-2 material-symbols-outlined text-sm"
                          style={{ color: bp.enabled ? '#ef4444' : '#6b7280' }}
                        >{bp.enabled ? 'circle' : 'radio_button_unchecked'}</span>
                      ) : (
                        <span className="absolute right-2 opacity-0 group-hover:opacity-100 material-symbols-outlined text-sm text-text-secondary/40">circle</span>
                      )}
                    </div>
                    {/* 代码 */}
                    <div className="flex-1 py-0.5 pr-4 whitespace-pre text-text">
                      {line || ' '}
                      {isCurrent && <span className="inline-block w-0.5 h-3.5 bg-warning ml-0.5 -mb-0.5 animate-pulse" />}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 右侧: 调试面板 */}
          <div className="w-80 border-l border-border flex flex-col shrink-0">
            {/* Tab 栏 */}
            <div className="flex border-b border-border shrink-0">
              {([
                { id: 'vars',        label: '变量', icon: 'data_object' },
                { id: 'watch',       label: '监视', icon: 'visibility' },
                { id: 'stack',       label: '栈',   icon: 'layers' },
                { id: 'breakpoints', label: '断点', icon: 'adjust' },
                { id: 'console',     label: '控制', icon: 'terminal' },
              ] as const).map(t => (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id)}
                  className={
                    'flex-1 px-2 py-2 text-xs flex flex-col items-center gap-0.5 border-b-2 ' +
                    (activeTab === t.id ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text')
                  }
                >
                  <span className="material-symbols-outlined text-base">{t.icon}</span>
                  {t.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-auto">
              {/* 变量 */}
              {activeTab === 'vars' && (
                <div className="text-xs">
                  {currentVars.length === 0 && (
                    <div className="px-3 py-6 text-center text-text-secondary">未运行或当前帧无变量</div>
                  )}
                  {(['local', 'closure', 'global'] as const).map(scope => {
                    const vars = currentVars.filter(v => v.scope === scope);
                    if (vars.length === 0) return null;
                    return (
                      <div key={scope} className="border-b border-border">
                        <div className="px-3 py-1 text-text-secondary uppercase tracking-wide bg-bg-dim/30 text-[10px]">
                          {scope === 'local' ? 'Local' : scope === 'closure' ? 'Closure' : 'Global'}
                        </div>
                        {vars.map(v => (
                          <div key={v.name} className="px-3 py-1 flex items-center gap-2 hover:bg-bg-dim/40">
                            <span className="material-symbols-outlined text-sm text-text-secondary" title={v.type}>
                              {v.type === 'string' ? 'abc' : v.type === 'number' ? 'tag' : v.type === 'boolean' ? 'toggle_on' : v.type === 'array' ? 'data_array' : v.type === 'function' ? 'function' : v.type === 'null' ? 'block' : 'data_object'}
                            </span>
                            <span className="font-medium text-text">{v.name}</span>
                            <span className="text-text-secondary">=</span>
                            <span className={'flex-1 truncate ' + (v.prevValue !== undefined ? 'text-warning animate-pulse' : 'text-primary')}>
                              {v.value}
                            </span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 监视 */}
              {activeTab === 'watch' && (
                <div className="text-xs">
                  <div className="p-2 flex gap-1 border-b border-border">
                    <input
                      type="text"
                      value={newWatch}
                      onChange={e => setNewWatch(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') addWatch(); }}
                      placeholder="+ 添加监视表达式"
                      className="flex-1 px-2 py-1 rounded border border-border bg-bg"
                    />
                    <button
                      onClick={addWatch}
                      disabled={!newWatch.trim()}
                      className="px-2 py-1 rounded bg-primary text-bg disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-sm">add</span>
                    </button>
                  </div>
                  {watches.map(w => (
                    <div key={w.id} className="px-3 py-1.5 border-b border-border/50 flex items-center gap-2 group">
                      <span className="font-mono text-primary">{w.expr}</span>
                      <span className="text-text-secondary">=</span>
                      <span className={'flex-1 truncate ' + (w.changed ? 'text-warning' : 'text-text')}>{w.value || '<未求值>'}</span>
                      {w.changed && <span className="material-symbols-outlined text-sm text-warning">change_circle</span>}
                      <button onClick={() => removeWatch(w.id)} className="opacity-0 group-hover:opacity-100 text-text-secondary hover:text-danger">
                        <span className="material-symbols-outlined text-sm">close</span>
                      </button>
                    </div>
                  ))}
                  {watches.length === 0 && (
                    <div className="px-3 py-6 text-center text-text-secondary">暂无监视</div>
                  )}
                </div>
              )}

              {/* 调用栈 */}
              {activeTab === 'stack' && (
                <div className="text-xs">
                  {(!step || step.stack.length === 0) && (
                    <div className="px-3 py-6 text-center text-text-secondary">无活动栈</div>
                  )}
                  {step && step.stack.map((f, i) => (
                    <div key={f.id} className={'px-3 py-1.5 border-b border-border/50 ' + (i === step.stack.length - 1 ? 'bg-primary/10' : '')}>
                      <div className="flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-sm text-text-secondary">function</span>
                        <span className="font-mono font-medium text-text">{f.function}</span>
                        <span className="ml-auto text-text-secondary">{f.file.split('/').pop()}:{f.line}</span>
                      </div>
                      {f.args.length > 0 && (
                        <div className="mt-0.5 pl-5 text-text-secondary">
                          {f.args.map(a => (
                            <div key={a.name}>
                              <span className="text-primary">{a.name}</span>=<span className="text-text">{a.value}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* 断点 */}
              {activeTab === 'breakpoints' && (
                <div className="text-xs">
                  {breakpoints.length === 0 && (
                    <div className="px-3 py-6 text-center text-text-secondary">点击行号添加断点</div>
                  )}
                  {breakpoints.map(bp => (
                    <div key={bp.id} className="px-3 py-1.5 border-b border-border/50 flex items-center gap-2 group">
                      <button onClick={() => toggleBreakpointEnabled(bp.id)}>
                        <span
                          className="material-symbols-outlined text-sm"
                          style={{ color: bp.enabled ? '#ef4444' : '#6b7280' }}
                        >{bp.enabled ? 'circle' : 'radio_button_unchecked'}</span>
                      </button>
                      <div className="flex-1">
                        <div className="font-mono">{scene.file.split('/').pop()}:<span className="text-primary font-bold">{bp.line}</span></div>
                        {bp.condition && <div className="text-text-secondary text-[10px]">if ({bp.condition})</div>}
                      </div>
                      <span className="text-text-secondary text-[10px]">×{bp.hitCount}</span>
                      <button onClick={() => removeBreakpoint(bp.id)} className="opacity-0 group-hover:opacity-100 text-text-secondary hover:text-danger">
                        <span className="material-symbols-outlined text-sm">close</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* 控制台 */}
              {activeTab === 'console' && (
                <div className="text-xs font-mono">
                  <div className="p-2 border-b border-border flex gap-1">
                    <input
                      type="text"
                      placeholder="(模拟) 输入表达式"
                      className="flex-1 px-2 py-1 rounded border border-border bg-bg"
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          const v = (e.target as HTMLInputElement).value;
                          if (!v.trim()) return;
                          setConsoleEntries(prev => [{ id: 'c_' + Date.now(), ts: Date.now(), level: 'log' as const, text: '> ' + v + '\n< ' + (Math.random() < 0.5 ? 'undefined' : '42') }, ...prev].slice(0, 100));
                          (e.target as HTMLInputElement).value = '';
                        }
                      }}
                    />
                  </div>
                  {consoleEntries.length === 0 && (
                    <div className="px-3 py-6 text-center text-text-secondary">无输出</div>
                  )}
                  {consoleEntries.map(c => (
                    <div
                      key={c.id}
                      className={
                        'px-3 py-1 border-b border-border/50 whitespace-pre-wrap break-all ' +
                        (c.level === 'error' ? 'text-danger' : c.level === 'warn' ? 'text-warning' : c.level === 'info' ? 'text-primary' : 'text-text')
                      }
                    >
                      {c.text}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
