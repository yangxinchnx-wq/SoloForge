// ─────────────────────────────────────────────────────────────────
// 发布规划器 — ReleasePlanner
// - 版本路线图
// - 功能/修复/性能分类
// - 风险评估
// - 时间线甘特图
// - 跨团队依赖
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type ReleaseStatus = 'planning' | 'in_development' | 'code_freeze' | 'released' | 'cancelled';
type ItemType = 'feature' | 'improvement' | 'bugfix' | 'breaking' | 'security' | 'deprecation';
type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

interface Release {
  id: string;
  version: string;
  codename: string;
  status: ReleaseStatus;
  targetDate: number;
  releaseManager: string;
  items: ReleaseItem[];
  blockers: number;
  completion: number;     // 0-100
  risk: RiskLevel;
  description: string;
}

interface ReleaseItem {
  id: string;
  title: string;
  type: ItemType;
  team: string;
  owner: string;
  status: 'todo' | 'in_progress' | 'review' | 'done' | 'blocked';
  progress: number;
  risk: RiskLevel;
  prLink?: string;
  dependsOn?: string[];
}

const RELEASES: Release[] = [
  {
    id: 'r1', version: 'v2.0.0', codename: 'Aurora', status: 'in_development', targetDate: Date.now() + 86400000 * 21,
    releaseManager: 'Alice Chen', blockers: 3, completion: 68, risk: 'medium',
    description: '下一代 SoloForge 核心版本,引入全新微内核架构、嵌入式 SurrealDB、Rust 调度器',
    items: [
      { id: 'i1',  title: '微内核 v2 重构',           type: 'breaking',  team: 'Core',         owner: 'Alice Chen',  status: 'in_progress', progress: 75,  risk: 'high' },
      { id: 'i2',  title: 'SurrealDB 嵌入式持久化',     type: 'feature',    team: 'Infra',        owner: 'David Zhang', status: 'in_progress', progress: 90,  risk: 'medium' },
      { id: 'i3',  title: 'Rust 调度器集成',           type: 'feature',    team: 'Infra',        owner: 'David Zhang', status: 'review',      progress: 95,  risk: 'low' },
      { id: 'i4',  title: '新智能体编排 UI',          type: 'feature',    team: 'Frontend',     owner: 'Frank Lin',   status: 'in_progress', progress: 60,  risk: 'medium' },
      { id: 'i5',  title: '多模型路由 (Claude/GPT)',   type: 'feature',    team: 'AI/ML',        owner: 'Carol Liu',   status: 'in_progress', progress: 80,  risk: 'low' },
      { id: 'i6',  title: '修复: 内存泄漏 in scheduler', type: 'bugfix',     team: 'Infra',        owner: 'David Zhang', status: 'done',         progress: 100, risk: 'medium' },
      { id: 'i7',  title: '废弃: 旧版 CLI',            type: 'deprecation',team: 'Platform',     owner: 'Bob Wang',    status: 'in_progress', progress: 50,  risk: 'low' },
      { id: 'i8',  title: '性能: 启动时间 < 1s',        type: 'improvement',team: 'Core',         owner: 'Alice Chen',  status: 'blocked',     progress: 30,  risk: 'high',   dependsOn: ['i1'] },
      { id: 'i9',  title: '安全: OAuth2 PKCE 强制',     type: 'security',   team: 'Auth',         owner: 'Bob Wang',    status: 'done',         progress: 100, risk: 'medium' },
      { id: 'i10', title: 'API v2 文档',               type: 'improvement',team: 'Docs',         owner: 'Eve',         status: 'in_progress', progress: 65,  risk: 'low' },
    ],
  },
  {
    id: 'r2', version: 'v1.5.0', codename: 'Pulse', status: 'released', targetDate: Date.now() - 86400000 * 14,
    releaseManager: 'Bob Wang', blockers: 0, completion: 100, risk: 'low',
    description: '当前稳定版本,功能增量更新',
    items: [
      { id: 'j1', title: '多语言支持',  type: 'feature', team: 'Frontend', owner: 'Grace Lee',  status: 'done', progress: 100, risk: 'low' },
      { id: 'j2', title: '缓存预热',    type: 'improvement', team: 'Infra', owner: 'David Zhang', status: 'done', progress: 100, risk: 'low' },
      { id: 'j3', title: '修复: 文件上传超时', type: 'bugfix', team: 'Platform', owner: 'Bob Wang', status: 'done', progress: 100, risk: 'medium' },
    ],
  },
  {
    id: 'r3', version: 'v2.1.0', codename: 'Borealis', status: 'planning', targetDate: Date.now() + 86400000 * 60,
    releaseManager: 'Carol Liu', blockers: 0, completion: 5, risk: 'medium',
    description: 'v2.0 后的次要更新,聚焦稳定性和开发者体验',
    items: [
      { id: 'k1', title: 'SDK 多语言生成',  type: 'feature', team: 'Platform', owner: 'Frank Lin', status: 'todo', progress: 0,   risk: 'medium' },
      { id: 'k2', title: '实时协作编辑',    type: 'feature', team: 'Frontend', owner: 'Grace Lee', status: 'todo', progress: 0,   risk: 'high' },
    ],
  },
];

