/**
 * SVG 企鹅端到端验证
 *
 * 验证链路: Node.js relay → Flutter /render → flutter_svg 渲染 SVG 企鹅
 *
 * 用法: node test-canvas-svg-penguin.cjs
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const BACKEND_URL = 'http://127.0.0.1:3001';
const exeDir = path.resolve(__dirname, 'UI/resources/canvas/canvas-dist');
const exe = path.join(exeDir, 'canvas_preview.exe');
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

function waitForPort(port, timeoutMs = 15000) {
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
  console.log('[svg-e2e] SVG 企鹅渲染测试 (flutter_svg)');
  console.log('='.repeat(70));
  console.log('[svg-e2e] exe:', exe);
  console.log('[svg-e2e] exe exists:', fs.existsSync(exe));
  console.log('[svg-e2e] exe size:', fs.statSync(exe).size, 'bytes');

  const port = await findFreePort();
  console.log('[svg-e2e] alloc Flutter port:', port);

  const child = spawn(exe, [
    '--port=' + port,
    '--canvas-width=600',
    '--canvas-height=500',
    '--models-dir=' + modelsDir,
  ], { cwd: exeDir, stdio: ['ignore', 'pipe', 'pipe'] });

  console.log('[svg-e2e] Flutter pid:', child.pid);
  child.stderr?.on('data', (d) => { process.stderr.write('[flutter] ' + d.toString()); });

  console.log('[svg-e2e] waiting for Flutter HTTP server...');
  const ready = await waitForPort(port, 15000);
  if (!ready) {
    console.error('[svg-e2e] ✗ Flutter port not ready');
    child.kill();
    process.exit(1);
  }
  console.log('[svg-e2e] ✓ Flutter HTTP server ready on port', port);

  // 注册端口到 Node.js
  console.log('[svg-e2e] registering port to Node.js backend...');
  const regRes = await httpPost(`${BACKEND_URL}/api/canvas/relay/register-port`, {
    sessionId: 'svg-penguin-test',
    port,
    pid: child.pid,
    hwnd: 0,
  });
  console.log('[svg-e2e] register-port status:', regRes.status);

  // 推送 SVG 企鹅 AST
  console.log('[svg-e2e] pushing SVG penguin AST...');
  const penguinSvg = `<svg viewBox='0 0 200 240' xmlns='http://www.w3.org/2000/svg'>
    <ellipse cx='100' cy='130' rx='60' ry='80' fill='#1A1A1A'/>
    <ellipse cx='100' cy='150' rx='40' ry='55' fill='#FFFFFF'/>
    <circle cx='100' cy='55' r='32' fill='#1A1A1A'/>
    <circle cx='88' cy='50' r='5' fill='#FFFFFF'/>
    <circle cx='112' cy='50' r='5' fill='#FFFFFF'/>
    <polygon points='92,62 108,62 100,75' fill='#FFA000'/>
    <ellipse cx='80' cy='205' rx='18' ry='9' fill='#FFA000'/>
    <ellipse cx='120' cy='205' rx='18' ry='9' fill='#FFA000'/>
  </svg>`.replace(/\n\s*/g, ' ').trim();

  const dsl = {
    type: 'svg',
    props: {
      width: 200,
      height: 240,
      content: penguinSvg,
    },
  };

  const pushRes = await httpPost(`${BACKEND_URL}/api/canvas/relay/push-ui`, {
    sessionId: 'svg-penguin-test',
    dsl,
    language: 'typescript',
  });

  console.log('[svg-e2e] push-ui status:', pushRes.status);
  console.log('[svg-e2e] push-ui body:', pushRes.body);

  if (pushRes.status === 200) {
    console.log('[svg-e2e] ✓✓✓ SVG 企鹅渲染成功！请查看 Flutter 窗口');
    console.log('[svg-e2e] 保持 8 秒供观察...');
    await new Promise((r) => setTimeout(r, 8000));
  } else {
    console.error('[svg-e2e] ✗ push-ui failed');
  }

  // 清理
  console.log('[svg-e2e] cleaning up...');
  await httpPost(`${BACKEND_URL}/api/canvas/relay/unregister-port`, { sessionId: 'svg-penguin-test' });
  child.kill();
  console.log('[svg-e2e] done');
  process.exit(pushRes.status === 200 ? 0 : 1);
}

main().catch((e) => {
  console.error('[svg-e2e] FATAL:', e);
  process.exit(1);
});
