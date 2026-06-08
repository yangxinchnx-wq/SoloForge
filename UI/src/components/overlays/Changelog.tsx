// ─────────────────────────────────────────────────────────────────
// 变更日志 / 发布说明 — Changelog
// - 版本时间线 (SemVer)
// - 类别: Feature / Improvement / Bug / Breaking / Security
// - Markdown 内容渲染
// - 对比版本 / 标签过滤
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button, Select } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type Category = 'feature' | 'improvement' | 'bug' | 'breaking' | 'security' | 'docs';

interface Release {
  version: string;       // semver
  date: string;
  channel: 'stable' | 'beta' | 'rc' | 'lts';
  title: string;
  items: Array<{ category: Category; text: string; scope?: string }>;
}

const CAT_META: Record<Category, { label: string; color: string; icon: string }> = {
  feature:     { label: '新功能', color: 'bg-success/15 text-success border-success/30', icon: 'auto_awesome' },
  improvement: { label: '改进',   color: 'bg-info/15 text-info border-info/30',         icon: 'upgrade' },
  bug:         { label: '修复',   color: 'bg-warning/15 text-warning border-warning/30', icon: 'bug_report' },
  breaking:    { label: '破坏性', color: 'bg-danger/15 text-danger border-danger/30',   icon: 'warning' },
  security:    { label: '安全',   color: 'bg-primary/15 text-primary border-primary/30', icon: 'shield' },
  docs:        { label: '文档',   color: 'bg-text-secondary/15 text-text-secondary',     icon: 'menu_book' },
};

const RELEASES: Release[] = [
  {
    version: '1.2.0', date: '2026-06-01', channel: 'stable',
    title: '智能体剧场 + 实时协作',
    items: [
      { category: 'feature', text: '智能体剧场 (Agent Theater) - 可视化展示多智能体对话', scope: 'ui' },
      { category: 'feature', text: '语音对话支持 9 种语言', scope: 'voice' },
      { category: 'feature', text: '屏幕共享 + 注释工具', scope: 'share' },
      { category: 'improvement', text: '事件浏览器性能提升 5x', scope: 'core' },
      { category: 'bug', text: '修复 Safari 下 Cookie 丢失', scope: 'auth' },
    ],
  },
  {
    version: '1.1.0', date: '2026-05-15', channel: 'stable',
    title: '数据可视化',
    items: [
      { category: 'feature', text: '仪表盘 (Dashboard) 8+ 组件', scope: 'ui' },
      { category: 'feature', text: 'AI 提示词模板库', scope: 'prompts' },
      { category: 'feature', text: '命令历史与收藏', scope: 'history' },
      { category: 'improvement', text: '代码评审支持多模型并行', scope: 'review' },
    ],
  },
  {
    version: '1.0.0', date: '2026-05-01', channel: 'lts',
    title: '正式发布',
    items: [
      { category: 'feature', text: 'SoloForge 1.0 LTS 正式发布', scope: 'core' },
      { category: 'feature', text: '微内核 + Rust 调度器 + SurrealDB 集成', scope: 'core' },
      { category: 'security', text: '端到端加密审计日志', scope: 'security' },
      { category: 'docs', text: '完整 API 文档 + 教程', scope: 'docs' },
    ],
  },
  {
    version: '0.9.0', date: '2026-04-15', channel: 'beta',
    title: 'Beta 公开测试',
    items: [
      { category: 'feature', text: 'AI 工作流 Pipeline 编辑器', scope: 'workflow' },
      { category: 'feature', text: 'Mermaid 图表实时预览', scope: 'ui' },
      { category: 'breaking', text: 'API: /v1/* 端点统一为 /v2/*', scope: 'api' },
      { category: 'bug', text: '修复高并发下数据库连接泄漏', scope: 'db' },
    ],
  },
  {
    version: '0.8.0', date: '2026-04-01', channel: 'rc',
    title: '候选发布',
    items: [
      { category: 'feature', text: '插件注册中心 (Plugin Registry)', scope: 'plugin' },
      { category: 'feature', text: 'SurrealDB 浏览器', scope: 'db' },
      { category: 'improvement', text: '代码地图响应式布局', scope: 'ui' },
    ],
  },
  {
    version: '0.7.0', date: '2026-03-15', channel: 'beta',
    title: '代码智能',
    items: [
      { category: 'feature', text: 'AI 代码多模型评审', scope: 'review' },
      { category: 'feature', text: '番茄钟 + 编码统计', scope: 'productivity' },
      { category: 'feature', text: '正则表达式工作台', scope: 'tools' },
      { category: 'feature', text: '便签 Sticky Notes', scope: 'productivity' },
    ],
  },
];

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  }
  return 0;
}

