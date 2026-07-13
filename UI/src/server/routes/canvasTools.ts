/**
 * SoloForge Canvas Tools (MCP-style)
 *
 * 提供大模型可调用的 solo_canvas_* 工具集
 *
 * 设计:
 *   - GET  /api/canvas/tools          → 返回 MCP 工具 schema 列表
 *   - POST /api/canvas/tools/invoke   → 执行指定工具 (路由到对应 handler)
 *
 * 工具命名规范:
 *   - 全部以 solo_canvas_ 前缀
 *   - requesterChatSessionId 是必填参数 (从 caller 传入, 代表调用方 chat)
 *
 * 权限:
 *   - list/get    → 任何 chat 都行 (public visibility)
 *   - create      → 任何 chat
 *   - add/update/remove device / rename / delete → 仅 owner
 */

import type { Request, Response } from 'express';
import type { DeviceInstance, SessionState } from '../services/canvas/types';
import { displayCanvasName, parseCanvasName } from '../services/canvas/types';
import { getSessionStore } from '../services/session/SessionStore';
import { getNotificationBus } from '../services/canvas/NotificationBus';

/** MCP 工具 schema */
interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; enum?: string[]; items?: { type: string } }>;
    required: string[];
  };
}

/** Tool invoke 响应 (OpenAI function calling 风格) */
interface ToolInvokeResponse {
  success: boolean;
  result?: unknown;
  error?: string;
}

