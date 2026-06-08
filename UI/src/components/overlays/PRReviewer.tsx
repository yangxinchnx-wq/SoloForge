// ─────────────────────────────────────────────────────────────────
// Pull Request 审查器 — PRReviewer
// - 行内评论
// - 文件级评分
// - 审查清单
// - 自动化检查 (lint/security/test)
// - 评审历史
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'unchanged';
type CommentType = 'suggestion' | 'issue' | 'praise' | 'question' | 'nitpick';
type CheckStatus = 'pass' | 'fail' | 'warn' | 'skipped';

interface FileChange {
  id: string;
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  language: string;
  comments: number;
  reviewStatus: 'reviewed' | 'pending' | 'flagged';
}

interface ReviewComment {
  id: string;
  fileId: string;
  line: number;
  type: CommentType;
  author: string;
  text: string;
  created: number;
  resolved: boolean;
  replies: number;
}

interface AutoCheck {
  id: string;
  category: 'lint' | 'security' | 'test' | 'style' | 'coverage' | 'complexity';
  name: string;
  status: CheckStatus;
  message: string;
  count?: number;
}

const FILE_CHANGES: FileChange[] = [
  { id: 'f1',  path: 'src/auth/jwt.ts',                status: 'modified', additions: 45, deletions: 12, language: 'typescript', comments: 3, reviewStatus: 'reviewed' },
  { id: 'f2',  path: 'src/auth/oauth-provider.ts',     status: 'added',    additions: 234, deletions: 0, language: 'typescript', comments: 5, reviewStatus: 'flagged' },
  { id: 'f3',  path: 'src/middleware/auth.ts',         status: 'modified', additions: 28, deletions: 8, language: 'typescript', comments: 2, reviewStatus: 'reviewed' },
  { id: 'f4',  path: 'src/api/user-routes.ts',         status: 'modified', additions: 67, deletions: 23, language: 'typescript', comments: 1, reviewStatus: 'pending' },
  { id: 'f5',  path: 'src/db/migrations/2026-06.ts',   status: 'added',    additions: 156, deletions: 0, language: 'sql',       comments: 4, reviewStatus: 'flagged' },
  { id: 'f6',  path: 'src/utils/crypto.ts',            status: 'modified', additions: 12, deletions: 45, language: 'typescript', comments: 0, reviewStatus: 'pending' },
  { id: 'f7',  path: 'src/auth/__tests__/jwt.test.ts', status: 'added',    additions: 89, deletions: 0, language: 'typescript', comments: 0, reviewStatus: 'pending' },
  { id: 'f8',  path: 'package.json',                    status: 'modified', additions: 3,  deletions: 1, language: 'json',      comments: 0, reviewStatus: 'reviewed' },
  { id: 'f9',  path: 'docs/auth-flow.md',              status: 'modified', additions: 45, deletions: 12, language: 'markdown',  comments: 1, reviewStatus: 'reviewed' },
  { id: 'f10', path: 'src/legacy/old-auth.ts',         status: 'deleted',  additions: 0,  deletions: 234, language: 'typescript', comments: 0, reviewStatus: 'reviewed' },
];

const COMMENTS: ReviewComment[] = [
  { id: 'c1', fileId: 'f2', line: 42, type: 'issue',       author: 'Alice Chen', text: '这里硬编码了 client_secret,应该从环境变量读取', created: Date.now() - 3600000,  resolved: false, replies: 2 },
  { id: 'c2', fileId: 'f2', line: 78, type: 'suggestion',  author: 'Bob Wang',   text: '建议用 zod schema 验证 redirect_uri,防止 open redirect', created: Date.now() - 1800000,  resolved: false, replies: 1 },
  { id: 'c3', fileId: 'f2', line: 124,type: 'praise',      author: 'Carol Liu',  text: 'PKCE 实现得很标准 👍', created: Date.now() - 600000, resolved: false, replies: 0 },
  { id: 'c4', fileId: 'f1', line: 23, type: 'nitpick',     author: 'David Zhang',text: '变量名 tokenJwt 可以简化成 jwt', created: Date.now() - 5400000, resolved: true,  replies: 1 },
  { id: 'c5', fileId: 'f5', line: 12, type: 'issue',       author: 'Eve',        text: '迁移脚本没加 IF NOT EXISTS,生产重跑会失败', created: Date.now() - 7200000,  resolved: false, replies: 3 },
  { id: 'c6', fileId: 'f3', line: 56, type: 'question',    author: 'Frank',      text: '为什么用 HMAC 而不是 RSA?', created: Date.now() - 1200000, resolved: false, replies: 0 },
];

