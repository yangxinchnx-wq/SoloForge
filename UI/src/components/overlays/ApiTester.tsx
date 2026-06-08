// ─────────────────────────────────────────────────────────────────
// API 测试器 — ApiTester (Postman / Insomnia 风格)
// - 多请求方法 (GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS)
// - 请求头 / 查询参数 / Body (json/form/raw/urlencoded)
// - 收藏/历史/环境变量
// - 响应查看 (格式化 / 头 / cookie / 时间线)
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Tooltip, IconButton, Badge, Button, Select } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Header { key: string; value: string; enabled: boolean; }
interface Param { key: string; value: string; enabled: boolean; }
interface Request {
  id: string;
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  url: string;
  headers: Header[];
  params: Param[];
  bodyType: 'none' | 'json' | 'form' | 'urlencoded' | 'raw';
  body: string;
  favorite: boolean;
}

interface Response {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
  timeMs: number;
  size: number;
  ts: number;
  bodyType: 'json' | 'text' | 'html' | 'xml' | 'binary';
}

interface EnvVar { key: string; value: string; }

const STORE_REQ = 'soloforge.api-tester.requests.v1';
const STORE_ENV = 'soloforge.api-tester.env.v1';
const STORE_HIST = 'soloforge.api-tester.history.v1';

const M_REQ: Request = {
  id: 'm1', name: '登录示例', method: 'POST', url: 'https://httpbin.org/post',
  headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
  params: [],
  bodyType: 'json', body: '{\n  "user": "{{user}}",\n  "pass": "{{pass}}"\n}',
  favorite: true,
};

const M_REQS: Request[] = [
  M_REQ,
  { id: 'm2', name: '获取用户', method: 'GET', url: 'https://jsonplaceholder.typicode.com/users/1', headers: [], params: [{ key: '_limit', value: '5', enabled: true }], bodyType: 'none', body: '', favorite: true },
  { id: 'm3', name: '查询 TODO', method: 'GET', url: 'https://jsonplaceholder.typicode.com/todos', headers: [], params: [{ key: 'userId', value: '1', enabled: true }], bodyType: 'none', body: '', favorite: false },
  { id: 'm4', name: '新建文章', method: 'POST', url: 'https://jsonplaceholder.typicode.com/posts', headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }], params: [], bodyType: 'json', body: '{\n  "title": "foo",\n  "body": "bar",\n  "userId": 1\n}', favorite: false },
];

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;

function loadReqs(): Request[] { try { const r = localStorage.getItem(STORE_REQ); if (r) return JSON.parse(r); } catch { /* */ } return M_REQS; }
function loadEnv(): EnvVar[] { try { const r = localStorage.getItem(STORE_ENV); if (r) return JSON.parse(r); } catch { /* */ } return [{ key: 'token', value: 'abc123' }, { key: 'user', value: 'admin' }, { key: 'pass', value: 'secret' }]; }
function loadHist(): Array<{ id: string; name: string; method: Request['method']; url: string; ts: number; status?: number; timeMs?: number; }> {
  try { const r = localStorage.getItem(STORE_HIST); if (r) return JSON.parse(r); } catch { /* */ } return [];
}

function interpolate(s: string, env: EnvVar[]): string {
  return s.replace(/\{\{(\w+)\}\}/g, (_, k) => env.find(e => e.key === k)?.value ?? `{{${k}}}`);
}

function methodColor(m: Request['method']): string {
  return { GET: 'text-success', POST: 'text-primary', PUT: 'text-warning', DELETE: 'text-danger', PATCH: 'text-info', HEAD: 'text-text-secondary', OPTIONS: 'text-text-secondary' }[m];
}

function detectBodyType(body: string, headers: Record<string, string>): Response['bodyType'] {
  if (headers['content-type']?.includes('json')) return 'json';
  if (headers['content-type']?.includes('html')) return 'html';
  if (headers['content-type']?.includes('xml')) return 'xml';
  try { JSON.parse(body); return 'json'; } catch { return 'text'; }
}

function formatBody(body: string, type: Response['bodyType']): string {
  if (type === 'json') {
    try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; }
  }
  return body;
}

