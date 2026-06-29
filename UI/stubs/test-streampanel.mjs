// test-streampanel.mjs - 用 Edge 的 CDP 驱动,验证流送区接线
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9223;
const TARGET = 'http://localhost:3000/';

console.log('[1/7] launching Edge headless');
const userDir = `C:\\Users\\yangx\\AppData\\Local\\Temp\\edge-test-${Date.now()}`;
const edgeProc = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDir}`,
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--window-size=1400,900',
], { stdio: ['ignore', 'pipe', 'pipe'] });
edgeProc.stderr.on('data', () => {}); // suppress

console.log('[2/7] waiting for CDP');
let debugUrl = null;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  try {
    const r = await fetch(`http://localhost:${PORT}/json/version`);
    if (r.ok) { debugUrl = (await r.json()).webSocketDebuggerUrl; break; }
  } catch {}
}
if (!debugUrl) { console.error('CDP not ready'); edgeProc.kill(); process.exit(1); }
console.log('  ok');

console.log('[3/7] connecting CDP');
const ws = new WebSocket(debugUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });

let nextId = 1;
const cbs = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && cbs.has(m.id)) {
    const { resolve, reject } = cbs.get(m.id); cbs.delete(m.id);
    if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
  }
});
const send = (method, params = {}, sessionId = null) => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    cbs.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => { if (cbs.has(id)) { cbs.delete(id); reject(new Error('timeout ' + method)); } }, 10000);
  });
};

const { targetId } = await send('Target.createTarget', { url: TARGET });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const sess = (method, params = {}) => send(method, params, sessionId);

await sess('Page.enable');
await sess('Runtime.enable');
console.log('[4/7] navigating');
await sleep(3000); // 等 React 挂载 + dev helper 注册

const check = await sess('Runtime.evaluate', { expression: '({demo: typeof __demoStreamTask, getState: typeof __getStreamState, getActive: typeof __getActiveChatId})', returnByValue: true });
console.log('  helpers:', JSON.stringify(check.result.value));

const activeId = await sess('Runtime.evaluate', { expression: '__getActiveChatId()', returnByValue: true });
console.log('  activeChatId =', activeId.result.value);

console.log('[5/7] triggering __demoStreamTask');
const trigger = await sess('Runtime.evaluate', {
  expression: `(() => { const id = __getActiveChatId(); __demoStreamTask(id, 'fast'); return id; })()`,
  returnByValue: true,
});
console.log('  triggered for chatId =', trigger.result.value);

// 立即查询初始状态
await sleep(100);
const initialState = await sess('Runtime.evaluate', { expression: `JSON.stringify(__getStreamState('${trigger.result.value}'))`, returnByValue: true });
console.log('  t=100ms store state:', initialState.result.value);

console.log('[6/7] sampling store state every 500ms (5 samples)');
const samples = [];
for (let i = 0; i < 8; i++) {
  await sleep(500);
  const state = await sess('Runtime.evaluate', {
    expression: `(() => {
      const state = __getStreamState('${trigger.result.value}');
      // 查 DOM 中是否包含 "AI 执行流程"
      const text = document.body.innerText;
      const hasPanel = text.includes('AI 执行流程');
      const subtaskNames = state ? state.subTasks.map(s => s.assignee).filter(Boolean) : [];
      return JSON.stringify({
        phase: state?.phase,
        progress: state?.progress,
        subTaskCount: state?.subTasks.length,
        subtaskStatuses: state?.subTasks.map(s => s.status),
        subtaskNames,
        hasPanelInDOM: hasPanel,
      });
    })()`,
    returnByValue: true,
  });
  samples.push({ at: (i + 1) * 500, data: JSON.parse(state.result.value) });
}

console.log('\n=== samples ===');
for (const s of samples) {
  console.log(`@${s.at}ms phase=${s.data.phase} subTasks=${s.data.subTaskCount} [${(s.data.subtaskStatuses || []).join(',')}]`);
  console.log(`  modelNames: ${(s.data.subtaskNames || []).join(' | ')}`);
  console.log(`  StreamPanel in DOM: ${s.data.hasPanelInDOM}`);
}

console.log('\n[7/7] final DOM check + screenshot');
const finalText = await sess('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
const streamIdx = finalText.result.value.indexOf('AI 执行流程');
const streamSlice = streamIdx >= 0
  ? finalText.result.value.slice(streamIdx, streamIdx + 500)
  : '(AI 执行流程 not in DOM)';
console.log('--- stream panel text (first 500 chars) ---');
console.log(streamSlice);

const shot = await sess('Page.captureScreenshot', { format: 'png' });
writeFileSync('C:\\Users\\yangx\\Desktop\\SoloForge\\UI\\stubs\\streampanel-demo.png', Buffer.from(shot.data, 'base64'));
console.log('  screenshot → UI\\stubs\\streampanel-demo.png');

ws.close();
edgeProc.kill();
process.exit(0);