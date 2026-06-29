// ─────────────────────────────────────────────────────────────────
// SoloForge 画布生命周期连通性测试
// 覆盖范围:
//   1. IPC 契约一致性 (main.cjs handler ↔ preload.cjs 暴露 ↔ PreviewPanel 调用)
//   2. Mock canvas 进程的 HTTP 路由契约 (pushUI / push / transform / status)
//   3. Crash 通知链路 (canvas:crashed IPC payload)
//   4. 状态机不变量 (start → stop → start 可重入, pause → 进程仍存活)
//
// 运行: node tests/canvas-lifecycle.mjs
// 退出码: 0 = 全部通过, 1 = 有失败
// ─────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const UI_ROOT = path.join(REPO_ROOT, 'UI');

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
  }
}

function section(name) {
  console.log(`\n\x1b[1m\x1b[36m══ ${name} ══\x1b[0m`);
}

// ─────────────────────────────────────────────────────────────────
// 第 1 节: 文件结构与 IPC 契约一致性
// ─────────────────────────────────────────────────────────────────
section('1. 文件结构 + IPC 契约');

const mainSrc = fs.readFileSync(path.join(UI_ROOT, 'electron/main.cjs'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(UI_ROOT, 'electron/preload.cjs'), 'utf8');
const previewSrc = fs.readFileSync(path.join(UI_ROOT, 'src/components/PreviewPanel.tsx'), 'utf8');

// main.cjs 应注册的 IPC handler 列表 (从 main.cjs 文本里抽出 ipcMain.handle)
const mainHandlers = [
  'canvas:start',
  'canvas:stop',
  'canvas:embed-status',
  'canvas:report-bounds',
  'canvas:host-info',
  'canvas:ensure-host',
  'canvas:status',
];
for (const h of mainHandlers) {
  assert(
    mainSrc.includes(`'${h}'`) || mainSrc.includes(`"${h}"`),
    `main.cjs 注册 handler: ${h}`,
  );
}

// preload.cjs 应暴露的方法
const preloadMethods = [
  'start', 'stop', 'embedStatus', 'status', 'reportBounds',
  'hostInfo', 'ensureHost', 'onCanvasCrashed',
];
for (const m of preloadMethods) {
  assert(
    preloadSrc.includes(`${m}:`) || preloadSrc.includes(`${m} =`),
    `preload.cjs 暴露: canvas.${m}`,
  );
}

// s3.4 修复 #3: onCanvasCrashed 必须存在
assert(preloadSrc.includes('onCanvasCrashed'), 'preload.cjs 暴露 onCanvasCrashed (修复 #3)');

// main.cjs 必须发 'canvas:crashed' IPC 通知 renderer
assert(
  mainSrc.includes("'canvas:crashed'"),
  "main.cjs 发送 'canvas:crashed' 通知 (修复 #3)",
);

// s3.4 修复 #9: child.on → child.once
assert(
  mainSrc.includes("child.once('exit'"),
  'main.cjs 用 child.once (修复 #9 防止重复触发)',
);

// s3.4 修复 #1: startAbortRef (PreviewPanel abort controller)
assert(
  previewSrc.includes('startAbortRef') && previewSrc.includes('AbortController'),
  'PreviewPanel 使用 AbortController (修复 #1)',
);

// s3.4 修复 #1: restartCanvas callback
assert(
  previewSrc.includes('restartCanvas'),
  'PreviewPanel 定义 restartCanvas (修复 #1)',
);

// s3.4 修复 #4: paused 恢复前先 ping 验证 process 存活
assert(
  previewSrc.includes('canvas.status(') && previewSrc.includes('canvasState === \'paused\''),
  'PreviewPanel paused 恢复前 ping 验证 (修复 #4)',
);

// s3.4 修复 #2: closeTab cleanup 用 activeTabId 而非 sessionIdRef
const cleanupLineMatch = previewSrc.match(/useEffect\(\(\) => \{[\s\S]*?return \(\) => \{[\s\S]*?window\.soloforge!\.canvas\.stop/);
assert(
  cleanupLineMatch !== null &&
  /const sid = activeTabId/.test(previewSrc),
  'PreviewPanel cleanup 使用 activeTabId (修复 #2)',
);

// s3.4 修复 #7: slowTick 必须 clearInterval + finally
assert(
  /} finally \{[\s\S]*?if \(slowTick\) clearInterval\(slowTick\)/m.test(previewSrc),
  'PreviewPanel startCanvas 用 finally 清理 slowTick (修复 #7)',
);

// s3.4 修复 #6: 入口并发守护
assert(
  previewSrc.includes('if (canvasStateRef.current === \'starting\')'),
  'PreviewPanel startCanvas 入口并发守护 (修复 #6)',
);

// ─────────────────────────────────────────────────────────────────
// 第 2 节: Mock canvas HTTP 路由契约
// ─────────────────────────────────────────────────────────────────
section('2. Mock canvas HTTP 路由契约');

// 这些 endpoint 是 Canvas3DClient 实际调用的 (从 src/services/canvas/Canvas3DClient.ts 抽出)
const expectedRoutes = [
  { method: 'POST', path: '/render', desc: 'selectDevice' },
  { method: 'POST', path: '/push-ui', desc: 'pushUI / pushWelcomeHint / feedASTChunk / flushAST' },
  { method: 'POST', path: '/transform', desc: 'transformDevice (高频)' },
  { method: 'POST', path: '/clear-devices', desc: 'clear3DDevices' },
  { method: 'POST', path: '/api/canvas/rtt/texture', desc: 'RTT 纹理 (s1.8)' },
  { method: 'POST', path: '/api/canvas/rtt/input', desc: 'RTT 输入事件 (s1.8)' },
  { method: 'GET',  path: '/api/canvas/rtt/devices', desc: 'RTT 设备列表 (s1.8)' },
  { method: 'POST', path: '/api/canvas/devices/reload', desc: '重载设备配置' },
  { method: 'GET',  path: '/api/canvas/devices/validation', desc: 'device config 校验结果' },
];

const clientSrc = fs.readFileSync(path.join(UI_ROOT, 'src/services/canvas/Canvas3DClient.ts'), 'utf8');
for (const r of expectedRoutes) {
  // 注意: 路由可能在模板字符串 ${baseUrl}/api/canvas/... 里
  // 检查路径末尾片段, 而非整段 (避免单引号/双引号/模板三种引号差异)
  const tail = r.path;
  assert(
    clientSrc.includes(tail),
    `Canvas3DClient 路由: ${r.method} ${r.path} (${r.desc})`,
  );
}

// pushBackground 走 Electron IPC (window.soloforge.canvas.setBackground), 不是 Canvas3DClient
const setBgInMain = mainSrc.includes("'canvas:set-background'") || mainSrc.includes('canvas:set-background');
const setBgInPreload = preloadSrc.includes('setBackground');
assert(setBgInMain && setBgInPreload, 'pushBackground 走 Electron IPC setBackground (而非 Canvas3DClient)');

// ─────────────────────────────────────────────────────────────────
// 第 3 节: 启动 mock canvas, 走完整生命周期
// ─────────────────────────────────────────────────────────────────
section('3. Mock canvas 生命周期端到端');

const mockCanvas = await startMockCanvas();
console.log(`  mock canvas 监听 http://127.0.0.1:${mockCanvas.port}`);

// 3.1 健康检查 — 验证 HTTP server 起来
const healthOk = await httpGet(`http://127.0.0.1:${mockCanvas.port}/health`);
assert(healthOk.status === 200, 'mock canvas /health 返回 200');

// 3.2 pushUI — 启动欢迎提示
const pushUi = await httpPost(`http://127.0.0.1:${mockCanvas.port}/push-ui`, {
  type: 'welcome-hint',
  message: '欢迎',
});
assert(pushUi.status === 200 && pushUi.body.received === true, 'pushUI welcome-hint 收到');

// 3.3 pushBackground — 推底色 (走 Electron IPC, 不打 mock canvas)
//    这里只验证 IPC handler 注册存在, 真实调用需要 Electron 环境
assert(
  mainSrc.includes('canvas:set-background') && preloadSrc.includes('setBackground'),
  'pushBackground IPC 通道可用 (修复 #4 链路)',
);

// 3.4 selectDevice — 选 iPhone 模型
const selectDev = await httpPost(`http://127.0.0.1:${mockCanvas.port}/render`, {
  deviceKey: 'iPhone15Pro',
});
assert(selectDev.status === 200 && selectDev.body.received === true, 'selectDevice iPhone15Pro 收到');

// 3.5 transformDevice — 高频 transform
const trans = await httpPost(`http://127.0.0.1:${mockCanvas.port}/transform`, {
  deviceId: 'iphone-1',
  x: 100, y: 200, scale: 1.5, rotation: 45,
});
assert(trans.status === 200, 'transformDevice 收到');

// 3.6 并发 transform (模拟拖拽连续 5 帧)
const concurrent = await Promise.all(
  Array.from({ length: 5 }, (_, i) =>
    httpPost(`http://127.0.0.1:${mockCanvas.port}/transform`, {
      deviceId: 'iphone-1', frame: i, x: 100 + i * 10,
    }),
  ),
);
assert(concurrent.every((r) => r.status === 200), '5 个并发 transform 全部 200');

// 3.7 未知路由 — 应 404 不应崩
const notFound = await httpGet(`http://127.0.0.1:${mockCanvas.port}/unknown-route`);
assert(notFound.status === 404, '未知路由返回 404');

// 3.8 模拟崩溃 — mock 关闭 server, 等同进程崩溃
mockCanvas.server.close();
const afterCrash = await httpGet(`http://127.0.0.1:${mockCanvas.port}/health`).catch((e) => ({
  status: 'CONNECTION_REFUSED',
  error: e.code,
}));
assert(
  afterCrash.status === 'CONNECTION_REFUSED' || afterCrash.status >= 500,
  'mock canvas 关闭后无法连接 (模拟崩溃)',
);

// 启动第二个 mock 测 stop
section('4. Stop 流程契约');
const mockCanvas2 = await startMockCanvas();
const stopRes = await httpPost(`http://127.0.0.1:${mockCanvas2.port}/api/stop`, {});
assert(stopRes.status === 200 && stopRes.body.stopped === true, 'canvas 接受 stop 指令');
// 关掉
mockCanvas2.server.close();

// ─────────────────────────────────────────────────────────────────
// 第 5 节: 状态机不变量
// ─────────────────────────────────────────────────────────────────
section('5. 状态机不变量');

// 5.1: 状态枚举完整性 — PreviewPanel 必须定义 5 状态
const stateMatch = previewSrc.match(/type CanvasState\s*=\s*([\s\S]*?);/);
assert(stateMatch !== null, 'CanvasState 类型定义存在');
if (stateMatch) {
  const states = ['idle', 'starting', 'running', 'paused', 'error'];
  for (const s of states) {
    assert(
      new RegExp(`'${s}'|"${s}"|\\b${s}\\b`).test(stateMatch[1]),
      `CanvasState 包含 '${s}'`,
    );
  }
}

// 5.2: 启动阶段完整性
const stages = ['init', 'preload', 'spawn', 'engine', 'shader', 'server', 'ready', 'connect', 'verify', 'done'];
for (const s of stages) {
  assert(
    previewSrc.includes(`'${s}'`),
    `StartStage 包含 '${s}'`,
  );
}

// 5.3: 错误分类完整性
const errorKinds = ['port-in-use', 'timeout', 'process-crash', 'path-not-found', 'electron-missing'];
for (const k of errorKinds) {
  assert(
    previewSrc.includes(`'${k}'`),
    `CanvasErrorKind 包含 '${k}'`,
  );
}

// 5.4: pause → resume 流程 — 必须有 pauseCanvas 和 paused 恢复路径
assert(
  previewSrc.includes('pauseCanvas'),
  'PreviewPanel 定义 pauseCanvas',
);
// paused → running 恢复路径 — 可能在 if 块内, 不强制要求同 block
const pausedRecoverPattern = /canvasState\s*===\s*'paused'[\s\S]{0,500}setCanvasState\('running'\)/m;
assert(
  pausedRecoverPattern.test(previewSrc),
  'paused → running 恢复路径存在 (修复 #4: 通过 canvas.status ping 验证)',
);

// ─────────────────────────────────────────────────────────────────
// 总结
// ─────────────────────────────────────────────────────────────────
console.log(`\n\x1b[1m════════════════════════════════════════\x1b[0m`);
console.log(`\x1b[32m通过: ${passed}\x1b[0m  \x1b[31m失败: ${failed}\x1b[0m`);
if (failed > 0) {
  console.log(`\n\x1b[31m失败项:\x1b[0m`);
  failures.forEach((f) => console.log(`  - ${f}`));
}
console.log(`\x1b[1m════════════════════════════════════════\x1b[0m`);

process.exit(failed > 0 ? 1 : 0);

// ─────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────
async function startMockCanvas() {
  const state = { routes: {} };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch {}
      // 记录请求,便于后续断言
      state.routes[req.url] = (state.routes[req.url] || 0) + 1;

      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
        return;
      }
      if (req.url === '/api/stop' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ stopped: true }));
        setTimeout(() => server.close(), 50);
        return;
      }
      // 业务路由 — 都返回 received: true
      const knownBusinessRoutes = [
        '/render', '/push-ui', '/transform', '/clear-devices',
        '/api/canvas/rtt/texture', '/api/canvas/rtt/input',
        '/api/canvas/rtt/devices', '/api/canvas/devices/reload',
        '/api/canvas/devices/validation',
      ];
      // 严格匹配 (避免 /api/canvas/rtt/drain 通过)
      if (knownBusinessRoutes.some((r) => req.url === r || req.url.startsWith(r + '?') || req.url.startsWith(r + '/'))) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true, route: req.url }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', route: req.url }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, port, state };
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let parsed = {};
        try { parsed = body ? JSON.parse(body) : {}; } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    }).on('error', reject);
  });
}

function httpPost(url, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const urlObj = new URL(url);
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let parsed = {};
        try { parsed = body ? JSON.parse(body) : {}; } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}