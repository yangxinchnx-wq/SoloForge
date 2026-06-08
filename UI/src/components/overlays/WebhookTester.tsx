// ─────────────────────────────────────────────────────────────────
// Webhook 测试器 — WebhookTester
// - 发送自定义 webhook
// - 接收/捕获 webhook 事件
// - 重试 + 签名
// - 事件日志 + 重放
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button, Select } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface WebhookEvent {
  id: string;
  ts: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  status?: number;
  duration?: number;
  source: 'sent' | 'received';
  signed: boolean;
}

const STORE = 'soloforge.webhook-tester.v1';

const SAMPLE_PAYLOADS = [
  { name: 'GitHub Push', body: JSON.stringify({ ref: 'refs/heads/main', commits: [{ id: 'abc', message: 'fix bug', author: 'alice' }] }) },
  { name: 'GitLab MR', body: JSON.stringify({ object_kind: 'merge_request', action: 'open', mr: { iid: 42, title: 'New feature' } }) },
  { name: 'Stripe 支付', body: JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { amount: 2000, currency: 'usd' } } }) },
  { name: 'Slack 消息', body: JSON.stringify({ channel: '#general', text: 'Hello world', user: 'alice' }) },
];

function load(): WebhookEvent[] { try { const r = localStorage.getItem(STORE); if (r) return JSON.parse(r); } catch { /* */ } return []; }
function save(d: WebhookEvent[]) { try { localStorage.setItem(STORE, JSON.stringify(d)); } catch { /* */ } }

function sign(body: string, secret: string): string {
  // 简单 hash 模拟
  let h = 0;
  const s = body + secret;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return 'sha256=' + Math.abs(h).toString(16).padStart(8, '0');
}

