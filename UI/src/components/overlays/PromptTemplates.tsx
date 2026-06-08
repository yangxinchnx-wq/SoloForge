// ─────────────────────────────────────────────────────────────────
// AI 提示词模板库 — PromptTemplates
// - 内置常用模板 (代码/翻译/总结/分析/创作)
// - 变量插值 {{name}} 实时预览
// - 收藏/分类/导入导出/版本
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
  onUse?: (text: string) => void;
}

interface Template {
  id: string;
  name: string;
  category: 'code' | 'translate' | 'summarize' | 'analyze' | 'create' | 'plan' | 'test' | 'review' | 'custom';
  description: string;
  body: string;
  variables: string[];
  tags: string[];
  author: string;
  uses: number;
  favorite: boolean;
  version: number;
  updatedAt: number;
  icon: string;
}

const STORAGE_KEY = 'soloforge.prompt-templates.v1';

const BUILTIN: Omit<Template, 'uses' | 'favorite' | 'version' | 'updatedAt'>[] = [
  {
    id: 'tpl_code_review',
    name: '代码审查',
    category: 'review',
    description: '多角度对代码片段做严格审查,标出问题 + 建议',
    icon: 'rate_review',
    author: 'system',
    variables: ['language', 'code', 'context'],
    tags: ['代码', '审查'],
    body: `请对以下 {{language}} 代码做严格审查,分三段输出:

1. **问题清单** (按严重度排序: 🔴 严重 / 🟡 警告 / 🟢 建议)
2. **改进建议** (具体到代码片段)
3. **优化后版本** (保留功能的前提下)

上下文:{{context}}

代码:
\`\`\`{{language}}
{{code}}
\`\`\``,
  },
  {
    id: 'tpl_unit_test',
    name: '单元测试生成',
    category: 'test',
    description: '为指定代码生成完整单元测试 (正常/边界/异常)',
    icon: 'science',
    author: 'system',
    variables: ['framework', 'language', 'code'],
    tags: ['测试', '代码'],
    body: `使用 {{framework}} 为以下 {{language}} 代码生成单元测试,要求:

- 覆盖: 正常路径 / 边界条件 / 异常分支
- 命名: describe/it 用中文,易于阅读
- 包含 mock 处理
- 输出完整可运行代码

\`\`\`{{language}}
{{code}}
\`\`\``,
  },
  {
    id: 'tpl_translate',
    name: '技术翻译',
    category: 'translate',
    description: '保留技术术语与代码的精准翻译',
    icon: 'translate',
    author: 'system',
    variables: ['from', 'to', 'text'],
    tags: ['翻译'],
    body: `将以下 {{from}} 翻译为 {{to}},要求:

- 技术术语保留原文括号说明 (例: closure 闭包)
- 代码块、命令、文件名不翻译
- 段落结构、Markdown 格式保持
- 语气专业,适合技术文档

原文:
{{text}}`,
  },
  {
    id: 'tpl_summarize',
    name: '文章摘要',
    category: 'summarize',
    description: '分层摘要 + 关键观点 + 行动建议',
    icon: 'summarize',
    author: 'system',
    variables: ['length', 'style', 'text'],
    tags: ['总结', '分析'],
    body: `请将以下内容做 {{length}} 字 {{style}} 风格摘要,分三部分:

## 一句话总结
## 关键观点 (3-5 条)
## 行动建议

原文:
{{text}}`,
  },
  {
    id: 'tpl_decision',
    name: 'AI 决策路由',
    category: 'plan',
    description: '根据场景路由到合适的 AI agent',
    icon: 'alt_route',
    author: 'system',
    variables: ['scenario', 'options'],
    tags: ['决策', '规划'],
    body: `场景:{{scenario}}

候选方案:
{{options}}

请:
1. 为每个方案打分 (0-10) 三个维度: 成本 / 风险 / 收益
2. 给出推荐排序
3. 说明首选方案的回退预案`,
  },
  {
    id: 'tpl_bug_analysis',
    name: 'Bug 根因分析',
    category: 'analyze',
    description: '5 Whys + 时间线 + 修复 + 预防',
    icon: 'bug_report',
    author: 'system',
    variables: ['bug', 'stack', 'logs'],
    tags: ['Bug', '分析'],
    body: `Bug 描述: {{bug}}

堆栈:
\`\`\`
{{stack}}
\`\`\`

日志:
\`\`\`
{{logs}}
\`\`\`

请输出:
1. **时间线** — 何时发生,触发条件
2. **5 Whys 根因**
3. **最小修复**
4. **预防措施** (代码层面 + 流程层面)`,
  },
  {
    id: 'tpl_doc',
    name: 'API 文档生成',
    category: 'create',
    description: '从代码生成 OpenAPI 风格文档',
    icon: 'menu_book',
    author: 'system',
    variables: ['language', 'code'],
    tags: ['文档', 'API'],
    body: `为以下 {{language}} 代码生成 API 文档,包含:

- 接口签名 (参数类型 / 返回值 / 异常)
- 至少 2 个调用示例 (基础 / 进阶)
- 常见错误码
- 性能复杂度

\`\`\`{{language}}
{{code}}
\`\`\``,
  },
  {
    id: 'tpl_creative',
    name: '创意构思',
    category: 'create',
    description: '生成多个角度的创意方案',
    icon: 'auto_awesome',
    author: 'system',
    variables: ['topic', 'count'],
    tags: ['创意', '生成'],
    body: `围绕 "{{topic}}" 生成 {{count}} 个不同角度的方案,每个方案需含:

- 标题 (4 字以内)
- 一句话核心
- 关键执行步骤 (3 步)
- 潜在风险

要求方案之间尽量差异化,避免雷同。`,
  },
  {
    id: 'tpl_refactor',
    name: '代码重构',
    category: 'code',
    description: '保留外部行为的内部重构方案',
    icon: 'build',
    author: 'system',
    variables: ['language', 'goal', 'code'],
    tags: ['代码', '重构'],
    body: `对以下 {{language}} 代码做重构,目标: {{goal}}

要求:
- 保持外部行为完全一致
- 提高可读性 / 可测试性 / 性能
- 给出重构前后 diff
- 解释每处改动的理由

\`\`\`{{language}}
{{code}}
\`\`\``,
  },
  {
    id: 'tpl_explain',
    name: '概念解释',
    category: 'analyze',
    description: '用类比 + 图示 + 代码解释抽象概念',
    icon: 'psychology',
    author: 'system',
    variables: ['audience', 'concept'],
    tags: ['解释', '教学'],
    body: `向 {{audience}} 解释 "{{concept}}",要求:

- 用生活类比开头
- 提供代码示例 (Python / JS 二选一)
- 配 ASCII 图或伪代码流程
- 列出 2-3 个常见误解
- 给出深入学习资源`,
  },
];

