import { useState, useRef, useEffect } from 'react';
import {
  GitBranch,
  RefreshCw,
  ArrowUp,
  Check,
  Plus,
  AlertCircle,
  X,
  ChevronDown,
  ChevronRight,
  Clock,
  Lock,
  Settings,
  History,
  GitCommitHorizontal,
} from '../utils/icons';
import { useGit } from '../git/useGit';

// ── Diff Renderer ────────────────────────────────────────────────
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

// ── Branch Selector ─────────────────────────────────────────────
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

// ── File Item Component ─────────────────────────────────────────
function FileItem({
  file,
  isStaged,
  onToggleStage,
  onShowDiff,
}: {
  file: { name: string; status: string; mtime?: string };
  isStaged: boolean;
  onToggleStage: () => void;
  onShowDiff: () => void;
}) {
  const statusColors: Record<string, string> = {
    untracked: 'text-emerald-500 bg-emerald-500/10',
    modified: 'text-amber-500 bg-amber-500/10',
    deleted: 'text-rose-500 bg-rose-500/10',
  };
  const statusLabel: Record<string, string> = {
    untracked: 'U',
    modified: 'M',
    deleted: 'D',
  };

  return (
    <div className="flex items-center gap-1.5 py-1 px-2 hover:bg-on-surface/5 rounded-lg group transition-colors">
      <span className={`text-[9.5px] shrink-0 font-extrabold px-1 rounded font-mono ${statusColors[file.status] || 'text-on-surface/60 bg-on-surface/5'}`}>
        {statusLabel[file.status] || '?'}
      </span>
      <div onClick={onShowDiff} className="flex-1 min-w-0 cursor-pointer flex items-center gap-2">
        <span className="font-mono text-[11px] truncate text-on-surface/80 group-hover:text-primary transition-colors">{file.name}</span>
        {file.mtime && <span className="text-[8.5px] text-on-surface/35 font-mono shrink-0">{file.mtime}</span>}
      </div>
      <button
        onClick={onToggleStage}
        className={`opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded cursor-pointer ${
          isStaged
            ? 'bg-rose-500/10 text-rose-400 hover:bg-rose-500 hover:text-white'
            : 'bg-primary/10 text-primary hover:bg-primary hover:text-white'
        }`}
        title={isStaged ? '取消暂存' : '暂存'}
      >
        {isStaged ? <X className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
      </button>
    </div>
  );
}

// ── History Item Component ──────────────────────────────────────
function HistoryItem({
  commit,
  onShowDiff,
}: {
  commit: { hash: string; message: string; author: string; relativeTime: string };
  onShowDiff: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onShowDiff}
      className="w-full p-2.5 bg-surface-bright/40 border border-outline/15 rounded-xl hover:border-primary/40 hover:bg-on-surface/5 transition-all text-left flex flex-col gap-1 cursor-pointer group"
    >
      <div className="flex justify-between items-center w-full">
        <span className="font-mono text-[9.5px] text-primary bg-primary/10 px-1.5 py-0.5 rounded font-bold group-hover:underline">{commit.hash}</span>
        <span className="text-[9.5px] text-on-surface/40 font-mono">{commit.relativeTime}</span>
      </div>
      <p className="text-[11px] font-bold text-on-surface leading-snug group-hover:text-primary">{commit.message}</p>
      <div className="flex justify-between items-center w-full mt-1.5 text-[9px] text-on-surface/40 border-t border-outline/10 pt-1">
        <span className="font-mono">提交者: {commit.author}</span>
        <span className="text-primary font-bold group-hover:translate-x-0.5 transition-transform">查看 Diff {'\u2192'}</span>
      </div>
    </button>
  );
}

