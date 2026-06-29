/**
 * SessionStore 单元测试
 *
 * 通过构造函数注入 mock 持久层 (DI),
 * 不依赖真实 Garnet / SurrealDB。
 *
 * 运行:
 *   ./node_modules/.bin/tsx tests/sessionStore.test.ts
 */

import type { SessionState, DeviceInstance } from '../src/server/services/canvas/types';
import { SessionStore, type ISessionPersistence } from '../src/server/services/session/SessionStore';

// 内存 mock: 替代 GarnetStore
function makeGarnetMock(): ISessionPersistence & { storage: Map<string, SessionState> } {
  return {
    storage: new Map<string, SessionState>(),
    async setSessionState(state: SessionState): Promise<boolean> {
      this.storage.set(state.sessionId, { ...state });
      return true;
    },
    async getSessionState(sessionId: string): Promise<SessionState | null> {
      return this.storage.get(sessionId) || null;
    },
  };
}

function makeSurrealMock(): ISessionPersistence & { storage: Map<string, SessionState> } {
  return {
    storage: new Map<string, SessionState>(),
    async saveSessionSnapshot(state: SessionState): Promise<boolean> {
      this.storage.set(state.sessionId, { ...state });
      return true;
    },
    async loadSessionSnapshot(sessionId: string): Promise<SessionState | null> {
      return this.storage.get(sessionId) || null;
    },
  };
}

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

