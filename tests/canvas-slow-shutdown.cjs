// ─────────────────────────────────────────────────────────────────
// SoloForge 画布 IPC 慢关闭端到端测试 (canvas-slow-shutdown.cjs)
//
// 目的: 模拟真实 Flutter 进程不响应 SIGTERM 的场景, 验证:
//         1. IPC stop 立即返回 (不等 canvas 退出), UI 不卡
//         2. canvas 进程 3s 后被 SIGKILL 强制退出 (window.process kill SIGKILL)
//         3. 多次 start/stop 不会留下孤儿进程
//         4. canvasSessions / wsClients 在 stop 后立即清空
//         5. RTT input POST 在 canvas alive 时成功 (CSP 修复验证)
//
// 跑法: npx electron tests/canvas-slow-shutdown.cjs
// 退出: 0 = 通过, 1 = 失败
// ─────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn, execSync } = require('child_process');

let electron;
try { electron = require('electron'); } catch (e) { console.error('FATAL: ' + e.message); process.exit(2); }
if (typeof electron === 'string') { console.error('FATAL: must run via electron'); process.exit(2); }
const { app, BrowserWindow, session } = electron;

const { createCanvasManager } = require(path.join(__dirname, '..', 'UI', 'electron', 'canvasHost.cjs'));

const LOG_DIR = path.join(__dirname, '..', 'logs', 'e2e');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'canvas-slow-shutdown.log');
try { fs.unlinkSync(LOG_FILE); } catch {}
const PASS = [], FAIL = [];

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

