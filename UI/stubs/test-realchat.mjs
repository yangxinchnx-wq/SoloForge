// test-realchat.mjs - 真实 chat SSE → pushStreamEventForPhase → streamingStore 全链路
// 在已挂载的 UI 里直接调 __realChat(chatId, prompt) 钩子
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9224;
const TARGET = 'http://localhost:3000/';

console.log('[1/8] launching Edge headless');
const userDir = `C:\\Users\\yangx\\AppData\\Local\\Temp\\edge-test-realchat-${Date.now()}`;
const edgeProc = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDir}`,
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--window-size=1400,900',
], { stdio: ['ignore', 'pipe', 'pipe'] });
edgeProc.stderr.on('data', () => {});

console.log('[2/8] waiting for CDP');
let debugUrl = null;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  try {
    const r = await fetch(`http://localhost:${PORT}/json/version`);
    if (r.ok) { debugUrl = (await r.json()).webSocketDebuggerUrl; break; }
  } catch {}
}
if (!debugUrl) { console.error('CDP not ready'); edgeProc.kill(); process.exit(1); }

console.log('[3/8] connecting CDP');
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
    setTimeout(() => { if (cbs.has(id)) { cbs.delete(id); reject(new Error('timeout ' + method)); } }, 15000);
  });
};

const { targetId } = await send('Target.createTarget', { url: TARGET });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const sess = (method, params = {}) => send(method, params, sessionId);

await sess('Page.enable');
await sess('Runtime.enable');
console.log('[4/8] waiting for React + dev helpers');
await sleep(4000);

const activeId = (await sess('Runtime.evaluate', { expression: '__getActiveChatId()', returnByValue: true })).result.value;
console.log('  activeChatId =', activeId);

console.log('[5/8] triggering __demoStreamTask (synthetic baseline)');
await sess('Runtime.evaluate', { expression: `__demoStreamTask('${activeId}', 'fast')`, returnByValue: true });
await sleep(2500); // 等 demo 跑完
const baseline = (await sess('Runtime.evaluate', { expression: `JSON.stringify(__getStreamState('${activeId}'))`, returnByValue: true })).result.value;
console.log('  baseline after demo:', baseline);

console.log('[6/8] sampling store state every 600ms during real chat');
// 真实 chat 通过点击发送按钮触发: 找到输入框并填入文本
const setup = await sess('Runtime.evaluate', { expression: `
  (() => {
    // 找输入框 (textarea 或 contentEditable)
    const ta = document.querySelector('textarea[placeholder*="输入"]') || document.querySelector('textarea');
    if (!ta) return 'no-textarea';
    // 设置为 React 受控值
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '用一句话介绍北京');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()
`, returnByValue: true });
console.log('  input setup:', setup.result.value);

await sleep(300);
const click = await sess('Runtime.evaluate', { expression: `
  (() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const sendBtn = buttons.find(b => b.getAttribute('aria-label') === 'send' || b.textContent?.includes('发送') || b.querySelector('svg.lucide-send'));
    if (!sendBtn) return 'no-send-button';
    sendBtn.click();
    return 'clicked';
  })()
`, returnByValue: true });
console.log('  send click:', click.result.value);

const samples = [];
for (let i = 0; i < 10; i++) {
  await sleep(600);
  const s = (await sess('Runtime.evaluate', { expression: `
    (() => {
      const state = __getStreamState('${activeId}');
      const text = document.body.innerText;
      return JSON.stringify({
        phase: state?.phase,
        progress: state?.progress,
        subTaskCount: state?.subTasks?.length,
        subtaskStatuses: state?.subTasks?.map(s => s.status),
        streamPanelText: text.includes('AI 执行流程') ? text.slice(text.indexOf('AI 执行流程'), text.indexOf('AI 执行流程') + 200) : 'no panel',
      });
    })()
  `, returnByValue: true })).result.value;
  samples.push({ at: (i + 1) * 600, data: JSON.parse(s) });
}

console.log('\n=== real chat samples ===');
for (const s of samples) {
  console.log(`@${s.at}ms phase=${s.data.phase} subTasks=${s.data.subTaskCount} [${(s.data.subtaskStatuses || []).join(',')}]`);
  console.log(`  panel: ${(s.data.streamPanelText || '').slice(0, 100).replace(/\n/g, ' | ')}`);
}

console.log('\n[7/8] final state');
const finalState = (await sess('Runtime.evaluate', { expression: `JSON.stringify(__getStreamState('${activeId}'))`, returnByValue: true })).result.value;
console.log('  final:', finalState);

console.log('[8/8] screenshot');
const shot = await sess('Page.captureScreenshot', { format: 'png' });
writeFileSync('C:\\Users\\yangx\\Desktop\\SoloForge\\UI\\stubs\\realchat-final.png', Buffer.from(shot.data, 'base64'));
console.log('  screenshot → UI\\stubs\\realchat-final.png');

ws.close();
edgeProc.kill();
process.exit(0);
