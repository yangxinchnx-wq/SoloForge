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

// ── 手绘线条图标（stroke 风格，匹配项目图标体系）──────────────

type IconProps = React.SVGProps<SVGSVGElement>;

/** 系统代理：显示器 + 信号波 */
const SystemProxyIcon = (props: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
    {/* 显示器外框 */}
    <rect x="3" y="5" width="18" height="11" rx="1.5" />
    {/* 底座 */}
    <path d="M9.5 20h5M12 16v4" />
    {/* 信号波 */}
    <path d="M9 9.5a3.5 3.5 0 0 1 6 0M7.5 8a5.5 5.5 0 0 1 9 0" />
    <circle cx="12" cy="11" r="0.6" fill="currentColor" stroke="none" />
  </svg>
);

/** 直连模式：两点直通箭头 */
const DirectConnIcon = (props: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
    {/* 左端节点 */}
    <circle cx="5" cy="12" r="2" />
    {/* 连接线 */}
    <path d="M7.2 12h6.6" />
    {/* 箭头 */}
    <path d="M11 9.5l3 2.5-3 2.5" />
    {/* 右端节点 */}
    <circle cx="19" cy="12" r="2" />
  </svg>
);

/** 手动代理：调节滑杆 */
const ManualProxyIcon = (props: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
    {/* 三条滑杆 */}
    <path d="M4 7h16M4 12h16M4 17h16" />
    {/* 旋钮（填充背景色遮住滑杆） */}
    <circle cx="9" cy="7" r="2.2" fill="var(--color-surface)" />
    <circle cx="15" cy="12" r="2.2" fill="var(--color-surface)" />
    <circle cx="7" cy="17" r="2.2" fill="var(--color-surface)" />
  </svg>
);

/** PAC 自动配置：文档 + 代码括号 */
const PacScriptIcon = (props: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
    {/* 文档轮廓 + 折角 */}
    <path d="M6 3h7l5 5v13H6V3z" />
    <path d="M13 3v5h5" />
    {/* 代码括号 < > */}
    <path d="M10 14.5l-2.2 1.75L10 18M14 14.5l2.2 1.75L14 18" />
  </svg>
);

