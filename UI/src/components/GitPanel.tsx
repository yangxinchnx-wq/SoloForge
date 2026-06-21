import { useState } from 'react';
import {
  GitBranch,
  RefreshCw,
  ArrowUp,
  Check,
  Settings,
  Lock,
  Plus,
  AlertCircle,
  Globe,
  User,
  FileText,
  CheckCircle2,
  X,
  ChevronDown,
  Clock,
} from 'lucide-react';
import { useGit } from '../git/useGit';

// ── Diff renderer ─────────────────────────────────────────────
function DiffView({ content, hasConflict = false }: { content: string | null; hasConflict?: boolean }) {
  if (!content) return <div className="text-on-surface/40 italic p-4 text-xs">没有差异内容</div>;
  const lines = content.split('\n');

  if (!hasConflict) {
    return (
      <pre className="font-mono text-[10px] leading-relaxed whitespace-pre overflow-x-auto p-3.5 bg-neutral-900 border border-outline/10 text-neutral-200 rounded-xl max-h-[460px] select-text">
        {lines.map((line, i) => {
          let cls = 'text-on-surface/85';
          if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-emerald-400 bg-emerald-950/25 px-1 py-0.5 rounded-sm block w-full border-l-2 border-emerald-500';
          else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-rose-400 bg-rose-950/25 px-1 py-0.5 rounded-sm block w-full border-l-2 border-rose-500';
          else if (line.startsWith('@@')) cls = 'text-blue-400 font-semibold block w-full bg-blue-950/10 py-0.5';
          else if (line.startsWith('diff --git') || line.startsWith('index ')) cls = 'text-amber-400 block w-full font-bold pt-1.5 border-t border-outline/10';
          else if (line.startsWith('commit ') || line.startsWith('Author:') || line.startsWith('Date:')) cls = 'text-purple-400 block w-full font-semibold';
          return <code key={i} className={cls}>{line || '\n'}</code>;
        })}
      </pre>
    );
  }

  let inOurs = false;
  let inTheirs = false;
  return (
    <pre className="font-mono text-[10.5px] leading-relaxed whitespace-pre overflow-x-auto p-3.5 bg-neutral-950 border border-outline/15 text-neutral-200 rounded-xl max-h-[460px] select-text">
      {lines.map((line, i) => {
        let cls = 'text-on-surface/85 block w-full px-1';
        if (line.startsWith('<<<<<<<')) {
          inOurs = true; inTheirs = false;
          return <div key={i} className="text-blue-400 bg-blue-950/40 font-black border-y border-blue-500/50 py-1 my-1 block w-full"><span className="bg-blue-500 text-bg px-1.5 py-0.5 rounded text-[8.5px] font-black mr-2 uppercase">{'\u25BC'} 当前更改</span>{line}</div>;
        }
        if (line.startsWith('=======')) {
          inOurs = false; inTheirs = true;
          return <div key={i} className="text-amber-400 bg-amber-950/45 font-black border-y border-amber-500/50 py-1 my-1 block w-full"><span className="bg-amber-500 text-bg px-1.5 py-0.5 rounded text-[8.5px] font-black mr-2 uppercase">{'\u25B2'} 传入更改</span>{line}</div>;
        }
        if (line.startsWith('>>>>>>>')) {
          inOurs = false; inTheirs = false;
          return <div key={i} className="text-neutral-400 bg-neutral-900 border-y border-neutral-700/50 py-1 my-1 block w-full"><span className="bg-neutral-600 text-white px-1.5 py-0.5 rounded text-[8.5px] font-black mr-2 uppercase">{'\u25C0'} 冲突边界</span>{line}</div>;
        }
        if (inOurs) cls = 'bg-blue-950/15 text-blue-300 font-medium px-2 py-0.5 border-l-2 border-blue-500 block w-full';
        else if (inTheirs) cls = 'bg-amber-950/15 text-amber-300 font-medium px-2 py-0.5 border-l-2 border-amber-500 block w-full';
        else if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-emerald-400 bg-emerald-950/20 px-1 py-0.5 block w-full border-l border-emerald-500';
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-rose-400 bg-rose-950/20 px-1 py-0.5 block w-full border-l border-rose-500';
        return <code key={i} className={cls}>{line || '\n'}</code>;
      })}
    </pre>
  );
}