function makeDevice(overrides: Partial<DeviceInstance> = {}): DeviceInstance {
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

// 防止 SessionStore 的 30s flush timer 干扰测试
function makeStore(): {
  store: SessionStore;
  garnet: ReturnType<typeof makeGarnetMock>;
  surreal: ReturnType<typeof makeSurrealMock>;
} {
  const garnet = makeGarnetMock();
  const surreal = makeSurrealMock();
  const store = new SessionStore({ garnet, surreal });
  store.destroy(); // 停掉 flush timer
  return { store, garnet, surreal };
}

(async function main() {
  // ============================================================
  section('getOrCreate');

  const s1 = makeStore();
  const state1 = s1.store.getOrCreate('sess-1');
  assert(state1.sessionId === 'sess-1', 'new session has correct id');
  assert(state1.devices.length === 0, 'new session has empty devices');
  assert(state1.selectedDeviceKey === 'fill', 'new session default selectedDeviceKey is fill');
  assert(state1.bgColor === '#FFFFFF', 'new session default bgColor is white');

  const state1Again = s1.store.getOrCreate('sess-1');
  assert(state1 === state1Again, 'getOrCreate returns same instance');

  // ============================================================
  section('switchTo');

  const s2 = makeStore();
  s2.store.switchTo('sess-2');
  assert(s2.store.getCurrentSessionId() === 'sess-2', 'switchTo updates current session id');
  assert(s2.store.getCurrent()?.sessionId === 'sess-2', 'getCurrent returns the active session');

  // ============================================================
  section('addDevice / removeDevice');

  const s3 = makeStore();
  const dev1 = makeDevice({ id: 'd1' });
  const dev2 = makeDevice({ id: 'd2' });
  s3.store.addDevice('sess-3', dev1);
  s3.store.addDevice('sess-3', dev2);
  assert(s3.store.getOrCreate('sess-3').devices.length === 2, 'addDevice appends');

  s3.store.removeDevice('sess-3', 'd1');
  const after3 = s3.store.getOrCreate('sess-3');
  assert(after3.devices.length === 1, 'removeDevice shrinks list');
  assert(after3.devices[0]?.id === 'd2', 'removeDevice keeps the right one');

  // 删掉选中的, selectedDeviceId 应清空
  s3.store.setSelectedDevice('sess-3', 'd2');
  s3.store.removeDevice('sess-3', 'd2');
  assert(s3.store.getOrCreate('sess-3').selectedDeviceId === null, 'removing selected clears selectedDeviceId');

  // ============================================================
  section('updateDeviceTransform');

  const s4 = makeStore();
  s4.store.addDevice('sess-4', makeDevice({ id: 'd1', xRatio: 0.5, yRatio: 0.5 }));
  s4.store.updateDeviceTransform('sess-4', 'd1', { xRatio: 0.7, rotationY: 1.5 });
  const d1 = s4.store.getOrCreate('sess-4').devices[0];
  assert(d1?.xRatio === 0.7, 'transform updates xRatio');
  assert(d1?.rotationY === 1.5, 'transform updates rotationY');
  assert(d1?.yRatio === 0.5, 'untransformed field preserved');

  // 不存在的 deviceId 不应抛错
  s4.store.updateDeviceTransform('sess-4', 'nonexistent', { xRatio: 0.1 });
  assert(s4.store.getOrCreate('sess-4').devices.length === 1, 'unknown device id is a no-op');

  // ============================================================
  section('setSelectedDevice');

  const s5 = makeStore();
  s5.store.addDevice('sess-5', makeDevice({ id: 'd1', isSelected: false }));
  s5.store.addDevice('sess-5', makeDevice({ id: 'd2', isSelected: false }));
  s5.store.setSelectedDevice('sess-5', 'd2');

  const s5State = s5.store.getOrCreate('sess-5');
  assert(s5State.selectedDeviceId === 'd2', 'selectedDeviceId updated');
  assert(s5State.devices.find((d) => d.id === 'd1')?.isSelected === false, 'other device not selected');
  assert(s5State.devices.find((d) => d.id === 'd2')?.isSelected === true, 'target device selected');

  s5.store.setSelectedDevice('sess-5', null);
  assert(s5.store.getOrCreate('sess-5').devices.every((d) => !d.isSelected), 'deselect clears all isSelected');

  // ============================================================
  section('restoreFromSurreal');

  const s6 = makeStore();
  s6.surreal.storage.set('sess-restore', {
    sessionId: 'sess-restore',
    selectedDeviceKey: 'iphone_14_pro',
    devices: [makeDevice({ id: 'd1' })],
    bgColor: '#000000',
    selectedDeviceId: 'd1',
    lastUpdated: 999,
  });

  const restored = await s6.store.restoreFromSurreal('sess-restore');
  assert(restored !== null, 'restore returns state');
  assert(restored?.bgColor === '#000000', 'restored bgColor matches');
  assert(restored?.devices.length === 1, 'restored devices present');

  const fromMem = s6.store.getOrCreate('sess-restore');
  assert(fromMem === restored, 'getOrCreate returns restored instance');

  // 错误时不抛
  const fromMissing = await s6.store.restoreFromSurreal('sess-missing');
  assert(fromMissing === null, 'missing session returns null');

  // ============================================================
  section('selectDevice (canvas mode switch)');

  const s7 = makeStore();
  s7.store.selectDevice('sess-7', 'ipad_pro');
  assert(s7.store.getOrCreate('sess-7').selectedDeviceKey === 'ipad_pro', 'selectDevice updates key');

  // ── 新行为: 选具体设备时自动在画布上创建一个 device ──
  const s7b = makeStore();
  s7b.store.selectDevice('sess-7b', 'm-iphone14pro');
  const s7bState = s7b.store.getOrCreate('sess-7b');
  assert(s7bState.devices.length === 1, 'selectDevice auto-creates one device');
  assert(s7bState.devices[0]?.modelKey === 'm-iphone14pro', 'created device has correct modelKey');
  assert(s7bState.devices[0]?.xRatio === 0.5 && s7bState.devices[0]?.yRatio === 0.5, 'new device is centered');
  assert(s7bState.selectedDeviceId === s7bState.devices[0]?.id, 'new device is auto-selected');
  assert(s7bState.devices[0]?.isSelected === true, 'new device isSelected=true');

  // 选相同 modelKey 第二次: 复用现有 device, 不重复创建
  s7b.store.selectDevice('sess-7b', 'm-iphone14pro');
  assert(s7b.store.getOrCreate('sess-7b').devices.length === 1, 'duplicate modelKey reuses existing device');

  // 选不同 modelKey: 多一个 device
  s7b.store.selectDevice('sess-7b', 'm-iphonese');
  assert(s7b.store.getOrCreate('sess-7b').devices.length === 2, 'different modelKey adds another device');

  // 切回 fill: 不动 devices (用户可能想保留工作)
  s7b.store.selectDevice('sess-7b', 'fill');
  assert(s7b.store.getOrCreate('sess-7b').devices.length === 2, 'fill mode keeps existing devices');
  assert(s7b.store.getOrCreate('sess-7b').selectedDeviceKey === 'fill', 'fill updates selectedDeviceKey');

  // ============================================================
  section('flushNow');

  const s8 = makeStore();
  s8.store.addDevice('sess-flush', makeDevice({ id: 'd1' }));
  s8.store.setSelectedDevice('sess-flush', 'd1');

  await s8.store.flushNow('sess-flush');
  assert(s8.garnet.storage.has('sess-flush'), 'flushed to garnet mock');

  // ============================================================
  section('flushAll (退出前用)');

  const s9 = makeStore();
  s9.store.addDevice('sess-A', makeDevice({ id: 'dA' }));
  s9.store.addDevice('sess-B', makeDevice({ id: 'dB' }));
  s9.store.setSelectedDevice('sess-A', 'dA');
  s9.store.setSelectedDevice('sess-B', 'dB');

  await s9.store.flushAll();
  assert(s9.garnet.storage.has('sess-A'), 'flushAll writes sess-A to garnet');
  assert(s9.garnet.storage.has('sess-B'), 'flushAll writes sess-B to garnet');
  assert(s9.surreal.storage.has('sess-A'), 'flushAll writes sess-A to surreal');
  assert(s9.surreal.storage.has('sess-B'), 'flushAll writes sess-B to surreal');

  // flushAll 后 dirty 应清空
  s9.store.addDevice('sess-C', makeDevice({ id: 'dC' }));
  // 立即再 flushAll, sess-A/B 应该不重新写
  const sizeBefore = s9.garnet.storage.size;
  await s9.store.flushAll();
  // garnet storage 大小至少增加 1 (sess-C), 但 A/B 不应重复触发副作用
  assert(s9.garnet.storage.has('sess-C'), 'flushAll includes newly added session');

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
  process.exit(0);
})().catch((e: Error) => {
  console.error('Test runner error:', e);
  process.exit(1);
});