// ─────────────────────────────────────────────────────────────
// MCP 工具 schema 列表 (暴露给大模型)
// ─────────────────────────────────────────────────────────────
const TOOLS: ToolSchema[] = [
  {
    name: 'solo_canvas_list',
    description: '列出当前 chat 可访问的所有画布 (按序号升序, 默认所有 public 画布可见)',
    input_schema: {
      type: 'object',
      properties: {
        requesterChatSessionId: { type: 'string', description: '请求方 chat session ID (必填, 即当前会话 ID)' },
      },
      required: ['requesterChatSessionId'],
    },
  },
  {
    name: 'solo_canvas_create',
    description:
      '为当前 chat 创建一个新画布 (返回 { sessionId, displayName, owner, deviceCount })。\n' +
      '\n' +
      '## 用法\n' +
      '- 序号由系统自动分配 (canvas_1, canvas_2, ..., canvas_10, 满了返回错误)\n' +
      '- description 可选, 建议用一句话描述画布用途, 例如 "3 设备对比图"\n' +
      '- requesterChatSessionId 必填 (创建者, 画布创建时无归属, 第一个写入者获得归属权)\n' +
      '\n' +
      '## 后续\n' +
      '创建后用 solo_canvas_add_device 摆设备 (同时获得归属权), 用 solo_canvas_rename 改备注 (需已获得归属权)。',
    input_schema: {
      type: 'object',
      properties: {
        requesterChatSessionId: { type: 'string', description: '创建者 chat session ID (必填, 画布创建时无归属, 第一个写入者获得归属权)' },
        description: { type: 'string', description: '可选备注 (最多 200 字符, 例: "3 设备对比图")' },
      },
      required: ['requesterChatSessionId'],
    },
  },
  {
    name: 'solo_canvas_get',
    description: '读取画布的完整状态 (devices / transform / 选中状态 / 背景色)',
    input_schema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string', description: '画布 sessionId (例: canvas_1)' },
        requesterChatSessionId: { type: 'string', description: '请求方 chat session ID (必填)' },
      },
      required: ['canvasId', 'requesterChatSessionId'],
    },
  },
  {
    name: 'solo_canvas_add_device',
    description:
      '向画布添加一个 3D 设备。返回 { added, canvasId, deviceCount }。\n' +
      '\n' +
      '## modelKey 支持清单（任选其一;不传或乱传会被 fallback 成占位框）\n' +
      '**手机 (mobile)**: iphone-15, iphone-15-pro, iphone-15-pro-max, iphone-14, iphone-14-pro, iphone-14-pro-max, iphone-se, galaxy-s23, pixel-7, xiaomi-13\n' +
      '**平板 (tablet)**: ipad-pro, ipad-pro-13, ipad-air, ipad-mini, surface-pro, galaxy-tab-s8\n' +
      '**桌面 (desktop)**: macbook-pro-14, macbook-pro-16, macbook-air, imac-24, studio-display\n' +
      '**手表 (watch)**: apple-watch-41, apple-watch-45, apple-watch-ultra, galaxy-watch-6\n' +
      '\n' +
      '## 推荐布局\n' +
      '- 位置: xRatio/yRatio ∈ [0.1, 0.9]（边缘 0/1 容易被裁）\n' +
      '- 默认朝向: rotationY=0（屏幕朝相机）; 斜放试试 rotationY=15~-15\n' +
      '- 缩放: displayScale 0.6~1.4 视觉效果好\n' +
      '- 颜色: highlightColor = "#RRGGBB"（HEX, 不带 alpha）\n' +
      '\n' +
      '## 例子\n' +
      '{"canvasId":"canvas_1","deviceId":"my-iphone","modelKey":"iphone-15-pro","xRatio":0.3,"yRatio":0.5,"rotationY":15,"displayScale":1.0,"highlightColor":"#4A90E2","requesterChatSessionId":"chat-1"}',
    input_schema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string' },
        deviceId: { type: 'string', description: '设备 ID (画布内唯一, 建议带语义后缀如 "my-iphone")' },
        modelKey: { type: 'string', description: '设备型号 key (见 description 里的清单; 默认 fallback 占位)' },
        xRatio: { type: 'number', description: 'X 位置 0-1 (相对画布宽度)' },
        yRatio: { type: 'number', description: 'Y 位置 0-1 (相对画布高度)' },
        rotationX: { type: 'number', description: 'X 旋转, 单位 度 (°)' },
        rotationY: { type: 'number', description: 'Y 旋转, 单位 度 (°)' },
        rotationZ: { type: 'number', description: 'Z 旋转, 单位 度 (°)' },
        displayScale: { type: 'number', description: '缩放 0.5~2.0 (1.0=原生大小)' },
        highlightColor: { type: 'string', description: '高亮色 HEX (#RRGGBB, 不带 alpha)' },
        requesterChatSessionId: { type: 'string' },
      },
      required: ['canvasId', 'deviceId', 'modelKey', 'requesterChatSessionId'],
    },
  },
  {
    name: 'solo_canvas_update_device',
    description: '更新画布中某个设备的 transform (位置/旋转/缩放)。仅 owner',
    input_schema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string' },
        deviceId: { type: 'string' },
        xRatio: { type: 'number' },
        yRatio: { type: 'number' },
        rotationX: { type: 'number' },
        rotationY: { type: 'number' },
        rotationZ: { type: 'number' },
        displayScale: { type: 'number' },
        highlightColor: { type: 'string' },
        requesterChatSessionId: { type: 'string' },
      },
      required: ['canvasId', 'deviceId', 'requesterChatSessionId'],
    },
  },
  {
    name: 'solo_canvas_remove_device',
    description: '从画布删除一个设备。仅 owner',
    input_schema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string' },
        deviceId: { type: 'string' },
        requesterChatSessionId: { type: 'string' },
      },
      required: ['canvasId', 'deviceId', 'requesterChatSessionId'],
    },
  },
  {
    name: 'solo_canvas_rename',
    description: '修改画布备注 (description)。画布名称由系统分配 (零填充序号 01-10), 不允许改 name。仅 owner',
    input_schema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string' },
        description: { type: 'string' },
        requesterChatSessionId: { type: 'string' },
      },
      required: ['canvasId', 'requesterChatSessionId'],
    },
  },
  {
    name: 'solo_canvas_delete',
    description: '删除画布 (序号会被新画布复用)。仅 owner',
    input_schema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string' },
        requesterChatSessionId: { type: 'string' },
      },
      required: ['canvasId', 'requesterChatSessionId'],
    },
  },
];

// ─────────────────────────────────────────────────────────────
// 路由 handler
// ─────────────────────────────────────────────────────────────

/** GET /api/canvas/tools — 返回 MCP schema */
export function handleListTools(_req: Request, res: Response): Response {
  return res.json({ success: true, payload: { tools: TOOLS } });
}

