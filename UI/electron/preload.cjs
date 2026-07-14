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
  // ── 2026-07-14: 手动重载 (HMR 已禁用, 渲染层可调用此方法触发完整页面重载) ──
  reload: () => ipcRenderer.invoke('app:reload'),
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
    // ★ 新增: 确保画布宿主窗口存在
    ensureHost: () => ipcRenderer.invoke('canvas:ensure-host'),
    // ★ 新增: pushUI — 推送 UI DSL (带 deviceId 关联)
    pushUI: (sessionId, dsl, deviceId) =>
      ipcRenderer.invoke('canvas:push-ui', { sessionId, dsl, deviceId }),
    // ★ 新增: selectDevice — 加载 3D 设备模型到画布 (POST /render)
    selectDevice: (sessionId, modelKey, file, nativeSize) =>
      ipcRenderer.invoke('canvas:select-device', { sessionId, modelKey, file, nativeSize }),
    // ★ 新增: setHostVisible — 显示/隐藏画布宿主窗口 (下拉框打开时隐藏)
    setHostVisible: (visible) =>
      ipcRenderer.invoke('canvas:set-host-visible', { visible }),
    // ★ 新增: openDevicePopup — 打开设备选择弹窗 (独立 BrowserWindow, 不被 Flutter 遮挡)
    openDevicePopup: (x, y, items, activeKey) =>
      ipcRenderer.invoke('canvas:open-device-popup', { x, y, items, activeKey }),
    // ★ 新增: closeDevicePopup — 关闭设备选择弹窗
    closeDevicePopup: () =>
      ipcRenderer.invoke('canvas:close-device-popup'),
    // ★ 新增: onDeviceSelected — 监听设备选择事件
    onDeviceSelected: (callback) => {
      const handler = (_e, data) => callback(data);
      ipcRenderer.on('canvas:device-selected', handler);
      return () => ipcRenderer.removeListener('canvas:device-selected', handler);
    },
    // ★ 新增: transformDevice — 拖拽/旋转/缩放 3D 设备
    transformDevice: (sessionId, deviceId, transform) =>
      ipcRenderer.invoke('canvas:transform-device', { sessionId, deviceId, transform }),
    // ★ 新增: clearDevices — 清除画布上所有 3D 设备
    clearDevices: (sessionId) =>
      ipcRenderer.invoke('canvas:clear-devices', { sessionId }),
    // ★ 新增: setBackground — 设置画布背景色
    setBackground: (sessionId, color) =>
      ipcRenderer.invoke('canvas:set-background', { sessionId, color }),
    // ★ 新增: screenshot — 截图画布
    screenshot: (sessionId) =>
      ipcRenderer.invoke('canvas:screenshot', { sessionId }),
    // ★ 新增: getDeviceConfig — 获取设备配置
    getDeviceConfig: () =>
      ipcRenderer.invoke('canvas:get-device-config'),
    // ★ 新增: listModels — 列出所有可用模型
    listModels: () =>
      ipcRenderer.invoke('canvas:list-models'),
    // ★ 新增: embedStatus — 查询画布嵌入状态
    embedStatus: (sessionId) =>
      ipcRenderer.invoke('canvas:embed-status', { sessionId }),
    // ★ 画布进程退出事件 (崩溃 / 正常退出), 由 main.cjs 的 child.on('exit') 推送
    //   回调参数: { sessionId, exitCode, signal, isCrash, stderr, message }
    //   返回取消订阅函数
    onExited: (callback) => {
      const handler = (_e, info) => callback(info);
      ipcRenderer.on('canvas:exited', handler);
      return () => ipcRenderer.removeListener('canvas:exited', handler);
    },
  },
  // ── 2026 自定义窗口控件(替代 Electron 的 titleBarOverlay,因为 Windows 11 22H2+ DWM 暗 tint) ──
  // 由 UI/src/components/WindowControls.tsx 调用
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    restore: () => ipcRenderer.invoke('window:restore'),
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
  // ── 文件夹选择器 (用于工作区绑定) ──
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  // ── 递归读取目录树 (用于工作区文件树恢复) ──
  readDirTree: (dirPath) => ipcRenderer.invoke('fs:read-dir-tree', { dirPath }),
  // 旧 API 保留作为 fallback (调试/特殊场景)
  moveWindow: (x, y) => ipcRenderer.invoke('window:move-to', { x, y }),
  getWindowBounds: () => ipcRenderer.invoke('window:get-bounds'),
  // ── 网络代理（四模式：system/direct/manual/pac） ──
  proxy: {
    getConfig:      ()  => ipcRenderer.invoke('proxy:get-config'),
    apply:          (c) => ipcRenderer.invoke('proxy:apply', c),
    testConnection: ()  => ipcRenderer.invoke('proxy:test'),
    getSystemInfo:  ()  => ipcRenderer.invoke('proxy:system-info'),
  },
  // ── 本地 LLM 管理 ──
  localLLM: {
    // 模型列表 CRUD
    list:        ()         => ipcRenderer.invoke('local-llm:list'),
    add:         (modelPath) => ipcRenderer.invoke('local-llm:add', { path: modelPath }),
    remove:      (modelPath) => ipcRenderer.invoke('local-llm:remove', { path: modelPath }),
    delete:      (modelPath) => ipcRenderer.invoke('local-llm:delete', { path: modelPath }),
    browse:      ()         => ipcRenderer.invoke('local-llm:browse'),
    // 模型加载/卸载
    load:        (modelPath, params) => ipcRenderer.invoke('local-llm:load', { path: modelPath, params }),
    unload:      ()         => ipcRenderer.invoke('local-llm:unload'),
    // 状态查询
    status:      ()         => ipcRenderer.invoke('local-llm:status'),
    device:      ()         => ipcRenderer.invoke('local-llm:device'),
    metrics:     ()         => ipcRenderer.invoke('local-llm:metrics'),
    // 服务管理
    startServer: ()         => ipcRenderer.invoke('local-llm:start-server'),
    stopServer:  ()         => ipcRenderer.invoke('local-llm:stop-server'),
    serverRunning: ()       => ipcRenderer.invoke('local-llm:server-running'),
    serverUrl:   ()         => ipcRenderer.invoke('local-llm:server-url'),
  },
});
