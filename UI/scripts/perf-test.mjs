// scripts/perf-test.mjs
// Electron headless 性能测试:
//   1) spawn electron perf-driver.cjs  — 启动静态 HTTP server + BrowserWindow
//   2) Electron 自动开 --remote-debugging-port=9223
//   3) chrome-remote-interface 直连 CDP, 拿 Page / Runtime / Network / Performance
//   4) 收集 Performance.getMetrics() / frame stats / download list / streamingStore 微基准
//   5) 输出 JSON 给报告用
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import fs from 'node:fs';
import CDP from 'chrome-remote-interface';
import http from 'node:http';

// === 工具: Race a promise against a timeout, return fallback on timeout ===
// CDP Promise + awaitPromise:true 可能永久挂起 (rAF 卡死 / 死循环)
// 给所有 Runtime.evaluate 加 max-wait 保护,perf-test 不允许 hang
async function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((res) => { timer = setTimeout(() => res(fallback), ms); });
  const result = await Promise.race([promise, timeout]);
  clearTimeout(timer);
  return result;
}

const __filename = new URL(import.meta.url).pathname.replace(/^\//, '');
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const DIST = path.join(ROOT, 'dist');
const INDEX = path.join(DIST, 'index.html');
const DEBUG_PORT = 9223;

if (!fs.existsSync(ELECTRON)) {
  console.error('electron.exe not found at', ELECTRON);
  process.exit(1);
}
if (!fs.existsSync(INDEX)) {
  console.error('dist/index.html missing — run npm run build first');
  process.exit(1);
}

const DEBUG_URL = `http://127.0.0.1:${DEBUG_PORT}`;

console.log('[perf] launching electron with --remote-debugging-port=' + DEBUG_PORT);

const env = {
  ...process.env,
  ELECTRON_DISABLE_SANDBOX: '1',
  ELECTRON_NO_ATTACH_CONSOLE: '1',
};

const DRIVER = path.join(__dirname, 'perf-driver.cjs');
console.log('[perf] using driver:', DRIVER);

const proc = spawn(ELECTRON, [
  DRIVER,
  '--remote-debugging-port=' + DEBUG_PORT,
  '--remote-allow-origins=*',
  '--no-sandbox',
  '--disable-gpu',
], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

proc.stdout.on('data', (d) => process.stdout.write('[electron] ' + d));
proc.stderr.on('data', (d) => process.stderr.write('[electron-err] ' + d));

// === 等待 CDP endpoint ===
async function getWsUrl(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const list = await new Promise((res, rej) => {
        http.get(DEBUG_URL + '/json', (r) => {
          let buf = '';
          r.on('data', (c) => (buf += c));
          r.on('end', () => res(JSON.parse(buf)));
        }).on('error', rej);
      });
      const t = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (t) return t.webSocketDebuggerUrl;
    } catch {}
    await delay(500);
  }
  throw new Error('CDP not ready');
}

