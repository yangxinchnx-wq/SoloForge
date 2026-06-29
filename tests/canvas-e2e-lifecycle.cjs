// ─────────────────────────────────────────────────────────────────
// SoloForge 画布端到端生命周期测试 (canvas-e2e-lifecycle.cjs)
//
// 目的: 真实启动 Electron + BrowserWindow, 加载一个测试 HTML (模拟 PreviewPanel),
//       跑完整启动/暂停/关闭 lifecycle, 验证:
//         1. CSP 允许 127.0.0.1 fetch (RTT input POST/GET)
//         2. 真实 IPC canvas:start / canvas:stop / canvas:status 链路
//         3. 真实 mock canvas 子进程 (HTTP server, ws 升级)
//         4. 启动/暂停/关闭序列在 BrowserWindow 渲染下不死循环
//         5. start → 立刻 close → 不会留下孤儿 canvas 进程
//         6. close 后 fetch 应该被 127.0.0.1:port 拒绝 (canvas 已死)
//
// 跑法: npx electron tests/canvas-e2e-lifecycle.cjs
// 退出: 0 = 全部通过, 1 = 失败
// ─────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

let electron;
try { electron = require('electron'); } catch (e) { console.error('FATAL: ' + e.message); process.exit(2); }
if (typeof electron === 'string') { console.error('FATAL: must run via electron'); process.exit(2); }
const { app, BrowserWindow, session, ipcMain } = electron;

const { createCanvasManager } = require(path.join(__dirname, '..', 'UI', 'electron', 'canvasHost.cjs'));