/** POST /api/canvas/tools/invoke — 执行工具 */
export async function handleInvokeTool(req: Request, res: Response): Promise<Response> {
  const body = (req.body && typeof req.body === 'object') ? req.body as { name?: unknown; arguments?: unknown } : {};
  const name = typeof body.name === 'string' ? body.name : '';
  const args = (body.arguments && typeof body.arguments === 'object')
    ? body.arguments as Record<string, unknown>
    : {};

  if (!name) {
    return res.status(400).json({ success: false, error: 'tool name required' });
  }
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return res.status(404).json({ success: false, error: `tool not found: ${name}` });
  }
  // 校验必填参数
  for (const required of tool.input_schema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return res.status(400).json({ success: false, error: `missing required arg: ${required}` });
    }
  }

  try {
    const result = await dispatchTool(name, args);
    return res.json({ success: true, payload: result } satisfies ToolInvokeResponse);
  } catch (e) {
    const err = e as ToolError;
    const status = err.status ?? 500;
    return res.status(status).json({
      success: false,
      error: err.message || 'internal error',
    } satisfies ToolInvokeResponse);
  }
}

class ToolError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// ─────────────────────────────────────────────────────────────
// 工具分发 + 实现
// ─────────────────────────────────────────────────────────────

async function dispatchTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const store = getSessionStore();
  switch (name) {
    case 'solo_canvas_list': {
      const requester = String(args.requesterChatSessionId);
      const all = store.listCanvases();
      const visible = all
        .filter((c) => store.canRead(c, requester))
        .map((c) => summarize(c, requester));
      return {
        total: visible.length,
        canvases: visible,
        lastAccessedCanvasId: store.getLastAccessedCanvas(requester)?.sessionId ?? null,
        maxCanvases: 10,
      };
    }

    case 'solo_canvas_create': {
      const requester = String(args.requesterChatSessionId);
      const description = typeof args.description === 'string' ? args.description : undefined;
      const state = store.createCanvas();
      if (!state) throw new ToolError('canvas limit reached (max 10, please delete some before creating)', 400);
      if (description !== undefined) {
        if (description.length > 200) throw new ToolError('description too long (max 200)', 400);
        state.description = description;
      }
      store.recordAccess(state.sessionId, requester);
      return summarize(state, requester);
    }

    case 'solo_canvas_get': {
      const id = String(args.canvasId);
      const requester = String(args.requesterChatSessionId);
      let state = store.listCanvases().find((c) => c.sessionId === id);
      if (!state) state = await store.loadFromSurrealById(id);
      if (!state) throw new ToolError(`canvas not found: ${id}`, 404);
      if (!store.canRead(state, requester)) throw new ToolError('forbidden: read not allowed', 403);
      store.recordAccess(id, requester);
      return state;
    }

    case 'solo_canvas_add_device': {
      const id = String(args.canvasId);
      const requester = String(args.requesterChatSessionId);
      const state = mustGetCanvas(id, requester, 'write_device');
      const device = pickDeviceFromArgs(args);
      store.addDevice(id, device);
      emitCanvasChange(state, requester, 'write_device');
      return { added: device.id, canvasId: id, deviceCount: state.devices.length };
    }

    case 'solo_canvas_update_device': {
      const id = String(args.canvasId);
      const deviceId = String(args.deviceId);
      const requester = String(args.requesterChatSessionId);
      const state = mustGetCanvas(id, requester, 'write_device');
      const transform = pickDeviceFromArgs(args, /* partial */ true);
      const found = state.devices.find((d) => d.id === deviceId);
      if (!found) throw new ToolError(`device not found: ${deviceId}`, 404);
      store.updateDeviceTransform(id, deviceId, transform);
      emitCanvasChange(state, requester, 'write_device');
      return { updated: deviceId, canvasId: id };
    }

    case 'solo_canvas_remove_device': {
      const id = String(args.canvasId);
      const deviceId = String(args.deviceId);
      const requester = String(args.requesterChatSessionId);
      const state = mustGetCanvas(id, requester, 'write_device');
      store.removeDevice(id, deviceId);
      emitCanvasChange(state, requester, 'remove_device');
      return { removed: deviceId, canvasId: id };
    }

    case 'solo_canvas_rename': {
      const id = String(args.canvasId);
      const requester = String(args.requesterChatSessionId);
      const state = mustGetCanvas(id, requester, 'manage');
      const description = typeof args.description === 'string' ? args.description : '';
      const updated = store.updateCanvasDescription(id, description);
      if (!updated) throw new ToolError('canvas not found', 404);
      emitCanvasChange(state, requester, 'rename');
      return summarize(updated, requester);
    }

    case 'solo_canvas_delete': {
      const id = String(args.canvasId);
      const requester = String(args.requesterChatSessionId);
      const state = mustGetCanvas(id, requester, 'manage');
      const ok2 = await store.deleteSession(id);
      if (!ok2) throw new ToolError('delete failed', 500);
      emitCanvasChange(state, requester, 'delete');
      return { deleted: id };
    }

    default:
      throw new ToolError(`tool not implemented: ${name}`, 500);
  }
}

