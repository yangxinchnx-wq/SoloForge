/**
 * 多会话状态管理
 * - 内存中维护当前所有活跃会话
 * - 切换会话 = 切换渲染目标, 不销毁任何东西
 * - 50~200ms 切换速度
 */

import type { DeviceInstance, SessionState } from '../canvas/types';
import { getGarnetStore } from '../persistence/GarnetStore';
import { getSurrealStore } from '../persistence/SurrealStore';

/**
 * 持久层抽象接口 (GarnetStore / SurrealStore 都实现这个)
 *
 * 用接口代替直接 import, 便于测试时注入 mock。
 *
 * 此文件位于 src/server/ 下,只能在 Node 进程(Express server.ts / 后端 ApiServer)加载。
 * 前端组件绝对不能 import 此文件 — 依赖 ioredis / @surrealdb/node 等 Node-only 库。
 */
export interface ISessionPersistence {
  setSessionState(state: SessionState): Promise<boolean> | Promise<void>;
  getSessionState(sessionId: string): Promise<SessionState | null>;
  loadSessionSnapshot?(sessionId: string): Promise<SessionState | null>;
  saveSessionSnapshot?(state: SessionState): Promise<boolean> | Promise<void>;
}

export class SessionStore {
  private states: Map<string, SessionState> = new Map();
  private currentSessionId: string | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private dirty: Set<string> = new Set();
  private garnet: ISessionPersistence;
  private surreal: ISessionPersistence;

  // s2.4: 持久化统计 — 诊断 F5 是否丢数据
  private _persistenceStats = {
    totalFlushes: 0,        // _flushDirty 调用次数
    garnetWrites: 0,        // 成功写到 Garnet 的次数
    surrealWrites: 0,       // 成功写到 SurrealDB 的次数
    lastFlushAt: 0,         // 上次 flush 完成的 timestamp
    lastFlushDurationMs: 0, // 上次 flush 耗时
    skippedFlushes: 0,      // 没有 dirty 跳过
  };

  constructor(persistence?: { garnet?: ISessionPersistence; surreal?: ISessionPersistence }) {
    this.garnet = persistence?.garnet ?? getGarnetStore();
    this.surreal = persistence?.surreal ?? getSurrealStore();
    this._startFlushTimer();
  }

  /**
   * 获取或创建会话
   */
  getOrCreate(sessionId: string): SessionState {
    if (this.states.has(sessionId)) {
      return this.states.get(sessionId)!;
    }

    const state: SessionState = {
      sessionId,
      selectedDeviceKey: 'fill',
      devices: [],
      bgColor: '#FFFFFF',
      selectedDeviceId: null,
      // s2.2: 多选设备 ID 列表 (空 = 无选中)
      selectedDeviceIds: [],
      lastUpdated: Date.now(),
    };
    this.states.set(sessionId, state);
    this.dirty.add(sessionId);
    return state;
  }

  /**
   * 切换当前会话
   */
  switchTo(sessionId: string): SessionState {
    this.currentSessionId = sessionId;
    const state = this.getOrCreate(sessionId);
    // 标记为脏, 下次 flush 写入
    this.dirty.add(sessionId);
    return state;
  }

  /**
   * 获取当前会话
   */
  getCurrent(): SessionState | null {
    if (!this.currentSessionId) return null;
    return this.states.get(this.currentSessionId) || null;
  }

