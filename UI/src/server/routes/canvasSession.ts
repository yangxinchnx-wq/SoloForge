/**
 * Canvas Session API 路由处理器(Node-only)
 *
 * 路由:
 *   GET    /api/canvas/sessions/:id                                  → 读 SessionState
 *   POST   /api/canvas/sessions/:id/devices                          → 新增 DeviceInstance
 *   DELETE /api/canvas/sessions/:id/devices/:deviceId                → 删除
 *   PUT    /api/canvas/sessions/:id/devices/:deviceId/transform      → 更新 transform
 *   PUT    /api/canvas/sessions/:id/devices/selected                 → 选中 id
 *   PUT    /api/canvas/sessions/:id/select-model                     → 切换 modelKey
 *   POST   /api/canvas/sessions/:id/flush                            → 强制 flush
 *
 * 错误格式: { success: false, error: string }
 * 成功格式: { success: true, payload: <data> } 或 { success: true }
 */

import { getGarnetStore } from '../services/persistence/GarnetStore';
import type { Request, Response } from 'express';
import type { DeviceInstance, SessionState } from '../services/canvas/types';
import { displayCanvasName, parseCanvasName } from '../services/canvas/types';
import { getSessionStore } from '../services/session/SessionStore';
import { clearAllCanvases } from '../services/session/SessionStore';
import { getNotificationBus } from '../services/canvas/NotificationBus';

function err(res: Response, status: number, message: string): Response {
  return res.status(status).json({ success: false, error: message });
}

function ok(res: Response, payload?: unknown): Response {
  return res.json(payload === undefined ? { success: true } : { success: true, payload });
}

/**
 * P0: 从请求头解析 requesterChatSessionId
 * 必填 — 缺失返回 undefined (调用方应返回 401)
 */
function getRequesterChatSessionId(req: Request): string | undefined {
  const h = req.headers['x-requester-chat-session-id'];
  if (typeof h === 'string' && h.trim().length > 0) return h.trim();
  // 也允许 body 里带 (兼容大模型 tool 调用)
  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (body && typeof (body as { requesterChatSessionId?: unknown }).requesterChatSessionId === 'string') {
    const v = (body as { requesterChatSessionId: string }).requesterChatSessionId.trim();
    if (v.length > 0) return v;
  }
  return undefined;
}

/**
 * P0: ACL 检查 - 读取 (所有 public 画布对任何 chat 可见)
 */
function ensureRead(req: Request, res: Response, canvas: SessionState): boolean {
  const requester = getRequesterChatSessionId(req);
  if (!requester) {
    err(res, 401, 'X-Requester-Chat-Session-Id header required');
    return false;
  }
  if (!getSessionStore().canRead(canvas, requester)) {
    err(res, 403, 'forbidden: no read access to this canvas');
    return false;
  }
  return true;
}

/**
 * P0: ACL 检查 - 设备层写入 (任何 chat 可写设备, 协作画布语义)
 * 触发通知: 非 owner 写时给 owner 发 notification
 */
function ensureWriteDevice(req: Request, res: Response, canvas: SessionState, action: 'write_device' | 'remove_device'): boolean {
  const requester = getRequesterChatSessionId(req);
  if (!requester) {
    err(res, 401, 'X-Requester-Chat-Session-Id header required');
    return false;
  }
  if (!getSessionStore().canWriteDevice(canvas, requester)) {
    err(res, 403, 'forbidden: no device write access to this canvas');
    return false;
  }
  return true;
}

/**
 * P0: ACL 检查 - 资源管理 (改名/删除, 仅 owner)
 */
function ensureManage(req: Request, res: Response, canvas: SessionState): boolean {
  const requester = getRequesterChatSessionId(req);
  if (!requester) {
    err(res, 401, 'X-Requester-Chat-Session-Id header required');
    return false;
  }
  if (!getSessionStore().canManage(canvas, requester)) {
    err(res, 403, 'forbidden: only owner can rename/delete this canvas');
    return false;
  }
  return true;
}

/**
 * 向后兼容: ensureWrite 保留, 等价于 ensureManage
 */
function ensureWrite(req: Request, res: Response, canvas: SessionState): boolean {
  return ensureManage(req, res, canvas);
}

/**
 * P0: 触发画布通知 (非 owner 写/删/改名时通知 owner)
 * 60s cooldown 在 NotificationBus 内
 */
