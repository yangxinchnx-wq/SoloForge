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
  start: (sessionId: string, width: number, height: number) => Promise<any>;
  resize: (sessionId: string, width: number, height: number) => Promise<any>;
  stop: (sessionId: string) => Promise<any>;
  push: (sessionId: string, dsl: unknown) => Promise<any>;
  status: (sessionId: string) => Promise<any>;
  reportBounds: (bounds: unknown) => Promise<any>;
  hostInfo: () => Promise<any>;
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
}

declare global {
  interface Window {
    soloforge?: SoloForgeApi;
  }
}