// ── Branch Selector ───────────────────────────────────────────
function BranchSelector({
  branches,
  currentBranch,
  onCheckout,
  onClose,
}: {
  branches: string[];
  currentBranch: string;
  onCheckout: (name: string, create?: boolean) => void;
  onClose: () => void;
}) {
  const [newName, setNewName] = useState('');

  return (
    <>
      <div className="fixed inset-0 z-40 bg-transparent" onClick={onClose} />
      <div className="absolute left-0 mt-1.5 w-48 bg-surface-bright border border-outline/35 rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.25)] p-1 z-50 flex flex-col gap-1 max-h-64 overflow-y-auto">
        <div className="px-2 py-1 text-[9px] text-on-surface/40 font-bold border-b border-outline/10 uppercase tracking-wider">选择分支</div>
        {branches.length === 0 ? (
          <div className="px-2 py-1.5 text-[10.5px] text-on-surface/50 italic">未获取到本地分支</div>
        ) : (
          branches.map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => onCheckout(b)}
              className={`w-full text-left px-2 py-1.5 rounded-lg text-[10.5px] font-mono flex items-center justify-between transition-colors cursor-pointer ${
                b === currentBranch ? 'bg-primary/15 text-primary font-bold' : 'hover:bg-on-surface/5 text-on-surface/85'
              }`}
            >
              <span className="truncate">{b}</span>
              {b === currentBranch && <Check className="w-3 h-3 text-primary shrink-0" />}
            </button>
          ))
        )}
        <div className="p-1 px-1.5 border-t border-outline/10 mt-1 space-y-1 text-left">
          <div className="text-[9px] text-on-surface/40 font-bold">新建并切换分支:</div>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) { onCheckout(newName.trim(), true); setNewName(''); } }}
              placeholder="分支名称"
              className="flex-1 text-[9.5px] px-1.5 py-0.5 bg-surface text-on-surface border border-outline/25 rounded outline-none font-mono"
            />
            <button
              type="button"
              onClick={() => { if (newName.trim()) { onCheckout(newName.trim(), true); setNewName(''); } }}
              className="bg-primary hover:bg-primary-hover text-bg p-1 rounded font-bold transition-all cursor-pointer flex items-center justify-center shrink-0"
            >
              <Plus className="w-2.5 h-2.5" />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Main Panel ────────────────────────────────────────────────
interface GitPanelProps {
  onClose: () => void;
}

