/**
 * validators.test.ts
 *
 * 单元测试入口: 在 UI 目录执行
 *   npx vitest run tests/validators.test.ts
 *
 * 如未安装 vitest, 可用 Node 24 内置 node:test:
 *   npx tsx tests/validators.test.ts
 *
 * 当前使用纯函数断言, 避免依赖问题。
 */

import {
  isDeviceInstance,
  isDeviceInstanceArray,
  isSessionState,
  repairSessionState,
  validateScreenUV,
} from '../src/server/services/canvas/validators';
import type { DeviceInstance, SessionState } from '../src/server/services/canvas/types';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, name: string): void {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  [FAIL] ${name}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function makeValidDevice(overrides: Partial<DeviceInstance> = {}): DeviceInstance {
  return {
    id: 'dev-1',
    modelKey: 'iphone_14_pro',
    xRatio: 0.5,
    yRatio: 0.5,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
    displayScale: 1,
    isSelected: false,
    highlightColor: '#FF6B6B',
    ...overrides,
  };
}

function makeValidSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: 'sess-1',
    selectedDeviceKey: 'fill',
    devices: [],
    bgColor: '#FFFFFF',
    selectedDeviceId: null,
    lastUpdated: 1234567890,
    ...overrides,
  };
}

// ============================================================
section('isDeviceInstance');

// 合法
assert(
  isDeviceInstance(makeValidDevice()),
  'valid device passes'
);

// 缺字段
assert(
  !isDeviceInstance({ ...makeValidDevice(), id: '' }),
  'empty id fails'
);
assert(
  !isDeviceInstance({ ...makeValidDevice(), xRatio: 1.5 }),
  'xRatio > 1 fails'
);
assert(
  !isDeviceInstance({ ...makeValidDevice(), xRatio: -0.1 }),
  'xRatio < 0 fails'
);
assert(
  !isDeviceInstance({ ...makeValidDevice(), highlightColor: 'red' }),
  'invalid hex color fails'
);
assert(
  !isDeviceInstance({ ...makeValidDevice(), displayScale: -1 }),
  'negative displayScale fails'
);
assert(
  !isDeviceInstance({ ...makeValidDevice(), isSelected: 'true' }),
  'non-boolean isSelected fails'
);
assert(
  !isDeviceInstance(null),
  'null fails'
);
assert(
  !isDeviceInstance('string'),
  'string fails'
);
assert(
  !isDeviceInstance({ id: 'x' }),
  'partial object fails'
);

// ============================================================
section('isDeviceInstanceArray');

assert(
  isDeviceInstanceArray([]),
  'empty array passes'
);
assert(
  isDeviceInstanceArray([makeValidDevice(), makeValidDevice({ id: 'dev-2' })]),
  'valid array passes'
);
assert(
  !isDeviceInstanceArray([makeValidDevice(), null]),
  'array with null fails'
);
assert(
  !isDeviceInstanceArray('not-array'),
  'string fails'
);

// ============================================================
section('isSessionState');

assert(
  isSessionState(makeValidSession()),
  'valid session passes'
);
assert(
  isSessionState(makeValidSession({ devices: [makeValidDevice()] })),
  'session with devices passes'
);
assert(
  isSessionState(makeValidSession({ selectedDeviceKey: '' })),
  'empty selectedDeviceKey allowed (means "fill")'
);
assert(
  isSessionState(makeValidSession({ selectedDeviceId: 'dev-1' })),
  'string selectedDeviceId passes'
);

assert(
  !isSessionState(makeValidSession({ sessionId: '' })),
  'empty sessionId fails'
);
assert(
  !isSessionState(makeValidSession({ bgColor: 'white' })),
  'invalid bgColor fails'
);
assert(
  !isSessionState(makeValidSession({ lastUpdated: NaN })),
  'NaN lastUpdated fails'
);
assert(
  !isSessionState(makeValidSession({ devices: [makeValidDevice(), { id: '' }] })),
  'invalid device in array fails'
);

// ============================================================
section('repairSessionState');

assert(
  repairSessionState({ sessionId: 's1' }) !== null,
  'minimal valid object gets repaired with defaults'
);
assert(
  repairSessionState({ sessionId: 's1', bgColor: 'invalid' })?.bgColor === '#FFFFFF',
  'invalid bgColor repaired to default'
);
assert(
  repairSessionState({ sessionId: 's1', devices: 'not-array' })?.devices.length === 0,
  'invalid devices repaired to empty array'
);
assert(
  repairSessionState(null) === null,
  'null returns null'
);
assert(
  repairSessionState({}) === null,
  'object without sessionId returns null'
);

// ============================================================
section('validateScreenUV');

assert(
  validateScreenUV({
    bl: { x: 0, y: 1 },
    br: { x: 1, y: 1 },
    tr: { x: 1, y: 0 },
    tl: { x: 0, y: 0 },
  }),
  'valid UV passes'
);
assert(
  !validateScreenUV({
    bl: { x: 0, y: 1 },
    br: { x: 1, y: 1 },
    tr: { x: 1, y: 0 },
    // missing tl
  }),
  'missing corner fails'
);
assert(
  !validateScreenUV({
    bl: { x: '0', y: 1 },
    br: { x: 1, y: 1 },
    tr: { x: 1, y: 0 },
    tl: { x: 0, y: 0 },
  }),
  'string coord fails'
);

// ============================================================
console.log(`\n--- Test Summary ---`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  console.log(`\nFailures:`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}

console.log(`\nAll tests passed.`);
