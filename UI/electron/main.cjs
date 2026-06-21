// ─────────────────────────────────────────────────────────────────
// SoloForge Electron 主进程
// 入口：package.json "main" 指向本文件
// 加载 UI/ 前端（开发态 = UI/server.ts，端口 3000；生产态 = vite build 产物）
// 原 SoloForge 后端（tsx src/index.ts，端口 3001）需独立启动，不由本进程拉起
// ─────────────────────────────────────────────────────────────────

const { app, BrowserWindow, shell, Menu, session, ipcMain, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');

// 2026 改造：UI server.ts 在 3000 端口（含 Vite middleware + Gemini 代理）
// 原 SoloForge 后端在 3001 端口（SurrealDB/Garnet/AI 社会系统）
// 当前阶段：UI 全部走 3000 提供的 /api/*；3001 处于备用 / 未来集成
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:3000';
const BACKEND_URL = process.env.SOLOFORGE_BACKEND_URL || 'http://localhost:3001';

let isDev = false;
let mainWindow = null;

/** 画布宿主窗口（隐藏），作为 Flutter 子窗口的 SetParent 目标 */
let canvasHostWindow = null;
/** canvas sessionId -> { pid, port, hwnd, process } */
const canvasSessions = new Map();

// ── API 中间人网关 ──
// 纯透传：拦截 UI 发的 /metrics/* /ui/*，把目标从 3000 重写到 3001（原后端）
// 保留 /api/* 不重写（由 UI/server.ts 自身 Express 提供，优先级最高）
// headers / body / method / SSE / 任何字段都不动，只改 URL
function setupApiProxy() {
  const urlFromBase = new URL(DEV_URL);
  const urlToBase = new URL(BACKEND_URL);
  const fromBase = `${urlFromBase.protocol}//${urlFromBase.host}`;
  const toBase = `${urlToBase.protocol}//${urlToBase.host}`;
  if (fromBase === toBase) return;

  const patterns = ['/metrics/*', '/ui/*'];
  const filter = { urls: patterns.map(p => `${fromBase}${p}`) };
  session.defaultSession.webRequest.onBeforeRequest(filter, (details, cb) => {
    const newUrl = details.url.replace(fromBase, toBase);
    console.log(`[proxy] ${details.method} ${details.url}  ->  ${newUrl}`);
    cb({ redirectURL: newUrl });
  });
}

// ────────────────────────────────────────────
// 画布宿主窗口
// 隐藏的 Borderless 窗口，位于屏幕外
// Flutter 窗口通过 SetParent 嵌入此窗口的 HWND
// Electron 渲染层通过 webContents 截图/事件与画布交互
// ────────────────────────────────────────────
function createCanvasHostWindow() {
  canvasHostWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    x: -32000,
    y: -32000,
    show: false,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      offscreen: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  // 加载空白页（必须是 HTML，Chromium 不允许 about:blank 在 windows 上当宿主）
  canvasHostWindow.loadURL('data:text/html,<html><body style="margin:0;background:transparent"></body></html>');
  return canvasHostWindow;
}

// ────────────────────────────────────────────
// 工具：找可用的本地端口
// ────────────────────────────────────────────
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ────────────────────────────────────────────
// 工具：PowerShell 调 Win32 API
// ────────────────────────────────────────────
function execPs(script) {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '`"').replace(/\n/g, ';')}"`,
      { timeout: 15000, encoding: 'utf-8', windowsHide: true },
      (err, stdout, stderr) => {
        if (err) resolve({ ok: false, error: stderr || err.message });
        else resolve({ ok: true, output: (stdout || '').trim() });
      }
    );
  });
}

const PS_WIN32 = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W32 {
  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
  [DllImport("user32.dll")] public static extern long GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern long SetWindowLong(IntPtr hWnd, int nIndex, long dwNewLong);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll")] public static extern int PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
}
'@
`.replace(/\n/g, '');

// 找指定 pid 的第一个顶层窗口
async function findWindowByPid(pid) {
  const script = `${PS_WIN32}