const INIT_SCRIPT = `
(() => {
  // 屏蔽 localhost 后端 fetch / XHR — perf 模式不依赖后端
  const isBlocked = (url) => {
    if (typeof url !== 'string') url = String(url);
    // 后端常见端口
    if (new RegExp('^https?:[\\\\/]+(127\\\\.0\\\\.0\\\\.1|localhost):(3001|3002|8765|9090|6380|6379)').test(url)) return true;
    // 任意外部 /api/ 路径(SSE 流) — 不重连了
    if (/^https?:\\/[^/]+\\/api\\//.test(url)) return true;
    // 内部网段
    if (new RegExp('^http:[\\\\/]+10\\\\.').test(url)) return true;
    return false;
  };
  const ORIG_FETCH = window.fetch;
  window.fetch = function(input, init) {
    let url;
    if (typeof input === 'string') url = input;
    else if (input && typeof input === 'object' && 'url' in input) url = input.url;
    if (url && isBlocked(url)) {
      return Promise.resolve(new Response(JSON.stringify({ ok: false, skipped: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return ORIG_FETCH.apply(this, arguments);
  };
  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = class extends OrigXHR {
    open(method, url, ...rest) {
      if (isBlocked(url)) { this._blocked = true; return super.open(method, 'data:text/plain,', ...rest); }
      return super.open(method, url, ...rest);
    }
    send() { if (this._blocked) { this.readyState = 4; this.status = 200; return; } return super.send.apply(this, arguments); }
  };
  // 屏蔽 EventSource 全局 — 后端 SSE 在 perf 模式下不工作,但 EventSource 会持续重连吃资源
  const OrigEventSource = window.EventSource;
  if (OrigEventSource) {
    window.EventSource = class extends OrigEventSource {
      constructor(url, opts) {
        const u = typeof url === 'string' ? url : (url && url.url) || '';
        if (isBlocked(u)) {
          super('data:text/event-stream,', opts);
          this._blocked = true;
          return;
        }
        super(url, opts);
      }
      addEventListener() { /* no-op when blocked */ }
    };
  }
  // 屏蔽后端 polling setInterval (<= 2000ms) — 释放 main thread
  const OrigSetInterval = window.setInterval;
  window.setInterval = function(fn, ms, ...args) {
    if (ms > 0 && ms < 2000 && typeof fn === 'function') {
      if (!window.__blockedIntervals) window.__blockedIntervals = 0;
      window.__blockedIntervals++;
      return 0;
    }
    return OrigSetInterval.call(this, fn, ms, ...args);
  };
  // 保留 rAF 引用 (frameStats 用), 默认启用
  window.__rafOriginal = window.requestAnimationFrame;
  // 环形 log buffer
  window.__capturedLogs = [];
  const MAX = 200;
  const push = (type, text) => {
    if (window.__capturedLogs.length >= MAX) window.__capturedLogs.shift();
    window.__capturedLogs.push({ type, text });
  };
  const trim = (s) => s.length > 500 ? s.slice(0, 500) + '...' : s;
  const origError = console.error, origWarn = console.warn, origLog = console.log;
  console.error = (...a) => { push('error', trim(a.map(x => { try { return typeof x === 'string' ? x : (x?.message ? String(x.message) : JSON.stringify(x)); } catch { return String(x); } }).join(' '))); origError.apply(console, a); };
  console.warn = (...a) => { push('warn', trim(a.map(x => typeof x === 'string' ? x : String(x)).join(' '))); origWarn.apply(console, a); };
  console.log = (...a) => { push('log', trim(a.map(x => typeof x === 'string' ? x : String(x)).join(' '))); origLog.apply(console, a); };
  window.addEventListener('error', e => push('uncaught', e.message + ' at ' + e.filename + ':' + e.lineno));
  window.addEventListener('unhandledrejection', e => push('unhandled', String(e.reason)));
})();
`;