export function WebhookTester({ open, onClose }: Props) {
  const [events, setEvents] = useState<WebhookEvent[]>(load);
  const [url, setUrl] = useState('https://httpbin.org/post');
  const [method, setMethod] = useState('POST');
  const [headers, setHeaders] = useState<Array<{ key: string; value: string }>>([{ key: 'Content-Type', value: 'application/json' }, { key: 'User-Agent', value: 'SoloForge-Webhook/1.0' }]);
  const [body, setBody] = useState(SAMPLE_PAYLOADS[0].body);
  const [secret, setSecret] = useState('whsec_test_abc123');
  const [signEnabled, setSignEnabled] = useState(true);
  const [sending, setSending] = useState(false);
  const [tab, setTab] = useState<'send' | 'receive' | 'log'>('send');
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => { save(events); }, [events]);

  const active = useMemo(() => events.find(e => e.id === activeId) || null, [events, activeId]);

  const send = useCallback(async () => {
    setSending(true);
    const id = 'wh_' + Date.now().toString(36);
    const finalHeaders: Record<string, string> = {};
    headers.filter(h => h.key).forEach(h => { finalHeaders[h.key] = h.value; });
    if (signEnabled) finalHeaders['X-Webhook-Signature'] = sign(body, secret);
    const start = performance.now();
    const ev: WebhookEvent = { id, ts: Date.now(), method, url, headers: finalHeaders, body, signed: signEnabled, source: 'sent' };
    setEvents(prev => [ev, ...prev]);
    setActiveId(id);
    try {
      const resp = await fetch(url, { method, headers: finalHeaders, body: method !== 'GET' ? body : undefined });
      const t = performance.now() - start;
      const respBody = await resp.text();
      setEvents(prev => prev.map(e => e.id === id ? { ...e, status: resp.status, duration: t, body: respBody } : e));
    } catch (e: any) {
      const t = performance.now() - start;
      setEvents(prev => prev.map(x => x.id === id ? { ...x, status: 0, duration: t, body: 'Error: ' + e.message } : x));
    } finally {
      setSending(false);
    }
  }, [url, method, headers, body, signEnabled, secret]);

  const replay = useCallback((e: WebhookEvent) => {
    setUrl(e.url);
    setMethod(e.method);
    setHeaders(Object.entries(e.headers).map(([key, value]) => ({ key, value })));
    setBody(e.body);
    setTab('send');
  }, []);

  // 模拟接收
  useEffect(() => {
    if (tab !== 'receive') return;
    const timer = window.setInterval(() => {
      if (Math.random() > 0.6) {
        const id = 'wh_' + Date.now().toString(36);
        const sample = SAMPLE_PAYLOADS[Math.floor(Math.random() * SAMPLE_PAYLOADS.length)];
        const ev: WebhookEvent = {
          id, ts: Date.now(), method: 'POST', url: '/api/webhooks/receive',
          headers: { 'Content-Type': 'application/json', 'X-Event-Type': sample.name },
          body: sample.body, status: 200, duration: 12, source: 'received', signed: Math.random() > 0.5,
        };
        setEvents(prev => [ev, ...prev].slice(0, 100));
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [tab]);

  if (!open) return null;

  const sent = events.filter(e => e.source === 'sent');
  const received = events.filter(e => e.source === 'received');

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">webhook</span>
          <h2 className="text-sm font-semibold text-text">Webhook 测试器</h2>
          <Badge variant="primary">{events.length} 事件</Badge>
          <Badge variant="info">↑{sent.length} 发送</Badge>
          <Badge variant="warning">↓{received.length} 接收</Badge>
          <div className="ml-auto flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light">
            {(['send', 'receive', 'log'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t ? 'bg-surface-high text-text' : 'text-text-secondary')}>
                {t === 'send' ? '发送' : t === 'receive' ? '接收' : `日志 (${events.length})`}
              </button>
            ))}
          </div>
          <IconButton icon="close" onClick={onClose} />
        </div>

        {tab === 'send' && (
          <div className="flex-1 flex overflow-hidden">
            <div className="flex-1 p-3 flex flex-col">
              <div className="flex gap-1 mb-2">
                <Select value={method} options={['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map(m => ({ value: m, label: m }))} onChange={setMethod} className="w-20" />
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/webhook"
                  className="flex-1 bg-surface border border-border-light rounded px-2 h-7 text-xs font-mono" />
                <Button size="sm" icon="send" onClick={send} loading={sending} variant="primary">发送</Button>
              </div>

              <h3 className="text-xs font-semibold text-text mb-1">请求头</h3>
              <div className="space-y-1 mb-2">
                {headers.map((h, i) => (
                  <div key={i} className="flex gap-1">
                    <input value={h.key} onChange={(e) => setHeaders(prev => prev.map((x, j) => j === i ? { ...x, key: e.target.value } : x))} placeholder="Header"
                      className="flex-1 bg-surface border border-border-light rounded px-2 h-6 text-[10px] font-mono" />
                    <input value={h.value} onChange={(e) => setHeaders(prev => prev.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} placeholder="Value"
                      className="flex-1 bg-surface border border-border-light rounded px-2 h-6 text-[10px] font-mono" />
                    <IconButton icon="close" size="xs" onClick={() => setHeaders(prev => prev.filter((_, j) => j !== i))} />
                  </div>
                ))}
                <Button size="xs" icon="add" onClick={() => setHeaders(prev => [...prev, { key: '', value: '' }])}>添加</Button>
              </div>

              <h3 className="text-xs font-semibold text-text mb-1">Body</h3>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} className="flex-1 bg-surface border border-border-light rounded p-2 text-[10px] font-mono text-text resize-none mb-2" />

              <div className="flex items-center gap-2 mb-1">
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={signEnabled} onChange={(e) => setSignEnabled(e.target.checked)} />HMAC 签名
                </label>
                {signEnabled && (
                  <>
                    <span className="text-[10px] text-text-secondary">Secret:</span>
                    <input value={secret} onChange={(e) => setSecret(e.target.value)} className="flex-1 bg-surface border border-border-light rounded px-2 h-6 text-[10px] font-mono" />
                    <code className="text-[10px] text-text-secondary">X-Webhook-Signature: {sign(body, secret).slice(0, 24)}...</code>
                  </>
                )}
              </div>
            </div>

            <div className="w-72 border-l border-border bg-bg p-2">
              <h3 className="text-xs font-semibold text-text mb-1">快速模板</h3>
              <div className="space-y-1">
                {SAMPLE_PAYLOADS.map(p => (
                  <button key={p.name} onClick={() => setBody(p.body)} className="w-full text-left bg-surface border border-border-light rounded p-2 hover:bg-surface-high">
                    <div className="text-xs font-medium text-text">{p.name}</div>
                    <div className="text-[10px] text-text-secondary font-mono truncate">{p.body.slice(0, 40)}...</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === 'receive' && (
          <div className="flex-1 overflow-y-auto p-3">
            <div className="bg-bg border border-border-light rounded-lg p-3 mb-3 text-center">
              <span className="material-symbols-outlined text-3xl text-success">radio_button_checked</span>
              <p className="text-sm text-text mt-1">正在监听 webhook...</p>
              <p className="text-[10px] text-text-secondary mt-0.5">URL: <code className="text-accent">/api/webhooks/receive</code></p>
              <p className="text-[10px] text-text-secondary">每 3 秒模拟一次接收 (60% 概率)</p>
            </div>
            <h3 className="text-xs font-semibold text-text mb-2">最近接收 ({received.length})</h3>
            {received.length === 0 ? <p className="text-xs text-text-secondary text-center py-4">暂无接收事件</p> : received.slice(0, 20).map(e => (
              <div key={e.id} onClick={() => setActiveId(e.id)} className="bg-bg border border-border-light rounded p-2 mb-1 cursor-pointer hover:bg-surface-high">
                <div className="flex items-center gap-2">
                  <Badge variant="success">200</Badge>
                  <code className="text-[10px] font-mono text-text-secondary">{e.headers['X-Event-Type'] || 'unknown'}</code>
                  {e.signed && <Badge variant="info">已签名</Badge>}
                  <span className="text-[10px] text-text-secondary ml-auto">{new Date(e.ts).toLocaleTimeString()}</span>
                </div>
                <pre className="text-[10px] font-mono text-text-secondary mt-1 truncate">{e.body}</pre>
              </div>
            ))}
          </div>
        )}

        {tab === 'log' && (
          <div className="flex-1 flex overflow-hidden">
            <div className="flex-1 overflow-y-auto">
              {events.length === 0 ? <p className="p-4 text-center text-xs text-text-secondary">无事件</p> : events.map(e => (
                <div key={e.id} onClick={() => setActiveId(e.id)}
                  className={'grid grid-cols-12 gap-1 px-2 py-1.5 text-[10px] font-mono border-b border-border-light cursor-pointer hover:bg-surface-high ' + (activeId === e.id ? 'bg-accent/10' : '')}>
                  <div className="col-span-1">
                    <Badge variant={e.source === 'sent' ? 'info' : 'warning'}>{e.source === 'sent' ? '↑' : '↓'}</Badge>
                  </div>
                  <div className="col-span-1 font-bold text-text">{e.method}</div>
                  <div className="col-span-3 truncate text-text">{e.url}</div>
                  <div className="col-span-1">
                    {e.status != null ? <Badge variant={e.status < 400 ? 'success' : 'danger'}>{e.status}</Badge> : <span>...</span>}
                  </div>
                  <div className="col-span-1 text-right text-text-secondary">{e.duration ? `${e.duration.toFixed(0)}ms` : ''}</div>
                  <div className="col-span-2 text-text-secondary">{e.signed ? '🔒' : '🔓'}</div>
                  <div className="col-span-3 text-right text-text-secondary">{new Date(e.ts).toLocaleString()}</div>
                </div>
              ))}
            </div>
            {active && (
              <div className="w-96 border-l border-border bg-bg p-2 overflow-y-auto">
                <h3 className="text-xs font-semibold text-text mb-1">事件详情</h3>
                <pre className="bg-surface border border-border-light rounded p-2 text-[10px] font-mono text-text whitespace-pre-wrap break-all mb-2 max-h-60 overflow-auto">{active.body}</pre>
                <h4 className="text-[10px] text-text-secondary mb-1">Headers</h4>
                <pre className="bg-surface border border-border-light rounded p-2 text-[10px] font-mono text-text-secondary whitespace-pre-wrap break-all mb-2 max-h-32 overflow-auto">
                  {Object.entries(active.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}
                </pre>
                {active.source === 'sent' && <Button size="xs" icon="replay" block onClick={() => replay(active)}>重放</Button>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