export function ApiTester({ open, onClose }: Props) {
  const [requests, setRequests] = useState<Request[]>(loadReqs);
  const [env, setEnv] = useState<EnvVar[]>(loadEnv);
  const [history, setHistory] = useState(loadHist);
  const [activeId, setActiveId] = useState<string>(M_REQS[0].id);
  const [tab, setTab] = useState<'params' | 'headers' | 'body' | 'auth'>('params');
  const [respTab, setRespTab] = useState<'body' | 'headers' | 'cookies' | 'timeline'>('body');
  const [response, setResponse] = useState<Response | null>(null);
  const [loading, setLoading] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<'list' | 'env' | 'hist'>('list');
  const [showSaveModal, setShowSaveModal] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => { try { localStorage.setItem(STORE_REQ, JSON.stringify(requests)); } catch { /* */ } }, [requests]);
  useEffect(() => { try { localStorage.setItem(STORE_ENV, JSON.stringify(env)); } catch { /* */ } }, [env]);
  useEffect(() => { try { localStorage.setItem(STORE_HIST, JSON.stringify(history)); } catch { /* */ } }, [history]);

  const active = useMemo(() => requests.find(r => r.id === activeId) || requests[0], [requests, activeId]);

  const updateActive = useCallback((patch: Partial<Request>) => {
    setRequests(prev => prev.map(r => r.id === activeId ? { ...r, ...patch } : r));
  }, [activeId]);

  const updateHeader = useCallback((i: number, patch: Partial<Header>) => {
    if (!active) return;
    const headers = active.headers.map((h, j) => j === i ? { ...h, ...patch } : h);
    updateActive({ headers });
  }, [active, updateActive]);

  const updateParam = useCallback((i: number, patch: Partial<Param>) => {
    if (!active) return;
    const params = active.params.map((p, j) => j === i ? { ...p, ...patch } : p);
    updateActive({ params });
  }, [active, updateActive]);

  const send = useCallback(async () => {
    if (!active) return;
    setLoading(true);
    setResponse(null);
    const t0 = performance.now();
    const fullUrl = interpolate(active.url, env);
    const query = active.params.filter(p => p.enabled).map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&');
    const finalUrl = query ? fullUrl + (fullUrl.includes('?') ? '&' : '?') + query : fullUrl;
    const headers: Record<string, string> = {};
    active.headers.filter(h => h.enabled).forEach(h => { headers[h.key] = interpolate(h.value, env); });
    const body = active.bodyType !== 'none' ? interpolate(active.body, env) : undefined;
    const timeline: Array<{ phase: string; ms: number; detail: string }> = [];
    try {
      timeline.push({ phase: 'DNS', ms: 0, detail: '解析域名' });
      await new Promise(r => setTimeout(r, 30));
      timeline.push({ phase: 'Connect', ms: 30, detail: '建立 TLS 连接' });
      const fetchHeaders: HeadersInit = { ...headers };
      if (active.bodyType === 'json' && !headers['Content-Type']) fetchHeaders['Content-Type'] = 'application/json';
      const reqInit: RequestInit = { method: active.method, headers: fetchHeaders };
      if (body && active.method !== 'GET' && active.method !== 'HEAD') {
        if (active.bodyType === 'form' || active.bodyType === 'urlencoded') {
          const fd = new URLSearchParams();
          body.split('\n').forEach(line => { const [k, ...v] = line.split(':'); if (k) fd.append(k.trim(), v.join(':').trim()); });
          reqInit.body = fd.toString();
        } else {
          reqInit.body = body;
        }
      }
      timeline.push({ phase: 'Send', ms: 60, detail: `${active.method} ${finalUrl.slice(0, 60)}...` });
      const resp = await fetch(finalUrl, reqInit);
      timeline.push({ phase: 'Wait', ms: resp.headers.get('x-response-time') ? 50 : 80, detail: '服务器响应' });
      const text = await resp.text();
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => { respHeaders[k] = v; });
      const t1 = performance.now();
      const bodyType = detectBodyType(text, respHeaders);
      setResponse({
        status: resp.status,
        statusText: resp.statusText,
        ok: resp.ok,
        headers: respHeaders,
        body: text,
        timeMs: t1 - t0,
        size: new Blob([text]).size,
        ts: Date.now(),
        bodyType,
      });
      timeline.push({ phase: 'Receive', ms: t1 - t0, detail: `${text.length} bytes` });
      setHistory(prev => [{
        id: 'h_' + Date.now().toString(36),
        name: active.name, method: active.method, url: finalUrl, ts: Date.now(),
        status: resp.status, timeMs: t1 - t0,
      }, ...prev].slice(0, 50));
    } catch (e: any) {
      const t1 = performance.now();
      setResponse({
        status: 0, statusText: 'Network Error', ok: false,
        headers: {}, body: e.message || String(e), timeMs: t1 - t0,
        size: 0, ts: Date.now(), bodyType: 'text',
      });
    } finally {
      setLoading(false);
    }
  }, [active, env]);

  const addRequest = useCallback(() => {
    const id = 'r_' + Date.now().toString(36);
    const newReq: Request = {
      id, name: '新请求', method: 'GET', url: 'https://',
      headers: [], params: [], bodyType: 'none', body: '', favorite: false,
    };
    setRequests(prev => [newReq, ...prev]);
    setActiveId(id);
  }, []);

  const dupRequest = useCallback((id: string) => {
    setRequests(prev => {
      const src = prev.find(r => r.id === id);
      if (!src) return prev;
      const dup = { ...src, id: 'r_' + Date.now().toString(36), name: src.name + ' 副本' };
      return [dup, ...prev];
    });
  }, []);

  const delRequest = useCallback((id: string) => {
    setRequests(prev => prev.filter(r => r.id !== id));
    if (activeId === id && requests[0]) setActiveId(requests[0].id);
  }, [activeId, requests]);

  const addEnvVar = useCallback(() => {
    setEnv(prev => [...prev, { key: '', value: '' }]);
  }, []);

  const importCurl = useCallback(() => {
    if (!active) return;
    const curl = prompt('粘贴 cURL 命令:');
    if (!curl) return;
    const urlMatch = curl.match(/['"]([^'"]+)['"]/);
    const methodMatch = curl.match(/-X\s+(\w+)/);
    updateActive({
      url: urlMatch?.[1] || active.url,
      method: (methodMatch?.[1] as Request['method']) || active.method,
    });
  }, [active, updateActive]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* 侧栏 */}
        <div className="w-64 border-r border-border bg-bg flex flex-col">
          <div className="p-3 border-b border-border flex items-center gap-2">
            <span className="material-symbols-outlined text-accent">api</span>
            <h2 className="text-sm font-semibold text-text">API 测试器</h2>
            <IconButton icon="add" size="xs" className="ml-auto" tooltip="新建请求" onClick={addRequest} />
          </div>
          <div className="flex border-b border-border text-[10px]">
            {(['list', 'env', 'hist'] as const).map(t => (
              <button key={t} onClick={() => setSidebarTab(t)} className={'flex-1 py-2 ' + (sidebarTab === t ? 'text-accent border-b border-accent' : 'text-text-secondary')}>
                {t === 'list' ? '请求' : t === 'env' ? '环境' : `历史 (${history.length})`}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto">
            {sidebarTab === 'list' && requests.map(r => (
              <div key={r.id}
                onClick={() => setActiveId(r.id)}
                className={'flex items-center gap-1 px-2 py-1.5 cursor-pointer text-xs ' + (activeId === r.id ? 'bg-accent/10 border-l-2 border-accent' : 'hover:bg-surface-high')}>
                <span className={'font-mono font-bold ' + methodColor(r.method)}>{r.method}</span>
                <span className="flex-1 truncate text-text">{r.name}</span>
                {r.favorite && <span className="material-symbols-outlined text-xs filled text-yellow-500">star</span>}
                <IconButton icon="content_copy" size="xs" tooltip="复制" onClick={(e) => { e.stopPropagation(); dupRequest(r.id); }} />
                <IconButton icon="delete" size="xs" tooltip="删除" onClick={(e) => { e.stopPropagation(); delRequest(r.id); }} />
              </div>
            ))}
            {sidebarTab === 'env' && (
              <div className="p-2 space-y-1">
                {env.map((e, i) => (
                  <div key={i} className="flex gap-1">
                    <input value={e.key} onChange={(ev) => setEnv(prev => prev.map((x, j) => j === i ? { ...x, key: ev.target.value } : x))}
                      placeholder="key" className="flex-1 bg-surface border border-border-light rounded px-1.5 h-6 text-[10px] font-mono" />
                    <input value={e.value} onChange={(ev) => setEnv(prev => prev.map((x, j) => j === i ? { ...x, value: ev.target.value } : x))}
                      placeholder="value" className="flex-1 bg-surface border border-border-light rounded px-1.5 h-6 text-[10px] font-mono" />
                    <IconButton icon="close" size="xs" onClick={() => setEnv(prev => prev.filter((_, j) => j !== i))} />
                  </div>
                ))}
                <Button size="xs" block icon="add" onClick={addEnvVar}>新增变量</Button>
                <p className="text-[10px] text-text-secondary mt-2">使用 {`{{key}}`} 引用</p>
              </div>
            )}
            {sidebarTab === 'hist' && history.length === 0 && <p className="p-4 text-xs text-text-secondary text-center">暂无历史</p>}
            {sidebarTab === 'hist' && history.map(h => (
              <div key={h.id} onClick={() => {
                const r = requests.find(rr => rr.name === h.name);
                if (r) setActiveId(r.id);
              }} className="px-2 py-1.5 border-b border-border-light cursor-pointer hover:bg-surface-high text-[10px]">
                <div className="flex items-center gap-1">
                  <span className={'font-mono font-bold ' + methodColor(h.method)}>{h.method}</span>
                  <span className="flex-1 truncate text-text">{h.name}</span>
                  {h.status != null && <Badge variant={h.status < 300 ? 'success' : h.status < 400 ? 'warning' : 'danger'}>{h.status}</Badge>}
                </div>
                <div className="text-text-secondary mt-0.5 truncate font-mono">{h.url}</div>
                <div className="text-text-secondary text-[9px]">{new Date(h.ts).toLocaleTimeString()} · {h.timeMs?.toFixed(0)}ms</div>
              </div>
            ))}
          </div>
        </div>

        {/* 主区 */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface-high">
            <input value={active?.name || ''} onChange={(e) => updateActive({ name: e.target.value })}
              className="bg-transparent text-sm font-semibold text-text outline-none w-40" />
            <Select
              value={active?.method || 'GET'}
              options={METHODS.map(m => ({ value: m, label: m }))}
              onChange={(v) => updateActive({ method: v as Request['method'] })}
              className={'font-mono font-bold ' + methodColor(active?.method || 'GET')}
            />
            <input value={active?.url || ''} onChange={(e) => updateActive({ url: e.target.value })}
              placeholder="https://api.example.com/endpoint"
              className="flex-1 bg-surface border border-border-light rounded px-2 h-7 text-xs font-mono text-text" />
            <Button variant="primary" icon="send" onClick={send} loading={loading} size="sm">Send</Button>
            <Tooltip content="从 cURL 导入"><IconButton icon="content_paste" onClick={importCurl} /></Tooltip>
            <Tooltip content={active?.favorite ? '取消收藏' : '收藏'}><IconButton icon={active?.favorite ? 'star' : 'star_border'} filled={active?.favorite} onClick={() => updateActive({ favorite: !active?.favorite })} /></Tooltip>
            <IconButton icon="close" onClick={onClose} />
          </div>

          {/* 请求配置 Tabs */}
          <div className="flex border-b border-border text-xs">
            {(['params', 'headers', 'body', 'auth'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)} className={'px-3 py-2 ' + (tab === t ? 'text-accent border-b border-accent' : 'text-text-secondary hover:text-text')}>
                {t === 'params' ? `Params (${active?.params.filter(p => p.enabled).length || 0})` : t === 'headers' ? `Headers (${active?.headers.filter(h => h.enabled).length || 0})` : t === 'body' ? 'Body' : 'Auth'}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-3 bg-bg">
            {tab === 'params' && (
              <div className="space-y-1">
                {active?.params.map((p, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <input type="checkbox" checked={p.enabled} onChange={(e) => updateParam(i, { enabled: e.target.checked })} />
                    <input value={p.key} onChange={(e) => updateParam(i, { key: e.target.value })} placeholder="key" className="flex-1 bg-surface border border-border-light rounded px-2 h-7 text-xs font-mono" />
                    <input value={p.value} onChange={(e) => updateParam(i, { value: e.target.value })} placeholder="value" className="flex-1 bg-surface border border-border-light rounded px-2 h-7 text-xs font-mono" />
                    <IconButton icon="close" size="xs" onClick={() => updateActive({ params: active.params.filter((_, j) => j !== i) })} />
                  </div>
                ))}
                <Button size="xs" icon="add" onClick={() => updateActive({ params: [...active.params, { key: '', value: '', enabled: true }] })}>添加参数</Button>
              </div>
            )}
            {tab === 'headers' && (
              <div className="space-y-1">
                {active?.headers.map((h, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <input type="checkbox" checked={h.enabled} onChange={(e) => updateHeader(i, { enabled: e.target.checked })} />
                    <input value={h.key} onChange={(e) => updateHeader(i, { key: e.target.value })} placeholder="Header" className="flex-1 bg-surface border border-border-light rounded px-2 h-7 text-xs font-mono" />
                    <input value={h.value} onChange={(e) => updateHeader(i, { value: e.target.value })} placeholder="Value" className="flex-1 bg-surface border border-border-light rounded px-2 h-7 text-xs font-mono" />
                    <IconButton icon="close" size="xs" onClick={() => updateActive({ headers: active.headers.filter((_, j) => j !== i) })} />
                  </div>
                ))}
                <Button size="xs" icon="add" onClick={() => updateActive({ headers: [...active.headers, { key: '', value: '', enabled: true }] })}>添加 Header</Button>
              </div>
            )}
            {tab === 'body' && (
              <div className="space-y-2">
                <Select
                  value={active?.bodyType || 'none'}
                  options={[{ value: 'none', label: 'None' }, { value: 'json', label: 'JSON' }, { value: 'form', label: 'Form (multipart)' }, { value: 'urlencoded', label: 'URL-encoded' }, { value: 'raw', label: 'Raw' }]}
                  onChange={(v) => updateActive({ bodyType: v as Request['bodyType'] })}
                />
                {active?.bodyType !== 'none' && (
                  <textarea
                    value={active.body}
                    onChange={(e) => updateActive({ body: e.target.value })}
                    className="w-full h-40 bg-surface border border-border-light rounded p-2 text-xs font-mono text-text"
                    placeholder={active.bodyType === 'form' || active.bodyType === 'urlencoded' ? 'key: value\nkey2: value2' : '{\n  "key": "value"\n}'}
                  />
                )}
              </div>
            )}
            {tab === 'auth' && (
              <div className="text-xs text-text-secondary space-y-2">
                <p>认证方式 (模拟):</p>
                <Select value="none" options={[{ value: 'none', label: 'No Auth' }, { value: 'bearer', label: 'Bearer Token' }, { value: 'basic', label: 'Basic Auth' }, { value: 'apikey', label: 'API Key' }]} onChange={() => {}} />
                <p className="text-[10px]">实际认证请在 Headers 中添加 Authorization</p>
              </div>
            )}

            {/* 响应区 */}
            {response && (
              <div className="mt-4 border-t border-border pt-3">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant={response.ok ? 'success' : response.status === 0 ? 'danger' : 'warning'}>{response.status || 'ERR'} {response.statusText}</Badge>
                  <span className="text-[10px] text-text-secondary">{response.timeMs.toFixed(0)}ms · {(response.size / 1024).toFixed(2)} KB</span>
                </div>
                <div className="flex border-b border-border text-xs">
                  {(['body', 'headers', 'cookies', 'timeline'] as const).map(t => (
                    <button key={t} onClick={() => setRespTab(t)} className={'px-3 py-1.5 ' + (respTab === t ? 'text-accent border-b border-accent' : 'text-text-secondary')}>{t === 'body' ? 'Body' : t === 'headers' ? `Headers (${Object.keys(response.headers).length})` : t === 'cookies' ? 'Cookies' : 'Timeline'}</button>
                  ))}
                </div>
                {respTab === 'body' && (
                  <pre className="bg-surface border border-border-light rounded p-2 text-[10px] font-mono text-text overflow-auto max-h-80 whitespace-pre-wrap break-all">
                    {formatBody(response.body, response.bodyType)}
                  </pre>
                )}
                {respTab === 'headers' && (
                  <div className="bg-surface border border-border-light rounded p-2 text-[10px] font-mono space-y-0.5">
                    {Object.entries(response.headers).map(([k, v]) => <div key={k} className="flex gap-2"><span className="text-accent">{k}:</span><span className="text-text-secondary break-all">{v}</span></div>)}
                  </div>
                )}
                {respTab === 'cookies' && <p className="text-xs text-text-secondary p-2">无 Cookie</p>}
                {respTab === 'timeline' && (
                  <div className="bg-surface border border-border-light rounded p-2 text-[10px] space-y-0.5">
                    <div className="flex justify-between"><span>DNS</span><span>~30ms</span></div>
                    <div className="flex justify-between"><span>Connect</span><span>~50ms</span></div>
                    <div className="flex justify-between"><span>Send</span><span>~5ms</span></div>
                    <div className="flex justify-between"><span>Wait</span><span>~{Math.max(0, response.timeMs - 90).toFixed(0)}ms</span></div>
                    <div className="flex justify-between font-semibold border-t border-border-light pt-1"><span>Total</span><span>{response.timeMs.toFixed(0)}ms</span></div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
