// probe-providers.mjs - 探查 UI 端 cherry_providers_v2 实际状态
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9225;

console.log('[1/5] launching Edge headless');
const userDir = `C:\\Users\\yangx\\AppData\\Local\\Temp\\edge-probe-${Date.now()}`;
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

const { targetId } = await send('Target.createTarget', { url: 'http://localhost:3000/' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const sess = (method, params = {}) => send(method, params, sessionId);

await sess('Page.enable');
await sess('Runtime.enable');
await sleep(4000);

console.log('[2/5] inspect localStorage: cherry_providers_v2');
const ls = (await sess('Runtime.evaluate', { expression: `
  (() => {
    const raw = localStorage.getItem('cherry_providers_v2');
    if (!raw) return 'NULL_OR_EMPTY';
    try {
      const arr = JSON.parse(raw);
      return JSON.stringify(arr.map(p => ({
        id: p.id,
        name: p.name,
        enabled: p.enabled,
        baseUrl: p.baseUrl || p.defaultUrl,
        apiKeyPrefix: p.apiKey ? p.apiKey.slice(0, 12) : 'EMPTY',
        apiKeyIsEncrypted: typeof p.apiKey === 'string' && p.apiKey.startsWith('enc:v1:'),
        modelCount: Array.isArray(p.models) ? p.models.length : 0,
        enabledModels: Array.isArray(p.models) ? p.models.filter(m => m.enabled !== false).map(m => m.id) : [],
      })), null, 2);
    } catch (e) {
      return 'PARSE_ERROR: ' + e.message + ' raw=' + raw.slice(0, 200);
    }
  })()
`, returnByValue: true })).result.value;
console.log(ls);

console.log('\n[3/5] probe decrypted modelProviderMap (window.__appModelMap if exposed)');
const map = (await sess('Runtime.evaluate', { expression: `
  (() => {
    // 触发解密: 调用 buildModelProviderMap 配合 decrypted 数据
    if (typeof window.__appModelMap === 'function') return JSON.stringify(window.__appModelMap());
    return '__appModelMap not exposed';
  })()
`, returnByValue: true })).result.value;
console.log(map);

console.log('\n[4/5] try decrypt a sample apiKey to see if device-key derivation works');
const decryptTest = (await sess('Runtime.evaluate', { expression: `
  (async () => {
    const raw = localStorage.getItem('cherry_providers_v2');
    if (!raw) return 'no raw';
    const arr = JSON.parse(raw);
    const sample = arr.find(p => p.apiKey && p.apiKey.startsWith('enc:v1:'));
    if (!sample) return 'no encrypted key to test';
    // 模拟 decryptSecret
    try {
      const parts = sample.apiKey.split(':');
      const iv = Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0));
      const cipherBuf = Uint8Array.from(atob(parts[3]), c => c.charCodeAt(0));
      const subtle = crypto.subtle;
      const enc = new TextEncoder();
      const baseKey = await subtle.importKey('raw', enc.encode(navigator.userAgent + '|' + navigator.language + '|' + navigator.platform), { name: 'PBKDF2' }, false, ['deriveKey']);
      const key = await subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode('soloforge.cherry.v1'), iterations: 100000, hash: 'SHA-256' }, baseKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      const plainBuf = await subtle.decrypt({ name: 'AES-GCM', iv }, key, cipherBuf);
      return 'OK decrypted: ' + new TextDecoder().decode(plainBuf).slice(0, 20) + '...';
    } catch (e) {
      return 'DECRYPT_FAIL: ' + e.message;
    }
  })()
`, returnByValue: true, awaitPromise: true })).result.value;
console.log(decryptTest);

console.log('\n[5/5] call chatPanel handleSend path to see actual state when triggered');
const sendResult = (await sess('Runtime.evaluate', { expression: `
  (async () => {
    // 模拟: 用 SettingsModal 同样的 buildModelProviderMap + decryptProviders
    const mod = await import('/src/data/secrets.ts');
    const mod2 = await import('/src/data/modelProviderMap.ts');
    const raw = localStorage.getItem('cherry_providers_v2');
    if (!raw) return 'no raw';
    const arr = JSON.parse(raw);
    const { providers: decrypted, failures } = await mod.decryptProviders(arr);
    const map = mod2.buildModelProviderMap(decrypted);
    return JSON.stringify({
      decryptionFailures: failures,
      decryptedSample: decrypted.slice(0, 2).map(p => ({ id: p.id, name: p.name, enabled: p.enabled, apiKeyLen: p.apiKey ? p.apiKey.length : 0, apiKeyPrefix: p.apiKey ? p.apiKey.slice(0, 6) : 'EMPTY', apiKeyIsEnc: p.apiKey && p.apiKey.startsWith('enc:v1:') })),
      mapKeys: Object.keys(map),
      mapCount: Object.keys(map).length,
    }, null, 2);
  })()
`, returnByValue: true, awaitPromise: true })).result.value;
console.log(sendResult);

ws.close();
edgeProc.kill();
process.exit(0);
