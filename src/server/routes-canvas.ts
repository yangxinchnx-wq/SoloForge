// ────────────────────────────────────────────────────────────
// SoloForge Canvas Relay Routes
// Path: src/server/routes-canvas.ts
// Description: 画布中转端点 — 让 Java Agent / 外部进程能推送 DSL 到 Flutter canvas
//
// 设计背景 (2026-07-09):
//   - Flutter canvas 端口由 Electron 主进程动态分配 (startCanvas)
//   - Java Agent (8770) 和 Node.js (3001) 都不能直接知道端口
//   - Electron 主进程在 startCanvas 成功后, 主动 HTTP POST 注册端口到 Node.js
//   - Java Agent 调 canvas_push_ui → POST /api/canvas/relay/push-ui → Node.js 查端口表 → 转发到 Flutter /render
//
// 端口注册表:
//   Map<sessionId, { port, pid, hwnd, registeredAt }>
//   存活期: Electron 主进程在画布停止时调 unregister-port
//   容错: Node.js 进程重启后表清空, 下次 Electron 心跳会重新注册 (见 register-port 的 alive 字段)
//
// 协议转换:
//   Java Agent 发送: { sessionId, dsl: {...AST...}, language: "typescript" }
//   Node.js 转换为 Flutter 期望的格式: { type: "render", ui: {...AST...}, platform: "material" }
//   Flutter main.dart _handleMessage 解析 ui 字段 → UiParser.parse → PlatformRenderer.build
// ────────────────────────────────────────────────────────────

import type { ApiResponse } from './types';
import { logger } from '../core/logger';

/** 画布端口注册表 (sessionId → 端口信息) */
interface CanvasPortInfo {
  sessionId: string;
  port: number;
  pid: number;
  hwnd?: number;
  registeredAt: number;
}

const canvasPortRegistry = new Map<string, CanvasPortInfo>();

/**
 * GET /api/canvas/relay/ports — 查询所有已注册的画布端口 (调试用)
 */
export function handleCanvasPortList(): ApiResponse {
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: {
      success: true,
      count: canvasPortRegistry.size,
      ports: Array.from(canvasPortRegistry.values()),
    },
  };
}

/**
 * POST /api/canvas/relay/register-port — Electron 主进程注册画布端口
 *
 * body: { sessionId, port, pid, hwnd? }
 *
 * 调用时机:
 *   - startCanvas 成功后立即调用 (见 main.cjs startCanvas 末尾)
 *   - 画布看门狗心跳时也可调用 (刷新 registeredAt)
 */
export function handleCanvasPortRegister(body: any): ApiResponse {
  if (!body || typeof body !== 'object') {
    return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { success: false, error: 'invalid body' } };
  }
  const { sessionId, port, pid, hwnd } = body;
  if (!sessionId || typeof port !== 'number' || typeof pid !== 'number') {
    return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { success: false, error: 'missing required fields: sessionId, port, pid' } };
  }

  canvasPortRegistry.set(String(sessionId), {
    sessionId: String(sessionId),
    port,
    pid,
    hwnd: typeof hwnd === 'number' ? hwnd : undefined,
    registeredAt: Date.now(),
  });

  logger.info('canvas-relay', `registered port ${port} for sessionId=${sessionId} (pid=${pid})`);
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: { success: true, sessionId, port, totalRegistered: canvasPortRegistry.size },
  };
}

/**
 * POST /api/canvas/relay/unregister-port — Electron 主进程注销画布端口
 *
 * body: { sessionId }
 */
export function handleCanvasPortUnregister(body: any): ApiResponse {
  if (!body || typeof body !== 'object') {
    return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { success: false, error: 'invalid body' } };
  }
  const sessionId = String(body.sessionId || '');
  if (!sessionId) {
    return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { success: false, error: 'missing sessionId' } };
  }

  const existed = canvasPortRegistry.delete(sessionId);
  logger.info('canvas-relay', `unregistered sessionId=${sessionId} (existed=${existed})`);
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: { success: true, sessionId, wasRegistered: existed, remaining: canvasPortRegistry.size },
  };
}