async function run() {
  let client;
  try {
    const wsUrl = await getWsUrl();
    console.log('[perf] CDP ready, ws:', wsUrl);
    client = await CDP({ target: { webSocketDebuggerUrl: wsUrl } });
    console.log('[perf] CDP connected');

    const { Page, Runtime, Network, Performance } = client;
    await Page.enable();
    await Runtime.enable();
    await Network.enable();
    await Performance.enable();

    // === 第一层屏蔽: Network.setBlockedURLs — 在 init script 注入前就生效
    // 屏蔽 perf 模式不需要的后端调用 + 任意 /api/ 路径
    // 这里用 prefix 列表,setBlockedURLs 是阻止 URL 子串
    await Network.setBlockedURLs({ urls: [
      '*://127.0.0.1:3001*',
      '*://localhost:3001*',
      '*://127.0.0.1:3002*',
      '*://localhost:3002*',
      '*://127.0.0.1:8765*',
      '*://127.0.0.1:9090*',
      '*://127.0.0.1:6380*',
      '*://127.0.0.1:6379*',
      '*/api/*',
    ] });

    // 收集 network 字节
    const downloadedChunks = new Set();
    let totalBytes = 0;
    Network.responseReceived((p) => {
      const url = p.response.url;
      const size = p.response.encodedDataLength || 0;
      totalBytes += size;
      downloadedChunks.add(url.split('/').pop().split('?')[0]);
    });
    Network.loadingFailed((p) => {
      if (p.errorText) {
        // ignore — 已 SPA fallback
      }
    });
    Runtime.consoleAPICalled((e) => {
      const text = e.args.map(a => a.value || a.description || '').join(' ');
      const t = e.type;
      if (e.type === 'error' && text.includes('404')) return; // 跳过 404 noise
      console.log('[page-console]', t, text);
    });
    Runtime.exceptionThrown((e) => {
      console.error('[page-exception]', e.exceptionDetails.exception?.description || e.exceptionDetails.text);
    });

    // 注入 init script + 刷新
    await Page.addScriptToEvaluateOnNewDocument({ source: INIT_SCRIPT });
    // 先 navigate to about:blank,让 hook 在新文档上重新注入,然后再导航回 perf page — 这样
    // 第一次 fetch 发出前 hook 已生效
    await Page.navigate({ url: 'about:blank' });
    await delay(300);
    await Page.navigate({ url: 'http://127.0.0.1:3007/' });
    console.log('[perf] page reload sent');
    await delay(2500);

    // 等首屏稳定 — 每次 evaluate 用 Runtime.evaluate 直发 + 短超时
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      const r = await Runtime.evaluate({
        expression: 'JSON.stringify({ ready: document.readyState === "complete" && !!document.querySelector("header"), rootLen: document.getElementById("root")?.children?.length || 0, hasStream: typeof window.__soloForgeStream !== "undefined" })',
        returnByValue: true,
        awaitPromise: false,
      });
      if (r.result && r.result.value) {
        try {
          const v = JSON.parse(r.result.value);
          if (v.ready && v.hasStream && v.rootLen > 0) { ready = true; break; }
        } catch {}
      }
      await delay(300);
    }
    if (!ready) console.warn('[perf] page not ready, continuing anyway');
    console.log('[perf] page ready, continuing');
    await delay(1500);

    // 收集 capturedLogs
    const captured = await Runtime.evaluate({
      expression: 'JSON.stringify((window.__capturedLogs || []).slice(-50))',
      returnByValue: true,
    });
    if (captured.result?.value) {
      const logs = JSON.parse(captured.result.value);
      if (logs.length) {
        console.log('[perf] captured page logs:');
        for (const l of logs) console.log('  [' + l.type + ']', l.text);
      } else {
        console.log('[perf] no captured page logs');
      }
    }

    // 收集 performance metrics
    const { metrics: rawMetrics } = await Performance.getMetrics();
    const m = Object.fromEntries(rawMetrics.map(x => [x.name, x.value]));

    // 60 帧空闲帧采样 — 临时恢复 rAF
    // 加 15s 兜底 — rAF 在主线程被 setInterval 吃满时不会触发, 避免 perf-test 整体 hang
    const frameStatsPromise = Runtime.evaluate({
      expression: `new Promise((resolve) => {
        const raf = window.__rafOriginal || window.requestAnimationFrame;
        const frames = [];
        let last = performance.now();
        let i = 0;
        function tick(ts) {
          frames.push(ts - last); last = ts; i++;
          if (i < 60) raf(tick);
          else {
            frames.sort();
            resolve(JSON.stringify({
              avgFrame: +(frames.reduce((a,b)=>a+b,0)/frames.length).toFixed(2),
              p95Frame: +frames[Math.floor(frames.length*0.95)].toFixed(2),
              maxFrame: +Math.max(...frames).toFixed(2),
              minFrame: +Math.min(...frames).toFixed(2),
              docReady: document.readyState,
              url: location.href,
              bodyChildrenCount: document.body.children.length,
            }));
          }
        }
        raf(tick);
      })`,
      awaitPromise: true,
      returnByValue: true,
    }).catch((e) => ({ exceptionDetails: { text: String(e?.message || e) } }));
    const frameStatsFallback = { result: { value: JSON.stringify({ avgFrame: -1, p95Frame: -1, maxFrame: -1, minFrame: -1, docReady: 'timeout', url: '', bodyChildrenCount: 0 }) } };
    const frameStatsRes = await withTimeout(frameStatsPromise, 15000, frameStatsFallback);
    const fsObj = JSON.parse(((frameStatsRes && frameStatsRes.result && frameStatsRes.result.value) || '{}'));

    // StreamingStore 微基准 — 用 50 次(非 1000), 每次都触发 React 重渲染
    const streamingBench = JSON.parse((await Runtime.evaluate({
      expression: `(() => {
        const stream = window.__soloForgeStream;
        if (!stream || !stream.applyEvent) return JSON.stringify({ error: 'no dev hook' });
        const N = 50;
        const ev0 = { kind: 'subtask_progress', chatId: '__perf__', ts: Date.now(), subTaskId: 's1', progress: 0, content: 'EXECUTE', status: 'running' };
        stream.__reset();
        stream.createTask('__perf__', 'perf', 'normal');
        const t0 = performance.now();
        for (let i = 0; i < N; i++) stream.applyEvent({ ...ev0, progress: (i/N)*100 });
        const t1 = performance.now();
        const task = stream.getTask('__perf__');
        stream.__reset();
        return JSON.stringify({
          eventCount: N,
          totalMs: +(t1 - t0).toFixed(2),
          perEventUs: +(((t1 - t0) * 1000) / N).toFixed(2),
          finalSubTasks: task?.subTasks?.length ?? 0,
          finalPhase: task?.phase,
        });
      })()`,
      returnByValue: true,
    })).result.value);

    // JSON 大对象
    const jsonBench = JSON.parse((await Runtime.evaluate({
      expression: `(() => {
        const big = { items: Array.from({ length: 200 }, (_, i) => ({ id: 'c'+i, title: 'chat'+i, msgs: Array.from({ length: 50 }, (_, j) => ({ role: 'u', text: 'msg'+j })) })) };
        const s0 = performance.now(); const str = JSON.stringify(big); const js = +(performance.now() - s0).toFixed(2);
        const o0 = performance.now(); JSON.parse(str); const jp = +(performance.now() - o0).toFixed(2);
        return JSON.stringify({ stringify: js, parse: jp, sizeKb: +(str.length/1024).toFixed(2) });
      })()`,
      returnByValue: true,
    })).result.value);

    // memory snapshot
    const memBefore = await Performance.getMetrics();
    const memBeforeMap = Object.fromEntries(memBefore.metrics.map(x => [x.name, x.value]));

    // 主题切换 stress
    const themeBench = JSON.parse((await Runtime.evaluate({
      expression: `(() => {
        const t0 = performance.now();
        const ev = [];
        for (let i = 0; i < 60; i++) {
          const begin = performance.now();
          const colors = { light: '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0') };
          localStorage.setItem('soloforge_customColors', JSON.stringify(colors));
          window.dispatchEvent(new StorageEvent('storage', { key: 'soloforge_customColors', newValue: JSON.stringify(colors) }));
          ev.push(performance.now() - begin);
        }
        const t1 = performance.now();
        ev.sort();
        return JSON.stringify({
          totalMs: +(t1 - t0).toFixed(2),
          avg: +(ev.reduce((a,b)=>a+b,0)/ev.length).toFixed(2),
          p95: +ev[Math.floor(ev.length*0.95)].toFixed(2),
          max: +Math.max(...ev).toFixed(2),
        });
      })()`,
      returnByValue: true,
    })).result.value);

    const memAfter = await Performance.getMetrics();
    const memAfterMap = Object.fromEntries(memAfter.metrics.map(x => [x.name, x.value]));

    const result = {
      ok: true,
      pageUrl: fsObj.url,
      docReady: fsObj.docReady,
      bodyChildren: fsObj.bodyChildrenCount,
      pageMetrics: m,
      frameStats: {
        avgFrame: fsObj.avgFrame,
        p95Frame: fsObj.p95Frame,
        maxFrame: fsObj.maxFrame,
        minFrame: fsObj.minFrame,
      },
      streamingBench,
      jsonBench,
      themeBench,
      memBefore: memBeforeMap,
      memAfter: memAfterMap,
      downloadedChunkCount: downloadedChunks.size,
      totalDownloadedBytes: totalBytes,
      chunks: Array.from(downloadedChunks).sort(),
      timestamp: new Date().toISOString(),
    };
    const outPath = path.join(ROOT, 'scripts', 'perf-output.json');
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log('\n========== PERF RESULT ==========');
    console.log(JSON.stringify(result, null, 2));
    console.log('=================================\n');
    console.log('[perf] saved to', outPath);
  } catch (e) {
    console.error('[perf] error', e);
    process.exitCode = 1;
  } finally {
    if (client) try { await client.close(); } catch {}
    proc.kill();
    await delay(300);
    try { proc.kill('SIGKILL'); } catch {}
  }
}

run().then(() => process.exit(process.exitCode || 0));
