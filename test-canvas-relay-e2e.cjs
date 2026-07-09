/**
 * 端到端验证: Java Agent → Node.js relay → Flutter canvas 渲染链路
 *
 * 步骤:
 *   1. spawn canvas_preview.exe 在空闲端口
 *   2. 等待端口就绪
 *   3. POST /api/canvas/relay/register-port 注册到 Node.js (3001)
 *   4. POST /api/canvas/relay/push-ui 推送一个真实 AST
 *   5. 检查 Flutter 是否返回 200 (UiParser.parse + PlatformRenderer.build 成功)
 *   6. 清理
 *
 * 用法: node test-canvas-relay-e2e.cjs
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const BACKEND_URL = 'http://127.0.0.1:3001';
const exe = path.resolve(__dirname, 'UI/resources/canvas/canvas-dist/canvas_preview.exe');
const exeDir = path.resolve(__dirname, 'UI/resources/canvas/canvas-dist');
const modelsDir = path.resolve(__dirname, 'UI/resources/canvas/models');

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

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

async function main() {
  console.log('='.repeat(70));
  console.log('[e2e] Java Agent → Node.js relay → Flutter canvas 端到端测试');
  console.log('='.repeat(70));
  console.log('[e2e] exe:', exe);
  console.log('[e2e] exe exists:', fs.existsSync(exe));

  if (!fs.existsSync(exe)) {
    console.error('[e2e] ✗ canvas_preview.exe not found');
    process.exit(1);
  }

  // 1. 找空闲端口并 spawn Flutter
  const port = await findFreePort();
  console.log('[e2e] alloc Flutter port:', port);

  const child = spawn(exe, [
    '--port=' + port,
    '--canvas-width=800',
    '--canvas-height=600',
    '--models-dir=' + modelsDir,
  ], { cwd: exeDir, stdio: ['ignore', 'pipe', 'pipe'] });

  console.log('[e2e] Flutter pid:', child.pid);

  let stdout = '';
  child.stdout?.on('data', (d) => { stdout += d.toString(); });
  child.stderr?.on('data', (d) => { process.stderr.write('[flutter] ' + d.toString()); });

  // 2. 等端口就绪
  console.log('[e2e] waiting for Flutter HTTP server...');
  const ready = await waitForPort(port, 15000);
  if (!ready) {
    console.error('[e2e] ✗ Flutter port not ready');
    child.kill();
    process.exit(1);
  }
  console.log('[e2e] ✓ Flutter HTTP server ready on port', port);

  // 3. 注册端口到 Node.js
  console.log('[e2e] registering port to Node.js backend...');
  const regRes = await httpPost(`${BACKEND_URL}/api/canvas/relay/register-port`, {
    sessionId: 'e2e-test-canvas',
    port,
    pid: child.pid,
    hwnd: 0,
  });
  console.log('[e2e] register-port status:', regRes.status, 'body:', regRes.body);

  if (regRes.status !== 200) {
    console.error('[e2e] ✗ register failed');
    child.kill();
    process.exit(1);
  }

  // 4. 推送一个真实 AST — 模拟 LLM 生成的登录界面
  console.log('[e2e] pushing UI DSL (login screen AST)...');
  const dsl = {
    type: 'container',
    props: { padding: 24, backgroundColor: '#F5F5F5' },
    children: [
      { type: 'text', props: { content: '登录', fontSize: 28, fontWeight: 'bold', color: '#1A1A1A' } },
      { type: 'input', props: { placeholder: '用户名', borderColor: '#D1D5DB', borderRadius: 8 } },
      { type: 'input', props: { placeholder: '密码', borderColor: '#D1D5DB', borderRadius: 8 } },
      { type: 'button', props: { label: '登录', variant: 'filled', color: '#3B82F6' } },
      { type: 'divider', props: {} },
      { type: 'text', props: { content: '还没账号? 注册', fontSize: 13, color: '#6B7280' } },
    ],
  };

  const pushRes = await httpPost(`${BACKEND_URL}/api/canvas/relay/push-ui`, {
    sessionId: 'e2e-test-canvas',
    dsl,
    language: 'typescript',
  });

  console.log('[e2e] push-ui status:', pushRes.status);
  console.log('[e2e] push-ui body:', pushRes.body);

  if (pushRes.status === 200) {
    console.log('[e2e] ✓✓✓ 端到端链路打通！Flutter 已渲染登录界面');
    console.log('[e2e] 请检查 Flutter 窗口是否显示了登录表单');
    // 保持 5 秒让用户看到
    console.log('[e2e] 保持 5 秒供观察...');
    await new Promise((r) => setTimeout(r, 5000));
  } else {
    console.error('[e2e] ✗ push-ui failed');
  }

  // 5. 清理
  console.log('[e2e] cleaning up...');
  await httpPost(`${BACKEND_URL}/api/canvas/relay/unregister-port`, { sessionId: 'e2e-test-canvas' });
  child.kill();
  console.log('[e2e] done');
  process.exit(pushRes.status === 200 ? 0 : 1);
}

main().catch((e) => {
  console.error('[e2e] FATAL:', e);
  process.exit(1);
});
