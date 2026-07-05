import React, { useState } from 'react';
import { RefreshCw } from '../../utils/icons';

// 03. 本地模型管理
export default function LocalModelTab() {
  const [localScanStatus, setLocalScanStatus] = useState<'idle' | 'scanning' | 'done'>('idle');
  const [localModels, setLocalModels] = useState([
    { name: 'Ollama: Qwen-2.5-7B (本地)', status: '已集成', size: '4.7 GB' },
    { name: 'Ollama: Llama-3.2 (本地)', status: '已集成', size: '2.0 GB' },
    { name: 'LM Studio: DeepSeek-R1-Distill (本地)', status: '可追加', size: '8.1 GB' }
  ]);
  const triggerLocalScan = () => {
    setLocalScanStatus('scanning');
    setTimeout(() => {
      setLocalScanStatus('done');
      if (localModels.length < 4) {
        setLocalModels([
          ...localModels,
          { name: 'Ollama: Mistral-7B (新扫描到)', status: '可追加', size: '4.1 GB' }
        ]);
      }
    }, 1800);
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="border-b border-[var(--color-outline)]/20 pb-3 mb-2">
        <h3 className="text-base font-bold text-[var(--color-on-surface)]">本地模型管理</h3>
        <p className="text-xs text-on-surface/50 mt-1">自动识别并同步本地 Ollama 或 LM Studio 的大模型</p>
      </div>

      <div className="flex items-center justify-between p-4 bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-xl mb-2">
        <div>
          <span className="text-sm font-bold text-[var(--color-on-surface)]">快速扫描本地运行端口</span>
          <p className="text-xs text-on-surface/50 mt-0.5">检测并连接 11434 / 1234 等常用微内核接口</p>
        </div>
        <button
          onClick={triggerLocalScan}
          disabled={localScanStatus === 'scanning'}
          className="bg-[var(--color-primary)] hover:opacity-90 disabled:opacity-50 text-[var(--color-bg)] px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition-all cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${localScanStatus === 'scanning' ? 'animate-spin' : ''}`} />
          <span>检测本地实例</span>
        </button>
      </div>

      <div className="space-y-2">
        <span className="text-xs text-[var(--color-primary)] font-mono font-semibold block">可用模型列表</span>
        {localModels.map((lm, idx) => (
          <div key={idx} className="p-3 bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded-xl flex items-center justify-between hover:border-[var(--color-primary)]/20 transition-all">
            <div className="flex items-center gap-2.5">
              <div className="w-2.5 h-2.5 rounded-full bg-[var(--color-primary)]/70 shrink-0" />
              <span className="text-xs font-semibold text-[var(--color-on-surface)]">{lm.name}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-on-surface/50 font-mono">{lm.size}</span>
              {lm.status === '已集成' ? (
                <span className="text-xs bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded">自动激活</span>
              ) : (
                <button
                  onClick={() => {
                    const updated = [...localModels];
                    updated[idx].status = '已集成';
                    setLocalModels(updated);
                  }}
                  className="text-xs bg-[var(--color-primary)]/15 hover:bg-[var(--color-primary)]/25 border border-[var(--color-primary)]/30 text-[var(--color-primary)] px-2.5 py-1 rounded cursor-pointer transition-all"
                >
                  导入
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
