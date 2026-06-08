// ─────────────────────────────────────────────────────────────────
// 嵌入向量浏览器 — EmbeddingExplorer
// - 向量可视化 (PCA / t-SNE / UMAP 投影)
// - 语义搜索
// - 相似度矩阵与最近邻
// - 聚类分析
// - 模型对比
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type EmbeddingModel = 'text-embedding-3-small' | 'text-embedding-3-large' | 'voyage-large-2' | 'bge-large-en' | 'cohere-embed-v3';
type Cluster = '技术' | '业务' | '设计' | '运营' | '法律' | '其他';

interface VectorPoint {
  id: string;
  text: string;
  x: number;       // 投影坐标
  y: number;
  cluster: Cluster;
  source: 'doc' | 'code' | 'chat' | 'ticket';
  distance?: number;
}

interface SearchResult {
  point: VectorPoint;
  similarity: number;
}

const EMBEDDING_MODELS: Record<EmbeddingModel, { dim: number; cost: number; speed: string }> = {
  'text-embedding-3-small': { dim: 1536, cost: 0.00000002, speed: '快' },
  'text-embedding-3-large': { dim: 3072, cost: 0.00000013, speed: '中' },
  'voyage-large-2':         { dim: 1536, cost: 0.00000012, speed: '中' },
  'bge-large-en':           { dim: 1024, cost: 0,           speed: '快 (本地)' },
  'cohere-embed-v3':        { dim: 1024, cost: 0.00000010, speed: '快' },
};

const POINTS: VectorPoint[] = [
  { id: 'p1',  text: '如何实现用户认证?',                 x: 120, y: 80,  cluster: '技术', source: 'chat' },
  { id: 'p2',  text: 'JWT token 的最佳实践',              x: 140, y: 100, cluster: '技术', source: 'doc' },
  { id: 'p3',  text: 'OAuth2 流程图',                      x: 100, y: 130, cluster: '技术', source: 'doc' },
  { id: 'p4',  text: '产品定价策略',                       x: 380, y: 200, cluster: '业务', source: 'doc' },
  { id: 'p5',  text: 'Q4 销售目标',                        x: 420, y: 230, cluster: '业务', source: 'ticket' },
  { id: 'p6',  text: '客户细分方法',                       x: 360, y: 250, cluster: '业务', source: 'doc' },
  { id: 'p7',  text: 'UI 设计规范',                        x: 250, y: 320, cluster: '设计', source: 'doc' },
  { id: 'p8',  text: '色彩心理学',                         x: 220, y: 350, cluster: '设计', source: 'doc' },
  { id: 'p9',  text: '用户旅程地图',                       x: 280, y: 380, cluster: '设计', source: 'doc' },
  { id: 'p10', text: '用户增长指标',                       x: 500, y: 100, cluster: '运营', source: 'doc' },
  { id: 'p11', text: 'A/B 测试结果分析',                   x: 530, y: 130, cluster: '运营', source: 'ticket' },
  { id: 'p12', text: '留存率优化',                         x: 480, y: 160, cluster: '运营', source: 'doc' },
  { id: 'p13', text: 'GDPR 合规要求',                      x: 80,  y: 380, cluster: '法律', source: 'doc' },
  { id: 'p14', text: '数据保护协议',                       x: 120, y: 420, cluster: '法律', source: 'doc' },
  { id: 'p15', text: '微服务架构演进',                     x: 200, y: 60,  cluster: '技术', source: 'code' },
  { id: 'p16', text: '数据库索引优化',                     x: 180, y: 180, cluster: '技术', source: 'code' },
  { id: 'p17', text: '品牌故事撰写',                       x: 320, y: 420, cluster: '设计', source: 'doc' },
  { id: 'p18', text: '竞品分析报告',                       x: 580, y: 280, cluster: '业务', source: 'doc' },
];

const CLUSTERS: Cluster[] = ['技术', '业务', '设计', '运营', '法律', '其他'];
const CLUSTER_COLOR: Record<Cluster, string> = {
  '技术': '#3b82f6', '业务': '#a855f7', '设计': '#ec4899',
  '运营': '#10b981', '法律': '#eab308', '其他': '#9ca3af'
};

function cosineSim(a: VectorPoint, b: VectorPoint): number {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.max(0, 1 - Math.sqrt(dx*dx + dy*dy) / 500);
}

