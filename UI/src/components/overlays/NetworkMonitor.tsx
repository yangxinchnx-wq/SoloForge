// ─────────────────────────────────────────────────────────────────
// 网络请求监控 — NetworkMonitor
// - HTTP/WebSocket 拦截展示
// - 时间线 + 瀑布图
// - 状态/方法/大小/耗时过滤
// - 请求详情 (Headers/Payload/Response)
// - 模拟请求 (Mock)
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Tooltip, IconButton, Badge, Button, Select } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface Req {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'WS';
  url: string;
  status: number;
  ok: boolean;
  size: number;          // bytes
  time: number;          // ms
  start: number;         // ms from monitor start
  end: number;
  type: 'fetch' | 'xhr' | 'ws' | 'static' | 'img';
  host: string;
  initiator: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  cached: boolean;
}

const STORE = 'soloforge.network-monitor.v1';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'WS'] as const;

const SEEDS: Req[] = [
  { id: 'r1', method: 'GET', url: '/api/v1/kernel', status: 200, ok: true, size: 1024, time: 45, start: 0, end: 45, type: 'fetch', host: 'localhost:3001', initiator: 'App.tsx', requestHeaders: { 'Accept': 'application/json' }, responseHeaders: { 'Content-Type': 'application/json', 'X-Powered-By': 'SoloForge' }, responseBody: '{"state":"running","version":"1.2.0"}', cached: false },
  { id: 'r2', method: 'GET', url: '/api/v1/agents', status: 200, ok: true, size: 2560, time: 78, start: 50, end: 128, type: 'fetch', host: 'localhost:3001', initiator: 'useBackend', requestHeaders: {}, responseHeaders: { 'Content-Type': 'application/json' }, responseBody: '[{"id":"a1","name":"Scheduler"},{"id":"a2","name":"Governor"}]', cached: false },
  { id: 'r3', method: 'POST', url: '/api/v1/chat/send', status: 200, ok: true, size: 4096, time: 1240, start: 130, end: 1370, type: 'fetch', host: 'localhost:3001', initiator: 'useChat.send', requestHeaders: { 'Content-Type': 'application/json' }, responseHeaders: { 'Content-Type': 'text/event-stream' }, requestBody: '{"message":"hello","sessionId":"s_123"}', responseBody: 'data: {"chunk":"hi"}\n\ndata: [DONE]', cached: false },
  { id: 'r4', method: 'GET', url: '/static/main.js', status: 200, ok: true, size: 256000, time: 12, start: 200, end: 212, type: 'static', host: 'localhost:5173', initiator: '<script>', requestHeaders: {}, responseHeaders: { 'Cache-Control': 'public, max-age=31536000' }, cached: true },
  { id: 'r5', method: 'GET', url: '/img/logo.png', status: 200, ok: true, size: 8192, time: 23, start: 215, end: 238, type: 'img', host: 'localhost:5173', initiator: 'TopBar', requestHeaders: {}, responseHeaders: {}, cached: true },
  { id: 'r6', method: 'WS', url: 'ws://localhost:3001/events', status: 101, ok: true, size: 0, time: 0, start: 240, end: 99999, type: 'ws', host: 'localhost:3001', initiator: 'useEventStream', requestHeaders: {}, responseHeaders: {}, cached: false },
  { id: 'r7', method: 'DELETE', url: '/api/v1/sessions/abc', status: 204, ok: true, size: 0, time: 56, start: 1380, end: 1436, type: 'fetch', host: 'localhost:3001', initiator: 'chat.del', requestHeaders: {}, responseHeaders: {}, cached: false },
  { id: 'r8', method: 'POST', url: '/api/v1/login', status: 401, ok: false, size: 87, time: 234, start: 1440, end: 1674, type: 'fetch', host: 'localhost:3001', initiator: 'Auth', requestHeaders: { 'Content-Type': 'application/json' }, responseHeaders: { 'WWW-Authenticate': 'Bearer' }, responseBody: '{"error":"invalid credentials"}', cached: false },
  { id: 'r9', method: 'GET', url: '/api/v1/db/query', status: 200, ok: true, size: 4096, time: 89, start: 1680, end: 1769, type: 'fetch', host: 'localhost:3001', initiator: 'SurrealExplorer', requestHeaders: {}, responseHeaders: {}, cached: false },
  { id: 'r10', method: 'GET', url: 'https://cdn.example.com/font.woff2', status: 200, ok: true, size: 51200, time: 156, start: 1800, end: 1956, type: 'static', host: 'cdn.example.com', initiator: '<style>', requestHeaders: {}, responseHeaders: {}, cached: true },
];