const AUTO_CHECKS: AutoCheck[] = [
  { id: 'ac1', category: 'lint',      name: 'ESLint',         status: 'pass', message: '0 errors, 0 warnings',       count: 0 },
  { id: 'ac2', category: 'lint',      name: 'Prettier',       status: 'pass', message: 'All files formatted' },
  { id: 'ac3', category: 'security',  name: 'Snyk',           status: 'fail', message: '2 high vulnerabilities found', count: 2 },
  { id: 'ac4', category: 'security',  name: 'Trivy (image)',  status: 'pass', message: 'No critical issues in image' },
  { id: 'ac5', category: 'security',  name: 'Secret scan',    status: 'fail', message: '1 hardcoded secret detected', count: 1 },
  { id: 'ac6', category: 'test',      name: 'Unit tests',     status: 'pass', message: '247 tests passed',           count: 247 },
  { id: 'ac7', category: 'test',      name: 'Integration',    status: 'pass', message: '89 tests passed',             count: 89 },
  { id: 'ac8', category: 'test',      name: 'E2E (Cypress)',  status: 'warn', message: '3 flaky tests',               count: 3 },
  { id: 'ac9', category: 'coverage',  name: 'Coverage',       status: 'pass', message: '87.3% (above threshold 80%)' },
  { id: 'ac10',category: 'complexity',name: 'Cyclomatic',     status: 'warn', message: '2 functions exceed threshold',count: 2 },
  { id: 'ac11',category: 'style',     name: 'Import order',   status: 'pass', message: 'OK' },
  { id: 'ac12',category: 'security',  name: 'Dep audit',      status: 'warn', message: '3 moderate vulnerabilities in dependencies', count: 3 },
];

function statusVariant(s: CheckStatus): 'success' | 'warning' | 'danger' | 'default' {
  return s === 'pass' ? 'success' : s === 'warn' ? 'warning' : s === 'fail' ? 'danger' : 'default';
}
function fileStatusVariant(s: FileStatus): 'success' | 'info' | 'danger' | 'warning' | 'default' {
  return s === 'added' ? 'success' : s === 'modified' ? 'info' : s === 'deleted' ? 'danger' : s === 'renamed' ? 'warning' : 'default';
}
function commentTypeLabel(t: CommentType): string { return { suggestion: '建议', issue: '问题', praise: '赞', question: '?', nitpick: 'Nit' }[t]; }
function commentTypeVariant(t: CommentType): 'success' | 'warning' | 'info' | 'danger' | 'default' {
  return t === 'praise' ? 'success' : t === 'issue' ? 'danger' : t === 'suggestion' ? 'info' : t === 'question' ? 'warning' : 'default';
}

