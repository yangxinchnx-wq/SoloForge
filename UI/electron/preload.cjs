// ─────────────────────────────────────────────────────────────────
// SoloForge Electron preload
// 在 contextIsolation 开启下通过 contextBridge 把受限能力暴露给渲染层
// 渲染层可通过 window.soloforge 访问
// ─────────────────────────────────────────────────────────────────

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soloforge', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  // 画布相关 IPC（受 contextBridge 沙箱约束，只暴露 invoke 包装）
  canvas: {
    start: (sessionId, width, height) =>
      ipcRenderer.invoke('canvas:start', { sessionId, width, height }),
    resize: (sessionId, width, height) =>
      ipcRenderer.invoke('canvas:resize', { sessionId, width, height }),
    stop: (sessionId) => ipcRenderer.invoke('canvas:stop', { sessionId }),
    push: (sessionId, dsl) => ipcRenderer.invoke('canvas:push', { sessionId, dsl }),
    status: (sessionId) => ipcRenderer.invoke('canvas:status', { sessionId }),
  },
});
