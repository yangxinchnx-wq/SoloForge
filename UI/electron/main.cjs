// ─────────────────────────────────────────────────────────────────
// SoloForge Electron 主进程
// 入口：package.json "main" 指向本文件
//
// dev 模式: 开发者手动启动 `npm run dev` (Vite + Node.js 3000)
//           Electron 从 http://localhost:3000 加载前端, HMR 默认启用
//           (设置 DISABLE_HMR=true 可禁用),用户通过 Ctrl+R / F5 / UI 按钮手动重载
//
// prod 模式: Electron 自动拉起所有后端服务 (UI Server 3000 + RACER 3001
//            + Garnet 6379 + git-service 3002), 从 dist/index.html 加载
// ─────────────────────────────────────────────────────────────────

// ★ 2026-07-11: 必须在 require('electron') 之前清除 ELECTRON_RUN_AS_NODE
//   CatPaw IDE / TRAE SOLO CN 等宿主环境会设置此变量, 导致 Electron 以纯 Node.js 模式运行
//   → sandbox 渲染器崩溃: "Cannot destructure property 'preloadScripts' of 'binding.startupData' as it is null"
//   清除后 Electron 才能正常以主进程模式启动
// ★ 2026-07-17: 必须无条件 delete, 不能用 if (process.env.ELECTRON_RUN_AS_NODE)
//   原因: Windows 上空字符串 "" 仍被视为"已设置", truthy 检查会漏掉
//   ELECTRON_RUN_AS_NODE= → if 判定为 false → 不删除 → 渲染器仍崩溃
delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.ELECTRON_NO_ATTACH_CONSOLE;