// ── 模式选项配置 ──
const MODE_OPTIONS: { id: ProxyMode; label: string; desc: string; defaultMode?: boolean; icon: React.ComponentType<IconProps> }[] = [
  { id: 'system', label: '系统代理', desc: '读取 OS 代理设置，含 WPAD/PAC 自动发现', defaultMode: true, icon: SystemProxyIcon },
  { id: 'direct', label: '直连模式', desc: '不使用代理，所有请求直连', icon: DirectConnIcon },
  { id: 'manual', label: '手动代理', desc: '手动配置代理服务器地址和端口', icon: ManualProxyIcon },
  { id: 'pac',    label: 'PAC 自动配置', desc: '通过 PAC URL 自动决定代理路由规则', icon: PacScriptIcon },
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

  // ── 当前选中模式的序号 ──
  const activeModeIndex = MODE_OPTIONS.findIndex(o => o.id === mode);

  // ── 渲染 ──
  return (
    <div className="flex flex-col h-full animate-fadeIn">
      {/* 标题区 */}
      <div className="border-b border-[var(--color-outline)]/15 pb-3 mb-4 shrink-0">
        <h3 className="text-base font-bold text-[var(--color-on-surface)]" style={{ textWrap: 'balance' }}>网络与代理配置</h3>
        <p className="text-xs text-on-surface/45 mt-1 leading-relaxed">
          配置应用程序的网络代理设置。修改后需点击「应用配置」生效。
          {mode === 'pac' && (
            <span className="text-amber-500/80 ml-1">⚠️ PAC 模式仅对渲染进程（UI 内请求）生效，Node.js 后端请求将直连。</span>
          )}
        </p>
      </div>

      {/* 左右分栏：左侧模式列表 + 右侧详情 */}
      <div className="flex-1 flex gap-4 min-h-0">

        {/* ── 左侧：四个模式列表 ── */}
        <div className="w-[200px] shrink-0 flex flex-col gap-2">
          {MODE_OPTIONS.map((opt, idx) => {
            const isActive = mode === opt.id;
            return (
              <button
                key={opt.id}
                onClick={() => setMode(opt.id)}
                className={`group relative flex items-start gap-2.5 px-3 py-3 rounded-xl border text-left transition-[border-color,background-color] duration-150 cursor-pointer ${
                  isActive
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8 text-[var(--color-on-surface)] shadow-[0_2px_8px_rgba(0,0,0,0.06)]'
                    : 'border-[var(--color-outline)]/15 text-on-surface/60 hover:border-[var(--color-outline)]/30 hover:bg-[var(--color-surface)]'
                }`}
                style={{
                  animationDelay: `${idx * 60}ms`,
                }}
              >
                {isActive && (
                  <div className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-[var(--color-primary)]" />
                )}
                {/* 图标 */}
                {(() => { const Icon = opt.icon; return <Icon className={`shrink-0 mt-0.5 transition-colors ${isActive ? 'text-[var(--color-primary)]' : 'text-on-surface/40 group-hover:text-on-surface/60'}`} style={{ width: 18, height: 18 }} />; })()}
                {/* 文本 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13px] font-semibold leading-tight">{opt.label}</span>
                    {opt.defaultMode && (
                      <span className="text-[9px] px-1 py-px rounded bg-[var(--color-primary)]/12 text-[var(--color-primary)] font-medium leading-none">
                        默认
                      </span>
                    )}
                  </div>
                  <span className="text-[10.5px] mt-1 block opacity-50 leading-snug line-clamp-2">{opt.desc}</span>
                </div>
              </button>
            );
          })}
        </div>

        {/* ── 右侧：模式详情 + 操作栏 ── */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">

          {/* 详情内容区（滚动） */}
          <div className="flex-1 overflow-y-auto pr-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">

            {/* 系统代理模式详情 */}
            {mode === 'system' && (
              <div
                key="system"
                className="p-4 bg-[var(--color-surface)] border border-[var(--color-outline)]/12 rounded-xl space-y-2 animate-fadeIn"
              >
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

            {/* 直连模式提示 */}
            {mode === 'direct' && (
              <div
                key="direct"
                className="p-4 bg-[var(--color-surface)] border border-[var(--color-outline)]/12 rounded-xl space-y-2 animate-fadeIn"
              >
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-blue-500/70" />
                  <span className="text-sm font-medium text-[var(--color-on-surface)]">直连模式</span>
                </div>
                <p className="text-xs text-on-surface/50 pl-4 leading-relaxed">
                  所有网络请求将直接连接，不经过任何代理服务器。适用于已有全局 VPN 或加速器的场景。
                </p>
              </div>
            )}

            {/* 手动代理模式详情 */}
            {mode === 'manual' && (
              <div
                key="manual"
                className="p-4 bg-[var(--color-surface)] border border-[var(--color-outline)]/12 rounded-xl space-y-4 animate-fadeIn"
              >
                {/* 协议选择 */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-[var(--color-primary)]/80 uppercase tracking-wider">协议类型</label>
                  <div className="flex gap-2">
                    {PROTOCOL_OPTIONS.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => setProtocol(p.id)}
                        className={`px-3 py-1.5 text-xs rounded-lg border transition-[border-color,background-color,color] cursor-pointer ${
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
                      className="text-[11px] text-[var(--color-primary)]/70 hover:text-[var(--color-primary)] transition-colors cursor-pointer"
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
              <div
                key="pac"
                className="p-4 bg-[var(--color-surface)] border border-[var(--color-outline)]/12 rounded-xl space-y-3 animate-fadeIn"
              >
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

          </div>

          {/* 操作栏：应用 + 测试（固定在右侧底部） */}
          <div className="flex items-center gap-3 pt-3 mt-3 border-t border-[var(--color-outline)]/10 shrink-0">
            <button
              onClick={handleApply}
              disabled={saving}
              className={`px-5 py-2.5 rounded-lg text-sm font-semibold transition-[background-color,opacity] cursor-pointer active:scale-[0.98] ${
                saving
                  ? 'bg-gray-300 text-gray-500 cursor-wait'
                  : saveStatus === 'ok'
                    ? 'bg-green-500/15 text-green-700 border border-green-500/25'
                    : saveStatus === 'error'
                      ? 'bg-red-500/15 text-red-700 border border-red-500/25'
                      : 'bg-[var(--color-primary)] text-white hover:brightness-110'
              }`}
            >
              {saving ? '保存中...' : saveStatus === 'ok' ? '✓ 已应用' : saveStatus === 'error' ? '✗ 失败' : '应用配置'}
            </button>

            <button
              onClick={handleTest}
              disabled={testing}
              className="px-4 py-2.5 rounded-lg text-sm font-medium border border-[var(--color-outline)]/20 text-on-surface/70 hover:bg-[var(--color-surface)] transition-[background-color,opacity] cursor-pointer active:scale-[0.98] disabled:opacity-50"
            >
              {testing ? '测试中...' : '测试连接'}
            </button>

            {/* 测试结果展示 */}
            {testResult && (
              <span className={`text-xs font-mono tabular-nums ${testResult.ok ? 'text-green-600' : 'text-red-500'}`}>
                {testResult.ok
                  ? `出口 IP: ${testResult.ip} · 延迟: ${testResult.latency}ms`
                  : `失败: ${testResult.error}`
                }
              </span>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
