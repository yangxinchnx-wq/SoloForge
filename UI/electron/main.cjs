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

// ── Content-Security-Policy ──
// dev 模式允许 unsafe-eval（Vite HMR 需要 new Function / eval）
// prod 模式严格：禁止 unsafe-eval、unsafe-inline（除 style）、只允许同源
function buildCspHeader(isDev) {
  if (isDev) {
    return [
      "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: ws: http://localhost:* http://127.0.0.1:*",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:* http://127.0.0.1:*",
      "style-src 'self' 'unsafe-inline' http://localhost:* http://127.0.0.1:*",
      "img-src 'self' data: blob: http://localhost:* http://127.0.0.1:*",
      "font-src 'self' data: http://localhost:* http://127.0.0.1:*",
      "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*",
    ].join('; ');
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:* https://api.openai.com https://api.anthropic.com https://api.deepseek.com https://generativelanguage.googleapis.com https://api.siliconflow.cn https://api.moonshot.cn https://api.xiaomimimo.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function applyCsp() {
  const csp = buildCspHeader(isDev);
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

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
// 透明 borderless 窗口，parent 设为 mainWindow 让 OS 自动管理 z-order
// （画布窗口始终在 mainWindow 内容之下，不会盖到其它组件）
// 位置由渲染端 reportBounds 上报（覆盖右侧画布区域）
// Flutter 窗口通过 SetParent 嵌入此窗口的 HWND，作为子窗口可见
// ────────────────────────────────────────────
let hostBounds = { x: 100, y: 100, width: 1200, height: 800 };

function createCanvasHostWindow(parent) {
  // 销毁旧的（重新创建的情况）
  if (canvasHostWindow && !canvasHostWindow.isDestroyed()) {
    try { canvasHostWindow.destroy(); } catch {}
  }
  canvasHostWindow = new BrowserWindow({
    width: hostBounds.width,
    height: hostBounds.height,
    x: hostBounds.x,
    y: hostBounds.y,
    parent: parent || undefined,  // ★ 关键：作为 mainWindow 的子窗口 → OS 自动管理 z-order
    show: true,                   // 可见，transparent 让背景透出 IDE 底色
    frame: false,
    transparent: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      offscreen: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  // 加载空白透明页（Chromium 不允许 about:blank 当宿主；用 data: URL）
  canvasHostWindow.loadURL('data:text/html,<html><body style="margin:0;background:transparent;backdrop-filter:none"></body></html>');
  canvasHostWindow.setAlwaysOnTop(false);
  canvasHostWindow.setIgnoreMouseEvents(false);
  return canvasHostWindow;
}

// 把画布宿主窗口移动到指定区域（渲染端 PreviewPanel 实时上报）
function positionCanvasHost(bounds) {
  if (!canvasHostWindow || canvasHostWindow.isDestroyed()) return;
  if (!bounds) return;
  hostBounds = bounds;
  try {
    canvasHostWindow.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
  } catch (e) {
    console.warn('[canvas-host] setBounds failed:', e?.message);
  }
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

// ── 2026 关闭 DWM 在窗口上的 chrome(消除 Windows 11 snap layout 的尺寸说明 tooltip) ──
// frame:false + transparent:true 都不能阻止 DWM 在用户拖动/缩放窗口时画
// "1234 × 567" 尺寸 tooltip,这是 DWM 在 explorer.exe 进程里画的,必须调
// DwmSetWindowAttribute 把 DWMWA_NCRENDERING_POLICY 设为 DWMNCRP_DISABLED
// (DWM 完全不参与此窗口的非客户区渲染 → snap tooltip 不再画)。
// 用 PowerShell + EncodedCommand 调,严格只动这一个 attribute,不动窗口位置/尺寸/样式。
function disableDwmNonClientRender(window) {
  if (process.platform !== 'win32') return;
  if (!window || window.isDestroyed()) return;

  let hwnd;
  try {
    const hwndBuf = window.getNativeWindowHandle();
    // Electron 返回 Buffer:64-bit 进程 8 字节,32-bit 进程 4 字节
    // PowerShell [IntPtr] 在 64-bit 系统上 8 字节,转 Int64 即可
    if (hwndBuf.length >= 8) {
      hwnd = hwndBuf.readBigInt64LE(0).toString();
    } else {
      hwnd = hwndBuf.readInt32LE(0).toString();
    }
  } catch (e) {
    console.warn('[dwm] get hwnd failed:', e?.message);
    return;
  }

  // 严格只设 DWMWA_NCRENDERING_POLICY = DWMNCRP_DISABLED,不动窗口
  //   DWMWA_NCRENDERING_POLICY = 2
  //   DWMNCRP_DISABLED        = 1
  const psScript = `
$src = @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("dwmapi.dll", PreserveSig=true)]
  public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);
}
'@
Add-Type -TypeDefinition $src -Language CSharp
$hwnd = [IntPtr]::new([Int64]${hwnd})
$policy = 1
$ret = [W]::DwmSetWindowAttribute($hwnd, 2, [ref]$policy, 4)
Write-Output "DWM_RET=$ret"
`;

  // 用 EncodedCommand 避免嵌套引号/反引号转义问题
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  const { exec } = require('child_process');
  exec(
    `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
    { timeout: 8000, windowsHide: true, encoding: 'utf-8' },
    (err, stdout) => {
      if (err) {
        console.warn('[dwm] disable non-client render failed:', err.message);
      } else {
        console.log('[dwm] disable non-client render:', (stdout || '').trim());
      }
    }
  );
}

// ── 2026 把窗口标记为"工具窗口" → explorer.exe 不再画 snap layout tooltip ──
// frame:false + transparent:true + DWMNCRP_DISABLED 都拦不住,Windows 11
// 的 snap layout tooltip 是 explorer.exe 在它自己的进程里画的(独立 overlay
// 顶层窗口),针对所有 explorer 认定的"顶层应用窗口"。
// WS_EX_TOOLWINDOW 让 explorer 把它当工具窗口 → 不参与 snap → tooltip 不再画
// WS_EX_APPWINDOW  对冲 TOOLWINDOW 的"不出现在任务栏"副作用,强制出现
function applyNoSnapExStyles(window) {
  if (process.platform !== 'win32') return;
  if (!window || window.isDestroyed()) return;

  let hwnd;
  try {
    const hwndBuf = window.getNativeWindowHandle();
    if (hwndBuf.length >= 8) {
      hwnd = hwndBuf.readBigInt64LE(0).toString();
    } else {
      hwnd = hwndBuf.readInt32LE(0).toString();
    }
  } catch (e) {
    console.warn('[exstyle] get hwnd failed:', e?.message);
    return;
  }

  // GWL_EXSTYLE = -20
  //   WS_EX_TOOLWINDOW = 0x00000080
  //   WS_EX_APPWINDOW  = 0x00040000
  // 直接 OR 进去,不动其他 bit
  const psScript = `
$src = @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")]
  public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")]
  public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
}
'@
Add-Type -TypeDefinition $src -Language CSharp
$hwnd = [IntPtr]::new([Int64]${hwnd})
$TOOL = 0x80
$APP  = 0x40000
$old = [W]::GetWindowLong($hwnd, -20)
$new = $old -bor $TOOL -bor $APP
[W]::SetWindowLong($hwnd, -20, $new) | Out-Null
Write-Output "EXSTYLE_OLD=$old,NEW=$new"
`;

  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  const { exec } = require('child_process');
  exec(
    `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
    { timeout: 8000, windowsHide: true, encoding: 'utf-8' },
    (err, stdout) => {
      if (err) {
        console.warn('[exstyle] apply failed:', err.message);
      } else {
        console.log('[exstyle]', (stdout || '').trim());
      }
    }
  );
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

  // 启动参数：--port=... 提供 WebSocket；--parent-hwnd=... 由 canvas C++ 入口自己 SetParent
  // 注意：canvas 的 C++ 入口使用 ParseArg(--port, arg, val) 解析，只识别 --key=value 形式，
  //      单独的 --port <val> 形式会让 std::stoi("") 抛异常触发 STATUS_STACK_BUFFER_OVERRUN
  const hostHwnd = canvasHostWindow.getNativeWindowHandle().readInt32LE(0);
  // cwd 必须设为 binary 所在目录，因为 C++ 入口的 DartProject(L"data") 是相对 binary 目录的
  // 而 dataDir 是 binary 下的 data/ 子目录，binary 在它的父目录
  const exeDir = path.dirname(exe);
  const child = spawn(exe, [
    `--port=${port}`,
    `--parent-hwnd=${hostHwnd}`,
    `--canvas-width=${width}`,
    `--canvas-height=${height}`,
  ], {
    cwd: exeDir,
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

  // 找窗口 HWND（轮询最多 5s）— C++ 入口收到 --parent-hwnd= 后会自己 SetParent + 修改样式
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

  // 把画布窗口的子 Flutter 窗口尺寸对齐到最新 hostBounds（renderer 会在 start 前调用 reportBounds）
  try {
    await moveWindow(hwnd, 0, 0, hostBounds.width, hostBounds.height);
  } catch (e) {
    console.warn('[canvas] moveWindow failed:', e?.message);
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
    // 兼容两种 DSL 形态：
    //   1) 渲染端直接给 {ui:{...}, platform:'material'} — 透传整个 dsl
    //   2) 渲染端给 {ui:{...}} — 包成 {type:'render', ui: dsl}
    let payload;
    if (dsl && (dsl.ui || dsl.root)) {
      // 已经是 root-level DSL 形态，原样发送
      payload = JSON.stringify({ type: 'render', ...dsl });
    } else {
      payload = JSON.stringify({ type: 'render', ui: dsl });
    }
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
  // renderer 上报 PreviewPanel 区域的位置/尺寸 → 移动画布宿主窗口到这里
  ipcMain.handle('canvas:report-bounds', async (_e, bounds) => {
    try {
      if (!bounds) return { ok: false, error: 'bounds missing' };
      positionCanvasHost(bounds);
      // 如果画布已经在跑，把嵌入的 Flutter 子窗口也同步 resize
      for (const [, s] of canvasSessions) {
        if (s.hwnd && s.process && !s.process.killed) {
          try { await moveWindow(s.hwnd, 0, 0, bounds.width, bounds.height); } catch {}
        }
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  // 查询画布宿主窗口是否已就绪（renderer 用来判断能否启动）
  ipcMain.handle('canvas:host-info', async () => ({ ok: true, bounds: hostBounds }));

  // ── 2026 自定义窗口控制按钮(替代 titleBarOverlay,因为 DWM 暗 tint 无法消除) ──
  // 由 UI/src/components/WindowControls.tsx 调用
  ipcMain.handle('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
  ipcMain.handle('window:is-maximized', () => {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow.isMaximized() : false;
  });
  ipcMain.handle('window:maximize-state', (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.on('maximize', () => event.sender.send('window:maximize-state-changed', true));
      mainWindow.on('unmaximize', () => event.sender.send('window:maximize-state-changed', false));
    }
  });

  // ── 2026 自定义 resize 边框(替代 frame:true 的 OS 边框,消除 Windows resize 时的白色 sizing box) ──
  // 由 UI/src/components/EdgeResize.tsx 调用
  ipcMain.handle('window:resize-by', (_e, { edge, deltaX, deltaY }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMaximized() || mainWindow.isMinimized() || mainWindow.isFullScreen()) return false;
    const b = mainWindow.getBounds();
    const minW = 1024;
    const minH = 640;
    let { x, y, width, height } = b;

    if (edge.includes('e')) width = Math.max(minW, width + deltaX);
    if (edge.includes('s')) height = Math.max(minH, height + deltaY);
    if (edge.includes('w')) {
      const newW = Math.max(minW, width - deltaX);
      if (newW !== width) { x = x + (width - newW); width = newW; }
    }
    if (edge.includes('n')) {
      const newH = Math.max(minH, height - deltaY);
      if (newH !== height) { y = y + (height - newH); height = newH; }
    }

    mainWindow.setBounds({
      x: Math.round(x), y: Math.round(y),
      width: Math.round(width), height: Math.round(height),
    });
    return true;
  });

  // ── 2026 自定义窗口拖动(替代 -webkit-app-region: drag,消除 Win11 snap layout tooltip) ──
  // 由 UI/src/components/Header.tsx 的 onMouseDown 调
  // deltaX/deltaY: 本次相对上次的鼠标位移(像素)
  ipcMain.handle('window:move-by', (_e, { deltaX, deltaY }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMaximized() || mainWindow.isMinimized() || mainWindow.isFullScreen()) return false;
    const [x, y] = mainWindow.getPosition();
    mainWindow.setPosition(Math.round(x + deltaX), Math.round(y + deltaY));
    return true;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    // ── 2026 完全自定义窗口(DWM 不画任何 chrome) ──
    // frame: false                → 完全去掉 OS 边框 / 标题栏 / resize sizing box
    // transparent: true           → 关键!窗口变成 WS_EX_LAYERED layered window,
    //                              DWM 不再绘制任何非客户区(包括 resize 时的 size box / drag preview)
    //                              这是 VS Code/Discord 完整隐藏 OS chrome 的官方做法
    //   - 替代实现:
    //     - 顶部 drag 区域由 .soloforge-drag-header CSS class 提供(WebkitAppRegion: drag)
    //     - "−/□/×" 按钮由 UI/src/components/WindowControls.tsx 用 React 画(走 IPC)
    //     - resize 由 UI/src/components/EdgeResize.tsx 在 4 边 + 4 角提供透明 handle(走 IPC)
    //   - 注意:body 必须有 solid 背景(见 index.css),否则 resize 时会看到桌面透出
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',  // transparent:true 时 backgroundColor 必须 #00000000
    hasShadow: false,
    minimizable: true,
    maximizable: true,
    resizable: true,         // frame:false 时 OS 不画 drag box,但这个 flag 影响 cursor 反馈
    fullscreenable: true,
    paintWhenInitiallyHidden: true,
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

  // ready-to-show:页面首次渲染完成后才显示窗口(避免闪烁)
  // 实际 show 逻辑放到 app.whenReady 里(包含 DWM 关闭非客户区渲染的副作用)

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
  // 2026 修复:Electron 在未打包项目里用 node_modules/.bin/electron 直接运行时,
  // app.isPackaged 仍然返回 true(已知 Electron 怪癖,见 electronjs docs)。
  // 正确判断:isDev = process.defaultApp || !app.isPackaged
  isDev = process.defaultApp || !app.isPackaged;
  applyCsp();
  setupApiProxy();
  buildMenu();
  createWindow();                  // 先创建主窗口
  createCanvasHostWindow(mainWindow); // 再以主窗口为 parent 创建画布宿主 → OS 自动管 z-order
  // 2026:关掉 DWM 在主窗口的非客户区渲染 + 标记为工具窗口
  // 两者结合才能彻底消除 Windows 11 snap layout 的尺寸说明 tooltip
  // (在 ready-to-show 之后调,确保 HWND 已绑定)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    setTimeout(() => {
      disableDwmNonClientRender(mainWindow);
      applyNoSnapExStyles(mainWindow);
    }, 100);
  });
  registerIpc();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      createCanvasHostWindow(mainWindow);
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
