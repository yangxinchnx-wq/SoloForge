// ─────────────────────────────────────────────────────────────────
// Git Worktree 管理 — GitWorktree
// - 多 worktree 并行开发
// - 分支关联与状态
// - PR 关联
// - 磁盘占用分析
// - 跨 worktree cherry-pick
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface Worktree {
  id: string;
  path: string;
  branch: string;
  commit: string;
  pr?: { number: number; title: string; status: 'open' | 'merged' | 'closed' | 'draft'; author: string; review: 'approved' | 'changes_requested' | 'pending' };
  status: 'clean' | 'modified' | 'untracked' | 'conflict' | 'ahead' | 'behind';
  aheadBy: number;
  behindBy: number;
  lastActivity: number;
  diskSize: number;     // MB
  files: number;
  isMain: boolean;
  isLocked: boolean;
}

const WORKTREES: Worktree[] = [
  { id: 'w1', path: '~/projects/soloforge',                         branch: 'main',                 commit: 'a3f5d2c', status: 'clean',     aheadBy: 0,  behindBy: 0,  lastActivity: Date.now() - 1800000,  diskSize: 1240, files: 1247, isMain: true,  isLocked: true,  pr: { number: 142, title: 'feat: 用户认证模块', status: 'merged',  author: 'Alice Chen',  review: 'approved' } },
  { id: 'w2', path: '~/projects/soloforge.wt-feature-auth',         branch: 'feature/user-auth',     commit: 'b8c9e1f', status: 'modified',  aheadBy: 12, behindBy: 2,  lastActivity: Date.now() - 300000,   diskSize: 1280, files: 1256, isMain: false, isLocked: false, pr: { number: 158, title: 'feat: OAuth2 集成', status: 'open',  author: 'Bob Wang',    review: 'changes_requested' } },
  { id: 'w3', path: '~/projects/soloforge.wt-bugfix-1234',          branch: 'bugfix/issue-1234',    commit: 'd2e4f5a', status: 'clean',     aheadBy: 3,  behindBy: 5,  lastActivity: Date.now() - 7200000,  diskSize: 1245, files: 1248, isMain: false, isLocked: false, pr: { number: 161, title: 'fix: 数据库连接池泄漏', status: 'open', author: 'Carol Liu',  review: 'pending' } },
  { id: 'w4', path: '~/projects/soloforge.wt-experiment-llm',       branch: 'experiment/llm-eval',  commit: 'f7g8h9i', status: 'untracked', aheadBy: 0,  behindBy: 0,  lastActivity: Date.now() - 60000,    diskSize: 1310, files: 1267, isMain: false, isLocked: false },
  { id: 'w5', path: '~/projects/soloforge.wt-release-v2',           branch: 'release/v2.0',         commit: 'j1k2l3m', status: 'ahead',     aheadBy: 24, behindBy: 0,  lastActivity: Date.now() - 3600000,  diskSize: 1265, files: 1253, isMain: false, isLocked: true },
  { id: 'w6', path: '~/projects/soloforge.wt-feature-ui-redesign',  branch: 'feature/ui-redesign',  commit: 'n4o5p6q', status: 'conflict',  aheadBy: 45, behindBy: 12, lastActivity: Date.now() - 86400000, diskSize: 1295, files: 1271, isMain: false, isLocked: false, pr: { number: 145, title: 'refactor: UI redesign', status: 'draft', author: 'David Zhang', review: 'pending' } },
  { id: 'w7', path: '~/projects/soloforge.wt-scratch',              branch: 'scratch/test-idea',    commit: 'r7s8t9u', status: 'behind',    aheadBy: 0,  behindBy: 18, lastActivity: Date.now() - 172800000,diskSize: 1248, files: 1249, isMain: false, isLocked: false },
];

function statusVariant(s: Worktree['status']): 'success' | 'info' | 'warning' | 'danger' | 'default' {
  return s === 'clean' ? 'success' : s === 'modified' ? 'info' : s === 'untracked' ? 'info' : s === 'ahead' ? 'info' : s === 'behind' ? 'warning' : s === 'conflict' ? 'danger' : 'default';
}
function statusLabel(s: Worktree['status']): string {
  return { clean: '干净', modified: '已修改', untracked: '未跟踪', conflict: '冲突', ahead: '领先', behind: '落后' }[s];
}
function prVariant(s: Worktree['pr'] extends infer P ? P extends { status: infer S } ? S : never : never): 'success' | 'info' | 'warning' | 'default' | 'danger' {
  return s === 'merged' ? 'success' : s === 'open' ? 'info' : s === 'closed' ? 'danger' : 'warning';
}

