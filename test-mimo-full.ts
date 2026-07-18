// 查看 MiMo API 完整响应结构
const baseUrl = 'https://token-plan-cn.xiaomimimo.com/v1';
const apiKey = 'tp-c387doyj702b8xop903eltrskb8hk1mk0mvogo5nwf4hkozd';

const body = {
  model: 'mimo-v2.5',
  messages: [
    { role: 'system', content: 'Respond in JSON: {"off_track": false, "reason": "test ok"}' },
    { role: 'user', content: 'Task: explain scheduling\n\nWorker output:\nFCFS is simple.' },
  ],
  temperature: 0.2,
  max_tokens: 256,
};

console.log('Calling MiMo...');
const t0 = Date.now();
const resp = await fetch(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify(body),
});
const dt = Date.now() - t0;
console.log(`Status: ${resp.status} in ${dt}ms`);
const json = await resp.json();
console.log('Full response:', JSON.stringify(json, null, 2));