// ── Settings Panel (inline overlay) ─────────────────────────────
function SettingsPanel({
  git,
  onClose,
}: {
  git: ReturnType<typeof useGit>;
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-surface animate-fade-in">
      {/* Settings Header */}
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-outline/30 bg-surface-bright shrink-0">
        <div className="flex items-center gap-2">
          <Settings className="w-4 h-4 text-primary" />
          <span className="text-xs font-bold text-on-surface">设置</span>
        </div>
        <button type="button" onClick={onClose} className="p-1.5 hover:bg-on-surface/10 rounded-md text-on-surface/60 hover:text-on-surface transition-colors cursor-pointer" title="返回">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4 text-left">
        {/* User Config */}
        <div className="bg-surface-bright/50 border border-outline/20 p-3 rounded-2xl space-y-3">
          <div className="flex items-center gap-1.5 pb-1 border-b border-outline/10">
            <span className="text-[11px] font-extrabold text-on-surface">提交人配置</span>
          </div>
          <div className="space-y-2.5">
            <div className="space-y-1">
              <label className="text-[9.5px] text-on-surface/50 font-bold">用户名</label>
              <input type="text" value={git.userName} onChange={(e) => git.setUserName(e.target.value)} placeholder="github_username" className="w-full text-[10.5px] px-2.5 py-1.5 bg-surface text-on-surface border border-outline/25 rounded-lg outline-none focus:border-primary" />
            </div>
            <div className="space-y-1">
              <label className="text-[9.5px] text-on-surface/50 font-bold">邮箱</label>
              <input type="email" value={git.userEmail} onChange={(e) => git.setUserEmail(e.target.value)} placeholder="user@domain.com" className="w-full text-[10.5px] px-2.5 py-1.5 bg-surface text-on-surface border border-outline/25 rounded-lg outline-none focus:border-primary" />
            </div>
          </div>
        </div>

        {/* Remote Config */}
        <div className="bg-surface-bright/50 border border-outline/20 p-3 rounded-2xl space-y-3">
          <div className="flex items-center gap-1.5 pb-1 border-b border-outline/10">
            <span className="text-[11px] font-extrabold text-on-surface">远程仓库</span>
          </div>
          <div className="space-y-2.5">
            <div className="space-y-1">
              <label className="text-[9.5px] text-on-surface/50 font-bold">HTTPS 链接</label>
              <input type="text" value={git.remoteUrl} onChange={(e) => git.setRemoteUrl(e.target.value)} placeholder="https://github.com/user/repo.git" className="w-full text-[10.5px] px-2.5 py-1.5 bg-surface text-on-surface border border-outline/25 rounded-lg outline-none focus:border-primary font-mono" />
            </div>
            <div className="space-y-1">
              <label className="text-[9.5px] text-on-surface/50 font-bold flex items-center gap-1"><Lock className="w-2.5 h-2.5 shrink-0" /><span>访问密钥</span></label>
              <input type="password" value={git.accessToken} onChange={(e) => git.setAccessToken(e.target.value)} placeholder="ghp_***" className="w-full text-[10.5px] px-2.5 py-1.5 bg-surface text-on-surface border border-outline/25 rounded-lg outline-none focus:border-primary font-mono" />
            </div>
            <div className="space-y-1">
              <label className="text-[9.5px] text-on-surface/50 font-bold">目标分支</label>
              <input type="text" value={git.targetBranch} onChange={(e) => git.setTargetBranch(e.target.value)} placeholder="main" className="w-full text-[10.5px] px-2.5 py-1.5 bg-surface text-on-surface border border-outline/25 rounded-lg outline-none focus:border-primary font-mono" />
            </div>
          </div>
        </div>

        <button onClick={() => { git.handleSaveConfig(); onClose(); }} disabled={git.loading} className="w-full py-2 bg-primary hover:bg-primary-hover text-bg rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1">
          <Check className="w-3.5 h-3.5" /><span>保存配置</span>
        </button>
      </div>
    </div>
  );
}

// ── Push Progress Bar ───────────────────────────────────────────
function PushProgress({ progress, success }: { progress: number; success: boolean }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-1.5">
      <div className="flex-1 h-1.5 bg-surface-bright border border-outline/10 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ease-out ${success ? 'bg-emerald-500' : 'bg-primary'}`}
          style={{ width: `${Math.min(progress, 100)}%` }}
        />
      </div>
      <span className={`text-[9.5px] font-mono font-bold shrink-0 ${success ? 'text-emerald-400' : 'text-primary'}`}>
        {success ? '100%' : `${progress}%`}
      </span>
    </div>
  );
}

// ── Main GitPanel Component ─────────────────────────────────────
interface GitPanelProps {
  onClose: () => void;
}

