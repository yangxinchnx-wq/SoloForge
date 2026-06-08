// ─────────────────────────────────────────────────────────────────
// SoloForge Electron preload
// 在 contextIsolation 开启下通过 contextBridge 把受限能力暴露给渲染层
// 渲染层可通过 window.soloforge 访问
// ─────────────────────────────────────────────────────────────────

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('soloforge', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  // 后续可在此挂载：
  //   - 通过 ipcRenderer.invoke('xxx') 调用后端（读文件、保存配置等）
  //   - 通过 ipcRenderer.on('event', ...) 订阅主进程推送
  // 现阶段只暴露环境元信息，避免暴露面过大
});
