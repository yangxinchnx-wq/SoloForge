// ─────────────────────────────────────────────────────────────────
// SoloForge Electron 主进程
// 入口：package.json "main" 指向本文件
// 加载 UI/ 前端（开发态 = UI/server.ts，端口 3000；生产态 = vite build 产物）
// 原 SoloForge 后端（tsx src/index.ts，端口 3001）需独立启动，不由本进程拉起
// ─────────────────────────────────────────────────────────────────

const { app, BrowserWindow, shell, Menu, session, ipcMain, nativeImage, screen, dialog } = require('electron');
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
/** canvas sessionId -> { pid, port, hwnd, process, watchdog? } */
const canvasSessions = new Map();

// ────────────────────────────────────────────
// 2026-07-08 画布看门狗: 心跳检测 + 自动重启
//
// 问题: canvas_preview.exe 有时不会崩溃退出, 而是事件循环挂住
//   (Dart HttpServer 串行处理 → 请求堆积 → 卡死)
//   此时 child.on('exit') 不会触发, UI 永远停在 "running" 状态
//
// 修复: 每 15s 向 canvas 的 /health 发 HTTP GET
//   连续 3 次失败 (45s) → 判定为挂死 → kill + 通知 UI 崩溃
// ────────────────────────────────────────────
const WATCHDOG_INTERVAL_MS = 15000;
const WATCHDOG_MAX_FAILURES = 3;

function startWatchdog(sessionId, session) {
  let consecutiveFailures = 0;
  const timer = setInterval(() => {
    const s = canvasSessions.get(sessionId);
    if (!s || !s.process || s.process.killed) {
      clearInterval(timer);
      return;
    }
    const req = http.request({
      host: '127.0.0.1',
      port: s.port,
      path: '/health',
      method: 'GET',
      timeout: 5000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode === 200) {
          consecutiveFailures = 0; // 心跳恢复正常
        } else {
          consecutiveFailures++;
          console.warn(`[watchdog:${sessionId}] health check returned ${res.statusCode} (${consecutiveFailures}/${WATCHDOG_MAX_FAILURES})`);
        }
      });
    });
    req.on('error', (e) => {
      consecutiveFailures++;
      console.warn(`[watchdog:${sessionId}] health check failed: ${e.message} (${consecutiveFailures}/${WATCHDOG_MAX_FAILURES})`);
      if (consecutiveFailures >= WATCHDOG_MAX_FAILURES) {
        // ★ 画布挂死: kill 进程, exit handler 会通知 UI
        console.error(`[watchdog:${sessionId}] ${WATCHDOG_MAX_FAILURES} consecutive failures, killing unresponsive canvas`);
        clearInterval(timer);
        killProcessTree(s.process);
      }
    });
    req.on('timeout', () => {
      req.destroy();
      consecutiveFailures++;
      console.warn(`[watchdog:${sessionId}] health check timeout (${consecutiveFailures}/${WATCHDOG_MAX_FAILURES})`);
      if (consecutiveFailures >= WATCHDOG_MAX_FAILURES) {
        console.error(`[watchdog:${sessionId}] ${WATCHDOG_MAX_FAILURES} consecutive timeouts, killing unresponsive canvas`);
        clearInterval(timer);
        killProcessTree(s.process);
      }
    });
    req.end();
  }, WATCHDOG_INTERVAL_MS);
  session.watchdog = timer;
}

