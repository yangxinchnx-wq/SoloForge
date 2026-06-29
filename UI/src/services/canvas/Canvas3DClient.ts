/**
 * Canvas 3D 客户端
 * 与 Flutter canvas 进程通信的薄封装
 *
 * 通信协议 (HTTP, 端口由 Electron 主进程分配):
 *   POST /render        - 渲染 UI DSL (走 /render, action 字段区分)
 *   POST /transform     - 更新 3D 设备 transform (高频, 独立端点)
 *   POST /push-ui       - 显式推送 UI 内容
 *   POST /clear-devices - 清除 3D 设备
 *
 * 全部用 POST JSON, 响应 { ok: boolean, error?: string }
 */

import type { DeviceInstance } from './types';

export interface CanvasActionResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export class Canvas3DClient {
  private port: number;
  private baseUrl: string;

  constructor(port: number) {
    this.port = port;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  /**
   * 选择一个设备 (切换到 3D 模式 + 加载对应设备模型)
   */
  async selectDevice(
    modelKey: string,
    deviceConfig: {
      file: string;
      nativeSize: { w: number; h: number };
    }
  ): Promise<CanvasActionResponse> {
    return this._post('/render', {
      action: 'selectDevice',
      modelKey,
      file: deviceConfig.file,
      nativeSize: deviceConfig.nativeSize,
    });
  }

  /**
   * 推送 DSL UI 内容 (渲染到设备屏幕)
   *
   * 走 /push-ui 端点 (与 /render 分离, 方便后端区分 action 类型)
   * s3.2c: 支持 deviceId 参数 — 多 session 设备独立 UI
   *   - deviceId 有值: 只渲染到该设备的屏幕
   *   - deviceId 无值: 渲染到所有设备屏幕 (共享 UI, 向后兼容)
   */
  async pushUI(sessionId: string, dsl: unknown, deviceId?: string): Promise<CanvasActionResponse> {
    return this._post('/push-ui', {
      action: 'pushUI',
      sessionId,
      dsl,
      deviceId: deviceId ?? null,
    });
  }

  // ─────────────────────────────────────────────────────────
  // 流式 Universal AST（s4.0 新增）
  //
  // 设计原则：
  //   - 复用现有 /push-ui 端点（与 pushUI 一致，零协议破坏）
  //   - action 字段区分：pushUI / feedASTChunk / flushAST
  //   - 旧调用方无感；新调用方按 streaming 模式喂 chunk
  //   - Flutter 端收到 feedASTChunk 时只更新内部 AST 树，不重绘整帧
  //   - flushAST 触发最终重绘 + 校验
  // ─────────────────────────────────────────────────────────

  /**
   * 喂一个 AST chunk 到 Flutter
   * @param partialAst 半成品 UniversalNode（半截 JSON 解析出来的）
   * @param isPartial true=继续喂，false=这是最后一块
   */
  async feedASTChunk(
    sessionId: string,
    partialAst: unknown,
    options: { deviceId?: string; isPartial?: boolean; language?: string } = {},
  ): Promise<CanvasActionResponse> {
    return this._post('/push-ui', {
      action: 'feedASTChunk',
      sessionId,
      partialAst,
      deviceId: options.deviceId ?? null,
      isPartial: options.isPartial ?? true,
      language: options.language ?? null,
    });
  }

  /**
   * 标记流结束，触发 Flutter 端最终校验 + 渲染
   */
  async flushAST(sessionId: string, deviceId?: string): Promise<CanvasActionResponse> {
    return this._post('/push-ui', {
      action: 'flushAST',
      sessionId,
      deviceId: deviceId ?? null,
    });
  }

  /**
   * 一站式便捷接口：一次性把完整 PreviewPayload 推到 Flutter
   * 内部等价于 feedASTChunk(isPartial=false) + flushAST
   */
  async pushUniversalPreview(
    sessionId: string,
    payload: { language: string; preview: { root: unknown; notes?: string }; source_code: string },
    deviceId?: string,
  ): Promise<CanvasActionResponse> {
    return this._post('/push-ui', {
      action: 'pushUI',
      sessionId,
      dsl: payload.preview.root,
      deviceId: deviceId ?? null,
      language: payload.language,
      sourceCode: payload.source_code,
    });
  }

  /**
   * 更新设备 transform (位置/旋转/缩放)
   *
   * 走 /transform 端点, 这是拖动场景的高频路径。
   * 后端可针对性优化 (跳过 ui parse, 直接改 scene graph)
   */
  async transformDevice(
    sessionId: string,
    deviceId: string,
    transform: Partial<DeviceInstance>
  ): Promise<CanvasActionResponse> {
    return this._post('/transform', {
      action: 'transformDevice',
      sessionId,
      deviceId,
      transform,
    });
  }

  /**
   * 清除所有 3D 设备, 回到 2D 模式
   */
  async clearDevices(sessionId: string): Promise<CanvasActionResponse> {
    return this._post('/clear-devices', {
      action: 'clearDevices',
      sessionId,
    });
  }

  /**
   * 内部 POST 助手
   */
  private async _post(path: string, body: unknown): Promise<CanvasActionResponse> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * 内部 GET 助手
   */
  private async _get<T = Record<string, unknown>>(path: string): Promise<T> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { method: 'GET' });
      return await res.json();
    } catch (e) {
      return { ok: false, error: (e as Error).message } as unknown as T;
    }
  }

  /**
   * s1.6: 获取 device-config.json 校验结果
   *
   * 返回 { configCount, errorCount, errors: [{modelKey, field, reason}] }
   * canvas 启动时已经跑过 loadAllDetailed, 这里直接读缓存即可
   */
  async getValidation(): Promise<DeviceConfigValidation> {
    try {
      const res = await fetch(`${this.baseUrl}/api/canvas/devices/validation`, {
        method: 'GET',
      });
      const data = await res.json();
      if (!data.ok) {
        return { configCount: 0, errorCount: 0, errors: [], checkedAt: 0, error: data.error };
      }
      return {
        configCount: data.configCount,
        errorCount: data.errorCount,
        errors: data.errors || [],
        checkedAt: data.checkedAt,
      };
    } catch (e) {
      return {
        configCount: 0,
        errorCount: 0,
        errors: [],
        checkedAt: 0,
        error: (e as Error).message,
      };
    }
  }

  /**
   * s1.6: 强制重载 device-config.json (改了文件后调一次)
   */
  async reloadConfigs(): Promise<{ ok: boolean; configCount?: number; errorCount?: number; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/canvas/devices/reload`, {
        method: 'POST',
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * s3.2a: 列出 Flutter 主窗口里所有有 RTT 能力的 device
   *
   * 用途: React 端确认哪些 device 屏幕"准备好被截图推 RTT"
   * 返回:
   *   - count: 设备数
   *   - devices: device.id 列表
   *   - rttPipelineReady: 端点通道就位
   *   - rttCaptureLoopRunning: 是否真在每帧截图 (s3.2a 暂 false, s3.2b 接入)
   */
  async listDeviceScreens(): Promise<{
    ok: boolean;
    count?: number;
    devices?: string[];
    rttPipelineReady?: boolean;
    rttCaptureLoopRunning?: boolean;
    rttCaptureLoopHint?: string;
    checkedAt?: number;
    error?: string;
  }> {
    return this._get('/api/canvas/rtt/devices');
  }

  // ─────────────────────────────────────────────────────────
  // s1.8: RTT (Render-To-Texture) 事件通道
  //
  // 这 4 个方法覆盖 s2.1 / s3.2 需要的最小通道:
  //   pushRttTexture   - renderer 把截图推给 main (存到 _rttTextures)
  //   getRttTexture    - three_d 渲染循环从 main 取最新一帧
  //   pushRttInput     - 屏内 tap/pan 事件推给 main
  //   drainRttInputs   - 外部拉取并清空输入队列
  // s1.8 阶段这些方法只是通道, 不会被实际调用, 但 API 锁定后 s2.1/s3.2 可以直接接
  // ─────────────────────────────────────────────────────────

  /**
   * s1.8: 推送 RTT 纹理 (base64 PNG) 到 main
   *
   * @param sessionId  当前会话
   * @param deviceId   目标设备
   * @param pngBase64  PNG 字节的 base64 编码 (不含 data:image/png;base64, 前缀)
   * @param width      纹理宽度 (像素)
   * @param height     纹理高度 (像素)
   */
  async pushRttTexture(
    sessionId: string,
    deviceId: string,
    pngBase64: string,
    width: number,
    height: number,
  ): Promise<RttPushResult> {
    return this._post('/api/canvas/rtt/texture', {
      sessionId,
      deviceId,
      png: pngBase64,
      width,
      height,
      timestamp: Date.now(),
    }) as Promise<RttPushResult>;
  }

  /**
   * s1.8: 查询 RTT 纹理
   *
   * @returns { ok, png, byteLength, ... } or { ok: false, error } (404 if not cached)
   */
  async getRttTexture(sessionId: string, deviceId: string): Promise<RttTextureResult> {
    try {
      const res = await fetch(`${this.baseUrl}/api/canvas/rtt/texture/${encodeURIComponent(sessionId)}/${encodeURIComponent(deviceId)}`);
      return await res.json();
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * s1.8: 推送屏内输入事件
   *
   * u/v 是设备屏幕本地坐标 (0~1), 不是 canvas 坐标.
   * renderer 在 three_d 命中测试时把 hit point 转换为 UV, 再调这个.
   */
  async pushRttInput(event: RttInputEventPayload): Promise<{ ok: boolean; queueSize?: number; error?: string }> {
    return this._post('/api/canvas/rtt/input', event) as Promise<{ ok: boolean; queueSize?: number; error?: string }>;
  }

  /**
   * s1.8: 拉取并清空输入事件队列
   *
   * 可选按 sessionId/deviceId 过滤. 返回后 main 端队列清空.
   * 典型调用: React 端每帧 (16ms) 拉一次, 处理完 UI 交互.
   */
  async drainRttInputs(filter?: { sessionId?: string; deviceId?: string }): Promise<RttInputDrainResult> {
    try {
      const qs = new URLSearchParams();
      if (filter?.sessionId) qs.set('sessionId', filter.sessionId);
      if (filter?.deviceId) qs.set('deviceId', filter.deviceId);
      const url = `${this.baseUrl}/api/canvas/rtt/input${qs.toString() ? '?' + qs : ''}`;
      const res = await fetch(url);
      return await res.json();
    } catch (e) {
      return { ok: false, count: 0, events: [], error: (e as Error).message };
    }
  }
}

export interface DeviceConfigValidation {
  configCount: number;
  errorCount: number;
  errors: Array<{ modelKey: string; field: string; reason: string }>;
  checkedAt: number;
  error?: string;
}

// s1.8: RTT 类型
export interface RttPushResult {
  ok: boolean;
  sessionId?: string;
  deviceId?: string;
  byteLength?: number;
  storedAt?: number;
  error?: string;
}

export interface RttTextureResult {
  ok: boolean;
  sessionId?: string;
  deviceId?: string;
  png?: string;
  byteLength?: number;
  fetchedAt?: number;
  error?: string;
  hint?: string;
}

export type RttInputType = 'tap' | 'doubleTap' | 'longPress' | 'panStart' | 'panMove' | 'panEnd';

export interface RttInputEventPayload {
  sessionId: string;
  deviceId: string;
  type: RttInputType;
  u: number;       // 0~1 屏幕 u 坐标
  v: number;       // 0~1 屏幕 v 坐标 (UV 坐标系, 上=0)
  timestamp?: number;
}

export interface RttInputEventRecord extends RttInputEventPayload {
  timestamp: number;
}

export interface RttInputDrainResult {
  ok: boolean;
  count: number;
  events: RttInputEventRecord[];
  drainedAt?: number;
  error?: string;
}