export function Changelog({ open, onClose }: Props) {
  const [filter, setFilter] = useState<Category | 'all'>('all');
  const [channel, setChannel] = useState<'all' | Release['channel']>('all');
  const [compareA, setCompareA] = useState<string>('1.1.0');
  const [compareB, setCompareB] = useState<string>('1.2.0');
  const [showCompare, setShowCompare] = useState(false);

  const filtered = useMemo(() => {
    return RELEASES.filter(r => channel === 'all' || r.channel === channel)
      .map(r => ({
        ...r,
        items: filter === 'all' ? r.items : r.items.filter(i => i.category === filter),
      }))
      .filter(r => r.items.length > 0);
  }, [filter, channel]);

  const stats = useMemo(() => {
    const all = RELEASES.flatMap(r => r.items);
    return {
      feature: all.filter(i => i.category === 'feature').length,
      improvement: all.filter(i => i.category === 'improvement').length,
      bug: all.filter(i => i.category === 'bug').length,
      breaking: all.filter(i => i.category === 'breaking').length,
      security: all.filter(i => i.category === 'security').length,
    };
  }, []);

  if (!open) return null;

  const relA = RELEASES.find(r => r.version === compareA);
  const relB = RELEASES.find(r => r.version === compareB);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1100px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">history</span>
          <h2 className="text-sm font-semibold text-text">更新日志</h2>
          <Badge variant="primary">{RELEASES.length} 版本</Badge>
          <Badge variant="info">+{stats.feature} 新功能</Badge>
          <Badge variant="warning">~{stats.improvement} 改进</Badge>
          <Badge variant="danger">{stats.bug} 修复</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="compare_arrows" onClick={() => setShowCompare(true)}>版本对比</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-2 border-b border-border bg-bg flex items-center gap-2">
          <span className="text-[10px] text-text-secondary">类型:</span>
          <div className="flex items-center gap-0.5 p-0.5 bg-surface rounded-md border border-border-light">
            <button onClick={() => setFilter('all')} className={'px-2 h-6 rounded text-[10px] ' + (filter === 'all' ? 'bg-surface-high text-text' : 'text-text-secondary')}>全部</button>
            {(Object.keys(CAT_META) as Category[]).map(c => (
              <button key={c} onClick={() => setFilter(c)} className={'px-2 h-6 rounded text-[10px] ' + (filter === c ? 'bg-surface-high text-text' : 'text-text-secondary')}>{CAT_META[c].label}</button>
            ))}
          </div>
          <span className="text-[10px] text-text-secondary ml-3">渠道:</span>
          <Select
            value={channel}
            options={[{ value: 'all', label: '全部' }, { value: 'stable', label: '稳定' }, { value: 'beta', label: 'Beta' }, { value: 'rc', label: 'RC' }, { value: 'lts', label: 'LTS' }]}
            onChange={(v) => setChannel(v as any)}
            className="w-20"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="relative">
            {/* 时间线 */}
            <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-border" />
            <div className="space-y-4">
              {filtered.map((r, i) => (
                <div key={r.version} className="relative pl-12">
                  <div className={'absolute left-2 top-2 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold border-2 border-surface ' + (r.channel === 'lts' ? 'bg-primary text-on-primary' : r.channel === 'stable' ? 'bg-success text-white' : r.channel === 'beta' ? 'bg-warning text-white' : 'bg-info text-white')}>
                    {r.channel === 'lts' ? 'L' : r.channel[0].toUpperCase()}
                  </div>
                  <div className="bg-bg border border-border rounded-lg p-3 hover:shadow-md transition">
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant={r.channel === 'lts' ? 'primary' : r.channel === 'stable' ? 'success' : 'warning'}>v{r.version}</Badge>
                      <span className="text-[10px] text-text-secondary">{r.date}</span>
                      <h3 className="text-sm font-semibold text-text flex-1">{r.title}</h3>
                      <span className="text-[10px] text-text-secondary">{r.items.length} 项</span>
                    </div>
                    <ul className="space-y-1">
                      {r.items.map((item, j) => {
                        const meta = CAT_META[item.category];
                        return (
                          <li key={j} className="flex items-start gap-2 text-xs">
                            <span className={'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[10px] shrink-0 ' + meta.color}>
                              <span className="material-symbols-outlined text-[10px]">{meta.icon}</span>
                              {meta.label}
                            </span>
                            {item.scope && <span className="text-[9px] px-1 py-0.5 rounded bg-surface-high text-text-secondary font-mono shrink-0">{item.scope}</span>}
                            <span className="text-text">{item.text}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {showCompare && (
          <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-8" onClick={() => setShowCompare(false)}>
            <div className="bg-surface border border-border rounded-xl shadow-2xl w-[800px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
                <h3 className="text-sm font-semibold text-text">版本对比</h3>
                <Select value={compareA} options={RELEASES.map(r => ({ value: r.version, label: `v${r.version}` }))} onChange={setCompareA} className="w-24" />
                <span className="text-text-secondary">→</span>
                <Select value={compareB} options={RELEASES.map(r => ({ value: r.version, label: `v${r.version}` }))} onChange={setCompareB} className="w-24" />
                <IconButton icon="close" size="xs" onClick={() => setShowCompare(false)} className="ml-auto" />
              </div>
              <div className="flex-1 overflow-y-auto p-3">
                {relA && relB && (() => {
                  const added = relB.items.filter(bi => !relA.items.some(ai => ai.text === bi.text));
                  const removed = relA.items.filter(ai => !relB.items.some(bi => bi.text === ai.text));
                  return (
                    <div className="space-y-2 text-xs">
                      <div>
                        <h4 className="text-success font-semibold mb-1">+ 新增 ({added.length})</h4>
                        {added.map((i, k) => <div key={k} className="text-text">+ {i.text}</div>)}
                      </div>
                      <div>
                        <h4 className="text-danger font-semibold mb-1">- 删除 ({removed.length})</h4>
                        {removed.map((i, k) => <div key={k} className="text-text">- {i.text}</div>)}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