function stopWatchdog(session) {
  if (session?.watchdog) {
    clearInterval(session.watchdog);
    session.watchdog = null;
  }
}

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
      // ★ sandbox: false — 宿主窗口只加载 data: 空白页, 无需沙箱
      //   sandbox:true + 无 preload + data:URL → binding.startupData=null
      //   → "Cannot destructure property 'preloadScripts' of null" 报错
      sandbox: false,
    },
  });
  // 加载空白透明页（Chromium 不允许 about:blank 当宿主；用 data: URL）
  canvasHostWindow.loadURL('data:text/html,<html><body style="margin:0;background:transparent;backdrop-filter:none"></body></html>');
  canvasHostWindow.setAlwaysOnTop(false);
  // 2026-07-04 修复: setIgnoreMouseEvents(true) 让事件穿透到 mainWindow
  // 原因: canvasHostWindow 是 mainWindow 的子窗口, 浮在 mainWindow 上面
  //   如果它覆盖了 Header 区域, mousedown 被它的空白 data: 页面吃掉
  //   mainWindow 的 Header 永远收不到事件 → 顶部栏拖不动
  // 安全性: Flutter 子窗口是通过 SetParent 嵌入的原生 HWND, 不受 Electron
  //   setIgnoreMouseEvents 影响, 仍正常接收事件
  canvasHostWindow.setIgnoreMouseEvents(true);
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
    // 用 -EncodedCommand (base64 UTF-16LE) 传递脚本,保留换行和特殊字符
    // 之前用 -Command + .replace(/\n/g, ';') 会破坏 Add-Type here-string (@'...'@) 语法
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    exec(
      `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
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
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
  [DllImport("dwmapi.dll", PreserveSig=true)] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
}
'@
`;
// 2026 修复:之前用 .replace(/\n/g, '') 删掉所有换行,导致 PS 解析
// here-string @' 报 UnexpectedCharactersAfterHereStringHeader
// (之前 findWindowByPid/embedWindow 等用 PS_WIN32 的函数从来没真被执行过
//  → bug 隐藏;现在 applyNoSnapFinal 第一次用就炸了)
// 改成保留换行,Add-Type 接受多行 C# 代码

// 找指定 pid 的第一个顶层窗口
// 优化: 优先用 Get-Process (无需 Add-Type 编译, ~100ms)
//   失败时 fallback 到 EnumWindows (需要 Add-Type, ~2-5s)
// 注意: 不检查 IsWindowVisible — spawn 时 windowsHide:true 会让窗口首次 ShowWindow
//   被 OS 替换为 SW_HIDE, IsWindowVisible 返回 false, 导致永远找不到窗口。
async function findWindowByPid(pid) {
  // 快速路径: Get-Process 的 MainWindowHandle
  // 缺点: windowsHide:true 时 MainWindowHandle 可能为 0, 但 Flutter 窗口创建后通常非 0
  try {
    const r = await execPs(
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { Write-Output $p.MainWindowHandle.ToInt64() } else { Write-Output 0 }`
    );
    if (r.ok) {
      const hwnd = parseInt(r.output, 10) || 0;
      if (hwnd !== 0) return hwnd;
    }
  } catch {}

  // 慢速 fallback: EnumWindows + GetParent == Zero + PID 匹配
  const script = `${PS_WIN32}
$found = [IntPtr]::Zero
$callback = {
  param($hwnd, $lparam)
  if ([W32]::GetParent($hwnd) -eq [IntPtr]::Zero) {
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
// 确保画布宿主窗口存在 (懒创建)
// ────────────────────────────────────────────
function ensureCanvasHost() {
  if (canvasHostWindow && !canvasHostWindow.isDestroyed()) {
    return canvasHostWindow;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('mainWindow not available; cannot create canvas host');
  }
  console.log('[canvas-host] lazy create (canvasHostWindow was null/destroyed)');
  return createCanvasHostWindow(mainWindow);
}

// ────────────────────────────────────────────
// Windows 进程树强制 kill
//   child.kill() 在 Windows 上只杀主进程, 不杀子进程 (GPU worker 等)
//   taskkill /T /F 杀整棵进程树
// ────────────────────────────────────────────
function killProcessTree(child) {
  if (!child || child.killed) return;
  const pid = child.pid;
  if (!pid) { try { child.kill(); } catch {} return; }
  if (process.platform === 'win32') {
    try {
      require('child_process').spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
    } catch {
      try { child.kill(); } catch {}
    }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

// ────────────────────────────────────────────
// 启动画布
// ────────────────────────────────────────────
async function startCanvas(sessionId, width, height) {
  if (canvasSessions.has(sessionId)) {
    const existing = canvasSessions.get(sessionId);
    if (existing.process && !existing.process.killed) {
      const { process: _omit, ...ipcSession } = existing;
      return { ok: true, session: ipcSession, reused: true };
    }
    canvasSessions.delete(sessionId);
  }

  const exe = resolveCanvasExePath();
  if (!fs.existsSync(exe)) {
    return { ok: false, error: `canvas_preview.exe not found at ${exe}` };
  }
  const dataDir = resolveCanvasDataDir();

  // 确保画布宿主窗口存在 (可能被 idle destroy 或外部销毁)
  let host;
  try {
    host = ensureCanvasHost();
  } catch (e) {
    return { ok: false, error: `failed to create canvas host: ${e.message}` };
  }

  const port = await findFreePort();

  // 启动参数：--port=... 提供 WebSocket；--parent-hwnd=... 由 canvas C++ 入口自己 SetParent
  // 注意：canvas 的 C++ 入口使用 ParseArg(--port, arg, val) 解析，只识别 --key=value 形式，
  //      单独的 --port <val> 形式会让 std::stoi("") 抛异常触发 STATUS_STACK_BUFFER_OVERRUN
  const hostHwnd = host.getNativeWindowHandle().readInt32LE(0);
  // cwd 必须设为 binary 所在目录，因为 C++ 入口的 DartProject(L"data") 是相对 binary 目录的
  // 而 dataDir 是 binary 下的 data/ 子目录，binary 在它的父目录
  const exeDir = path.dirname(exe);
  // ★ 关键: 必须删除 ELECTRON_RUN_AS_NODE（不能赋空字符串）
  //   Windows 上空字符串仍被视为 "存在", 可能干扰子进程初始化
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;

  // ★ 关键修复: 不传 --parent-hwnd 给 C++ runner
  //   原因: C++ runner 收到 parent-hwnd 后立即 SetParent, 将 Flutter 窗口变为子窗口
  //   → findWindowByPid 的 EnumWindows 只查找顶层窗口 (GetParent==Zero), 找不到子窗口
  //   → HWND 查找超时 → killProcessTree → exit code 1
  //   修复: 让 Flutter 窗口先作为顶层窗口创建, main.cjs 找到 HWND 后再 embedWindow
  console.log(`[canvas:${sessionId}] spawning: ${exe} --port=${port} --canvas-width=${width} --canvas-height=${height} (cwd=${exeDir})`);

  const child = spawn(exe, [
    `--port=${port}`,
    `--canvas-width=${width}`,
    `--canvas-height=${height}`,
  ], {
    cwd: exeDir,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  console.log(`[canvas:${sessionId}] spawned pid=${child.pid}`);

  // 收集 stderr 输出用于崩溃诊断 (最多保留 2000 字符)
  let stderrBuffer = '';
  child.stdout.on('data', (d) => console.log(`[canvas:${sessionId}]`, d.toString().trim()));
  child.stderr.on('data', (d) => {
    const text = d.toString().trim();
    console.error(`[canvas:${sessionId}:err]`, text);
    stderrBuffer = (stderrBuffer + '\n' + text).slice(-2000);
  });
  child.on('exit', (code, signal) => {
    console.log(`[canvas:${sessionId}] exited code=${code} signal=${signal}`);
    const wasRunning = canvasSessions.has(sessionId);
    const session = canvasSessions.get(sessionId);
    // ★ 清理看门狗定时器
    if (session?.watchdog) {
      clearInterval(session.watchdog);
    }
    canvasSessions.delete(sessionId);
    // ★ 通知渲染层: 画布进程已退出 (非正常退出时附带诊断信息)
    //   code=0 / signal=null → 正常关闭 (用户主动停止)
    //   code!=0 / signal!=null → 崩溃, 附带 stderr 末尾供 UI 展示
    if (wasRunning && mainWindow && !mainWindow.isDestroyed()) {
      const isCrash = code !== 0 && code !== null;
      // 翻译常见退出码为人类可读信息
      let crashReason = '';
      if (isCrash) {
        if (code === 3221226505) crashReason = ' (STATUS_STACK_BUFFER_OVERRUN — 栈溢出)';
        else if (code === 3221225477) crashReason = ' (STATUS_ACCESS_VIOLATION — 内存访问违规)';
        else if (code === 3221225725) crashReason = ' (STATUS_HEAP_CORRUPTION — 堆损坏)';
        else if (code === 255) crashReason = ' (Dart 未捕获异常)';
        else if (code > 100000) crashReason = ' (Win32 异常)';
      }
      mainWindow.webContents.send('canvas:exited', {
        sessionId,
        exitCode: code,
        signal,
        isCrash,
        stderr: isCrash ? stderrBuffer : '',
        message: isCrash
          ? `画布进程崩溃 (exit=${code}${crashReason}${signal ? ' signal=' + signal : ''})`
          : 'canvas_preview.exe 已退出',
      });
    }
  });

  // 等待端口 ready
  // 等待端口 ready (同时监听进程是否提前退出)
  let exitedEarly = false;
  let earlyExitCode = null;
  let earlyStderr = '';
  const earlyExitHandler = (code, signal) => {
    exitedEarly = true;
    earlyExitCode = code;
    earlyStderr = stderrBuffer;
  };
  child.once('exit', earlyExitHandler);

  console.log(`[canvas:${sessionId}] waiting for port ${port}...`);
  const ready = await waitForPort(port, 10000);
  child.removeListener('exit', earlyExitHandler);

  if (exitedEarly) {
    console.error(`[canvas:${sessionId}] early exit: code=${earlyExitCode} stderr=${earlyStderr?.slice(-300)}`);
    return {
      ok: false,
      error: `canvas_preview.exe 启动后立即退出 (code=${earlyExitCode})${earlyStderr ? '\n' + earlyStderr.slice(-500) : ''}`,
    };
  }
  if (!ready) {
    console.error(`[canvas:${sessionId}] port ${port} not ready, killing process tree`);
    killProcessTree(child);
    return { ok: false, error: `canvas WebSocket did not start on port ${port}` };
  }
  console.log(`[canvas:${sessionId}] port ${port} ready, finding window HWND...`);

  // 找窗口 HWND（总超时 15s — 避免慢速 PowerShell 导致无限等待）
  let hwnd = 0;
  const pid = child.pid;
  const hwndDeadline = Date.now() + 15000;
  let hwndAttempts = 0;
  for (let i = 0; i < 60 && hwnd === 0 && Date.now() < hwndDeadline; i++) {
    hwnd = await findWindowByPid(pid);
    hwndAttempts++;
    if (hwnd === 0) await new Promise(r => setTimeout(r, 200));
  }
  if (hwnd === 0) {
    console.error(`[canvas:${sessionId}] HWND not found after ${hwndAttempts} attempts (pid=${pid}), killing process tree`);
    killProcessTree(child);
    return { ok: false, error: `canvas window HWND not found for pid ${pid} (tried ${hwndAttempts} times)` };
  }
  console.log(`[canvas:${sessionId}] HWND found: ${hwnd} (after ${hwndAttempts} attempts)`);

  // ★ 关键: 将 Flutter 窗口嵌入到 canvasHostWindow (SetParent + WS_CHILD)
  //   之前缺失这一步 → Flutter 窗口作为独立顶层窗口存在, 不在 Electron 内
  try {
    await embedWindow(hwnd, hostHwnd, 0, 0, hostBounds.width, hostBounds.height);
    console.log(`[canvas:${sessionId}] embedded into host hwnd=${hostHwnd}`);
  } catch (e) {
    console.warn(`[canvas:${sessionId}] embedWindow failed:`, e?.message);
    // embed 失败不阻止启动, 用户至少能看到独立窗口
  }

  // 把画布窗口尺寸对齐到最新 hostBounds
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
    watchdog: null,
  };
  canvasSessions.set(sessionId, session);
  // ★ 启动看门狗: 每 15s 心跳检测, 连续 3 次失败自动 kill 挂死的画布
  startWatchdog(sessionId, session);
  // ★ 2026-07-09: 把画布端口注册到 Node.js 后端 (让 Java Agent 能 relay 推送 DSL)
  registerCanvasPortToBackend(sessionId, port, pid, hwnd);
  // IPC 返回时去掉无法 structured clone 的对象 (ChildProcess + Timer)
  const { process: _omit, watchdog: _omit2, ...ipcSession } = session;
  return { ok: true, session: ipcSession, reused: false };
}

async function resizeCanvas(sessionId, width, height) {
  const s = canvasSessions.get(sessionId);
  if (!s) return { ok: false, error: 'session not found' };
  s.width = width;
  s.height = height;
  return moveWindow(s.hwnd, 0, 0, width, height);
}

// ────────────────────────────────────────────
// 2026-07-09 画布端口注册到 Node.js 后端 (3001)
// 让 Java Agent (8770) 能通过 Node.js relay 推送 DSL 到 Flutter canvas
// 链路: Java canvas_push_ui → POST 3001/api/canvas/relay/push-ui → Flutter /render
// ────────────────────────────────────────────
function registerCanvasPortToBackend(sessionId, port, pid, hwnd) {
  const payload = JSON.stringify({ sessionId, port, pid, hwnd });
  const req = http.request(
    `${BACKEND_URL}/api/canvas/relay/register-port`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 2000,
    },
    (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        console.log(`[canvas:${sessionId}] registered port ${port} to backend (status=${res.statusCode})`);
      });
    }
  );
  req.on('error', (e) => {
    // 后端未启动时不阻塞画布启动 (Electron 可独立运行)
    console.warn(`[canvas:${sessionId}] register-port failed (non-blocking): ${e.message}`);
  });
  req.on('timeout', () => { req.destroy(); });
  req.write(payload);
  req.end();
}

function unregisterCanvasPortFromBackend(sessionId) {
  const payload = JSON.stringify({ sessionId });
  const req = http.request(
    `${BACKEND_URL}/api/canvas/relay/unregister-port`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 2000,
    },
    (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        console.log(`[canvas:${sessionId}] unregistered port from backend (status=${res.statusCode})`);
      });
    }
  );
  req.on('error', (e) => {
    console.warn(`[canvas:${sessionId}] unregister-port failed (non-blocking): ${e.message}`);
  });
  req.on('timeout', () => { req.destroy(); });
  req.write(payload);
  req.end();
}

async function stopCanvas(sessionId) {
  const s = canvasSessions.get(sessionId);
  if (!s) return { ok: true, notFound: true };
  // ★ 清理看门狗
  stopWatchdog(s);
  if (s.process && !s.process.killed) {
    killProcessTree(s.process);
    setTimeout(() => {
      if (s.process && !s.process.killed) killProcessTree(s.process);
    }, 3000);
  }
  canvasSessions.delete(sessionId);
  // ★ 2026-07-09: 通知 Node.js 后端注销端口 (让 Java Agent 不再往已关闭的画布推)
  unregisterCanvasPortFromBackend(sessionId);
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

// ── 2026-07-05 自定义窗口控制按钮 ──
// 由 UI/src/components/WindowControls.tsx 调用
//
// toggle-maximize 不用 mainWindow.maximize()/unmaximize():
//   maximize() 内部调用 ShowWindow(SW_MAXIMIZE) → DWM 播放状态转换动画
//   → 显示半透明尺寸数字提示 (白色长方形)
//   DWMWA_TRANSITIONS_FORCEDISABLED 对 Win11 的这个 tooltip 无效
//   改用 setBounds 手动设置窗口尺寸到工作区全屏 → 不触发 DWM 动画 → 无 tooltip
//
// 用自定义标志 _customMaximized 记录状态, 不依赖 OS 的 maximized 状态

let _customMaximized = false;
let _savedBounds = null;

  // ── 文件夹选择器 (用于工作区绑定) ──
  ipcMain.handle('dialog:select-folder', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '选择工作区文件夹',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const folderPath = result.filePaths[0];
    const folderName = path.basename(folderPath);
    return { path: folderPath, name: folderName };
  });

ipcMain.handle('window:minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});

ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (_customMaximized) {
    // 还原
    if (_savedBounds) {
      mainWindow.setBounds(_savedBounds);
    }
    _customMaximized = false;
  } else {
    // 最大化: 保存当前 bounds, 然后设置为屏幕工作区全屏
    _savedBounds = mainWindow.getBounds();
    const { screen } = require('electron');
    const display = screen.getDisplayMatching(_savedBounds);
    mainWindow.setBounds(display.workArea);
    _customMaximized = true;
  }
  // 通知渲染器状态变化
  mainWindow.webContents.send('window:maximize-state-changed', _customMaximized);
  return _customMaximized;
});

ipcMain.handle('window:restore', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (_customMaximized && _savedBounds) {
      mainWindow.setBounds(_savedBounds);
      _customMaximized = false;
      mainWindow.webContents.send('window:maximize-state-changed', false);
    } else {
      mainWindow.restore();
    }
  }
});

