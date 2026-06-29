// test-decrypt-banner.mjs - 验证解密失败 banner、错误消息精准化、打开设置按钮
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9226;
const TARGET = 'http://localhost:3000/';

console.log('[1/6] launching Edge headless');
const userDir = `C:\\Users\\yangx\\AppData\\Local\\Temp\\edge-banner-${Date.now()}`;
const edgeProc = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDir}`,
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--window-size=1400,900',
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
await sleep(4000);

console.log('[2/6] 注入测试用的 cherry_providers_v2 (含一个加密 key 模拟设备指纹变化)');
const seed = await sess('Runtime.evaluate', { expression: `
  (() => {
    // 准备一个 enKey, 这个 key 用的是其他设备的 fingerprint, 本机无法解密
    // 用一个随机 base64 模拟, 反正加密格式对就行
    const fakeEncrypted = 'enc:v1:' + btoa('0123456789ab') + ':' + btoa('fakeciphertextbytes');
    const arr = [
      { id: 'minimax', name: 'MiniMax', enabled: false, baseUrl: 'https://api.minimaxi.chat/v1', apiKey: '', models: [] },
      { id: 'xiaomi', name: 'XIAOMIMIMO', enabled: true, baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: fakeEncrypted, models: [
        { id: 'mimo-v2-flash', enabled: true },
        { id: 'mimo-v2.5-pro', enabled: true }
      ] },
      { id: 'qwen-test', name: 'Qwen Test', enabled: true, baseUrl: 'https://example.com', apiKey: fakeEncrypted, models: [
        { id: 'qwen-test-model', enabled: true }
      ] },
    ];
    // 必须同时: (1) 写到 localStorage (2) 用 store.set 更新 store cache (3) 派发 providers_updated 事件
    // 仅 localStorage 不足以触发 store 重读 — store 用内存 cache 做同步读
    localStorage.setItem('cherry_providers_v2', JSON.stringify(arr));
    if (window.__settingsStore) {
      window.__settingsStore.set('cherry_providers_v2', arr);
    }
    window.dispatchEvent(new Event('providers_updated'));
    window.dispatchEvent(new Event('storage'));
    return 'seeded, encrypted count=' + arr.filter(p => p.apiKey.startsWith('enc:v1:')).length;
  })()
`, returnByValue: true });
console.log('  ', seed.result.value);
await sleep(1500); // 等 App.tsx 监听 providers_updated / storage 重新刷新

console.log('[2.5/6] 探针: localStorage 实际内容 + App 是否读到');
const probe1 = await sess('Runtime.evaluate', { expression: `
  (() => {
    const raw = localStorage.getItem('cherry_providers_v2');
    if (!raw) return { hasKey: false };
    const arr = JSON.parse(raw);
    return {
      hasKey: true,
      count: arr.length,
      encryptedCount: arr.filter(p => p.apiKey && p.apiKey.startsWith('enc:v1:')).length,
      names: arr.map(p => p.name),
      diagnostics: window.__decryptDiagnostics || 'none',
    };
  })()
`, returnByValue: true });
console.log(JSON.stringify(probe1.result.value, null, 2));

console.log('[3/6] 检查 banner 是否出现 + 内容 + 实际诊断数据');
const banner = await sess('Runtime.evaluate', { expression: `
  (() => {
    const el = document.querySelector('[data-testid="decryption-failure-banner"]');
    if (!el) return { found: false };
    return {
      found: true,
      bannerText: el.innerText,
      hasOpenSettingsBtn: !!el.querySelector('[data-testid="open-settings-from-banner"]'),
      bgColor: getComputedStyle(el).backgroundColor,
      diagnostics: window.__decryptDiagnostics || 'no __decryptDiagnostics',
    };
  })()
`, returnByValue: true });
console.log(JSON.stringify(banner.result.value, null, 2));

console.log('\n[5/6] 在打开 SettingsModal 之前先验证 in-chat 错误消息 (因为 modal 关闭会写回 DEFAULT 污染 store)');
const sendResult = await sess('Runtime.evaluate', { expression: `
  (async () => {
    if (typeof window.__triggerHandleSend !== 'function') return 'no-dev-hook';
    window.__triggerHandleSend();
    return 'triggered-via-dev-hook';
  })()
`, returnByValue: true, awaitPromise: true });
console.log('  send result:', sendResult.result.value);
await sleep(2000);

const errorMsg = await sess('Runtime.evaluate', { expression: `
  (() => {
    const text = document.body.innerText || '';
    const matches = {
      hasDecryptError: text.includes('API key 无法在本设备解密') || text.includes('设备指纹'),
      hasMainModelError: text.includes('主模型未配置') || text.includes('主模型'),
      hasXIAOMIMIMO: text.includes('XIAOMIMIMO'),
      hasQwenTest: text.includes('Qwen Test'),
      lastAssistantBlock: (() => {
        const blocks = Array.from(document.querySelectorAll('*')).filter(el => el.textContent && el.textContent.includes('❌') && el.textContent.includes('主模型'));
        if (blocks.length === 0) return null;
        return blocks[blocks.length - 1].textContent.slice(0, 500);
      })(),
      chatPanelProps: window.__chatPanelProps || 'missing',
      appDiagnostics: window.__decryptDiagnostics || 'missing',
    };
    return matches;
  })()
`, returnByValue: true });
console.log('  error probe:', JSON.stringify(errorMsg.result.value, null, 2));

console.log('\n[6/6] 截图最终状态');
const shot = await sess('Page.captureScreenshot', { format: 'png' });
writeFileSync('C:\\Users\\yangx\\Desktop\\SoloForge\\UI\\stubs\\decrypt-banner.png', Buffer.from(shot.data, 'base64'));
console.log('  screenshot → UI\\stubs\\decrypt-banner.png');

ws.close();
edgeProc.kill();
process.exit(0);