$found = [IntPtr]::Zero
$callback = {
  param($hwnd, $lparam)
  if ([W32]::IsWindowVisible($hwnd) -and [W32]::GetParent($hwnd) -eq [IntPtr]::Zero) {
    $procId = 0
    [W32]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
    if ($procId -eq ${pid}) {
      $script:found = $hwnd
      return $false
    }
  }
  return $true
}
[W32]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
if ($script:found -ne [IntPtr]::Zero) { Write-Output $script:found.ToInt64() } else { Write-Output 0 }`;
  const r = await execPs(script);
  const hwnd = parseInt(r.output, 10) || 0;
  return hwnd;
}

async function embedWindow(flutterHwnd, parentHwnd, x = 0, y = 0, w = 800, h = 600) {
  // 去掉 caption/thickframe/sysmenu，加 WS_CHILD | WS_VISIBLE
  const GWL_STYLE = -16;
  const WS_CHILD = 0x40000000;
  const WS_VISIBLE = 0x10000000;
  const WS_CAPTION = 0x00C00000;
  const WS_THICKFRAME = 0x00040000;
  const WS_SYSMENU = 0x00080000;
  const WS_MINIMIZEBOX = 0x00020000;
  const WS_MAXIMIZEBOX = 0x00010000;
  const script = `${PS_WIN32}
$child = [IntPtr]::new(${flutterHwnd})
$parent = [IntPtr]::new(${parentHwnd})
$oldStyle = [W32]::GetWindowLong($child, -16)
$newStyle = ($oldStyle -band -bnot 0x00C00000L) -band -bnot 0x00040000L
$newStyle = $newStyle -band -bnot 0x00080000L
$newStyle = $newStyle -band -bnot 0x00020000L
$newStyle = $newStyle -band -bnot 0x00010000L
$newStyle = $newStyle -bor 0x40000000L -bor 0x10000000L
[W32]::SetWindowLong($child, -16, $newStyle) | Out-Null
[W32]::SetParent($child, $parent) | Out-Null
[W32]::SetWindowPos($child, [IntPtr]::Zero, ${x}, ${y}, ${w}, ${h}, 0x0040 -bor 0x0020) | Out-Null
[W32]::ShowWindow($child, 5) | Out-Null
Write-Output "OK"`;
  return execPs(script);
}

async function moveWindow(hwnd, x, y, w, h) {
  const script = `${PS_WIN32}