  /**
   * 获取当前 session ID
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * 选中一个设备 (切换画布模式)
   *
   * 关键: 切到非 fill 时,自动在画布中央放一个 DeviceInstance。
   * 之前只更新 selectedDeviceKey 但 devices 一直是空,导致 React 端
   * fetchSession 拿到空 devices,Model3DOverlay 啥也不渲染。
   *
   * 现在: 切到具体设备 (iPhone / iPad / MacBook) 立即有一个 device 出现,
   * 用户可以用滚轮拖、右键旋转、Delete 删除。
   * 切回 fill 不删 device (保留用户工作)。
   */
  selectDevice(sessionId: string, modelKey: string): void {
    const state = this.getOrCreate(sessionId);
    state.selectedDeviceKey = modelKey;
    state.lastUpdated = Date.now();
    this.dirty.add(sessionId);

    // fill 是 2D 模式标记, 不创建 device
    if (modelKey === 'fill') return;

    // 找同 modelKey 的 device, 没有就新建一个
    const existing = state.devices.find((d) => d.modelKey === modelKey);
    if (existing) {
      // 已有: 选中它
      this.setSelectedDevice(sessionId, existing.id);
    } else {
      // 新建 device: 默认居中, 用 modelKey 派生一个稳定 id
      const newDevice: DeviceInstance = {
        id: `dev-${modelKey}-${Date.now().toString(36)}`,
        modelKey,
        xRatio: 0.5,
        yRatio: 0.5,
        rotationX: 0,
        rotationY: 0,
        rotationZ: 0,
        displayScale: 1,
        isSelected: true,
        highlightColor: '#FF6B6B',
        // s2.x 扩展: 设备独立 UI session (null = 共享 sessionId)
        uiSessionId: null,
      };
      this.addDevice(sessionId, newDevice);
      this.setSelectedDevice(sessionId, newDevice.id);
    }
  }

  /**
   * 添加 3D 设备到画布
   */
  addDevice(sessionId: string, device: DeviceInstance): void {
    const state = this.getOrCreate(sessionId);
    state.devices.push(device);
    state.lastUpdated = Date.now();
    this.dirty.add(sessionId);
  }

  /**
   * 移除 3D 设备
   */
  removeDevice(sessionId: string, deviceId: string): void {
    const state = this.getOrCreate(sessionId);
    state.devices = state.devices.filter((d) => d.id !== deviceId);
    if (state.selectedDeviceId === deviceId) {
      state.selectedDeviceId = null;
    }
    state.lastUpdated = Date.now();
    this.dirty.add(sessionId);
  }

  /**
   * 更新设备 transform
   */
  updateDeviceTransform(
    sessionId: string,
    deviceId: string,
    transform: Partial<DeviceInstance>
  ): void {
    const state = this.getOrCreate(sessionId);
    const idx = state.devices.findIndex((d) => d.id === deviceId);
    if (idx === -1) return;
    state.devices[idx] = { ...state.devices[idx], ...transform };
    state.lastUpdated = Date.now();
    this.dirty.add(sessionId);
  }

  /**
   * s3.2c: 设置设备的独立 UI session
   *
   * @param uiSessionId  - null = 回退到共享 UI (跟随 _uiNode)
   *                     - 有值 = 该设备使用独立 UI session
   *
   * 多 session 设备 UI 场景:
   *   - 设备 A 显示登录页 (uiSessionId = "login")
   *   - 设备 B 显示仪表盘 (uiSessionId = "dashboard")
   *   - 设备 C 无 uiSessionId → 显示共享 UI
   */
  setDeviceUiSession(
    sessionId: string,
    deviceId: string,
    uiSessionId: string | null,
  ): boolean {
    const state = this.getOrCreate(sessionId);
    const idx = state.devices.findIndex((d) => d.id === deviceId);
    if (idx === -1) return false;
    state.devices[idx] = { ...state.devices[idx], uiSessionId };
    state.lastUpdated = Date.now();
    this.dirty.add(sessionId);
    return true;
  }

  /**
   * 设置选中设备
   */
  setSelectedDevice(sessionId: string, deviceId: string | null): void {
    const state = this.getOrCreate(sessionId);
    state.selectedDeviceId = deviceId;
    state.selectedDeviceIds = deviceId ? [deviceId] : [];
    // 同步所有设备的 isSelected
    state.devices.forEach((d) => {
      d.isSelected = deviceId !== null && d.id === deviceId;
    });
    state.lastUpdated = Date.now();
    this.dirty.add(sessionId);
  }

  /**
   * s2.2: 设置多选设备
   *
   * @param deviceIds  选中的设备 ID 列表
   *   - 空数组 = 取消所有选中
   *   - 单元素 = 等同 setSelectedDevice
   *   - 多元素 = 群组选, 第一个元素是"主选"
   * @param primaryId  主选 ID (默认 deviceIds[0])
   *
   * 自动过滤掉不存在的 deviceId, 并把 selectedDeviceId 同步到主选
   */
  setSelectedDevices(
    sessionId: string,
    deviceIds: string[],
    primaryId?: string,
  ): void {
    const state = this.getOrCreate(sessionId);
    // 去重 + 过滤野指针
    const valid = [...new Set(deviceIds)].filter((id) =>
      state.devices.some((d) => d.id === id),
    );
    state.selectedDeviceIds = valid;
    const primary = primaryId && valid.includes(primaryId)
      ? primaryId
      : (valid[0] ?? null);
    state.selectedDeviceId = primary;
    // 同步 isSelected
    const primarySet = new Set(valid);
    state.devices.forEach((d) => {
      d.isSelected = primarySet.has(d.id);
    });
    state.lastUpdated = Date.now();
    this.dirty.add(sessionId);
  }

