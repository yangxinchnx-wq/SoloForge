// ─────────────────────────────────────────────────────────────────
// 左侧面板 (除资源/编辑器外的视图)
// Git / Search / Debug / Court / Agents
// ─────────────────────────────────────────────────────────────────

import { useState } from 'react';
import type { useResources } from '../../hooks/useResources';
import { useBackend } from '../../hooks/useBackend';
import { PanelHeader, Tooltip, IconButton, Badge, StatusDot, Button, EmptyState } from '../ui/Button';

// ─── Git 面板 ───
export function GitPanel() {
  const changes = [
    { path: '/src/index.ts', status: 'M', msg: 'feat: 添加 Garnet 热数据层', author: 'yangx', time: '2 分钟前' },
    { path: '/src/api-server.ts', status: 'M', msg: 'fix: 修复 SSE 断连', author: 'yangx', time: '5 分钟前' },
    { path: '/src/data/repositories/surreal-repositories.ts', status: 'U', msg: '', author: '', time: '10 分钟前' },
    { path: '/rust_core/src/scheduler.rs', status: 'A', msg: 'feat: Aging 优先级', author: 'yangx', time: '1 小时前' },
    { path: '/migrations/v5_events.surql', status: 'M', msg: 'feat: 事件审计表', author: 'yangx', time: '2 小时前' },
  ];
  const branches = [
    { name: 'main', current: true, ahead: 0, behind: 0 },
    { name: 'feat/garnet-hot-layer', ahead: 3, behind: 1 },
    { name: 'fix/sse-reconnect', ahead: 1, behind: 0 },
  ];

  return (
    <div className="flex flex-col h-full">
      <PanelHeader
        icon="account_tree"
        title="源码管理"
        count={<Badge variant="primary">{changes.length} 变更</Badge>}
        action={
          <>
            <Tooltip content="提交">
              <Button size="sm" variant="primary" icon="check">提交</Button>
            </Tooltip>
          </>
        }
      />
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {/* 当前分支 */}
        <div className="p-2 border-b border-border-light">
          <div className="flex items-center gap-2 text-xs">
            <span className="material-symbols-outlined text-primary text-sm">account_tree</span>
            <span className="font-medium text-text">main</span>
            <span className="text-text-secondary text-[10px]">↻</span>
            <div className="flex-1" />
            <button className="material-symbols-outlined text-sm text-text-secondary hover:text-text">sync</button>
            <button className="material-symbols-outlined text-sm text-text-secondary hover:text-text">more_horiz</button>
          </div>
        </div>

        {/* 变更列表 */}
        <div className="px-2 py-1.5 flex items-center gap-1.5 text-[10px] uppercase font-semibold text-text-secondary">
          <span className="material-symbols-outlined text-xs">edit</span>
          变更
          <span className="text-text">·</span>
          <span className="text-text">{changes.length}</span>
        </div>
        {changes.map((c, i) => (
          <div key={i} className="group flex items-start gap-2 px-3 py-1.5 hover:bg-surface-low text-xs">
            <span className={`font-mono font-bold w-3 ${c.status === 'M' ? 'text-warning' : c.status === 'A' ? 'text-success' : c.status === 'D' ? 'text-danger' : 'text-accent'}`}>
              {c.status || '?'}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-text truncate">{c.path}</div>
              {c.msg && <div className="text-[10px] text-text-secondary truncate">{c.msg}</div>}
              {c.time && <div className="text-[9px] text-text-secondary/70 font-mono">{c.author} · {c.time}</div>}
            </div>
            <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5">
              <button className="material-symbols-outlined text-xs text-text-secondary hover:text-text">visibility</button>
              <button className="material-symbols-outlined text-xs text-text-secondary hover:text-text">undo</button>
            </div>
          </div>
        ))}

        {/* 分支 */}
        <div className="px-2 py-1.5 flex items-center gap-1.5 text-[10px] uppercase font-semibold text-text-secondary border-t border-border-light mt-2">
          <span className="material-symbols-outlined text-xs">fork_right</span>
          分支
        </div>
        {branches.map(b => (
          <div key={b.name} className={`group flex items-center gap-2 px-3 py-1 text-xs ${b.current ? 'bg-primary-container/30' : 'hover:bg-surface-low'}`}>
            <span className={`material-symbols-outlined text-sm ${b.current ? 'text-primary' : 'text-text-secondary'}`}>account_tree</span>
            <span className={`flex-1 truncate ${b.current ? 'font-semibold text-text' : 'text-text'}`}>{b.name}</span>
            {b.ahead > 0 && <span className="text-[9px] font-mono text-success">↑{b.ahead}</span>}
            {b.behind > 0 && <span className="text-[9px] font-mono text-danger">↓{b.behind}</span>}
            {b.current && <Badge variant="primary" className="text-[9px]">当前</Badge>}
          </div>
        ))}

        {/* 远程 */}
        <div className="px-2 py-1.5 text-[10px] uppercase font-semibold text-text-secondary border-t border-border-light mt-2">
          远程
        </div>
        <div className="px-3 py-1 flex items-center gap-2 text-xs hover:bg-surface-low cursor-pointer">
          <span className="material-symbols-outlined text-sm text-text-secondary">cloud</span>
          <span className="flex-1">origin</span>
          <span className="material-symbols-outlined text-xs text-text-secondary">chevron_right</span>
        </div>
      </div>
    </div>
  );
}