const { app, BrowserWindow, shell, Menu, session, ipcMain, nativeImage, screen, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');

// ── Proxy Service（网络代理管理） ──
const { ProxyService } = require('./proxy-service.cjs');
const proxyService = new ProxyService();

// ── Local LLM Manager（本地大模型管理, v2: node-llama-cpp） ──
const localLLM = require('./local-llm-manager.cjs');
localLLM.init();

// dev 模式: Vite dev server (3000) + 外部独立后端
// prod 模式: Electron 自动启动所有服务
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:3000';
const BACKEND_URL = process.env.SOLOFORGE_BACKEND_URL || 'http://localhost:3001';

let isDev = false;
let mainWindow = null;

  // ── 生产模式服务管理 ──────────────────────────────────────────
  // 打包后 Electron 需要自动拉起所有后端进程
  const spawnedChildren = [];

/**
 * 在生产模式下启动所有必要的后端服务 (分阶段, 确保依赖顺序)
 * 1. Garnet (6379) — 无依赖
 * 2. SurrealDB (8400) — 无依赖
 * 3. git-service (3002) — 无依赖
 * 4. RACER Core (3001) — 依赖 Garnet + SurrealDB
 * 5. UI Server (3000) — 依赖 RACER Core
 */
async function startProductionServices() {
    if (isDev) return; // dev 模式下服务由 npm run dev 管理

    const resourcesPath = process.resourcesPath || path.resolve(__dirname, '..');
    const appPath = app.getAppPath();

    // 创建 RACER Core 需要的运行时目录
    const runtimeDirs = [
      path.join(resourcesPath, 'data', 'soloforge_vault'),
      path.join(resourcesPath, 'data', 'jsonl', 'archive'),
      path.join(resourcesPath, 'data', 'soloforge_db'),
      path.join(resourcesPath, 'logs'),
    ];
    for (const dir of runtimeDirs) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    // ── 阶段 1: 启动无依赖的基础服务 ──

  // ── 1a. 启动 Garnet (6379) ──
  const garnetExe = path.join(resourcesPath, 'garnet', 'GarnetServer.exe');
  if (fs.existsSync(garnetExe)) {
    console.log('[services] Starting Garnet (6379)...');
    const garnet = spawn(garnetExe, ['--port', '6379'], {
      cwd: path.dirname(garnetExe),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    garnet.stdout?.on('data', (d) => process.stdout.write(`[garnet] ${d}`));
    garnet.stderr?.on('data', (d) => process.stderr.write(`[garnet] ${d}`));
    garnet.on('exit', (code) => console.warn(`[garnet] exited with code ${code}`));
    spawnedChildren.push(garnet);
    await waitForPort(6379, 10000).then(ok => console.log(ok ? '[services] ✓ Garnet ready' : '[services] ✗ Garnet timeout'));
  } else {
    console.warn('[services] Garnet not found at', garnetExe, '— running without Garnet (degraded mode)');
  }

  // ── 1b. 启动 SurrealDB (8400) ──
  const surrealExe = path.join(resourcesPath, 'bin', 'surreal.exe');
  if (fs.existsSync(surrealExe)) {
    const surrealDataDir = path.join(resourcesPath, 'surreal_data');
    if (!fs.existsSync(surrealDataDir)) fs.mkdirSync(surrealDataDir, { recursive: true });
    console.log('[services] Starting SurrealDB (8400)...');
    const surreal = spawn(surrealExe, [
      'start',
      '--bind', '0.0.0.0:8400',
      '--user', 'root',
      '--pass', 'root',
      `rocksdb:${surrealDataDir}`,
    ], {
      cwd: path.dirname(surrealExe),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    surreal.stdout?.on('data', (d) => process.stdout.write(`[surreal] ${d}`));
    surreal.stderr?.on('data', (d) => process.stderr.write(`[surreal] ${d}`));
    surreal.on('exit', (code) => console.warn(`[surreal] exited with code ${code}`));
    spawnedChildren.push(surreal);
    await waitForPort(8400, 10000).then(ok => console.log(ok ? '[services] ✓ SurrealDB ready' : '[services] ✗ SurrealDB timeout'));
  } else {
    console.warn('[services] SurrealDB not found at', surrealExe, '— persistence will fail');
  }

  // ── 1c. 启动 git-service (3002) ──
  const gitExe = path.join(resourcesPath, 'git-service', 'git-service.exe');
  if (fs.existsSync(gitExe)) {
    const repoRoot = path.resolve(appPath, '..', '..');
    console.log('[services] Starting git-service (3002)...');
    const gitSvc = spawn(gitExe, ['--port', '3002', '--repo', repoRoot], {
      cwd: path.dirname(gitExe),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    gitSvc.stdout?.on('data', (d) => process.stdout.write(`[git-service] ${d}`));
    gitSvc.stderr?.on('data', (d) => process.stderr.write(`[git-service] ${d}`));
    gitSvc.on('exit', (code) => console.warn(`[git-service] exited with code ${code}`));
    spawnedChildren.push(gitSvc);
  } else {
    console.warn('[services] git-service not found at', gitExe);
  }

  // ── 阶段 2: 启动依赖 Garnet + SurrealDB 的 RACER Core (3001) ──
  const coreEntry = path.join(resourcesPath, 'core', 'server.mjs');
  if (fs.existsSync(coreEntry)) {
    console.log('[services] Starting RACER Core (3001)...');
    const coreEnv = { ...process.env };
    delete coreEnv.ELECTRON_RUN_AS_NODE;
    // cwd 设为 resourcesPath, 这样 RACER Core 的 process.cwd() 能找到 bin/scheduler.exe
    const coreProc = spawn(process.execPath, [coreEntry], {
      cwd: resourcesPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: coreEnv,
      windowsHide: true,
    });
    coreProc.stdout?.on('data', (d) => process.stdout.write(`[core] ${d}`));
    coreProc.stderr?.on('data', (d) => process.stderr.write(`[core] ${d}`));
    coreProc.on('exit', (code) => console.warn(`[core] exited with code ${code}`));
    spawnedChildren.push(coreProc);
    await waitForPort(3001, 15000).then(ok => console.log(ok ? '[services] ✓ RACER Core ready' : '[services] ✗ RACER Core timeout'));
  } else {
    console.warn('[services] RACER Core not found at', coreEntry, '— LLM dispatch will fail (502)');
  }

  // ── 阶段 3: 启动 UI Server (3000) ──
  const uiServer = path.join(appPath, 'dist', 'server.mjs');
  if (fs.existsSync(uiServer)) {
    console.log('[services] Starting UI Server (3000)...');
    const uiEnv = { ...process.env, NODE_ENV: 'production' };
    delete uiEnv.ELECTRON_RUN_AS_NODE;
    const uiProc = spawn(process.execPath, [uiServer], {
      cwd: appPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: uiEnv,
      windowsHide: true,
    });
    uiProc.stdout?.on('data', (d) => process.stdout.write(`[ui-server] ${d}`));
    uiProc.stderr?.on('data', (d) => process.stderr.write(`[ui-server] ${d}`));
    uiProc.on('exit', (code) => console.warn(`[ui-server] exited with code ${code}`));
    spawnedChildren.push(uiProc);
  } else {
    console.error('[services] UI Server not found at', uiServer);
  }
}

/** 等待端口就绪 (最多 15s) */
function waitForPort(port, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const sock = new net.Socket();
      sock.setTimeout(1000);
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) { resolve(false); return; }
        setTimeout(check, 300);
      });
      sock.on('timeout', () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) { resolve(false); return; }
        setTimeout(check, 300);
      });
      sock.connect(port, '127.0.0.1');
    };
    check();
  });
}

