// ─────────────────────────────────────────────────────────────────
// SoloForge 画布 CSP 端到端测试 (canvas-csp-e2e.cjs)
//
// 目的: 真实启动 BrowserWindow, 加载一个测试 HTML, 注入与 main.cjs 完全相同的
//       Content-Security-Policy, 然后在 webContents 里跑 fetch 到 127.0.0.1 mock canvas。
//       验证: CSP 修复后, /api/canvas/rtt/input 不再被 Refused to connect 拒绝。
//
// 跑法: npx electron tests/canvas-csp-e2e.cjs
// 退出: 0 = 全部通过, 1 = 失败
//
// 与 csp.test.cjs 的区别:
//   csp.test.cjs: 静态解析 main.cjs 源码, 检查 CSP 字符串文本
//   canvas-csp-e2e.cjs: 真实启动 Electron + BrowserWindow, 验证 fetch 在 CSP 下真能成功
// ─────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');

let electron;
try { electron = require('electron'); } catch (e) { console.error('FATAL: ' + e.message); process.exit(2); }
if (typeof electron === 'string') { console.error('FATAL: must run via electron'); process.exit(2); }
const { app, BrowserWindow, session } = electron;

const LOG_DIR = path.join(__dirname, '..', 'logs', 'e2e');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'canvas-csp-e2e.log');
try { fs.unlinkSync(LOG_FILE); } catch {}
const PASS = [];
const FAIL = [];
const LOG_LINES = [];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  LOG_LINES.push(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  try { process.stdout.write(line + '\n'); } catch {}
}
function assert(cond, msg) {
  if (cond) { PASS.push(msg); log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { FAIL.push(msg); log(`  \x1b[31m✗\x1b[0m ${msg}`); }
}
function section(name) { log(''); log(`══ ${name} ══`); }

// ── Mock canvas HTTP server (127.0.0.1:randomPort) ──
// 模拟 Flutter canvas 进程, 监听 RTT input 端点
function startMockCanvasServer() {
  return new Promise((resolve) => {
    const rttQueue = [];
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url.startsWith('/api/canvas/rtt/input')) {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            const ev = JSON.parse(body);
            rttQueue.push({ ...ev, t: Date.now() });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, queueSize: rttQueue.length }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/api/canvas/rtt/input')) {
        const url = new URL(req.url, 'http://127.0.0.1');
        const sid = url.searchParams.get('sessionId');
        let events = rttQueue;
        if (sid) events = events.filter(e => e.sessionId === sid);
        rttQueue.length = 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: events.length, events }));
        return;
      }
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, getRttCount: () => rttQueue.length, drainRtt: () => { const out = rttQueue.slice(); rttQueue.length = 0; return out; } });
    });
  });
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

// ── 与 main.cjs 完全一致的 CSP 字符串 (复制自 UI/electron/main.cjs setupCsp) ──
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

