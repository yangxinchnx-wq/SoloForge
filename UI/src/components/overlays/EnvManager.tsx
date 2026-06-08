// ─────────────────────────────────────────────────────────────────
// 环境变量管理 — EnvManager
// - 多环境 (dev/staging/prod) 切换
// - 变量编辑 (KEY=VALUE)
// - 一键复制 .env 格式
// - 加密敏感字段标记
// - 导入/导出 .env 文件
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface EnvVar {
  key: string;
  value: string;
  sensitive: boolean;
  description?: string;
}

interface Env {
  id: string;
  name: string;
  color: string;
  icon: string;
  vars: EnvVar[];
}

const STORE = 'soloforge.env-manager.v1';

const DEFAULT_ENVS: Env[] = [
  {
    id: 'dev', name: '开发', color: '#10b981', icon: 'science',
    vars: [
      { key: 'NODE_ENV', value: 'development', sensitive: false },
      { key: 'API_BASE', value: 'http://localhost:3001', sensitive: false },
      { key: 'DB_URL', value: 'rocksdb://data/soloforge_dev', sensitive: false },
      { key: 'DEBUG', value: 'true', sensitive: false },
      { key: 'LOG_LEVEL', value: 'debug', sensitive: false },
      { key: 'JWT_SECRET', value: 'dev-secret-do-not-use-in-prod', sensitive: true, description: '开发用密钥' },
    ],
  },
  {
    id: 'staging', name: '预发', color: '#f59e0b', icon: 'preview',
    vars: [
      { key: 'NODE_ENV', value: 'staging', sensitive: false },
      { key: 'API_BASE', value: 'https://staging.soloforge.dev', sensitive: false },
      { key: 'DB_URL', value: 'rocksdb://data/soloforge_staging', sensitive: false },
      { key: 'DEBUG', value: 'false', sensitive: false },
      { key: 'LOG_LEVEL', value: 'info', sensitive: false },
      { key: 'JWT_SECRET', value: 'stg_••••••••••', sensitive: true, description: '预发密钥' },
      { key: 'SENTRY_DSN', value: 'https://stg@sentry.io/123', sensitive: false },
    ],
  },
  {
    id: 'prod', name: '生产', color: '#ef4444', icon: 'public',
    vars: [
      { key: 'NODE_ENV', value: 'production', sensitive: false },
      { key: 'API_BASE', value: 'https://api.soloforge.dev', sensitive: false },
      { key: 'DB_URL', value: 'rocksdb://data/soloforge_prod', sensitive: false },
      { key: 'DEBUG', value: 'false', sensitive: false },
      { key: 'LOG_LEVEL', value: 'warn', sensitive: false },
      { key: 'JWT_SECRET', value: 'prod_••••••••••', sensitive: true, description: '生产密钥 (KMS 管理)' },
      { key: 'SENTRY_DSN', value: 'https://prod@sentry.io/456', sensitive: false },
      { key: 'REDIS_URL', value: 'redis://prod-redis.internal:6379', sensitive: false },
    ],
  },
];

function load(): Env[] { try { const r = localStorage.getItem(STORE); if (r) return JSON.parse(r); } catch { /* */ } return DEFAULT_ENVS; }
function save(d: Env[]) { try { localStorage.setItem(STORE, JSON.stringify(d)); } catch { /* */ } }

function toEnvFile(env: Env): string {
  return `# Environment: ${env.name}\n# Generated: ${new Date().toISOString()}\n\n${env.vars.map(v => {
    const val = v.sensitive ? '••••••••' : v.value;
    return `${v.key}=${val.includes(' ') || val.includes('#') ? `"${val}"` : val}${v.description ? `  # ${v.description}` : ''}`;
  }).join('\n')}\n`;
}

