// shot-cloudmodel.mjs - 重构后云端模型 tab 截图
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9227;
const TARGET = 'http://127.0.0.1:3000/';

console.log('[1/4] launching Edge headless');
const userDir = `C:\\Users\\yangx\\AppData\\Local\\Temp\\edge-cloudmodel-${Date.now()}`;
const edgeProc = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDir}`,
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--window-size=1600,1000',
], { stdio: ['ignore', 'pipe', 'pipe'] });
edgeProc.stderr.on('data', () => {});

let debugUrl = null;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  try {
    const r = await fetch(`http://localhost:${PORT}/json/version`);
    if (r.ok) { debugUrl = (await r.json()).webSocketDebuggerUrl; break; }
  } catch {}
}
if (!debugUrl) { console.error('CDP not ready'); edgeProc.kill(); process.exit(1); }

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
await sleep(5000);

console.log('[2/4] 注入测试数据 + 打开设置 → 切到云端模型');
const seed = await sess('Runtime.evaluate', { expression: `
  (() => {
    const fakeEncrypted = 'sk-test-1234567890';
    const arr = [
      { id: 'openai', name: 'OpenAI', enabled: true, baseUrl: 'https://api.openai.com/v1', defaultUrl: 'https://api.openai.com/v1', apiKey: fakeEncrypted, customModels: ['gpt-4o-test'], models: [
        { id: 'gpt-4o', name: 'GPT-4o', enabled: true, tags: ['chat','flagship'] },
        { id: 'gpt-4o-mini', name: 'GPT-4o mini', enabled: true, tags: ['chat','fast'] },
        { id: 'o1-preview', name: 'o1 Preview', enabled: false, tags: ['reasoning'] }
      ] },
      { id: 'anthropic', name: 'Anthropic', enabled: true, baseUrl: 'https://api.anthropic.com', defaultUrl: 'https://api.anthropic.com', apiKey: fakeEncrypted, customModels: [], models: [
        { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', enabled: true, tags: ['chat'] }
      ] },
    ];
    if (window.__settingsStore) {
      window.__settingsStore.set('cherry_providers_v2', arr);
    }
    localStorage.setItem('cherry_providers_v2', JSON.stringify(arr));
    return 'seeded, providers=' + arr.length;
  })()
`, returnByValue: true });
console.log('  ', seed.result.value);
await sleep(1500); // 等 HMR 编译完

// 通过 dev 钩子直接打开设置
const openResult = await sess('Runtime.evaluate', { expression: `
  (() => {
    if (typeof window.__openSettings !== 'function') return 'no-dev-hook';
    window.__openSettings();
    return 'opened via __openSettings';
  })()
`, returnByValue: true });
console.log('  open settings:', openResult.result.value);
await sleep(2500);

const switchTab = await sess('Runtime.evaluate', { expression: `
  (() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const cloudTab = tabs.find(t => t.textContent?.includes('云端模型'));
    if (!cloudTab) return 'no-cloud-tab, found ' + tabs.length + ' tabs';
    cloudTab.click();
    return 'switched, tabs: ' + tabs.map(t => t.textContent).join(' | ');
  })()
`, returnByValue: true });
console.log('  switch tab:', switchTab.result.value);
await sleep(800);

console.log('[3/4] 抓 DOM 文本确认标题与按钮变化');
const snapshot = await sess('Runtime.evaluate', { expression: `
  (() => {
    const apiKeyInput = document.getElementById('provider-api-key');
    const panel = apiKeyInput?.closest('div[class*="flex-1"][class*="rounded-2xl"]')
                || apiKeyInput?.closest('section')?.parentElement
                || document.body;
    const allButtons = Array.from(document.querySelectorAll('button'));
    const resetButtons = allButtons.filter(b => (b.textContent || '').trim() === '重置');

    // 抓左侧服务商列表的 li[data-provider-id] 节点,挨个导出 id + 对应 svg 的关键属性
    const list = Array.from(document.querySelectorAll('li[data-provider-id]'));
    const items = list.map(li => {
      const svg = li.querySelector('svg');
      const providerName = li.querySelector('span')?.textContent?.trim() || '';
      const innerSvg = svg ? svg.innerHTML : '';
      // 取 svg 内第一个 <path d="..."> 的前 6 个字符做指纹 (每个 brand logo path 不同)
      const pathMatch = innerSvg.match(/<path[^>]*d="([^"]{0,40})/);
      const titleMatch = innerSvg.match(/<title>([^<]+)<\\/title>/);
      const hash = pathMatch ? pathMatch[1].slice(0, 30) : '';
      return {
        id: li.getAttribute('data-provider-id'),
        name: providerName,
        svgWidth: svg?.getAttribute('width'),
        svgViewBox: svg?.getAttribute('viewBox'),
        svgTitle: titleMatch ? titleMatch[1] : null,
        pathFingerprint: hash,
        svgOuterHTMLLen: svg ? svg.outerHTML.length : 0,
      };
    });

    return {
      apiKeyInputExists: !!apiKeyInput,
      baseUrlInputExists: !!document.getElementById('provider-base-url'),
      resetButtonCount: resetButtons.length,
      providerCount: items.length,
      items,
    };
  })()
`, returnByValue: true });
console.log(JSON.stringify(snapshot.result.value, null, 2));

console.log('[4/4] 截图');
const shot = await sess('Page.captureScreenshot', { format: 'png' });
writeFileSync('C:\\Users\\yangx\\Desktop\\SoloForge\\UI\\stubs\\cloudmodel-refactor.png', Buffer.from(shot.data, 'base64'));
console.log('  screenshot → UI\\stubs\\cloudmodel-refactor.png');

ws.close();
edgeProc.kill();
process.exit(0);