/** 优雅退出所有子进程 (含子进程树)
 * ★ 2026-07-15: 改用 killProcessTree 替代裸 .kill()。
 *   原因: 与 start.mjs 同类 bug — Windows 上 .kill() 只杀顶层进程,
 *   子进程 (npx→tsx→node) 变成孤儿继续持有 rocksdb LOCK,
 *   导致下次启动 SurrealDB 初始化超时崩溃。
 */
function killAllChildren() {
  for (const child of spawnedChildren) {
    killProcessTree(child);
  }
}

// ── Content-Security-Policy ──
// 统一策略 (不分 dev/prod):
//   Electron 桌面应用, 用户自行选择 LLM 服务商 (providers_db.json 含 20+ 家 + 自定义 baseUrl)
//   全部通路开放, 仅保留 object-src / frame-ancestors 基础防护
function buildCspHeader() {
  return [
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: ws: wss: http: https:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' http: https:",
    "style-src 'self' 'unsafe-inline' http: https:",
    "img-src 'self' data: blob: http: https:",
    "font-src 'self' data: http: https:",
    "connect-src 'self' blob: data: ws: wss: http: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function applyCsp() {
  const csp = buildCspHeader();
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    const responseHeaders = {
      ...details.responseHeaders,
      'Content-Security-Policy': [csp],
      // 2026-07-11: 强制 no-store,让 Chromium 不写任何磁盘缓存
      //   防止 V8 Code Cache 缓存旧字节码导致用户看到旧代码
      'cache-control': ['no-store, no-cache, must-revalidate'],
      'pragma': ['no-cache'],
      'expires': ['0'],
    };
    cb({ responseHeaders });
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
// ────────────────────────────────────────────
// 工具：找可用的本地端口
// ────────────────────────────────────────────
// ────────────────────────────────────────────
// 工具：解析 3D 模型目录路径
// ────────────────────────────────────────────
function resolveModelsDir() {
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'canvas', 'models'))) {
    return path.join(process.resourcesPath, 'canvas', 'models');
  }
  const uiRoot = path.resolve(__dirname, '..');
  return path.join(uiRoot, 'resources', 'canvas', 'models');
}

// ────────────────────────────────────────────
// 工具：读取设备配置 (device-config.json)
// ────────────────────────────────────────────
function readDeviceConfig() {
  const configPath = path.join(resolveModelsDir(), 'device-config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[canvas] readDeviceConfig failed:', e?.message);
    return { models: {} };
  }
}

// ────────────────────────────────────────────
// 工具：列出可用模型 (扫描 models/ 目录)
// ────────────────────────────────────────────
function listAvailableModels() {
const config = readDeviceConfig();
  const result = [];
  if (config?.models) {
    for (const [key, info] of Object.entries(config.models)) {
      result.push({
        key,
        label: info.label || key,
        group: info.group || 'desktop',
        type: info.type || '2d',
        nativeSize: info.nativeSize || { w: 0, h: 0 },
      });
    }
  }
  return result;
}

// ────────────────────────────────────────────
// 工具：等待 WS 端口起来
// ────────────────────────────────────────────
// ────────────────────────────────────────────
// 确保画布宿主窗口存在 (懒创建)
// ────────────────────────────────────────────
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
// ────────────────────────────────────────────
// 2026-07-09 画布端口注册到 Node.js 后端 (3001)
// 让 Java Agent (8770) 能通过 Node.js relay 推送 DSL 到 Flutter canvas
// 链路: Java canvas_push_ui → POST 3001/api/canvas/relay/push-ui → Flutter /render
// ────────────────────────────────────────────
// ────────────────────────────────────────────
// 通用 HTTP POST 到 canvas (供 pushUI / transform / clear / setBg 等复用)
// ────────────────────────────────────────────
// ────────────────────────────────────────────
// 画布操作: pushUI / transform / clear / setBg / screenshot
// ────────────────────────────────────────────