ipcMain.handle('window:close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});
ipcMain.handle('window:is-maximized', () => {
  return _customMaximized;
});
ipcMain.handle('window:maximize-state', (event) => {
  // 立即推送当前状态
  event.sender.send('window:maximize-state-changed', _customMaximized);
});

  // ── 2026-07-02 彻底重构: 自定义窗口拖动(绝对坐标模式 + 同步 FIFO) ──
  // 之前架构 (delta 模式) 的根因缺陷:
  //   1. renderer 累积 dx/dy → IPC 推给 main → main 再累积一次 → main 内部维护 windowX/Y 缓存
  //      → 任何一处失准 = 永久累积误差, 不可恢复
  //   2. PS worker stdin 不 flush, 16ms 内多条命令堆积 → 中间帧位置丢失
  //   3. getPosition() 是异步的, 拿到的可能是过时值
  //   4. 节流逻辑 (8ms interval + pendingTimer) 进一步增加延迟, 让窗口落后于鼠标
  //
  // 新架构 (绝对坐标模式):
  //   - renderer 自己算: "窗口绝对位置 = mousedown 时的窗口位置 + 当前 clientX/Y - mousedown 时的 clientX/Y"
  //   - 每帧发 window:move-to(x, y), 走 psSend FIFO 同步等 ACK
  //   - main 端零状态: 不缓存窗口位置, 不累积 delta, 拿到 x/y 直接 SetWindowPos
  //   - 不再需要 window:move-begin / window:move-end (这是为了修复 delta 累积误差加的兜底, 现在不需要了)
  //
  // 为什么 FIFO 不会拖慢渲染:
  //   - SetWindowPos 是 OS 立即生效的 syscall, 本身 < 0.1ms
  //   - PS 进程 ReadLine → SetWindowPos → WriteLine OK → Flush, 全链路 ~0.5ms
  //   - 60Hz 帧间隔 = 16.67ms, 完全够用
  //   - FIFO 保证"绝对不会丢帧", 而非"延迟发送", 这是关键
  // ── 2026-07-04 主进程轮询模式 (根治 mousemove 事件风暴) ──────────
  // 旧方案: renderer mousemove → IPC → setPosition → 触发 resize → React 重渲染
  //   问题: 每秒 100+ 次 IPC 往返 + 整个 React 树重渲染 → 卡死 + 风扇起飞
  //
  // 新方案: renderer mousedown 时一次 IPC drag-start, mouseup 时一次 IPC drag-stop
  //   主进程用 setInterval(16ms) 自己读 screen.getCursorScreenPoint() + setPosition
  //   完全绕开渲染器 mousemove 事件 + 跨进程 IPC 往返
  //
  // ── 2026-07-04 PS Worker drag loop (根治 setInterval + Chromium IPC 延迟) ──
  //   优先路径: psSend('DRAG_START|hwnd|winX|winY|mouseX|mouseY')
  //     PS Worker 后台线程: tight loop Sleep(8) + GetCursorPos + SetWindowPos
  //     零 Node.js IPC, 零 Chromium IPC, 全在 OS 内核态
  //   Fallback: psWorker 未就绪时降级到 setInterval + screen.getCursorScreenPoint
  let dragTimer = null;
  let dragStartMouse = { x: 0, y: 0 };
  let dragStartWindow = { x: 0, y: 0 };
  let dragFrameCount = 0;
  let dragUsingPsWorker = false;

  // 通用 cleanup: 通知渲染器 + 恢复 canvasHost + 重应用反 snap
  const cleanupDragState = () => {
    dragActive = false;
    // 通知渲染器退出拖动状态 (恢复 backdrop-filter)
    try { mainWindow?.webContents?.send?.('drag-state', false); } catch {}
    // 恢复 canvasHostWindow 显示
    try {
      if (canvasHostWindow && !canvasHostWindow.isDestroyed()) {
        canvasHostWindow.show();
      }
    } catch {}
    // 拖动结束后重新应用一次反 snap 样式
    if (mainWindow && !mainWindow.isDestroyed()) {
      process.nextTick(() => {
        try { applyNoSnapFinal(mainWindow); } catch {}
      });
    }
    // 2026-07-06: 拖拽结束后, 如果 PS Worker 已死则重启
    if (!psWorker && process.platform === 'win32') {
      console.log('[ps-worker] 拖拽结束, 3秒后自动重启...');
      setTimeout(() => {
        if (!psWorker) startPsWorker();
      }, 3000);
    }
  };

  const stopDragFallback = () => {
    if (dragTimer) {
      clearInterval(dragTimer);
      dragTimer = null;
      if (dragFrameCount > 0) {
        console.log('[drag-fallback] stopped after %d frames', dragFrameCount);
      }
      dragFrameCount = 0;
    }
    // 2026-07-06: 无论 dragTimer 是否存在, 只要 dragActive 就清理
    if (dragActive) {
      cleanupDragState();
    }
  };

  ipcMain.handle('window:drag-start', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMinimized() || mainWindow.isFullScreen()) return false;
    // 先停掉可能残留的上一次拖动
    if (dragUsingPsWorker) {
      try { await psSend('DRAG_STOP', 'drag-stop-cleanup'); } catch {}
      dragUsingPsWorker = false;
    } else {
      stopDragFallback();
    }
    try {
      const b = mainWindow.getBounds();
      const p = screen.getCursorScreenPoint();
      dragStartWindow = { x: b.x, y: b.y };
      dragStartMouse = { x: p.x, y: p.y };
      dragFrameCount = 0;
      // 拖动期间禁用 reapplyNoSnap
      dragActive = true;
      // 通知渲染器进入拖动状态 (CSS 临时禁用 backdrop-filter)
      try { mainWindow.webContents.send('drag-state', true); } catch {}
      // 拖动期间隐藏 canvasHostWindow
      try {
        if (canvasHostWindow && !canvasHostWindow.isDestroyed()) {
          canvasHostWindow.hide();
        }
      } catch {}

      // 优先路径: PS Worker 后台线程 drag loop
      if (psWorker && psWorkerOk) {
        try {
          const hwnd = getHwndStr(mainWindow);
          await psSend(`DRAG_START|${hwnd}|${b.x}|${b.y}|${p.x}|${p.y}`, 'drag-start');
          dragUsingPsWorker = true;
          return true;
        } catch (e) {
          console.warn('[drag-start] PS Worker DRAG_START failed, fallback:', e?.message);
        }
      }

      // Fallback: setInterval + screen.getCursorScreenPoint (PS Worker 未就绪)
      dragUsingPsWorker = false;
      dragTimer = setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          stopDragFallback();
          return;
        }
        const cur = screen.getCursorScreenPoint();
        const nx = dragStartWindow.x + (cur.x - dragStartMouse.x);
        const ny = dragStartWindow.y + (cur.y - dragStartMouse.y);
        try {
          mainWindow.setPosition(Math.round(nx), Math.round(ny));
        } catch (e) {
          console.warn('[drag-fallback] setPosition:', e?.message);
          stopDragFallback();
        }
        dragFrameCount++;
      }, 8);
      return true;
    } catch (e) {
      console.warn('[drag-start]', e?.message);
      return false;
    }
  });

  ipcMain.handle('window:drag-stop', async () => {
    if (dragUsingPsWorker) {
      try {
        await psSend('DRAG_STOP', 'drag-stop');
      } catch (e) {
        console.warn('[drag-stop] PS Worker DRAG_STOP failed:', e?.message);
      }
      dragUsingPsWorker = false;
      cleanupDragState();
    } else {
      stopDragFallback();
    }
    return true;
  });

  // 保留 move-to 作为 fallback (调试/特殊场景), 但默认不走
  let moveDbgCount = 0;
  ipcMain.handle('window:move-to', async (_e, { x, y }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    try {
      mainWindow.setPosition(Math.round(x), Math.round(y));
      if (moveDbgCount < 3) console.log('[move-to#%d] fallback setPosition', moveDbgCount++);
      return true;
    } catch (e) {
      console.warn('[move-to]', e?.message);
      return false;
    }
  });

  // ── 2026-07-02 同步改造: resize 也走绝对坐标 + FIFO ──
  // edge: 'n'|'s'|'e'|'w'|'ne'|'nw'|'se'|'sw'
  // x, y, width, height: 期望的最终绝对坐标/尺寸 (renderer 算好后直接发)
  ipcMain.handle('window:resize-to', async (_e, { x, y, width, height }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMaximized() || mainWindow.isMinimized() || mainWindow.isFullScreen()) return false;
    const minW = 1024;
    const minH = 640;
    const rw = Math.max(minW, Math.round(width));
    const rh = Math.max(minH, Math.round(height));
    const rx = Math.round(x);
    const ry = Math.round(y);
    const hwnd = getHwndStr(mainWindow);
    if (!hwnd) {
      mainWindow.setBounds({ x: rx, y: ry, width: rw, height: rh });
      return true;
    }
    try {
      await psSend(`RESIZE|${hwnd}|${rx}|${ry}|${rw}|${rh}`, 'resize');
      return true;
    } catch (e) {
      console.warn('[resize-to]', e?.message);
      return false;
    }
  });

  // ── 2026-07-02 绝对坐标模式配套: 拿窗口当前位置 ──
  // renderer 在 mousedown 时调一次拿窗口当前屏幕位置, 之后 mousemove 完全用增量计算
  // 不维护任何状态, 不缓存, 纯透传
  ipcMain.handle('window:get-bounds', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    try {
      const b = mainWindow.getBounds();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    } catch (e) {
      return null;
    }
  });
}

