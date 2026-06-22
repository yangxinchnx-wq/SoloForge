// 验证新版 PreviewPanel 推送的 DSL 格式能被 Flutter canvas 正确解析
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const exePath = path.resolve(__dirname, 'UI', 'resources', 'canvas', 'canvas-dist', 'canvas_preview.exe');
const exeDir = path.dirname(exePath);

const port = 12000 + Math.floor(Math.random() * 500);
console.log(`[INFO] spawn on port ${port}`);

const child = spawn(exePath, [`--port=${port}`], { cwd: exeDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', d => process.stdout.write(`[canvas] ${d}`));
child.stderr.on('data', d => process.stderr.write(`[canvas-err] ${d}`));

function post(payload) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1', port, path: '/render', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 5000,
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', e => resolve({ error: e.message }));
    req.write(data);
    req.end();
  });
}

(async () => {
  // 等待端口
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      await new Promise((resolve, reject) => {
        const sock = require('net').createConnection({ host: '127.0.0.1', port }, () => { sock.end(); resolve(); });
        sock.on('error', reject);
      });
      break;
    } catch {}
  }
  console.log('[OK] canvas up');

  // 测 1: 新版 {ui, platform} 格式
  console.log('\n[TEST 1] new format {ui, platform}');
  const r1 = await post({
    type: 'render',
    ui: {
      type: 'container',
      props: { padding: 16, backgroundColor: '#0B1020', layout: 'column', spacing: 8 },
      children: [
        { type: 'text', props: { content: '🎨 画布已就绪', fontSize: 18, color: '#FFFFFF' } },
        { type: 'text', props: { content: '当前底色: #0B1020', fontSize: 12, color: '#cbd5e1', opacity: 0.75 } },
        { type: 'button', props: { label: '示例按钮', variant: 'filled', color: '#3b82f6' } },
        { type: 'progress', props: { value: 0.7, color: '#3b82f6' } },
      ],
    },
    platform: 'material',
  });
  console.log('  result:', r1);
  if (r1.status !== 200) { console.error('[FAIL]'); child.kill(); process.exit(1); }

  // 测 2: 切到底色黑
  console.log('\n[TEST 2] switch bg to black');
  const r2 = await post({
    type: 'render',
    ui: {
      type: 'container',
      props: { padding: 16, backgroundColor: '#000000', layout: 'column', spacing: 8 },
      children: [
        { type: 'text', props: { content: '深色底', fontSize: 16, color: '#FFFFFF' } },
      ],
    },
    platform: 'material',
  });
  console.log('  result:', r2);
  if (r2.status !== 200) { console.error('[FAIL]'); child.kill(); process.exit(1); }

  // 测 3: 切到白色
  console.log('\n[TEST 3] switch bg to white');
  const r3 = await post({
    type: 'render',
    ui: {
      type: 'container',
      props: { padding: 16, backgroundColor: '#FFFFFF', layout: 'column', spacing: 8 },
      children: [
        { type: 'text', props: { content: '浅色底', fontSize: 16, color: '#000000' } },
      ],
    },
    platform: 'material',
  });
  console.log('  result:', r3);
  if (r3.status !== 200) { console.error('[FAIL]'); child.kill(); process.exit(1); }

  console.log('\n[OK] all DSL format tests passed');
  child.kill();
  await new Promise(r => setTimeout(r, 500));
  process.exit(0);
})();