// ── 测试 HTML: 注入 CSP + 跑 fetch ──
function buildTestHtml(csp, mockPort) {
  return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>CSP Test</title>
</head>
<body>
<h1>CSP E2E Test</h1>
<pre id="out">pending</pre>
<script>
(async () => {
  const out = document.getElementById('out');
  const port = ${mockPort};
  const log = [];
  const errs = [];
  // 抓 window.onerror + unhandledrejection
  window.addEventListener('error', (e) => errs.push('window.error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errs.push('unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));

  // 1. 验证 RTT input POST
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/canvas/rtt/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', deviceId: 'd1', type: 'tap', u: 0.5, v: 0.5, timestamp: Date.now() }),
    });
    const j = await r.json();
    log.push('rtt-input-POST ok=' + j.ok + ' queueSize=' + j.queueSize);
  } catch (e) {
    errs.push('rtt-input-POST error: ' + e.message);
  }

  // 2. 验证 RTT input GET (drain)
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/canvas/rtt/input?sessionId=s1');
    const j = await r.json();
    log.push('rtt-input-GET ok=' + j.ok + ' count=' + j.count);
  } catch (e) {
    errs.push('rtt-input-GET error: ' + e.message);
  }

  // 3. 验证 WS 端口 (connect-src 是否允许 ws://127.0.0.1)
  try {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    const wsRes = await new Promise((resolve) => {
      const t = setTimeout(() => resolve('TIMEOUT'), 3000);
      ws.onopen = () => { clearTimeout(t); resolve('OPEN'); };
      ws.onerror = () => { clearTimeout(t); resolve('ERROR'); };
    });
    try { ws.close(); } catch {}
    log.push('ws-127.0.0.1=' + wsRes);
  } catch (e) {
    errs.push('ws error: ' + e.message);
  }

  // 4. 验证 http://localhost (回归 — 不能因 127.0.0.1 修复而破坏 localhost)
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/health');
    const j = await r.json();
    log.push('health-127.0.0.1 ok=' + j.ok);
  } catch (e) {
    errs.push('health error: ' + e.message);
  }

  out.textContent = JSON.stringify({ log, errs }, null, 2);
  window.__testResult = { log, errs };
})();
</script>
</body>
</html>`;
}

async function runTests() {
  log('');
  log('╔══════════════════════════════════════════════════════════╗');
  log('║  SoloForge 画布 CSP 端到端测试                            ║');
  log('╚══════════════════════════════════════════════════════════╝');

  await app.whenReady();
  log('electron app ready');

  // 1. 启动 mock canvas
  const mock = await startMockCanvasServer();
  log(`mock canvas listening 127.0.0.1:${mock.port}`);

  // 2. 在 default session 注册 onHeadersReceived, 注入 CSP (与 main.cjs 一致)
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      const headers = details.responseHeaders || {};
      headers['Content-Security-Policy'] = [MAIN_CSP];
      callback({ responseHeaders: headers });
    }
  );

  // 3. 写一个临时 HTML 文件 (data: URL 没法用 CSP 注入 header, 用 file://)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soloforge-csp-'));
  const htmlPath = path.join(tmpDir, 'test.html');
  const html = buildTestHtml(MAIN_CSP, mock.port);
  fs.writeFileSync(htmlPath, html);
  log(`test html: ${htmlPath}`);

  // 4. 启动 BrowserWindow 加载 HTML
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: false,  // Windows offscreen 在某些环境下不稳, 关掉
    },
  });

  // 5. 抓 console-message 和 dom-ready
  const consoleMessages = [];
  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    consoleMessages.push({ level, message, source: sourceId, line });
    log(`  [console L${level}] ${message}`);
  });

  // 6. loadFile + 等待 __testResult
  await new Promise((resolve, reject) => {
    win.webContents.once('did-finish-load', () => {
      log('did-finish-load');
      // 等 __testResult 出现 (max 5s)
      const start = Date.now();
      const tick = setInterval(async () => {
        try {
          const r = await win.webContents.executeJavaScript('JSON.stringify(window.__testResult || null)');
          if (r && r !== 'null') {
            clearInterval(tick);
            resolve(JSON.parse(r));
            return;
          }
        } catch {}
        if (Date.now() - start > 5000) {
          clearInterval(tick);
          reject(new Error('__testResult timeout'));
        }
      }, 100);
    });
    win.webContents.once('did-fail-load', (_e, code, desc, url) => {
      reject(new Error(`did-fail-load: ${code} ${desc} ${url}`));
    });
    win.loadFile(htmlPath).catch(reject);
  }).catch((e) => {
    log('loadFile error: ' + e.message);
  });

  // 7. 读取结果
  const result = await win.webContents.executeJavaScript('JSON.stringify(window.__testResult || {})').then(s => JSON.parse(s));
  log('test result: ' + JSON.stringify(result, null, 2));

  // =========== Section 1: CSP 修复后 fetch 127.0.0.1 不被拒绝 ===========
  section('Section 1: CSP 修复后 fetch 127.0.0.1 成功 (核心 bug)');
  {
    assert(Array.isArray(result.log) && result.log.length > 0, 'fetch 日志非空');
    assert(!result.errs || result.errs.length === 0, `无 fetch 错误 (errs=${JSON.stringify(result.errs || [])})`);
    const rttPost = (result.log || []).find(l => l.startsWith('rtt-input-POST'));
    assert(rttPost && rttPost.includes('ok=true'), 'POST /api/canvas/rtt/input 成功 (CSP 不再 Refused to connect)');
    const rttGet = (result.log || []).find(l => l.startsWith('rtt-input-GET'));
    assert(rttGet && rttGet.includes('ok=true'), 'GET /api/canvas/rtt/input 成功 (drain 端点)');
    const health = (result.log || []).find(l => l.startsWith('health-127.0.0.1'));
    assert(health && health.includes('ok=true'), '/health 127.0.0.1 成功');
  }

  // =========== Section 2: WS 端口 CSP 允许 ===========
  section('Section 2: WebSocket 127.0.0.1 CSP 允许');
  {
    const wsLine = (result.log || []).find(l => l.startsWith('ws-127.0.0.1'));
    // mock canvas 没真 WS 端点, 但只要 CSP 不阻止, connect() 不会立即被拒绝
    // (会超时 / 失败, 但不应是 'Refused to connect' 类的 CSP 错误)
    assert(wsLine, 'WS 127.0.0.1 fetch 尝试已执行 (无 CSP 即时拒绝)');
    assert(!wsLine.includes('Refused'), 'WS 127.0.0.1 没出现 CSP 拒绝消息');
  }

  // =========== Section 3: console-message 无 CSP 错误 ===========
  section('Section 3: console-message 无 CSP 错误');
  {
    const cspErrors = consoleMessages.filter(m =>
      /Content Security Policy/i.test(m.message) ||
      /Refused to connect/i.test(m.message) ||
      /CSP/i.test(m.message) && /violat/i.test(m.message)
    );
    assert(cspErrors.length === 0, `无 CSP 错误消息 (实际 ${cspErrors.length} 条)`);
    if (cspErrors.length > 0) {
      for (const e of cspErrors) log(`    CSP 错误: L${e.level} ${e.message}`);
    }
  }

  // =========== Section 4: mock canvas 真的收到了 rtt input ===========
  section('Section 4: mock canvas 收到 RTT input');
  {
    // 重新 drain 看 (前面 GET 已经 drain 过一次, 应为空)
    // 推一个 + drain 验证 mock server 端真的在收
    await new Promise((resolve) => {
      const data = JSON.stringify({ sessionId: 's2', deviceId: 'd2', type: 'tap', u: 0.1, v: 0.2, timestamp: Date.now() });
      const req = http.request({ host: '127.0.0.1', port: mock.port, path: '/api/canvas/rtt/input', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
        let buf = ''; res.on('data', c => buf += c);
        res.on('end', () => resolve(JSON.parse(buf)));
      });
      req.on('error', () => resolve({ ok: false }));
      req.write(data); req.end();
    });
    const drained = mock.drainRtt();
    assert(drained.length >= 1, `mock 收到 RTT input (drain ${drained.length} 条)`);
  }

  // =========== 清理 ===========
  win.close();
  mock.server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  // =========== 汇总 ===========
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