// ────────────────────────────────────────────
// 2026 反 snap 工具集(模块级,被 registerIpc / app.whenReady 共享)
// 之前版本被误放进 registerIpc 内部 → ReferenceError → Electron 起不来
// 现在移到 registerIpc 之后、createWindow 之前,加 startPsWorker 做高频 SetWindowPos
// ────────────────────────────────────────────

// 异步执行 PowerShell(只用于启动时一次性调用,性能无所谓)
// 写 .ps1 临时文件再 -File 执行
// 注意:不能 spawnSync(在 Electron 主进程里 ETIMEDOUT),用 async exec
function execPsSync(script) {
  if (process.platform !== 'win32') return Promise.resolve('');
  const tmpDir = require('os').tmpdir();
  const tmpFile = path.join(tmpDir, `soloforge-ps-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.ps1`);
  // 头插 BOM 让 PS 正确识别 UTF-8
  const bom = '\uFEFF';
  fs.writeFileSync(tmpFile, bom + script, 'utf-8');
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`, {
      timeout: 30000, windowsHide: true, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpFile); } catch {}
      if (err) {
        const msg = err.message || String(err);
        console.warn('[ps] exec failed:', msg.slice(0, 500));
        if (stderr) console.warn('[ps] stderr:', stderr.toString().slice(0, 1500));
        if (stdout) console.warn('[ps] stdout:', stdout.toString().slice(0, 500));
        resolve('');
        return;
      }
      resolve(stdout.toString().trim());
    });
  });
}

function getHwndStr(window) {
  if (!window || window.isDestroyed()) return null;
  try {
    const buf = window.getNativeWindowHandle();
    if (buf.length >= 8) return buf.readBigInt64LE(0).toString();
    return buf.readInt32LE(0).toString();
  } catch (e) { return null; }
}

// ── 2026-07-05 窗口样式 → WS_POPUP (彻底移除非客户区) ──
//   核心反 snap: 将 GWL_STYLE 替换为 WS_POPUP
//   frame:false 不够: Chromium 内部 WM_NCHITTEST 仍返回 HTMAXBUTTON → snap flyout
//   WS_POPUP 完全无非客户区 → WM_NCHITTEST 不返回 HTMAXBUTTON → flyout 不出现
//   A) GWL_STYLE = WS_POPUP | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN
//   B) GWL_EXSTYLE |= WS_EX_APPWINDOW (任务栏可见)
//   C) DWM: 方角 + NC 渲染关闭
//   D) SetWindowPos 刷新
function applyNoSnapFinal(window) {
  if (process.platform !== 'win32') return;
  const hwnd = getHwndStr(window);
  if (!hwnd) return;

  const script = PS_WIN32 + `
$hwnd = [IntPtr]::new([Int64]${hwnd})

# === 核心反 snap: 将窗口样式替换为 WS_POPUP ===
#   frame:false 不够: Chromium 内部的 WM_NCHITTEST 处理器仍然为右上角返回 HTMAXBUTTON,
#   触发 Windows 11 snap layout flyout (白色尺寸浮动块)
#   WS_POPUP 完全没有非客户区 → WM_NCHITTEST 不会返回 HTMAXBUTTON → flyout 不出现
#   保留 WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN
$WS_POPUP        = 0x80000000
$WS_VISIBLE      = 0x10000000
$WS_CLIPSIBLINGS = 0x04000000
$WS_CLIPCHILDREN = 0x02000000
$oldStyle = [W32]::GetWindowLong($hwnd, -16)
$newStyle = $WS_POPUP -bor $WS_VISIBLE -bor $WS_CLIPSIBLINGS -bor $WS_CLIPCHILDREN
[W32]::SetWindowLong($hwnd, -16, $newStyle) | Out-Null
$styleOut = "STYLE=0x$($oldStyle.ToString('X8'))->0x$($newStyle.ToString('X8'))"

# === GWL_EXSTYLE: 确保 WS_EX_APPWINDOW (任务栏可见) ===
$APP  = 0x40000
$oldEx = [W32]::GetWindowLong($hwnd, -20)
$newEx = $oldEx -bor $APP
[W32]::SetWindowLong($hwnd, -20, $newEx) | Out-Null
$exOut = "EX=0x$($oldEx.ToString('X8'))->0x$($newEx.ToString('X8'))"

# === DWM: 方角 + NC 渲染关闭 ===
$policy1 = 1
$policy4 = 2
$dwmRet1 = [W32]::DwmSetWindowAttribute($hwnd, 2,  [ref]$policy1, 4)
$dwmRet4 = [W32]::DwmSetWindowAttribute($hwnd, 33, [ref]$policy4, 4)
$dwmOut = "DWM_NCR=$dwmRet1,CORNER=$dwmRet4"

# === SetWindowPos 刷新 ===
$SWP = 0x0001 -bor 0x0002 -bor 0x0004 -bor 0x0010 -bor 0x0400
$swpRet = [W32]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, 0, 0, $SWP)
$swpOut = "SWP=$swpRet"