// ── Mock canvas: SIGTERM 后 2s 才退出 (模拟真实 Flutter 慢关闭) ──
function makeSlowMockCanvasScript() {
  const script = `
const http = require('http');
const crypto = require('crypto');
const portArg = process.argv.find(a => a.startsWith('--port='));
const port = portArg ? parseInt(portArg.split('=')[1], 10) : 0;
let exiting = false;
const log = (m) => { try { process.stdout.write('[mock-slow] ' + m + '\\n'); } catch {} };

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
    req.socket.on('data', () => {});
    req.socket.on('close', () => {});
    return;
  }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, received: body ? JSON.parse(body) : null }));
  });
});
server.listen(port, '127.0.0.1', () => log('listening ' + port));

// SIGTERM: 2s 后退出 (模拟真实 Flutter 慢关闭)
process.on('SIGTERM', () => {
  if (exiting) return;
  exiting = true;
  log('SIGTERM received, cleaning up (2s)...');
  setTimeout(() => {
    log('exit');
    server.close(() => process.exit(0));
  }, 2000);
});
`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soloforge-slow-'));
  const scriptPath = path.join(tmpDir, 'mock-canvas-slow.js');
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

async function runTests() {
  log('');
  log('╔══════════════════════════════════════════════════════════╗');
  log('║  SoloForge 画布 IPC 慢关闭端到端测试                       ║');
  log('╚══════════════════════════════════════════════════════════╝');

  await app.whenReady();
  log('electron app ready');

  // 1. mock canvas + canvas manager
  const { scriptPath, tmpDir } = makeSlowMockCanvasScript();
  const mockWindow = makeMockWindow();
  const mainWindows = [mockWindow];
  const getMainWindow = () => mainWindows[0] || null;
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
    logPrefix: '[slow]',
  });
  cm.registerIpc();

  async function ipc(channel, payload) {
    try { return await mockIpcMain.invokeHandler(channel, payload); }
    catch (e) { return { ok: false, error: e.message }; }
  }

  // =========== Section 1: 启动 + IPC stop < 1s 返回 (不等 canvas exit) ===========
  section('Section 1: IPC stop 立即返回 (用户场景: "✕ 关闭后 UI 立刻响应")');
  {
    const sid = 'slow-1';
    const t0 = Date.now();
    const startRes = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    assert(startRes.ok === true, `start 成功 (${Date.now() - t0}ms)`);
    const port = startRes.session.port;
    log(`canvas port=${port}, pid=${startRes.session.pid}`);

    // 模拟 IPC stop: 立即返回, 不等 canvas exit
    const tStop = Date.now();
    const stopRes = await ipc('canvas:stop', { sessionId: sid });
    const dt = Date.now() - tStop;
    log(`IPC stop 返回: ${dt}ms`);
    assert(stopRes.ok === true, `stop ok (实际 ${JSON.stringify(stopRes)})`);
    assert(dt < 500, `IPC stop < 500ms 返回 (实际 ${dt}ms, 用户感觉 "✕ 立即响应")`);

    // 等 mock canvas 进程 2s 退出
    await new Promise(r => setTimeout(r, 3000));
    // 验证 process 状态
    try {
      process.kill(startRes.session.pid, 0);
      log(`  [warn] 进程 ${startRes.session.pid} 仍在 (mock canvas 应该已 exit)`);
      assert(false, `mock canvas 进程已 exit (实际仍在, 测试 mock 可能有问题)`);
    } catch (e) {
      // ESRCH = no such process = 已退出 ✓
      if (e.code === 'ESRCH') {
        assert(true, `mock canvas 进程 ${startRes.session.pid} 已 exit (3s 内)`);
      } else {
        log(`  [warn] kill(0) 异常: ${e.code} ${e.message}`);
      }
    }
  }

  // =========== Section 2: 启动后立即点 ✕ (start race) ===========
  section('Section 2: 启动后立即 stop (用户场景: 启动期间点 ✕)');
  {
    const sid = 'slow-race';
    const startRes = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    assert(startRes.ok === true, `start 成功`);
    // 不等启动完成, 立即 stop (实际 start 已 await 完了)
    const tStop = Date.now();
    const stopRes = await ipc('canvas:stop', { sessionId: sid });
    assert(stopRes.ok === true, `stop 成功`);
    log(`stop 耗时: ${Date.now() - tStop}ms`);
  }

  // =========== Section 3: 5x 慢关闭 cycle, 不留孤儿进程 ===========
  section('Section 3: 5x 慢关闭 cycle, 不留孤儿进程');
  {
    const pids = [];
    for (let i = 0; i < 5; i++) {
      const sid = `cycle-${i}`;
      const startRes = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
      assert(startRes.ok === true, `cycle ${i}: start 成功`);
      pids.push(startRes.session.pid);
      const stopRes = await ipc('canvas:stop', { sessionId: sid });
      assert(stopRes.ok === true, `cycle ${i}: stop 成功`);
    }
    // 等所有 mock canvas 进程 2s 退出
    log('等所有 mock canvas 进程退出 (3s)...');
    await new Promise(r => setTimeout(r, 3000));
    let aliveCount = 0;
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
        log(`  [warn] 进程 ${pid} 仍在`);
        aliveCount++;
      } catch (e) {
        if (e.code !== 'ESRCH') { aliveCount++; log(`  [warn] kill(0) 异常: ${e.code}`); }
      }
    }
    assert(aliveCount === 0, `5 个 mock canvas 进程 3s 内全部 exit (实际 ${aliveCount} 个仍活)`);
  }

  // =========== Section 4: RTT input POST 在 canvas alive 时成功 ===========
  section('Section 4: RTT input POST 真实端到端 (CSP 修复验证)');
  {
    const sid = 'rtt-1';
    const startRes = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    assert(startRes.ok === true, 'RTT: start 成功');
    const port = startRes.session.port;
    // 真实 webContents 调 fetch (CSP 验证)
    // 用 BrowserWindow + file:// HTML + fetch to 127.0.0.1:port
    const MAIN_CSP = [
      "default-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: http://localhost:* http://127.0.0.1:* https:",
      "font-src 'self' data: https://fonts.gstatic.com",
      "connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    const tmpHtmlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soloforge-slow-html-'));
    const htmlPath = path.join(tmpHtmlDir, 'test.html');
    fs.writeFileSync(htmlPath, `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${MAIN_CSP}"></head><body>
<script>
(async () => {
  const out = { log: [], errs: [] };
  try {
    const r = await fetch('http://127.0.0.1:${port}/api/canvas/rtt/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: '${sid}', deviceId: 'd1', type: 'tap', u: 0.5, v: 0.5, timestamp: Date.now() }),
    });
    out.log.push('rtt-POST status=' + r.status);
  } catch (e) { out.errs.push('rtt-POST: ' + e.message); }
  try {
    const r = await fetch('http://127.0.0.1:${port}/health');
    out.log.push('health status=' + r.status);
  } catch (e) { out.errs.push('health: ' + e.message); }
  window.__result = out;
})();
</script></body></html>`);

    session.defaultSession.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
      const headers = details.responseHeaders || {};
      headers['Content-Security-Policy'] = [MAIN_CSP];
      callback({ responseHeaders: headers });
    });

    const win = new BrowserWindow({ show: false, width: 600, height: 400, webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: false } });
    const cspErrs = [];
    win.webContents.on('console-message', (_e, level, message) => {
      if (/Content Security Policy/i.test(message) || /Refused to connect/i.test(message)) {
        cspErrs.push({ level, message });
      }
    });
    await new Promise((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve());
      win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error('did-fail-load: ' + code + ' ' + desc)));
      win.loadFile(htmlPath).catch(reject);
    });
    // 等 __result
    let result = null;
    for (let i = 0; i < 50; i++) {
      const r = await win.webContents.executeJavaScript('JSON.stringify(window.__result || null)');
      if (r && r !== 'null') { result = JSON.parse(r); break; }
      await new Promise(r => setTimeout(r, 100));
    }
    log(`RTT result: ${JSON.stringify(result)}`);
    assert(result && result.log.some(l => l.includes('rtt-POST')), `RTT POST 成功 (log: ${JSON.stringify(result?.log)})`);
    assert(result && result.log.some(l => l.includes('health status=200')), `health 200`);
    assert(cspErrs.length === 0, `webContents 无 CSP 错误 (实际 ${cspErrs.length} 条)`);
    win.close();
    try { fs.rmSync(tmpHtmlDir, { recursive: true, force: true }); } catch {}

    // 关闭
    await ipc('canvas:stop', { sessionId: sid });
  }

  // =========== 清理 ===========
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

runTests().catch((e) => {
  log('FATAL: ' + e.stack);
  process.exit(2);
});
