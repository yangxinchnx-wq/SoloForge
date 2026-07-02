// scripts/perf-driver.cjs
// 临时 Electron 主进程 (替代 main.cjs), 仅用于 perf-test.mjs:
//   - 强制 prod mode (加载 dist/index.html via file://)
//   - 无 IPC 桥接 / 无 canvas host / 无菜单
//   - 加 --remote-debugging-port 用于 CDP
// 退出时机:由 perf-test.mjs 通过 process.send SIGINT 关闭
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

app.disableHardwareAcceleration();
const DISABLE_GPU_SWITCHES = [
  'disable-gpu',
  'disable-software-rasterizer',
  'disable-gpu-compositing',
  'disable-dev-shm-usage',
  'no-sandbox',
];
for (const sw of DISABLE_GPU_SWITCHES) app.commandLine.appendSwitch(sw);

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist'); // 静态根 = dist 目录本身
const INDEX = path.join(DIST_DIR, 'index.html');
const HTTP_PORT = 3007; // 静态 HTTP server 端口

let win = null;
let server = null;

function startStaticServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      // /assets/* 直接落到 dist/assets/*;  / 落到 dist/index.html
      let p = path.join(DIST_DIR, url === '/' ? '/index.html' : url);
      // 防越界 - 必须留在 DIST_DIR 内
      if (!p.startsWith(DIST_DIR)) { res.writeHead(403); return res.end(); }
      const ext = path.extname(p);
      const mime = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.json': 'application/json',
        '.otf': 'font/otf',
        '.ttf': 'font/ttf',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
      }[ext] || 'application/octet-stream';
      fs.readFile(p, (err, data) => {
        if (err) {
          // SPA fallback: 未知路径返回 index.html (mock API 也走这路径)
          if (ext === '') {
            return fs.readFile(INDEX, (e2, html) => {
              if (e2) { res.writeHead(500); return res.end('server error'); }
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
              res.end(html);
            });
          }
          res.writeHead(404); return res.end('not found: ' + url);
        }
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
        res.end(data);
      });
    });
    server.listen(HTTP_PORT, '127.0.0.1', () => {
      console.log('[perf-driver] http server on http://127.0.0.1:' + HTTP_PORT);
      resolve();
    });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: false, // 性能测试不开 DevTools
      backgroundThrottling: false,
    },
  });
  // 屏蔽 perf 模式下不需要的后端调用 — 避免 404 风暴阻塞 CDP 协议通道
  // 同时屏蔽 SSE 长连接(/api/events/stream + EventSource 主动 retry) — 不让它在 idle 期间持续开
  const ses = win.webContents.session;
  const BACKEND_PORT_RE = /^(3001|3002|8765|9090|6380|6379)$/;
  ses.webRequest.onBeforeRequest((details, cb) => {
    try {
      const u = new URL(details.url);
      if (BACKEND_PORT_RE.test(u.port) || /^10\./.test(u.hostname)) {
        return cb({ cancel: true });
      }
      if (u.pathname && u.pathname.startsWith('/api/')) {
        return cb({ cancel: true });
      }
    } catch {/* not a URL we recognize */}
    cb({});
  });
  // 直接加载根路径 - dist/index.html 内 <script src="/assets/..."/> 由 server 在 DIST_DIR 下查找
  win.loadURL('http://127.0.0.1:' + HTTP_PORT + '/');
  win.webContents.once('did-finish-load', () => {
    console.log('[perf-driver] main page did-finish-load');
  });
}

app.whenReady().then(async () => {
  await startStaticServer();
  createWindow();
  console.log('[perf-driver] ready');
});

app.on('window-all-closed', () => {
  app.quit();
});

// 显式监听外部信号 — perf-test 通过 SIGINT 关闭, 否则 CPU 100% 卡死
function shutdown(sig) {
  console.log('[perf-driver] received ' + sig + ', shutting down');
  try {
    if (win && !win.isDestroyed()) win.destroy();
    if (server) server.close();
  } catch {}
  app.quit();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