// ────────────────────────────────────────────
// IPC handlers
// ────────────────────────────────────────────
function registerIpc() {
  // ★ 2026-07-16: 画布 IPC 全部注释掉 — 画布重构中
  //   恢复方法: 删除本行下方的 /* 和对应的 */ 注释

// ── 自定义窗口控制按钮 ──
// 由 UI/src/components/WindowControls.tsx 调用
// frame:false → 无 snap flyout; maximize()/unmaximize() → 无 DWM resize tooltip

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

  // ── 递归读取目录树 (用于工作区文件树恢复) ──
  // 返回与前端 FileNode 兼容的 JSON 树结构
  ipcMain.handle('fs:read-dir-tree', async (_e, { dirPath, maxDepth }) => {
    console.log('[fs:read-dir-tree] called with dirPath:', dirPath);
    const SKIP_DIRS = new Set(['.git', '.svn', 'node_modules', '__pycache__', '.cache', 'dist', 'build', '.next', '.nuxt']);
    const MAX_DEPTH = maxDepth || 12;

    function readDir(dirPath, parentPath, depth) {
      const name = path.basename(dirPath);
      const nodePath = parentPath ? `${parentPath}/${name}` : name;
      const children = [];
      if (depth >= MAX_DEPTH) {
        return { name, type: 'folder', path: nodePath, children };
      }
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
          const childPath = path.join(dirPath, entry.name);
          if (entry.isDirectory()) {
            children.push(readDir(childPath, nodePath, depth + 1));
          } else if (entry.isFile()) {
            children.push({ name: entry.name, type: 'file', path: `${nodePath}/${entry.name}` });
          }
        }
      } catch (e) {
        // 权限/IO 错误: 返回空子节点
      }
      children.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return { name, type: 'folder', path: nodePath, children };
    }

    try {
      // 如果路径直接存在,直接读取
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        const tree = readDir(dirPath, '', 0);
        return { success: true, tree };
      }

      // 路径不存在 → 在常见基目录下搜索同名文件夹
      // 场景: workspaceFolder 只存了文件夹名 (如 "Dyson Sphere Program"),
      // 不是完整路径,需要猜测实际位置
      const folderName = path.basename(dirPath);
      const homeDir = app.getPath('home');
      const searchBases = [
        path.join(homeDir, 'Desktop'),
        path.join(homeDir, 'Documents'),
        path.join(homeDir, 'Downloads'),
        homeDir,
        path.join(homeDir, 'Desktop', 'Projects'),
        path.join(homeDir, 'Projects'),
      ];
      // 也尝试相对于 CWD (项目根目录)
      searchBases.push(process.cwd());
      // 也尝试上一级目录 (UI/ 的父目录,即 SoloForge/)
      searchBases.push(path.dirname(process.cwd()));

      console.log('[fs:read-dir-tree] searching for folderName:', folderName, 'in bases:', searchBases);
      for (const base of searchBases) {
        const candidate = path.join(base, folderName);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          console.log('[fs:read-dir-tree] found at:', candidate);
          const tree = readDir(candidate, '', 0);
          return { success: true, tree, resolvedPath: candidate };
        }
      }

      return { success: false, error: 'Directory not found in common locations: ' + dirPath };
    } catch (e) {
      return { success: false, error: e.message || String(e) };
    }
  });

