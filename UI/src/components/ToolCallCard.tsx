/**
 * ToolCallCard — 在 ChatPanel 里渲染 AI 的 hashline 工具调用结果
 *
 * 设计原则:
 *  - 折叠成 1 行(文件名 + 状态点),默认展开 detail
 *  - diff 用等宽字体,绿/红前缀,+/-/+N -M 概览
 *  - 错误态: 显示 code + 提示(stale 时提示"AI 将自动重试")
 */
import React, { useState } from 'react';
import { ChevronDown, CheckCircle2, XCircle, Loader2, FileText, Edit3, Layers } from 'lucide-react';
import type { ToolCall, HashlineEditCall, HashlineReadCall, HashlineBatchCall } from '../types';

interface Props {
  call: ToolCall;
}

function basename(p: string): string {
  const m = p.match(/[^\\/]+$/);
  return m ? m[0] : p;
}

function statusDot(status: ToolCall['status']): { color: string; icon: React.ReactElement } {
  if (status === 'running') {
    return {
      color: 'text-blue-400',
      icon: <Loader2 className="w-3 h-3 animate-spin shrink-0" />,
    };
  }
  if (status === 'success') {
    return {
      color: 'text-green-500',
      icon: <CheckCircle2 className="w-3 h-3 shrink-0" />,
    };
  }
  return {
    color: 'text-red-500',
    icon: <XCircle className="w-3 h-3 shrink-0" />,
  };
}

function kindIcon(kind: ToolCall['kind']): React.ReactElement {
  if (kind === 'hashline.read') return <FileText className="w-3.5 h-3.5 shrink-0" />;
  if (kind === 'hashline.edit') return <Edit3 className="w-3.5 h-3.5 shrink-0" />;
  return <Layers className="w-3.5 h-3.5 shrink-0" />;
}

function diffSummary(added: number | undefined, removed: number | undefined): string {
  const a = added ?? 0;
  const r = removed ?? 0;
  return `+${a} -${r}`;
}

/**
 * 把 hashline 的 unified diff 染成行级绿/红
 * 输入格式:
 *   - removed line
 *   + added line
 *    context line
 */
function renderDiff(diff: string | undefined): React.ReactElement {
  if (!diff) return <span className="text-on-surface/40 text-[10px]">no diff</span>;
  const lines = diff.split('\n');
  return (
    <pre className="font-mono text-[10.5px] leading-snug whitespace-pre-wrap break-all bg-bg/60 border border-outline/20 rounded p-2 max-h-60 overflow-y-auto scrollbar-thin">
      {lines.map((line, i) => {
        let cls = 'text-on-surface/70';
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-green-400 bg-green-500/5';
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-400 bg-red-500/5';
        else if (line.startsWith('@@')) cls = 'text-blue-400';
        return (
          <div key={i} className={cls}>
            {line || '\u00A0'}
          </div>
        );
      })}
    </pre>
  );
}

