/// <reference types="vite/client" />

/**
 * SoloForge Electron preload 暴露给 renderer 的全局类型
 * 对应 UI/electron/preload.cjs 的 contextBridge.exposeInMainWorld
 */
export {};

interface WindowControlsApi {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  close: () => Promise<void>;
  onMaximizeChanged: (cb: (isMax: boolean) => void) => () => void;
}

interface CanvasApi {
  start: (sessionId: string, width: number, height: number) => Promise<{ ok: boolean; error?: string; session?: any; reused?: boolean }>;
  resize: (sessionId: string, width: number, height: number) => Promise<{ ok: boolean; error?: string }>;
  stop: (sessionId: string) => Promise<{ ok: boolean; notFound?: boolean }>;
  push: (sessionId: string, dsl: any) => Promise<{ ok: boolean; status?: number; body?: string; error?: string }>;
  status: (sessionId: string) => Promise<{ ok: boolean; active: boolean; info?: any }>;
  reportBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<{ ok: boolean; error?: string }>;
  hostInfo: () => Promise<{ ok: boolean; created?: boolean; bounds: { x: number; y: number; width: number; height: number } }>;
  ensureHost: () => Promise<{ ok: boolean; created?: boolean; hwnd?: number; bounds?: any; error?: string }>;
  pushUI: (sessionId: string, dsl: any, deviceId?: string | null) => Promise<{ ok: boolean; error?: string }>;
  selectDevice: (sessionId: string, modelKey: string, file: string, nativeSize: { w: number; h: number }) => Promise<{ ok: boolean; error?: string }>;
  setHostVisible: (visible: boolean) => Promise<{ ok: boolean; error?: string }>;
  openDevicePopup: (payload: {
    x: number; y: number; width: number; height: number;
    renderMode: string; currentKey: string; currentLabel?: string; deviceCount: number;
    groups: Array<{ label: string; items: Array<{ key: string; label: string; w: number; h: number; group: string }> }>;
    theme: { surface: string; surfaceBright: string; primary: string; onSurface: string; outline: string };
  }) => Promise<{ ok: boolean; error?: string }>;
  closeDevicePopup: () => Promise<{ ok: boolean }>;
  onDeviceSelected: (callback: (data: { key: string; glbFile?: string }) => void) => () => void;
  transformDevice: (sessionId: string, deviceId: string, transform: any) => Promise<{ ok: boolean; error?: string }>;
  clearDevices: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  setBackground: (sessionId: string, color: string) => Promise<{ ok: boolean; error?: string }>;
  screenshot: (sessionId: string) => Promise<{ ok: boolean; dataUrl?: string; width?: number; height?: number; error?: string }>;
  getDeviceConfig: () => Promise<{ ok: boolean; config?: any; modelsDir?: string }>;
  listModels: () => Promise<{ ok: boolean; models?: any[] }>;
  embedStatus: (sessionId: string) => Promise<{ ok: boolean; sessionId?: string; embedded?: boolean; hwnd?: number; pid?: number; width?: number; height?: number; error?: string }>;
  onExited: (callback: (info: CanvasExitedInfo) => void) => () => void;
}

/** main.cjs child.on('exit') 推送的画布退出信息 */
interface CanvasExitedInfo {
  sessionId: string;
  exitCode: number | null;
  signal: string | null;
  isCrash: boolean;
  stderr: string;
  message: string;
}

interface AgentApi {
  on: (eventType: string, callback: (msg: unknown) => void) => () => void;
  dispatch: (payload: unknown) => Promise<any>;
  dispute: (payload: unknown) => Promise<any>;
  snapshot: () => Promise<any>;
  bridgeStatus: () => Promise<any>;
}

interface AiApi {
  chat: (req: unknown, onEvent: (msg: any) => void) => {
    taskId: string;
    abort: () => void;
    unsubscribe: () => void;
  };
  chatViaPort: (req: unknown) => Promise<{
    taskId: string;
    port: MessagePort;
    abort: () => void;
  }>;
  abort: (taskId: string) => Promise<void>;
}

/** 本地 LLM 流式聊天返回的流对象 */
interface LocalLLMChatStream {
  streamId: string;
  onToken: (cb: (token: string) => void) => () => void;
  onDone: (cb: () => void) => () => void;
  onError: (cb: (err: string) => void) => () => void;
  start: () => Promise<void>;
  abort: () => Promise<{ ok: boolean }>;
}

interface LocalLLMApi {
  list: () => Promise<{ ok: boolean; models: any[] }>;
  add: (path: string) => Promise<{ ok: boolean; error?: string; model?: any }>;
  remove: (path: string) => Promise<{ ok: boolean }>;
  delete: (path: string) => Promise<{ ok: boolean; error?: string }>;
  browse: () => Promise<{ ok: boolean; canceled?: boolean; path?: string }>;
  load: (path: string, params: { n_ctx: number; n_threads: number; n_gpu_layers: number }) => Promise<{ ok: boolean; error?: string; model_name?: string }>;
  unload: () => Promise<{ ok: boolean }>;
  status: () => Promise<any>;
  device: () => Promise<any>;
  metrics: () => Promise<any>;
  startServer: () => Promise<{ ok: boolean; error?: string }>;
  stopServer: () => Promise<{ ok: boolean }>;
  serverRunning: () => Promise<{ running: boolean }>;
  chat: (text: string, params: {
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    repeat_penalty?: number;
  }) => LocalLLMChatStream;
  chatReset: () => Promise<{ ok: boolean }>;
}

interface SoloForgeApi {
  platform: NodeJS.Platform;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  canvas: CanvasApi;
  agent: AgentApi;
  ai: AiApi;
  controls: WindowControlsApi;
  localLLM: LocalLLMApi;
}

declare global {
  interface Window {
    soloforge?: SoloForgeApi;
  }
}
