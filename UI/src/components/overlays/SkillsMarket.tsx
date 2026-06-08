// ─────────────────────────────────────────────────────────────────
// 技能市场 - 浏览/启用/禁用技能
// ─────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { Button, Badge, Tooltip } from '../ui/Button';

interface Skill {
  id: string;
  name: string;
  desc: string;
  icon: string;
  category: '编程' | '研究' | '生产力' | '数据' | '系统' | '创作';
  enabled: boolean;
  builtin: boolean;
  uses: number;
  rating: number;
  author: string;
}

const INITIAL: Skill[] = [
  { id: 'code-review',   name: '代码审查',     desc: '自动检查代码风格、潜在 bug、性能问题', icon: 'rate_review', category: '编程', enabled: true,  builtin: true,  uses: 1284, rating: 4.8, author: 'SoloForge' },
  { id: 'unit-test',     name: '单元测试',     desc: '为函数/类自动生成单元测试',          icon: 'science',     category: '编程', enabled: true,  builtin: true,  uses: 962,  rating: 4.7, author: 'SoloForge' },
  { id: 'refactor',      name: '重构助手',     desc: '识别重复代码并提出重构建议',         icon: 'build',       category: '编程', enabled: false, builtin: true,  uses: 542,  rating: 4.5, author: 'SoloForge' },
  { id: 'web-search',    name: '联网搜索',     desc: '在 DuckDuckGo / Bing 上检索实时信息', icon: 'travel_explore', category: '研究', enabled: true,  builtin: true,  uses: 3201, rating: 4.6, author: 'SoloForge' },
  { id: 'arxiv',         name: '论文检索',     desc: '在 arXiv 上查找学术论文',            icon: 'article',     category: '研究', enabled: false, builtin: false, uses: 188,  rating: 4.4, author: '@phd' },
  { id: 'summarize',     name: '文档摘要',     desc: '把长文档压缩成要点',                icon: 'summarize',   category: '生产力', enabled: true, builtin: true,  uses: 1872, rating: 4.7, author: 'SoloForge' },
  { id: 'translate',     name: '翻译',         desc: '高质量中英/多语种互译',              icon: 'translate',   category: '生产力', enabled: false, builtin: true,  uses: 654,  rating: 4.5, author: 'SoloForge' },
  { id: 'sql-query',     name: 'SQL 生成',     desc: '自然语言转 SQL 并执行',              icon: 'database',    category: '数据', enabled: true,  builtin: true,  uses: 421,  rating: 4.6, author: 'SoloForge' },
  { id: 'chart',         name: '图表生成',     desc: '数据 → 多种图表',                    icon: 'bar_chart',   category: '数据', enabled: false, builtin: false, uses: 233,  rating: 4.3, author: '@data-vis' },
  { id: 'shell',         name: 'Shell 执行',   desc: '在容器内运行 shell 命令',            icon: 'terminal',    category: '系统', enabled: false, builtin: true,  uses: 88,   rating: 4.2, author: 'SoloForge' },
  { id: 'image-gen',     name: '图像生成',     desc: '调用 SD/DALL-E 生成插图',            icon: 'image',       category: '创作', enabled: false, builtin: false, uses: 612,  rating: 4.5, author: '@artisan' },
  { id: 'markdown',      name: 'Markdown 美化',desc: '为 Markdown 添加排版与图表',         icon: 'edit_note',   category: '创作', enabled: true,  builtin: true,  uses: 1455, rating: 4.8, author: 'SoloForge' },
];

const CATEGORIES = ['全部', '编程', '研究', '生产力', '数据', '系统', '创作'] as const;

interface Props {
  open: boolean;
  onClose: () => void;
  onToggle?: (id: string, enabled: boolean) => void;
}

