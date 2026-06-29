// ─────────────────────────────────────────────────────────────────
// SoloForge 画布 Windows 进程树 kill 测试 (canvas-kill-tree.cjs)
//
// 目的: 验证 s5 修复: Windows 上 killProcessTree 用 taskkill /T /F
//       杀整棵进程树 (主进程 + GPU worker + 派生子进程), 不留孤儿。
//
// 场景: 真实 Flutter canvas (canvas_preview.exe) 会派生 GPU worker,
//       Node child_process.kill() 只杀主进程, 不杀 worker → "关闭后不退出"
//
// 跑法: npx electron tests/canvas-kill-tree.cjs
// 退出: 0 = 通过, 1 = 失败
// ─────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

let electron;
try { electron = require('electron'); } catch (e) { console.error('FATAL: ' + e.message); process.exit(2); }
if (typeof electron === 'string') { console.error('FATAL: must run via electron'); process.exit(2); }
const { app } = electron;

const LOG_DIR = path.join(__dirname, '..', 'logs', 'e2e');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'canvas-kill-tree.log');
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

// 检查进程是否还活
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    // EPERM = 进程存在但没权限
    if (e.code === 'EPERM') return true;
    return false;
  }
}

// 找 main process 直接子进程 (Windows 用 wmic, 跨平台用 tasklist)
// 简化: 用 wmic 找 pid 的直接子进程
function listChildPidsWindows(parentPid) {
  try {
    const out = spawnSync('wmic', ['process', 'where', `ParentProcessId=${parentPid}`, 'get', 'ProcessId'], { encoding: 'utf8', windowsHide: true });
    if (out.status !== 0) return [];
    const lines = out.stdout.split('\n').slice(1);  // skip header
    const pids = [];
    for (const line of lines) {
      const m = line.trim().match(/^(\d+)/);
      if (m) pids.push(parseInt(m[1], 10));
    }
    return pids;
  } catch (e) {
    return [];
  }
}

// ── Mock canvas 脚本: 派生 2 个 worker 子进程 ──
function makeTreeCanvasScript() {
  const script = `
const { spawn } = require('child_process');
const portArg = process.argv.find(a => a.startsWith('--port='));
const port = portArg ? parseInt(portArg.split('=')[1], 10) : 0;
const log = (m) => { try { process.stdout.write('[mock-tree] ' + m + '\\n'); } catch {} };

// 启动 2 个 worker 子进程
function spawnWorker(name) {
  const w = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WORKER_NAME: name },
  });
  w.stdout.on('data', d => log('worker-' + name + ' stdout: ' + d.toString().trim()));
  w.stderr.on('data', d => log('worker-' + name + ' stderr: ' + d.toString().trim()));
  w.on('exit', (code, sig) => log('worker-' + name + ' exit code=' + code + ' sig=' + sig));
  return w;
}

const worker1 = spawnWorker('gpu');
const worker2 = spawnWorker('audio');
log('started workers: gpu=' + worker1.pid + ' audio=' + worker2.pid);

const http = require('http');
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
  res.writeHead(404); res.end();
});
server.listen(port, '127.0.0.1', () => log('listening ' + port + ' main pid=' + process.pid));

process.on('SIGTERM', () => log('SIGTERM received'));
process.on('exit', (code) => log('main exit code=' + code));
// 关键: main exit 时, 不会自动 kill workers
`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soloforge-tree-'));
  const scriptPath = path.join(tmpDir, 'mock-canvas-tree.js');
  fs.writeFileSync(scriptPath, script);
  return { scriptPath, tmpDir };
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const net = require('net');
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
    getNativeWindowHandle: () => { const buf = Buffer.alloc(32); buf.writeInt32LE(0x12345678, 0); return buf; },
  };
}

