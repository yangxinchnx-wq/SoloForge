/**
 * Canvas Session HTTP Client(前端)
 *
 * 替代旧的 SessionStore 类调用,所有操作走 HTTP 到 server.ts 路由。
 * server.ts 内部用 SessionStore (server/services/session/SessionStore) 维护状态。
 *
 * 错误处理:
 * - 网络失败 → 返回默认值(不阻塞 UI)
 * - 4xx/5xx → console.warn + 返回 false / null
 * - 调用方可选择静默忽略
 */

import type { DeviceInstance, SessionState } from './types';

const API_BASE = '/api/canvas/sessions';

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    });
    if (!res.ok) {
      console.warn(`[sessionApi] ${init?.method || 'GET'} ${url} → ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (data && typeof data === 'object' && 'success' in data) {
      return data.success ? (data.payload as T) : null;
    }
    return data as T;
  } catch (e) {
    console.warn(`[sessionApi] ${init?.method || 'GET'} ${url} failed:`, (e as Error).message);
    return null;
  }
}

/**
 * 获取完整 session 状态
 */
export async function fetchSession(sessionId: string): Promise<SessionState | null> {
  return jsonRequest<SessionState>(`${API_BASE}/${encodeURIComponent(sessionId)}`);
}

/**
 * 选中设备模型(切换画布模式)
 */
export async function selectModel(sessionId: string, modelKey: string): Promise<boolean> {
  const r = await jsonRequest<{ ok: true }>(
    `${API_BASE}/${encodeURIComponent(sessionId)}/select-model`,
    { method: 'PUT', body: JSON.stringify({ modelKey }) }
  );
  return r !== null;
}

/**
 * 设置当前选中设备 id(用于高亮)
 */
export async function setSelectedDevice(sessionId: string, deviceId: string | null): Promise<boolean> {
  const r = await jsonRequest<{ ok: true }>(
    `${API_BASE}/${encodeURIComponent(sessionId)}/devices/selected`,
    { method: 'PUT', body: JSON.stringify({ deviceId }) }
  );
  return r !== null;
}

/**
 * 更新设备 transform(位置 / 旋转 / 缩放等)
 */
export async function updateDeviceTransform(
  sessionId: string,
  deviceId: string,
  transform: Partial<DeviceInstance>
): Promise<boolean> {
  const r = await jsonRequest<{ ok: true }>(
    `${API_BASE}/${encodeURIComponent(sessionId)}/devices/${encodeURIComponent(deviceId)}/transform`,
    { method: 'PUT', body: JSON.stringify(transform) }
  );
  return r !== null;
}

/**
 * 添加设备
 */
export async function addDevice(sessionId: string, device: DeviceInstance): Promise<boolean> {
  const r = await jsonRequest<{ ok: true }>(
    `${API_BASE}/${encodeURIComponent(sessionId)}/devices`,
    { method: 'POST', body: JSON.stringify(device) }
  );
  return r !== null;
}

/**
 * 删除设备
 */
export async function removeDevice(sessionId: string, deviceId: string): Promise<boolean> {
  const r = await jsonRequest<{ ok: true }>(
    `${API_BASE}/${encodeURIComponent(sessionId)}/devices/${encodeURIComponent(deviceId)}`,
    { method: 'DELETE' }
  );
  return r !== null;
}

/**
 * 强制 flush(立即写 Garnet + Surreal)
 */
export async function flushSession(sessionId?: string): Promise<boolean> {
  const r = await jsonRequest<{ ok: true }>(
    `${API_BASE}/${encodeURIComponent(sessionId || '')}/flush`,
    { method: 'POST' }
  );
  return r !== null;
}

// ─────────────────────────────────────────
// s1.4: 会话改名 / 删除 / 列表
// ─────────────────────────────────────────

export interface SessionSummary {
  sessionId: string;
  name?: string;
  description?: string;
  createdAt?: number;
  lastUpdated: number;
  deviceCount: number;
  bgColor: string;
  isCurrent: boolean;
}

/**
 * s1.4: 改会话名 (空字符串 = 清掉名字)
 */
export async function renameSession(
  sessionId: string,
  name?: string,
  description?: string
): Promise<SessionState | null> {
  const r = await jsonRequest<SessionState>(
    `${API_BASE}/${encodeURIComponent(sessionId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        name: name !== undefined ? name : undefined,
        description: description !== undefined ? description : undefined,
      }),
    }
  );
  return r;
}

/**
 * s2.2: 多选设备 — 替换选中集
 *
 * @param deviceIds  选中的设备 ID 列表 (空数组 = 取消所有)
 * @param primaryId  主选 ID, 默认 deviceIds[0]
 */
