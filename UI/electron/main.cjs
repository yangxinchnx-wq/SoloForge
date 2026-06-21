// ─────────────────────────────────────────────────────────────────
// SoloForge Electron 主进程
// 入口：package.json "main" 指向本文件
// 加载 UI/ 前端（开发态 = UI/server.ts，端口 3000；生产态 = vite build 产物）
// 原 SoloForge 后端（tsx src/index.ts，端口 3001）需独立启动，不由本进程拉起
// ─────────────────────────────────────────────────────────────────

const { app, BrowserWindow, shell, Menu, session } = require('electron');
const path = require('path');

// 2026 改造：UI server.ts 在 3000 端口（含 Vite middleware + Gemini 代理）
// 原 SoloForge 后端在 3001 端口（SurrealDB/Garnet/AI 社会系统）
// 当前阶段：UI 全部走 3000 提供的 /api/*；3001 处于备用 / 未来集成
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:3000';
const BACKEND_URL = process.env.SOLOFORGE_BACKEND_URL || 'http://localhost:3001';
// isDev 必须在 app.whenReady 之后才能拿到（app.isPackaged 在主进程才注入）
let isDev = false;

let mainWindow = null;

// ── API 中间人网关 ──
// 纯透传：拦截 UI 发的 /metrics/* /ui/*，把目标从 3000 重写到 3001（原后端）
// 保留 /api/* 不重写（由 UI/server.ts 自身 Express 提供，优先级最高）
// 未来如需让 UI 调原后端 Agent/Kernel，把 /api/agent/* 改成 /agent/* 然后加入 patterns
// headers / body / method / SSE / 任何字段都不动，只改 URL
function setupApiProxy() {
  const urlFromBase = new URL(DEV_URL);
  const urlToBase = new URL(BACKEND_URL);
  const fromBase = `${urlFromBase.protocol}//${urlFromBase.host}`;
  const toBase = `${urlToBase.protocol}//${urlToBase.host}`;
  if (fromBase === toBase) return; // 3000 和 3001 是同源，不需中间人

  // 匹配模式：
  //   /metrics/* — 代理到 3001 原后端的 Prometheus 指标
  //   /ui/*      — 代理到 3001 原后端的管理 UI（src/ui/index.html）
  // 注：/api/* 当前完全由 UI/server.ts 提供，不在重写范围
  const patterns = ['/metrics/*', '/ui/*'];
  const filter = { urls: patterns.map(p => `${fromBase}${p}`) };

  session.defaultSession.webRequest.onBeforeRequest(filter, (details, cb) => {
    const newUrl = details.url.replace(fromBase, toBase);
    console.log(`[proxy] ${details.method} ${details.url}  ->  ${newUrl}`);
    cb({ redirectURL: newUrl });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'SoloForge',
    backgroundColor: '#121414',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [isMac ? { role: 'close' } : { role: 'quit' }] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  isDev = !app.isPackaged;
  setupApiProxy();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
