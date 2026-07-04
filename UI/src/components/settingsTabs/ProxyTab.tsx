import React, { useState } from 'react';

// 08. 网络代理配置
export default function ProxyTab() {
  const [proxyMode, setProxyMode] = useState<'none' | 'system' | 'custom'>('none');
  const [proxyServer, setProxyServer] = useState('127.0.0.1');
  const [proxyPort, setProxyPort] = useState('7890');

  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="border-b border-[var(--color-outline)]/20 pb-3 mb-2">
        <h3 className="text-base font-bold text-[var(--color-on-surface)]">网络与代理配置</h3>
        <p className="text-xs text-on-surface/50 mt-1">由于跨区域网络通路差异，可为云运算节点配置代理中转</p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <button
          onClick={() => setProxyMode('none')}
          className={`p-4 rounded-xl border text-center cursor-pointer transition-all ${proxyMode === 'none' ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-on-surface)] font-bold' : 'border-[var(--color-outline)]/20 text-on-surface/50'}`}
        >
          <span className="text-sm font-semibold block">直连模式 (No Proxy)</span>
          <span className="text-xs mt-1 block opacity-50">网络物理链路直接连通</span>
        </button>

        <button
          onClick={() => setProxyMode('system')}
          className={`p-4 rounded-xl border text-center cursor-pointer transition-all ${proxyMode === 'system' ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-on-surface)] font-bold' : 'border-[var(--color-outline)]/20 text-on-surface/50'}`}
        >
          <span className="text-sm font-semibold block">系统环境变量代理</span>
          <span className="text-xs mt-1 block opacity-50">自适应读取环境路由配置</span>
        </button>

        <button
          onClick={() => setProxyMode('custom')}
          className={`p-4 rounded-xl border text-center cursor-pointer transition-all ${proxyMode === 'custom' ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-on-surface)] font-bold' : 'border-[var(--color-outline)]/20 text-on-surface/50'}`}
        >
          <span className="text-sm font-semibold block">手动自定义通道</span>
          <span className="text-xs mt-1 block opacity-50">配置自建 HTTP/SOCKS 转发</span>
        </button>
      </div>

      {proxyMode === 'custom' && (
        <div className="p-4 bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded-xl grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <span className="text-xs text-[var(--color-primary)]/85 font-mono block">代代理地址 (Server Host)</span>
            <input
              type="text"
              value={proxyServer}
              onChange={(e) => setProxyServer(e.target.value)}
              className="w-full text-sm p-3 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-lg text-[var(--color-on-surface)] font-mono focus:border-[var(--color-primary)] outline-none"
            />
          </div>
          <div className="space-y-2">
            <span className="text-xs text-[var(--color-primary)]/85 font-mono block">连接监听端口 (Port Code)</span>
            <input
              type="text"
              value={proxyPort}
              onChange={(e) => setProxyPort(e.target.value)}
              className="w-full text-sm p-3 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-lg text-[var(--color-on-surface)] font-mono focus:border-[var(--color-primary)] outline-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}