export function EmbeddingExplorer({ open, onClose }: Props) {
  const [tab, setTab] = useState<'scatter' | 'search' | 'clusters' | 'model'>('scatter');
  const [model, setModel] = useState<EmbeddingModel>('text-embedding-3-large');
  const [query, setQuery] = useState<string>('用户认证');
  const [activeCluster, setActiveCluster] = useState<Cluster | 'all'>('all');
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const searchResults = useMemo<SearchResult[]>(() => {
    const fakeQ: VectorPoint = { id: 'q', text: query, x: 110, y: 90, cluster: '技术', source: 'chat' };
    return POINTS.map(p => ({ point: p, similarity: cosineSim(fakeQ, p) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 8);
  }, [query]);

  const filtered = activeCluster === 'all' ? POINTS : POINTS.filter(p => p.cluster === activeCluster);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">scatter_plot</span>
          <h2 className="text-sm font-semibold text-text">嵌入向量浏览器</h2>
          <Badge variant="info">{POINTS.length} 向量</Badge>
          <Badge variant="success">{CLUSTERS.length} 聚类</Badge>
          <select value={model} onChange={(e) => setModel(e.target.value as EmbeddingModel)} className="bg-bg border border-border-light rounded px-2 h-7 text-[10px]">
            {Object.entries(EMBEDDING_MODELS).map(([k, v]) => <option key={k} value={k}>{k} ({v.dim}d)</option>)}
          </select>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="add">添加文本</Button>
            <Button size="sm" icon="download">导出</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'scatter',  l: '散点图' },
            { k: 'search',   l: '语义搜索' },
            { k: 'clusters', l: '聚类分析' },
            { k: 'model',    l: '模型对比' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-56 border-r border-border bg-bg overflow-y-auto p-2">
            <p className="text-[10px] text-text-secondary px-1 mb-1">聚类筛选</p>
            <div onClick={() => setActiveCluster('all')}
              className={'p-1.5 rounded cursor-pointer mb-0.5 ' + (activeCluster === 'all' ? 'bg-accent/15' : 'hover:bg-surface-high')}>
              <span className="text-[11px] text-text">全部 ({POINTS.length})</span>
            </div>
            {CLUSTERS.map(c => {
              const count = POINTS.filter(p => p.cluster === c).length;
              return (
                <div key={c} onClick={() => setActiveCluster(c)}
                  className={'p-1.5 rounded cursor-pointer mb-0.5 flex items-center gap-1 ' + (activeCluster === c ? 'bg-accent/15' : 'hover:bg-surface-high')}>
                  <span className="w-2 h-2 rounded-full" style={{ background: CLUSTER_COLOR[c] }}></span>
                  <span className="text-[11px] text-text flex-1">{c}</span>
                  <span className="text-[10px] text-text-secondary">{count}</span>
                </div>
              );
            })}
          </div>

          <div className="flex-1 overflow-auto p-3 space-y-3">
            {(tab === 'scatter' || tab === 'search') && (
              <>
                {tab === 'search' && (
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h3 className="text-xs font-semibold text-text mb-2">语义搜索</h3>
                    <div className="flex gap-2">
                      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="输入查询文本..." className="flex-1 bg-surface-high border border-border-light rounded px-3 h-8 text-[11px]" />
                      <Button size="sm" icon="search" variant="primary">搜索</Button>
                    </div>
                  </div>
                )}

                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">{tab === 'search' ? '查询 + 最近邻' : '向量投影 (t-SNE)'}</h3>
                  <svg viewBox="0 0 700 500" className="w-full bg-surface-high rounded" style={{ minHeight: 480 }}>
                    {/* Grid */}
                    {Array.from({ length: 7 }, (_, i) => (
                      <line key={`v${i}`} x1={i * 100} y1="0" x2={i * 100} y2="500" stroke="rgba(255,255,255,0.05)" />
                    ))}
                    {Array.from({ length: 5 }, (_, i) => (
                      <line key={`h${i}`} x1="0" y1={i * 100} x2="700" y2={i * 100} stroke="rgba(255,255,255,0.05)" />
                    ))}

                    {tab === 'search' && searchResults.length > 0 && searchResults[0].similarity > 0.7 && (
                      <line x1="110" y1="90" x2={searchResults[0].point.x} y2={searchResults[0].point.y} stroke="#fbbf24" strokeWidth="2" strokeDasharray="3 3" />
                    )}

                    {tab === 'search' && (
                      <g>
                        <circle cx="110" cy="90" r="12" fill="#fbbf24" stroke="white" strokeWidth="2" />
                        <text x="110" y="94" fontSize="9" fill="black" textAnchor="middle" fontWeight="700">Q</text>
                        <text x="110" y="115" fontSize="8" fill="white" textAnchor="middle">{query}</text>
                      </g>
                    )}

                    {filtered.map(p => {
                      const isHover = hoveredId === p.id;
                      const isTopResult = tab === 'search' && searchResults[0]?.point.id === p.id;
                      return (
                        <g key={p.id} onMouseEnter={() => setHoveredId(p.id)} onMouseLeave={() => setHoveredId(null)} style={{ cursor: 'pointer' }}>
                          <circle cx={p.x} cy={p.y} r={isHover || isTopResult ? 8 : 5}
                            fill={CLUSTER_COLOR[p.cluster]} opacity={isHover || isTopResult ? 1 : 0.7}
                            stroke={isHover || isTopResult ? 'white' : 'none'} strokeWidth="2" />
                          {(isHover || isTopResult) && (
                            <g>
                              <rect x={p.x + 10} y={p.y - 14} width="180" height="28" rx="3" fill="rgba(0,0,0,0.8)" />
                              <text x={p.x + 16} y={p.y - 2} fontSize="9" fill="white">{p.text}</text>
                              <text x={p.x + 16} y={p.y + 9} fontSize="8" fill="#9ca3af">{p.cluster} · {p.source}</text>
                            </g>
                          )}
                        </g>
                      );
                    })}
                  </svg>
                </div>

                {tab === 'search' && (
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h3 className="text-xs font-semibold text-text mb-2">搜索结果 (按相似度)</h3>
                    <div className="space-y-1.5">
                      {searchResults.map((r, i) => (
                        <div key={r.point.id} className="flex items-center gap-2 p-2 bg-surface-high rounded">
                          <span className="text-[10px] text-text-secondary w-6 text-right">#{i + 1}</span>
                          <Badge variant="info">{r.point.cluster}</Badge>
                          <span className="text-[11px] text-text flex-1">{r.point.text}</span>
                          <div className="w-24 h-1.5 bg-bg rounded-full overflow-hidden">
                            <div className="h-full bg-success" style={{ width: `${r.similarity * 100}%` }}></div>
                          </div>
                          <span className="text-[10px] text-text font-mono w-12 text-right">{(r.similarity * 100).toFixed(1)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {tab === 'clusters' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">聚类分析</h3>
                <div className="grid grid-cols-2 gap-2">
                  {CLUSTERS.map(c => {
                    const clusterPoints = POINTS.filter(p => p.cluster === c);
                    if (clusterPoints.length === 0) return null;
                    const cx = clusterPoints.reduce((s, p) => s + p.x, 0) / clusterPoints.length;
                    const cy = clusterPoints.reduce((s, p) => s + p.y, 0) / clusterPoints.length;
                    return (
                      <div key={c} className="bg-surface-high rounded p-2">
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <span className="w-3 h-3 rounded-full" style={{ background: CLUSTER_COLOR[c] }}></span>
                          <span className="text-[11px] font-semibold text-text">{c}</span>
                          <span className="text-[10px] text-text-secondary ml-auto">{clusterPoints.length} 点</span>
                        </div>
                        <p className="text-[10px] text-text-secondary">中心: ({cx.toFixed(0)}, {cy.toFixed(0)})</p>
                        <p className="text-[10px] text-text-secondary">代表词: {clusterPoints[0]?.text.slice(0, 12)}...</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {tab === 'model' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">嵌入模型对比</h3>
                <table className="w-full text-[11px]">
                  <thead className="text-text-secondary border-b border-border-light">
                    <tr>
                      <th className="text-left py-1.5">模型</th>
                      <th className="text-right py-1.5">维度</th>
                      <th className="text-right py-1.5">$/1k tokens</th>
                      <th className="text-right py-1.5">速度</th>
                      <th className="text-right py-1.5">MTEB 评分</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(EMBEDDING_MODELS).map(([k, v]) => (
                      <tr key={k} className="border-b border-border-light">
                        <td className="py-1.5"><code className="text-[10px] font-mono text-text">{k}</code></td>
                        <td className="py-1.5 text-right text-text font-mono">{v.dim}</td>
                        <td className="py-1.5 text-right text-text font-mono">${(v.cost * 1000).toFixed(4)}</td>
                        <td className="py-1.5 text-right"><Badge variant="info">{v.speed}</Badge></td>
                        <td className="py-1.5 text-right text-text font-mono">{(60 + Math.random() * 8).toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
