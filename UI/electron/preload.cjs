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
    reportBounds: (bounds) => ipcRenderer.invoke('canvas:report-bounds', bounds),
    hostInfo: () => ipcRenderer.invoke('canvas:host-info'),
  },
  // ── 2026 自定义窗口控件(替代 Electron 的 titleBarOverlay,因为 Windows 11 22H2+ DWM 暗 tint) ──
  // 由 UI/src/components/WindowControls.tsx 调用
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizeStateChange: (callback) => {
      const handler = (_e, isMax) => callback(isMax);
      ipcRenderer.on('window:maximize-state-changed', handler);
      // 订阅一次,main 端开始向该 renderer 推送
      ipcRenderer.invoke('window:maximize-state').catch(() => {});
      return () => ipcRenderer.removeListener('window:maximize-state-changed', handler);
    },
  },
  // ── 2026 自定义 resize 边框(替代 frame:true 的 OS 边框,消除 Windows resize 时的白色 sizing box) ──
  // 由 UI/src/components/EdgeResize.tsx 调用
  // edge: 'n'|'s'|'e'|'w'|'ne'|'nw'|'se'|'sw'; deltaX/deltaY: 本次相对上次的鼠标位移(像素)
  resizeWindow: (edge, deltaX, deltaY) =>
    ipcRenderer.invoke('window:resize-by', { edge, deltaX, deltaY }),
  // ── 2026 自定义窗口拖动(替代 -webkit-app-region: drag,消除 Win11 snap layout tooltip) ──
  // 由 UI/src/components/Header.tsx 的 onMouseDown 调
  // deltaX/deltaY: 本次相对上次的鼠标位移(像素)
  moveWindow: (deltaX, deltaY) => ipcRenderer.invoke('window:move-by', { deltaX, deltaY }),
  // ── 2026 设置持久化(通过主进程 settingsStorage.cjs 写入磁盘) ──
  // 由 UI/src/state/settings/adapters/electronStore.ts 调用
  settings: {
    readStore: (args) => ipcRenderer.invoke('settings:read-store', args),
    writeStore: (args) => ipcRenderer.invoke('settings:write-store', args),
    deleteStoreKey: (args) => ipcRenderer.invoke('settings:delete-store-key', args),
  },
});