  /**
   * s2.2: 群组变换
   *
   * @param delta  增量 transform
   *   { dXRatio, dYRatio, dRotationX, dRotationY, dRotationZ, scaleDelta }
   *   dX/dY/dR 是绝对增量, scaleDelta 是相对比例 (1.0 = 不变, 1.1 = 放大 10%)
   *
   * 只作用于当前选中的设备 (selectedDeviceIds), 如果空就什么也不做
   * 不选中的设备保持原位 — 跟"group transform"概念一致
   */
  transformGroup(
    sessionId: string,
    delta: {
      dXRatio?: number;
      dYRatio?: number;
      dRotationX?: number;
      dRotationY?: number;
      dRotationZ?: number;
      scaleDelta?: number;
    },
  ): void {
    const state = this.getOrCreate(sessionId);
    if (state.selectedDeviceIds.length === 0) return;
    const idSet = new Set(state.selectedDeviceIds);
    const dx = delta.dXRatio ?? 0;
    const dy = delta.dYRatio ?? 0;
    const drx = delta.dRotationX ?? 0;
    const dry = delta.dRotationY ?? 0;
    const drz = delta.dRotationZ ?? 0;
    const sd = delta.scaleDelta ?? 1;
    state.devices = state.devices.map((d) => {
      if (!idSet.has(d.id)) return d;
      return {
        ...d,
        xRatio: d.xRatio + dx,
        yRatio: d.yRatio + dy,
        rotationX: d.rotationX + drx,
        rotationY: d.rotationY + dry,
        rotationZ: d.rotationZ + drz,
        // 缩放: 相对当前值乘, 但有上下限避免失控
        displayScale: (d.displayScale * sd).clamp(0.1, 5.0),
      };
    });
    state.lastUpdated = Date.now();
    this.dirty.add(sessionId);
  }

  /**
   * 恢复会话 (启动时从 SurrealDB)
   */
  async restoreFromSurreal(sessionId: string): Promise<SessionState | null> {
    try {
      if (!this.surreal.loadSessionSnapshot) return null;
      const state = await this.surreal.loadSessionSnapshot(sessionId);
      if (state) {
        this.states.set(sessionId, state);
        return state;
      }
    } catch (e) {
      console.warn('[SessionStore] restore failed:', (e as Error).message);
    }
    return null;
  }

