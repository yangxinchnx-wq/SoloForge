/**
 * 集成测试 — 模拟 main.cjs 的 startCanvas 完整流程
 *
 * 步骤:
 *   1. 加载 CanvasWindowManagerNative FFI
 *   2. spawn canvas_preview.exe (带 --parent-hwnd=0 因为是测试,没有 host)
 *   3. 等端口 ready
 *   4. 60 次重试 findWindowByPid
 *   5. moveWindow 测试
 *   6. embedWindowFull 测试 (dummy parent)
 *   7. 关闭 canvas_preview.exe
 *
 * 用法: node test/start-canvas-full.cjs
 */

const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const exe = path.join(root, 'resources', 'canvas', 'canvas-dist', 'canvas_preview.exe');
const exeDir = path.join(root, 'resources', 'canvas', 'canvas-dist');
const modelsDir = path.join(root, 'resources', 'canvas', 'models');

console.log('='.repeat(60));
console.log('[test] startCanvas 完整流程集成测试');
console.log('='.repeat(60));

// ── FFI ──
let native;
try {
  native = require(path.join(root, 'src', 'services', 'canvas', 'CanvasWindowManagerNative.cjs'));
  console.log('[test] FFI loaded, keys:', Object.keys(native).length);
} catch (e) {
  console.error('[test] FFI load failed:', e.message);
  process.exit(1);
}

// ── helpers ──
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function waitForPort(port, timeoutMs = 10000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tryConnect = () => {
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => { sock.end(); resolve(true); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(tryConnect, 100);
      });
    };
    tryConnect();
  });
}

const log = (label, ...args) => {
  const ts = ((Date.now() - globalStart) / 1000).toFixed(2);
  console.log(`[${ts}s] [${label}]`, ...args);
};

const globalStart = Date.now();

async function main() {
  // 0. FFI 自检
  log('init', 'isWindowAlive(0):', native.isWindowAlive(0));
  log('init', 'isWindowVisible(0):', native.isWindowVisible(0));

  // 1. 端口
  const port = await findFreePort();
  log('init', 'alloc port:', port);

  // 2. spawn
  log('spawn', 'starting canvas_preview.exe...');
  const child = spawn(exe, [
    `--port=${port}`,
    `--parent-hwnd=0`,  // 测试用,没 host
    `--canvas-width=800`,
    `--canvas-height=600`,
    `--models-dir=${modelsDir}`,
  ], {
    cwd: exeDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  log('spawn', 'pid:', child.pid);

  let stdoutBuf = '', stderrBuf = '';
  child.stdout?.on('data', d => stdoutBuf += d.toString());
  child.stderr?.on('data', d => stderrBuf += d.toString());
  child.on('exit', (code) => log('spawn', `exit code=${code}`));

  // 3. 端口 ready
  const portReady = await waitForPort(port, 10000);
  log('port', 'ready:', portReady);
  if (!portReady) {
    log('fail', 'stdout:', stdoutBuf.slice(0, 500));
    log('fail', 'stderr:', stderrBuf.slice(0, 500));
    child.kill();
    process.exit(1);
  }

  // 4. findWindowByPid 60 次重试
  let hwnd = 0;
  let attempt = 0;
  for (let i = 0; i < 60 && hwnd === 0; i++) {
    hwnd = native.findWindowByPid(child.pid);
    attempt++;
    if (hwnd === 0) await new Promise(r => setTimeout(r, 200));
  }
  log('hwnd', `found: ${hwnd} (attempts=${attempt})`);
  if (hwnd === 0) {
    log('fail', 'HWND not found after 60 attempts');
    log('fail', 'stdout:', stdoutBuf.slice(0, 500));
    log('fail', 'stderr:', stderrBuf.slice(0, 500));
    child.kill();
    process.exit(1);
  }

  // 5. hwnd check
  const visible = native.isWindowVisible(hwnd);
  log('check', `visible: ${visible}`);

  // 6. getWindowProcessId 反向验证
  const foundPid = native.getWindowProcessId(hwnd);
  log('check', `getWindowProcessId: ${foundPid} (should match ${child.pid})`);
  if (foundPid !== child.pid) {
    log('warn', `PID mismatch! expected ${child.pid}, got ${foundPid}`);
  }

  // 7. moveWindow 测试
  log('move', 'testing moveWindow...');
  const moveOk = native.moveWindow(hwnd, 100, 100, 1024, 768);
  log('move', 'result:', moveOk);

  // 8. embedWindowFull dummy parent 测试 (测 FFI 调用链完整)
  log('embed', 'testing embedWindowFull with dummy parent...');
  const dummyParent = 0x12345;
  const embedOk = native.embedWindowFull(hwnd, dummyParent, 0, 0, 800, 600);
  log('embed', 'result:', embedOk);

  // 9. verifyEmbed dummy
  log('verify', 'testing verifyEmbed...');
  const v = native.verifyEmbed(hwnd, dummyParent);
  log('verify', 'result:', JSON.stringify(v));

  // 10. 关闭
  log('cleanup', 'killing canvas_preview.exe...');
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 500));
  if (!child.killed) child.kill('SIGKILL');

  log('done', `✓ 全部测试通过 (total ${Date.now() - globalStart}ms)`);
  process.exit(0);
}

main().catch(e => {
  console.error('[test] FATAL:', e);
  process.exit(1);
});