[W32]::MoveWindow([IntPtr]::new(${hwnd}), ${x}, ${y}, ${w}, ${h}, $true) | Out-Null
Write-Output "OK"`;
  return execPs(script);
}

async function sendToCanvas(canvasHwnd, jsonPayload) {
  // 通过 IPC 而不是 Win32 SendMessage 实现，UI 直接 WebSocket 推送更稳定
  // 这里保留接口以备扩展
  return { ok: true };
}

// ────────────────────────────────────────────
// 工具：解析 canvas_preview.exe 路径
// ────────────────────────────────────────────
function resolveCanvasExePath() {
  // 打包后: process.resourcesPath/canvas/canvas_preview.exe
  // 开发态: UI/resources/canvas/canvas-dist/canvas_preview.exe
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'canvas', 'canvas_preview.exe'))) {
    return path.join(process.resourcesPath, 'canvas', 'canvas_preview.exe');
  }
  // __dirname = UI/electron; 回到 UI/
  const uiRoot = path.resolve(__dirname, '..');
  const devPath = path.join(uiRoot, 'resources', 'canvas', 'canvas-dist', 'canvas_preview.exe');
  return devPath;
}

function resolveCanvasDataDir() {
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'canvas', 'data'))) {
    return path.join(process.resourcesPath, 'canvas', 'data');
  }
  const uiRoot = path.resolve(__dirname, '..');
  return path.join(uiRoot, 'resources', 'canvas', 'canvas-dist', 'data');
}

// ────────────────────────────────────────────
// 工具：等待 WS 端口起来
// ────────────────────────────────────────────
function waitForPort(port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tryConnect = () => {
      const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
        sock.end();
        resolve(true);
      });
      sock.on('error', () => {
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(tryConnect, 200);
      });
    };
    tryConnect();
  });
}

// ────────────────────────────────────────────
// 启动画布
// ────────────────────────────────────────────
async function startCanvas(sessionId, width, height) {
  if (canvasSessions.has(sessionId)) {
    const existing = canvasSessions.get(sessionId);
    if (existing.process && !existing.process.killed) {
      return { ok: true, session: existing, reused: true };
    }
    canvasSessions.delete(sessionId);
  }

  const exe = resolveCanvasExePath();
  if (!fs.existsSync(exe)) {
    return { ok: false, error: `canvas_preview.exe not found at ${exe}` };
  }
  const dataDir = resolveCanvasDataDir();
  const port = await findFreePort();

  // 启动参数：--port 提供 WebSocket；不传 --parent-hwnd（交给 SetParent 后期注入更可靠）
  const child = spawn(exe, [
    '--port', String(port),
    '--canvas-width', String(width),
    '--canvas-height', String(height),
  ], {
    cwd: dataDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.on('data', (d) => console.log(`[canvas:${sessionId}]`, d.toString().trim()));
  child.stderr.on('data', (d) => console.error(`[canvas:${sessionId}:err]`, d.toString().trim()));
  child.on('exit', (code, signal) => {
    console.log(`[canvas:${sessionId}] exited code=${code} signal=${signal}`);
    canvasSessions.delete(sessionId);
  });

  // 等待端口 ready
  const ready = await waitForPort(port, 10000);
  if (!ready) {
    child.kill('SIGTERM');
    return { ok: false, error: `canvas WebSocket did not start on port ${port}` };
  }

  // 找窗口 HWND（轮询最多 5s）
  let hwnd = 0;
  const pid = child.pid;
  for (let i = 0; i < 25 && hwnd === 0; i++) {
    hwnd = await findWindowByPid(pid);
    if (hwnd === 0) await new Promise(r => setTimeout(r, 200));
  }
  if (hwnd === 0) {
    child.kill('SIGTERM');
    return { ok: false, error: `canvas window HWND not found for pid ${pid}` };
  }

  // 嵌入到隐藏宿主窗口
  const embed = await embedWindow(hwnd, canvasHostWindow.getNativeWindowHandle().readInt32LE(0), 0, 0, width, height);
  if (!embed.ok) {
    child.kill('SIGTERM');
    return { ok: false, error: `embed failed: ${embed.error}` };
  }

  const session = {
    sessionId,
    pid,
    port,
    hwnd,
    process: child,
    width,
    height,
  };
  canvasSessions.set(sessionId, session);
  return { ok: true, session, reused: false };
}

async function resizeCanvas(sessionId, width, height) {
  const s = canvasSessions.get(sessionId);
  if (!s) return { ok: false, error: 'session not found' };
  s.width = width;
  s.height = height;
  return moveWindow(s.hwnd, 0, 0, width, height);
}

async function stopCanvas(sessionId) {
  const s = canvasSessions.get(sessionId);
  if (!s) return { ok: true, notFound: true };
  if (s.process && !s.process.killed) {
    s.process.kill('SIGTERM');
    setTimeout(() => {
      if (s.process && !s.process.killed) s.process.kill('SIGKILL');
    }, 3000);
  }
  canvasSessions.delete(sessionId);
  return { ok: true };
}

async function pushCanvasDSL(sessionId, dsl) {
  const s = canvasSessions.get(sessionId);
  if (!s) return { ok: false, error: 'session not found' };
  // 通过 WebSocket 推 DSL 到 canvas
  return new Promise((resolve) => {
    const payload = JSON.stringify({ type: 'render', dsl });
    const req = http.request({
      host: '127.0.0.1',
      port: s.port,
      path: '/render',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 5000,
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

// ────────────────────────────────────────────
// IPC handlers
// ────────────────────────────────────────────
function registerIpc() {
  ipcMain.handle('canvas:start', async (_e, { sessionId, width, height }) => {
    return startCanvas(sessionId, width || 800, height || 600);
  });
  ipcMain.handle('canvas:resize', async (_e, { sessionId, width, height }) => {
    return resizeCanvas(sessionId, width, height);
  });
  ipcMain.handle('canvas:stop', async (_e, { sessionId }) => {
    return stopCanvas(sessionId);
  });
  ipcMain.handle('canvas:push', async (_e, { sessionId, dsl }) => {
    return pushCanvasDSL(sessionId, dsl);
  });
  ipcMain.handle('canvas:status', async (_e, { sessionId }) => {
    const s = canvasSessions.get(sessionId);
    return { ok: true, active: !!s, info: s || null };
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
  createCanvasHostWindow();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createCanvasHostWindow();
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // 清理所有画布进程
  for (const [, s] of canvasSessions) {
    if (s.process && !s.process.killed) s.process.kill('SIGTERM');
  }
  canvasSessions.clear();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const [, s] of canvasSessions) {
    if (s.process && !s.process.killed) s.process.kill('SIGTERM');
  }
});