function emitCanvasChange(
  canvas: SessionState,
  actorChatSessionId: string,
  action: 'write_device' | 'remove_device' | 'rename' | 'delete',
): void {
  getNotificationBus().emit({
    actorChatSessionId,
    ownerChatSessionId: canvas.ownerChatSessionId,
    canvasId: canvas.sessionId,
    canvasDisplayName: displayCanvasName(canvas.name),
    action,
  });
}

/**
 * GET /api/canvas/sessions/:id
 * 读取画布 (走恢复路径 — 内存没有时从 Surreal 拉取)
 * 校验 read 权限 + 记录 access 时间
 */
export async function handleGetSession(req: Request, res: Response): Promise<Response> {
  const id = String(req.params.id || '');
  if (!id) return err(res, 400, 'session id required');
  const store = getSessionStore();
  const state = await findCanvasWithRecovery(id);
  if (!state) return err(res, 404, 'canvas not found');
  if (!ensureRead(req, res, state)) return res;  // already written
  // 记录访问 (用于自动切回)
  const requester = getRequesterChatSessionId(req);
  if (requester) store.recordAccess(id, requester);
  return ok(res, state);
}

/**
 * POST /api/canvas/sessions
 * P0: 显式创建画布 (走最小可用序号策略)
 * header X-Requester-Chat-Session-Id: chat-X (必填, 即 owner)
 * body: { description?: string }  (name 由系统分配)
 */
export function handleCreateCanvas(req: Request, res: Response): Response {
  const requester = getRequesterChatSessionId(req);
  if (!requester) return err(res, 401, 'X-Requester-Chat-Session-Id header required');
  const body = (req.body && typeof req.body === 'object') ? req.body as { description?: unknown } : {};
  const description = typeof body.description === 'string' ? body.description : undefined;
  const state = getSessionStore().createCanvas();
  if (!state) return err(res, 409, 'canvas limit reached (max 10, please delete some before creating)');
  if (description !== undefined) {
    state.description = description;
  }
  // ★ FIX 2026-07-14: 创建后立即认领归属权给创建者
  // 原逻辑: 只 recordAccess 不 claimCanvas → 画布保持无归属 (isUnowned=true)
  //         → 其他 chat 打开时看到无归属画布就复用 → 数据串台 (画布混用)
  // 修复: 创建即认领, 确保每个 chat 创建的画布立即归属该 chat, 其他 chat 不会复用
  getSessionStore().claimCanvas(state.sessionId, requester);
  // 记录访问 (用于 lastAccessedCanvasId 自动切回)
  getSessionStore().recordAccess(state.sessionId, requester);
  return ok(res, state);
}

/**
 * GET /api/canvas/resources?requesterChatSessionId=X
 * P0: 资源池端点 — 列出 requester 可访问的所有画布 (按序号升序)
 * 默认 public 全部可见, 附上 owner 信息便于 UI 展示
 */
export function handleListResources(req: Request, res: Response): Response {
  const requester = getRequesterChatSessionId(req) ?? (
    typeof req.query.requesterChatSessionId === 'string'
      ? req.query.requesterChatSessionId
      : undefined
  );
  if (!requester) return err(res, 401, 'X-Requester-Chat-Session-Id header (or ?requesterChatSessionId=) required');
  const store = getSessionStore();
  const all = store.listCanvases();
  const accessible = all
    .filter(c => store.canRead(c, requester))
    .map(c => ({
      sessionId: c.sessionId,
      name: c.name,
      displayName: parseCanvasName(c.name) > 0 ? String(parseCanvasName(c.name)) : c.name,
      description: c.description,
      ownerChatSessionId: c.ownerChatSessionId,
      isOwner: c.ownerChatSessionId === requester,
      isUnowned: c.ownerChatSessionId === null,
      deviceCount: c.devices.length,
      lastUpdated: c.lastUpdated,
      lastAccessedAt: c.lastAccessedBy?.[requester] ?? null,
    }));
  return ok(res, {
    canvases: accessible,
    total: accessible.length,
    lastAccessedCanvasId: store.getLastAccessedCanvas(requester)?.sessionId ?? null,
    maxCanvases: 10,
  });
}

/**
 * PUT /api/canvas/sessions/:id/select-model
 * body: { modelKey: string }
 * 写操作 - 仅 owner
 */