Write-Output "$styleOut; $exOut; $dwmOut; $swpOut"
`;
  execPsSync(script).then((out) => {
    if (out) console.log('[dwm-style]', out);
  });
}

// 2026-07-04 拖动期间禁用 reapplyNoSnap 的标志
let dragActive = false;

// 2026-07-05: 样式只需应用一次, 不再在每次 move/resize 时重新应用
//   之前每次 move/resize 都 spawn 一个新 PowerShell 进程 → 启动时十几个进程 → 拖动卡
//   SetWindowLong 设的样式会持久保持, 不需要反复重设
let _styleApplied = false;
function reapplyNoSnap() {
  if (process.platform !== 'win32') return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (dragActive) return;
  if (mainWindow.isMinimized()) return;
  if (_styleApplied) return;  // 已应用过, 跳过
  setImmediate(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
      applyNoSnapFinal(mainWindow);
      _styleApplied = true;
    }
  });
}

// ── 2026 持久 PowerShell 进程(高频 SetWindowPos 用) ──
//
// 【2026-07-02 抖动修复 - 同步 FIFO + ACK 协议】
// 之前架构: Node 端 stdin.write 不 flush, PS 端 ReadLine + SetWindowPos 都是异步
//   → 多条命令堆积在 Node 内部 buffer / PS 进程 stdin 里
//   → PS 一次执行多条 SetWindowPos, 但窗口只显示最后一条的位置
//   → 中间帧完全丢失 → 看到的就是"跳到错误位置" / "抖动"
//
// 新架构 - 同步 FIFO:
//   1. PS 端每次 ReadLine 拿到命令 → 执行 SetWindowPos → 回写 "OK\n" 到 stdout → 才读下一行
//   2. Node 端用 ackWaiters 队列维护"等 ACK 的请求列表", 每收到一行 OK 就 resolve 队首
//   3. Node 端写命令前检查 ackWaiters 是否为空, 不空就 push 到 pendingCommands 队列等待
//   4. 这样保证:
//      - 同一时刻只有 1 条命令在执行 (FIFO)
//      - 命令执行完才发下一条 (不堆积)
//      - 调用方 await ipc 能精确知道"这条已生效" (可做后续逻辑)
//   5. 由于 SetWindowPos 本身是 OS 立即生效的 (返回 BOOL 即完成), ACK 协议本身开销 ~0.05ms
//
// 输入协议 (1 行):
//   MOVE|x|y     → SetWindowPos(...X=x, Y=y, SWP_NOSIZE|NOZORDER|NOACTIVATE|NOSENDCHANGING = 0x0415)
//   RESIZE|x|y|w|h → SetWindowPos(X=x, Y=y, cx=w, cy=h, SWP_NOZORDER|NOACTIVATE|NOSENDCHANGING = 0x0414)
//   QUIT          → PS 进程退出
//
// 输出: 成功执行完一条写一行 "OK\n", Node 端按行解析触发对应 waiter resolve
let psWorker = null;
let psWorkerOk = false;
let psWorkerStdinReady = true;  // FIFO 状态: true = 可以写下一条
const ackWaiters = [];          // [{resolve, reject, timer, label}]
let pendingCommands = [];       // [{line, resolve, reject, label}] 等待 FIFO 槽位的命令

function startPsWorker() {
  if (process.platform !== 'win32') return;
  if (psWorker) return;
  // PS 端逻辑:
  //   while(true) { ReadLine → 解析命令 → SetWindowPos → Console.Out.WriteLine("OK") → flush }
  // 用 [Console]::Out.Flush() 强制立即把 OK 推给 Node 端 (避免 .NET 默认缓冲)
  const psCode = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WSet {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("kernel32.dll")] public static extern uint GetLastError();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] public static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong32(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern IntPtr CallWindowProc(IntPtr lpPrevWndFunc, IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  public delegate IntPtr WndProcDelegate(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public struct POINT { public int X; public int Y; }
  public static IntPtr OriginalWndProc = IntPtr.Zero;
  public static WndProcDelegate HookDelegate;
  public static IntPtr HookedHwnd = IntPtr.Zero;
  public static IntPtr HookedWndProc(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam) {
    if (Msg == 0x0084) {
      IntPtr result = CallWindowProc(OriginalWndProc, hWnd, Msg, wParam, lParam);
      if (result.ToInt64() == 9) return new IntPtr(1);
      return result;
    }
    return CallWindowProc(OriginalWndProc, hWnd, Msg, wParam, lParam);
  }
  public static IntPtr DoSetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong) {
    if (IntPtr.Size == 8) return SetWindowLongPtr64(hWnd, nIndex, dwNewLong);
    return new IntPtr(SetWindowLong32(hWnd, nIndex, dwNewLong.ToInt32()));
  }
  public static bool InstallHook(IntPtr hWnd) {
    if (HookedHwnd != IntPtr.Zero) return false;
    HookDelegate = new WndProcDelegate(HookedWndProc);
    IntPtr funcPtr = Marshal.GetFunctionPointerForDelegate(HookDelegate);
    OriginalWndProc = DoSetWindowLongPtr(hWnd, -4, funcPtr);
    HookedHwnd = hWnd;
    uint err = GetLastError();
    System.Console.Error.WriteLine("InstallHook: funcPtr=" + funcPtr + " origProc=" + OriginalWndProc + " err=" + err + " ptrSize=" + IntPtr.Size);
    return OriginalWndProc != IntPtr.Zero;
  }
}
'@
[Console]::Out.WriteLine("READY")
[Console]::Out.Flush()
$moveCount = 0
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if ($line -eq 'QUIT') { break }
  $parts = $line.Split('|')
  if ($parts.Count -lt 2) { [Console]::Out.WriteLine("ERR_BAD_CMD"); [Console]::Out.Flush(); continue }
  try {
    $cmd = $parts[0]
    $hwnd = [IntPtr]::new([Int64]$parts[1])
    $isWin = [WSet]::IsWindow($hwnd)
    if ($cmd -eq 'PING') {
      $rect = New-Object WSet+RECT
      $gr = [WSet]::GetWindowRect($hwnd, [ref]$rect)
      [Console]::Out.WriteLine("PONG hwnd=$hwnd IsWindow=$isWin GetRect=$gr L=$($rect.Left) T=$($rect.Top) R=$($rect.Right) B=$($rect.Bottom) LastErr=" + [WSet]::GetLastError())
      [Console]::Out.Flush()
      continue
    }
    if ($cmd -eq 'SUBCLASS') {
      # 安装子类化 WindowProc, 拦截 WM_NCHITTEST
      $ok = [WSet]::InstallHook($hwnd)
      [Console]::Out.WriteLine("OK SUBCLASS installed=$ok hwnd=$hwnd")
      [Console]::Out.Flush()
      continue
    }
    if ($cmd -eq 'MOVE') {
      $x = [int]$parts[2]
      $y = [int]$parts[3]
      # SWP_NOSIZE(0x0001) | SWP_NOZORDER(0x0004) | SWP_NOACTIVATE(0x0010) | SWP_NOSENDCHANGING(0x0400) = 0x0415
      $ret = [WSet]::SetWindowPos($hwnd, [IntPtr]::Zero, $x, $y, 0, 0, 0x0415)
      # 前 3 次打印详细信息: SetWindowPos 返回值 + GetLastError + 实际窗口位置
      if ($moveCount -lt 3) {
        $rect2 = New-Object WSet+RECT
        $gr2 = [WSet]::GetWindowRect($hwnd, [ref]$rect2)
        $err = [WSet]::GetLastError()
        [Console]::Out.WriteLine("OK MOVE ret=$ret LastErr=$err IsWindow=$isWin AfterMove L=$($rect2.Left) T=$($rect2.Top) R=$($rect2.Right) B=$($rect2.Bottom)")
        [Console]::Out.Flush()
        $moveCount++
        continue
      }
    } elseif ($cmd -eq 'RESIZE') {
      $x = [int]$parts[2]
      $y = [int]$parts[3]
      $w = [int]$parts[4]
      $h = [int]$parts[5]
      [WSet]::SetWindowPos($hwnd, [IntPtr]::Zero, $x, $y, $w, $h, 0x0414) | Out-Null
    } elseif ($cmd -eq 'DRAG_START') {
      # 参数: DRAG_START|hwnd|startWinX|startWinY|startMouseX|startMouseY
      # 用 $script: 作用域存参数, 确保后台线程闭包能安全访问
      $script:dragHwnd = $hwnd
      $script:dragStartWinX = [int]$parts[2]
      $script:dragStartWinY = [int]$parts[3]
      $script:dragStartMouseX = [int]$parts[4]
      $script:dragStartMouseY = [int]$parts[5]
      $script:dragStopFlag = $false
      $dragThread = [System.Threading.Thread]::new([System.Threading.ThreadStart]{
        # 后台线程: tight loop — GetCursorPos + SetWindowPos, ~120Hz
        # 零 Node.js IPC, 零 Chromium IPC, 全在 OS 内核态完成
        try {
          while (-not $script:dragStopFlag) {
            [System.Threading.Thread]::Sleep(8)
            $pt = New-Object WSet+POINT
            [void][WSet]::GetCursorPos([ref]$pt)
            $dx = $pt.X - $script:dragStartMouseX
            $dy = $pt.Y - $script:dragStartMouseY
            [void][WSet]::SetWindowPos($script:dragHwnd, [IntPtr]::Zero, ($script:dragStartWinX + $dx), ($script:dragStartWinY + $dy), 0, 0, 0x0415)
          }
        } catch {}
      })
      $dragThread.IsBackground = $true
      $dragThread.Start()
      $script:dragThreadRef = $dragThread
      # 立即回 OK 释放 FIFO 槽位, drag loop 在后台线程继续
      [Console]::Out.WriteLine("OK")
      [Console]::Out.Flush()
      continue
    } elseif ($cmd -eq 'DRAG_STOP') {
      $script:dragStopFlag = $true
      if ($script:dragThreadRef) {
        $script:dragThreadRef.Join(500) | Out-Null
        $script:dragThreadRef = $null
      }
    }
    [Console]::Out.WriteLine("OK")
    [Console]::Out.Flush()
  } catch {
    [Console]::Out.WriteLine("ERR " + $_.Exception.Message)
    [Console]::Out.Flush()
  }
}
`;
  const encoded = Buffer.from(psCode, 'utf16le').toString('base64');
  const { spawn } = require('child_process');
  try {
    psWorker = spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    // PS stdout 按行解析, 每行 "READY" / "OK" / "ERR" 触发对应处理
    let stdoutBuf = '';
    psWorker.stdout.on('data', (d) => {
      stdoutBuf += d.toString('utf-8');
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        // 2026-07-04 修复: 第一行 "READY" 是 worker 启动信号, 不是命令 ACK
        if (line === 'READY' && !psWorkerOk) {
          psWorkerOk = true;
          psWorkerStdinReady = true;
          console.log('[ps-worker] READY received (FIFO mode, Add-Type compiled)');
          // 启动期间堆积的命令现在可以发了
          drainPending();
          continue;
        }
        const waiter = ackWaiters.shift();
        if (!waiter) {
          // 没有 waiter 在等 (说明这条是初始化期间的残余), 忽略
          // 2026-07-04 诊断: 打印出来便于观察 PS 端详细输出
          console.log('[ps-worker unsolicited]', line);
          continue;
        }
        clearTimeout(waiter.timer);
        // 2026-07-04: PS 端 MOVE 前 3 次会返回 "OK MOVE ret=... LastErr=... AfterMove..."
        // 把详细日志打印到主进程 stdout, 然后 resolve waiter
        if (line.startsWith('OK')) {
          if (line !== 'OK') console.log('[ps-worker detail]', line);
          waiter.resolve(line);
        } else if (line.startsWith('PONG')) {
          console.log('[ps-worker PONG]', line);
          waiter.resolve(line);
        } else {
          console.warn('[ps-worker ERR]', line);
          waiter.reject(new Error(line));
        }
      }
      // FIFO 槽位空出来了, 发下一条 pending 命令
      drainPending();
    });
    psWorker.stderr.on('data', (d) => {
      // 2026-07-04 诊断: 不 trim, 显示完整 CLIXML 错误
      const msg = d.toString('utf-8');
      console.warn('[ps-worker stderr RAW]', JSON.stringify(msg.slice(0, 500)));
    });
    psWorker.on('exit', (code) => {
      console.log('[ps-worker] exited code=' + code);
      // reject 所有在等的 waiter
      while (ackWaiters.length) {
        const w = ackWaiters.shift();
        clearTimeout(w.timer);
        w.reject(new Error('ps-worker exited'));
      }
      psWorker = null;
      psWorkerOk = false;
      psWorkerStdinReady = true;
      // 2026-07-05: 自动重启 PS Worker (3秒后, 避免频繁重启)
      // 2026-07-06: 移除 !dragActive 条件 — 即使在拖拽中崩溃也要重启
      //   (拖拽用的是 fallback setInterval, PS Worker 重启不会干扰)
      if (code !== 0) {
        console.log('[ps-worker] 3秒后自动重启...');
        setTimeout(() => {
          if (!psWorker) {
            startPsWorker();
          }
        }, 3000);
      }
    });
    psWorker.on('error', (e) => {
      console.warn('[ps-worker] spawn error:', e.message);
      psWorker = null;
      psWorkerOk = false;
    });
    // 2026-07-04 修复: 不再用 setTimeout(200ms) 标记 ready
    // Add-Type 编译 C# 代码可能要 1-2s, 期间发的命令会堆积在 PS stdin,
    // 第一条执行后回 OK, 但已有大量命令堆积, FIFO 卡死
    // 现在: psWorkerOk 由 stdout 收到 "READY" 信号时设置
    // 兜底: 5s 后还没 READY, 标记为失败, 让 psSend reject
    const readyTimeout = setTimeout(() => {
      if (!psWorkerOk) {
        console.warn('[ps-worker] READY timeout (5s), Add-Type 可能失败');
        // 强制标记为 ready 让 drainPending 能尝试 (会失败但能产生错误日志)
        psWorkerOk = false;
      }
    }, 5000);
    // 清理 readyTimeout 在 exit handler 里
    psWorker.once('exit', () => clearTimeout(readyTimeout));
  } catch (e) {
    console.warn('[ps-worker] spawn failed:', e.message);
    psWorker = null;
  }
}