export function PRReviewer({ open, onClose }: Props) {
  const [tab, setTab] = useState<'files' | 'comments' | 'checks' | 'checklist'>('files');
  const [activeFileId, setActiveFileId] = useState<string>(FILE_CHANGES[0].id);
  const activeFile = FILE_CHANGES.find(f => f.id === activeFileId) || FILE_CHANGES[0];
  const fileComments = COMMENTS.filter(c => c.fileId === activeFileId);
  const passedChecks = AUTO_CHECKS.filter(c => c.status === 'pass').length;
  const failedChecks = AUTO_CHECKS.filter(c => c.status === 'fail').length;

  const totalAdd = FILE_CHANGES.reduce((s, f) => s + f.additions, 0);
  const totalDel = FILE_CHANGES.reduce((s, f) => s + f.deletions, 0);
  const totalComments = COMMENTS.length;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">rate_review</span>
          <h2 className="text-sm font-semibold text-text">Pull Request 审查器</h2>
          <Badge variant="info">PR #158</Badge>
          <Badge variant="success">+{totalAdd}</Badge>
          <Badge variant="danger">-{totalDel}</Badge>
          <Badge variant="info">{FILE_CHANGES.length} 文件</Badge>
          <Badge variant="warning">{totalComments} 评论</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="check" variant="primary">批准</Button>
            <Button size="sm" icon="edit">请求修改</Button>
            <Button size="sm" icon="comment">仅评论</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'files',     l: `文件 (${FILE_CHANGES.length})` },
            { k: 'comments',  l: `评论 (${totalComments})` },
            { k: 'checks',    l: `自动化检查 (${AUTO_CHECKS.length})` },
            { k: 'checklist', l: '审查清单' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-80 border-r border-border bg-bg overflow-y-auto">
            {tab === 'files' && FILE_CHANGES.map(f => (
              <div key={f.id} onClick={() => setActiveFileId(f.id)}
                className={'px-3 py-2 border-b border-border-light cursor-pointer hover:bg-surface-high ' + (activeFileId === f.id ? 'bg-accent/10 border-l-2 border-l-accent' : '')}>
                <div className="flex items-center gap-1 mb-1">
                  <Badge variant={fileStatusVariant(f.status)}>{f.status}</Badge>
                  {f.comments > 0 && <Badge variant="warning">{f.comments}</Badge>}
                  {f.reviewStatus === 'reviewed' && <span className="material-symbols-outlined text-sm text-success">check_circle</span>}
                  {f.reviewStatus === 'flagged' && <span className="material-symbols-outlined text-sm text-danger">flag</span>}
                </div>
                <code className="text-[11px] font-mono text-text block truncate">{f.path}</code>
                <div className="text-[10px] text-text-secondary mt-0.5 flex items-center gap-2">
                  <span className="text-success font-mono">+{f.additions}</span>
                  <span className="text-danger font-mono">-{f.deletions}</span>
                  <span className="ml-auto">{f.language}</span>
                </div>
              </div>
            ))}
            {tab === 'comments' && COMMENTS.map(c => {
              const file = FILE_CHANGES.find(f => f.id === c.fileId);
              return (
                <div key={c.id} onClick={() => { setActiveFileId(c.fileId); setTab('files'); }} className="px-3 py-2 border-b border-border-light cursor-pointer hover:bg-surface-high">
                  <div className="flex items-center gap-1 mb-1">
                    <Badge variant={commentTypeVariant(c.type)}>{commentTypeLabel(c.type)}</Badge>
                    {c.resolved && <Badge variant="success">已解决</Badge>}
                  </div>
                  <code className="text-[10px] font-mono text-text-secondary block truncate">{file?.path}:{c.line}</code>
                  <p className="text-[11px] text-text mt-1 line-clamp-2">{c.text}</p>
                  <div className="text-[10px] text-text-secondary mt-1">{c.author} · {c.replies} 回复</div>
                </div>
              );
            })}
          </div>

          <div className="flex-1 overflow-auto p-3 space-y-3">
            {tab === 'files' && (
              <>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant={fileStatusVariant(activeFile.status)}>{activeFile.status}</Badge>
                    <code className="text-sm font-mono font-bold text-text">{activeFile.path}</code>
                    <Badge variant="info">{activeFile.language}</Badge>
                  </div>
                  <div className="grid grid-cols-4 gap-3 text-[11px]">
                    <div><p className="text-[10px] text-text-secondary">新增</p><p className="text-success font-mono text-lg">+{activeFile.additions}</p></div>
                    <div><p className="text-[10px] text-text-secondary">删除</p><p className="text-danger font-mono text-lg">-{activeFile.deletions}</p></div>
                    <div><p className="text-[10px] text-text-secondary">评论数</p><p className="text-text font-mono text-lg">{activeFile.comments}</p></div>
                    <div><p className="text-[10px] text-text-secondary">审查</p><Badge variant={activeFile.reviewStatus === 'reviewed' ? 'success' : activeFile.reviewStatus === 'flagged' ? 'danger' : 'warning'}>{activeFile.reviewStatus}</Badge></div>
                  </div>
                </div>

                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">代码差异 (示意)</h3>
                  <pre className="bg-black text-xs font-mono p-3 rounded overflow-x-auto">
{activeFile.additions > 0 && <span className="text-green-400">+ export async function authenticate(req: Request) {`{`}</span>}
{activeFile.deletions > 0 && <span className="text-red-400">- export async function login(req: Request) {`{`}</span>}
{activeFile.additions > 0 && <span className="text-green-400">+   const token = await jwt.verify(req.headers.get('authorization'));</span>}
{activeFile.deletions > 0 && <span className="text-red-400">-   const user = await db.users.findOne({`{ token }`});</span>}
{activeFile.additions > 0 && <span className="text-green-400">+   if (!token) return new Response(&apos;Unauthorized&apos;, {`{ status: 401 }`});</span>}
{activeFile.additions > 0 && <span className="text-green-400">+   return await userService.getById(token.sub);</span>}
{activeFile.deletions > 0 && <span className="text-red-400">-   return user;</span>}
{activeFile.additions > 0 && <span className="text-green-400">+ {`}`}</span>}
                  </pre>
                </div>

                {fileComments.length > 0 && (
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h3 className="text-xs font-semibold text-text mb-2">本文件评论 ({fileComments.length})</h3>
                    <div className="space-y-1.5">
                      {fileComments.map(c => (
                        <div key={c.id} className="bg-surface-high rounded p-2">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant={commentTypeVariant(c.type)}>{commentTypeLabel(c.type)}</Badge>
                            <code className="text-[10px] font-mono text-accent">L{c.line}</code>
                            <span className="text-[10px] text-text-secondary ml-auto">{c.author}</span>
                          </div>
                          <p className="text-[11px] text-text">{c.text}</p>
                          {c.replies > 0 && <p className="text-[10px] text-text-secondary mt-1">{c.replies} 条回复</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {tab === 'comments' && (
              <div className="space-y-1.5">
                {COMMENTS.map(c => {
                  const file = FILE_CHANGES.find(f => f.id === c.fileId);
                  return (
                    <div key={c.id} className="bg-bg border border-border-light rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant={commentTypeVariant(c.type)}>{commentTypeLabel(c.type)}</Badge>
                        <code className="text-[10px] font-mono text-accent">{file?.path}:L{c.line}</code>
                        {c.resolved && <Badge variant="success">已解决</Badge>}
                        <span className="text-[10px] text-text-secondary ml-auto">{c.author} · {new Date(c.created).toLocaleString()}</span>
                      </div>
                      <p className="text-[11px] text-text">{c.text}</p>
                    </div>
                  );
                })}
              </div>
            )}

            {tab === 'checks' && (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <p className="text-[10px] text-text-secondary">通过</p>
                    <p className="text-2xl font-bold text-success font-mono mt-1">{passedChecks}</p>
                  </div>
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <p className="text-[10px] text-text-secondary">失败</p>
                    <p className="text-2xl font-bold text-danger font-mono mt-1">{failedChecks}</p>
                  </div>
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <p className="text-[10px] text-text-secondary">总检查项</p>
                    <p className="text-2xl font-bold text-text font-mono mt-1">{AUTO_CHECKS.length}</p>
                  </div>
                </div>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">自动化检查结果</h3>
                  <div className="space-y-1.5">
                    {AUTO_CHECKS.map(c => (
                      <div key={c.id} className="flex items-center gap-2 p-2 bg-surface-high rounded">
                        <Badge variant="info">{c.category}</Badge>
                        <Badge variant={statusVariant(c.status)}>{c.status}</Badge>
                        <span className="text-[11px] text-text font-medium">{c.name}</span>
                        <span className="text-[10px] text-text-secondary flex-1">{c.message}</span>
                        {c.count !== undefined && <span className="text-[10px] text-text font-mono">{c.count}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {tab === 'checklist' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">审查清单</h3>
                <div className="space-y-1.5">
                  {[
                    { item: '代码遵循项目风格指南', checked: true,  author: 'Alice' },
                    { item: '添加/更新了单元测试', checked: true,  author: 'Bob' },
                    { item: '更新了相关文档', checked: true,  author: 'Carol' },
                    { item: '无明显性能问题', checked: true,  author: 'David' },
                    { item: '错误处理完善', checked: true,  author: 'Alice' },
                    { item: '日志记录充分', checked: false, author: null },
                    { item: '考虑了边界情况', checked: true,  author: 'Eve' },
                    { item: '依赖已审查 (无许可证冲突)', checked: true,  author: 'Frank' },
                    { item: '数据库迁移可回滚', checked: false, author: null },
                    { item: '前后端 API 契约一致', checked: true,  author: 'Alice' },
                    { item: 'Feature Flag 已配置', checked: false, author: null },
                  ].map((c, i) => (
                    <div key={i} className="flex items-center gap-2 p-2 bg-surface-high rounded">
                      <span className={'material-symbols-outlined text-base ' + (c.checked ? 'text-success' : 'text-text-secondary')}>
                        {c.checked ? 'check_box' : 'check_box_outline_blank'}
                      </span>
                      <span className={'text-[11px] flex-1 ' + (c.checked ? 'text-text' : 'text-text-secondary')}>{c.item}</span>
                      {c.author && <span className="text-[10px] text-text-secondary">@ {c.author}</span>}
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