export function handleSelectModel(req: Request, res: Response): Response {
  const id = String(req.params.id || '');
  const { modelKey } = req.body || {};
  if (!id) return err(res, 400, 'session id required');
  if (typeof modelKey !== 'string') return err(res, 400, 'modelKey (string) required');
  const store = getSessionStore();
  const state = store.listCanvases().find(c => c.sessionId === id);
  if (!state) return err(res, 404, 'canvas not found (use POST /api/canvas/sessions to create)');
  if (!ensureWriteDevice(req, res, state, 'write_device')) return res;
  const requester = getRequesterChatSessionId(req);
  // ★ 无归属画布: 第一个写入者获得归属权
  if (requester) store.claimCanvas(id, requester);
  store.selectDevice(id, modelKey);
  if (requester) emitCanvasChange(state, requester, 'write_device');
  return ok(res);
}

/**
 * PUT /api/canvas/sessions/:id/devices/selected
 * body: { deviceId: string | null }
 * 写操作 - 仅 owner
 */
export function handleSetSelectedDevice(req: Request, res: Response): Response {
  const id = String(req.params.id || '');
  const { deviceId } = req.body || {};
  if (!id) return err(res, 400, 'session id required');
  if (deviceId !== null && typeof deviceId !== 'string') {
    return err(res, 400, 'deviceId (string | null) required');
  }
  const store = getSessionStore();
  const state = store.listCanvases().find(c => c.sessionId === id);
  if (!state) return err(res, 404, 'canvas not found');
  if (!ensureWriteDevice(req, res, state, 'write_device')) return res;
  const requester = getRequesterChatSessionId(req);
  // ★ 无归属画布: 第一个写入者获得归属权
  if (requester) store.claimCanvas(id, requester);
  store.setSelectedDevice(id, deviceId);
  if (requester) emitCanvasChange(state, requester, 'write_device');
  return ok(res);
}

/**
 * POST /api/canvas/sessions/:id/devices
 * body: DeviceInstance
 * 写操作 - 仅 owner
 */
export function handleAddDevice(req: Request, res: Response): Response {
  const id = String(req.params.id || '');
  const device = req.body as DeviceInstance;
  if (!id) return err(res, 400, 'session id required');
  if (!device || typeof device.id !== 'string' || typeof device.modelKey !== 'string') {
    return err(res, 400, 'invalid DeviceInstance body');
  }
  const store = getSessionStore();
  const state = store.listCanvases().find(c => c.sessionId === id);
  if (!state) return err(res, 404, 'canvas not found');
  if (!ensureWriteDevice(req, res, state, 'write_device')) return res;
  const requester = getRequesterChatSessionId(req);
  // ★ 无归属画布: 第一个写入者获得归属权
  if (requester) store.claimCanvas(id, requester);
  store.addDevice(id, device);
  if (requester) emitCanvasChange(state, requester, 'write_device');
  return ok(res);
}

/**
 * DELETE /api/canvas/sessions/:id/devices/:deviceId
 * 写操作 - 仅 owner
 */
export function handleRemoveDevice(req: Request, res: Response): Response {
  const id = String(req.params.id || '');
  const deviceId = String(req.params.deviceId || '');
  if (!id || !deviceId) return err(res, 400, 'session id and deviceId required');
  const store = getSessionStore();
  const state = store.listCanvases().find(c => c.sessionId === id);
  if (!state) return err(res, 404, 'canvas not found');
  if (!ensureWriteDevice(req, res, state, 'remove_device')) return res;
  const requester = getRequesterChatSessionId(req);
  // ★ 无归属画布: 第一个写入者获得归属权
  if (requester) store.claimCanvas(id, requester);
  store.removeDevice(id, deviceId);
  if (requester) emitCanvasChange(state, requester, 'remove_device');
  return ok(res);
}

/**
 * PUT /api/canvas/sessions/:id/devices/:deviceId/transform
 * body: Partial<DeviceInstance>
 * 写操作 - 仅 owner
 */
export function handleUpdateTransform(req: Request, res: Response): Response {
  const id = String(req.params.id || '');
  const deviceId = String(req.params.deviceId || '');
  const transform = req.body as Partial<DeviceInstance>;
  if (!id || !deviceId) return err(res, 400, 'session id and deviceId required');
  if (!transform || typeof transform !== 'object') {
    return err(res, 400, 'transform body (object) required');
  }
  const store = getSessionStore();
  const state = store.listCanvases().find(c => c.sessionId === id);
  if (!state) return err(res, 404, 'canvas not found');
  if (!ensureWriteDevice(req, res, state, 'write_device')) return res;
  const requester = getRequesterChatSessionId(req);
  // ★ 无归属画布: 第一个写入者获得归属权
  if (requester) store.claimCanvas(id, requester);
  store.updateDeviceTransform(id, deviceId, transform);
  if (requester) emitCanvasChange(state, requester, 'write_device');
  return ok(res);
}

