import React, { useState, useEffect, useCallback } from 'react';

// ── 类型定义（严格类型，禁止 any）─────────────────────────────
type ProxyMode = 'system' | 'direct' | 'manual' | 'pac';
type ProxyProtocol = 'http' | 'https' | 'socks4' | 'socks5';

interface ProxyConfig {
  mode: ProxyMode;
  protocol?: ProxyProtocol;
  server?: string;
  port?: string;
  bypassList?: string;
  pacUrl?: string;
}

interface SystemProxyInfo {
  enabled: boolean;
  server?: string;
  pacUrl?: string;
  platform?: string;
}

interface TestResult {
  ok: boolean;
  ip?: string;
  latency?: number;
  error?: string;
}

// ── 声明 window.soloforge.proxy（由 preload.cjs 注入）──────────
declare global {
  interface Window {
    soloforge: {
      proxy: {
        getConfig: () => Promise<ProxyConfig>;
        apply: (config: ProxyConfig) => Promise<{ ok: boolean }>;
        testConnection: () => Promise<TestResult>;
        getSystemInfo: () => Promise<SystemProxyInfo>;
      };
    };
  }
}

// ── 模式选项配置 ──
const MODE_OPTIONS: { id: ProxyMode; label: string; desc: string; defaultMode?: boolean }[] = [
  { id: 'system', label: '系统代理', desc: '读取 OS 代理设置，含 WPAD/PAC 自动发现', defaultMode: true },
  { id: 'direct', label: '直连模式', desc: '不使用代理，所有请求直连' },
  { id: 'manual', label: '手动代理', desc: '用户手动配置代理服务器地址和端口' },
  { id: 'pac',    label: 'PAC 自动配置', desc: '通过 PAC URL 自动决定代理路由规则' },
];

const PROTOCOL_OPTIONS: { id: ProxyProtocol; label: string }[] = [
  { id: 'http',   label: 'HTTP' },
  { id: 'https',  label: 'HTTPS' },
  { id: 'socks4', label: 'SOCKS4' },
  { id: 'socks5', label: 'SOCKS5' },
];