async function runTests() {
  log('');
  log('╔══════════════════════════════════════════════════════════╗');
  log('║  SoloForge 画布 Windows 进程树 kill 测试 (s5 修复验证)     ║');
  log('╚══════════════════════════════════════════════════════════╝');

  await app.whenReady();
  log(`platform: ${process.platform}`);

  const { createCanvasManager } = require(path.join(__dirname, '..', 'UI', 'electron', 'canvasHost.cjs'));
  const { scriptPath, tmpDir } = makeTreeCanvasScript();
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
    sendToCanvasRaw: () => Promise.resolve({ status: 0, body: '', error: 'no http' }),
    findFreePort,
    waitForPort: async (port, timeoutMs = 8000) => {
      const start = Date.now();
      const net = require('net');
      while (Date.now() - start < timeoutMs) {
        const ok = await new Promise((resolve) => {
          const sock = net.createConnection({ host: '127.0.0.1', port }, () => { sock.end(); resolve(true); });
          sock.on('error', () => resolve(false));
          setTimeout(() => { try { sock.destroy(); } catch {} resolve(false); }, 1000);
        });
        if (ok) return true;
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
    logPrefix: '[tree]',
  });
  cm.registerIpc();

  async function ipc(channel, payload) {
    try { return await mockIpcMain.invokeHandler(channel, payload); }
    catch (e) { return { ok: false, error: e.message }; }
  }

  // =========== Section 1: spawn canvas + 派生 workers, 验证子进程存在 ===========
  section('Section 1: 启动 mock canvas, 派生 2 个 worker 子进程');
  {
    const sid = 'tree-1';
    const startRes = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    assert(startRes.ok === true, `start 成功 (canvas pid=${startRes.session.pid})`);
    // 等 workers 启动
    await new Promise(r => setTimeout(r, 500));
    // 找 main 的子进程
    const childPids = listChildPidsWindows(startRes.session.pid);
    log(`canvas main pid=${startRes.session.pid}, child pids=${JSON.stringify(childPids)}`);
    assert(childPids.length >= 2, `main 派生 ≥ 2 个子进程 (实际 ${childPids.length})`);
    // 保存 worker pids 用于后面验证
    global.__workerPids = childPids;
  }

  // =========== Section 2: 用 Node child.kill (旧方式, 不杀树) ===========
  section('Section 2: 旧方式 child.kill — main 死, workers 仍在 (重现 bug)');
  {
    // 找 canvasSessions 里的 child
    const s = cm._internal.canvasSessions.get('tree-1');
    const child = s ? s.process : null;
    assert(child != null, 'canvas session 存在');
    // 旧方式: child.kill() (Windows: TerminateProcess, 只杀 main)
    try { child.kill(); } catch {}
    // 等 1s
    await new Promise(r => setTimeout(r, 1000));
    const mainAlive = isProcessAlive(child.pid);
    log(`main pid=${child.pid} alive after child.kill: ${mainAlive}`);
    assert(!mainAlive, `旧方式: main 进程已死 (实际 alive=${mainAlive})`);
    // 检查 workers 是否仍在 — 这是 bug!
    const aliveWorkers = global.__workerPids.filter(pid => isProcessAlive(pid));
    log(`workers 仍活数量: ${aliveWorkers.length} / ${global.__workerPids.length}`);
    if (aliveWorkers.length > 0) {
      log(`  [bug reproduced] 旧方式 child.kill() 不杀 worker 子进程, 进程树残留!`);
    }
    // 这个测试就是为了暴露这个 bug, 不需要 assert pass
  }

  // =========== Section 3: 用 taskkill /T /F (s5 修复) — main + workers 全死 ===========
  section('Section 3: 新方式 killProcessTree (taskkill /T /F) — main + workers 全死');
  {
    // 重新启动一个新 canvas (因为上一步 main 已死, 但 workers 还在)
    const sid = 'tree-2';
    const startRes = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
    assert(startRes.ok === true, `start 成功 (canvas pid=${startRes.session.pid})`);
    await new Promise(r => setTimeout(r, 500));
    const s = cm._internal.canvasSessions.get(sid);
    const child = s.process;
    const childPids = listChildPidsWindows(child.pid);
    log(`canvas-2 main pid=${child.pid}, child pids=${JSON.stringify(childPids)}`);
    assert(childPids.length >= 2, `main 派生 ≥ 2 个子进程 (实际 ${childPids.length})`);
    const workerPids = childPids;
    // 用 s5 修复: IPC canvas:stop 调 killProcessTree (taskkill /T /F)
    const stopRes = await ipc('canvas:stop', { sessionId: sid });
    assert(stopRes.ok === true, `stop 成功`);
    // 等 taskkill 完成
    await new Promise(r => setTimeout(r, 1000));
    const mainAlive = isProcessAlive(child.pid);
    log(`canvas-2 main pid=${child.pid} alive after killProcessTree: ${mainAlive}`);
    assert(!mainAlive, `s5: main 进程已死 (实际 alive=${mainAlive})`);
    // 关键: workers 也死了
    const aliveWorkers = workerPids.filter(pid => isProcessAlive(pid));
    log(`canvas-2 workers 仍活数量: ${aliveWorkers.length} / ${workerPids.length}`);
    assert(aliveWorkers.length === 0, `s5: 所有 worker 子进程已死 (实际 ${aliveWorkers.length} 仍活)`);
  }

  // =========== Section 4: 5x cycle, 不留孤儿 ===========
  section('Section 4: 5x start/stop cycle, 不留任何孤儿进程');
  {
    const allPids = [];
    for (let i = 0; i < 5; i++) {
      const sid = `tree-cycle-${i}`;
      const startRes = await ipc('canvas:start', { sessionId: sid, width: 800, height: 600 });
      assert(startRes.ok === true, `cycle ${i}: start 成功`);
      await new Promise(r => setTimeout(r, 400));
      const childPids = listChildPidsWindows(startRes.session.pid);
      allPids.push({ main: startRes.session.pid, workers: childPids });
      const stopRes = await ipc('canvas:stop', { sessionId: sid });
      assert(stopRes.ok === true, `cycle ${i}: stop 成功`);
    }
    // 等 taskkill
    await new Promise(r => setTimeout(r, 1500));
    let aliveMain = 0, aliveWorkers = 0;
    for (const p of allPids) {
      if (isProcessAlive(p.main)) aliveMain++;
      for (const w of p.workers) {
        if (isProcessAlive(w)) aliveWorkers++;
      }
    }
    log(`5 cycles: alive main=${aliveMain}, alive workers=${aliveWorkers}`);
    assert(aliveMain === 0, `5 cycles: 0 个 main 进程残留 (实际 ${aliveMain})`);
    assert(aliveWorkers === 0, `5 cycles: 0 个 worker 子进程残留 (实际 ${aliveWorkers})`);
  }

  // =========== Section 5: 旧残留 worker 清理 (s5 修了 tree-1 残留) ===========
  section('Section 5: 旧残留 worker 清理 (s5 修复历史残留)');
  {
    // Section 2 留下了一些 worker (主进程死了但 workers 仍在)
    const staleWorkers = global.__workerPids.filter(pid => isProcessAlive(pid));
    log(`Section 2 残留的 worker 数量: ${staleWorkers.length} / ${global.__workerPids.length}`);
    if (staleWorkers.length === 0) {
      log(`  [info] 没有残留, 跳过清理`);
      assert(true, '无残留 worker (Section 2 已被 OS 清理)');
    } else {
      // 手动 taskkill 清理
      for (const pid of staleWorkers) {
        try {
          spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } catch {}
      }
      await new Promise(r => setTimeout(r, 1000));
      const stillAlive = staleWorkers.filter(pid => isProcessAlive(pid));
      assert(stillAlive.length === 0, `taskkill /T /F 清理残留 worker (实际 ${stillAlive.length} 仍活)`);
    }
  }

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