/**
 * POST /api/canvas/relay/push-ui — Java Agent 推送 DSL 到画布
 *
 * body: { sessionId, dsl: {...AST...}, language: "typescript" }
 *
 * 链路:
 *   1. 从 canvasPortRegistry 查 sessionId 对应的 Flutter 端口
 *   2. 若找不到, 尝试用任意已注册端口 (降级, 适用于单画布场景)
 *   3. 转换协议为 Flutter 期望的 { type: "render", ui: {...}, platform: "material" }
 *   4. HTTP POST 到 Flutter http://127.0.0.1:{port}/render
 *   5. 返回 Flutter 的响应
 */
export async function handleCanvasRelayPushUi(body: any): Promise<ApiResponse> {
  if (!body || typeof body !== 'object') {
    return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { success: false, error: 'invalid body' } };
  }

  const sessionId = String(body.sessionId || '');
  const dsl = body.dsl;
  const language = String(body.language || 'typescript');

  if (!sessionId) {
    return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { success: false, error: 'missing sessionId' } };
  }
  if (!dsl || typeof dsl !== 'object') {
    return { status: 400, headers: { 'Content-Type': 'application/json' }, body: { success: false, error: 'missing or invalid dsl (expected object)' } };
  }

  // 1. 查端口 — 优先精确匹配 sessionId
  let portInfo = canvasPortRegistry.get(sessionId);
  if (!portInfo) {
    // 降级: 取任意一个已注册的画布 (适用于单画布场景, 或 sessionId 不匹配时)
    const anyEntry = canvasPortRegistry.values().next();
    if (!anyEntry.done) {
      portInfo = anyEntry.value;
      logger.warn('canvas-relay', `sessionId=${sessionId} not in registry, falling back to port ${portInfo.port} (sessionId=${portInfo.sessionId})`);
    }
  }

  if (!portInfo) {
    logger.warn('canvas-relay', `no canvas registered, cannot push UI. sessionId=${sessionId}`);
    return {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
      body: {
        success: false,
        error: 'no canvas process registered. Start a canvas in the Electron UI first.',
        hint: 'Electron 主进程需要在画布启动时调 POST /api/canvas/relay/register-port 注册端口',
      },
    };
  }

  // 2. 协议转换 — Java Agent 发 {dsl} → Flutter 期望 {type:"render", ui:{...}}
  //    Flutter main.dart _handleMessage 兼容两种格式:
  //      a) {platform:"material", ui:{...}} — 透传
  //      b) {type:"render", ui:{...}} — 透传 ui 字段
  //    采用 (b) 形式, 与 Electron pushCanvasDSL 保持一致 (见 main.cjs:679)
  const flutterPayload = {
    type: 'render',
    ui: dsl,
    platform: 'material',
    language, // Flutter 当前忽略此字段, 但保留以便未来扩展 (代码高亮等)
  };

  const payloadStr = JSON.stringify(flutterPayload);

  // 3. HTTP POST 到 Flutter /render
  try {
    const flutterUrl = `http://127.0.0.1:${portInfo.port}/render`;
    const flutterRes = await fetch(flutterUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payloadStr)) },
      body: payloadStr,
    });

    const flutterBody = await flutterRes.text().catch(() => '');

    if (!flutterRes.ok) {
      logger.warn('canvas-relay', `Flutter /render returned ${flutterRes.status}: ${flutterBody}`);
      return {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
        body: {
          success: false,
          error: `Flutter /render failed: HTTP ${flutterRes.status}`,
          flutterResponse: flutterBody,
          port: portInfo.port,
        },
      };
    }

    logger.info('canvas-relay', `pushed UI to canvas sessionId=${sessionId} port=${portInfo.port} dslBytes=${payloadStr.length}`);
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        success: true,
        sessionId,
        port: portInfo.port,
        dslBytes: payloadStr.length,
        flutterResponse: flutterBody || '{"ok":true}',
      },
    };
  } catch (err: any) {
    logger.error('canvas-relay', `failed to reach Flutter canvas at port ${portInfo.port}: ${err.message}`);
    // 画布可能已挂掉, 清理注册表 (Electron 看门狗会重启并重新注册)
    canvasPortRegistry.delete(portInfo.sessionId);
    return {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
      body: {
        success: false,
        error: `failed to reach Flutter canvas: ${err.message}`,
        port: portInfo.port,
        hint: '画布进程可能已退出, 请在 Electron UI 重新启动画布',
      },
    };
  }
}