function loadTemplates(): Template[] {
  try {
    const r = localStorage.getItem(STORAGE_KEY);
    if (r) return JSON.parse(r);
  } catch { /* ignore */ }
  return BUILTIN.map(t => ({ ...t, uses: 0, favorite: false, version: 1, updatedAt: Date.now() }));
}
function saveTemplates(arr: Template[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr)); } catch { /* ignore */ }
}

const CATEGORY_STYLE: Record<Template['category'], { label: string; icon: string; color: string }> = {
  code:      { label: '代码', icon: 'code',         color: 'bg-blue-500/15 text-blue-500 border-blue-500/30' },
  translate: { label: '翻译', icon: 'translate',    color: 'bg-cyan-500/15 text-cyan-500 border-cyan-500/30' },
  summarize: { label: '总结', icon: 'summarize',    color: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30' },
  analyze:   { label: '分析', icon: 'analytics',    color: 'bg-violet-500/15 text-violet-500 border-violet-500/30' },
  create:    { label: '创作', icon: 'auto_awesome', color: 'bg-pink-500/15 text-pink-500 border-pink-500/30' },
  plan:      { label: '规划', icon: 'route',        color: 'bg-amber-500/15 text-amber-500 border-amber-500/30' },
  test:      { label: '测试', icon: 'science',      color: 'bg-teal-500/15 text-teal-500 border-teal-500/30' },
  review:    { label: '审查', icon: 'rate_review',  color: 'bg-rose-500/15 text-rose-500 border-rose-500/30' },
  custom:    { label: '自定义', icon: 'edit_note',   color: 'bg-text-secondary/15 text-text-secondary border-text-secondary/30' },
};

export function PromptTemplates({ open, onClose, onUse }: Props) {
  const [templates, setTemplates] = useState<Template[]>(loadTemplates);
  const [view, setView] = useState<'browse' | 'editor'>('browse');
  const [editing, setEditing] = useState<Template | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState<Template['category'] | 'all' | 'fav'>('all');
  const [varValues, setVarValues] = useState<Record<string, string>>({});

  useEffect(() => { saveTemplates(templates); }, [templates]);

  const filtered = useMemo(() => {
    return templates.filter(t => {
      if (catFilter === 'fav' && !t.favorite) return false;
      if (catFilter !== 'all' && catFilter !== 'fav' && t.category !== catFilter) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return t.name.toLowerCase().includes(q)
        || t.description.toLowerCase().includes(q)
        || t.tags.some(tag => tag.toLowerCase().includes(q));
    });
  }, [templates, search, catFilter]);

  const active = useMemo(() => templates.find(t => t.id === activeId) || null, [templates, activeId]);

  const interpolated = useMemo(() => {
    if (!active) return '';
    return active.body.replace(/\{\{(\w+)\}\}/g, (_, k) => varValues[k] ?? `{{${k}}}`);
  }, [active, varValues]);

  const toggleFav = useCallback((id: string) => {
    setTemplates(prev => prev.map(t => t.id === id ? { ...t, favorite: !t.favorite, updatedAt: Date.now() } : t));
  }, []);

  const removeTpl = useCallback((id: string) => {
    setTemplates(prev => prev.filter(t => t.id !== id));
    if (activeId === id) setActiveId(null);
  }, [activeId]);

  const duplicateTpl = useCallback((id: string) => {
    setTemplates(prev => {
      const t = prev.find(x => x.id === id);
      if (!t) return prev;
      const newTpl: Template = {
        ...t,
        id: 'tpl_' + Date.now().toString(36),
        name: t.name + ' (副本)',
        version: 1,
        uses: 0,
        favorite: false,
        updatedAt: Date.now(),
      };
      return [newTpl, ...prev];
    });
  }, []);

  const useTpl = useCallback((t: Template) => {
    setTemplates(prev => prev.map(x => x.id === t.id ? { ...x, uses: x.uses + 1 } : x));
    onUse?.(interpolated);
  }, [interpolated, onUse]);

  const saveAsNew = useCallback((t: Template) => {
    setTemplates(prev => [{ ...t, id: 'tpl_' + Date.now().toString(36), version: 1, uses: 0, updatedAt: Date.now() }, ...prev]);
  }, []);

  const exportJson = useCallback(() => {
    const blob = new Blob([JSON.stringify(templates, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'prompt-templates.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [templates]);

  const importJson = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const arr = JSON.parse(reader.result as string);
        if (Array.isArray(arr)) setTemplates(arr);
      } catch { /* ignore */ }
    };
    reader.readAsText(file);
  }, []);

  const fileInputRef = useState<HTMLInputElement | null>(null);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-[1200px] max-w-[95vw] h-[82vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶栏 */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">library_books</span>
          <h2 className="text-sm font-semibold text-text">AI 提示词模板库</h2>
          <Badge variant="primary">{templates.length} 模板</Badge>
          <span className="text-xs text-text-secondary">总计被用 {templates.reduce((a, t) => a + t.uses, 0)} 次</span>
          <div className="ml-auto flex items-center gap-1.5">
            <Tooltip content="导入 JSON"><IconButton icon="upload" onClick={() => (fileInputRef[0] as any)?.click()} /></Tooltip>
            <input type="file" accept=".json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = ''; }} />
            <Tooltip content="导出 JSON"><IconButton icon="download" onClick={exportJson} /></Tooltip>
            <IconButton icon="add" onClick={() => {
              const t: Template = {
                id: 'tpl_' + Date.now().toString(36),
                name: '新模板',
                category: 'custom',
                description: '',
                body: '请输入模板内容,使用 {{variable}} 标记变量。',
                variables: ['variable'],
                tags: [],
                author: 'me',
                uses: 0, favorite: false, version: 1, updatedAt: Date.now(),
                icon: 'edit_note',
              };
              setEditing(t);
              setView('editor');
            }} />
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        {/* 工具条 */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-bg shrink-0">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索名称 / 描述 / 标签..."
            className="bg-surface border border-border-light rounded px-2 h-7 text-xs text-text w-56 focus:border-accent outline-none"
          />
          <div className="flex items-center gap-0.5 p-0.5 bg-surface rounded-md border border-border-light">
            {(['all', 'fav', 'code', 'translate', 'summarize', 'analyze', 'create', 'plan', 'test', 'review', 'custom'] as const).map(c => (
              <button
                key={c}
                onClick={() => setCatFilter(c)}
                className={'px-2 h-6 rounded text-[10px] transition ' + (catFilter === c ? 'bg-surface-high text-text shadow-sm' : 'text-text-secondary hover:text-text')}
              >
                {c === 'all' ? '全部' : c === 'fav' ? '★ 收藏' : CATEGORY_STYLE[c as Template['category']]?.label || c}
              </button>
            ))}
          </div>
        </div>

        {/* 主体 */}
        {view === 'browse' ? (
          <div className="flex-1 flex overflow-hidden">
            {/* 列表 */}
            <div className="w-80 border-r border-border overflow-y-auto p-2 space-y-1">
              {filtered.length === 0 && <div className="text-center text-xs text-text-secondary py-8">无匹配模板</div>}
              {filtered.map(t => {
                const cs = CATEGORY_STYLE[t.category];
                return (
                  <div
                    key={t.id}
                    onClick={() => { setActiveId(t.id); setVarValues({}); }}
                    className={'p-2.5 rounded-lg cursor-pointer transition border ' + (activeId === t.id ? 'bg-accent/10 border-accent/30' : 'border-transparent hover:bg-surface-high')}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className={'material-symbols-outlined text-sm ' + cs.color.split(' ')[1]}>{t.icon}</span>
                      <span className="text-xs font-medium text-text flex-1 truncate">{t.name}</span>
                      {t.favorite && <span className="material-symbols-outlined text-xs filled text-yellow-500">star</span>}
                    </div>
                    <div className="text-[10px] text-text-secondary line-clamp-2">{t.description}</div>
                    <div className="mt-1 flex items-center gap-1.5 text-[9px] text-text-secondary">
                      <span className={'px-1 rounded ' + cs.color}>{cs.label}</span>
                      <span>· 使用 {t.uses}</span>
                      <span>· v{t.version}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            {/* 详情 */}
            <div className="flex-1 flex flex-col overflow-hidden">
              {!active ? (
                <div className="flex-1 flex flex-col items-center justify-center text-text-secondary">
                  <span className="material-symbols-outlined text-5xl opacity-30">library_books</span>
                  <p className="mt-3 text-sm">选择一个模板查看详情</p>
                </div>
              ) : (
                <>
                  <div className="px-4 py-3 border-b border-border bg-surface-high flex items-center gap-3 shrink-0">
                    <span className={'material-symbols-outlined ' + CATEGORY_STYLE[active.category].color.split(' ')[1]}>{active.icon}</span>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-semibold text-text truncate">{active.name}</h3>
                      <div className="text-[10px] text-text-secondary truncate">{active.description}</div>
                    </div>
                    <Tooltip content={active.favorite ? '取消收藏' : '收藏'}>
                      <IconButton icon={active.favorite ? 'star' : 'star_border'} filled={active.favorite} onClick={() => toggleFav(active.id)} />
                    </Tooltip>
                    <Tooltip content="复制"><IconButton icon="content_copy" onClick={() => navigator.clipboard?.writeText(interpolated)} /></Tooltip>
                    <Tooltip content="编辑"><IconButton icon="edit" onClick={() => { setEditing({ ...active }); setView('editor'); }} /></Tooltip>
                    <Tooltip content="另存为新模板"><IconButton icon="save_as" onClick={() => saveAsNew(active)} /></Tooltip>
                    <Tooltip content="复制"><IconButton icon="fork_right" onClick={() => duplicateTpl(active.id)} /></Tooltip>
                    <Button variant="primary" size="sm" icon="play_arrow" onClick={() => useTpl(active)}>使用</Button>
                  </div>
                  {/* 变量输入 */}
                  {active.variables.length > 0 && (
                    <div className="px-4 py-2 border-b border-border bg-bg">
                      <div className="text-[10px] uppercase tracking-wider text-text-secondary mb-1">变量插值</div>
                      <div className="grid grid-cols-2 gap-2">
                        {active.variables.map(v => (
                          <div key={v} className="flex items-center gap-1.5">
                            <span className="text-[10px] font-mono text-accent w-20 truncate">{`{{${v}}}`}</span>
                            <input
                              value={varValues[v] || ''}
                              onChange={(e) => setVarValues(p => ({ ...p, [v]: e.target.value }))}
                              className="flex-1 bg-surface border border-border-light rounded px-2 h-6 text-[11px] text-text focus:border-accent outline-none"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* 模板正文 */}
                  <div className="flex-1 grid grid-cols-2 gap-0 overflow-hidden">
                    <div className="border-r border-border flex flex-col overflow-hidden">
                      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-secondary border-b border-border-light">原始模板</div>
                      <pre className="flex-1 p-3 text-xs font-mono text-text-secondary overflow-auto whitespace-pre-wrap bg-bg/30">{active.body}</pre>
                    </div>
                    <div className="flex flex-col overflow-hidden">
                      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-secondary border-b border-border-light">插值预览</div>
                      <pre className="flex-1 p-3 text-xs font-mono text-text overflow-auto whitespace-pre-wrap">{interpolated}</pre>
                    </div>
                  </div>
                  {/* 标签/统计 */}
                  <div className="px-4 py-1.5 border-t border-border bg-surface-high flex items-center gap-2 text-[10px] text-text-secondary shrink-0">
                    <span>作者 {active.author}</span>
                    <span>·</span>
                    <span>使用 {active.uses} 次</span>
                    <span>·</span>
                    <span>v{active.version}</span>
                    <span>·</span>
                    <span>{new Date(active.updatedAt).toLocaleString()}</span>
                    <div className="ml-auto flex gap-1">
                      {active.tags.map(t => <span key={t} className="px-1.5 rounded bg-bg text-text-secondary">#{t}</span>)}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        ) : (
          // 编辑器
          <div className="flex-1 flex flex-col overflow-hidden p-3 gap-3">
            {editing && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-text-secondary">名称</label>
                    <input
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                      className="w-full bg-bg border border-border-light rounded px-2 h-7 text-xs text-text focus:border-accent outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-text-secondary">分类</label>
                    <select
                      value={editing.category}
                      onChange={(e) => setEditing({ ...editing, category: e.target.value as any })}
                      className="w-full bg-bg border border-border-light rounded px-2 h-7 text-xs text-text focus:border-accent outline-none"
                    >
                      {Object.entries(CATEGORY_STYLE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </select>
                  </div>
                  <div className="col-span-2">
                    <label className="text-[10px] uppercase tracking-wider text-text-secondary">描述</label>
                    <input
                      value={editing.description}
                      onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                      className="w-full bg-bg border border-border-light rounded px-2 h-7 text-xs text-text focus:border-accent outline-none"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="text-[10px] uppercase tracking-wider text-text-secondary">标签 (逗号分隔)</label>
                    <input
                      value={editing.tags.join(', ')}
                      onChange={(e) => setEditing({ ...editing, tags: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                      className="w-full bg-bg border border-border-light rounded px-2 h-7 text-xs text-text focus:border-accent outline-none"
                    />
                  </div>
                </div>
                <div className="flex-1 grid grid-cols-2 gap-2 overflow-hidden">
                  <div className="flex flex-col">
                    <label className="text-[10px] uppercase tracking-wider text-text-secondary">模板 (使用 {`{{name}}`} 表示变量)</label>
                    <textarea
                      value={editing.body}
                      onChange={(e) => {
                        const vars = Array.from(new Set(Array.from(e.target.value.matchAll(/\{\{(\w+)\}\}/g)).map(m => m[1])));
                        setEditing({ ...editing, body: e.target.value, variables: vars });
                      }}
                      className="flex-1 bg-bg border border-border-light rounded p-2 text-xs font-mono text-text resize-none focus:border-accent outline-none"
                    />
                  </div>
                  <div className="flex flex-col">
                    <label className="text-[10px] uppercase tracking-wider text-text-secondary">预览</label>
                    <pre className="flex-1 bg-bg border border-border-light rounded p-2 text-xs font-mono text-text overflow-auto whitespace-pre-wrap">
                      {editing.body.replace(/\{\{(\w+)\}\}/g, (_, k) => `‹${k}›`)}
                    </pre>
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setView('browse')}>取消</Button>
                  {editing.id && !templates.find(t => t.id === editing.id) && (
                    <Button variant="secondary" size="sm" icon="delete" onClick={() => removeTpl(editing.id)}>删除</Button>
                  )}
                  <Button variant="primary" size="sm" icon="save" onClick={() => {
                    const exists = templates.find(t => t.id === editing.id);
                    if (exists) {
                      setTemplates(prev => prev.map(t => t.id === editing.id ? { ...editing, version: t.version + 1, updatedAt: Date.now() } : t));
                    } else {
                      setTemplates(prev => [{ ...editing, updatedAt: Date.now() }, ...prev]);
                    }
                    setView('browse');
                  }}>保存</Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