export default function GitPanel({ onClose }: GitPanelProps) {
  const git = useGit();
  const [showBranchSelector, setShowBranchSelector] = useState(false);
  const [viewMode, setViewMode] = useState<'changes' | 'history'>('changes');
  const [expandedStaged, setExpandedStaged] = useState(true);
  const [expandedUnstaged, setExpandedUnstaged] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const commitInputRef = useRef<HTMLInputElement>(null);

  const currentBranch = git.targetBranch || git.statusData?.branch || 'main';

  // Auto-expand sections based on content
  useEffect(() => {
    if (git.stagedFiles.length > 0) setExpandedStaged(true);
    if (git.unstagedFiles.length > 0) setExpandedUnstaged(true);
  }, [git.stagedFiles.length, git.unstagedFiles.length]);

  // Focus commit input on mount
  useEffect(() => {
    const timer = setTimeout(() => commitInputRef.current?.focus(), 300);
    return () => clearTimeout(timer);
  }, []);

  const handleCommitKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      git.handleCommit();
    }
  };

  const isPushing = git.pushProgress !== null;

  return (
    <div className="flex-1 flex flex-col h-full bg-surface relative select-none">
      {/* ─── Header ─── */}
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-outline/30 bg-surface-bright shrink-0">
        <div className="flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-primary" />
          <span className="text-xs font-bold tracking-wider text-on-surface">Git</span>
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
          <button type="button" onClick={() => { setShowSettings(true); setViewMode('changes'); }} className="p-1.5 hover:bg-on-surface/10 rounded-md text-on-surface/60 hover:text-primary transition-colors cursor-pointer" title="设置">
            <Settings className="w-3.5 h-3.5" />
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

      {/* ─── Loading / Uninitialized / Settings Overlay ─── */}
      {showSettings ? (
        <SettingsPanel git={git} onClose={() => setShowSettings(false)} />
      ) : !git.statusData ? (
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
        /* Initialized - Main View */
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* ─── View Toggle (no settings tab) ─── */}
          <div className="flex border-b border-outline/30 bg-surface-bright/50 shrink-0">
            <button
              onClick={() => setViewMode('changes')}
              className={`flex-1 py-2 text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 ${
                viewMode === 'changes'
                  ? 'text-primary border-b-2 border-primary bg-primary/5'
                  : 'text-on-surface/55 hover:text-on-surface/90 border-b-2 border-transparent'
              }`}
            >
              <GitCommitHorizontal className="w-3.5 h-3.5" />
              <span>变更 {git.statusData.files.length > 0 && `(${git.statusData.files.length})`}</span>
            </button>
            <button
              onClick={() => setViewMode('history')}
              className={`flex-1 py-2 text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 ${
                viewMode === 'history'
                  ? 'text-primary border-b-2 border-primary bg-primary/5'
                  : 'text-on-surface/55 hover:text-on-surface/90 border-b-2 border-transparent'
              }`}
            >
              <History className="w-3.5 h-3.5" />
              <span>历史</span>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {/* ═══ CHANGES VIEW ═══ */}
            {viewMode === 'changes' && (
              <div className="flex flex-col h-full">
                {/* File Changes Section */}
                <div className="flex-1 overflow-y-auto">
                  {/* ── Compact Sync Bar ── */}
                  <div className="flex items-center justify-between px-3 py-2 border-b border-outline/10 bg-surface-bright/30 shrink-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <ArrowUp className="w-3 h-3 text-on-surface/40 shrink-0" />
                      {git.remoteUrl ? (
                        <span className="text-[9.5px] text-on-surface/60 font-mono truncate">
                          {git.remoteUrl.replace(/https:\/\/|[a-zA-Z0-9_-]+@/g, '').replace(/\.git$/, '')}
                        </span>
                      ) : (
                        <span className="text-[9.5px] text-on-surface/40">未配置远程仓库</span>
                      )}
                    </div>
                    {git.remoteUrl ? (
                      <button
                        onClick={git.handlePush}
                        disabled={git.loading || isPushing}
                        className="shrink-0 text-[9.5px] px-2.5 py-1 bg-primary hover:bg-primary-hover active:scale-95 text-bg font-extrabold rounded-lg transition-all flex items-center gap-1 disabled:opacity-40"
                      >
                        {isPushing ? <RefreshCw className="w-2.5 h-2.5 animate-spin" /> : <ArrowUp className="w-2.5 h-2.5" />}
                        <span>{isPushing ? '推送中' : '推送'}</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => setShowSettings(true)}
                        className="shrink-0 text-[9.5px] px-2.5 py-1 bg-primary/10 hover:bg-primary/20 text-primary font-extrabold rounded-lg transition-all flex items-center gap-1"
                      >
                        <Settings className="w-2.5 h-2.5" />
                        <span>配置</span>
                      </button>
                    )}
                  </div>

                  {/* ── Push Progress (thin bar) ── */}
                  {isPushing && (
                    <PushProgress progress={git.pushProgress} success={git.pushSuccessState} />
                  )}

                  {/* ── Files ── */}
                  <div className="p-3 space-y-4">
                    {/* Staged Files */}
                    {git.stagedFiles.length > 0 && (
                      <div className="space-y-1.5 text-left">
                        <button onClick={() => setExpandedStaged(!expandedStaged)} className="flex items-center gap-1.5 w-full px-1">
                          {expandedStaged ? <ChevronDown className="w-3 h-3 text-on-surface/40" /> : <ChevronRight className="w-3 h-3 text-on-surface/40" />}
                          <span className="text-[10.5px] font-extrabold text-emerald-400">已暂存 ({git.stagedFiles.length})</span>
                        </button>
                        {expandedStaged && (
                          <div className="space-y-0.5 border-l-2 border-emerald-500/20 pl-2 ml-1">
                            {git.stagedFiles.map((f, i) => (
                              <FileItem
                                key={i}
                                file={f}
                                isStaged={true}
                                onToggleStage={() => git.stageFile(f.name)}
                                onShowDiff={() => git.handleViewFileDiff(f.name)}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Unstaged Files */}
                    <div className="space-y-1.5 text-left">
                      <div className="flex items-center justify-between px-1">
                        <button onClick={() => setExpandedUnstaged(!expandedUnstaged)} className="flex items-center gap-1.5">
                          {expandedUnstaged ? <ChevronDown className="w-3 h-3 text-on-surface/40" /> : <ChevronRight className="w-3 h-3 text-on-surface/40" />}
                          <span className="text-[10.5px] font-extrabold text-on-surface/70">变更 ({git.unstagedFiles.length})</span>
                        </button>
                        {git.unstagedFiles.length > 0 && (
                          <button onClick={() => git.stageFile()} disabled={git.loading} className="text-[9.5px] text-primary hover:underline cursor-pointer font-bold flex items-center gap-0.5" title="将所有未暂存的文件一次性添加到暂存区">
                            <Plus className="w-2.5 h-2.5" /> 全部暂存
                          </button>
                        )}
                      </div>
                      {expandedUnstaged && (
                        <>
                          {git.unstagedFiles.length === 0 ? (
                            <p className="text-[11px] text-on-surface/35 py-3 text-center bg-on-surface/5 border border-dashed border-outline/10 rounded-xl">没有未暂存的更改</p>
                          ) : (
                            <div className="space-y-0.5">
                              {git.unstagedFiles.map((f, i) => (
                                <FileItem
                                  key={i}
                                  file={f}
                                  isStaged={false}
                                  onToggleStage={() => git.stageFile(f.name)}
                                  onShowDiff={() => git.handleViewFileDiff(f.name)}
                                />
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* ── Commit Bar (fixed bottom) ── */}
                <div className="border-t border-outline/30 bg-surface-bright p-3 space-y-2 shrink-0">
                  <div className="flex gap-2">
                    <input
                      ref={commitInputRef}
                      type="text"
                      value={git.commitMessage}
                      onChange={(e) => git.setCommitMessage(e.target.value)}
                      onKeyDown={handleCommitKeyDown}
                      placeholder="提交备注 (Enter 提交)"
                      className="flex-1 text-[11px] p-2 bg-surface text-on-surface border border-outline/25 rounded-lg focus:border-primary outline-none"
                    />
                    <button
                      onClick={git.handleCommit}
                      disabled={git.loading || git.stagedFiles.length === 0}
                      className="px-3 bg-primary hover:bg-primary-hover text-bg rounded-lg text-[10.5px] font-bold cursor-pointer transition-colors flex items-center justify-center gap-1 disabled:opacity-35 disabled:pointer-events-none"
                    >
                      <span>提交</span>
                    </button>
                  </div>
                  {git.stagedFiles.length > 0 && (
                    <button
                      onClick={async () => { await git.handleCommit(); await git.handlePush(); }}
                      disabled={git.loading || !git.remoteUrl}
                      className="w-full py-1.5 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded-lg text-[10px] font-bold cursor-pointer transition-colors flex items-center justify-center gap-1 disabled:opacity-35 disabled:pointer-events-none"
                    >
                      <ArrowUp className="w-3 h-3" /><span>提交并推送</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* ═══ HISTORY VIEW ═══ */}
            {viewMode === 'history' && (
              <div className="p-3 space-y-3 text-left">
                {git.statusData.commits.length > 0 && (
                  <>
                    <div className="flex items-center gap-1.5 px-1">
                      <Clock className="w-3 h-3 text-on-surface/40" />
                      <span className="text-[10px] text-on-surface/50 font-bold">提交历史 ({git.statusData.commits.length})</span>
                    </div>
                    <div className="space-y-2 select-text">
                      {git.statusData.commits.map((log, i) => (
                        <HistoryItem
                          key={i}
                          commit={log}
                          onShowDiff={() => git.handleViewCommitDiff(log.hash)}
                        />
                      ))}
                    </div>
                  </>
                )}
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
                {git.diffHasConflict ? '合并冲突' : git.diffTitle}
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