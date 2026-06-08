// ─────────────────────────────────────────────────────────────────
// 缓存检查器 — CacheInspector
// - Redis/Dragonfly/Memcached 缓存查看
// - Key 扫描与值预览
// - TTL 管理
// - 命中率分析
// - 内存使用与淘汰策略
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type CacheEngine = 'redis' | 'dragonfly' | 'memcached' | 'keydb';

interface CacheKey {
  key: string;
  type: 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream';
  size: number;        // bytes
  ttl: number;         // seconds (-1 = no expire)
  hits: number;
  lastAccess: number;
  namespace: string;
  preview: string;
}

const ENGINES: Record<CacheEngine, { host: string; port: number; version: string; maxMemory: string }> = {
  redis:     { host: 'redis://cache-1.internal',  port: 6379,  version: '7.2.4',  maxMemory: '4 GB' },
  dragonfly: { host: 'dragonfly://cache-2.internal', port: 6379, version: '1.13.0', maxMemory: '8 GB' },
  memcached: { host: 'memcached://cache-3.internal', port: 11211, version: '1.6.21', maxMemory: '2 GB' },
  keydb:     { host: 'keydb://cache-4.internal',  port: 6379,  version: '6.3.4',  maxMemory: '4 GB' },
};

const NAMESPACES = ['session', 'ratelimit', 'cache:user', 'cache:api', 'lock', 'queue', 'analytics'];