const TYPE_LABEL: Record<ItemType, string> = {
  feature: '功能', improvement: '改进', bugfix: '修复', breaking: '破坏性', security: '安全', deprecation: '废弃'
};
const TYPE_COLOR: Record<ItemType, 'success' | 'info' | 'warning' | 'danger' | 'default'> = {
  feature: 'success', improvement: 'info', bugfix: 'warning', breaking: 'danger', security: 'danger', deprecation: 'default'
};
const STATUS_COLOR: Record<ReleaseItem['status'], 'success' | 'info' | 'warning' | 'danger' | 'default'> = {
  todo: 'default', in_progress: 'info', review: 'warning', done: 'success', blocked: 'danger'
};
const RISK_COLOR: Record<RiskLevel, 'success' | 'warning' | 'danger' | 'default'> = {
  low: 'success', medium: 'warning', high: 'danger', critical: 'danger'
};

export function ReleasePlanner({ open, onClose }: Props) {
  const [tab, setTab] = useState<'roadmap' | 'detail' | 'timeline' | 'risks'>('roadmap');
  const [activeReleaseId, setActiveReleaseId] = useState<string>(RELEASES[0].id);
  const [typeFilter, setTypeFilter] = useState<ItemType | 'all'>('all');
  const activeRelease = RELEASES.find(r => r.id === activeReleaseId) || RELEASES[0];

  const filteredItems = typeFilter === 'all' ? activeRelease.items : activeRelease.items.filter(i => i.type === typeFilter);
  const totalRisk = activeRelease.items.filter(i => i.risk === 'high' || i.risk === 'critical').length;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">rocket</span>
          <h2 className="text-sm font-semibold text-text">发布规划器</h2>
          <Badge variant="info">{RELEASES.length} 版本</Badge>
          <Badge variant="info">{RELEASES.filter(r => r.status === 'in_development').length} 开发中</Badge>
          <Badge variant="success">{RELEASES.filter(r => r.status === 'released').length} 已发布</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="add" variant="primary">新建发布</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'roadmap',  l: '路线图' },
            { k: 'detail',   l: `发布详情 (${activeRelease.items.length})` },
            { k: 'timeline', l: '时间线' },
            { k: 'risks',    l: '风险评估' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-72 border-r border-border bg-bg overflow-y-auto">
            {RELEASES.map(r => (
              <div key={r.id} onClick={() => { setActiveReleaseId(r.id); setTab('detail'); }}
                className={'px-3 py-2 border-b border-border-light cursor-pointer hover:bg-surface-high ' + (activeReleaseId === r.id ? 'bg-accent/10 border-l-2 border-l-accent' : '')}>
                <div className="flex items-center gap-1 mb-1">
                  <Badge variant="info">{r.version}</Badge>
                  <Badge variant={r.status === 'released' ? 'success' : r.status === 'in_development' ? 'info' : r.status === 'cancelled' ? 'danger' : 'warning'}>{r.status}</Badge>
                  {r.blockers > 0 && <Badge variant="danger">{r.blockers} 阻塞</Badge>}
                </div>
                <p className="text-[11px] font-semibold text-text">{r.codename}</p>
                <p className="text-[10px] text-text-secondary mt-0.5">{new Date(r.targetDate).toLocaleDateString()}</p>
                <div className="h-1 bg-bg rounded-full overflow-hidden mt-1.5">
                  <div className="h-full bg-accent" style={{ width: `${r.completion}%` }}></div>
                </div>
                <p className="text-[10px] text-text-secondary mt-0.5">{r.completion}% 完成 · {r.items.length} 项</p>
              </div>
            ))}
          </div>

          <div className="flex-1 overflow-auto p-3 space-y-3">
            {tab === 'roadmap' && (
              <div className="space-y-3">
                {RELEASES.map(r => (
                  <div key={r.id} className="bg-bg border border-border-light rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="info">{r.version}</Badge>
                      <h3 className="text-sm font-semibold text-text">{r.codename}</h3>
                      <Badge variant={r.status === 'released' ? 'success' : r.status === 'in_development' ? 'info' : r.status === 'cancelled' ? 'danger' : 'warning'}>{r.status}</Badge>
                      <span className="text-[10px] text-text-secondary ml-auto">发布: {new Date(r.targetDate).toLocaleDateString()}</span>
                    </div>
                    <p className="text-[11px] text-text-secondary mb-2">{r.description}</p>
                    <div className="grid grid-cols-6 gap-1.5">
                      {r.items.map(i => (
                        <div key={i.id} className="bg-surface-high rounded p-1.5 text-center">
                          <Badge variant={TYPE_COLOR[i.type]}>{TYPE_LABEL[i.type]}</Badge>
                          <p className="text-[10px] text-text mt-1 truncate">{i.title}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'detail' && activeRelease && (
              <>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant="info">{activeRelease.version}</Badge>
                    <h3 className="text-base font-semibold text-text">{activeRelease.codename}</h3>
                    <Badge variant={activeRelease.status === 'released' ? 'success' : activeRelease.status === 'in_development' ? 'info' : 'warning'}>{activeRelease.status}</Badge>
                    <Badge variant={RISK_COLOR[activeRelease.risk]}>风险: {activeRelease.risk}</Badge>
                  </div>
                  <p className="text-[11px] text-text-secondary mb-3">{activeRelease.description}</p>
                  <div className="grid grid-cols-5 gap-2 text-[11px]">
                    <div><p className="text-[10px] text-text-secondary">发布管理</p><p className="text-text">{activeRelease.releaseManager}</p></div>
                    <div><p className="text-[10px] text-text-secondary">目标日期</p><p className="text-text">{new Date(activeRelease.targetDate).toLocaleDateString()}</p></div>
                    <div><p className="text-[10px] text-text-secondary">完成度</p><p className="text-text font-mono">{activeRelease.completion}%</p></div>
                    <div><p className="text-[10px] text-text-secondary">阻塞项</p><p className="text-danger font-mono">{activeRelease.blockers}</p></div>
                    <div><p className="text-[10px] text-text-secondary">高风险</p><p className="text-warning font-mono">{totalRisk}</p></div>
                  </div>
                  <div className="mt-2 h-1.5 bg-surface-high rounded-full overflow-hidden">
                    <div className="h-full bg-accent" style={{ width: `${activeRelease.completion}%` }}></div>
                  </div>
                </div>

                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="text-xs font-semibold text-text">发布项</h3>
                    <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as any)} className="bg-bg border border-border-light rounded px-2 h-6 text-[10px] ml-auto">
                      <option value="all">所有类型</option>
                      {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    {filteredItems.map(i => (
                      <div key={i.id} className="bg-surface-high rounded p-2">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant={TYPE_COLOR[i.type]}>{TYPE_LABEL[i.type]}</Badge>
                          <Badge variant={STATUS_COLOR[i.status]}>{i.status}</Badge>
                          {i.risk !== 'low' && <Badge variant={RISK_COLOR[i.risk]}>{i.risk} 风险</Badge>}
                          <span className="text-[10px] text-text-secondary ml-auto">{i.team} · {i.owner}</span>
                        </div>
                        <p className="text-[11px] text-text">{i.title}</p>
                        <div className="flex items-center gap-2 mt-1.5">
                          <div className="flex-1 h-1.5 bg-bg rounded-full overflow-hidden">
                            <div className="h-full bg-accent" style={{ width: `${i.progress}%` }}></div>
                          </div>
                          <span className="text-[10px] text-text font-mono w-8 text-right">{i.progress}%</span>
                        </div>
                        {i.dependsOn && i.dependsOn.length > 0 && (
                          <p className="text-[10px] text-text-secondary mt-1">依赖: {i.dependsOn.join(', ')}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {tab === 'timeline' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">甘特图 (Gantt)</h3>
                <div className="overflow-x-auto">
                  <svg viewBox="0 0 800 320" className="w-full bg-surface-high rounded" style={{ minHeight: 320 }}>
                    {/* Date axis */}
                    {Array.from({ length: 21 }, (_, i) => (
                      <g key={i}>
                        <line x1={50 + i * 35} y1="0" x2={50 + i * 35} y2="320" stroke="rgba(255,255,255,0.05)" />
                        <text x={50 + i * 35} y="15" fontSize="9" fill="#9ca3af" textAnchor="middle">D-{20-i}</text>
                      </g>
                    ))}
                    {/* Items */}
                    {activeRelease.items.map((item, i) => {
                      const start = i * 0.5;
                      const dur = item.progress > 0 ? (item.progress / 100) * 14 : 0;
                      const y = 30 + i * 28;
                      const color = item.status === 'done' ? '#16a34a' : item.status === 'blocked' ? '#dc2626' : item.status === 'review' ? '#eab308' : '#a855f7';
                      return (
                        <g key={item.id}>
                          <text x="5" y={y + 4} fontSize="9" fill="#1f2937">{item.title.slice(0, 18)}</text>
                          <rect x={50 + start * 35} y={y - 5} width={Math.max(dur * 35, 4)} height="14" fill={color} fillOpacity="0.6" rx="2" />
                          {item.status === 'blocked' && <text x={50 + start * 35 + 5} y={y + 5} fontSize="8" fill="white">⚠</text>}
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>
            )}

            {tab === 'risks' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">风险评估</h3>
                <div className="space-y-1.5">
                  {activeRelease.items.filter(i => i.risk !== 'low').map(i => (
                    <div key={i.id} className="bg-surface-high rounded p-2">
                      <div className="flex items-center gap-2">
                        <Badge variant={RISK_COLOR[i.risk]}>{i.risk} 风险</Badge>
                        <span className="text-[11px] font-medium text-text">{i.title}</span>
                        <Badge variant="default">{TYPE_LABEL[i.type]}</Badge>
                        <span className="text-[10px] text-text-secondary ml-auto">{i.owner}</span>
                      </div>
                      <p className="text-[10px] text-text-secondary mt-1">
                        缓解措施: {i.risk === 'high' ? '需 2 人评审 + Tech Lead 审批' : '需资深工程师 review'}
                      </p>
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