// FIFO 槽位有空闲 → 发 pending 队列里的下一条
function drainPending() {
  if (!psWorker || !psWorkerOk) return;
  if (!psWorkerStdinReady) return;
  if (pendingCommands.length === 0) return;
  const next = pendingCommands.shift();
  psWorkerStdinReady = false;
  ackWaiters.push({
    resolve: next.resolve,
    reject: next.reject,
    timer: setTimeout(() => {
      // ACK 超时 (默认 2s) - 这种情况基本意味着 PS 进程僵死
      // 把这个 waiter 从队列里摘掉, 后续 ACK 来时不会错误 resolve
      const i = ackWaiters.indexOf(next);
      // 注意: 此时 ackWaiters 里这个已经被 shift 出去了 (因为我们在 push 之前就 shift 了 next),
      // 实际超时处理是 reject caller, 但不破坏 FIFO 槽位
      console.warn('[ps-worker] ACK timeout:', next.label);
      psWorkerStdinReady = true;
      next.reject(new Error('ACK timeout'));
      // 尝试恢复: 发下一条 pending
      drainPending();
    }, 2000),
    label: next.label,
  });
  // 写入 stdin. 必须 flush - Node 端 pipe 默认有 buffer.
  // 对于 spawn 的 pipe, write() 返回 false 时要监听 drain 事件.
  // 这里我们靠 PS 端的 ACK 协议保证不堆积, 不需要 Node 端 drain.
  try {
    const written = psWorker.stdin.write(next.line + '\n');
    if (next.label === 'move') {
      console.log('[ps-send] line=%s, writeReturn=%s, ackWaiters=%d, pending=%d', next.line, written, ackWaiters.length, pendingCommands.length);
    }
  } catch (e) {
    // 写入失败 (管道断了) - reject waiter + 恢复 FIFO
    const w = ackWaiters.shift();
    if (w) {
      clearTimeout(w.timer);
      w.reject(e);
    }
    psWorkerStdinReady = true;
  }
}

