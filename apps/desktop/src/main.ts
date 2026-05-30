// 简化的 Electron 测试
const { app, BrowserWindow } = require('electron');
const path = require('path');

console.log('[Test] Electron 版本测试');
console.log('[Test] process.versions:', process.versions);

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // 加载一个简单的 HTML
  win.loadURL('data:text/html,<h1>SoloForge Electron Works!</h1><p>如果看到这个，说明 Electron 运行正常。</p>');

  console.log('[Test] 窗口已创建');
}

app.whenReady().then(() => {
  console.log('[Test] App ready');
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
