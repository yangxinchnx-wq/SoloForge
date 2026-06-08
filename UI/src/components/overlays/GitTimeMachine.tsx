// ─────────────────────────────────────────────────────────────────
// Git 时光机 — 文件历史与回滚
// - 模拟 git log: 50 条提交,带作者/时间/分支
// - 文件级历史 (按 path 过滤)
// - Diff 查看 (统一格式, +/- 高亮)
// - 任意 commit 一键回滚 (生成 reset patch)
// - 分支图 + 标签
// - 支持 stash / cherry-pick / blame 模式
// ─────────────────────────────────────────────────────────────────

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';

// ── 类型 ──
interface GitCommit {
  id: string;
  shortId: string;
  author: { name: string; avatar: string; email: string };
  ts: number;
  message: string;
  branch: string;
  tags?: string[];
  filesChanged: number;
  additions: number;
  deletions: number;
  parents: string[];
  /** 简化 diff: +行 / -行 */
  diff: Array<{ type: 'add' | 'del' | 'ctx'; line: string; oldNum?: number; newNum?: number }>;
  files: Array<{ path: string; status: 'M' | 'A' | 'D' | 'R'; additions: number; deletions: number }>;
}

interface GitBranch {
  name: string;
  current: boolean;
  ahead: number;
  behind: number;
  lastCommitId: string;
  color: string;
}

interface StashEntry {
  id: string;
  ts: number;
  message: string;
  filesCount: number;
  branch: string;
}

// ── 模拟数据 ──
const AUTHORS = [
  { name: 'Alice林',  avatar: '🦊', email: 'alice@soloforge.dev' },
  { name: 'Bob陈',    avatar: '🐼', email: 'bob@soloforge.dev' },
  { name: 'Carol王',  avatar: '🦉', email: 'carol@soloforge.dev' },
  { name: 'David李',  avatar: '🐯', email: 'david@soloforge.dev' },
  { name: 'Eve周',    avatar: '🐰', email: 'eve@soloforge.dev' },
];

const BRANCH_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#a855f7', '#ef4444', '#06b6d4'];

const COMMIT_MESSAGES = [
  'feat: 添加决策链路优化',
  'fix: 修复内存泄漏 (issue #42)',
  'refactor: 拆分 UserService',
  'docs: 更新 README',
  'chore: 升级依赖到 v2.3',
  'feat(api): 新增 /api/governor/snapshot',
  'test: 补全 CourtSubmission 测试',
  'perf: 数据库查询添加索引',
  'feat(ui): 添加快捷键 Ctrl+Shift+L',
  'fix: 修复重启时配置丢失',
  'feat(agent): 实现 PreferenceLearner',
  'style: 统一代码格式化',
  'revert: 回滚 #123 的改动',
  'feat: 集成 OpenTelemetry',
  'fix(court): 修复证据哈希校验',
  'chore: 清理废弃迁移',
  'feat: 真实命令执行 (executeCommand)',
  'feat(ui): 拖出独立窗口',
  'refactor: 拆分 schema 校验逻辑',
  'docs: 添加架构图',
];

const FILE_PATHS = [
  'src/index.ts', 'src/App.tsx', 'src/api/client.ts', 'src/api/terminal.ts',
  'src/hooks/useChat.ts', 'src/hooks/useBackend.ts',
  'src/components/overlays/CodeReview.tsx', 'src/components/overlays/TaskScheduler.tsx',
  'src/components/overlays/CollabCursors.tsx', 'src/components/overlays/BreakpointDebugger.tsx',
  'src/components/overlays/PluginRegistry.tsx', 'src/components/overlays/SnippetsManager.tsx',
  'src/components/overlays/SurrealExplorer.tsx', 'src/components/overlays/DetachedWindow.tsx',
  'migrations/v5_events.surql', 'rust_core/src/scheduler.rs',
  'README.md', 'package.json',
];

function rand<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