function HeaderLine({ call, dot }: { call: ToolCall; dot: ReturnType<typeof statusDot> }): React.ReactElement {
  if (call.kind === 'hashline.edit') {
    const c = call as HashlineEditCall;
    const file = basename(c.filePath);
    const summary =
      c.status === 'success'
        ? `${c.op} ${diffSummary(c.insertedLineCount, c.removedLineCount)}`
        : c.status === 'error'
          ? `${c.op} 失败 ${c.errorCode ?? ''}`
          : `${c.op} 进行中`;
    return (
      <div className="flex items-center gap-1.5 text-on-surface/80 min-w-0">
        {dot.icon}
        {kindIcon(call.kind)}
        <span className="font-mono font-semibold truncate">{file}</span>
        <span className="text-on-surface/40 text-[10px]">·</span>
        <span className="text-[10px] truncate">{summary}</span>
      </div>
    );
  }
  if (call.kind === 'hashline.read') {
    const c = call as HashlineReadCall;
    const file = basename(c.filePath);
    const summary =
      c.status === 'success'
        ? `read epoch=${c.version?.lockEpoch ?? '?'}`
        : c.status === 'error'
          ? `read 失败 ${c.errorCode ?? ''}`
          : 'read 进行中';
    return (
      <div className="flex items-center gap-1.5 text-on-surface/80 min-w-0">
        {dot.icon}
        {kindIcon(call.kind)}
        <span className="font-mono font-semibold truncate">{file}</span>
        <span className="text-on-surface/40 text-[10px]">·</span>
        <span className="text-[10px] truncate">{summary}</span>
      </div>
    );
  }
  // batch
  const c = call as HashlineBatchCall;
  const summary =
    c.status === 'success'
      ? `${c.succeeded}/${c.total} 全部成功`
      : c.status === 'error'
        ? c.failedAt !== undefined
          ? `${c.succeeded}/${c.total} 回滚 @${c.failedAt} ${c.errorCode ?? ''}`
          : `${c.succeeded}/${c.total} 失败 ${c.errorCode ?? ''}`
        : `batch ${c.total} 项进行中`;
  return (
    <div className="flex items-center gap-1.5 text-on-surface/80 min-w-0">
      {dot.icon}
      {kindIcon(call.kind)}
      <span className="font-semibold">batch</span>
      <span className="text-on-surface/40 text-[10px]">·</span>
      <span className="text-[10px] truncate">{summary}</span>
    </div>
  );
}

function EditDetail({ call }: { call: HashlineEditCall }): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-on-surface/60 font-mono">
        <span className="text-on-surface/40">op:</span>
        <span className="text-on-surface">{call.op}</span>
        {call.status === 'success' && (
          <>
            <span className="text-on-surface/40">diff:</span>
            <span className="text-green-400">+{call.insertedLineCount ?? 0}</span>
            <span className="text-red-400">-{call.removedLineCount ?? 0}</span>
            <span className="text-on-surface/40">epoch:</span>
            <span>{call.newVersion?.lockEpoch ?? '?'}</span>
          </>
        )}
        {call.status === 'error' && (
          <>
            <span className="text-red-400">code:</span>
            <span className="text-red-400 font-semibold">{call.errorCode}</span>
          </>
        )}
      </div>

      {call.status === 'success' && call.diff && (
        <div className="flex flex-col gap-1">
          <div className="text-[10px] text-on-surface/40 uppercase tracking-wider">diff</div>
          {renderDiff(call.diff)}
        </div>
      )}

      {call.status === 'error' && call.errorCode === 'E_STALE_HASH' && (
        <div className="text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5">
          锚点已过期,AI 已收到 fresh 锚点并自动重试中…
        </div>
      )}
      {call.status === 'error' && call.errorCode === 'E_LOCK_TIMEOUT' && (
        <div className="text-[10px] text-orange-300 bg-orange-500/10 border border-orange-500/30 rounded px-2 py-1.5">
          锁等待超时(5s),AI 将稍后重试。
        </div>
      )}
      {call.status === 'error' && call.errorCode === 'E_AGENT_QUOTA' && (
        <div className="text-[10px] text-orange-300 bg-orange-500/10 border border-orange-500/30 rounded px-2 py-1.5">
          单 agent 并发配额已满(3),AI 将释放其他 edit 后重试。
        </div>
      )}
    </div>
  );
}

function ReadDetail({ call }: { call: HashlineReadCall }): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-on-surface/60 font-mono">
        <span className="text-on-surface/40">path:</span>
        <span className="text-on-surface/80 break-all">{call.filePath}</span>
      </div>
      {call.status === 'success' && call.version && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-on-surface/60 font-mono">
          <span className="text-on-surface/40">version:</span>
          <span>mtime {call.version.mtimeMs.toFixed(2)}</span>
          <span>hash {call.version.contentHash.slice(0, 8)}</span>
          <span>epoch {call.version.lockEpoch}</span>
        </div>
      )}
      {call.status === 'error' && (
        <div className="text-[10px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5">
          {call.errorCode ?? 'E_UNKNOWN'}
        </div>
      )}
    </div>
  );
}

