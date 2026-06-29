/**
 * 自动化测试 — 验证 startCanvas 整条逻辑链
 *
 * 模拟 main.cjs 里的 startCanvas 流程,直接 spawn canvas_preview.exe
 * 然后用 FFI findWindowByPid 找窗口,验证三级回退是否工作
 *
 * 用法: node test/start-canvas.mjs
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
console.log('[test] canvas_preview.exe 启动逻辑链测试');
console.log('='.repeat(60));
console.log('[test] exe  :', exe);
console.log('[test] models:', modelsDir);
console.log('[test] fs.existsSync(exe):', fs.existsSync(exe));
console.log('[test] fs.existsSync(models):', fs.existsSync(modelsDir));

// 引入 FFI
let native;
try {
  native = require(path.join(root, 'src', 'services', 'canvas', 'CanvasWindowManagerNative.cjs'));
  console.log('[test] FFI loaded, keys:', Object.keys(native).join(','));
} catch (e) {
  console.error('[test] FFI load failed:', e.message);
  process.exit(1);
}

// 找一个空闲端口
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

function waitForPort(port, timeoutMs = 12000) {
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

async function main() {
  const port = await findFreePort();
  console.log('[test] alloc port:', port);

  console.log('[test] spawning canvas_preview.exe...');
  const start = Date.now();
  const child = spawn(exe, [
    '--port=' + port,
    '--canvas-width=800',
    '--canvas-height=600',
    '--models-dir=' + modelsDir,
  ], {
    cwd: exeDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pid = child.pid;
  console.log('[test] child.pid:', pid);

  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout?.on('data', d => stdoutBuf += d.toString());
  child.stderr?.on('data', d => stderrBuf += d.toString());
  child.on('exit', (code) => {
    console.log(`[test] child exited code=${code} after ${Date.now() - start}ms`);
    if (stdoutBuf) console.log('[test] stdout:', stdoutBuf.slice(0, 500));
    if (stderrBuf) console.log('[test] stderr:', stderrBuf.slice(0, 500));
  });

  // 1. 等待端口
  console.log('[test] waiting for port...');
  const portReady = await waitForPort(port, 12000);
  console.log(`[test] port ready: ${portReady} (after ${Date.now() - start}ms)`);
  if (!portReady) {
    child.kill();
    process.exit(1);
  }

  // 2. 找窗口 — 用我们修改后的 FFI 三级回退
  console.log('[test] finding window with FFI findWindowByPid...');
  let hwnd = 0;
  let attempts = 0;
  for (let i = 0; i < 60 && hwnd === 0; i++) {
    hwnd = native.findWindowByPid(pid);
    attempts++;
    if (hwnd === 0) await new Promise(r => setTimeout(r, 200));
  }
  const elapsed = Date.now() - start;
  console.log(`[test] hwnd: ${hwnd} (after ${attempts} attempts, ${elapsed}ms total)`);

  if (hwnd === 0) {
    console.error('[test] ✗ HWND not found!');
    console.log('[test] stdout:', stdoutBuf.slice(0, 1000));
    console.log('[test] stderr:', stderrBuf.slice(0, 1000));

    // 用 PowerShell 调试看看到底有哪些窗口
    console.log('[test] dumping all windows of pid via PowerShell...');
    const { execSync } = require('child_process');
    try {
      const out = execSync(`powershell -NoProfile -Command "Get-Process -Id ${pid} | Select-Object Id,ProcessName,MainWindowHandle,MainWindowTitle | Format-List"`, { encoding: 'utf8' });
      console.log(out);
    } catch (e) {
      console.log('PS failed:', e.message);
    }
    child.kill();
    process.exit(1);
  }

  // 3. 测试 isWindowVisible 等
  console.log('[test] hwnd check:');
  try {
    const visible = native.isWindowVisible(hwnd);
    const parent = native.getParent(hwnd);
    const title = native.getWindowText(hwnd);
    console.log('  visible:', visible);
    console.log('  parent :', parent);
    console.log('  title  :', title);
  } catch (e) {
    console.log('  (check fn not avail):', e.message);
  }

  // 4. embed 测试
  console.log('[test] testing embedWindowFull...');
  try {
    // 用一个假 parent HWND 测 FFI 调用本身不崩
    const dummyParent = 0x12345;
    const ok = native.embedWindowFull(hwnd, dummyParent, 0, 0, 800, 600);
    console.log('  embedWindowFull (dummy) returned:', ok);
  } catch (e) {
    console.log('  embed failed:', e.message);
  }

  // 清理
  child.kill();
  console.log(`[test] ✓ ALL OK in ${Date.now() - start}ms`);
  process.exit(0);
}

main().catch(e => {
  console.error('[test] FATAL:', e);
  process.exit(1);
});
