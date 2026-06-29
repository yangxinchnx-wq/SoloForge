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

import type { Request, Response } from 'express';
import type { DeviceInstance, SessionState } from '../services/canvas/types';
import { getSessionStore } from '../services/session/SessionStore';

function err(res: Response, status: number, message: string): Response {
  return res.status(status).json({ success: false, error: message });
}

function ok(res: Response, payload?: unknown): Response {
  return res.json(payload === undefined ? { success: true } : { success: true, payload });
}

/**
 * GET /api/canvas/sessions/:id
 */
export function handleGetSession(req: Request, res: Response): Response {
  const id = String(req.params.id || '');
  if (!id) return err(res, 400, 'session id required');
  const state = getSessionStore().getOrCreate(id);
  return ok(res, state);
}

/**
 * PUT /api/canvas/sessions/:id/select-model
 * body: { modelKey: string }
 */
export function handleSelectModel(req: Request, res: Response): Response {
  const id = String(req.params.id || '');
  const { modelKey } = req.body || {};
  if (!id) return err(res, 400, 'session id required');
  if (typeof modelKey !== 'string') return err(res, 400, 'modelKey (string) required');
  getSessionStore().selectDevice(id, modelKey);
  return ok(res);
}

/**
 * PUT /api/canvas/sessions/:id/devices/selected
 * body: { deviceId: string | null }
 */
export function handleSetSelectedDevice(req: Request, res: Response): Response {
  const id = String(req.params.id || '');
  const { deviceId } = req.body || {};
  if (!id) return err(res, 400, 'session id required');
  if (deviceId !== null && typeof deviceId !== 'string') {
    return err(res, 400, 'deviceId (string | null) required');
  }
  getSessionStore().setSelectedDevice(id, deviceId);
  return ok(res);
}

/**
 * POST /api/canvas/sessions/:id/devices
 * body: DeviceInstance
 */
export function handleAddDevice(req: Request, res: Response): Response {
  const id = String(req.params.id || '');
  const device = req.body as DeviceInstance;
  if (!id) return err(res, 400, 'session id required');
  if (!device || typeof device.id !== 'string' || typeof device.modelKey !== 'string') {
    return err(res, 400, 'invalid DeviceInstance body');
  }
  getSessionStore().addDevice(id, device);
  return ok(res);
}

/**
 * DELETE /api/canvas/sessions/:id/devices/:deviceId
 */
export function handleRemoveDevice(req: Request, res: Response): Response {
  const id = String(req.params.id || '');
  const deviceId = String(req.params.deviceId || '');
  if (!id || !deviceId) return err(res, 400, 'session id and deviceId required');
  getSessionStore().removeDevice(id, deviceId);
  return ok(res);
}

/**
 * PUT /api/canvas/sessions/:id/devices/:deviceId/transform
 * body: Partial<DeviceInstance>
 */
export function handleUpdateTransform(req: Request, res: Response): Response {
  const id = String(req.params.id || '');
  const deviceId = String(req.params.deviceId || '');
  const transform = req.body as Partial<DeviceInstance>;
  if (!id || !deviceId) return err(res, 400, 'session id and deviceId required');
  if (!transform || typeof transform !== 'object') {
    return err(res, 400, 'transform body (object) required');
  }
  getSessionStore().updateDeviceTransform(id, deviceId, transform);
  return ok(res);
}

/**
 * PATCH /api/canvas/sessions/:id
 * s1.4: 改会话名 + 备注
 * body: { name?: string, description?: string }
 */
export function handleRenameSession(req: Request, res: Response): Response {
  const id = String(req.params.id || '');
  if (!id) return err(res, 400, 'session id required');
  const body = req.body || {};
  if (typeof body !== 'object') return err(res, 400, 'body must be object');
  try {
    const state = getSessionStore().renameSession(
      id,
      typeof body.name === 'string' ? body.name : undefined,
      typeof body.description === 'string' ? body.description : undefined
    );
    if (!state) return err(res, 404, 'session not found');
    return ok(res, state);
  } catch (e) {
    return err(res, 400, (e as Error).message);
  }
}

/**
 * DELETE /api/canvas/sessions/:id
 * s1.4: 删除会话 (内存 + 持久层)
 */
export async function handleDeleteSession(req: Request, res: Response): Promise<Response> {
  const id = String(req.params.id || '');
  if (!id) return err(res, 400, 'session id required');
  try {
    const ok2 = await getSessionStore().deleteSession(id);
    if (!ok2) return err(res, 404, 'session not found');
    return ok(res, { deleted: id });
  } catch (e) {
    return err(res, 500, `delete failed: ${(e as Error).message}`);
  }
}

/**
 * GET /api/canvas/sessions
 * s1.4: 列出所有会话 (轻量摘要)
 */
export function handleListSessions(req: Request, res: Response): Response {
  const list = getSessionStore().listSessions();
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
  // 元素必须是 string
  if (body.deviceIds.some((x: unknown) => typeof x !== 'string')) {
    return err(res, 400, 'deviceIds must be string array');
  }
  const primaryId = typeof body.primaryId === 'string' ? body.primaryId : undefined;
  getSessionStore().setSelectedDevices(id, body.deviceIds as string[], primaryId);
  return ok(res);
}

export function handleTransformGroup(req: Request, res: Response): Response {
  const id = String(req.params.id || '');
  if (!id) return err(res, 400, 'session id required');
  const body = req.body || {};
  if (!body || typeof body !== 'object') {
    return err(res, 400, 'delta body (object) required');
  }
  // 数字字段容错
  const n = (v: unknown): number | undefined => {
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  getSessionStore().transformGroup(id, {
    dXRatio: n(body.dXRatio),
    dYRatio: n(body.dYRatio),
    dRotationX: n(body.dRotationX),
    dRotationY: n(body.dRotationY),
    dRotationZ: n(body.dRotationZ),
    scaleDelta: n(body.scaleDelta),
  });
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
  // uiSessionId 可以是 string 或 null (显式传 null = 回退共享 UI)
  if (uiSessionId !== null && uiSessionId !== undefined && typeof uiSessionId !== 'string') {
    return err(res, 400, 'uiSessionId must be string or null');
  }
  const found = getSessionStore().setDeviceUiSession(
    id,
    deviceId,
    uiSessionId ?? null,
  );
  if (!found) return err(res, 404, 'device not found');
  return ok(res);
}

/**
 * 路由注册(挂到 Express app)
 *
 * 注意顺序:
 *   /flush 必须放在 /devices/:deviceId 之前,否则
 *   'flush' 会被匹配成 deviceId="flush"
 */
export function registerCanvasSessionRoutes(app: import('express').Express): void {
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
  // s3.2c: 多 session 设备 UI — 设置设备独立 UI session
  app.put('/api/canvas/sessions/:id/devices/:deviceId/ui-session', handleSetDeviceUiSession);
  app.post('/api/canvas/sessions/:id/flush', handleFlush);
  // s2.4: 持久化诊断 (放在 :id 路由之后避免吞掉)
  app.get('/api/canvas/persistence/status', handleGetPersistenceStatus);
  app.post('/api/canvas/persistence/force-flush', handleForceFlush);
  app.post('/api/canvas/persistence/restore-all', handleRestoreAll);
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