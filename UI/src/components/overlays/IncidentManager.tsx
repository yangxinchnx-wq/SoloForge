// ─────────────────────────────────────────────────────────────────
// 事件响应管理器 — IncidentManager
// - 事件升级/值班/On-call 轮转
// - Runbook 文档关联
// - 事后复盘 (Postmortem)
// - 状态页发布
// - 时间线 + 沟通记录
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type Severity = 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4';
type Status = 'investigating' | 'identified' | 'mitigating' | 'monitoring' | 'resolved';

interface Incident {
  id: string;
  key: string;          // INC-001
  title: string;
  severity: Severity;
  status: Status;
  service: string;
  started: number;
  resolved?: number;
  commander: string;
  responders: string[];
  affected: number;     // users
  timeline: TimelineEvent[];
  postmortem?: string;
  runbook?: string;
  publicUpdates: PublicUpdate[];
}

interface TimelineEvent {
  ts: number;
  type: 'alert' | 'ack' | 'action' | 'update' | 'resolve' | 'comm';
  actor: string;
  text: string;
}

interface PublicUpdate {
  ts: number;
  status: Status;
  text: string;
}

interface Oncall {
  id: string;
  name: string;
  role: 'primary' | 'secondary' | 'manager';
  start: number;
  end: number;
  rotations: string[];
}

const INCIDENTS: Incident[] = [
  {
    id: 'i1', key: 'INC-2024-0421', title: '登录服务 5xx 错误率飙升', severity: 'SEV1', status: 'monitoring',
    service: 'auth-api', started: Date.now() - 1800000, resolved: Date.now() - 300000,
    commander: 'Alice Chen', responders: ['Bob Wang', 'Carol Liu', 'David Zhang'],
    affected: 12400,
    timeline: [
      { ts: Date.now() - 1800000, type: 'alert',  actor: 'system',  text: '触发告警: 5xx 错误率 > 5% (当前 12.4%)' },
      { ts: Date.now() - 1750000, type: 'ack',    actor: 'Alice',   text: '确认事件,认领 IC 角色' },
      { ts: Date.now() - 1700000, type: 'comm',   actor: 'Alice',   text: '在 #inc-2024-0421 频道广播' },
      { ts: Date.now() - 1500000, type: 'action', actor: 'Bob',     text: '回滚 v1.4.2 → v1.4.1,15s 内完成' },
      { ts: Date.now() - 1200000, type: 'update', actor: 'Alice',   text: '5xx 率下降至 0.8%' },
      { ts: Date.now() - 900000,  type: 'action', actor: 'Carol',   text: '定位根因: db-migration 引入了不兼容的索引' },
      { ts: Date.now() - 600000,  type: 'update', actor: 'Alice',   text: '补丁 PR 已合并,准备部署' },
      { ts: Date.now() - 300000,  type: 'resolve',actor: 'Alice',   text: '5xx 率恢复至 0.01%,转入监控' },
    ],
    publicUpdates: [
      { ts: Date.now() - 1700000, status: 'investigating', text: '我们正在调查登录服务可能出现的故障。' },
      { ts: Date.now() - 1200000, status: 'identified',    text: '已识别问题为数据库迁移,正在回滚。' },
      { ts: Date.now() - 600000,  status: 'mitigating',    text: '已实施修复,大部分用户可正常登录。' },
      { ts: Date.now() - 300000,  status: 'monitoring',    text: '事件已解决,正在持续监控系统状态。' },
    ],
    runbook: 'runbooks/auth-api-5xx.md',
    postmortem: '# INC-2024-0421 复盘\n\n## 时间线\n- ...\n\n## 根因\n数据库 migration 引入的 UNIQUE 索引与已有数据冲突...\n\n## 改进项\n1. 灰度发布数据库 migration\n2. 添加 5xx 错误率预警\n3. 更新 runbook',
  },
  {
    id: 'i2', key: 'INC-2024-0420', title: 'CDN 缓存命中率突降', severity: 'SEV3', status: 'resolved',
    service: 'cdn', started: Date.now() - 7200000, resolved: Date.now() - 6000000,
    commander: 'Bob Wang', responders: ['Eve'],
    affected: 0,
    timeline: [
      { ts: Date.now() - 7200000, type: 'alert',   actor: 'system', text: '缓存命中率 78% → 45%' },
      { ts: Date.now() - 7100000, type: 'ack',     actor: 'Bob',    text: '确认,正在分析' },
      { ts: Date.now() - 6600000, type: 'action',  actor: 'Bob',    text: '刷新 cache key 前缀规则' },
      { ts: Date.now() - 6000000, type: 'resolve', actor: 'Bob',    text: '命中率恢复 92%' },
    ],
    publicUpdates: [
      { ts: Date.now() - 7100000, status: 'investigating', text: 'CDN 性能下降,正在调查。' },
      { ts: Date.now() - 6000000, status: 'resolved',      text: '已修复,所有地区恢复正常。' },
    ],
    runbook: 'runbooks/cdn-cache-miss.md',
  },
  {
    id: 'i3', key: 'INC-2024-0419', title: 'API 延迟 P99 飙升至 8s', severity: 'SEV2', status: 'resolved',
    service: 'search-api', started: Date.now() - 86400000, resolved: Date.now() - 82800000,
    commander: 'Carol Liu', responders: ['David', 'Frank'],
    affected: 8200,
    timeline: [
      { ts: Date.now() - 86400000, type: 'alert',   actor: 'system', text: 'P99 延迟 8400ms (SLO: 1000ms)' },
      { ts: Date.now() - 86300000, type: 'ack',     actor: 'Carol',  text: '正在分析' },
      { ts: Date.now() - 86000000, type: 'action',  actor: 'David',  text: '重启 ElasticSearch 集群' },
      { ts: Date.now() - 84000000, type: 'update',  actor: 'Carol',  text: 'P99 降至 1200ms' },
      { ts: Date.now() - 82800000, type: 'resolve', actor: 'Carol',  text: '已恢复' },
    ],
    publicUpdates: [
      { ts: Date.now() - 86300000, status: 'investigating', text: '搜索功能可能出现性能问题。' },
      { ts: Date.now() - 82800000, status: 'resolved',      text: '搜索功能已恢复,感谢您的耐心。' },
    ],
    runbook: 'runbooks/elasticsearch-slow.md',
  },
  {
    id: 'i4', key: 'INC-2024-0418', title: '数据库主从延迟 15 分钟', severity: 'SEV2', status: 'resolved',
    service: 'postgres-primary', started: Date.now() - 172800000, resolved: Date.now() - 169200000,
    commander: 'David Zhang', responders: ['Eve'],
    affected: 0,
    timeline: [
      { ts: Date.now() - 172800000, type: 'alert',   actor: 'system', text: 'replica_lag 900s' },
      { ts: Date.now() - 172700000, type: 'ack',     actor: 'David',  text: '正在调查' },
      { ts: Date.now() - 171000000, type: 'action',  actor: 'David',  text: 'kill 大查询' },
      { ts: Date.now() - 169200000, type: 'resolve', actor: 'David',  text: '延迟恢复 1s 内' },
    ],
    publicUpdates: [
      { ts: Date.now() - 172800000, status: 'investigating', text: '我们注意到数据库复制延迟异常,正在调查。' },
      { ts: Date.now() - 169200000, status: 'resolved',      text: '已恢复,所有读副本延迟恢复正常。' },
    ],
  },
];