export async function setSelectedDevices(
  sessionId: string,
  deviceIds: string[],
  primaryId?: string,
): Promise<boolean> {
  const r = await jsonRequest<{ success: true }>(
    `${API_BASE}/${encodeURIComponent(sessionId)}/devices/selected-many`,
    {
      method: 'PUT',
      body: JSON.stringify({ deviceIds, primaryId }),
    }
  );
  return r?.success === true;
}

/**
 * s2.2: 群组增量变换
 *
 * 只作用于当前 selectedDeviceIds, 不选中的设备保持原位
 */
export async function transformGroup(
  sessionId: string,
  delta: {
    dXRatio?: number;
    dYRatio?: number;
    dRotationX?: number;
    dRotationY?: number;
    dRotationZ?: number;
    scaleDelta?: number;
  },
): Promise<boolean> {
  const r = await jsonRequest<{ success: true }>(
    `${API_BASE}/${encodeURIComponent(sessionId)}/devices/transform-group`,
    {
      method: 'POST',
      body: JSON.stringify(delta),
    }
  );
  return r?.success === true;
}

/**
 * s2.4: 持久化诊断
 */
export interface PersistenceStats {
  totalFlushes: number;
  garnetWrites: number;
  surrealWrites: number;
  lastFlushAt: number;
  lastFlushDurationMs: number;
  skippedFlushes: number;
  dirtyCount: number;
  inMemoryCount: number;
  flushIntervalMs: number;
}

export async function getPersistenceStatus(): Promise<PersistenceStats | null> {
  return jsonRequest<PersistenceStats>('/api/canvas/persistence/status');
}

/**
 * s2.4: 强制 flush (F5 前调用)
 *
 * 不阻塞, fire-and-forget
 */
export function forceFlush(sessionId?: string): void {
  const url = '/api/canvas/persistence/force-flush';
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sessionId ? { sessionId } : {}),
    // keepalive 让浏览器在 unload 阶段也能发出
    keepalive: true,
  }).catch(() => {});
}

/**
 * s2.4: 冷启动恢复 — 把 SurrealDB 里所有 session 拉回内存
 */
export async function restoreAllFromSurreal(): Promise<{ restored: number; total: number } | null> {
  const r = await jsonRequest<{ success: true; payload: { restored: number; total: number } }>(
    '/api/canvas/persistence/restore-all',
    { method: 'POST' }
  );
  return r?.payload ?? null;
}

/**
 * s1.4: 删除会话 (内存 + 持久层)
 */