export function ToolCallCard({ call }: Props): React.ReactElement {
  const [open, setOpen] = useState(true);
  const dot = statusDot(call.status);

  return (
    <div className="border border-outline/30 rounded-lg overflow-hidden bg-bg/40 font-sans text-[11px]">
      <div
        onClick={() => setOpen(!open)}
        className="px-2.5 py-1.5 bg-surface/60 border-b border-outline/20 flex items-center justify-between cursor-pointer hover:bg-surface/80 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <ChevronDown
            className={`w-3 h-3 text-on-surface/50 transition-transform duration-200 shrink-0 ${
              open ? '' : '-rotate-90'
            }`}
          />
          <HeaderLine call={call} dot={dot} />
        </div>
        {call.durationMs !== undefined && (
          <span className="text-[9px] text-on-surface/40 font-mono shrink-0 ml-2">
            {call.durationMs}ms
          </span>
        )}
      </div>
      {open && (
        <div className="px-2.5 py-2">
          {call.kind === 'hashline.edit' && <EditDetail call={call} />}
          {call.kind === 'hashline.read' && <ReadDetail call={call} />}
          {call.kind === 'hashline.batch' && <BatchDetail call={call} />}
        </div>
      )}
    </div>
  );
}

function BatchDetail({ call }: { call: HashlineBatchCall }): React.ReactElement {
  const results = call.results ?? [];
  return (
    <div className="flex flex-col gap-2">
      {/* 文件清单 + 每文件 diffSummary */}
      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] text-on-surface/40 uppercase tracking-wider">涉及文件</div>
        {results.length === 0 && (
          <div className="text-[10px] text-on-surface/50">无子结果(可能未完成)</div>
        )}
        {results.map((r, i) => {
          const file = basename(r.filePath);
          const isRolledBack = call.status === 'error';
          return (
            <div
              key={i}
              className={`border rounded p-1.5 flex flex-col gap-1 ${
                isRolledBack
                  ? 'border-red-500/30 bg-red-500/5'
                  : 'border-green-500/20 bg-green-500/5'
              }`}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-mono">
                <span className="text-on-surface/40">#{i}</span>
                <span className="text-on-surface font-semibold">{file}</span>
                <span className="text-on-surface/40">·</span>
                <span className="text-green-400">+{r.insertedLineCount}</span>
                <span className="text-red-400">-{r.removedLineCount}</span>
                <span className="text-on-surface/40">·</span>
                <span className="text-on-surface/60">epoch {r.version.lockEpoch}</span>
                {isRolledBack && (
                  <>
                    <span className="text-on-surface/40">·</span>
                    <span className="text-red-400 font-semibold">已回滚</span>
                  </>
                )}
              </div>
              {r.diff && (
                <details>
                  <summary className="text-[9px] text-on-surface/50 cursor-pointer hover:text-on-surface/80 select-none">
                    查看 diff
                  </summary>
                  <div className="mt-1">{renderDiff(r.diff)}</div>
                </details>
              )}
            </div>
          );
        })}
      </div>

      {/* 错误态额外信息 */}
      {call.status === 'error' && call.failedAt !== undefined && (
        <div className="text-[10px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5">
          第 {call.failedAt} 个 edit 触发失败,前 {call.failedAt} 个子结果已整体回滚。
        </div>
      )}
      {call.status === 'error' && call.errorCode === 'E_LOCK_TIMEOUT' && (
        <div className="text-[10px] text-orange-300 bg-orange-500/10 border border-orange-500/30 rounded px-2 py-1.5">
          锁等待超时(5s),AI 将稍后重试整 batch。
        </div>
      )}
      {call.status === 'error' && call.errorCode === 'E_AGENT_QUOTA' && (
        <div className="text-[10px] text-orange-300 bg-orange-500/10 border border-orange-500/30 rounded px-2 py-1.5">
          单 agent 并发配额已满(3),AI 将释放其他 edit 后重试。
        </div>
      )}
    </div>
  );
}