const ONCALL: Oncall[] = [
  { id: 'o1', name: 'Alice Chen',  role: 'primary',   start: Date.now() - 86400000, end: Date.now() + 86400000, rotations: ['平台', 'auth-api'] },
  { id: 'o2', name: 'Bob Wang',    role: 'secondary', start: Date.now() - 86400000, end: Date.now() + 86400000, rotations: ['平台'] },
  { id: 'o3', name: 'Carol Liu',   role: 'primary',   start: Date.now() - 86400000, end: Date.now() + 86400000, rotations: ['search-api', 'data'] },
  { id: 'o4', name: 'David Zhang', role: 'manager',   start: Date.now() - 86400000, end: Date.now() + 86400000, rotations: ['全栈'] },
];

function sevColor(s: Severity): string {
  return s === 'SEV1' ? 'danger' : s === 'SEV2' ? 'warning' : s === 'SEV3' ? 'info' : 'default';
}

function statusLabel(s: Status): string {
  return { investigating: '调查中', identified: '已定位', mitigating: '缓解中', monitoring: '监控中', resolved: '已解决' }[s];
}

export function IncidentManager({ open, onClose }: Props) {
  const [tab, setTab] = useState<'active' | 'all' | 'oncall' | 'postmortem'>('active');
  const [activeId, setActiveId] = useState<string>(INCIDENTS[0].id);
  const [filter, setFilter] = useState<'all' | Severity>('all');

  const activeInc = INCIDENTS.find(i => i.id === activeId) || INCIDENTS[0];
  const activeIncidents = INCIDENTS.filter(i => i.status !== 'resolved');

  const filtered = useMemo(() => {
    return filter === 'all' ? INCIDENTS : INCIDENTS.filter(i => i.severity === filter);
  }, [filter]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">report</span>
          <h2 className="text-sm font-semibold text-text">事件响应管理器</h2>
          {activeIncidents.length > 0 && <Badge variant="danger">{activeIncidents.length} 进行中</Badge>}
          <Badge variant="info">{INCIDENTS.length} 总计</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="add" variant="primary">新建事件</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'active',     l: `进行中 (${activeIncidents.length})` },
            { k: 'all',        l: `所有 (${INCIDENTS.length})` },
            { k: 'oncall',     l: '值班表' },
            { k: 'postmortem', l: '复盘' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-72 border-r border-border bg-bg overflow-y-auto">
            <div className="px-3 py-2 border-b border-border-light flex items-center gap-1">
              <select value={filter} onChange={(e) => setFilter(e.target.value as any)} className="flex-1 bg-bg border border-border-light rounded px-2 h-6 text-[10px]">
                <option value="all">所有严重度</option>
                <option value="SEV1">SEV1</option>
                <option value="SEV2">SEV2</option>
                <option value="SEV3">SEV3</option>
                <option value="SEV4">SEV4</option>
              </select>
            </div>
            {filtered.map(inc => {
              const dur = inc.resolved ? inc.resolved - inc.started : Date.now() - inc.started;
              const durStr = dur < 60000 ? `${Math.round(dur/1000)}s` : dur < 3600000 ? `${Math.round(dur/60000)}m` : `${Math.round(dur/3600000)}h`;
              return (
                <div key={inc.id} onClick={() => { setActiveId(inc.id); setTab('all'); }}
                  className={'px-3 py-2 border-b border-border-light cursor-pointer hover:bg-surface-high ' + (activeId === inc.id ? 'bg-accent/10 border-l-2 border-l-accent' : '')}>
                  <div className="flex items-center gap-1 mb-1">
                    <Badge variant={sevColor(inc.severity) as any}>{inc.severity}</Badge>
                    <code className="text-[10px] text-text-secondary font-mono">{inc.key}</code>
                  </div>
                  <div className="text-[11px] font-medium text-text truncate">{inc.title}</div>
                  <div className="text-[10px] text-text-secondary mt-0.5 flex items-center gap-1">
                    <span>{inc.service}</span>
                    <span>·</span>
                    <span>{statusLabel(inc.status)}</span>
                    <span className="ml-auto">{durStr}</span>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex-1 overflow-auto p-3">
            {tab === 'oncall' && (
              <div className="space-y-3">
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">当前值班 (24h 轮转)</h3>
                  <div className="grid grid-cols-2 gap-2">
                    {ONCALL.map(o => (
                      <div key={o.id} className="bg-bg border border-border-light rounded p-2">
                        <div className="flex items-center gap-2">
                          <span className="material-symbols-outlined text-base text-accent">person</span>
                          <div className="flex-1">
                            <p className="text-xs font-semibold text-text">{o.name}</p>
                            <p className="text-[10px] text-text-secondary">{o.rotations.join(', ')}</p>
                          </div>
                          <Badge variant={o.role === 'primary' ? 'danger' : o.role === 'secondary' ? 'warning' : 'info'}>{o.role}</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">本周排班</h3>
                  <table className="w-full text-xs">
                    <thead className="text-[10px] text-text-secondary">
                      <tr>
                        <th className="text-left py-1">日期</th>
                        <th className="text-left py-1">Primary</th>
                        <th className="text-left py-1">Secondary</th>
                        <th className="text-left py-1">Manager</th>
                      </tr>
                    </thead>
                    <tbody>
                      {['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((d, i) => (
                        <tr key={d} className="border-t border-border-light">
                          <td className="py-1 text-text-secondary">{d}</td>
                          <td className="py-1 text-text">{ONCALL[i % ONCALL.length].name}</td>
                          <td className="py-1 text-text">{ONCALL[(i + 1) % ONCALL.length].name}</td>
                          <td className="py-1 text-text">{ONCALL[3].name}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {(tab === 'all' || tab === 'active') && (
              <div className="space-y-3">
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant={sevColor(activeInc.severity) as any}>{activeInc.severity}</Badge>
                    <code className="text-sm font-mono font-bold text-text">{activeInc.key}</code>
                    <Badge variant="info">{statusLabel(activeInc.status)}</Badge>
                    {activeInc.status === 'resolved' && <Badge variant="success">✓</Badge>}
                  </div>
                  <h3 className="text-base font-semibold text-text">{activeInc.title}</h3>
                  <div className="text-[10px] text-text-secondary mt-1 flex items-center gap-3">
                    <span>服务: {activeInc.service}</span>
                    <span>·</span>
                    <span>开始: {new Date(activeInc.started).toLocaleString()}</span>
                    {activeInc.resolved && <><span>·</span><span>解决: {new Date(activeInc.resolved).toLocaleString()}</span></>}
                    {activeInc.affected > 0 && <><span>·</span><span className="text-danger">影响 {activeInc.affected.toLocaleString()} 用户</span></>}
                  </div>
                  <div className="text-[11px] text-text mt-2 flex items-center gap-3">
                    <span><span className="text-text-secondary">IC: </span><span className="text-text font-medium">{activeInc.commander}</span></span>
                    <span><span className="text-text-secondary">响应者: </span><span className="text-text">{activeInc.responders.join(', ')}</span></span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h4 className="text-xs font-semibold text-text mb-2">事件时间线</h4>
                    <div className="space-y-1.5">
                      {activeInc.timeline.map((t, i) => (
                        <div key={i} className="flex gap-2 text-[11px]">
                          <span className="text-text-secondary text-[10px] w-12 shrink-0">{new Date(t.ts).toLocaleTimeString().slice(0, 5)}</span>
                          <span className={'shrink-0 w-4 h-4 rounded-full flex items-center justify-center ' + (
                            t.type === 'alert' ? 'bg-danger' : t.type === 'ack' ? 'bg-warning' : t.type === 'action' ? 'bg-info' : t.type === 'update' ? 'bg-accent' : t.type === 'resolve' ? 'bg-success' : 'bg-text-secondary'
                          )}>
                            <span className="text-white text-[8px]">{t.type === 'alert' ? '!' : t.type === 'ack' ? '✓' : t.type === 'action' ? '⚙' : t.type === 'update' ? 'i' : t.type === 'resolve' ? '✓' : '💬'}</span>
                          </span>
                          <div className="flex-1">
                            <p className="text-text">{t.text}</p>
                            <p className="text-[10px] text-text-secondary">{t.actor}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h4 className="text-xs font-semibold text-text mb-2">公开状态页更新</h4>
                    <div className="space-y-1.5">
                      {activeInc.publicUpdates.map((u, i) => (
                        <div key={i} className="border-l-2 border-accent pl-2 py-0.5">
                          <div className="flex items-center gap-1 text-[10px] text-text-secondary mb-0.5">
                            <Badge variant="info">{statusLabel(u.status)}</Badge>
                            <span>{new Date(u.ts).toLocaleString()}</span>
                          </div>
                          <p className="text-[11px] text-text">{u.text}</p>
                        </div>
                      ))}
                    </div>
                    {activeInc.runbook && (
                      <div className="mt-3 pt-2 border-t border-border-light">
                        <p className="text-[10px] text-text-secondary">Runbook</p>
                        <code className="text-[10px] font-mono text-accent">{activeInc.runbook}</code>
                      </div>
                    )}
                  </div>
                </div>

                {activeInc.postmortem && (
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h4 className="text-xs font-semibold text-text mb-2">事后复盘 (Postmortem)</h4>
                    <pre className="bg-bg border border-border-light rounded p-2 text-[10px] font-mono text-text whitespace-pre-wrap max-h-40 overflow-y-auto">{activeInc.postmortem}</pre>
                  </div>
                )}
              </div>
            )}

            {tab === 'postmortem' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">Postmortem 文化</h3>
                <p className="text-[10px] text-text-secondary mb-3">无指责复盘 - 关注系统问题而非个人</p>
                <div className="grid grid-cols-3 gap-2">
                  {INCIDENTS.filter(i => i.postmortem).map(i => (
                    <div key={i.id} onClick={() => { setActiveId(i.id); setTab('all'); }} className="bg-bg border border-border-light rounded p-2 cursor-pointer hover:bg-surface-high">
                      <Badge variant={sevColor(i.severity) as any}>{i.severity}</Badge>
                      <p className="text-[11px] text-text font-medium mt-1">{i.key}</p>
                      <p className="text-[10px] text-text-secondary">{i.title}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
