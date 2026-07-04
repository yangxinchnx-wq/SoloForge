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
  // 2026-07-02 绝对坐标模式: renderer 算好最终 x/y/width/height 直接发, main 端无状态
  resizeWindow: (x, y, width, height) =>
    ipcRenderer.invoke('window:resize-to', { x, y, width, height }),
  // ── 2026 自定义窗口拖动(替代 -webkit-app-region: drag,消除 Win11 snap layout tooltip) ──
  // 由 UI/src/components/Header.tsx 的 onMouseDown 调
  // 2026-07-04 主进程轮询模式 (根治 mousemove 事件风暴 + 卡死)
  //   - renderer mousedown 时一次 IPC drag-start, mouseup 时一次 IPC drag-stop
  //   - 主进程用 setInterval(16ms) 自己读 screen.getCursorScreenPoint() + setPosition
  //   - 完全绕开渲染器 mousemove 事件 + 跨进程 IPC 往返
  dragStart: () => ipcRenderer.invoke('window:drag-start'),
  dragStop: () => ipcRenderer.invoke('window:drag-stop'),
  // 主进程在 drag-start/stop 时推送给渲染器, 让 CSS 临时禁用 backdrop-filter
  onDragState: (callback) => {
    const handler = (_e, isDragging) => callback(isDragging);
    ipcRenderer.on('drag-state', handler);
    return () => ipcRenderer.removeListener('drag-state', handler);
  },
  // 旧 API 保留作为 fallback (调试/特殊场景)
  moveWindow: (x, y) => ipcRenderer.invoke('window:move-to', { x, y }),
  getWindowBounds: () => ipcRenderer.invoke('window:get-bounds'),
});