const KEYS: CacheKey[] = [
  { key: 'session:abc123def456',        type: 'hash',  size: 1024,  ttl: 1800,   hits: 42,   lastAccess: Date.now() - 5000,    namespace: 'session',  preview: '{ userId: "u_12345", roles: ["admin"], ... }' },
  { key: 'ratelimit:user:u_12345',      type: 'string',size: 16,    ttl: 60,     hits: 156,  lastAccess: Date.now() - 12000,   namespace: 'ratelimit',preview: '42' },
  { key: 'cache:user:profile:u_99',     type: 'string',size: 8192,  ttl: 3600,   hits: 234,  lastAccess: Date.now() - 300000,  namespace: 'cache:user', preview: '{ id, name, email, avatar, bio, ... }' },
  { key: 'cache:api:github:repos',      type: 'string',size: 524288,ttl: 7200,   hits: 89,   lastAccess: Date.now() - 1800000, namespace: 'cache:api',  preview: '[{ id, name, stars, ... }, ... 2500 items]' },
  { key: 'lock:migration:2026_06',      type: 'string',size: 32,    ttl: 1800,   hits: 0,    lastAccess: Date.now() - 60000,   namespace: 'lock',     preview: 'worker-7.soloforge-prod' },
  { key: 'queue:emails:pending',        type: 'list',  size: 4096,  ttl: -1,     hits: 12,   lastAccess: Date.now() - 30000,   namespace: 'queue',    preview: '[email1, email2, email3, ... 156 items]' },
  { key: 'cache:api:weather:beijing',   type: 'string',size: 2048,  ttl: 600,    hits: 892,  lastAccess: Date.now() - 30000,   namespace: 'cache:api',  preview: '{ temp: 28, humidity: 65, ... }' },
  { key: 'session:xyz789ghi012',        type: 'hash',  size: 768,   ttl: 1800,   hits: 28,   lastAccess: Date.now() - 1800000, namespace: 'session',  preview: '{ userId: "u_67890", roles: ["user"], ... }' },
  { key: 'analytics:pageview:2026_06_07', type: 'zset', size: 65536, ttl: 86400,  hits: 0,    lastAccess: Date.now() - 3600000, namespace: 'analytics', preview: '{ member1, score1 }, { member2, score2 }, ...' },
  { key: 'ratelimit:ip:203.0.113.45',   type: 'string',size: 16,    ttl: 60,     hits: 67,   lastAccess: Date.now() - 60000,   namespace: 'ratelimit',preview: '12' },
  { key: 'cache:user:settings:u_99',    type: 'hash',  size: 512,   ttl: 3600,   hits: 156,  lastAccess: Date.now() - 300000,  namespace: 'cache:user', preview: '{ theme: "dark", lang: "zh-CN", ... }' },
];

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(2)} MB`;
}

function formatTTL(s: number): string {
  if (s === -1) return '∞';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function CacheInspector({ open, onClose }: Props) {
  const [tab, setTab] = useState<'keys' | 'stats' | 'memory' | 'cli'>('keys');
  const [engine, setEngine] = useState<CacheEngine>('dragonfly');
  const [namespaceFilter, setNamespaceFilter] = useState<string>('all');
  const [activeKeyId, setActiveKeyId] = useState<string>(KEYS[0].key);
  const [searchQuery, setSearchQuery] = useState<string>('');

  const activeKey = KEYS.find(k => k.key === activeKeyId) || KEYS[0];
  const filtered = KEYS.filter(k => {
    if (namespaceFilter !== 'all' && k.namespace !== namespaceFilter) return false;
    if (searchQuery && !k.key.includes(searchQuery)) return false;
    return true;
  });

  const totalSize = KEYS.reduce((s, k) => s + k.size, 0);
  const totalHits = KEYS.reduce((s, k) => s + k.hits, 0);
  const hitRate = 92.4;
  const evictedKeys = 1247;
  const connectedClients = 89;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">memory</span>
          <h2 className="text-sm font-semibold text-text">缓存检查器</h2>
          <Badge variant="info">{KEYS.length} keys</Badge>
          <Badge variant="success">命中 {hitRate}%</Badge>
          <Badge variant="warning">{(totalSize / 1048576).toFixed(2)} MB</Badge>
          <select value={engine} onChange={(e) => setEngine(e.target.value as CacheEngine)} className="bg-bg border border-border-light rounded px-2 h-7 text-[10px]">
            {Object.entries(ENGINES).map(([k, v]) => <option key={k} value={k}>{k} ({v.version})</option>)}
          </select>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="refresh">刷新</Button>
            <Button size="sm" icon="delete_sweep">清理</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'keys',   l: `键 (${KEYS.length})` },
            { k: 'stats',  l: '统计' },
            { k: 'memory', l: '内存' },
            { k: 'cli',    l: 'CLI' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-72 border-r border-border bg-bg overflow-y-auto">
            <div className="px-3 py-2 border-b border-border-light space-y-1.5">
              <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="搜索 key (e.g. session:*)" className="w-full bg-bg border border-border-light rounded px-2 h-6 text-[10px]" />
              <select value={namespaceFilter} onChange={(e) => setNamespaceFilter(e.target.value)} className="w-full bg-bg border border-border-light rounded px-2 h-6 text-[10px]">
                <option value="all">所有 namespace</option>
                {NAMESPACES.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            {filtered.map(k => (
              <div key={k.key} onClick={() => setActiveKeyId(k.key)}
                className={'px-3 py-2 border-b border-border-light cursor-pointer hover:bg-surface-high ' + (activeKeyId === k.key ? 'bg-accent/10 border-l-2 border-l-accent' : '')}>
                <div className="flex items-center gap-1 mb-1">
                  <Badge variant="info">{k.type}</Badge>
                  <code className="text-[10px] font-mono text-text truncate">{k.key}</code>
                </div>
                <div className="text-[10px] text-text-secondary flex items-center gap-2">
                  <span>{formatBytes(k.size)}</span>
                  <span>·</span>
                  <span>TTL {formatTTL(k.ttl)}</span>
                  <span>·</span>
                  <span>{k.hits} hits</span>
                </div>
              </div>
            ))}
          </div>

          <div className="flex-1 overflow-auto p-3 space-y-3">
            {tab === 'keys' && (
              <>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant="info">{activeKey.type}</Badge>
                    <code className="text-sm font-mono font-bold text-text">{activeKey.key}</code>
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-[11px]">
                    <div>
                      <p className="text-[10px] text-text-secondary">大小</p>
                      <p className="text-text font-mono">{formatBytes(activeKey.size)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-text-secondary">TTL</p>
                      <p className="text-text font-mono">{formatTTL(activeKey.ttl)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-text-secondary">命中次数</p>
                      <p className="text-text font-mono">{activeKey.hits}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-text-secondary">Namespace</p>
                      <p className="text-text font-mono">{activeKey.namespace}</p>
                    </div>
                  </div>
                </div>

                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h4 className="text-xs font-semibold text-text mb-2">值预览</h4>
                  <pre className="bg-surface-high border border-border-light rounded p-3 text-[11px] font-mono text-text whitespace-pre-wrap max-h-64 overflow-y-auto">{activeKey.preview}</pre>
                </div>

                <div className="flex items-center gap-2">
                  <Button size="sm" icon="edit">修改</Button>
                  <Button size="sm" icon="schedule">续期</Button>
                  <Button size="sm" icon="content_copy">复制</Button>
                  <Button size="sm" icon="delete" variant="danger">删除</Button>
                </div>
              </>
            )}

            {tab === 'stats' && (
              <div className="grid grid-cols-4 gap-3">
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <p className="text-[10px] text-text-secondary">总命中</p>
                  <p className="text-2xl font-bold text-success font-mono mt-1">{totalHits.toLocaleString()}</p>
                </div>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <p className="text-[10px] text-text-secondary">命中率</p>
                  <p className="text-2xl font-bold text-text font-mono mt-1">{hitRate}%</p>
                </div>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <p className="text-[10px] text-text-secondary">淘汰键数</p>
                  <p className="text-2xl font-bold text-warning font-mono mt-1">{evictedKeys}</p>
                </div>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <p className="text-[10px] text-text-secondary">连接客户端</p>
                  <p className="text-2xl font-bold text-text font-mono mt-1">{connectedClients}</p>
                </div>
                <div className="col-span-2 bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">操作统计</h3>
                  <div className="space-y-1.5 text-[11px]">
                    {[
                      { op: 'GET',     count: 1245678, color: 'success' },
                      { op: 'SET',     count: 234567,  color: 'info' },
                      { op: 'DEL',     count: 12456,   color: 'danger' },
                      { op: 'HGET',    count: 567890,  color: 'success' },
                      { op: 'EXPIRE',  count: 12345,   color: 'warning' },
                      { op: 'INCR',    count: 98765,   color: 'info' },
                    ].map(s => (
                      <div key={s.op} className="flex items-center gap-2">
                        <code className="text-[10px] font-mono text-text w-16">{s.op}</code>
                        <div className="flex-1 h-2 bg-surface-high rounded-full overflow-hidden">
                          <div className={`h-full bg-${s.color === 'success' ? 'success' : s.color === 'info' ? 'info' : s.color === 'warning' ? 'warning' : 'danger'}`} style={{ width: `${(s.count / 1245678) * 100}%` }}></div>
                        </div>
                        <span className="text-[10px] text-text font-mono w-20 text-right">{s.count.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="col-span-2 bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">按类型</h3>
                  <div className="space-y-1.5 text-[11px]">
                    {['string', 'hash', 'list', 'set', 'zset', 'stream'].map(t => {
                      const count = KEYS.filter(k => k.type === t).length;
                      return (
                        <div key={t} className="flex items-center gap-2">
                          <Badge variant="info">{t}</Badge>
                          <span className="text-text font-mono">{count}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {tab === 'memory' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">内存使用 ({ENGINES[engine].maxMemory})</h3>
                <div className="space-y-2">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] text-text">总使用</span>
                      <span className="text-[11px] text-text font-mono">{(totalSize / 1048576).toFixed(2)} MB / {ENGINES[engine].maxMemory}</span>
                    </div>
                    <div className="h-3 bg-surface-high rounded-full overflow-hidden">
                      <div className="h-full bg-accent" style={{ width: `${(totalSize / 8388608) * 100}%` }}></div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mt-3">
                    <div>
                      <p className="text-[10px] text-text-secondary mb-1">淘汰策略</p>
                      <Badge variant="warning">allkeys-lru</Badge>
                    </div>
                    <div>
                      <p className="text-[10px] text-text-secondary mb-1">分片</p>
                      <Badge variant="info">16 slots</Badge>
                    </div>
                    <div>
                      <p className="text-[10px] text-text-secondary mb-1">持久化</p>
                      <Badge variant="success">AOF + RDB</Badge>
                    </div>
                    <div>
                      <p className="text-[10px] text-text-secondary mb-1">集群模式</p>
                      <Badge variant="success">Cluster</Badge>
                    </div>
                  </div>
                </div>
                <div className="mt-3 pt-3 border-t border-border-light">
                  <h4 className="text-xs font-semibold text-text mb-2">最大键</h4>
                  {KEYS.slice().sort((a, b) => b.size - a.size).slice(0, 5).map(k => (
                    <div key={k.key} className="flex items-center gap-2 py-1 text-[11px]">
                      <code className="font-mono text-text flex-1 truncate">{k.key}</code>
                      <span className="text-text-secondary font-mono">{formatBytes(k.size)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === 'cli' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">Redis CLI</h3>
                <div className="bg-black rounded p-3 font-mono text-[11px] h-64 overflow-y-auto">
                  <p className="text-green-400">redis-cli connected to {ENGINES[engine].host}:{ENGINES[engine].port}</p>
                  <p className="text-gray-400">dragonfly&gt; KEYS *</p>
                  <p className="text-gray-300">1) "{KEYS[0].key}"</p>
                  <p className="text-gray-300">2) "{KEYS[1].key}"</p>
                  <p className="text-gray-300">3) "{KEYS[2].key}"</p>
                  <p className="text-gray-300">... (8 more)</p>
                  <p className="text-gray-400">dragonfly&gt; HGETALL {KEYS[0].key}</p>
                  <p className="text-yellow-300">1) "userId"</p>
                  <p className="text-yellow-300">2) "u_12345"</p>
                  <p className="text-yellow-300">3) "roles"</p>
                  <p className="text-yellow-300">4) "[&quot;admin&quot;]"</p>
                  <p className="text-gray-400">dragonfly&gt; TTL {KEYS[0].key}</p>
                  <p className="text-yellow-300">(integer) {KEYS[0].ttl}</p>
                  <p className="text-gray-400">dragonfly&gt; INFO memory</p>
                  <p className="text-yellow-300">used_memory_human:{(totalSize / 1048576).toFixed(2)}M</p>
                  <p className="text-gray-400">dragonfly&gt; <span className="animate-pulse">_</span></p>
                </div>
                <div className="mt-2 flex gap-1.5">
                  <input className="flex-1 bg-bg border border-border-light rounded px-2 h-7 text-[11px] font-mono" placeholder="输入命令..." />
                  <Button size="sm" variant="primary">执行</Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