// 发送一条命令到 PS worker, 返回 Promise (resolve = PS 已执行完)
function psSend(cmd, label = 'cmd') {
  return new Promise((resolve, reject) => {
    if (!psWorker || !psWorkerOk) {
      reject(new Error('ps-worker not ready'));
      return;
    }
    pendingCommands.push({ line: cmd, resolve, reject, label });
    drainPending();
  });
}

function psSetWindowPos(hwnd, x, y, w, h, flags) {
  // 这个旧函数保留以兼容现有调用, 但实际不再使用 (所有 SetWindowPos 都走 psSend)
  // 真正的 drag/resize 走 psSend('MOVE|...') 或 psSend('RESIZE|...')
  return false;
}

function createWindow() {
  // 应用图标: 使用 build/icon/icon-666.png (256x256 高清版)
  const iconPath = path.join(__dirname, '..', 'build', 'icon', 'icon-666.png');
  const appIcon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : null;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    // ── 2026-07-05 最终方案: titleBarStyle:'hidden' (无 overlay) ──
    //
    // 根因: frame:false 时 Chromium 硬编码 WM_NCHITTEST 返回 HTMAXBUTTON,
    //   触发 Windows 11 snap layout flyout。跨进程拦截得到 ACCESS_DENIED。
    //
    // titleBarStyle:'hidden' (无 titleBarOverlay):
    //   - 系统处理 WM_NCHITTEST (不是 Chromium)
    //   - maximizable:false → WS_MAXIMIZEBOX 不被加入 → 系统不返回 HTMAXBUTTON → 无 snap flyout
    //   - 不画系统按钮 (无 overlay) → 三个按钮全部自绘 (跟之前 frame:false 一样)
    //   - 自定义拖动: -webkit-app-region: drag (已有)
    titleBarStyle: 'hidden',
    backgroundColor: '#050505',
    hasShadow: false,
    minimizable: true,
    maximizable: false,
    resizable: true,
    fullscreenable: true,
    paintWhenInitiallyHidden: true,
    icon: appIcon || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 任务栏图标兜底 (Windows 任务栏 + macOS Dock)
  if (appIcon && !appIcon.isEmpty()) {
    try { mainWindow.setIcon(appIcon); } catch {}
  }

  // 2026-07-02 修复"强制刷新看到几个版本前的代码"问题:
  //   file:// 协议没有 Cache-Control 响应头,Chromium 把 dist/ 下的 JS/CSS
  //   硬缓存到磁盘,Ctrl+Shift+R 也清不掉。加 mtime 时间戳作 query 强制绕开
  //   内存缓存 + clearCache() 兜底清掉之前的磁盘缓存。
  if (isDev) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    console.log(`[electron] ▶ renderer loadURL: ${DEV_URL} (isDev=${isDev})`);
  } else {
    const distIndex = path.join(__dirname, '..', 'dist', 'index.html');
    const mtime = fs.existsSync(distIndex)
      ? fs.statSync(distIndex).mtimeMs
      : Date.now();
    mainWindow.loadFile(distIndex, { query: { v: mtime } });
    console.log(`[electron] ▶ renderer loadFile: ${distIndex}?v=${mtime} (isDev=${isDev})`);
  }
  // 创建窗口时立即清一次缓存,把上一版本的 dist/ 残留从磁盘清掉
  try { mainWindow.webContents.session.clearCache(); } catch {}

  // 2026-07-05: frame:false + 实色背景, 刷新时 native 窗口自带深色底, 无黑屏。
  //   executeJavaScript 涂深色背景让旧页面最后一帧 persist (双重保险)。
  mainWindow.webContents.on('did-start-loading', () => {
    mainWindow.webContents.executeJavaScript(
      `try{document.documentElement.style.setProperty('background','#050505','important');` +
      `document.body&&document.body.style.setProperty('background','#050505','important');}catch(e){}`
    ).catch(() => {});
  });

  // 2026-07-02 调试日志:确认 renderer 真正加载的 URL(诊断"看到的还是旧 UI")
  mainWindow.webContents.on('did-finish-load', () => {
    console.log(`[electron] ★ renderer 真正加载的 URL: ${mainWindow.webContents.getURL()}`);
  });
  mainWindow.webContents.on('did-fail-load', (_, code, desc, url) => {
    console.error(`[electron] ✗ renderer 加载失败: ${url} (${code} ${desc})`);
  });

  // ready-to-show:页面首次渲染完成后才显示窗口(避免闪烁)
  // 实际 show 逻辑放到 app.whenReady 里(包含 DWM 关闭非客户区渲染的副作用)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // ── 渲染进程崩溃恢复 ──────────────────────────────────────────
  // 2026-07-07: 用户反馈"过一会黑屏" — 渲染进程可能因 GPU 崩溃或 OOM 被杀。
  // 监听 render-process-gone 事件, 自动重载页面而非显示黑屏。
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[electron] 渲染进程崩溃:', details.reason, details.exitCode);
    // 给用户一秒看到日志, 然后重载
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('[electron] 尝试重载渲染进程...');
        mainWindow.webContents.reload();
      }
    }, 1000);
  });

  mainWindow.on('unresponsive', () => {
    console.warn('[electron] 渲染进程无响应, 等待恢复...');
    // 不强制杀掉, 给用户机会保存数据。10 秒后如果仍无响应才重载。
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isResponsive()) {
        console.warn('[electron] 渲染进程 10 秒后仍无响应, 强制重载');
        mainWindow.webContents.reload();
      }
    }, 10_000);
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