// ─────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────

function mustGetCanvas(id: string, requester: string, mode: 'read' | 'write_device' | 'manage'): SessionState {
  const store = getSessionStore();
  const state = store.listCanvases().find((c) => c.sessionId === id);
  if (!state) throw new ToolError(`canvas not found: ${id}`, 404);
  const allowed = mode === 'read' ? store.canRead(state, requester)
    : mode === 'write_device' ? store.canWriteDevice(state, requester)
    : store.canManage(state, requester);
  if (!allowed) throw new ToolError(`forbidden: ${mode} not allowed`, 403);
  // ★ 无归属画布: 第一个写入者获得归属权
  if (mode === 'write_device') {
    store.claimCanvas(id, requester);
  }
  return state;
}

function emitCanvasChange(
  canvas: SessionState,
  actor: string,
  action: 'write_device' | 'remove_device' | 'rename' | 'delete',
): void {
  getNotificationBus().emit({
    actorChatSessionId: actor,
    ownerChatSessionId: canvas.ownerChatSessionId,
    canvasId: canvas.sessionId,
    canvasDisplayName: displayCanvasName(canvas.name),
    action,
  });
}

function pickDeviceFromArgs(args: Record<string, unknown>, partial = false): DeviceInstance {
  const num = (k: string): number | undefined => {
    const v = args[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const str = (k: string): string | undefined => (typeof args[k] === 'string' ? (args[k] as string) : undefined);
  const base: DeviceInstance = {
    id: String(args.deviceId),
    modelKey: String(args.modelKey),
    xRatio: num('xRatio') ?? 0.5,
    yRatio: num('yRatio') ?? 0.5,
    rotationX: num('rotationX') ?? 0,
    rotationY: num('rotationY') ?? 0,
    rotationZ: num('rotationZ') ?? 0,
    displayScale: num('displayScale') ?? 1,
    isSelected: false,
    highlightColor: str('highlightColor') ?? '#FFFFFF',
  };
  if (partial) {
    // update 模式: 只取 args 里存在的字段
    // 注意: modelKey 不允许 update(会破坏模型绑定),只读,缺失时报错
    const out: Partial<DeviceInstance> & { id: string } = {
      id: base.id,
    };
    if (num('xRatio') !== undefined) out.xRatio = num('xRatio')!;
    if (num('yRatio') !== undefined) out.yRatio = num('yRatio')!;
    if (num('rotationX') !== undefined) out.rotationX = num('rotationX')!;
    if (num('rotationY') !== undefined) out.rotationY = num('rotationY')!;
    if (num('rotationZ') !== undefined) out.rotationZ = num('rotationZ')!;
    if (num('displayScale') !== undefined) out.displayScale = num('displayScale')!;
    if (str('highlightColor')) out.highlightColor = str('highlightColor')!;
    return out as DeviceInstance;
  }
  return base;
}

function summarize(c: SessionState, requester: string) {
  const seq = parseCanvasName(c.name);
  return {
    sessionId: c.sessionId,
    name: c.name,
    displayName: seq > 0 ? String(seq) : c.name,
    description: c.description,
    ownerChatSessionId: c.ownerChatSessionId,
    isOwner: c.ownerChatSessionId === requester,
    isUnowned: c.ownerChatSessionId === null,
    deviceCount: c.devices.length,
    lastUpdated: c.lastUpdated,
    lastAccessedAt: c.lastAccessedBy?.[requester] ?? null,
    visibility: c.visibility,
    bgColor: c.bgColor,
    devices: c.devices,
  };
}

// ─────────────────────────────────────────────────────────────
// 路由注册
// ─────────────────────────────────────────────────────────────
export function registerCanvasToolRoutes(app: import('express').Express): void {
  app.get('/api/canvas/tools', handleListTools);
  app.post('/api/canvas/tools/invoke', handleInvokeTool);
}