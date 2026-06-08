// ─────────────────────────────────────────────────────────────────
// 特征实验看板 — ExperimentBoard
// - A/B 测试 / 多臂老虎机 / Feature Flag
// - 实验设计与分流
// - 指标追踪与显著性检验
// - 用户分群
// - 实验归档
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type ExperimentStatus = 'draft' | 'running' | 'paused' | 'completed' | 'abandoned';
type ExperimentType = 'ab_test' | 'multivariate' | 'feature_flag' | 'bandit' | 'holdout';

interface Experiment {
  id: string;
  name: string;
  hypothesis: string;
  status: ExperimentStatus;
  type: ExperimentType;
  owner: string;
  startDate: number;
  endDate?: number;
  variants: Variant[];
  primaryMetric: string;
  secondaryMetrics: string[];
  sampleSize: number;
  currentSample: number;
  confidence: number;       // 0-100
  lift: number;              // % improvement
  pValue: number;
  segments: string[];
}

interface Variant {
  id: string;
  name: string;
  weight: number;            // 0-100
  users: number;
  conversions: number;
  conversionRate: number;
  revenue: number;
  isControl: boolean;
}

const EXPERIMENTS: Experiment[] = [
  {
    id: 'e1', name: '新注册流程 vs 旧流程',
    hypothesis: '简化注册流程(2 步 → 1 步)将提升注册转化率 ≥10%',
    status: 'running', type: 'ab_test', owner: 'Alice Chen',
    startDate: Date.now() - 86400000 * 7,
    variants: [
      { id: 'v1', name: 'Control (2 步)',  weight: 50, users: 12450, conversions: 1245, conversionRate: 10.0, revenue: 0,    isControl: true },
      { id: 'v2', name: 'Treatment (1 步)', weight: 50, users: 12380, conversions: 1485, conversionRate: 12.0, revenue: 0,    isControl: false },
    ],
    primaryMetric: '注册转化率', secondaryMetrics: ['完成时间', '放弃率', '7 日留存'],
    sampleSize: 30000, currentSample: 24830, confidence: 96.8, lift: 20.0, pValue: 0.032,
    segments: ['移动端', '新用户', '所有地区'],
  },
  {
    id: 'e2', name: '推荐算法 v2',
    hypothesis: '基于 LLM 的推荐将提升 CTR ≥15%',
    status: 'running', type: 'ab_test', owner: 'Bob Wang',
    startDate: Date.now() - 86400000 * 14,
    variants: [
      { id: 'v1', name: '协同过滤',     weight: 33, users: 45230, conversions: 4523, conversionRate: 10.0, revenue: 67890, isControl: true },
      { id: 'v2', name: 'LLM 推荐',     weight: 33, users: 45010, conversions: 5851, conversionRate: 13.0, revenue: 87765, isControl: false },
      { id: 'v3', name: '混合 (协同+LLM)', weight: 34, users: 45380, conversions: 6353, conversionRate: 14.0, revenue: 95298, isControl: false },
    ],
    primaryMetric: 'CTR', secondaryMetrics: ['GMV', '用户停留时长', '多样性'],
    sampleSize: 150000, currentSample: 135620, confidence: 99.2, lift: 30.0, pValue: 0.008,
    segments: ['活跃用户', '有购买历史'],
  },
  {
    id: 'e3', name: '深色模式默认开启',
    hypothesis: '深色模式默认开启将提升移动端用户满意度',
    status: 'paused', type: 'feature_flag', owner: 'Carol Liu',
    startDate: Date.now() - 86400000 * 3,
    variants: [
      { id: 'v1', name: 'OFF', weight: 50, users: 5230, conversions: 0, conversionRate: 0, revenue: 0, isControl: true },
      { id: 'v2', name: 'ON',  weight: 50, users: 5180, conversions: 0, conversionRate: 0, revenue: 0, isControl: false },
    ],
    primaryMetric: 'NPS', secondaryMetrics: ['页面停留时间', '回访率'],
    sampleSize: 20000, currentSample: 10410, confidence: 0, lift: 0, pValue: 1,
    segments: ['移动端-iOS'],
  },
  {
    id: 'e4', name: '定价页 CTA 颜色',
    hypothesis: '橙色 CTA 按钮比蓝色点击率高 5%',
    status: 'completed', type: 'ab_test', owner: 'David Zhang',
    startDate: Date.now() - 86400000 * 30,
    endDate:   Date.now() - 86400000 * 16,
    variants: [
      { id: 'v1', name: '蓝色 (原)', weight: 50, users: 28450, conversions: 1422, conversionRate: 5.0, revenue: 426600, isControl: true },
      { id: 'v2', name: '橙色',      weight: 50, users: 28380, conversions: 1561, conversionRate: 5.5, revenue: 468300, isControl: false },
    ],
    primaryMetric: 'CTA 点击率', secondaryMetrics: ['GMV', '跳出率'],
    sampleSize: 50000, currentSample: 56830, confidence: 92.3, lift: 10.0, pValue: 0.077,
    segments: ['桌面端', '美国'],
  },
  {
    id: 'e5', name: '首页 Hero 视频',
    hypothesis: '视频背景 Hero 提升品牌感知',
    status: 'draft', type: 'multivariate', owner: 'Eve',
    startDate: 0,
    variants: [
      { id: 'v1', name: '图片',  weight: 25, users: 0, conversions: 0, conversionRate: 0, revenue: 0, isControl: true },
      { id: 'v2', name: '视频',  weight: 25, users: 0, conversions: 0, conversionRate: 0, revenue: 0, isControl: false },
      { id: 'v3', name: '动画',  weight: 25, users: 0, conversions: 0, conversionRate: 0, revenue: 0, isControl: false },
      { id: 'v4', name: '无图',  weight: 25, users: 0, conversions: 0, conversionRate: 0, revenue: 0, isControl: false },
    ],
    primaryMetric: '滚动深度', secondaryMetrics: ['停留时间', '注册率'],
    sampleSize: 20000, currentSample: 0, confidence: 0, lift: 0, pValue: 1,
    segments: ['新访客'],
  },
];