function generateCommits(): GitCommit[] {
  const commits: GitCommit[] = [];
  const now = Date.now();
  let parents: string[] = [];
  for (let i = 0; i < 50; i++) {
    const id = 'c' + (100000 + i).toString(36) + Math.random().toString(36).slice(2, 6);
    const shortId = id.slice(0, 7);
    const author = rand(AUTHORS);
    const branchIdx = Math.min(Math.floor(i / 10), 4);
    const branch = ['main', 'feature/review', 'fix/terminal', 'feature/ai-pair', 'chore/cleanup'][branchIdx];
    const filesCount = 1 + Math.floor(Math.random() * 4);
    const files = Array.from({ length: filesCount }, () => {
      const path = rand(FILE_PATHS);
      const status: 'M' | 'A' | 'D' | 'R' = Math.random() < 0.6 ? 'M' : Math.random() < 0.5 ? 'A' : 'D';
      return { path, status, additions: Math.floor(Math.random() * 30), deletions: Math.floor(Math.random() * 20) };
    });
    const additions = files.reduce((a, f) => a + f.additions, 0);
    const deletions = files.reduce((a, f) => a + f.deletions, 0);
    // 简单 diff (前几行 ctx, + 几行, - 几行)
    const diff: GitCommit['diff'] = [];
    let oldNum = 1, newNum = 1;
    for (let l = 0; l < 8; l++) {
      if (Math.random() < 0.3) {
        const t = Math.random() < 0.5 ? 'add' : 'del';
        diff.push({ type: t, line: (t === 'add' ? '+' : '-') + '  generated line ' + l, oldNum: t === 'del' ? oldNum++ : undefined, newNum: t === 'add' ? newNum++ : undefined });
      } else {
        diff.push({ type: 'ctx', line: '   existing line ' + l, oldNum: oldNum++, newNum: newNum++ });
      }
    }
    commits.push({
      id, shortId,
      author, ts: now - i * 3600_000 - Math.floor(Math.random() * 1800_000),
      message: rand(COMMIT_MESSAGES),
      branch,
      tags: i === 0 ? ['HEAD', 'main'] : i === 3 ? ['v0.9.0'] : i === 12 ? ['v1.0.0'] : i === 25 ? ['v1.1.0'] : undefined,
      filesChanged: files.length, additions, deletions,
      parents: i === 0 || i === 10 || i === 20 || i === 30 ? [] : parents.slice(-1),
      diff, files,
    });
    parents = [id];
  }
  return commits;
}

function generateBranches(commits: GitCommit[]): GitBranch[] {
  return ['main', 'feature/review', 'fix/terminal', 'feature/ai-pair'].map((name, i) => {
    const branchCommits = commits.filter(c => c.branch === name);
    return {
      name, current: name === 'main',
      ahead: name === 'main' ? 0 : Math.floor(Math.random() * 5),
      behind: name === 'main' ? 0 : Math.floor(Math.random() * 3),
      lastCommitId: branchCommits[0]?.id || commits[0].id,
      color: BRANCH_COLORS[i % BRANCH_COLORS.length],
    };
  });
}

function generateStashes(): StashEntry[] {
  return [
    { id: 's1', ts: Date.now() - 3600_000, message: 'WIP: 新功能调试中', filesCount: 3, branch: 'feature/ai-pair' },
    { id: 's2', ts: Date.now() - 86400_000, message: '临时: 重构中', filesCount: 5, branch: 'main' },
    { id: 's3', ts: Date.now() - 172800_000, message: '测试代码', filesCount: 2, branch: 'feature/review' },
  ];
}

// ─── 主组件 ───
interface Props {
  open: boolean;
  onClose: () => void;
  initialFile?: string;
  onCheckoutCommit?: (commitId: string) => void;
}