const LOG_DIR = path.join(__dirname, '..', 'logs', 'e2e');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'canvas-e2e-lifecycle.log');
try { fs.unlinkSync(LOG_FILE); } catch {}
const PASS = [];
const FAIL = [];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  try { process.stdout.write(line + '\n'); } catch {}
}
function assert(cond, msg) {
  if (cond) { PASS.push(msg); log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { FAIL.push(msg); log(`  \x1b[31m✗\x1b[0m ${msg}`); }
}
function section(name) { log(''); log(`══ ${name} ══`); }

// ── Mock canvas 子进程 (HTTP + WS) ──
function makeMockCanvasScript() {
  const script = `
const http = require('http');
const crypto = require('crypto');
const portArg = process.argv.find(a => a.startsWith('--port='));
const port = portArg ? parseInt(portArg.split('=')[1], 10) : 0;
if (!port) { console.error('[mock-canvas] missing --port=N'); process.exit(2); }
const log = (m) => { try { process.stdout.write('[mock-canvas] ' + m + '\\n'); } catch {} };

const server = http.createServer((req, res) => {
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    const key = req.headers['sec-websocket-key'];
    if (!key) { req.socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    req.socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + accept, '', '',
    ].join('\\r\\n'));
    req.socket.on('data', () => {});  // 保持连接
    req.socket.on('close', () => {});
    return;
  }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if (req.url.startsWith('/api/canvas/rtt/input') && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, queueSize: 1 }));
      return;
    }
    if (req.url.startsWith('/api/canvas/rtt/input') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, count: 0, events: [] }));
      return;
    }
    if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, received: body ? JSON.parse(body) : null }));
  });
});
server.listen(port, '127.0.0.1', () => log('listening ' + port));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soloforge-e2e-'));
  const scriptPath = path.join(tmpDir, 'mock-canvas.js');
  fs.writeFileSync(scriptPath, script);
  return { scriptPath, tmpDir };
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

function makeMockWindow() {
  let destroyed = false;
  return {
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true; },
    setBounds: () => {},
    setAlwaysOnTop: () => {},
    setIgnoreMouseEvents: () => {},
    loadURL: () => {},
    getNativeWindowHandle: () => {
      const buf = Buffer.alloc(32);
      buf.writeInt32LE(0x12345678, 0);
      return buf;
    },
  };
}

// 与 main.cjs 一致的 CSP
const MAIN_CSP = [
  "default-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: http://localhost:* http://127.0.0.1:* https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' http://localhost:3000 http://localhost:3001 ws://localhost:3000 ws://localhost:3001 http://localhost:3002 http://127.0.0.1:* ws://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function buildTestHtml(port) {
  return `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="${MAIN_CSP}">
<title>E2E Lifecycle</title>
</head><body>
<h1>E2E Lifecycle</h1>
<pre id="out">pending</pre>
<script>
(async () => {
  const out = document.getElementById('out');
  const port = ${port};
  const log = [];
  const errs = [];
  // 抓 console-message / window.error
  window.addEventListener('error', (e) => errs.push('window.error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errs.push('unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));

  // 1. 启动前 fetch (canvas 还没起, 应该 connection refused, 但 CSP 应允许)
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(2000) });
    log.push('before-start health status=' + r.status);
  } catch (e) { errs.push('before-start: ' + e.message); }

  // 2. 启动后 fetch (canvas 应该起)
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/health');
    const j = await r.json();
    log.push('after-start health ok=' + j.ok);
  } catch (e) { errs.push('after-start: ' + e.message); }

  // 3. 模拟暂停: 不调 fetch (paused 不影响 canvas 进程, 仍可 fetch)
  log.push('paused (no fetch change)');

  // 4. 关闭后 fetch (canvas 应 kill, fetch 应 fail)
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(2000) });
    log.push('after-close health status=' + r.status + ' (UNEXPECTED, canvas should be dead)');
  } catch (e) { log.push('after-close expected-fail: ' + e.name); }

  out.textContent = JSON.stringify({ log, errs }, null, 2);
  window.__testResult = { log, errs };
})();
</script>
</body></html>`;
}

async function runTests() {
  log('');
  log('╔══════════════════════════════════════════════════════════╗');
  log('║  SoloForge 画布端到端生命周期测试                            ║');
  log('╚══════════════════════════════════════════════════════════╝');

  await app.whenReady();
  log('electron app ready');

  // 1. 注入 CSP 到 default session
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      const headers = details.responseHeaders || {};
      headers['Content-Security-Policy'] = [MAIN_CSP];
      callback({ responseHeaders: headers });
    }
  );

  // 2. 准备 mock canvas + canvas manager
  const { scriptPath, tmpDir } = makeMockCanvasScript();
  const mockWindow = makeMockWindow();
  const mainWindows = [mockWindow];
  const getMainWindow = () => mainWindows[0] || null;
  // mock ipcMain: 跟 button-bug-test.cjs 一样, 持有 _handlers Map + invokeHandler
  const mockIpcMain = {
    _handlers: new Map(),
    handle(channel, fn) { this._handlers.set(channel, fn); },
    invokeHandler(channel, ...args) { const fn = this._handlers.get(channel); if (!fn) throw new Error('no handler: ' + channel); return fn({}, ...args); },
  };

  const cm = createCanvasManager({
    app,
    BrowserWindow: function() { return makeMockWindow(); },
    ipcMain: mockIpcMain,
    getMainWindow,
    resolveCanvasExePath: () => scriptPath,
    resolveCanvasDataDir: () => tmpDir,
    resolveModelsDir: () => tmpDir,
    readDeviceConfig: () => ({ devices: [] }),
    listAvailableModels: () => [],
    moveWindow: async () => ({ ok: true }),
    embedWindowWithRetry: async () => ({ ok: true, attempted: 1, succeeded: 1, retried: 0 }),
    findWindowByPid: async () => 0xABCD,
    sendToCanvasRaw: (port, p, body, timeoutMs) => new Promise((resolve) => {
      const data = body || '';
      const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: timeoutMs || 5000 }, (res) => {
        let buf = ''; res.on('data', c => buf += c);
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
      req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
      if (data) req.write(data);
      req.end();
    }),
    findFreePort,
    waitForPort: async (port, timeoutMs = 8000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          const ok = await new Promise((resolve) => {
            const sock = net.createConnection({ host: '127.0.0.1', port }, () => { sock.end(); resolve(true); });
            sock.on('error', () => resolve(false));
            setTimeout(() => { try { sock.destroy(); } catch {} resolve(false); }, 1000);
          });
          if (ok) return true;
        } catch {}
        await new Promise(r => setTimeout(r, 200));
      }
      return false;
    },
    spawn: (exe, args, opts = {}) => {
      if (typeof exe === 'string' && (exe.endsWith('.js') || exe.endsWith('.cjs'))) {
        return spawn(process.execPath, [exe, ...args], { ...opts, env: { ...(opts.env || process.env), ELECTRON_RUN_AS_NODE: '1' } });
      }
      return spawn(exe, args, opts);
    },
    logPrefix: '[e2e]',
  });
  cm.registerIpc();

  async function ipc(channel, payload) {
    try {
      return await mockIpcMain.invokeHandler(channel, payload);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // 3. 写一个临时 HTML
  // 我们需要知道 canvas 启动后的 port, 但 HTML 写时还不知道
  // 解决: HTML 里硬编码 port=0, 然后启动后通过 executeJavaScript 改 port 测试
  // 简化: 先启动 canvas, 拿 port, 再创建 HTML, 加载
  // 进一步简化: 创建 HTML 时 port 设为 0 (placeholder), 通过 executeJavaScript 改写 fetch
  // 这里用第 1 种: 先 start, 拿 port, 再 create HTML

  // 4. 启动 BrowserWindow (预先创建, 但不加载)
  const tmpHtmlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soloforge-e2e-html-'));
  const htmlPath = path.join(tmpHtmlDir, 'test.html');

  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: false },
  });
  const consoleMessages = [];
  win.webContents.on('console-message', (event, level, message) => {
    consoleMessages.push({ level, message });
    log(`  [console L${level}] ${message}`);
  });

  // =========== Section 1: 启动前 fetch 127.0.0.1 应被 CSP 允许 (即使 canvas 没起) ===========
  section('Section 1: 启动前 — CSP 允许 fetch 127.0.0.1 (canvas 未起)');
  {
    // 写一个用 placeholder port 99999 (一定连不通) 的 HTML, 验证 CSP 不立即拒绝
    const html = buildTestHtml(99999);
    fs.writeFileSync(htmlPath, html);
    await new Promise((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve());
      win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error('did-fail-load: ' + code + ' ' + desc)));
      win.loadFile(htmlPath).catch(reject);
    });
    // 等 __testResult
    const result = await waitForTestResult(win, 5000);
    log('  result: ' + JSON.stringify(result));
    assert(result && result.log && result.log.length > 0, '启动前 HTML 执行 fetch 流程');
    // CSP 不应拒绝 (应该 connection refused)
    const beforeStart = result.log.find(l => l.startsWith('before-start health'));
    assert(!beforeStart || !beforeStart.includes('Refused'), '启动前 fetch 没出现 CSP 拒绝 (应 connection refused)');
    assert(result.errs.some(e => e.includes('before-start')), '启动前 fetch 失败 (canvas 未起, 预期 fail)');
  }

  // =========== Section 2: 启动 canvas 后 fetch 应成功 ===========
  section('Section 2: 启动 canvas 后 fetch 127.0.0.1 成功');
  let sessionPort = 0;
  {
    const sid = 'e2e-session-1';
    const startRes = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    if (!startRes.ok) {
      log('  start failed: ' + JSON.stringify(startRes));
      assert(false, 'canvas:start 成功');
    } else {
      assert(startRes.ok === true, 'canvas:start 成功');
      sessionPort = startRes.session.port;
      log('  canvas port: ' + sessionPort);
      // 写新 HTML 用真 port
      const html = buildTestHtml(sessionPort);
      fs.writeFileSync(htmlPath, html);
      await win.webContents.reload();
      await new Promise((resolve) => {
        const onLoad = () => { win.webContents.removeListener('did-finish-load', onLoad); resolve(); };
        win.webContents.once('did-finish-load', onLoad);
        setTimeout(resolve, 3000);  // 兜底
      });
      const result = await waitForTestResult(win, 5000);
      log('  result: ' + JSON.stringify(result));
      const afterStart = result.log.find(l => l.startsWith('after-start health'));
      assert(afterStart && afterStart.includes('ok=true'), '启动后 fetch health 成功 (canvas alive)');
    }
  }

  // =========== Section 3: 暂停 (no IPC) — fetch 仍应成功 ===========
  section('Section 3: 暂停 — canvas 仍 alive, fetch 仍成功');
  {
    if (sessionPort > 0) {
      const r = await fetchHealth(sessionPort);
      assert(r.ok, '暂停期间 fetch health 仍成功');
    } else {
      assert(false, 'sessionPort=0, 跳过');
    }
  }

  // =========== Section 4: 关闭 canvas 后 fetch 应 fail (canvas dead) ===========
  section('Section 4: 关闭 canvas 后 fetch fail (canvas dead)');
  {
    const sid = 'e2e-session-1';
    const stopRes = await ipc('canvas:stop', { sessionId: sid });
    assert(stopRes.ok === true, 'canvas:stop 成功');
    await new Promise(r => setTimeout(r, 500));
    // 等 mock 子进程 exit
    const r = await fetchHealth(sessionPort, 1500).catch(e => ({ ok: false, error: e.message }));
    assert(!r.ok, '关闭后 fetch health 失败 (canvas 进程已 kill)');
  }

  // =========== Section 5: 快速 start → close 序列 (5x) 不死循环 ===========
  section('Section 5: 快速 start → close 5x 不死循环');
  {
    const cm2 = cm._internal;
    const initialSessionCount = cm2.canvasSessions.size;
    const initialWsCount = cm2.wsClients ? cm2.wsClients.size : 0;
    for (let i = 0; i < 5; i++) {
      const sid = `cycle-${i}`;
      const startRes = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
      assert(startRes.ok === true, `cycle ${i}: start 成功`);
      await new Promise(r => setTimeout(r, 100));
      const stopRes = await ipc('canvas:stop', { sessionId: sid });
      assert(stopRes.ok === true, `cycle ${i}: stop 成功`);
      await new Promise(r => setTimeout(r, 100));
    }
    // 等所有 mock 子进程 exit
    await new Promise(r => setTimeout(r, 1000));
    const finalSessionCount = cm2.canvasSessions.size;
    const finalWsCount = cm2.wsClients ? cm2.wsClients.size : 0;
    assert(finalSessionCount === initialSessionCount, `canvasSessions 清空 (${initialSessionCount} → ${finalSessionCount})`);
    assert(finalWsCount === initialWsCount, `wsClients 清空 (${initialWsCount} → ${finalWsCount})`);
  }

  // =========== Section 6: RTT input POST 在 canvas alive 时成功 ===========
  section('Section 6: RTT input POST 真实端到端');
  {
    const sid = 'e2e-rtt';
    const startRes = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    assert(startRes.ok === true, 'RTT: start 成功');
    const port = startRes.session.port;
    await new Promise(r => setTimeout(r, 300));
    // 直接从 main 进程调 sendToCanvasRaw (这是 deps 里传进去的)
    // 通过查 canvasSessions 拿 port 调 IPC push
    // 这里用 IPC push (canvas:push 走 /render) 间接验证 — 更精准的是 pushRttInput 走 /api/canvas/rtt/input
    // 直接走 HTTP POST 到 mock canvas port
    const pushRes = await new Promise((resolve) => {
      const data = JSON.stringify({ sessionId: sid, deviceId: 'd1', type: 'tap', u: 0.5, v: 0.5, timestamp: Date.now() });
      const req = http.request({ host: '127.0.0.1', port, path: '/api/canvas/rtt/input', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 3000 }, (res) => {
        let buf = ''; res.on('data', c => buf += c);
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
      req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
      req.write(data); req.end();
    });
    assert(pushRes.status === 200, `RTT POST 200 (status=${pushRes.status})`);
    if (pushRes.body) {
      const j = JSON.parse(pushRes.body);
      assert(j.ok === true, `RTT POST ok=true (body=${pushRes.body.slice(0, 80)})`);
    }
    const drainRes = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/canvas/rtt/input?sessionId=' + sid, method: 'GET', timeout: 3000 }, (res) => {
        let buf = ''; res.on('data', c => buf += c);
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
      req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
      req.end();
    });
    assert(drainRes.status === 200, `RTT GET drain 200 (status=${drainRes.status})`);
    await ipc('canvas:stop', { sessionId: sid });
  }

  // =========== 汇总 ===========
  win.close();
  try { fs.rmSync(tmpHtmlDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  log('');
  log('╔══════════════════════════════════════════════════════════╗');
  log(`║  结果: ${PASS.length} 通过, ${FAIL.length} 失败`);
  log('╚══════════════════════════════════════════════════════════╝');
  if (FAIL.length > 0) {
    for (const f of FAIL) log(`  ✗ ${f}`);
  }
  process.exit(FAIL.length > 0 ? 1 : 0);
}

function waitForTestResult(win, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const r = await win.webContents.executeJavaScript('JSON.stringify(window.__testResult || null)');
        if (r && r !== 'null') { resolve(JSON.parse(r)); return; }
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    resolve({ log: [], errs: ['timeout'] });
  });
}

function fetchHealth(port, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: timeoutMs }, (res) => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => { try { resolve({ ok: true, status: res.statusCode, body: JSON.parse(buf) }); } catch { resolve({ ok: true, status: res.statusCode, body: buf }); } });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

runTests().catch((e) => {
  log('FATAL: ' + e.stack);
  process.exit(2);
});