function load(): Req[] { try { const r = localStorage.getItem(STORE); if (r) return JSON.parse(r); } catch { /* */ } return SEEDS; }
function save(d: Req[]) { try { localStorage.setItem(STORE, JSON.stringify(d)); } catch { /* */ } }

function methodColor(m: string): string {
  return { GET: 'text-success', POST: 'text-primary', PUT: 'text-warning', DELETE: 'text-danger', PATCH: 'text-info', WS: 'text-text-secondary' }[m] || 'text-text';
}

export function NetworkMonitor({ open, onClose }: Props) {
  const [reqs, setReqs] = useState<Req[]>(load);
  const [filter, setFilter] = useState('');
  const [methodFilter, setMethodFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | '2xx' | '3xx' | '4xx' | '5xx' | 'err'>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [tab, setTab] = useState<'all' | 'xhr' | 'js' | 'img' | 'ws'>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => { save(reqs); }, [reqs]);

  // 模拟实时新增请求
  useEffect(() => {
    if (recording) {
      intervalRef.current = window.setInterval(() => {
        const id = 'r_' + Date.now().toString(36);
        const method = METHODS[Math.floor(Math.random() * METHODS.length)];
        const start = reqs.length > 0 ? Math.max(...reqs.map(r => r.end)) : 0;
        const time = Math.floor(Math.random() * 500) + 10;
        const statuses = [200, 200, 200, 200, 304, 404, 500];
        const status = statuses[Math.floor(Math.random() * statuses.length)];
        const newReq: Req = {
          id, method,
          url: `/api/v1/${['chat', 'agents', 'db', 'events', 'kernel'][Math.floor(Math.random() * 5)]}/${Math.random().toString(36).slice(2, 8)}`,
          status, ok: status < 400,
          size: Math.floor(Math.random() * 10000), time,
          start, end: start + time,
          type: 'fetch', host: 'localhost:3001', initiator: 'App',
          requestHeaders: {}, responseHeaders: {}, cached: false,
        };
        setReqs(prev => [...prev.slice(-49), newReq]);
      }, 1500);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [recording, reqs.length]);

  const filtered = useMemo(() => reqs.filter(r => {
    if (methodFilter !== 'all' && r.method !== methodFilter) return false;
    if (statusFilter === '2xx' && (r.status < 200 || r.status >= 300)) return false;
    if (statusFilter === '3xx' && (r.status < 300 || r.status >= 400)) return false;
    if (statusFilter === '4xx' && (r.status < 400 || r.status >= 500)) return false;
    if (statusFilter === '5xx' && r.status < 500) return false;
    if (statusFilter === 'err' && r.ok) return false;
    if (typeFilter !== 'all' && r.type !== typeFilter) return false;
    if (tab === 'xhr' && r.type !== 'fetch') return false;
    if (tab === 'js' && r.type !== 'static') return false;
    if (tab === 'img' && r.type !== 'img') return false;
    if (tab === 'ws' && r.type !== 'ws') return false;
    if (filter && !r.url.toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  }), [reqs, methodFilter, statusFilter, typeFilter, filter, tab]);

  const active = useMemo(() => reqs.find(r => r.id === activeId) || null, [reqs, activeId]);
  const totalSize = useMemo(() => filtered.reduce((a, r) => a + r.size, 0), [filtered]);
  const totalTime = useMemo(() => filtered.reduce((a, r) => a + r.time, 0), [filtered]);
  const maxTime = useMemo(() => Math.max(...reqs.map(r => r.end), 2000), [reqs]);
  const slow = useMemo(() => reqs.filter(r => r.time > 500), [reqs]);
  const failed = useMemo(() => reqs.filter(r => !r.ok), [reqs]);

  const clear = useCallback(() => setReqs([]), []);
  const retry = useCallback((id: string) => setReqs(prev => prev.map(r => r.id === id ? { ...r, time: r.time + Math.floor(Math.random() * 100) } : r)), []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">network_check</span>
          <h2 className="text-sm font-semibold text-text">网络监控</h2>
          <Badge variant="primary">{filtered.length} / {reqs.length}</Badge>
          <Badge variant="info">{(totalSize / 1024).toFixed(1)} KB</Badge>
          <Badge variant="default">{totalTime}ms</Badge>
          {slow.length > 0 && <Badge variant="warning">⏱ {slow.length} 慢</Badge>}
          {failed.length > 0 && <Badge variant="danger">✕ {failed.length} 失败</Badge>}
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="URL 过滤..."
            className="bg-surface border border-border-light rounded px-2 h-7 text-xs w-40 ml-auto" />
          <Tooltip content="录制"><IconButton icon={recording ? 'stop_circle' : 'play_circle'} filled={recording} onClick={() => setRecording(!recording)} /></Tooltip>
          <Button size="sm" icon="delete" onClick={clear}>清空</Button>
          <IconButton icon="close" onClick={onClose} />
        </div>

        <div className="px-3 py-1.5 border-b border-border bg-bg flex items-center gap-2 text-[10px]">
          <span className="text-text-secondary">方法:</span>
          <select value={methodFilter} onChange={(e) => setMethodFilter(e.target.value)} className="bg-surface border border-border-light rounded px-1.5 h-6 text-[10px]">
            <option value="all">全部</option>
            {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <span className="text-text-secondary">状态:</span>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)} className="bg-surface border border-border-light rounded px-1.5 h-6 text-[10px]">
            <option value="all">全部</option>
            <option value="2xx">2xx</option>
            <option value="3xx">3xx</option>
            <option value="4xx">4xx</option>
            <option value="5xx">5xx</option>
            <option value="err">失败</option>
          </select>
          <span className="text-text-secondary">类型:</span>
          <div className="flex items-center gap-0.5 p-0.5 bg-surface rounded-md border border-border-light">
            {(['all', 'xhr', 'js', 'img', 'ws'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)} className={'px-1.5 h-5 rounded text-[10px] ' + (tab === t ? 'bg-surface-high text-text' : 'text-text-secondary')}>
                {t === 'all' ? '全部' : t === 'xhr' ? 'XHR' : t === 'js' ? 'JS' : t === 'img' ? '图片' : 'WS'}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 flex flex-col">
            {/* 表头 */}
            <div className="grid grid-cols-12 gap-1 px-2 py-1 bg-surface-high text-[10px] text-text-secondary border-b border-border">
              <div className="col-span-1">方法</div>
              <div className="col-span-4">URL</div>
              <div className="col-span-1">状态</div>
              <div className="col-span-1 text-right">大小</div>
              <div className="col-span-1 text-right">耗时</div>
              <div className="col-span-4">瀑布</div>
            </div>
            <div className="flex-1 overflow-auto">
              {filtered.length === 0 ? <p className="p-4 text-center text-xs text-text-secondary">无请求</p> : filtered.map(r => (
                <div key={r.id} onClick={() => setActiveId(r.id)}
                  className={'grid grid-cols-12 gap-1 px-2 py-1 text-[10px] font-mono border-b border-border-light cursor-pointer hover:bg-surface-high ' + (activeId === r.id ? 'bg-accent/10' : '')}>
                  <div className={'col-span-1 font-bold ' + methodColor(r.method)}>{r.method}</div>
                  <div className="col-span-4 truncate text-text">{r.url}</div>
                  <div className="col-span-1">
                    <Badge variant={r.ok ? (r.status >= 300 ? 'warning' : 'success') : 'danger'}>{r.status}</Badge>
                  </div>
                  <div className="col-span-1 text-right text-text-secondary">{r.size > 1024 ? (r.size / 1024).toFixed(1) + 'KB' : r.size + 'B'}</div>
                  <div className={'col-span-1 text-right ' + (r.time > 500 ? 'text-danger font-bold' : 'text-text-secondary')}>{r.time}ms</div>
                  <div className="col-span-4 relative h-3 bg-bg-dim rounded">
                    <div className="absolute top-0 h-3 rounded"
                      style={{
                        left: `${(r.start / maxTime) * 100}%`,
                        width: `${Math.max(2, (r.end - r.start) / maxTime * 100)}%`,
                        background: r.ok ? (r.time > 500 ? '#f59e0b' : '#3b82f6') : '#ef4444',
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {active && (
            <div className="w-96 border-l border-border bg-bg p-3 overflow-y-auto">
              <h3 className="text-xs font-semibold text-text mb-2">请求详情</h3>
              <div className="bg-surface border border-border-light rounded p-2 mb-2">
                <div className="flex items-center gap-1 mb-1">
                  <span className={'font-bold ' + methodColor(active.method)}>{active.method}</span>
                  <code className="text-[10px] text-text truncate flex-1">{active.url}</code>
                </div>
                <div className="grid grid-cols-2 gap-1 text-[10px]">
                  <div><span className="text-text-secondary">状态:</span> {active.status}</div>
                  <div><span className="text-text-secondary">耗时:</span> {active.time}ms</div>
                  <div><span className="text-text-secondary">大小:</span> {active.size} B</div>
                  <div><span className="text-text-secondary">Host:</span> {active.host}</div>
                </div>
                <Button size="xs" icon="refresh" onClick={() => retry(active.id)} className="mt-1">重试</Button>
              </div>
              <h4 className="text-[10px] text-text-secondary uppercase tracking-wider mb-1">请求头</h4>
              <div className="bg-surface border border-border-light rounded p-1.5 text-[10px] font-mono">
                {Object.entries(active.requestHeaders).map(([k, v]) => <div key={k} className="flex gap-1"><span className="text-accent">{k}:</span> <span className="text-text-secondary break-all">{v}</span></div>)}
              </div>
              {active.requestBody && (
                <>
                  <h4 className="text-[10px] text-text-secondary uppercase tracking-wider mb-1 mt-2">请求体</h4>
                  <pre className="bg-surface border border-border-light rounded p-1.5 text-[10px] font-mono text-text-secondary whitespace-pre-wrap break-all">{active.requestBody}</pre>
                </>
              )}
              <h4 className="text-[10px] text-text-secondary uppercase tracking-wider mb-1 mt-2">响应头</h4>
              <div className="bg-surface border border-border-light rounded p-1.5 text-[10px] font-mono">
                {Object.entries(active.responseHeaders).map(([k, v]) => <div key={k} className="flex gap-1"><span className="text-accent">{k}:</span> <span className="text-text-secondary break-all">{v}</span></div>)}
              </div>
              {active.responseBody && (
                <>
                  <h4 className="text-[10px] text-text-secondary uppercase tracking-wider mb-1 mt-2">响应体</h4>
                  <pre className="bg-surface border border-border-light rounded p-1.5 text-[10px] font-mono text-text-secondary whitespace-pre-wrap break-all max-h-40 overflow-auto">{active.responseBody}</pre>
                </>
              )}
            </div>
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-border bg-surface-high text-[10px] text-text-secondary flex items-center gap-3">
          <span>{filtered.length} 请求</span>
          <span>·</span>
          <span>{(totalSize / 1024).toFixed(2)} KB 总传输</span>
          <span>·</span>
          <span>{totalTime}ms 总耗时</span>
          <span className="ml-auto">{recording ? '🔴 录制中 (每 1.5s 模拟新请求)' : '已停止'}</span>
        </div>
      </div>
    </div>
  );
}