export function SkillsMarket({ open, onClose, onToggle }: Props) {
  const [skills, setSkills] = useState<Skill[]>(INITIAL);
  const [category, setCategory] = useState<typeof CATEGORIES[number]>('全部');
  const [search, setSearch] = useState('');

  if (!open) return null;

  const filtered = skills.filter(s =>
    (category === '全部' || s.category === category) &&
    (!search || s.name.includes(search) || s.desc.includes(search))
  );

  const toggle = (id: string) => {
    setSkills(prev => {
      const next = prev.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s);
      const s = next.find(x => x.id === id);
      if (s) onToggle?.(id, s.enabled);
      return next;
    });
  };

  const enabledCount = skills.filter(s => s.enabled).length;

  return (
    <div
      className="fixed inset-0 z-[180] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in p-8"
      onClick={onClose}
    >
      <div
        className="w-[900px] max-w-[95vw] h-[600px] max-h-[90vh] bg-bg border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-slide-in-up"
        onClick={e => e.stopPropagation()}
      >
        {/* 头 */}
        <div className="flex items-center justify-between px-5 h-14 bg-gradient-to-r from-primary/10 to-accent/10 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="absolute inset-0 blur-lg bg-primary/40 rounded-full" />
              <div className="relative w-9 h-9 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                <span className="material-symbols-outlined text-white filled">extension</span>
              </div>
            </div>
            <div>
              <h2 className="text-base font-display font-bold text-text">技能市场</h2>
              <p className="text-[10px] text-text-secondary">为 SoloForge 解锁更多能力 · {enabledCount}/{skills.length} 已启用</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary text-sm">search</span>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="搜索技能..."
                className="pl-8 pr-3 h-8 w-56 bg-surface border border-border-light text-xs text-text rounded-md focus:outline-none focus:border-primary"
              />
            </div>
            <Tooltip content="关闭">
              <button onClick={onClose} className="p-1.5 rounded hover:bg-surface text-text-secondary hover:text-text">
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </Tooltip>
          </div>
        </div>

        {/* 分类 */}
        <div className="flex items-center gap-1 px-5 py-2 border-b border-border-light bg-bg-dim">
          {CATEGORIES.map(c => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`px-3 h-7 text-xs rounded-md transition-colors ${
                category === c
                  ? 'bg-primary text-on-primary'
                  : 'text-text-secondary hover:text-text hover:bg-surface-high'
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        {/* 列表 */}
        <div className="flex-1 overflow-y-auto p-4 scrollbar-thin">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {filtered.map(s => (
              <div
                key={s.id}
                className={`group relative flex items-start gap-3 p-3 rounded-xl border transition-all ${
                  s.enabled
                    ? 'bg-primary/5 border-primary/40 hover:border-primary'
                    : 'bg-surface border-border-light hover:border-primary/50'
                }`}
              >
                <div className={`shrink-0 w-10 h-10 rounded-lg flex items-center justify-center ${
                  s.enabled ? 'bg-primary text-on-primary' : 'bg-surface-high text-text-secondary'
                }`}>
                  <span className="material-symbols-outlined text-xl">{s.icon}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-sm font-semibold text-text truncate">{s.name}</span>
                    <Badge variant="default" className="text-[9px]">{s.category}</Badge>
                    {s.builtin && <Badge variant="info" className="text-[9px]">内置</Badge>}
                    {!s.builtin && <Badge variant="warning" className="text-[9px]">社区</Badge>}
                  </div>
                  <p className="text-[11px] text-text-secondary mt-0.5 line-clamp-2">{s.desc}</p>
                  <div className="flex items-center gap-2.5 mt-1.5 text-[10px] text-text-secondary/80">
                    <span className="flex items-center gap-0.5">
                      <span className="material-symbols-outlined text-xs">download</span>
                      {s.uses.toLocaleString()}
                    </span>
                    <span className="flex items-center gap-0.5">
                      <span className="material-symbols-outlined text-xs text-warning filled">star</span>
                      {s.rating.toFixed(1)}
                    </span>
                    <span>· {s.author}</span>
                  </div>
                </div>
                <button
                  onClick={() => toggle(s.id)}
                  className={`shrink-0 w-9 h-5 rounded-full transition-colors relative ${
                    s.enabled ? 'bg-primary' : 'bg-surface-high'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow ${
                      s.enabled ? 'translate-x-[18px]' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
            ))}
          </div>
          {filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-text-secondary">
              <span className="material-symbols-outlined text-4xl mb-2 opacity-40">search_off</span>
              <p className="text-xs">没有匹配 "{search}" 的技能</p>
            </div>
          )}
        </div>

        {/* 底栏 */}
        <div className="flex items-center justify-between px-5 h-10 bg-bg-dim border-t border-border text-[10px] text-text-secondary">
          <div className="flex items-center gap-3">
            <span>已启用 {enabledCount} 项</span>
            <span>·</span>
            <span>{filtered.length} / {skills.length} 项展示</span>
          </div>
          <Button variant="ghost" size="sm" icon="upload">安装本地技能 (.sfpkg)</Button>
        </div>
      </div>
    </div>
  );
}
