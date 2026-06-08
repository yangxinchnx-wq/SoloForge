// ─────────────────────────────────────────────────────────────────
// 知识库 — KnowledgeBase
// - 文档 CRUD 与版本控制
// - 全文搜索
// - 分类与标签
// - 协同编辑 (锁定/历史)
// - 关联引用
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type DocStatus = 'draft' | 'review' | 'published' | 'archived';

interface Doc {
  id: string;
  title: string;
  path: string;
  category: string;
  tags: string[];
  status: DocStatus;
  author: string;
  updated: number;
  size: number;
  views: number;
  versions: number;
  linked: number;
  excerpt: string;
}

interface DocVersion {
  id: string;
  v: string;
  author: string;
  created: number;
  change: string;
  size: number;
}

const DOCS: Doc[] = [
  { id: 'd1',  title: 'API 认证流程',          path: '/docs/auth/oauth-flow.md',         category: '认证', tags: ['oauth', 'jwt', 'security'],    status: 'published', author: 'Alice Chen',  updated: Date.now() - 86400000 * 1,  size: 12450, views: 1245, versions: 12, linked: 8,  excerpt: '本文介绍 SoloForge API 的 OAuth2 认证流程,包括授权码模式、PKCE、token 刷新等机制。' },
  { id: 'd2',  title: '数据库 Schema 设计',     path: '/docs/db/schema.md',                category: '数据库', tags: ['postgres', 'schema', 'design'], status: 'published', author: 'Bob Wang',    updated: Date.now() - 86400000 * 3,  size: 24500, views: 678,  versions: 5,  linked: 23, excerpt: 'PostgreSQL 12+ 的 schema 设计规范,涵盖命名、索引、约束、迁移等最佳实践。' },
  { id: 'd3',  title: '部署指南',             path: '/docs/ops/deployment.md',            category: '运维', tags: ['k8s', 'docker', 'ci-cd'],       status: 'published', author: 'Carol Liu',   updated: Date.now() - 86400000 * 5,  size: 18900, views: 892,  versions: 8,  linked: 15, excerpt: '通过 GitOps + ArgoCD 实现零停机部署,包含蓝绿发布、金丝雀、回滚策略。' },
  { id: 'd4',  title: '微服务架构',            path: '/docs/architecture/microservices.md', category: '架构', tags: ['microservices', 'ddd'],         status: 'published', author: 'David Zhang', updated: Date.now() - 86400000 * 7,  size: 32100, views: 1456, versions: 4,  linked: 31, excerpt: '领域驱动设计在 SoloForge 的实践,包括限界上下文、聚合根、事件风暴等内容。' },
  { id: 'd5',  title: '前端组件库',            path: '/docs/frontend/components.md',       category: '前端', tags: ['react', 'tailwind', 'ui'],      status: 'review',    author: 'Eve',         updated: Date.now() - 86400000 * 1,  size: 8700,  views: 234,  versions: 3,  linked: 5,  excerpt: 'SoloForge 内部使用的 80+ UI 组件,统一的设计语言、主题、a11y 标准。' },
  { id: 'd6',  title: '性能优化',             path: '/docs/perf/optimization.md',        category: '性能', tags: ['performance', 'caching'],     status: 'draft',     author: 'Frank',       updated: Date.now() - 3600000,         size: 4500,  views: 0,    versions: 1,  linked: 0,  excerpt: '从数据库到 CDN 的全链路性能优化,包含查询优化、缓存策略、懒加载等。' },
  { id: 'd7',  title: 'AI 模型管理',          path: '/docs/ai/model-registry.md',         category: 'AI', tags: ['ml', 'mlops', 'registry'],     status: 'published', author: 'Grace',       updated: Date.now() - 86400000 * 2,  size: 15600, views: 567,  versions: 6,  linked: 12, excerpt: '使用 MLflow 管理模型注册、版本、血缘、推理监控的完整工作流。' },
  { id: 'd8',  title: '事件溯源',             path: '/docs/architecture/event-sourcing.md', category: '架构', tags: ['event-sourcing', 'cqrs'],      status: 'archived',  author: 'David Zhang', updated: Date.now() - 86400000 * 30, size: 11200, views: 345,  versions: 2,  linked: 7,  excerpt: '事件溯源与 CQRS 架构在 SoloForge 治理链路中的应用(已废弃,迁移到新架构)。' },
  { id: 'd9',  title: '安全最佳实践',         path: '/docs/security/best-practices.md',    category: '安全', tags: ['security', 'owasp'],           status: 'published', author: 'Alice Chen',  updated: Date.now() - 86400000 * 4,  size: 9800,  views: 1023, versions: 7,  linked: 18, excerpt: 'OWASP Top 10 对照的实践清单,涵盖输入验证、XSS、CSRF、SQL 注入等。' },
  { id: 'd10', title: '故障排查手册',         path: '/docs/ops/troubleshooting.md',       category: '运维', tags: ['ops', 'runbook'],               status: 'published', author: 'Carol Liu',   updated: Date.now() - 86400000 * 1,  size: 22300, views: 2134, versions: 15, linked: 4,  excerpt: '常见故障的诊断流程和 Runbook,覆盖数据库、网络、应用层。' },
];