export default function GitPanel({ onClose }: GitPanelProps) {
  const git = useGit();
  const [showBranchSelector, setShowBranchSelector] = useState(false);

  const currentBranch = git.targetBranch || git.statusData?.branch || 'main';

  return (
    <div className="flex-1 flex flex-col h-full bg-surface relative select-none">
      {/* ─── Header ─── */}
      <div className="flex items-center justify-between px-3.5 py-3 border-b border-outline/30 bg-surface-bright shrink-0">
        <div className="flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-primary animate-pulse" />
          <span className="text-xs font-bold tracking-wider text-on-surface">源代码管理</span>
          {git.statusData?.initialized && (
            <div className="relative">
              <button
                type="button"
                onClick={() => { setShowBranchSelector(!showBranchSelector); if (!showBranchSelector) git.fetchBranches(); }}
                className="text-[10px] bg-primary/10 hover:bg-primary/20 text-primary px-2 py-0.5 rounded-full font-mono font-bold flex items-center gap-1 cursor-pointer transition-colors max-w-[120px] truncate"
                title="切换/新建 Git 分支"
              >
                <span className="truncate">{currentBranch}</span>
                <ChevronDown className="w-2.5 h-2.5 opacity-70 shrink-0" />
              </button>
              {showBranchSelector && (
                <BranchSelector
                  branches={git.branches}
                  currentBranch={currentBranch}
                  onCheckout={(name, create) => { git.handleCheckoutBranch(name, create); setShowBranchSelector(false); }}
                  onClose={() => setShowBranchSelector(false)}
                />
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => git.fetchGitStatus()} disabled={git.loading} className="p-1.5 hover:bg-on-surface/10 rounded-md text-on-surface/60 hover:text-on-surface transition-colors cursor-pointer disabled:opacity-30" title="刷新">
            <RefreshCw className={`w-3.5 h-3.5 ${git.loading ? 'animate-spin' : ''}`} />
          </button>
          <button type="button" onClick={onClose} className="p-1.5 hover:bg-on-surface/10 rounded-md text-on-surface/60 hover:text-on-surface transition-colors cursor-pointer" title="关闭">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ─── Feedback ─── */}
      {git.feedback && (
        <div className={`px-3.5 py-2 text-[10.5px] border-b text-left flex gap-1.5 items-start shrink-0 ${git.feedback.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-rose-500/10 border-rose-500/20 text-rose-400'}`}>
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span className="flex-1">{git.feedback.text}</span>
          <button onClick={() => git.setFeedback(null)} className="shrink-0 p-0.5 hover:bg-on-surface/5 rounded"><X className="w-3 h-3 text-on-surface/40" /></button>
        </div>
      )}

      {/* ─── Content ─── */}
      {!git.statusData ? (
        /* Loading */
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center space-y-3">
          <RefreshCw className="w-6 h-6 text-on-surface/30 animate-spin" />
          <p className="text-xs text-on-surface/40">加载 Git 状态中...</p>
        </div>
      ) : !git.statusData.initialized ? (
        /* Not initialized */
        <div className="flex-1 flex flex-col justify-between p-5 text-left">
          <div className="space-y-4">
            <div className="bg-primary/5 border border-primary/25 rounded-2xl p-4 space-y-2.5">
              <span className="inline-flex p-1.5 bg-primary/10 rounded-xl text-primary"><GitBranch className="w-5 h-5" /></span>
              <h3 className="text-xs font-black text-on-surface">创建 Git 版本库</h3>
              <p className="text-[11px] text-on-surface/60 leading-relaxed">当前项目目录未检测到 Git 仓库。初始化后即可记录代码版本，并推送到 GitHub 等远程仓库。</p>
            </div>
            <button onClick={git.initializeRepository} disabled={git.loading} className="w-full py-2.5 bg-primary hover:bg-primary-hover text-bg font-extrabold text-xs rounded-xl flex items-center justify-center gap-1.5 cursor-pointer shadow-md transition-all active:scale-95 disabled:opacity-50">
              {git.loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              <span>初始化本地 Git 仓库</span>
            </button>
          </div>
          <div className="text-[10px] text-on-surface/30 leading-snug border-t border-outline/10 pt-3">* 初始化后会自动生成 .gitignore 文件。</div>
        </div>
      ) : (
        /* Initialized */
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Tabs */}
          <div className="flex border-b border-outline/30 bg-surface-bright/50 px-2 pt-1 shrink-0">
            {([['changes', `变更 (${git.statusData.files.length})`], ['history', '提交历史'], ['settings', '认证与配置']] as const).map(([key, label]) => (
              <button key={key} onClick={() => git.setActiveSubTab(key)} className={`flex-1 py-2 text-[11px] font-bold border-b-2 transition-all ${git.activeSubTab === key ? 'border-primary text-primary' : 'border-transparent text-on-surface/55 hover:text-on-surface/90'}`}>
                {label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-3.5 space-y-4">

            {/* ═══ CHANGES TAB ═══ */}
            {git.activeSubTab === 'changes' && (
              <div className="space-y-4">
                {/* Commit form */}
                <div className="bg-surface-bright/50 border border-outline/25 p-3 rounded-2xl space-y-3 text-left">
                  <span className="text-[10px] text-on-surface/50 font-bold block">提交消息</span>
                  <input type="text" value={git.commitMessage} onChange={(e) => git.setCommitMessage(e.target.value)} placeholder="输入提交备忘记录..." className="w-full text-[11px] p-2 bg-surface text-on-surface border border-outline/25 rounded-lg focus:border-primary outline-none" />

                  <div className="border-t border-outline/10 pt-2.5 space-y-2.5">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <span className="text-[9px] text-on-surface/40 font-bold block">作者用户名</span>
                        <input type="text" value={git.userName} onChange={(e) => git.setUserName(e.target.value)} placeholder="git-username" className="w-full text-[10px] px-2 py-1 bg-surface text-on-surface border border-outline/20 rounded outline-none focus:border-primary" />
                      </div>
                      <div className="space-y-1">
                        <span className="text-[9px] text-on-surface/40 font-bold block">邮箱</span>
                        <input type="text" value={git.userEmail} onChange={(e) => git.setUserEmail(e.target.value)} placeholder="email@example.com" className="w-full text-[10px] px-2 py-1 bg-surface text-on-surface border border-outline/20 rounded outline-none focus:border-primary font-mono" />
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-2 pt-1 border-t border-outline/5">
                    <button onClick={git.handleCommit} disabled={git.loading || git.statusData.files.length === 0} className="flex-1 py-1.5 bg-primary/10 hover:bg-primary/20 hover:text-white border border-primary/30 text-primary rounded-lg text-[10.5px] font-bold cursor-pointer transition-colors flex items-center justify-center gap-1 disabled:opacity-35 disabled:pointer-events-none">
                      <Check className="w-3.5 h-3.5" /><span>仅提交</span>
                    </button>
                    <button onClick={async () => { await git.handleCommit(); await git.handlePush(); }} disabled={git.loading || (git.statusData.files.length === 0 && !git.remoteUrl)} className="flex-1 py-1.5 bg-primary hover:bg-primary-hover text-bg rounded-lg text-[10.5px] font-extrabold cursor-pointer transition-all flex items-center justify-center gap-1 shadow-sm disabled:opacity-35 disabled:pointer-events-none">
                      <ArrowUp className="w-3.5 h-3.5" /><span>提交并推送</span>
                    </button>
                  </div>
                </div>

                {/* Staged files */}
                {git.stagedFiles.length > 0 && (
                  <div className="space-y-1.5 text-left">
                    <span className="text-[10.5px] font-extrabold text-emerald-400 px-1">已暂存 ({git.stagedFiles.length})</span>
                    <div className="space-y-1 border-l border-emerald-500/20 pl-2">
                      {git.stagedFiles.map((f, i) => (
                        <div key={i} onClick={() => git.handleViewFileDiff(f.name)} className="flex justify-between items-center py-1 text-[11px] hover:bg-on-surface/5 px-2 rounded-md group cursor-pointer" title="查看差异">
                          <div className="flex items-center gap-1.5 truncate">
                            <FileText className="w-3.5 h-3.5 text-on-surface/40 group-hover:text-primary" />
                            <span className="font-mono truncate text-on-surface/80 group-hover:text-primary transition-colors">{f.name}</span>
                          </div>
                          <span className="text-[10px] shrink-0 font-extrabold px-1 text-emerald-400 font-mono">{f.status === 'untracked' ? '新加' : '已更改'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Unstaged files */}
                <div className="space-y-1.5 text-left">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[10.5px] font-extrabold text-on-surface/70">待暂存 ({git.unstagedFiles.length})</span>
                    {git.unstagedFiles.length > 0 && (
                      <button onClick={() => git.stageFile()} disabled={git.loading} className="text-[9.5px] text-primary hover:underline cursor-pointer font-bold flex items-center gap-0.5">
                        <Plus className="w-2.5 h-2.5" /> 暂存全部
                      </button>
                    )}
                  </div>
                  {git.unstagedFiles.length === 0 ? (
                    <p className="text-[11px] text-on-surface/35 py-3 text-center bg-on-surface/5 border border-dashed border-outline/10 rounded-xl">未检测到文件变动</p>
                  ) : (
                    <div className="space-y-1">
                      {git.unstagedFiles.map((f, i) => (
                        <div key={i} className="flex justify-between items-center py-1.5 text-[11px] hover:bg-on-surface/5 px-2 rounded-md group">
                          <div onClick={() => git.handleViewFileDiff(f.name)} className="flex items-center gap-1.5 truncate flex-1 cursor-pointer" title="查看差异">
                            <FileText className="w-3.5 h-3.5 text-on-surface/40 group-hover:text-primary" />
                            <span className="font-mono truncate text-on-surface group-hover:text-primary transition-colors">{f.name}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`text-[9.5px] shrink-0 font-extrabold px-1 rounded font-mono ${f.status === 'untracked' ? 'text-emerald-500 bg-emerald-500/10' : f.status === 'deleted' ? 'text-rose-500 bg-rose-500/10' : 'text-amber-500 bg-amber-500/10'}`}>
                              {f.status === 'untracked' ? 'U' : f.status === 'deleted' ? 'D' : 'M'}
                            </span>
                            <button onClick={() => git.stageFile(f.name)} className="hidden group-hover:flex p-0.5 bg-primary/10 text-primary border border-primary/20 hover:bg-primary hover:text-bg rounded cursor-pointer" title="暂存">
                              <Plus className="w-2.5 h-2.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Remote sync */}
                <div className="bg-surface-bright/50 border border-outline/25 p-3 rounded-2xl space-y-3 text-left">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Globe className="w-3.5 h-3.5 text-primary" />
                      <span className="text-[10px] text-on-surface/50 font-bold uppercase tracking-wider">远程仓库同步</span>
                    </div>
                    {git.remoteUrl && <span className="text-[9px] bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded font-bold">已连接</span>}
                  </div>

                  {git.remoteUrl ? (
                    <div className="space-y-2.5">
                      <div className="bg-surface/60 rounded-xl p-2.5 border border-outline/10 space-y-1.5">
                        <div className="flex justify-between items-center text-[10.5px]">
                          <span className="text-on-surface/40">目标仓库</span>
                          <span className="font-mono text-on-surface/85 truncate max-w-[170px] font-semibold">{git.remoteUrl.replace(/https:\/\/|[a-zA-Z0-9_-]+@/g, '').replace(/\.git$/, '')}</span>
                        </div>
                        <div className="flex justify-between items-center text-[10.5px]">
                          <span className="text-on-surface/40">分支</span>
                          <span className="font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded text-[10px] font-bold">{currentBranch}</span>
                        </div>
                        <div className="flex justify-between items-center text-[10.5px]">
                          <span className="text-on-surface/40">认证</span>
                          <span className={`font-mono text-[10px] font-bold flex items-center gap-1 ${git.accessToken ? 'text-emerald-400' : 'text-amber-500'}`}>
                            <Lock className="w-2.5 h-2.5" />{git.accessToken ? '已配置' : '未配置'}
                          </span>
                        </div>
                      </div>

                      {git.pushProgress !== null ? (
                        <div className="w-full py-4 flex flex-col items-center justify-center bg-surface-bright border border-primary/20 rounded-xl space-y-2.5 animate-pulse">
                          <div className="relative flex items-center justify-center w-12 h-12">
                            {git.pushSuccessState ? (
                              <div className="flex items-center justify-center w-9 h-9 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"><Check className="w-4.5 h-4.5 stroke-[3]" /></div>
                            ) : (
                              <>
                                <svg className="w-12 h-12 transform -rotate-90">
                                  <circle className="text-on-surface/5" strokeWidth="3.5" stroke="currentColor" fill="transparent" r="20" cx="24" cy="24" />
                                  <circle className="text-primary transition-all duration-150" strokeWidth="4" strokeDasharray={2 * Math.PI * 20} strokeDashoffset={2 * Math.PI * 20 - (git.pushProgress / 100) * (2 * Math.PI * 20)} strokeLinecap="round" stroke="currentColor" fill="transparent" r="20" cx="24" cy="24" />
                                </svg>
                                <span className="absolute text-[10px] font-black text-on-surface/90 font-mono">{git.pushProgress}%</span>
                              </>
                            )}
                          </div>
                          <p className="text-[10.5px] font-extrabold text-on-surface">
                            {git.pushSuccessState ? <span className="text-emerald-400">推送已完成！</span> : <span className="text-primary">正在推送到远程...</span>}
                          </p>
                        </div>
                      ) : (
                        <button onClick={git.handlePush} disabled={git.loading} className="w-full py-2 bg-primary hover:bg-primary-hover active:scale-[0.98] text-[11px] text-bg font-extrabold rounded-xl transition-all flex items-center justify-center gap-1.5 shadow-md shadow-primary/5 disabled:opacity-45">
                          <ArrowUp className="w-3.5 h-3.5" /><span>立即推送至远程仓库</span>
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="bg-surface/40 border border-dashed border-outline/20 rounded-xl p-3 text-center space-y-2.5">
                      <p className="text-[10.5px] text-on-surface/50 leading-relaxed">尚未配置远程仓库链接。</p>
                      <button type="button" onClick={() => git.setActiveSubTab('settings')} className="inline-flex items-center gap-1.5 px-3 py-1 bg-primary/10 hover:bg-primary/20 border border-primary/20 text-primary text-[10px] font-black rounded-lg cursor-pointer transition-all">
                        <Settings className="w-3 h-3" /><span>前往配置 {'\u2192'}</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ═══ HISTORY TAB ═══ */}
            {git.activeSubTab === 'history' && (
              <div className="space-y-3 text-left">
                <span className="text-[10px] text-on-surface/50 font-bold flex items-center gap-1.5"><Clock className="w-3 h-3" />提交历史 ({git.statusData.commits.length})</span>
                {git.statusData.commits.length === 0 ? (
                  <p className="text-[11px] text-on-surface/35 py-6 text-center border border-dashed border-outline/10 rounded-xl">暂无提交记录</p>
                ) : (
                  <div className="space-y-2 select-text">
                    {git.statusData.commits.map((log, i) => (
                      <button key={i} type="button" onClick={() => git.handleViewCommitDiff(log.hash)} className="w-full p-2.5 bg-surface-bright/40 border border-outline/15 rounded-xl hover:border-primary/40 hover:bg-on-surface/5 transition-all text-left flex flex-col gap-1 cursor-pointer group">
                        <div className="flex justify-between items-center w-full">
                          <span className="font-mono text-[9.5px] text-primary bg-primary/10 px-1.5 py-0.5 rounded font-bold group-hover:underline">{log.hash}</span>
                          <span className="text-[9.5px] text-on-surface/40 font-mono">{log.relativeTime}</span>
                        </div>
                        <p className="text-[11px] font-bold text-on-surface leading-snug group-hover:text-primary">{log.message}</p>
                        <div className="flex justify-between items-center w-full mt-1.5 text-[9px] text-on-surface/40 border-t border-outline/10 pt-1">
                          <span className="font-mono">提交者: {log.author}</span>
                          <span className="text-primary font-bold group-hover:translate-x-0.5 transition-transform">查看 Diff {'\u2192'}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ═══ SETTINGS TAB ═══ */}
            {git.activeSubTab === 'settings' && (
              <div className="space-y-4 text-left">
                <div className="bg-surface-bright/50 border border-outline/20 p-3 rounded-2xl space-y-3">
                  <div className="flex items-center gap-1.5 pb-1 border-b border-outline/10">
                    <User className="w-3.5 h-3.5 text-primary" />
                    <span className="text-[11px] font-extrabold text-on-surface">提交人签名配置</span>
                  </div>
                  <div className="space-y-2.5">
                    <div className="space-y-1">
                      <label className="text-[9.5px] text-on-surface/50 font-bold">用户名</label>
                      <input type="text" value={git.userName} onChange={(e) => git.setUserName(e.target.value)} placeholder="例如: github_username" className="w-full text-[10.5px] px-2.5 py-1.5 bg-surface text-on-surface border border-outline/25 rounded-lg outline-none focus:border-primary" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[9.5px] text-on-surface/50 font-bold">注册邮箱</label>
                      <input type="email" value={git.userEmail} onChange={(e) => git.setUserEmail(e.target.value)} placeholder="user@domain.com" className="w-full text-[10.5px] px-2.5 py-1.5 bg-surface text-on-surface border border-outline/25 rounded-lg outline-none focus:border-primary" />
                    </div>
                  </div>
                </div>

                <div className="bg-surface-bright/50 border border-outline/20 p-3 rounded-2xl space-y-3">
                  <div className="flex items-center gap-1.5 pb-1 border-b border-outline/10">
                    <Globe className="w-3.5 h-3.5 text-primary" />
                    <span className="text-[11px] font-extrabold text-on-surface">远程仓库连接配置</span>
                  </div>
                  <div className="space-y-2.5">
                    <div className="space-y-1">
                      <label className="text-[9.5px] text-on-surface/50 font-bold">仓库 HTTPS 链接</label>
                      <input type="text" value={git.remoteUrl} onChange={(e) => git.setRemoteUrl(e.target.value)} placeholder="https://github.com/username/repo.git" className="w-full text-[10.5px] px-2.5 py-1.5 bg-surface text-on-surface border border-outline/25 rounded-lg outline-none focus:border-primary font-mono" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[9.5px] text-on-surface/50 font-bold flex items-center gap-1"><Lock className="w-2.5 h-2.5 shrink-0" /><span>个人访问密钥</span></label>
                      <input type="password" value={git.accessToken} onChange={(e) => git.setAccessToken(e.target.value)} placeholder="ghp_***" className="w-full text-[10.5px] px-2.5 py-1.5 bg-surface text-on-surface border border-outline/25 rounded-lg outline-none focus:border-primary font-mono" title="只保存在本地浏览器" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[9.5px] text-on-surface/50 font-bold">目标推送分支</label>
                      <input type="text" value={git.targetBranch} onChange={(e) => git.setTargetBranch(e.target.value)} placeholder="main" className="w-full text-[10.5px] px-2.5 py-1.5 bg-surface text-on-surface border border-outline/25 rounded-lg outline-none focus:border-primary font-mono" />
                    </div>
                  </div>
                </div>

                <button onClick={git.handleSaveConfig} disabled={git.loading} className="w-full py-2 bg-primary hover:bg-primary-hover text-bg rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" /><span>保存并应用配置</span>
                </button>
              </div>
            )}

          </div>
        </div>
      )}

      {/* ─── Diff Modal ─── */}
      {git.diffModalOpen && (
        <div className="absolute inset-0 bg-surface/95 backdrop-blur-md z-[100] flex flex-col animate-fade-in select-text">
          <div className="bg-surface border-b border-outline/30 px-3.5 py-3 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <span className={`text-[9.5px] font-mono px-2 py-0.5 rounded-full font-black shadow-sm ${git.diffHasConflict ? 'bg-amber-500/15 text-amber-500 border border-amber-500/20' : 'bg-primary/10 text-primary border border-primary/20'}`}>
                {git.diffHasConflict ? '检测到合并冲突' : git.diffTitle}
              </span>
              {git.diffFileName && <span className="text-[11px] font-black font-mono text-on-surface truncate max-w-[120px]">{git.diffFileName}</span>}
            </div>
            <button type="button" onClick={git.closeDiffModal} className="p-1 hover:bg-on-surface/10 rounded-md text-on-surface/60 hover:text-on-surface transition-colors cursor-pointer">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {git.diffHasConflict && (
            <div className="bg-amber-500/10 border-b border-amber-500/20 px-3.5 py-2.5 space-y-2 text-left shrink-0">
              <div className="flex items-start gap-1.5 text-amber-500">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-[10.5px] font-bold">合并冲突提示</h4>
                  <p className="text-[9.5px] text-on-surface/75 leading-relaxed mt-0.5">检测到冲突代码行，请选择保留策略：</p>
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => git.handleResolveConflict('ours')} className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-700 active:scale-95 text-white font-extrabold text-[10px] rounded-lg cursor-pointer transition-all flex items-center justify-center gap-1.5">
                  <Lock className="w-3 h-3" /><span>保留当前</span>
                </button>
                <button type="button" onClick={() => git.handleResolveConflict('theirs')} className="flex-1 py-1.5 bg-amber-600 hover:bg-amber-700 active:scale-95 text-white font-extrabold text-[10px] rounded-lg cursor-pointer transition-all flex items-center justify-center gap-1.5">
                  <ArrowUp className="w-3 h-3" /><span>保留传入</span>
                </button>
                <button type="button" onClick={() => git.handleResolveConflict('both')} className="px-2.5 py-1.5 bg-on-surface/10 hover:bg-on-surface/20 active:scale-95 text-on-surface font-extrabold text-[10px] rounded-lg cursor-pointer transition-all">保留双方</button>
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-3.5 space-y-3 bg-neutral-950/90 text-left">
            <div className="flex items-center justify-between border-b border-outline/10 pb-2">
              <span className="text-[10px] text-on-surface/40 uppercase tracking-widest font-black">{git.diffHasConflict ? '冲突代码' : '差异详情'}</span>
              <button onClick={() => { if (git.diffContent) { navigator.clipboard.writeText(git.diffContent); git.showFeedback('success', '已复制到剪贴板'); } }} className="text-[10px] text-primary hover:underline font-bold">复制</button>
            </div>
            <DiffView content={git.diffContent} hasConflict={git.diffHasConflict} />
          </div>
        </div>
      )}
    </div>
  );
}