/**
 * PATCH /api/canvas/sessions/:id
 * P0: 仅改 description (备注)
 * name 是系统分配的零填充序号, 不允许改
 * 写操作 - 仅 owner
 * body: { description?: string }
 */
export function handleRenameSession(req: Request, res: Response): Response {
  const id = String(req.params.id || '');
  if (!id) return err(res, 400, 'session id required');
  const body = (req.body && typeof req.body === 'object') ? req.body as { description?: unknown } : {};
  if (body.description !== undefined && typeof body.description !== 'string') {
    return err(res, 400, 'description must be string');
  }
  const store = getSessionStore();
  const state = store.listCanvases().find(c => c.sessionId === id);
  if (!state) return err(res, 404, 'canvas not found');
  if (!ensureManage(req, res, state)) return res;
  const requester = getRequesterChatSessionId(req);
  try {
    store.updateCanvasDescription(id, typeof body.description === 'string' ? body.description : undefined);
    if (requester) emitCanvasChange(state, requester, 'rename');
    return ok(res, store.listCanvases().find(c => c.sessionId === id));
  } catch (e) {
    return err(res, 400, (e as Error).message);
  }
}

/**
 * DELETE /api/canvas/sessions/:id
 * P0: 删除画布 (内存 + 持久层)
 * ★ FIX 2026-07-14: 移除 owner 限制, 任何 requester 都可删除 (用户手动清理需求)
 * 彻底清理: 内存 states/dirty + Garnet 热存储 + SurrealDB 持久层 + Electron 子进程
 */
export async function handleDeleteSession(req: Request, res: Response): Promise<Response> {
  const id = String(req.params.id || '');
  if (!id) return err(res, 400, 'session id required');
  const store = getSessionStore();
  // ★ FIX 2026-07-14: 先鉴权再查内存 — 保证 401 优先于 404
  const requester = getRequesterChatSessionId(req);
  if (!requester) return err(res, 401, 'X-Requester-Chat-Session-Id header required');
  const state = store.listCanvases().find(c => c.sessionId === id);
  try {
    if (state) {
      // Session 在内存中 — 完整删除 (内存 + Garnet + SurrealDB)
      const ok2 = await store.deleteSession(id);
      if (!ok2) return err(res, 404, 'canvas not found');
      emitCanvasChange(state, requester, 'delete');
      return ok(res, { deleted: id });
    } else {
      // ★ 2026-07-14: Session 不在内存中 (服务器重启后 SurrealDB 恢复失败)
      //   1. 尝试清理持久层 (Garnet + SurrealDB)
      //   2. 无论持久层是否有, 返回 200 — DELETE 幂等: "不存在" = "已删除"
      //   前端会清理本地缓存 (Electron 子进程 / incrementalCanvasPusher / canvasDeviceStore)
      await store.deleteSessionFromPersistence(id);
      return ok(res, { deleted: id, notInMemory: true });
    }
  } catch (e) {
    return err(res, 500, `delete failed: ${(e as Error).message}`);
  }
}

/**
 * GET /api/canvas/sessions
 * P0: 列出所有画布 (轻量摘要) — 需要 requester (仅返回可读画布)
 */
export function handleListSessions(req: Request, res: Response): Response {
  const store = getSessionStore();
  const all = store.listCanvases();
  const requester = getRequesterChatSessionId(req);
  // 没传 requester 时返回 401 (因为新机制下读也要鉴权)
  if (!requester) return err(res, 401, 'X-Requester-Chat-Session-Id header required');
  const list = all
    .filter(c => store.canRead(c, requester))
    .map(c => ({
      sessionId: c.sessionId,
      name: c.name,
      displayName: parseCanvasName(c.name) > 0 ? String(parseCanvasName(c.name)) : c.name,
      ownerChatSessionId: c.ownerChatSessionId,
      isOwner: c.ownerChatSessionId === requester,
      isUnowned: c.ownerChatSessionId === null,
      deviceCount: c.devices.length,
      lastUpdated: c.lastUpdated,
    }));
  return ok(res, { sessions: list, total: list.length });
}