const VERSIONS: DocVersion[] = [
  { id: 'v1', v: 'v1.2.0', author: 'Alice Chen',  created: Date.now() - 86400000 * 1,  change: '新增 PKCE 流程图与示例',      size: 12450 },
  { id: 'v2', v: 'v1.1.0', author: 'Alice Chen',  created: Date.now() - 86400000 * 14, change: '修正 token 刷新过期逻辑',     size: 11200 },
  { id: 'v3', v: 'v1.0.0', author: 'Bob Wang',    created: Date.now() - 86400000 * 60, change: '初版',                       size: 9800 },
  { id: 'v4', v: 'v0.9.0', author: 'Alice Chen',  created: Date.now() - 86400000 * 90, change: '草稿',                       size: 5400 },
];

const CATEGORIES = ['全部', '认证', '数据库', '运维', '架构', '前端', '性能', 'AI', '安全'];

function statusVariant(s: DocStatus): 'success' | 'info' | 'warning' | 'default' {
  return s === 'published' ? 'success' : s === 'review' ? 'warning' : s === 'draft' ? 'info' : 'default';
}

export function KnowledgeBase({ open, onClose }: Props) {
  const [tab, setTab] = useState<'browse' | 'editor' | 'versions' | 'graph'>('browse');
  const [activeId, setActiveId] = useState<string>(DOCS[0].id);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState<string>('全部');
  const activeDoc = DOCS.find(d => d.id === activeId) || DOCS[0];

  const filtered = DOCS.filter(d => {
    if (categoryFilter !== '全部' && d.category !== categoryFilter) return false;
    if (searchQuery && !d.title.toLowerCase().includes(searchQuery.toLowerCase()) && !d.excerpt.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const totalViews = DOCS.reduce((s, d) => s + d.views, 0);
  const totalSize = DOCS.reduce((s, d) => s + d.size, 0);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">library_books</span>
          <h2 className="text-sm font-semibold text-text">知识库</h2>
          <Badge variant="info">{DOCS.length} 文档</Badge>
          <Badge variant="success">{DOCS.filter(d => d.status === 'published').length} 已发布</Badge>
          <Badge variant="info">{totalViews.toLocaleString()} 浏览</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="add" variant="primary">新建文档</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'browse',   l: '浏览' },
            { k: 'editor',   l: '编辑器' },
            { k: 'versions', l: '版本历史' },
            { k: 'graph',    l: '关联图' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-72 border-r border-border bg-bg overflow-y-auto">
            <div className="px-3 py-2 border-b border-border-light space-y-1.5">
              <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="搜索标题或内容..." className="w-full bg-bg border border-border-light rounded px-2 h-6 text-[10px]" />
              <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="w-full bg-bg border border-border-light rounded px-2 h-6 text-[10px]">
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {filtered.map(d => (
              <div key={d.id} onClick={() => { setActiveId(d.id); setTab('editor'); }}
                className={'px-3 py-2 border-b border-border-light cursor-pointer hover:bg-surface-high ' + (activeId === d.id ? 'bg-accent/10 border-l-2 border-l-accent' : '')}>
                <div className="flex items-center gap-1 mb-1">
                  <Badge variant="default">{d.category}</Badge>
                  <Badge variant={statusVariant(d.status)}>{d.status}</Badge>
                </div>
                <p className="text-[11px] font-medium text-text">{d.title}</p>
                <p className="text-[10px] text-text-secondary mt-0.5 line-clamp-2">{d.excerpt}</p>
                <div className="text-[10px] text-text-secondary mt-1 flex items-center gap-2">
                  <span>👁 {d.views}</span>
                  <span>v{d.versions}</span>
                  <span className="ml-auto">{new Date(d.updated).toLocaleDateString()}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="flex-1 overflow-auto p-3 space-y-3">
            {tab === 'browse' && (
              <>
                <div className="grid grid-cols-4 gap-3">
                  {CATEGORIES.slice(1).map(cat => {
                    const catDocs = DOCS.filter(d => d.category === cat);
                    return (
                      <div key={cat} onClick={() => setCategoryFilter(cat)} className="bg-bg border border-border-light rounded-lg p-3 cursor-pointer hover:border-accent">
                        <p className="text-[10px] text-text-secondary">{cat}</p>
                        <p className="text-2xl font-bold text-text font-mono mt-1">{catDocs.length}</p>
                        <p className="text-[10px] text-text-secondary">{(catDocs.reduce((s, d) => s + d.views, 0)).toLocaleString()} 浏览</p>
                      </div>
                    );
                  })}
                </div>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">最近更新</h3>
                  <div className="space-y-1.5">
                    {DOCS.slice().sort((a, b) => b.updated - a.updated).slice(0, 5).map(d => (
                      <div key={d.id} onClick={() => { setActiveId(d.id); setTab('editor'); }} className="bg-surface-high rounded p-2 cursor-pointer hover:border-accent border border-transparent">
                        <div className="flex items-center gap-2">
                          <Badge variant="default">{d.category}</Badge>
                          <span className="text-[11px] text-text font-medium">{d.title}</span>
                          <span className="text-[10px] text-text-secondary ml-auto">{new Date(d.updated).toLocaleString()}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {tab === 'editor' && (
              <>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant="default">{activeDoc.category}</Badge>
                    <Badge variant={statusVariant(activeDoc.status)}>{activeDoc.status}</Badge>
                    <code className="text-[10px] font-mono text-text-secondary ml-2">{activeDoc.path}</code>
                  </div>
                  <h3 className="text-lg font-semibold text-text mb-1">{activeDoc.title}</h3>
                  <div className="flex flex-wrap gap-1 mb-3">
                    {activeDoc.tags.map(t => <Badge key={t} variant="default">{t}</Badge>)}
                  </div>
                  <div className="grid grid-cols-4 gap-3 text-[11px]">
                    <div><p className="text-[10px] text-text-secondary">作者</p><p className="text-text">{activeDoc.author}</p></div>
                    <div><p className="text-[10px] text-text-secondary">大小</p><p className="text-text font-mono">{(activeDoc.size / 1024).toFixed(1)} KB</p></div>
                    <div><p className="text-[10px] text-text-secondary">浏览</p><p className="text-text font-mono">{activeDoc.views.toLocaleString()}</p></div>
                    <div><p className="text-[10px] text-text-secondary">引用</p><p className="text-text font-mono">{activeDoc.linked}</p></div>
                  </div>
                </div>

                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">内容预览</h3>
                  <div className="bg-surface-high border border-border-light rounded p-3 text-[11px] text-text leading-relaxed font-mono whitespace-pre-wrap">
{`# ${activeDoc.title}

> 状态: ${activeDoc.status} | 作者: ${activeDoc.author} | 更新: ${new Date(activeDoc.updated).toLocaleDateString()}

## 概述

${activeDoc.excerpt}

## 目录

1. 背景与目标
2. 架构设计
3. 实现细节
4. 部署与运维
5. 故障排查

## 1. 背景与目标

在 SoloForge 系统中,我们需要一个统一的...

## 2. 架构设计

整个系统由以下几个核心组件构成:
- API Gateway
- Auth Service
- Database Cluster
- Cache Layer

## 3. 实现细节

### 3.1 Token 生成

\`\`\`typescript
async function generateToken(user: User): Promise<string> {
  const payload = { sub: user.id, roles: user.roles };
  return await jwt.sign(payload, SECRET, { expiresIn: '1h' });
}
\`\`\`

### 3.2 验证流程

每条请求都会经过以下步骤:
1. 提取 Authorization header
2. 验证签名
3. 检查过期时间
4. 加载用户上下文

## 4. 部署与运维

参考 [部署指南](/docs/ops/deployment.md)。

## 5. 故障排查

| 错误码 | 含义 | 解决方案 |
|--------|------|----------|
| 401    | 未认证 | 重新登录 |
| 403    | 无权限 | 联系管理员 |
| 429    | 限流 | 稍后重试 |
`}
                  </div>
                </div>
              </>
            )}

            {tab === 'versions' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">版本历史: {activeDoc.title}</h3>
                <div className="space-y-1.5">
                  {VERSIONS.map(v => (
                    <div key={v.id} className="bg-surface-high rounded p-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="info">{v.v}</Badge>
                        <span className="text-[11px] text-text">{v.change}</span>
                        <span className="text-[10px] text-text-secondary ml-auto">{v.author}</span>
                      </div>
                      <div className="text-[10px] text-text-secondary mt-1 flex items-center gap-2">
                        <span>{new Date(v.created).toLocaleString()}</span>
                        <span>·</span>
                        <span>{(v.size / 1024).toFixed(1)} KB</span>
                        <span className="ml-auto flex gap-1">
                          <Button size="sm" icon="visibility">查看</Button>
                          <Button size="sm" icon="restore">恢复</Button>
                          <Button size="sm" icon="compare">对比</Button>
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === 'graph' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-3">文档关联图</h3>
                <svg viewBox="0 0 800 400" className="w-full bg-surface-high rounded" style={{ minHeight: 400 }}>
                  {[
                    { x: 400, y: 50,  label: 'API 认证流程',     r: 50, color: '#a855f7' },
                    { x: 200, y: 150, label: '安全最佳实践',     r: 40, color: '#dc2626' },
                    { x: 600, y: 150, label: '部署指南',         r: 40, color: '#3b82f6' },
                    { x: 100, y: 280, label: '微服务架构',       r: 45, color: '#16a34a' },
                    { x: 300, y: 300, label: '数据库 Schema',     r: 35, color: '#eab308' },
                    { x: 500, y: 300, label: 'AI 模型管理',       r: 35, color: '#ec4899' },
                    { x: 700, y: 280, label: '故障排查手册',     r: 30, color: '#9ca3af' },
                  ].map((n, i) => {
                    const isCenter = i === 0;
                    return (
                      <g key={i}>
                        <circle cx={n.x} cy={n.y} r={n.r} fill={n.color} fillOpacity="0.2" stroke={n.color} strokeWidth="2" />
                        <text x={n.x} y={n.y} fontSize="10" fill="#1f2937" textAnchor="middle" fontWeight={isCenter ? '700' : '500'}>{n.label}</text>
                      </g>
                    );
                  })}
                  {/* Connections */}
                  <line x1="400" y1="50"  x2="200" y2="150" stroke="#9ca3af" strokeWidth="1.5" />
                  <line x1="400" y1="50"  x2="600" y2="150" stroke="#9ca3af" strokeWidth="1.5" />
                  <line x1="200" y1="150" x2="100" y2="280" stroke="#9ca3af" strokeWidth="1.5" />
                  <line x1="200" y1="150" x2="300" y2="300" stroke="#9ca3af" strokeWidth="1.5" />
                  <line x1="600" y1="150" x2="500" y2="300" stroke="#9ca3af" strokeWidth="1.5" />
                  <line x1="600" y1="150" x2="700" y2="280" stroke="#9ca3af" strokeWidth="1.5" />
                  <line x1="100" y1="280" x2="300" y2="300" stroke="#9ca3af" strokeWidth="1" strokeDasharray="2 4" />
                  <line x1="500" y1="300" x2="700" y2="280" stroke="#9ca3af" strokeWidth="1" strokeDasharray="2 4" />
                </svg>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