export function EnvManager({ open, onClose }: Props) {
  const [envs, setEnvs] = useState<Env[]>(load);
  const [activeId, setActiveId] = useState<string>('dev');
  const [search, setSearch] = useState('');
  const [showSecrets, setShowSecrets] = useState(false);

  useEffect(() => { save(envs); }, [envs]);

  const active = useMemo(() => envs.find(e => e.id === activeId) || envs[0], [envs, activeId]);
  const filtered = useMemo(() => {
    if (!active) return [];
    const q = search.toLowerCase();
    return active.vars.filter(v => !q || v.key.toLowerCase().includes(q) || v.value.toLowerCase().includes(q));
  }, [active, search]);

  const updateVar = useCallback((idx: number, patch: Partial<EnvVar>) => {
    setEnvs(prev => prev.map(e => e.id === activeId ? { ...e, vars: e.vars.map((v, j) => j === idx ? { ...v, ...patch } : v) } : e));
  }, [activeId]);

  const addVar = useCallback(() => {
    setEnvs(prev => prev.map(e => e.id === activeId ? { ...e, vars: [...e.vars, { key: 'NEW_KEY', value: '', sensitive: false }] } : e));
  }, [activeId]);

  const delVar = useCallback((idx: number) => {
    setEnvs(prev => prev.map(e => e.id === activeId ? { ...e, vars: e.vars.filter((_, j) => j !== idx) } : e));
  }, [activeId]);

  const copyEnv = useCallback(() => {
    if (!active) return;
    const txt = toEnvFile(active);
    navigator.clipboard?.writeText(txt).catch(() => {});
  }, [active]);

  const downloadEnv = useCallback(() => {
    if (!active) return;
    const blob = new Blob([toEnvFile(active)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `.env.${active.id}`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [active]);

  const importEnv = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const txt = reader.result as string;
      const lines = txt.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      const vars: EnvVar[] = lines.map(line => {
        const [key, ...rest] = line.split('=');
        const value = rest.join('=').replace(/^["']|["']$/g, '');
        return { key: key.trim(), value, sensitive: key.toUpperCase().includes('SECRET') || key.toUpperCase().includes('PASSWORD') || key.toUpperCase().includes('TOKEN') || key.toUpperCase().includes('KEY') };
      });
      setEnvs(prev => prev.map(e => e.id === activeId ? { ...e, vars: [...e.vars, ...vars] } : e));
    };
    reader.readAsText(file);
  }, [activeId]);

  if (!open) return null;

  const sensitiveCount = active?.vars.filter(v => v.sensitive).length || 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1100px] max-w-[95vw] h-[80vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">tune</span>
          <h2 className="text-sm font-semibold text-text">环境变量</h2>
          <Badge variant="primary">{envs.length} 环境</Badge>
          {active && <Badge variant="warning">🔒 {sensitiveCount} 敏感</Badge>}
          <div className="ml-auto flex items-center gap-1">
            <Tooltip content={showSecrets ? '隐藏敏感' : '显示敏感'}>
              <IconButton icon={showSecrets ? 'visibility_off' : 'visibility'} active={showSecrets} onClick={() => setShowSecrets(!showSecrets)} />
            </Tooltip>
            <Button size="sm" icon="content_copy" onClick={copyEnv}>复制 .env</Button>
            <Button size="sm" icon="download" onClick={downloadEnv}>下载</Button>
            <Tooltip content="导入 .env">
              <IconButton icon="upload" onClick={() => {
                const inp = document.createElement('input');
                inp.type = 'file'; inp.accept = '.env,.txt';
                inp.onchange = () => { const f = inp.files?.[0]; if (f) importEnv(f); };
                inp.click();
              }} />
            </Tooltip>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-48 border-r border-border bg-bg p-2 space-y-1">
            {envs.map(e => (
              <button key={e.id} onClick={() => setActiveId(e.id)}
                className={'w-full text-left px-2 py-2 rounded flex items-center gap-2 transition ' + (activeId === e.id ? 'bg-accent/15 text-accent' : 'hover:bg-surface-high text-text')}>
                <span className="material-symbols-outlined text-sm" style={{ color: e.color }}>{e.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate">{e.name}</div>
                  <div className="text-[10px] text-text-secondary">{e.vars.length} 变量</div>
                </div>
              </button>
            ))}
            <Button size="xs" icon="add" block onClick={() => {
              const id = 'env_' + Date.now().toString(36);
              setEnvs(prev => [...prev, { id, name: '新环境', color: '#3b82f6', icon: 'settings', vars: [] }]);
              setActiveId(id);
            }}>新建环境</Button>
          </div>

          <div className="flex-1 flex flex-col p-3 overflow-hidden">
            <div className="flex items-center gap-2 mb-2">
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索 KEY 或 VALUE..."
                className="flex-1 bg-bg border border-border-light rounded px-2 h-7 text-xs" />
              <Button size="sm" icon="add" onClick={addVar}>新增变量</Button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <div className="bg-bg border border-border-light rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-surface-high text-text-secondary text-[10px]">
                    <tr>
                      <th className="text-left px-2 py-1.5 w-6"></th>
                      <th className="text-left px-2 py-1.5">KEY</th>
                      <th className="text-left px-2 py-1.5">VALUE</th>
                      <th className="text-left px-2 py-1.5 w-20">敏感</th>
                      <th className="text-left px-2 py-1.5 w-6"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((v, i) => {
                      const realIdx = active?.vars.findIndex(x => x === v) ?? i;
                      const displayValue = v.sensitive && !showSecrets ? '••••••••' : v.value;
                      return (
                        <tr key={i} className="border-t border-border-light hover:bg-surface-high">
                          <td className="px-2 py-1">
                            <span className={'inline-block w-2 h-2 rounded-full ' + (v.sensitive ? 'bg-warning' : 'bg-success')} title={v.sensitive ? '敏感' : '普通'} />
                          </td>
                          <td className="px-2 py-1">
                            <input value={v.key} onChange={(e) => updateVar(realIdx, { key: e.target.value })}
                              className="w-full bg-transparent font-mono text-[11px] text-text" />
                          </td>
                          <td className="px-2 py-1">
                            <input value={displayValue} onChange={(e) => updateVar(realIdx, { value: e.target.value })}
                              className="w-full bg-transparent font-mono text-[11px] text-text" />
                          </td>
                          <td className="px-2 py-1">
                            <button onClick={() => updateVar(realIdx, { sensitive: !v.sensitive })}
                              className={'text-[10px] px-1.5 py-0.5 rounded ' + (v.sensitive ? 'bg-warning/20 text-warning' : 'bg-surface-high text-text-secondary')}>
                              {v.sensitive ? '是' : '否'}
                            </button>
                          </td>
                          <td className="px-2 py-1">
                            <IconButton icon="close" size="xs" onClick={() => delVar(realIdx)} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            {active && (
              <div className="mt-2 p-2 bg-bg border border-border-light rounded text-[10px] font-mono text-text-secondary max-h-24 overflow-auto">
                <div className="text-text font-semibold mb-1"># 预览 .env</div>
                <pre className="whitespace-pre-wrap break-all">{toEnvFile(active)}</pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
