const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  console.log('app.isPackaged =', app.isPackaged);
  console.log('app.getAppPath() =', app.getAppPath());
  console.log('process.defaultApp =', process.defaultApp);
  console.log('NODE_ENV =', process.env.NODE_ENV);

  // 试着创建一个最简单的窗口
  const w = new BrowserWindow({ width: 600, height: 400, show: true });
  w.loadURL('data:text/html,<h1>HELLO from Electron, isPackaged=' + (app.isPackaged ? 'true' : 'false') + '</h1>');
  setTimeout(() => app.quit(), 3000);
});