export function GitWorktree({ open, onClose }: Props) {
  const [tab, setTab] = useState<'list' | 'branches' | 'prs' | 'disk'>('list');
  const [activeId, setActiveId] = useState<string>(WORKTREES[1].id);
  const active = WORKTREES.find(w => w.id === activeId) || WORKTREES[0];

  const totalDisk = WORKTREES.reduce((s, w) => s + w.diskSize, 0);
  const conflicts = WORKTREES.filter(w => w.status === 'conflict').length;
  const openPrs = WORKTREES.filter(w => w.pr && w.pr.status === 'open').length;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">account_tree</span>
          <h2 className="text-sm font-semibold text-text">Git Worktree 管理</h2>
          <Badge variant="info">{WORKTREES.length} worktrees</Badge>
          <Badge variant="success">{WORKTREES.filter(w => w.status === 'clean').length} 干净</Badge>
          {conflicts > 0 && <Badge variant="danger">{conflicts} 冲突</Badge>}
          {openPrs > 0 && <Badge variant="info">{openPrs} PR</Badge>}
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="add" variant="primary">新建 worktree</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'list',     l: `Worktrees (${WORKTREES.length})` },
            { k: 'branches', l: '分支' },
            { k: 'prs',      l: `Pull Requests (${WORKTREES.filter(w => w.pr).length})` },
            { k: 'disk',     l: '磁盘分析' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-80 border-r border-border bg-bg overflow-y-auto">
            {tab === 'list' && WORKTREES.map(w => (
              <div key={w.id} onClick={() => setActiveId(w.id)}
                className={'px-3 py-2 border-b border-border-light cursor-pointer hover:bg-surface-high ' + (activeId === w.id ? 'bg-accent/10 border-l-2 border-l-accent' : '')}>
                <div className="flex items-center gap-1 mb-1">
                  <Badge variant={statusVariant(w.status)}>{statusLabel(w.status)}</Badge>
                  {w.isMain && <Badge variant="info">main</Badge>}
                  {w.isLocked && <span className="material-symbols-outlined text-sm text-text-secondary">lock</span>}
                </div>
                <code className="text-[11px] font-mono text-text font-medium block">{w.branch}</code>
                <div className="text-[10px] text-text-secondary mt-0.5 flex items-center gap-1">
                  <code className="font-mono">{w.commit}</code>
                  {w.aheadBy > 0 && <span className="text-success">↑{w.aheadBy}</span>}
                  {w.behindBy > 0 && <span className="text-warning">↓{w.behindBy}</span>}
                  <span className="ml-auto">{w.diskSize} MB</span>
                </div>
              </div>
            ))}
          </div>

          <div className="flex-1 overflow-auto p-3 space-y-3">
            {tab === 'list' && (
              <>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <code className="text-sm font-mono font-bold text-text">{active.branch}</code>
                    <Badge variant={statusVariant(active.status)}>{statusLabel(active.status)}</Badge>
                    {active.isMain && <Badge variant="info">主 worktree</Badge>}
                    {active.isLocked && <Badge variant="warning">已锁定</Badge>}
                  </div>
                  <p className="text-[10px] text-text-secondary font-mono mb-3">{active.path}</p>
                  <div className="grid grid-cols-4 gap-3 text-[11px]">
                    <div><p className="text-[10px] text-text-secondary">最新提交</p><code className="text-text">{active.commit}</code></div>
                    <div><p className="text-[10px] text-text-secondary">领先</p><p className="text-success font-mono">↑ {active.aheadBy}</p></div>
                    <div><p className="text-[10px] text-text-secondary">落后</p><p className="text-warning font-mono">↓ {active.behindBy}</p></div>
                    <div><p className="text-[10px] text-text-secondary">最后活动</p><p className="text-text">{new Date(active.lastActivity).toLocaleString()}</p></div>
                    <div><p className="text-[10px] text-text-secondary">文件数</p><p className="text-text font-mono">{active.files}</p></div>
                    <div><p className="text-[10px] text-text-secondary">磁盘占用</p><p className="text-text font-mono">{active.diskSize} MB</p></div>
                  </div>
                </div>

                {active.pr && (
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h3 className="text-xs font-semibold text-text mb-2">关联 Pull Request</h3>
                    <div className="flex items-center gap-2">
                      <Badge variant={prVariant(active.pr.status)}>{active.pr.status}</Badge>
                      <code className="text-[11px] font-mono text-text">#{active.pr.number}</code>
                      <span className="text-[11px] text-text">{active.pr.title}</span>
                    </div>
                    <div className="mt-2 flex items-center gap-3 text-[10px] text-text-secondary">
                      <span>by {active.pr.author}</span>
                      <span>·</span>
                      <Badge variant={active.pr.review === 'approved' ? 'success' : active.pr.review === 'changes_requested' ? 'danger' : 'warning'}>{active.pr.review}</Badge>
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-2 flex-wrap">
                  <Button size="sm" icon="terminal">打开终端</Button>
                  <Button size="sm" icon="code">在编辑器打开</Button>
                  <Button size="sm" icon="sync">同步</Button>
                  <Button size="sm" icon="merge" variant="primary">合并</Button>
                  <Button size="sm" icon="undo">回滚</Button>
                  <Button size="sm" icon="lock">锁定</Button>
                  <Button size="sm" icon="delete" variant="danger">删除</Button>
                </div>
              </>
            )}

            {tab === 'branches' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">分支工作树关联</h3>
                <div className="space-y-1.5">
                  {WORKTREES.map(w => (
                    <div key={w.id} className="flex items-center gap-2 p-2 bg-surface-high rounded">
                      <code className="text-[11px] font-mono text-text flex-1">{w.branch}</code>
                      <Badge variant={statusVariant(w.status)}>{statusLabel(w.status)}</Badge>
                      <span className="text-[10px] text-text-secondary">{w.commit}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === 'prs' && (
              <div className="space-y-2">
                {WORKTREES.filter(w => w.pr).map(w => w.pr && (
                  <div key={w.id} className="bg-bg border border-border-light rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-1.5">
                      <Badge variant={prVariant(w.pr!.status)}>{w.pr!.status}</Badge>
                      <code className="text-[11px] font-mono text-text">#{w.pr!.number}</code>
                      <Badge variant={w.pr!.review === 'approved' ? 'success' : w.pr!.review === 'changes_requested' ? 'danger' : 'warning'}>{w.pr!.review}</Badge>
                      <span className="text-[10px] text-text-secondary ml-auto">by {w.pr!.author}</span>
                    </div>
                    <p className="text-sm font-medium text-text">{w.pr!.title}</p>
                    <code className="text-[10px] text-text-secondary font-mono">{w.branch}</code>
                  </div>
                ))}
              </div>
            )}

            {tab === 'disk' && (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <p className="text-[10px] text-text-secondary">总占用</p>
                    <p className="text-2xl font-bold text-text font-mono mt-1">{(totalDisk / 1024).toFixed(2)} GB</p>
                    <p className="text-[10px] text-text-secondary">across {WORKTREES.length} worktrees</p>
                  </div>
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <p className="text-[10px] text-text-secondary">节省空间</p>
                    <p className="text-2xl font-bold text-success font-mono mt-1">{(totalDisk * (WORKTREES.length - 1) / 1024).toFixed(2)} GB</p>
                    <p className="text-[10px] text-text-secondary">相比 clone 多个仓库</p>
                  </div>
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <p className="text-[10px] text-text-secondary">平均 worktree</p>
                    <p className="text-2xl font-bold text-text font-mono mt-1">{Math.round(totalDisk / WORKTREES.length)} MB</p>
                  </div>
                </div>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">各 worktree 占用</h3>
                  <div className="space-y-1.5">
                    {[...WORKTREES].sort((a, b) => b.diskSize - a.diskSize).map(w => {
                      const pct = (w.diskSize / totalDisk) * 100;
                      return (
                        <div key={w.id} className="flex items-center gap-2">
                          <code className="text-[10px] font-mono text-text w-40 truncate">{w.branch}</code>
                          <div className="flex-1 h-3 bg-surface-high rounded-full overflow-hidden">
                            <div className="h-full bg-accent" style={{ width: `${pct}%` }}></div>
                          </div>
                          <span className="text-[10px] text-text font-mono w-16 text-right">{w.diskSize} MB</span>
                          <span className="text-[10px] text-text-secondary font-mono w-10 text-right">{pct.toFixed(1)}%</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
