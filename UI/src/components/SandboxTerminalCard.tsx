import React, { useState } from 'react';
import { Terminal, ChevronDown, CheckCircle2, XCircle, Loader2, Copy } from 'lucide-react';
import type { SandboxExecuteCall } from '../services/e2b/E2BService';

interface SandboxTerminalCardProps {
  call: SandboxExecuteCall;
}

/**
 * SandboxTerminalCard — E2B 沙箱命令执行结果卡
 *
 * 简化版:展示 sandbox.execute 工具调用的命令/stdout/stderr/退出码
 * 原版可能更复杂(含流式更新/取消/重试/下载日志)
 * 用户恢复原文件后可直接覆盖
 */
export const SandboxTerminalCard: React.FC<SandboxTerminalCardProps> = ({ call }) => {
  const [open, setOpen] = useState(true);
  const isRunning = call.status === 'running';
  const isSuccess = call.status === 'success';
  const isError = call.status === 'error';

  const StatusIcon = isRunning
    ? Loader2
    : isSuccess
      ? CheckCircle2
      : XCircle;

  const statusColor = isRunning
    ? 'text-blue-400'
    : isSuccess
      ? 'text-emerald-400'
      : 'text-red-400';

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
          <StatusIcon
            className={`w-3 h-3 shrink-0 ${statusColor} ${isRunning ? 'animate-spin' : ''}`}
          />
          <Terminal className="w-3 h-3 text-on-surface/50 shrink-0" />
          <code className="text-on-surface/80 truncate font-mono">
            $ {call.command}
          </code>
        </div>
        {call.executionTime !== undefined && (
          <span className="text-[9px] text-on-surface/40 font-mono shrink-0 ml-2">
            {call.executionTime}ms
          </span>
        )}
      </div>

      {open && (
        <div className="bg-black/30">
          {call.stdout && (
            <pre className="px-3 py-2 text-[10px] text-emerald-200/90 font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
              {call.stdout}
            </pre>
          )}
          {call.stderr && (
            <pre className="px-3 py-2 text-[10px] text-red-300/90 font-mono whitespace-pre-wrap break-words border-t border-red-500/20 max-h-48 overflow-y-auto">
              {call.stderr}
            </pre>
          )}
          {call.exitCode !== undefined && !isRunning && (
            <div className="px-3 py-1.5 text-[9px] text-on-surface/50 font-mono border-t border-outline/20 flex items-center gap-2">
              <span>exit code:</span>
              <span className={isSuccess ? 'text-emerald-400' : 'text-red-400'}>
                {call.exitCode}
              </span>
              {call.stdout && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard?.writeText(call.stdout || '');
                  }}
                  className="ml-auto text-on-surface/40 hover:text-on-surface/80 transition-colors"
                  title="复制 stdout"
                >
                  <Copy className="w-3 h-3" />
                </button>
              )}
            </div>
          )}
          {isRunning && (
            <div className="px-3 py-1.5 text-[9px] text-blue-300/80 font-mono border-t border-outline/20 flex items-center gap-2">
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
              <span>命令执行中…</span>
            </div>
          )}
          {isError && call.errorCode && (
            <div className="px-3 py-1.5 text-[9px] text-red-300/80 font-mono border-t border-red-500/20">
              {call.errorCode}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SandboxTerminalCard;