// 2026 终极反 snap Chromium switches
// 列出能想到的、所有跟 Windows 11 snap/overlay/window-management 相关的 feature
// 即使不知道哪个能命中,一起 disable 也无害
if (process.platform === 'win32') {
  try {
    app.commandLine.appendSwitch(
      'disable-features',
      [
        'WindowsScrollingPersonality',
        'OverlayScrollbar',
        'WindowsSystemLocationProvider',
        'DialogObserver',
        'HardwareMediaKeyHandling',
        'LiveCaption',
        'SystemNotificationProviders',
        'WebOTP',
        'Translate',
        'InfiniteSessionRestore',
        'SnapLayouts',                  // Win11 snap layouts
        'SnapAssist',                   // Win11 snap assist 分屏建议
        'WindowOcclusion',              // DWM occlusion 跟踪
        'CalculateNativeWinOcclusion',  // Chromium 自己算 occlusion,snap 检测会用到
        'DesktopCaptureMacV2',          // (无关但无害)
        'EnableOopRasterization',       // 关 OOP raster,减少 DWM 协同
        'SurfaceControl',               // 关 surface control,走老 GDI
        'MojoIpcz',                     // 关 MojoIpcz(IPC 优化,可能跟 snap 无关)
        'NotificationTriggers',         // (无关但无害)
        'SystemTray',                   // (无关但无害)
        'TaskManager',                  // (无关但无害)
        'PwaAdditionalWindowControls',  // PWA 窗口控制
        'WebAppWindowControlsOverlay',  // PWA 窗口控制 overlay
        'DesktopPWAsRunOnOsLogin',      // PWA 开机启动
        'WebAppEnableSceneController',  // 关 PWA scene controller
      ].join(',')
    );
    // 防止后台渲染降频(可以防止窗口被 explorer 视为"非活动"导致 snap state 重置)
    app.commandLine.appendSwitch('disable-renderer-backgrounding');
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
    app.commandLine.appendSwitch('disable-background-timer-throttling');
    // 禁止 Windows 11 多指/触控的 snap 行为
    app.commandLine.appendSwitch('disable-pinch');
    // 强制使用 IME 默认值(可能与 snap 无关,但减少 OS 干预)
    app.commandLine.appendSwitch('disable-features', 'InputEventOnAnimationFrame');
  } catch (e) { /* ignore */ }
}

// ── 主进程入口 ──
app.whenReady().then(() => {
  // 2026-07-02 修复"强制刷新看到几个版本前的代码"问题(方案 C,根因修复):
  //   原 isDev = process.defaultApp || !app.isPackaged 在某些启动场景下
  //   会走到 false 分支 → loadFile('dist/index.html') → file:// 协议无
  //   Cache-Control 响应头 → Chromium 硬缓存 dist/ 的 JS/CSS 到磁盘,
  //   Ctrl+Shift+R 也清不掉 → 用户看到几个版本前的代码。
  //   强制 isDev = true → 永远走 Vite dev server (3000) → 走 HTTP 协议,
  //   有正常 Cache-Control + HMR → 永远拿到最新源码,不再有缓存问题。
  //   如果未来要打 release 包,需要在 electron-builder 打包前把这一行
  //   改回原表达式(并提供环境变量开关覆盖,例如 SOLOFORGE_FORCE_DEV)。
  isDev = true;
  if (process.env.SOLOFORGE_FORCE_PROD === '1') {
    isDev = process.defaultApp || !app.isPackaged;
    console.log('[electron] SOLOFORGE_FORCE_PROD=1, 走 dist/ 产物');
  } else {
    console.log('[electron] 强制 dev 模式 → Vite dev server (3000),绕过 file:// 缓存');
  }
  applyCsp();
  setupApiProxy();

  // 2026-07-02 修复"强制刷新看到几个版本前的代码"问题:
  //   Electron renderer 在 user-data-dir 写了一大堆磁盘缓存
  //   (Code Cache 295MB / Cache 55MB / GPUCache),这些是 Chromium 编译过的 JS
  //   字节码,即使走 HTTP 协议 3000,Chromium 也会优先复用本地字节码 →
  //   用户看到旧版 UI。
  //   启动时清全部缓存 + dev 模式禁用磁盘 HTTP cache,让 Vite HMR 永远拿最新 JS。
  //   fire-and-forget(不 await):createWindow 不阻塞,清缓存失败也不会让窗口打不开。
  //   注意:session.clearCache() / clearStorageData 都不删 Code Cache(那是 V8 字节码
  //   缓存,Chromium 不在 session API 里暴露),必须用 fs.rm 直接删 user-data-dir。
  Promise.all([
    session.defaultSession.clearCache().catch((e) => console.warn('[electron] clearCache:', e?.message)),
    session.defaultSession.clearStorageData({
      storages: ['shadercache', 'cachestorage', 'serviceworkers'],
    }).catch((e) => console.warn('[electron] clearStorageData:', e?.message)),
  ]).then(() => {
    console.log('[electron] ✓ session 缓存已清');
  });

  // ★ 直接删 user-data-dir 里的所有持久化数据 (绕过 session API 限制)
  //   session.clearCache() / clearStorageData() 都不删 localStorage / IndexedDB
  //   (它们用的是不同的 storage backend),必须用 fs.rm 直接删 user-data-dir
  //   这里包括:
  //   - Code Cache / Cache / GPUCache: V8 字节码 / HTTP 缓存
  //   - Local Storage / Session Storage: React zustand persist 用,旧 store 数据锁住 UI
  //   - IndexedDB: 大对象持久化(canvas session / chats / 历史)
  //   - WebStorage: 同 Local Storage 的另一种存储
  //   - settings-store.json: 如果有 Electron 主进程写入的设置
  try {
    const userDataDir = app.getPath('userData');
    const targets = [
      'Code Cache', 'Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
      'Local Storage', 'Session Storage', 'IndexedDB', 'WebStorage',
      'Service Worker', 'Service Worker Database', 'Shared Dictionary',
      'File System', 'blob_storage', 'Network',
      'settings-store.json',
    ];
    let deletedCount = 0;
    for (const sub of targets) {
      const p = path.join(userDataDir, sub);
      if (fs.existsSync(p)) {
        try {
          fs.rmSync(p, { recursive: true, force: true });
          deletedCount++;
        } catch (e) {
          // 文件可能被 Chromium 持有,跳过(Electron 退出后会再清一次)
          console.warn(`[electron] 清 ${sub} 失败(可能在用):`, e?.message);
        }
      }
    }
    if (deletedCount > 0) {
      console.log(`[electron] ✓ 已删 ${deletedCount} 个 user-data-dir 目录(Code Cache / Local Storage / IndexedDB ...)`);
    } else {
      console.log(`[electron] user-data-dir 无缓存需清`);
    }
  } catch (e) {
    console.warn('[electron] 清 user-data-dir 失败:', e?.message);
  }
  buildMenu();

  // 2026: 启动持久 PS worker(drag/resize 高频 SetWindowPos 用)
  startPsWorker();

  createWindow();                  // 先创建主窗口
  createCanvasHostWindow(mainWindow); // 再以主窗口为 parent 创建画布宿主 → OS 自动管 z-order

  // 2026-07-05: titleBarStyle:'hidden' + titleBarOverlay 让系统处理 WM_NCHITTEST
  //   不需要 applyNoSnapFinal (WS_POPUP hack) 或 SUBCLASS (跨进程拦截)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
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
  // 清理所有画布进程 + 看门狗
  for (const [, s] of canvasSessions) {
    stopWatchdog(s);
    if (s.process && !s.process.killed) killProcessTree(s.process);
  }
  canvasSessions.clear();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const [, s] of canvasSessions) {
    stopWatchdog(s);
    if (s.process && !s.process.killed) killProcessTree(s.process);
  }
});