// ── 组件 ──────────────────────────────────────────────────────
export default function ProxyTab() {
  // 状态管理
  const [mode, setMode] = useState<ProxyMode>('system');
  const [protocol, setProtocol] = useState<ProxyProtocol>('http');
  const [server, setServer] = useState('127.0.0.1');
  const [port, setPort] = useState('7890');
  const [bypassList, setBypassList] = useState('');
  const [pacUrl, setPacUrl] = useState('');
  const [showBypassEdit, setShowBypassEdit] = useState(false);
  // 测试结果
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  // 系统代理信息
  const [sysInfo, setSysInfo] = useState<SystemProxyInfo | null>(null);
  // 保存状态
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'ok' | 'error'>('idle');

  // ── 初始化：从主进程加载已保存的配置 ──
  useEffect(() => {
    loadConfig();
    loadSystemInfo();
  }, []);

  const loadConfig = async () => {
    try {
      const config: ProxyConfig = await window.soloforge.proxy.getConfig();
      setMode(config.mode || 'system');
      if (config.protocol) setProtocol(config.protocol);
      if (config.server) setServer(config.server);
      if (config.port) setPort(config.port);
      if (config.bypassList) setBypassList(config.bypassList);
      if (config.pacUrl) setPacUrl(config.pacUrl);
    } catch {
      // 首次使用或 IPC 不可用，保持默认值
    }
  };

  const loadSystemInfo = async () => {
    try {
      const info: SystemProxyInfo = await window.soloforge.proxy.getSystemInfo();
      setSysInfo(info);
    } catch {
      // 忽略
    }
  };

  // ── 应用配置到主进程 ──
  const handleApply = useCallback(async () => {
    setSaving(true);
    setSaveStatus('idle');

    try {
      const config: ProxyConfig = { mode };
      if (mode === 'manual') {
        config.protocol = protocol;
        config.server = server.trim();
        config.port = port.trim();
        if (bypassList.trim()) config.bypassList = bypassList.trim();
      }
      if (mode === 'pac') {
        config.pacUrl = pacUrl.trim();
      }

      await window.soloforge.proxy.apply(config);
      setSaveStatus('ok');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    } finally {
      setSaving(false);
    }
  }, [mode, protocol, server, port, bypassList, pacUrl]);

  // ── 连通性测试 ──
  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result: TestResult = await window.soloforge.proxy.testConnection();
      setTestResult(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '测试失败';
      setTestResult({ ok: false, error: msg });
    } finally {
      setTesting(false);
    }
  }, []);

  // ── 模式切换按钮样式 ──
  const modeBtnClass = (m: ProxyMode) =>
    `p-3 rounded-xl border text-left cursor-pointer transition-all duration-150 ${
      mode === m
        ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8 text-[var(--color-on-surface)] shadow-sm'
        : 'border-[var(--color-outline)]/15 text-on-surface/60 hover:border-[var(--color-outline)]/30 hover:bg-[var(--color-surface)]'
    }`;

  // ── 渲染 ──
  return (
    <div className="space-y-5 animate-fadeIn">
      {/* 标题区 */}
      <div className="border-b border-[var(--color-outline)]/15 pb-3">
        <h3 className="text-base font-bold text-[var(--color-on-surface)]">网络与代理配置</h3>
        <p className="text-xs text-on-surface/45 mt-1 leading-relaxed">
          配置应用程序的网络代理设置。修改后需点击「应用配置」生效。
          {mode === 'pac' && (
            <span className="text-amber-500/80 ml-1">⚠️ PAC 模式仅对渲染进程（UI 内请求）生效，Node.js 后端请求将直连。</span>
          )}
        </p>
      </div>

      {/* 四模式选择 */}
      <div className="grid grid-cols-2 gap-3">
        {MODE_OPTIONS.map((opt) => (
          <button key={opt.id} onClick={() => setMode(opt.id)} className={modeBtnClass(opt.id)}>
            <span className="text-sm font-semibold block">{opt.label}</span>
            {opt.defaultMode && mode === opt.id && (
              <span className="text-[10px] mt-0.5 inline-block px-1.5 py-0.5 rounded bg-[var(--color-primary)]/10 text-[var(--color-primary)] font-medium">默认</span>
            )}
            <span className="text-[11px] mt-1 block opacity-55">{opt.desc}</span>
          </button>
        ))}
      </div>

      {/* ── 模式详情区域（根据选择动态切换） ── */}

      {/* 系统代理模式详情 */}
      {mode === 'system' && (
        <div className="p-4 bg-[var(--color-surface)] border border-[var(--color-outline)]/12 rounded-xl space-y-2">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500/70 animate-pulse" />
            <span className="text-sm font-medium text-[var(--color-on-surface)]">系统代理模式</span>
          </div>
          {sysInfo ? (
            sysInfo.enabled ? (
              <div className="text-xs text-on-surface/60 space-y-1 pl-4">
                <p>状态：<span className="text-green-600 font-medium">已启用</span></p>
                {sysInfo.server && <p>地址：<code className="font-mono bg-black/5 px-1.5 py-0.5 rounded">{sysInfo.server}</code></p>}
                {sysInfo.pacUrl && <p>PAC URL：<code className="font-mono bg-black/5 px-1.5 py-0.5 rounded break-all">{sysInfo.pacUrl}</code></p>}
                {!sysInfo.server && !sysInfo.pacUrl && <p className="text-amber-600/80">检测到系统代理已启用，但未找到具体地址信息</p>}
                {sysInfo.platform && sysInfo.platform !== 'win32' && (
                  <p className="text-amber-600/70 italic">当前平台 ({sysInfo.platform}) 的系统代理检测为实验性支持</p>
                )}
              </div>
            ) : (
              <p className="text-xs text-on-surface/50 pl-4">系统代理当前未启用（将使用直连）</p>
            )
          ) : (
            <p className="text-xs text-on-surface/40 pl-4">正在检测系统代理...</p>
          )}
        </div>
      )}

      {/* 手动代理模式详情 */}
      {mode === 'manual' && (
        <div className="p-4 bg-[var(--color-surface)] border border-[var(--color-outline)]/12 rounded-xl space-y-4">
          {/* 协议选择 */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[var(--color-primary)]/80 uppercase tracking-wider">协议类型</label>
            <div className="flex gap-2">
              {PROTOCOL_OPTIONS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setProtocol(p.id)}
                  className={`px-3 py-1.5 text-xs rounded-lg border transition-all cursor-pointer ${
                    protocol === p.id
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)] font-semibold'
                      : 'border-[var(--color-outline)]/20 text-on-surface/50 hover:border-[var(--color-outline)]/40'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* 地址 + 端口 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--color-primary)]/80">服务器地址</label>
              <input
                type="text"
                value={server}
                onChange={(e) => setServer(e.target.value)}
                placeholder="127.0.0.1"
                className="w-full text-sm p-2.5 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-lg text-[var(--color-on-surface)] font-mono focus:border-[var(--color-primary)] outline-none transition-colors"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--color-primary)]/80">端口</label>
              <input
                type="text"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="7890"
                className="w-full text-sm p-2.5 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-lg text-[var(--color-on-surface)] font-mono focus:border-[var(--color-primary)] outline-none transition-colors"
              />
            </div>
          </div>

          {/* Bypass 绕过列表 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-[var(--color-primary)]/80">绕过列表（可选）</label>
              <button
                onClick={() => setShowBypassEdit(!showBypassEdit)}
                className="text-[11px] text-[var(--color-primary)]/70 hover:text-[var(--color-primary)] transition-colors"
              >
                {showBypassEdit ? '收起' : '编辑'}
              </button>
            </div>
            {showBypassEdit ? (
              <textarea
                value={bypassList}
                onChange={(e) => setBypassList(e.target.value)}
                placeholder="localhost,127.0.0.1,::1,*.local,&lt;local&gt;"
                rows={2}
                className="w-full text-xs p-2.5 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-lg text-[var(--color-on-surface)] font-mono focus:border-[var(--color-primary)] outline-none resize-y"
              />
            ) : (
              <p className="text-[11px] text-on-surface/40 font-mono truncate">
                {bypassList || '使用默认绕过列表（localhost / 127.0.0.1 / ::1 / *.local / 内部服务端口）'}
              </p>
            )}
          </div>
        </div>
      )}

      {/* PAC 模式详情 */}
      {mode === 'pac' && (
        <div className="p-4 bg-[var(--color-surface)] border border-[var(--color-outline)]/12 rounded-xl space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[var(--color-primary)]/80">PAC 脚本 URL</label>
            <input
              type="text"
              value={pacUrl}
              onChange={(e) => setPacUrl(e.target.value)}
              placeholder="http://proxy.company.com/proxy.pac"
              className="w-full text-sm p-2.5 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-lg text-[var(--color-on-surface)] font-mono focus:border-[var(--color-primary)] outline-none transition-colors"
            />
          </div>
          <p className="text-[11px] text-amber-600/70 leading-relaxed">
            ⚠️ PAC 模式仅对 Chromium 渲染进程生效。Node.js 后端请求（LLM 调度、API 请求等）将直连，
            不经过 PAC 路由规则。
          </p>
        </div>
      )}

      {/* 直连模式提示 */}
      {mode === 'direct' && (
        <div className="p-4 bg-[var(--color-surface)] border border-[var(--color-outline)]/12 rounded-xl">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-500/70" />
            <span className="text-sm font-medium text-[var(--color-on-surface)]">直连模式</span>
          </div>
          <p className="text-xs text-on-surface/50 mt-2 pl-4">
            所有网络请求将直接连接，不经过任何代理服务器。适用于已有全局 VPN 或加速器的场景。
          </p>
        </div>
      )}

      {/* 操作栏：应用 + 测试 */}
      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={handleApply}
          disabled={saving}
          className={`px-5 py-2.5 rounded-lg text-sm font-semibold transition-all cursor-pointer ${
            saving
              ? 'bg-gray-300 text-gray-500 cursor-wait'
              : saveStatus === 'ok'
                ? 'bg-green-500/15 text-green-700 border border-green-500/25'
                : saveStatus === 'error'
                  ? 'bg-red-500/15 text-red-700 border border-red-500/25'
                  : 'bg-[var(--color-primary)] text-white hover:brightness-110 active:scale-[0.98]'
          }`}
        >
          {saving ? '保存中...' : saveStatus === 'ok' ? '✓ 已应用' : saveStatus === 'error' ? '✗ 失败' : '应用配置'}
        </button>

        <button
          onClick={handleTest}
          disabled={testing}
          className="px-4 py-2.5 rounded-lg text-sm font-medium border border-[var(--color-outline)]/20 text-on-surface/70 hover:bg-[var(--color-surface)] transition-all cursor-pointer disabled:opacity-50"
        >
          {testing ? '测试中...' : '测试连接'}
        </button>

        {/* 测试结果展示 */}
        {testResult && (
          <span className={`text-xs font-mono ${testResult.ok ? 'text-green-600' : 'text-red-500'}`}>
            {testResult.ok
              ? `出口 IP: ${testResult.ip} · 延迟: ${testResult.latency}ms`
              : `失败: ${testResult.error}`
            }
          </span>
        )}
      </div>
    </div>
  );
}