/**
 * POST /api/canvas/sessions/:id/flush
 * body: 可选 { sessionId?: string } — 省略时 flush 全部
 * :id 为 "_all" 时也走 flushAll
 */
export async function handleFlush(req: Request, res: Response): Promise<Response> {
  const id = String(req.params.id || '');
  const store = getSessionStore();
  try {
    if (!id || id === '_all') {
      await store.flushAll();
    } else {
      await store.flushNow(id);
    }
    return ok(res);
  } catch (e) {
    return err(res, 500, `flush failed: ${(e as Error).message}`);
  }
}

/**
 * s2.4: 持久化诊断 + 强刷 + 冷启动恢复
 * ----------------------------------------------------------------
 * GET    /api/canvas/persistence/status
 *   返回 SessionStore 持久化统计
 *
 * POST   /api/canvas/persistence/force-flush
 *   body: { sessionId?: string }
 *   阻塞 flush 到 Garnet + Surreal
 *
 * POST   /api/canvas/persistence/restore-all
 *   从 SurrealDB 拉所有 session 恢复到内存
 *   返回 { restored, total }
 */
export function handleGetPersistenceStatus(_req: Request, res: Response): Response {
  return ok(res, getSessionStore().getPersistenceStats());
}

export async function handleForceFlush(req: Request, res: Response): Promise<Response> {
  const sid = (req.body && typeof req.body === 'object')
    ? (typeof req.body.sessionId === 'string' ? req.body.sessionId : undefined)
    : undefined;
  try {
    const r = await getSessionStore().forceFlush(sid);
    return ok(res, r);
  } catch (e) {
    return err(res, 500, `force flush failed: ${(e as Error).message}`);
  }
}

export async function handleRestoreAll(_req: Request, res: Response): Promise<Response> {
  try {
    const r = await getSessionStore().restoreAllFromSurreal();
    return ok(res, r);
  } catch (e) {
    return err(res, 500, `restore-all failed: ${(e as Error).message}`);
  }
}

/**
 * ★ POST /api/canvas/persistence/clear-all
 * 清空所有画布数据 (内存 + Garnet + SurrealDB)
 * 用于清理旧数据 / 重置状态
 */
export async function handleClearAll(_req: Request, res: Response): Promise<Response> {
  try {
    const r = await clearAllCanvases();
    console.log('[canvasSession] clearAll result:', JSON.stringify(r));
    return ok(res, r);
  } catch (e) {
    return err(res, 500, `clear-all failed: ${(e as Error).message}`);
  }
}

/**
 * s2.2: 多选 + 群组变换
 * ----------------------------------------------------------------
 * PUT    /api/canvas/sessions/:id/devices/selected-many
 *   body: { deviceIds: string[], primaryId?: string }
 *   替换选中集 (旧 selected 端点行为 = 这个端点的单元素版本)
 *
 * POST   /api/canvas/sessions/:id/devices/transform-group
 *   body: { dXRatio?, dYRatio?, dRotationX?, dRotationY?, dRotationZ?, scaleDelta? }
 *   群组增量变换 — 只作用于当前 selectedDevices
 */
export function handleSetSelectedDevices(req: Request, res: Response): Response {
  const id = String(req.params.id || '');
  if (!id) return err(res, 400, 'session id required');
  const body = req.body || {};
  if (!Array.isArray(body.deviceIds)) {
    return err(res, 400, 'deviceIds (string[]) required');
  }
  if (body.deviceIds.some((x: unknown) => typeof x !== 'string')) {
    return err(res, 400, 'deviceIds must be string array');
  }
  const primaryId = typeof body.primaryId === 'string' ? body.primaryId : undefined;
  const store = getSessionStore();
  const state = store.listCanvases().find(c => c.sessionId === id);
  if (!state) return err(res, 404, 'canvas not found');
  if (!ensureWriteDevice(req, res, state, 'write_device')) return res;
  const requester = getRequesterChatSessionId(req);
  // ★ 无归属画布: 第一个写入者获得归属权
  if (requester) store.claimCanvas(id, requester);
  store.setSelectedDevices(id, body.deviceIds as string[], primaryId);
  if (requester) emitCanvasChange(state, requester, 'write_device');
  return ok(res);
}