ipcMain.handle('window:minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});

ipcMain.handle('window:toggle-maximize', () => {
if (!mainWindow || mainWindow.isDestroyed()) return false;
if (mainWindow.isMaximized()) {
mainWindow.unmaximize();
} else {
mainWindow.maximize();
}
return mainWindow.isMaximized();
});

ipcMain.handle('window:restore', () => {
if (mainWindow && !mainWindow.isDestroyed()) {
if (mainWindow.isMaximized()) mainWindow.unmaximize();
else mainWindow.restore();
}
});

ipcMain.handle('window:close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});
ipcMain.handle('window:is-maximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});
ipcMain.handle('window:maximize-state', (event) => {
  const isMax = mainWindow ? mainWindow.isMaximized() : false;
  event.sender.send('window:maximize-state-changed', isMax);
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
    // 清理拖动状态
    dragActive = false;
    // 拖动结束后 PS Worker 重启检查 (拖拽可能弄崩 PS Worker)
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
      // 拖动期间禁用样式重应用检查
      dragActive = true;
      // 通知渲染器进入拖动状态 (CSS 临时禁用 backdrop-filter)
      try { mainWindow.webContents.send('drag-state', true); } catch {}

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

  // ── 2026-07-14: 手动重载 IPC (HMR 已禁用, 用户通过 UI 按钮 / F5 / Ctrl+R 手动重载) ──
  ipcMain.handle('app:reload', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log('[electron] 手动重载渲染进程 (app:reload IPC)');
      // 清缓存防止 Chromium 复用旧字节码
      try { mainWindow.webContents.session.clearCache(); } catch {}
      mainWindow.webContents.reload();
      return { ok: true };
    }
    return { ok: false, error: 'mainWindow not available' };
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
function getHwndStr(window) {
  if (!window || window.isDestroyed()) return null;
  try {
    const buf = window.getNativeWindowHandle();
    if (buf.length >= 8) return buf.readBigInt64LE(0).toString();
    return buf.readInt32LE(0).toString();
  } catch (e) { return null; }
}

// ── 2026-07-04 拖动期间禁用标志 ──
let dragActive = false;

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
    // titleBarStyle:'hidden' + titleBarOverlay → 原生 caption buttons, 无标题文字
    //   overlay 让按钮图标颜色可控 (深色背景下默认白色图标看不见)
    //   color: 透明背景 → Header 底色透出来
    //   symbolColor: 浅灰图标 → 在深色背景上清晰可见
    //   height: 52 → 和 Header 高度一致
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: 'rgba(5, 5, 5, 0)',
      symbolColor: '#a8b0b8',
      height: 52,
    },
    backgroundColor: '#050505',
    hasShadow: false,
    minimizable: true,
    maximizable: true,
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
  //   dev 模式: 从 Vite dev server (3000) 加载, HMR 已禁用 (手动重载)
  //   prod 模式: 从已启动的 UI Server (3000) 加载 (HTTP 协议, 无 file:// 缓存问题)
  //   两者都走 http://localhost:3000, 区别在于 dev 有 DevTools
  if (isDev) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    console.log(`[electron] ▶ renderer loadURL: ${DEV_URL} (isDev=${isDev})`);
  } else {
    // 生产模式: UI Server (3000) 已由 startProductionServices() 启动
    //   走 HTTP 协议而非 file://, 避免 Chromium 硬缓存问题
    mainWindow.loadURL(DEV_URL);
    console.log(`[electron] ▶ renderer loadURL: ${DEV_URL} (isDev=${isDev}, prod mode)`);
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
    // 2026-07-14: HMR 已禁用, View 菜单显式提供 Reload 入口 (Ctrl+R + F5)
    {
      label: 'View',
      submenu: [
        { role: 'reload', accelerator: 'CmdOrCtrl+R' },
        { label: 'Reload (F5)', accelerator: 'F5', click: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            try { mainWindow.webContents.session.clearCache(); } catch {}
            mainWindow.webContents.reload();
          }
        }},
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
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
    // ── 2026-07-11: 彻底禁用 Chromium 磁盘缓存,防止旧代码残留 ──
    // V8 Code Cache (字节码缓存) 是"e壳子出现旧代码"的根因:
    //   Chromium 会把编译过的 JS 字节码写到 user-data-dir/Code Cache/,
    //   即使 Vite HMR 推了新代码,Chromium 也可能复用旧字节码 → 用户看到旧 UI。
    app.commandLine.appendSwitch('disable-http-cache');
    app.commandLine.appendSwitch('disable-features', 'BlinkCodeCache,V8CodeCache');
    app.commandLine.appendSwitch('js-flags', '--no-flush-bytecode --no-lazy');
  } catch (e) { /* ignore */ }
}

// ── 主进程入口 ──
app.whenReady().then(async () => {
  // ── 应用上次保存的代理配置 ──
  try { await proxyService.apply(proxyService.getConfig()); }
  catch(e) { console.warn('[ProxyService] Failed to restore:', e?.message); }

  // ── 注册代理 IPC handler ──
  ipcMain.handle('proxy:get-config', () => proxyService.getConfig());
  ipcMain.handle('proxy:apply', (_, cfg) => proxyService.apply(cfg));
  ipcMain.handle('proxy:test', () => proxyService.testConnection());
  ipcMain.handle('proxy:system-info', () => proxyService.getSystemProxyInfo());

  // ── 注册 Local LLM IPC handler ──
  localLLM.registerIpc(ipcMain, dialog);
  // ── dev/prod 模式判定 ──
  //   dev: 开发者通过 npm run dev 启动, Vite dev server 在 3000
  //         环境变量 SOLOFORGE_FORCE_DEV=1 也强制 dev (从 IDE 启动调试时用)
  //   prod: 打包后双击 exe, Electron 自动拉起所有后端服务
  //         file:// 加载 dist/index.html (加 mtime 防缓存)
  if (process.env.SOLOFORGE_FORCE_DEV === '1') {
    isDev = true;
    console.log('[electron] SOLOFORGE_FORCE_DEV=1, 走 Vite dev server (3000)');
  } else {
    isDev = process.defaultApp || !app.isPackaged;
    console.log(`[electron] isDev=${isDev} (defaultApp=${process.defaultApp}, isPackaged=${app.isPackaged})`);
  }

  // ── 生产模式: 并行启动后端服务（不阻塞 UI） ──
  if (!isDev) {
    // fire-and-forget: 服务在后台并行启动
    startProductionServices().catch(e => console.error('[services] error:', e?.message));
  }

  // CSP / proxy / 缓存清理 — 可以在 splash 期间并行完成
  applyCsp();
  setupApiProxy();

  try {
    await Promise.all([
      session.defaultSession.clearCache().catch((e) => console.warn('[electron] clearCache:', e?.message)),
      session.defaultSession.clearStorageData({
        storages: ['shadercache', 'cachestorage', 'serviceworkers'],
      }).catch((e) => console.warn('[electron] clearStorageData:', e?.message)),
    ]);
    console.log('[electron] ✓ session 缓存已清');
  } catch (e) {
    console.warn('[electron] 清 session 缓存失败:', e?.message);
  }

  // ★ no-store 响应头已在 applyCsp() 中统一注入 (CSP + cache-control 合并)
  //   此处不再重复设置 onHeadersReceived,避免覆盖 CSP 头

  // ★ 直接删 user-data-dir 里的持久化缓存数据 (绕过 session API 限制)
  //   session.clearCache() / clearStorageData() 都不删 localStorage / IndexedDB
  //   (它们用的是不同的 storage backend),必须用 fs.rm 直接删 user-data-dir
  //   注意: Local Storage 和 WebStorage 都不能删!
  //   - Local Storage: cherry_providers_v2 (大模型密钥) + soloforge_workspaces 需要持久化
  //   - WebStorage: 某些 Electron/Chromium 版本中是 Local Storage 的别名, 删了 = 删 localStorage
  //   删除会导致「密钥重启后丢失」问题
  try {
    const userDataDir = app.getPath('userData');
    const targets = [
      'Code Cache', 'Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
      // Local Storage + WebStorage 保留: 大模型密钥 + workspace 需要持久化
      'Session Storage', 'IndexedDB',
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

  // ── 生产模式: 等待 UI Server 就绪后再创建主窗口 ──
  if (!isDev) {
    console.log('[electron] splash 显示中, 等待 UI Server (3000) 就绪...');
    const ready = await waitForPort(3000, 30000);
    if (ready) {
      console.log('[electron] ✓ UI Server (3000) 就绪, 加载主窗口');
    } else {
      console.error('[electron] ✗ UI Server (3000) 30s 超时, 强制加载');
    }
  }

  createWindow();

// titleBarStyle:'hidden' → 原生 caption buttons, 无需任何 PowerShell hack
mainWindow.once('ready-to-show', () => {
  mainWindow.show();
});
// 原生 maximize/unmaximize 事件 → 通知渲染器更新按钮状态
mainWindow.on('maximize', () => {
  mainWindow.webContents.send('window:maximize-state-changed', true);
});
mainWindow.on('unmaximize', () => {
  mainWindow.webContents.send('window:maximize-state-changed', false);
});
  registerIpc();
  // ★ 清理 hot reload 残留的下拉框窗口 (防双窗口)
  try { cleanupStaleDropdownWindows(); } catch (e) { console.warn('[electron] cleanupStaleDropdownWindows:', e?.message); }

app.on('activate', () => {
if (BrowserWindow.getAllWindows().length === 0) {
createWindow();
}
});
});

app.on('window-all-closed', () => {
  // 生产模式: 退出所有后端服务
  killAllChildren();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // 退出 Local LLM 服务 (async, fire-and-forget on quit)
  localLLM.cleanup().catch(() => {});
  // 生产模式: 退出所有后端服务
  killAllChildren();
});