export function GitTimeMachine({ open, onClose, initialFile, onCheckoutCommit }: Props) {
  const [commits] = useState<GitCommit[]>(() => generateCommits());
  const [branches] = useState<GitBranch[]>(() => generateBranches(commits));
  const [stashes] = useState<StashEntry[]>(generateStashes);
  const [selectedId, setSelectedId] = useState<string | null>(commits[0]?.id || null);
  const [fileFilter, setFileFilter] = useState<string>(initialFile || '');
  const [authorFilter, setAuthorFilter] = useState<string>('all');
  const [branchFilter, setBranchFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'commits' | 'graph' | 'stash' | 'blame'>('commits');
  const [compareBase, setCompareBase] = useState<string | null>(null);
  const [revertConfirmId, setRevertConfirmId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return commits.filter(c => {
      if (branchFilter !== 'all' && c.branch !== branchFilter) return false;
      if (authorFilter !== 'all' && c.author.name !== authorFilter) return false;
      if (fileFilter && !c.files.some(f => f.path.toLowerCase().includes(fileFilter.toLowerCase()))) return false;
      if (search && !c.message.toLowerCase().includes(search.toLowerCase()) && !c.shortId.includes(search)) return false;
      return true;
    });
  }, [commits, branchFilter, authorFilter, fileFilter, search]);

  const selected = useMemo(() => commits.find(c => c.id === selectedId) || null, [commits, selectedId]);
  const compareCommit = useMemo(() => compareBase ? commits.find(c => c.id === compareBase) || null : null, [commits, compareBase]);

  const revertTo = useCallback((id: string) => {
    if (!confirm('确认回滚到此 commit?\n\n这将生成一个 revert patch 并应用到当前分支。')) return;
    alert('✓ 已生成 revert patch:\n\ngit revert --no-commit ' + id + '\n\n(模拟)');
    onCheckoutCommit?.(id);
  }, [onCheckoutCommit]);

  const cherryPick = useCallback((id: string) => {
    if (!confirm('Cherry-pick 此 commit 到当前分支?')) return;
    alert('✓ 已应用:\n\ngit cherry-pick ' + id + '\n\n(模拟)');
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[min(98vw,1240px)] h-[min(94vh,820px)] bg-bg-elevated border border-border rounded-xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center px-4 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">history</span>
            <h2 className="text-base font-semibold">Git 时光机</h2>
            <span className="text-xs text-text-secondary ml-2">
              {commits.length} commits · {branches.length} 分支 · {stashes.length} stashes
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {([
              { id: 'commits', label: '历史', icon: 'list' },
              { id: 'graph',   label: '图谱', icon: 'account_tree' },
              { id: 'stash',   label: 'Stash', icon: 'inventory_2' },
              { id: 'blame',   label: 'Blame', icon: 'assignment_ind' },
            ] as const).map(t => (
              <button
                key={t.id}
                onClick={() => setView(t.id)}
                className={'px-2.5 py-1 text-xs rounded border flex items-center gap-1 ' +
                  (view === t.id ? 'border-primary text-primary bg-primary/10' : 'border-border hover:bg-bg-dim')}
              >
                <span className="material-symbols-outlined text-sm">{t.icon}</span>
                {t.label}
              </button>
            ))}
            <button onClick={onClose} className="px-2 py-1 rounded hover:bg-bg-dim text-text-secondary ml-1">
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          </div>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* 左: 分支 + 筛选 */}
          <div className="w-56 border-r border-border flex flex-col shrink-0">
            <div className="px-3 py-2 text-xs text-text-secondary uppercase tracking-wide border-b border-border">分支</div>
            <div className="px-2 py-1 space-y-0.5 border-b border-border">
              <button
                onClick={() => setBranchFilter('all')}
                className={'w-full px-2 py-1 text-xs rounded text-left flex items-center gap-1.5 ' +
                  (branchFilter === 'all' ? 'bg-primary/15 text-primary' : 'hover:bg-bg-dim')}
              >
                <span className="material-symbols-outlined text-sm">dehaze</span>
                全部 ({commits.length})
              </button>
              {branches.map(b => (
                <button
                  key={b.name}
                  onClick={() => setBranchFilter(b.name)}
                  className={'w-full px-2 py-1 text-xs rounded text-left flex items-center gap-1.5 ' +
                    (branchFilter === b.name ? 'bg-primary/15 text-primary' : 'hover:bg-bg-dim')}
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: b.color }} />
                  <span className="truncate font-mono">{b.name}</span>
                  {b.current && <span className="ml-auto text-[10px] text-text-secondary">●</span>}
                </button>
              ))}
            </div>

            <div className="px-3 py-2 text-xs text-text-secondary uppercase tracking-wide border-b border-border border-t">作者</div>
            <div className="px-2 py-1 space-y-0.5">
              <button
                onClick={() => setAuthorFilter('all')}
                className={'w-full px-2 py-1 text-xs rounded text-left ' +
                  (authorFilter === 'all' ? 'bg-primary/15 text-primary' : 'hover:bg-bg-dim')}
              >
                全部
              </button>
              {AUTHORS.map(a => (
                <button
                  key={a.name}
                  onClick={() => setAuthorFilter(a.name)}
                  className={'w-full px-2 py-1 text-xs rounded text-left flex items-center gap-1.5 ' +
                    (authorFilter === a.name ? 'bg-primary/15 text-primary' : 'hover:bg-bg-dim')}
                >
                  <span>{a.avatar}</span>
                  <span className="truncate">{a.name}</span>
                </button>
              ))}
            </div>

            <div className="px-3 py-2 text-xs text-text-secondary uppercase tracking-wide border-b border-border border-t">筛选</div>
            <div className="p-2 space-y-1.5">
              <input
                type="text"
                value={fileFilter}
                onChange={e => setFileFilter(e.target.value)}
                placeholder="文件路径..."
                className="w-full px-2 py-1 rounded border border-border bg-bg text-xs"
              />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="搜索消息或 commit ID..."
                className="w-full px-2 py-1 rounded border border-border bg-bg text-xs"
              />
            </div>
          </div>

          {/* 中: 提交列表 */}
          {view !== 'stash' && view !== 'blame' && (
            <div className="w-96 border-r border-border flex flex-col shrink-0">
              <div className="px-3 py-1.5 border-b border-border text-xs text-text-secondary flex items-center gap-2">
                <span>显示 {filtered.length} 条</span>
                {compareBase && (
                  <span className="text-warning">对比: {commits.find(c => c.id === compareBase)?.shortId}</span>
                )}
                {compareBase && (
                  <button onClick={() => setCompareBase(null)} className="ml-auto text-text-secondary hover:text-text">× 取消对比</button>
                )}
              </div>
              <div className="flex-1 overflow-auto">
                {filtered.length === 0 && <div className="px-3 py-6 text-center text-xs text-text-secondary">无匹配 commit</div>}
                {filtered.map(c => (
                  <div
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    onDoubleClick={() => revertTo(c.id)}
                    className={'px-3 py-2 border-b border-border/50 cursor-pointer hover:bg-bg-dim ' +
                      (selectedId === c.id ? 'bg-primary/10 border-l-2 border-l-primary' : '')}
                  >
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="font-mono text-text-secondary">{c.shortId}</span>
                      <span className="text-text">{c.author.avatar}</span>
                      <span className="text-text-secondary">{c.author.name}</span>
                      <span className="ml-auto text-text-secondary text-[10px]">{relTime(c.ts)}</span>
                    </div>
                    <div className="text-sm mt-0.5 truncate">{c.message}</div>
                    <div className="flex items-center gap-2 mt-0.5 text-[10px] text-text-secondary">
                      <span className="font-mono" style={{ color: branches.find(b => b.name === c.branch)?.color }}>{c.branch}</span>
                      <span>·</span>
                      <span className="text-success">+{c.additions}</span>
                      <span className="text-danger">-{c.deletions}</span>
                      {c.tags && c.tags.length > 0 && (
                        <>
                          <span>·</span>
                          {c.tags.filter(t => t !== 'HEAD').map(t => (
                            <span key={t} className="px-1 rounded bg-primary/15 text-primary">{t}</span>
                          ))}
                        </>
                      )}
                      <div className="ml-auto flex items-center gap-1">
                        <button
                          onClick={e => { e.stopPropagation(); setCompareBase(c.id); }}
                          className="hover:text-text"
                          title="设为对比基准"
                        >⇄</button>
                        <button
                          onClick={e => { e.stopPropagation(); cherryPick(c.id); }}
                          className="hover:text-text"
                          title="Cherry-pick"
                        >⊕</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 右: 详情 */}
          <div className="flex-1 flex flex-col min-w-0">
            {view === 'commits' && selected && (
              <CommitDetail commit={selected} compareWith={compareCommit} />
            )}
            {view === 'graph' && (
              <GraphView commits={filtered} branches={branches} selectedId={selectedId} onSelect={setSelectedId} />
            )}
            {view === 'stash' && (
              <StashView stashes={stashes} />
            )}
            {view === 'blame' && selected && (
              <BlameView commit={selected} filePath={fileFilter || selected.files[0]?.path || ''} />
            )}
            {view === 'commits' && !selected && (
              <div className="flex-1 flex items-center justify-center text-text-secondary text-sm">从左侧选择 commit</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CommitDetail({ commit, compareWith }: { commit: GitCommit; compareWith: GitCommit | null }) {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold">{commit.message}</h3>
          <span className="font-mono text-xs text-text-secondary">{commit.shortId}</span>
        </div>
        <div className="flex items-center gap-3 mt-1.5 text-xs text-text-secondary">
          <span>{commit.author.avatar} <span className="text-text">{commit.author.name}</span> &lt;{commit.author.email}&gt;</span>
          <span>·</span>
          <span>{new Date(commit.ts).toLocaleString('zh-CN')}</span>
          <span>·</span>
          <span>{relTime(commit.ts)}</span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button className="px-2 py-1 text-xs rounded border border-border hover:bg-bg-dim flex items-center gap-1">
            <span className="material-symbols-outlined text-sm">undo</span>
            Revert
          </button>
          <button className="px-2 py-1 text-xs rounded border border-border hover:bg-bg-dim flex items-center gap-1">
            <span className="material-symbols-outlined text-sm">add_circle</span>
            Cherry-pick
          </button>
          <button className="px-2 py-1 text-xs rounded border border-border hover:bg-bg-dim flex items-center gap-1">
            <span className="material-symbols-outlined text-sm">file_download</span>
            Patch
          </button>
          <button className="px-2 py-1 text-xs rounded border border-border hover:bg-bg-dim flex items-center gap-1">
            <span className="material-symbols-outlined text-sm">tag</span>
            打标签
          </button>
        </div>
      </div>

      <div className="px-4 py-2 border-b border-border">
        <div className="text-xs text-text-secondary mb-1.5">{commit.filesChanged} 个文件变更 · <span className="text-success">+{commit.additions}</span> <span className="text-danger">-{commit.deletions}</span></div>
        <div className="space-y-0.5">
          {commit.files.map(f => (
            <div key={f.path} className="flex items-center gap-2 text-xs px-2 py-0.5 hover:bg-bg-dim rounded group">
              <span className={
                'w-4 text-center font-mono ' +
                (f.status === 'A' ? 'text-success' : f.status === 'D' ? 'text-danger' : f.status === 'R' ? 'text-warning' : 'text-text-secondary')
              }>{f.status}</span>
              <span className="font-mono text-text truncate flex-1">{f.path}</span>
              <span className="text-success text-[10px]">+{f.additions}</span>
              <span className="text-danger text-[10px]">-{f.deletions}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-bg-dim/30 font-mono text-xs">
        {commit.diff.map((d, i) => (
          <div
            key={i}
            className={
              'flex items-start gap-2 px-3 py-0.5 ' +
              (d.type === 'add' ? 'bg-success/10 text-success' :
               d.type === 'del' ? 'bg-danger/10 text-danger' :
               'text-text-secondary')
            }
          >
            <span className="w-8 text-right text-text-secondary/40">{d.oldNum || ''}</span>
            <span className="w-8 text-right text-text-secondary/40">{d.newNum || ''}</span>
            <span className="w-3 text-center font-bold">
              {d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' '}
            </span>
            <span className="whitespace-pre flex-1">{d.line.replace(/^[-+]\s+/, '')}</span>
          </div>
        ))}
      </div>

      {compareWith && (
        <div className="border-t border-border bg-warning/5 p-2 text-xs text-text-secondary">
          <span className="text-warning">ⓘ</span> 对比基准: {compareWith.shortId} ({compareWith.message})
        </div>
      )}
    </div>
  );
}

function GraphView({ commits, branches, selectedId, onSelect }: any) {
  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="text-xs text-text-secondary mb-3">提交图谱 (按时间倒序) · 颜色 = 分支</div>
      <div className="space-y-0.5">
        {commits.map((c: GitCommit, i: number) => {
          const branch = branches.find((b: GitBranch) => b.name === c.branch);
          return (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={'w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-bg-dim ' + (selectedId === c.id ? 'bg-primary/10' : '')}
            >
              {/* 图节点 */}
              <div className="w-6 flex flex-col items-center shrink-0">
                <div className="w-2.5 h-2.5 rounded-full border-2" style={{
                  borderColor: branch?.color || '#6b7280',
                  backgroundColor: c.id === commits[0]?.id ? branch?.color : 'transparent',
                }} />
                {i < commits.length - 1 && <div className="w-0.5 flex-1 mt-0.5" style={{ backgroundColor: branch?.color, opacity: 0.4 }} />}
              </div>
              <div className="flex-1 min-w-0 text-left">
                <div className="text-sm truncate flex items-center gap-1.5">
                  <span className="font-mono text-xs text-text-secondary">{c.shortId}</span>
                  <span>{c.message}</span>
                </div>
                <div className="text-[10px] text-text-secondary">
                  <span className="font-mono" style={{ color: branch?.color }}>{c.branch}</span>
                  <span className="mx-1">·</span>
                  <span>{c.author.avatar} {c.author.name}</span>
                  <span className="mx-1">·</span>
                  <span>{relTime(c.ts)}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StashView({ stashes }: { stashes: StashEntry[] }) {
  return (
    <div className="flex-1 p-4">
      <div className="text-sm text-text-secondary mb-3">Stash 列表 · 点击恢复</div>
      <div className="space-y-1">
        {stashes.map(s => (
          <div key={s.id} className="px-3 py-2 rounded border border-border hover:bg-bg-dim flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">inventory_2</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">{s.message}</div>
              <div className="text-xs text-text-secondary">{s.branch} · {s.filesCount} 文件 · {new Date(s.ts).toLocaleString('zh-CN')}</div>
            </div>
            <button className="px-2 py-1 text-xs rounded border border-border hover:bg-bg-dim">Pop</button>
            <button className="px-2 py-1 text-xs rounded border border-border hover:bg-bg-dim">Apply</button>
            <button className="px-2 py-1 text-xs rounded border border-border hover:bg-danger/15 hover:text-danger">Drop</button>
          </div>
        ))}
        {stashes.length === 0 && <div className="text-center text-text-secondary py-8 text-sm">Stash 列表为空</div>}
      </div>
    </div>
  );
}

function BlameView({ commit, filePath }: { commit: GitCommit; filePath: string }) {
  // 模拟 30 行 blame
  const lines = Array.from({ length: 30 }, (_, i) => ({
    lineNum: i + 1,
    text: '// generated line ' + (i + 1) + ' — this is a sample content',
  }));
  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="text-sm text-text-secondary mb-2 flex items-center gap-2">
        <span className="material-symbols-outlined text-sm">assignment_ind</span>
        <span className="font-mono text-primary">{filePath}</span>
        <span>·</span>
        <span>@{commit.shortId}</span>
      </div>
      <div className="font-mono text-xs border border-border rounded">
        {lines.map((l, i) => {
          const author = AUTHORS[i % AUTHORS.length];
          const ts = commit.ts - (30 - i) * 60000;
          return (
            <div key={i} className="flex items-start gap-2 px-2 py-0.5 hover:bg-bg-dim border-b border-border/30">
              <div className="w-8 text-right text-text-secondary/50 select-none">{l.lineNum}</div>
              <div className="w-32 flex items-center gap-1 text-text-secondary text-[10px] shrink-0">
                <span>{author.avatar}</span>
                <span className="truncate">{author.name}</span>
                <span className="ml-auto text-text-secondary/60">{new Date(ts).toLocaleDateString('zh-CN')}</span>
              </div>
              <div className="flex-1 text-text whitespace-pre truncate">{l.text}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}