  /**
   * 启动定时 flush (热→温)
   *
   * s2.4: 从 3 秒改成 1 秒 — F5 最多丢 1 秒数据 (原 3 秒)
   * 关掉 SoloForge 前应调 flushAll() 强制刷一次。
   */
  private _startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this._flushDirty().catch((e) => {
        console.warn('[SessionStore] flush error:', e);
      });
    }, 1000); // s2.4: 1 秒 (原 3 秒)
  }

  /**
   * Flush dirty 会话到 Garnet + SurrealDB
   *
   * s2.4: 加重试/统计/耗时记录
   */
  private async _flushDirty(): Promise<void> {
    this._persistenceStats.totalFlushes++;
    if (this.dirty.size === 0) {
      this._persistenceStats.skippedFlushes++;
      return;
    }
    const started = Date.now();
    let garnetOk = 0;
    let surrealOk = 0;
    for (const sessionId of this.dirty) {
      const state = this.states.get(sessionId);
      if (!state) continue;
      // 热: Garnet
      try {
        await this.garnet.setSessionState(state);
        garnetOk++;
      } catch (e) {
        console.warn(`[SessionStore] garnet write failed: ${(e as Error).message}`);
      }
      // 温: SurrealDB (异步, 不阻塞, 但统计成功的)
      if (this.surreal.saveSessionSnapshot) {
        this.surreal.saveSessionSnapshot(state)
          .then((ok) => { if (ok) this._persistenceStats.surrealWrites++; })
          .catch(() => {});
      }
    }
    this._persistenceStats.garnetWrites += garnetOk;
    this._persistenceStats.lastFlushAt = Date.now();
    this._persistenceStats.lastFlushDurationMs = Date.now() - started;
    this.dirty.clear();
  }

  /**
   * 强制 flush (会话切换时调用)
   *
   * s2.4 增强: 也标脏
   *   - 旧逻辑: 显式 setSessionState, 不走 dirty (因为没修改)
   *   - 新逻辑: 也 add dirty, 让 _flushDirty 走完 surreal 异步写
   */
  async flushNow(sessionId?: string): Promise<void> {
    if (sessionId) {
      const state = this.states.get(sessionId);
      if (state) {
        try {
          await this.garnet.setSessionState(state);
        } catch (e) {
          console.warn(`[SessionStore] flushNow garnet failed: ${(e as Error).message}`);
        }
        // 同时把 sessionId 加入 dirty, 触发 _flushDirty 写 surreal
        this.dirty.add(sessionId);
      }
    } else {
      await this._flushDirty();
    }
  }

  /**
   * s2.4: 强制 flush + 阻塞等 surreal
   *
   * 用途:
   *   - 应用退出前 (before-quit)
   *   - 用户按 Ctrl+S 主动保存
   *   - F5 前的 pagehide / beforeunload 钩子
   *
   * 区别于 flushNow:
   *   - flushNow 是 fire-and-forget, 走 dirty 异步写
   *   - forceFlush 阻塞等两层都写完
   */
  async forceFlush(sessionId?: string): Promise<{ garnetOk: boolean; surrealOk: boolean }> {
    if (sessionId) {
      this.dirty.add(sessionId);
    }
    const started = Date.now();
    let garnetOk = false;
    let surrealOk = false;
    for (const sid of this.dirty) {
      const state = this.states.get(sid);
      if (!state) continue;
      try {
        await this.garnet.setSessionState(state);
        garnetOk = true;
      } catch {}
      if (this.surreal.saveSessionSnapshot) {
        try {
          const ok = await this.surreal.saveSessionSnapshot(state);
          if (ok) surrealOk = true;
        } catch {}
      }
    }
    this._persistenceStats.lastFlushAt = Date.now();
    this._persistenceStats.lastFlushDurationMs = Date.now() - started;
    this.dirty.clear();
    return { garnetOk, surrealOk };
  }

  /**
   * s2.4: 冷启动恢复 — 从 SurrealDB 拉所有已知 session
   *
   * SurrealStore 提供 listAllSessionIds?() 方法 (在 SurrealStore 里实现)
   * 没实现时返回空数组, 优雅降级
   */
  async restoreAllFromSurreal(): Promise<{ restored: number; total: number }> {
    const surrealAny = this.surreal as ISessionPersistence & {
      listAllSessionIds?: () => Promise<string[]>;
    };
    if (typeof surrealAny.listAllSessionIds !== 'function') {
      return { restored: 0, total: 0 };
    }
    let ids: string[] = [];
    try {
      ids = await surrealAny.listAllSessionIds();
    } catch (e) {
      console.warn('[SessionStore] restoreAllFromSurreal list failed:', (e as Error).message);
      return { restored: 0, total: 0 };
    }
    let restored = 0;
    for (const sid of ids) {
      if (this.states.has(sid)) continue; // 内存已有, 跳过
      const st = await this.restoreFromSurreal(sid);
      if (st) restored++;
    }
    return { restored, total: ids.length };
  }

  /**
   * s2.4: 持久化统计 (诊断端点用)
   */
  getPersistenceStats(): {
    totalFlushes: number;
    garnetWrites: number;
    surrealWrites: number;
    lastFlushAt: number;
    lastFlushDurationMs: number;
    skippedFlushes: number;
    dirtyCount: number;
    inMemoryCount: number;
    flushIntervalMs: number;
  } {
    return {
      ...this._persistenceStats,
      dirtyCount: this.dirty.size,
      inMemoryCount: this.states.size,
      flushIntervalMs: 1000,
    };
  }

  /**
   * 强制 flush 所有会话 (热 + 温)
   *
   * 用途:
   * - 应用退出前 (before-quit)
   * - 用户主动保存
   * - 错误恢复 (最后一道防线)
   *
   * 与 flushNow 区别: 这里会写两层 (garnet + surreal), 阻塞等返回
   */
  async flushAll(): Promise<void> {
    const sessions = Array.from(this.states.values());

    // 1. 先把所有 dirty 标脏的写一次 (确保 _flushDirty 走一遍)
    await this._flushDirty();

    // 2. 强制写所有 session (即使不脏, 也保证最新状态落到温存储)
    await Promise.all(
      sessions.map(async (state) => {
        try {
          await this.garnet.setSessionState(state);
          if (this.surreal.saveSessionSnapshot) {
            await this.surreal.saveSessionSnapshot(state);
          }
        } catch (e) {
          console.warn('[SessionStore] flushAll error:', (e as Error).message);
        }
      })
    );

    this.dirty.clear();
  }

  /**
   * 停止 flush timer
   */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ─────────────────────────────────────────
  // s1.4: 会话改名 / 删除 / 列表
  // ─────────────────────────────────────────

  /**
   * s1.4: 改会话名 + 备注
   * - name: 1-50 字符, 不能为空 (空字符串视为不改名)
   * - description: 0-200 字符
   * 返回修改后的 SessionState
   */
  renameSession(sessionId: string, name?: string, description?: string): SessionState | null {
    const state = this.states.get(sessionId);
    if (!state) return null;

    if (name !== undefined) {
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        // 空字符串 = 清掉名字
        delete state.name;
      } else if (trimmed.length > 50) {
        throw new Error(`session name too long (max 50 chars, got ${trimmed.length})`);
      } else {
        state.name = trimmed;
      }
    }

    if (description !== undefined) {
      if (description.length > 200) {
        throw new Error(`session description too long (max 200 chars, got ${description.length})`);
      }
      state.description = description;
    }

    if (state.createdAt === undefined) {
      state.createdAt = Date.now();
    }

    state.lastUpdated = Date.now();
    this.dirty.add(sessionId);
    return state;
  }

  /**
   * s1.4: 删除会话
   * - 从内存 + dirty 移除
   * - 异步尝试删除持久层 (Garnet + Surreal)
   * - 如果是当前活跃 session, currentSessionId 设为 null
   * 返回是否成功删除
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    if (!this.states.has(sessionId)) return false;

    this.states.delete(sessionId);
    this.dirty.delete(sessionId);
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }

    // 持久层清理 — 尽力而为, 失败不阻塞
    try {
      const { getGarnetStore } = await import('../persistence/GarnetStore');
      const garnet = getGarnetStore();
      if (garnet && typeof (garnet as any).deleteSession === 'function') {
        await (garnet as any).deleteSession(sessionId).catch(() => {});
      }
    } catch (_) {}

    try {
      const { getSurrealStore } = await import('../persistence/SurrealStore');
      const surreal = getSurrealStore();
      if (surreal && typeof (surreal as any).deleteSession === 'function') {
        await (surreal as any).deleteSession(sessionId).catch(() => {});
      }
    } catch (_) {}

    return true;
  }

  /**
   * s1.4: 列出所有会话 (轻量摘要, 不含 devices 完整数据)
   */
  listSessions(): Array<{
    sessionId: string;
    name?: string;
    description?: string;
    createdAt?: number;
    lastUpdated: number;
    deviceCount: number;
    bgColor: string;
    isCurrent: boolean;
  }> {
    const out: Array<{
      sessionId: string;
      name?: string;
      description?: string;
      createdAt?: number;
      lastUpdated: number;
      deviceCount: number;
      bgColor: string;
      isCurrent: boolean;
    }> = [];
    for (const [sessionId, state] of this.states.entries()) {
      out.push({
        sessionId,
        name: state.name,
        description: state.description,
        createdAt: state.createdAt,
        lastUpdated: state.lastUpdated,
        deviceCount: state.devices.length,
        bgColor: state.bgColor,
        isCurrent: sessionId === this.currentSessionId,
      });
    }
    // 按 lastUpdated 倒序
    out.sort((a, b) => b.lastUpdated - a.lastUpdated);
    return out;
  }
}

let _instance: SessionStore | null = null;
export function getSessionStore(): SessionStore {
  if (!_instance) {
    _instance = new SessionStore();
  }
  return _instance;
}
