// tail-sse.mjs - 订阅 /api/events/stream 实时流,采集 5 秒后输出摘要
import http from 'node:http';

const REQ = http.request({
  host: 'localhost',
  port: 3001,
  path: '/api/events/stream',
  method: 'GET',
  headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
}, (res) => {
  console.log(`[sse] HTTP ${res.statusCode} content-type=${res.headers['content-type']}`);
  let buf = '';
  let count = 0;
  let firstTs = 0, lastTs = 0;
  const domains = new Map();
  const eventTypes = new Map();
  let sampleLines = [];

  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      if (!frame.trim()) continue;
      const ev = {};
      for (const line of frame.split('\n')) {
        const m = line.match(/^([a-z\-]+):\s?(.*)$/);
        if (m) ev[m[1]] = m[2];
      }
      if (!ev.data) continue;
      count++;
      let parsed = null;
      try { parsed = JSON.parse(ev.data); } catch {}
      if (!parsed) continue;
      const et = ev.event || parsed.event || 'message';
      eventTypes.set(et, (eventTypes.get(et) || 0) + 1);
      const ts = parsed.timestamp || Date.now();
      if (!firstTs) firstTs = ts;
      lastTs = ts;
      if (parsed.payload) {
        const d = parsed.payload.domain || ev.event || '?';
        domains.set(d, (domains.get(d) || 0) + 1);
      }
      if (sampleLines.length < 4) sampleLines.push({ ts, et, payload: parsed.payload });
    }
  });
  res.on('end', () => console.log('[sse] connection closed'));

  setTimeout(() => {
    console.log('---');
    console.log(`总事件数: ${count}`);
    console.log(`时间跨度: ${(lastTs - firstTs)}ms (first=${firstTs} last=${lastTs})`);
    console.log(`事件类型分布:`);
    [...eventTypes.entries()].sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${k}: ${v}`));
    console.log(`Domain 分布:`);
    [...domains.entries()].sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${k}: ${v}`));
    console.log(`最近 4 条事件样本:`);
    sampleLines.forEach((s, i) => {
      const summary = JSON.stringify(s.payload).slice(0, 220);
      console.log(`  [${i}] ts=${s.ts} ${s.et} -> ${summary}${summary.length === 220 ? '...' : ''}`);
    });
    process.exit(0);
  }, 5000);
});
REQ.on('error', (e) => { console.error('[sse] error', e.message); process.exit(1); });
REQ.end();