// ─── 搜索面板 ───
export function SearchPanel({ resources }: { resources: ReturnType<typeof useResources> }) {
  const [query, setQuery] = useState('TODO');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);

  const results = [
    { file: '/src/api-server.ts', line: 42, col: 12, text: '// TODO: 重构错误处理' },
    { file: '/src/core/court/consensagent.ts', line: 88, col: 4, text: '// TODO: 接入 LLM 升级' },
    { file: '/src/data/repositories/surreal-repositories.ts', line: 156, col: 8, text: '// TODO: 添加事务' },
    { file: '/python/mappo_server.py', line: 23, col: 1, text: '# TODO: 性能优化' },
    { file: '/rust_core/src/scheduler.rs', line: 67, col: 16, text: '// TODO: 单元测试' },
  ];

  return (
    <div className="flex flex-col h-full">
      <PanelHeader
        icon="search"
        title="搜索"
        count={<Badge variant="primary">{results.length} 结果</Badge>}
        action={
          <>
            <Tooltip content="区分大小写"><button onClick={() => setCaseSensitive(s => !s)} className={`w-6 h-6 text-[10px] font-bold rounded ${caseSensitive ? 'bg-primary text-on-primary' : 'text-text-secondary hover:text-text'}`}>Aa</button></Tooltip>
            <Tooltip content="整词"><button onClick={() => setWholeWord(s => !s)} className={`w-6 h-6 text-[10px] font-bold rounded ${wholeWord ? 'bg-primary text-on-primary' : 'text-text-secondary hover:text-text'}`}>ab</button></Tooltip>
            <Tooltip content="正则"><button onClick={() => setRegex(s => !s)} className={`w-6 h-6 text-[10px] font-bold rounded ${regex ? 'bg-primary text-on-primary' : 'text-text-secondary hover:text-text'}`}>.*</button></Tooltip>
          </>
        }
      />
      <div className="p-2 border-b border-border-light">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="搜索内容"
          className="w-full bg-surface border border-border-light text-xs text-text rounded px-2 h-7 focus:outline-none focus:border-primary"
        />
        <input
          placeholder="files to include (e.g. *.ts)"
          className="w-full mt-1 bg-surface border border-border-light text-[10px] text-text-secondary rounded px-2 h-6 focus:outline-none focus:border-primary"
        />
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {results.map((r, i) => (
          <div
            key={i}
            onClick={() => { resources.setActiveFile(r.file); }}
            className="px-3 py-1.5 hover:bg-surface-low cursor-pointer border-b border-border-light"
          >
            <div className="flex items-center gap-1.5 text-[10px] text-text-secondary font-mono">
              <span className="material-symbols-outlined text-xs">description</span>
              <span className="truncate flex-1">{r.file}</span>
              <span>:{r.line}</span>
            </div>
            <div className="text-[11px] text-text font-mono mt-0.5 truncate">
              <span className="bg-warning/30 text-warning px-0.5 rounded">{query}</span>
              {r.text.replace(query, '').slice(query.length)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── 调试面板 ───
export function DebugPanel() {
  return (
    <div className="flex flex-col h-full">
      <PanelHeader
        icon="bug_report"
        title="调试"
        count={<Badge variant="default">未运行</Badge>}
        action={
          <Button size="sm" variant="primary" icon="play_arrow">启动</Button>
        }
      />
      <div className="p-2 border-b border-border-light">
        <select className="w-full bg-surface border border-border-light text-xs text-text rounded h-7 px-2 focus:outline-none focus:border-primary">
          <option>选择配置</option>
          <option>Node.js: src/index.ts</option>
          <option>Python: python/mappo_server.py</option>
          <option>Rust: rust_core (release)</option>
        </select>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2 scrollbar-thin">
        <div className="bg-surface rounded-lg p-3 border border-border">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary mb-2">变量</div>
          <div className="space-y-1 text-[10px] font-mono">
            {['kernel.state', 'system.cpu', 'db.surrealdb.records', 'agents[0].name'].map((v, i) => (
              <div key={i} className="flex items-center gap-2 hover:bg-surface-low px-1 -mx-1 rounded">
                <span className="text-accent">{v}</span>
                <span className="text-text-secondary">=</span>
                <span className="text-success">"READY"</span>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-surface rounded-lg p-3 border border-border">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary mb-2">调用栈</div>
          <div className="space-y-0.5 text-[10px] font-mono">
            {['mainSystemIgnitionEngine', 'kernel.boot()', 'telemetryExporter.initialize', 'SurrealPersistence.start'].map((s, i) => (
              <div key={i} className="text-text" style={{ paddingLeft: i * 8 }}>
                at {s}
              </div>
            ))}
          </div>
        </div>
        <div className="bg-surface rounded-lg p-3 border border-border">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary mb-2">断点</div>
          <div className="text-[10px] text-text-secondary text-center py-2">未设置断点</div>
        </div>
      </div>
    </div>
  );
}

// ─── 法庭面板 ───
type CaseStatus = 'active' | 'review' | 'closed' | 'pending' | 'escalated';
type CourtCase = {
  id: string;
  title: string;
  status: CaseStatus;
  judge: string;
  level: number;
  jurors?: { allow: number; deny: number; abstain: number; total: number };
  evidence?: number;
  createdAt?: string;
  verdict?: string;
};

export function CourtPanel() {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | CaseStatus>('all');

  const cases: CourtCase[] = [
    { id: 'case_001', title: '组件越权访问',           status: 'active',   judge: 'ConsensAgent',     level: 1, jurors: { allow: 4, deny: 1, abstain: 0, total: 5 }, evidence: 7, createdAt: '2 分钟前' },
    { id: 'case_002', title: '策略漂移检测',           status: 'review',   judge: 'LlmEscalation',   level: 2, jurors: { allow: 2, deny: 2, abstain: 1, total: 5 }, evidence: 12, createdAt: '15 分钟前' },
    { id: 'case_003', title: '内存泄漏',               status: 'closed',   judge: 'ConsensAgent',     level: 1, jurors: { allow: 5, deny: 0, abstain: 0, total: 5 }, evidence: 4, verdict: 'allow', createdAt: '1 小时前' },
    { id: 'case_004', title: 'API 错误率超标',         status: 'pending',  judge: '-',               level: 0, evidence: 0, createdAt: '30 分钟前' },
    { id: 'case_005', title: 'Decision 链循环依赖',    status: 'escalated',judge: 'LlmEscalation',   level: 3, jurors: { allow: 0, deny: 4, abstain: 1, total: 5 }, evidence: 9, createdAt: '3 小时前' },
  ];

  const statusMap: Record<CaseStatus, { v: 'running' | 'warning' | 'success' | 'idle' | 'error'; label: string; color: string }> = {
    active:    { v: 'running', label: '审理中', color: 'text-success' },
    review:    { v: 'warning', label: '复审',   color: 'text-warning' },
    closed:    { v: 'success', label: '已结案', color: 'text-text-secondary' },
    pending:   { v: 'idle',    label: '待审',   color: 'text-text-secondary' },
    escalated: { v: 'error',   label: '已升级', color: 'text-danger' },
  };

  const stats = {
    total: cases.length,
    active: cases.filter(c => c.status === 'active').length,
    review: cases.filter(c => c.status === 'review' || c.status === 'escalated').length,
    closed: cases.filter(c => c.status === 'closed').length,
  };

  const filteredCases = filter === 'all' ? cases : cases.filter(c => c.status === filter);
  const filters: Array<{ id: 'all' | CaseStatus; label: string; count: number; color: string }> = [
    { id: 'all',       label: '全部', count: stats.total,  color: 'text-text' },
    { id: 'active',    label: '审理', count: stats.active, color: 'text-success' },
    { id: 'review',    label: '复审', count: cases.filter(c => c.status === 'review').length, color: 'text-warning' },
    { id: 'escalated', label: '升级', count: cases.filter(c => c.status === 'escalated').length, color: 'text-danger' },
    { id: 'closed',    label: '结案', count: stats.closed, color: 'text-text-secondary' },
  ];

  return (
    <div className="flex flex-col h-full">
      <PanelHeader
        icon="gavel"
        title="法庭"
        count={<Badge variant="info">{stats.active} 审理 · {stats.review} 复审</Badge>}
        action={
          <Tooltip content="新建案件">
            <IconButton icon="add" size="xs" />
          </Tooltip>
        }
      />

      {/* 状态过滤条 */}
      <div className="px-2 py-1.5 border-b border-border-light flex items-center gap-1 overflow-x-auto scrollbar-thin">
        {filters.map(f => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`shrink-0 flex items-center gap-1 px-1.5 h-5 rounded-full text-[9px] transition-colors ${
              filter === f.id
                ? 'bg-primary-container text-on-primary-container border border-primary/40'
                : 'bg-surface text-text-secondary hover:text-text border border-border-light'
            }`}
          >
            <span className={filter === f.id ? '' : f.color}>{f.label}</span>
            <span className="font-mono tabular-nums opacity-70">{f.count}</span>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1.5 scrollbar-thin">
        {filteredCases.length === 0 ? (
          <EmptyState icon="gavel" title="该类别下无案件" hint="切换其他过滤查看" />
        ) : filteredCases.map(c => {
          const s = statusMap[c.status];
          const isOpen = expanded === c.id;
          const jurorProgress = c.jurors
            ? Math.round((c.jurors.allow + c.jurors.deny + c.jurors.abstain) / c.jurors.total * 100)
            : 0;
          return (
            <div
              key={c.id}
              className={`bg-surface rounded-lg border transition-colors ${
                isOpen ? 'border-primary/50' : 'border-border hover:border-primary/30'
              }`}
            >
              <div
                onClick={() => setExpanded(isOpen ? null : c.id)}
                className="p-2 cursor-pointer"
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <StatusDot status={s.v} />
                    <span className="text-xs font-semibold text-text truncate">{c.title}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Badge variant={c.level === 0 ? 'default' : c.level === 1 ? 'primary' : c.level === 2 ? 'warning' : 'danger'}>
                      L{c.level}
                    </Badge>
                    <span className={`material-symbols-outlined text-[10px] text-text-secondary transition-transform ${isOpen ? 'rotate-180' : ''}`}>
                      expand_more
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-text-secondary font-mono">
                  <span className="truncate">{c.id}</span>
                  <span>·</span>
                  <span className="truncate">{c.judge}</span>
                  <span className={`ml-auto ${s.color}`}>{s.label}</span>
                </div>
                {/* 进度条: 陪审完成度 */}
                {c.jurors && c.jurors.total > 0 && (
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <div className="flex-1 h-1 bg-border-light rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all ${
                          jurorProgress === 100
                            ? (c.jurors.allow > c.jurors.deny ? 'bg-success' : c.jurors.deny > c.jurors.allow ? 'bg-danger' : 'bg-warning')
                            : 'bg-primary/60'
                        }`}
                        style={{ width: `${jurorProgress}%` }}
                      />
                    </div>
                    <span className="text-[9px] text-text-secondary font-mono shrink-0 tabular-nums">
                      {c.jurors.allow + c.jurors.deny + c.jurors.abstain}/{c.jurors.total}
                    </span>
                  </div>
                )}
              </div>
              {/* 展开详情 */}
              {isOpen && (
                <div className="px-2 pb-2 border-t border-border-light pt-1.5 space-y-1.5 animate-fade-in">
                  {/* 陪审投票分布 */}
                  {c.jurors && (
                    <div className="space-y-0.5">
                      <div className="text-[9px] uppercase text-text-secondary font-semibold">陪审投票</div>
                      <div className="flex items-center gap-0.5 h-2">
                        <div className="bg-success rounded-sm" style={{ flex: c.jurors.allow }} title={`通过 ${c.jurors.allow}`} />
                        <div className="bg-danger rounded-sm" style={{ flex: c.jurors.deny }} title={`否决 ${c.jurors.deny}`} />
                        <div className="bg-text-secondary/40 rounded-sm" style={{ flex: c.jurors.abstain }} title={`弃权 ${c.jurors.abstain}`} />
                      </div>
                      <div className="flex items-center gap-2 text-[9px] font-mono">
                        <span className="text-success">通过 {c.jurors.allow}</span>
                        <span className="text-danger">否决 {c.jurors.deny}</span>
                        {c.jurors.abstain > 0 && <span className="text-text-secondary">弃权 {c.jurors.abstain}</span>}
                      </div>
                    </div>
                  )}
                  {/* 元数据 */}
                  <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] font-mono">
                    {c.evidence !== undefined && (
                      <>
                        <span className="text-text-secondary">证据</span>
                        <span className="text-text">{c.evidence} 条</span>
                      </>
                    )}
                    {c.createdAt && (
                      <>
                        <span className="text-text-secondary">创建</span>
                        <span className="text-text-secondary">{c.createdAt}</span>
                      </>
                    )}
                    {c.verdict && (
                      <>
                        <span className="text-text-secondary">裁决</span>
                        <span className={c.verdict === 'allow' ? 'text-success' : 'text-danger'}>{c.verdict}</span>
                      </>
                    )}
                  </div>
                  {/* 操作 */}
                  <div className="flex items-center gap-1 pt-1">
                    <Button size="xs" variant="ghost" icon="visibility" >详情</Button>
                    {c.status === 'active' && (
                      <Button size="xs" variant="ghost" icon="gavel">投票</Button>
                    )}
                    {(c.status === 'review' || c.status === 'escalated') && (
                      <Button size="xs" variant="outline" icon="trending_up">升级处理</Button>
                    )}
                    {c.status === 'pending' && (
                      <Button size="xs" variant="primary" icon="play_arrow">启动</Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── 组件面板 ───
export function AgentsPanel() {
  const { agents } = useBackend();
  return (
    <div className="flex flex-col h-full">
      <PanelHeader
        icon="smart_toy"
        title="组件"
        count={<Badge variant="primary">{agents.filter(a => a.status === 'running').length}/{agents.length}</Badge>}
        action={
          <Tooltip content="刷新">
            <IconButton icon="refresh" size="xs" />
          </Tooltip>
        }
      />
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5 scrollbar-thin">
        {agents.length === 0 ? (
          <EmptyState icon="smart_toy" title="暂无组件数据" hint="等待后端响应" />
        ) : (
          agents.map(a => (
            <div key={a.id} className="p-2 bg-surface rounded-lg border border-border hover:border-primary/50 cursor-pointer">
              <div className="flex items-center gap-1.5 mb-1">
                <StatusDot status={a.status === 'running' ? 'running' : a.status === 'error' ? 'error' : 'idle'} pulse={a.status === 'running'} />
                <span className="text-xs font-semibold text-text truncate flex-1">{a.name}</span>
                <Badge variant="default" className="text-[9px]">{a.type}</Badge>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-text-secondary font-mono">
                <span>{a.id}</span>
                <span>·</span>
                <span>{a.tasks} 任务</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