const TYPE_LABEL: Record<ExperimentType, string> = {
  ab_test: 'A/B Test', multivariate: '多变量', feature_flag: 'Feature Flag', bandit: '多臂老虎机', holdout: '保留对照',
};

function statusVariant(s: ExperimentStatus): 'success' | 'info' | 'warning' | 'default' | 'danger' {
  return s === 'running' ? 'info' : s === 'completed' ? 'success' : s === 'paused' ? 'warning' : s === 'abandoned' ? 'danger' : 'default';
}

export function ExperimentBoard({ open, onClose }: Props) {
  const [tab, setTab] = useState<'board' | 'detail' | 'segments' | 'history'>('board');
  const [activeExpId, setActiveExpId] = useState<string>(EXPERIMENTS[0].id);
  const [statusFilter, setStatusFilter] = useState<ExperimentStatus | 'all'>('all');
  const activeExp = EXPERIMENTS.find(e => e.id === activeExpId) || EXPERIMENTS[0];

  const filtered = statusFilter === 'all' ? EXPERIMENTS : EXPERIMENTS.filter(e => e.status === statusFilter);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">science</span>
          <h2 className="text-sm font-semibold text-text">特征实验看板</h2>
          <Badge variant="info">{EXPERIMENTS.length} 实验</Badge>
          <Badge variant="info">{EXPERIMENTS.filter(e => e.status === 'running').length} 运行中</Badge>
          <Badge variant="success">{EXPERIMENTS.filter(e => e.status === 'completed').length} 完成</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="add" variant="primary">新建实验</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'board',    l: '看板' },
            { k: 'detail',   l: '实验详情' },
            { k: 'segments', l: '用户分群' },
            { k: 'history',  l: '历史归档' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-72 border-r border-border bg-bg overflow-y-auto">
            <div className="px-3 py-2 border-b border-border-light">
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)} className="w-full bg-bg border border-border-light rounded px-2 h-6 text-[10px]">
                <option value="all">所有状态</option>
                <option value="draft">草稿</option>
                <option value="running">运行中</option>
                <option value="paused">暂停</option>
                <option value="completed">完成</option>
                <option value="abandoned">废弃</option>
              </select>
            </div>
            {filtered.map(exp => (
              <div key={exp.id} onClick={() => { setActiveExpId(exp.id); setTab('detail'); }}
                className={'px-3 py-2 border-b border-border-light cursor-pointer hover:bg-surface-high ' + (activeExpId === exp.id ? 'bg-accent/10 border-l-2 border-l-accent' : '')}>
                <div className="flex items-center gap-1 mb-1">
                  <Badge variant="info">{TYPE_LABEL[exp.type]}</Badge>
                  <Badge variant={statusVariant(exp.status)}>{exp.status}</Badge>
                </div>
                <div className="text-[11px] font-medium text-text">{exp.name}</div>
                <div className="text-[10px] text-text-secondary mt-0.5">
                  {exp.status === 'running' && `${exp.currentSample.toLocaleString()} 样本 · ${exp.confidence}% 置信度`}
                  {exp.status === 'completed' && `Lift ${exp.lift}% · p=${exp.pValue}`}
                  {exp.status === 'draft' && '未开始'}
                </div>
              </div>
            ))}
          </div>

          <div className="flex-1 overflow-auto p-3 space-y-3">
            {tab === 'board' && (
              <div className="grid grid-cols-2 gap-3">
                {EXPERIMENTS.map(exp => (
                  <div key={exp.id} onClick={() => { setActiveExpId(exp.id); setTab('detail'); }} className="bg-bg border border-border-light rounded-lg p-3 cursor-pointer hover:border-accent">
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="info">{TYPE_LABEL[exp.type]}</Badge>
                      <Badge variant={statusVariant(exp.status)}>{exp.status}</Badge>
                      <span className="text-[10px] text-text-secondary ml-auto">{exp.owner}</span>
                    </div>
                    <h3 className="text-sm font-semibold text-text mb-1">{exp.name}</h3>
                    <p className="text-[10px] text-text-secondary mb-2">{exp.hypothesis}</p>
                    {exp.status === 'running' && (
                      <div className="space-y-1.5">
                        <div>
                          <div className="flex items-center justify-between text-[10px]">
                            <span className="text-text-secondary">样本量</span>
                            <span className="text-text font-mono">{exp.currentSample.toLocaleString()} / {exp.sampleSize.toLocaleString()}</span>
                          </div>
                          <div className="h-1.5 bg-surface-high rounded-full overflow-hidden mt-0.5">
                            <div className="h-full bg-accent" style={{ width: `${(exp.currentSample / exp.sampleSize) * 100}%` }}></div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 text-[11px]">
                          <div>
                            <span className="text-text-secondary">Lift</span> <span className="text-text font-mono font-semibold">{exp.lift > 0 ? '+' : ''}{exp.lift}%</span>
                          </div>
                          <div>
                            <span className="text-text-secondary">置信度</span> <span className="text-text font-mono font-semibold">{exp.confidence}%</span>
                          </div>
                          <div>
                            <span className="text-text-secondary">p-value</span> <span className="text-text font-mono font-semibold">{exp.pValue}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {tab === 'detail' && activeExp && (
              <>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant="info">{TYPE_LABEL[activeExp.type]}</Badge>
                    <Badge variant={statusVariant(activeExp.status)}>{activeExp.status}</Badge>
                    <span className="text-[10px] text-text-secondary ml-auto">{activeExp.owner}</span>
                  </div>
                  <h3 className="text-base font-semibold text-text mb-1">{activeExp.name}</h3>
                  <p className="text-[11px] text-text-secondary italic mb-3">"{activeExp.hypothesis}"</p>
                  <div className="grid grid-cols-4 gap-2 text-[11px]">
                    <div><span className="text-text-secondary block">主指标</span><Badge variant="info">{activeExp.primaryMetric}</Badge></div>
                    <div><span className="text-text-secondary block">开始</span><span className="text-text">{new Date(activeExp.startDate).toLocaleDateString()}</span></div>
                    <div><span className="text-text-secondary block">样本量</span><span className="text-text font-mono">{activeExp.currentSample.toLocaleString()}</span></div>
                    <div><span className="text-text-secondary block">置信度</span><span className="text-text font-mono">{activeExp.confidence}%</span></div>
                  </div>
                </div>

                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">变体结果</h3>
                  <table className="w-full text-[11px]">
                    <thead className="text-text-secondary border-b border-border-light">
                      <tr>
                        <th className="text-left py-1.5">变体</th>
                        <th className="text-right py-1.5">权重</th>
                        <th className="text-right py-1.5">用户数</th>
                        <th className="text-right py-1.5">转化</th>
                        <th className="text-right py-1.5">转化率</th>
                        <th className="text-right py-1.5">95% CI</th>
                        <th className="text-right py-1.5">Lift vs Ctrl</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeExp.variants.map(v => {
                        const ctrl = activeExp.variants.find(x => x.isControl);
                        const lift = ctrl && !v.isControl ? ((v.conversionRate - ctrl.conversionRate) / ctrl.conversionRate) * 100 : 0;
                        const se = Math.sqrt(v.conversionRate * (100 - v.conversionRate) / Math.max(v.users, 1)) * 1.96;
                        return (
                          <tr key={v.id} className="border-b border-border-light">
                            <td className="py-1.5 text-text">
                              {v.name}
                              {v.isControl && <Badge variant="default">对照</Badge>}
                            </td>
                            <td className="py-1.5 text-right text-text font-mono">{v.weight}%</td>
                            <td className="py-1.5 text-right text-text font-mono">{v.users.toLocaleString()}</td>
                            <td className="py-1.5 text-right text-text font-mono">{v.conversions.toLocaleString()}</td>
                            <td className="py-1.5 text-right text-text font-mono">{v.conversionRate.toFixed(2)}%</td>
                            <td className="py-1.5 text-right text-text-secondary font-mono">±{se.toFixed(2)}%</td>
                            <td className="py-1.5 text-right">
                              {v.isControl ? <span className="text-text-secondary">-</span> :
                                <span className={'font-mono font-semibold ' + (lift > 0 ? 'text-success' : 'text-danger')}>
                                  {lift > 0 ? '+' : ''}{lift.toFixed(1)}%
                                </span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h3 className="text-xs font-semibold text-text mb-2">次要指标</h3>
                    <div className="space-y-1">
                      {activeExp.secondaryMetrics.map(m => (
                        <div key={m} className="flex items-center gap-2 p-1.5 bg-surface-high rounded">
                          <span className="text-[11px] text-text flex-1">{m}</span>
                          <Badge variant="info">追踪中</Badge>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h3 className="text-xs font-semibold text-text mb-2">用户分群</h3>
                    <div className="space-y-1">
                      {activeExp.segments.map(s => (
                        <div key={s} className="flex items-center gap-2 p-1.5 bg-surface-high rounded">
                          <span className="material-symbols-outlined text-base text-accent">group</span>
                          <span className="text-[11px] text-text flex-1">{s}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            )}

            {tab === 'segments' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">用户分群定义</h3>
                <div className="grid grid-cols-2 gap-2">
                  {['新用户', '回访用户', '移动端', '桌面端', '高价值用户', '流失风险', '付费用户', '免费用户'].map(s => (
                    <div key={s} className="bg-surface-high rounded p-2 flex items-center gap-2">
                      <span className="material-symbols-outlined text-base text-accent">group</span>
                      <span className="text-[11px] text-text flex-1">{s}</span>
                      <Badge variant="info">{(1000 + Math.random() * 50000) | 0}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === 'history' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">已归档实验</h3>
                <div className="space-y-1.5">
                  {EXPERIMENTS.filter(e => e.status === 'completed').map(e => (
                    <div key={e.id} className="bg-surface-high rounded p-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="success">已发布</Badge>
                        <span className="text-[11px] font-medium text-text">{e.name}</span>
                        <span className="text-[10px] text-text-secondary ml-auto">Lift +{e.lift}%</span>
                      </div>
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