export async function deleteSession(sessionId: string): Promise<boolean> {
  const r = await jsonRequest<{ deleted: string }>(
    `${API_BASE}/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' }
  );
  return r !== null;
}

/**
 * s3.2c: 多 session 设备 UI — 设置设备的独立 UI session
 *
 * @param uiSessionId - null = 回退到共享 UI; 有值 = 该设备独立 UI
 * @returns 是否成功
 */
export async function setDeviceUiSession(
  sessionId: string,
  deviceId: string,
  uiSessionId: string | null,
): Promise<boolean> {
  const r = await jsonRequest<{ success: true }>(
    `${API_BASE}/${encodeURIComponent(sessionId)}/devices/${encodeURIComponent(deviceId)}/ui-session`,
    { method: 'PUT', body: JSON.stringify({ uiSessionId }) }
  );
  return r?.success === true;
}

/**
 * s1.4: 列出所有会话 (轻量摘要)
 */
export async function listSessions(): Promise<SessionSummary[]> {
  const r = await jsonRequest<{ sessions: SessionSummary[]; total: number }>(API_BASE);
  return r?.sessions || [];
}

// ─────────────────────────────────────────
// P0: 画布作为公共资源 + ACL
// ─────────────────────────────────────────

/**
 * 画布资源摘要 (公共资源池视图)
 *
 * sessionId: 画布 ID (canvas_1 ... canvas_10)
 * displayName: UI 显示的序号 (1, 2, ..., 10)
 * ownerChatSessionId: 创建该画布的 chat session
 * isOwner: 当前请求方是否 owner (可写)
 * lastAccessedAt: 请求方最近一次访问时间
 */
export interface CanvasResource {
  sessionId: string;
  name: string;
  displayName: string;
  description?: string;
  ownerChatSessionId: string;
  isOwner: boolean;
  deviceCount: number;
  lastUpdated: number;
  lastAccessedAt: number | null;
  visibility: 'public';
  bgColor: string;
  devices: DeviceInstance[];
}

export interface CanvasListResponse {
  total: number;
  canvases: CanvasResource[];
  lastAccessedCanvasId: string | null;
  maxCanvases: number;
}

/**
 * 列出当前 chat 可访问的所有画布 (公共读)
 *
 * @param requesterChatSessionId 调用方 chat session id (header)
 */
export async function listCanvasResources(
  requesterChatSessionId: string
): Promise<CanvasListResponse | null> {
  return jsonRequest<CanvasListResponse>('/api/canvas/resources', {
    headers: { 'X-Requester-Chat-Session-Id': requesterChatSessionId },
  });
}

/**
 * 创建一个新画布 (系统自动分配最小可用序号)
 */
export async function createCanvas(
  requesterChatSessionId: string,
  description?: string
): Promise<CanvasResource | null> {
  return jsonRequest<CanvasResource>('/api/canvas/sessions', {
    method: 'POST',
    headers: { 'X-Requester-Chat-Session-Id': requesterChatSessionId },
    body: JSON.stringify({ description }),
  });
}

/**
 * 读画布的完整状态 (public, 但必须带 requester)
 */
export async function fetchCanvas(
  canvasId: string,
  requesterChatSessionId: string
): Promise<SessionState | null> {
  return jsonRequest<SessionState>(`${API_BASE}/${encodeURIComponent(canvasId)}`, {
    headers: { 'X-Requester-Chat-Session-Id': requesterChatSessionId },
  });
}

/**
 * 改画布描述 (仅 owner)
 */
export async function updateCanvasDescription(
  canvasId: string,
  description: string,
  requesterChatSessionId: string
): Promise<SessionState | null> {
  return jsonRequest<SessionState>(`${API_BASE}/${encodeURIComponent(canvasId)}`, {
    method: 'PATCH',
    headers: { 'X-Requester-Chat-Session-Id': requesterChatSessionId },
    body: JSON.stringify({ description }),
  });
}

/**
 * 删除画布 (仅 owner, 序号会被新画布复用)
 */
export async function deleteCanvas(
  canvasId: string,
  requesterChatSessionId: string
): Promise<boolean> {
  const r = await jsonRequest<{ deleted: string }>(
    `${API_BASE}/${encodeURIComponent(canvasId)}`,
    {
      method: 'DELETE',
      headers: { 'X-Requester-Chat-Session-Id': requesterChatSessionId },
    }
  );
  return r !== null;
}

/**
 * 取最近访问的画布 (用于点击 chat 时自动切换)
 */
export async function fetchLastAccessedCanvas(
  requesterChatSessionId: string
): Promise<CanvasListResponse | null> {
  return jsonRequest<CanvasListResponse>('/api/canvas/resources', {
    headers: { 'X-Requester-Chat-Session-Id': requesterChatSessionId },
  });
}

// ─────────────────────────────────────────
// P0: LLM MCP tool 调用
// ─────────────────────────────────────────

export interface MCPToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface MCPInvokeResponse<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

// ─────────────────────────────────────────
// P0: 画布修改通知 (owner 轮询)
// ─────────────────────────────────────────

export interface CanvasNotification {
  id: string;
  actorChatSessionId: string;
  targetChatSessionId: string;
  canvasId: string;
  canvasDisplayName: string;
  action: 'write_device' | 'remove_device' | 'rename' | 'delete';
  ts: number;
  message: string;
}

/**
 * 拉取并 ack (consume) 当前 chat 作为 owner 的所有通知
 *
 * 客户端每 3s 调一次, 拿到的就 push 到气泡队列, 然后这些通知被服务端清掉
 */
export async function drainCanvasNotifications(
  requesterChatSessionId: string,
): Promise<CanvasNotification[]> {
  try {
    const r = await fetch(
      `/api/canvas/notifications?requester=${encodeURIComponent(requesterChatSessionId)}`,
      { headers: { 'X-Requester-Chat-Session-Id': requesterChatSessionId } },
    );
    if (!r.ok) return [];
    const data = await r.json();
    return (data?.payload?.notifications ?? []) as CanvasNotification[];
  } catch {
    return [];
  }
}

/**
 * 仅 peek (不消费), 用于调试
 */
export async function peekCanvasNotifications(
  requesterChatSessionId: string,
): Promise<CanvasNotification[]> {
  try {
    const r = await fetch('/api/canvas/notifications/peek', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requester: requesterChatSessionId }),
    });
    if (!r.ok) return [];
    const data = await r.json();
    return (data?.payload?.notifications ?? []) as CanvasNotification[];
  } catch {
    return [];
  }
}