export function handleTransformGroup(req: Request, res: Response): Response {
  const id = String(req.params.id || '');
  if (!id) return err(res, 400, 'session id required');
  const body = req.body || {};
  if (!body || typeof body !== 'object') {
    return err(res, 400, 'delta body (object) required');
  }
  const n = (v: unknown): number | undefined => {
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const store = getSessionStore();
  const state = store.listCanvases().find(c => c.sessionId === id);
  if (!state) return err(res, 404, 'canvas not found');
  if (!ensureWriteDevice(req, res, state, 'write_device')) return res;
  const requester = getRequesterChatSessionId(req);
  // ★ 无归属画布: 第一个写入者获得归属权
  if (requester) store.claimCanvas(id, requester);
  store.transformGroup(id, {
    dXRatio: n(body.dXRatio),
    dYRatio: n(body.dYRatio),
    dRotationX: n(body.dRotationX),
    dRotationY: n(body.dRotationY),
    dRotationZ: n(body.dRotationZ),
    scaleDelta: n(body.scaleDelta),
  });
  if (requester) emitCanvasChange(state, requester, 'write_device');
  return ok(res);
}

/**
 * s3.2c: 多 session 设备 UI — 设置设备的独立 UI session
 * ----------------------------------------------------------------
 * PUT /api/canvas/sessions/:id/devices/:deviceId/ui-session
 *   body: { uiSessionId: string | null }
 *   - null = 回退到共享 UI (所有设备同屏)
 *   - 有值 = 该设备使用独立 UI session
 */
export function handleSetDeviceUiSession(req: Request, res: Response): Response {
  const id = String(req.params.id || '');
  const deviceId = String(req.params.deviceId || '');
  if (!id || !deviceId) return err(res, 400, 'session id and deviceId required');
  const { uiSessionId } = req.body || {};
  if (uiSessionId !== null && uiSessionId !== undefined && typeof uiSessionId !== 'string') {
    return err(res, 400, 'uiSessionId must be string or null');
  }
  const store = getSessionStore();
  const state = store.listCanvases().find(c => c.sessionId === id);
  if (!state) return err(res, 404, 'canvas not found');
  if (!ensureWriteDevice(req, res, state, 'write_device')) return res;
  const requester = getRequesterChatSessionId(req);
  // ★ 无归属画布: 第一个写入者获得归属权
  if (requester) store.claimCanvas(id, requester);
  const found = store.setDeviceUiSession(
    id,
    deviceId,
    uiSessionId ?? null,
  );
  if (!found) return err(res, 404, 'device not found');
  if (requester) emitCanvasChange(state, requester, 'write_device');
  return ok(res);
}

/**
 * ★ 2026-07-13: 画布 DSL 热数据存储
 * PUT /api/canvas/sessions/:id/dsl  — 写入 LLM 生成的 DSL/AST
 * GET /api/canvas/sessions/:id/dsl  — 读取最后保存的 DSL/AST
 *
 * 存储层: GarnetStore (Redis 兼容, 24h TTL)
 * Key 规范: hot:sf:session:{id}:dsl
 */
async function handleSaveDsl(req: Request, res: Response): Promise<Response> {
  const sessionId = req.params.id;
  if (!sessionId) return err(res, 400, 'sessionId required');
  const { dsl, language, sourceCode } = req.body || {};
  if (!dsl) return err(res, 400, 'dsl required in body');
  try {
    const garnet = getGarnetStore();
    // 直接用 GarnetStore 的底层 client 写一个独立的 dsl key
    const key = `hot:sf:session:${sessionId}:dsl`;
    const value = JSON.stringify({
      dsl,
      language: language || 'json',
      sourceCode: sourceCode || '',
      savedAt: Date.now(),
    });
    // @ts-ignore — GarnetStore.client is private but we need raw access
    await garnet.client.set(key, value, 'EX', 86400); // 24h TTL
    return ok(res, { savedAt: Date.now() });
  } catch (e) {
    console.warn('[canvasSession] saveDsl failed:', (e as Error).message);
    return err(res, 500, `saveDsl failed: ${(e as Error).message}`);
  }
}

async function handleGetDsl(req: Request, res: Response): Promise<Response> {
  const sessionId = req.params.id;
  if (!sessionId) return err(res, 400, 'sessionId required');
  try {
    const garnet = getGarnetStore();
    const key = `hot:sf:session:${sessionId}:dsl`;
    // @ts-ignore
    const value = await garnet.client.get(key);
    if (!value) return ok(res, null); // 没有热数据
    try {
      const parsed = JSON.parse(value);
      return ok(res, parsed);
    } catch {
      return ok(res, null); // 损坏数据当没存
    }
  } catch (e) {
    console.warn('[canvasSession] getDsl failed:', (e as Error).message);
    return err(res, 500, `getDsl failed: ${(e as Error).message}`);
  }
}

/*
 * 路由注册(挂到 Express app)
 *
 * 注意顺序:
 *   /flush 必须放在 /devices/:deviceId 之前,否则
 *   'flush' 会被匹配成 deviceId="flush"
 */
export function registerCanvasSessionRoutes(app: import('express').Express): void {
  // P0: 资源池端点 (无 :id) 必须在 :id 路由前
  app.get('/api/canvas/resources', handleListResources);
  // P0: 画布通知 (drain + ack, 由 owner 轮询)
  app.get('/api/canvas/notifications', handleDrainNotifications);
  app.post('/api/canvas/notifications/peek', handlePeekNotifications);
  // P0: 创建画布
  app.post('/api/canvas/sessions', handleCreateCanvas);
  // s1.4: 会话列表 (无 :id)
  app.get('/api/canvas/sessions', handleListSessions);
  app.get('/api/canvas/sessions/:id', handleGetSession);
  // s1.4: 改名 (PATCH) + 删除 (DELETE)
  app.patch('/api/canvas/sessions/:id', handleRenameSession);
  app.delete('/api/canvas/sessions/:id', handleDeleteSession);
  app.put('/api/canvas/sessions/:id/select-model', handleSelectModel);
  app.put('/api/canvas/sessions/:id/devices/selected', handleSetSelectedDevice);
  app.put('/api/canvas/sessions/:id/devices/selected-many', handleSetSelectedDevices);
  app.post('/api/canvas/sessions/:id/devices/transform-group', handleTransformGroup);
  app.post('/api/canvas/sessions/:id/devices', handleAddDevice);
  app.delete('/api/canvas/sessions/:id/devices/:deviceId', handleRemoveDevice);
  app.put('/api/canvas/sessions/:id/devices/:deviceId/transform', handleUpdateTransform);
  app.put('/api/canvas/sessions/:id/devices/:deviceId/ui-session', handleSetDeviceUiSession);
  app.post('/api/canvas/sessions/:id/flush', handleFlush);
  app.get('/api/canvas/sessions/:id/dsl', handleGetDsl);
  app.put('/api/canvas/sessions/:id/dsl', handleSaveDsl);
  app.get('/api/canvas/persistence/status', handleGetPersistenceStatus);
  app.post('/api/canvas/persistence/force-flush', handleForceFlush);
  app.post('/api/canvas/persistence/restore-all', handleRestoreAll);
  app.post('/api/canvas/persistence/clear-all', handleClearAll);
}

// ─────────────────────────────────────────────────────────────
// P0: 画布修改通知 (owner 轮询拉取)
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/canvas/notifications?requester=chat-A
 * 拉取 + ack (consume模式, 拉过的就清掉)
 *
 * 客户端每 3s 轮询一次, 拿到的 notifications push 到气泡队列
 */
export function handleDrainNotifications(req: Request, res: Response): Response {
  // requester 从 query 或 header 取
  const requester = String(req.query.requester || getRequesterChatSessionId(req) || '');
  if (!requester) return err(res, 401, 'requester (query or X-Requester-Chat-Session-Id header) required');
  const list = getNotificationBus().drain(requester);
  return ok(res, { notifications: list, count: list.length });
}

/**
 * POST /api/canvas/notifications/peek
 * 仅查看, 不消费 (用于调试 + E2E 测试)
 *
 * body: { requester: 'chat-A' }
 */
export function handlePeekNotifications(req: Request, res: Response): Response {
  const body = (req.body && typeof req.body === 'object') ? req.body as { requester?: unknown } : {};
  const requester = typeof body.requester === 'string' ? body.requester : '';
  if (!requester) return err(res, 400, 'body.requester required');
  const list = getNotificationBus().peek(requester);
  return ok(res, { notifications: list, count: list.length });
}

/**
 * 优雅退出:server.ts before-quit 时调用,刷所有 session 到持久层
 */
export async function flushAllSessions(): Promise<void> {
  try {
    await getSessionStore().flushAll();
  } catch (e) {
    console.warn('[canvasSession] flushAllSessions failed:', (e as Error).message);
  }
}

// 暴露 SessionState 类型,供其他 server 模块引用
export type { SessionState };