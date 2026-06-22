// 端到端集成测试: 模拟 Electron 主进程启动画布 + 推送 DSL
// 验证:
//   1. canvas_preview.exe 能正常启动（不崩溃）
//   2. HTTP /render 端点能接收 DSL
//   3. 进程在 5s 后仍存活
//   4. 多次 DSL 推送稳定
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const exePath = path.resolve(__dirname, 'UI', 'resources', 'canvas', 'canvas-dist', 'canvas_preview.exe');
const exeDir = path.dirname(exePath);

if (!fs.existsSync(exePath)) {
  console.error(`[FAIL] canvas_preview.exe not found at ${exePath}`);
  process.exit(1);
}
console.log(`[INFO] exe: ${exePath}`);
console.log(`[INFO] cwd: ${exeDir}`);

const port = 11000 + Math.floor(Math.random() * 1000);
console.log(`[INFO] spawn canvas on port ${port}`);

const child = spawn(exePath, [
  `--port=${port}`,
  `--canvas-width=1024`,
  `--canvas-height=600`,
], {
  cwd: exeDir,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

child.stdout.on('data', d => console.log(`[stdout] ${d.toString().trim()}`));
child.stderr.on('data', d => console.error(`[stderr] ${d.toString().trim()}`));
child.on('exit', (code, signal) => console.log(`[exit] code=${code} signal=${signal}`));

// 等待端口起来
async function waitForPort(port, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const sock = require('net').createConnection({ host: '127.0.0.1', port }, () => {
          sock.end();
          resolve();
        });
        sock.on('error', reject);
      });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  return false;
}

function pushDSL(port, dsl) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(dsl);
    const req = http.request({
      host: '127.0.0.1', port, path: '/render', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 5000,
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body }));
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

(async () => {
  console.log('[STEP 1] waiting for canvas to start...');
  const ready = await waitForPort(port, 10000);
  if (!ready) {
    console.error(`[FAIL] canvas did not start on port ${port}`);
    child.kill('SIGTERM');
    process.exit(1);
  }
  console.log(`[OK] canvas listening on ${port}`);

  // 检查进程还活着
  await new Promise(r => setTimeout(r, 500));
  if (child.killed || child.exitCode !== null) {
    console.error(`[FAIL] canvas exited early: code=${child.exitCode}`);
    process.exit(1);
  }
  console.log(`[OK] canvas alive after 0.5s, pid=${child.pid}`);

  console.log('[STEP 2] pushing initial DSL (text + button)...');
  let r = await pushDSL(port, {
    type: 'render',
    ui: {
      type: 'container',
      props: { padding: 16 },
      children: [
        { type: 'text', props: { text: 'SoloForge Canvas Live', size: 28, color: '#FFFFFF' } },
        { type: 'text', props: { text: 'Embedded end-to-end test', size: 14, color: '#88FF88' } },
        { type: 'button', props: { label: 'Click me', onClick: 'demo' } },
      ],
    },
  });
  console.log(`  result: ${r.status} ${r.body}`);
  if (!r.ok) {
    console.error('[FAIL] initial DSL push failed');
    child.kill('SIGTERM');
    process.exit(1);
  }

  console.log('[STEP 3] pushing update DSL (different content)...');
  r = await pushDSL(port, {
    type: 'render',
    ui: {
      type: 'container',
      props: { padding: 16 },
      children: [
        { type: 'text', props: { text: 'Second Render', size: 24, color: '#FFAABB' } },
      ],
    },
  });
  console.log(`  result: ${r.status} ${r.body}`);
  if (!r.ok) {
    console.error('[FAIL] second DSL push failed');
    child.kill('SIGTERM');
    process.exit(1);
  }

  console.log('[STEP 4] waiting 2s and checking process still alive...');
  await new Promise(r => setTimeout(r, 2000));
  if (child.killed || child.exitCode !== null) {
    console.error(`[FAIL] canvas died after 2s: code=${child.exitCode}`);
    process.exit(1);
  }
  console.log(`[OK] canvas still alive pid=${child.pid}`);

  console.log('[STEP 5] stopping canvas...');
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 1000));
  if (!child.killed) child.kill('SIGKILL');

  console.log('\n========================================');
  console.log('[SUCCESS] end-to-end canvas integration test PASSED');
  console.log('========================================');
  process.exit(0);
})();
