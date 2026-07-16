import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, ChevronDown, RefreshCw, Cpu, Play, Square, Send,
  AlertCircle, CheckCircle2, Loader2, Globe, Copy,
} from '../utils/icons';
import { useAppStore } from '../state/appStore';

// ── 类型定义 ──────────────────────────────────────────────────────

interface ModelEntry {
  path: string;
  name: string;
  addedAt: string;
  sizeMb?: number;
}

interface ModelStatus {
  loaded: boolean;
  model_path?: string;
  model_name?: string;
  file_size_mb?: number;
  params?: {
    n_ctx: number;
    n_threads: number;
    n_gpu_layers: number;
  };
}

interface DeviceInfo {
  cpu_cores: number;
  ram_gb: number;
  gpu: string | null;
  cuda_supported?: boolean;
  suggested?: {
    n_ctx: number;
    n_threads: number;
    n_gpu_layers: number;
  };
}

interface Metrics {
  tokens_per_second: number;
  time_to_first_token_ms: number;
  total_tokens: number;
  total_time_ms: number;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface HttpServerInfo {
  running: boolean;
  host: string;
  port: number;
  lanIP: string;
  url: string | null;
  localUrl: string | null;
  requestCount: number;
  modelLoaded: boolean;
  modelName: string | null;
}

// ── 组件 ──────────────────────────────────────────────────────────

export default function LocalLLMPage() {
  const setShowLocalLLMPage = useAppStore((s) => s.setShowLocalLLMPage);

  // 模型列表（只读引用）
  const [models, setModels] = useState<ModelEntry[]>([]);

  // 选中 & 状态
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [serverRunning, setServerRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // 系统参数
  const [nCtx, setNCtx] = useState(4096);
  const [nThreads, setNThreads] = useState(4);
  const [nGpuLayers, setNGpuLayers] = useState(0);

  // 推理参数
  const [temperature, setTemperature] = useState(0.3);
  const [topP, setTopP] = useState(1.0);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [repeatPenalty, setRepeatPenalty] = useState(1.1);

  // 聊天
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatStreaming, setChatStreaming] = useState(false);
  const chatStreamRef = useRef<{ abort: () => Promise<any> } | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // 确认对话框
  const [confirmSwitch, setConfirmSwitch] = useState<string | null>(null);

  // 局域网共享
  const [httpRunning, setHttpRunning] = useState(false);
  const [httpPort, setHttpPort] = useState(8768);
  const [httpInfo, setHttpInfo] = useState<HttpServerInfo | null>(null);
  const httpPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [copied, setCopied] = useState(false);

  // ── 初始化 ──────────────────────────────────────────────────

  const initialize = useCallback(async () => {
    try {
      const { running } = await window.soloforge.localLLM.serverRunning();
      setServerRunning(running);

      if (running) {
        const [listRes, statusRes, deviceRes] = await Promise.all([
          window.soloforge.localLLM.list(),
          window.soloforge.localLLM.status(),
          window.soloforge.localLLM.device(),
        ]);
        setModels(listRes.models || []);
        setStatus(statusRes);
        setDeviceInfo(deviceRes);

        if (statusRes.loaded && statusRes.model_path) {
          setSelectedPath(statusRes.model_path);
          if (statusRes.params) {
            setNCtx(statusRes.params.n_ctx);
            setNThreads(statusRes.params.n_threads);
            setNGpuLayers(statusRes.params.n_gpu_layers);
          }
        }

        // 检查 HTTP 服务器状态
        const httpInfo = await window.soloforge.localLLM.getHttpServerInfo();
        setHttpInfo(httpInfo);
        setHttpRunning(httpInfo.running);
        if (httpInfo.running) {
          setHttpPort(httpInfo.port);
          _startHttpPolling();
        }
      } else {
        // 服务未运行时也加载模型列表（只读参考）
        const listRes = await window.soloforge.localLLM.list();
        setModels(listRes.models || []);
      }
    } catch (e) {
      console.error('[LocalLLMPage] init failed:', e);
    }
  }, []);

  useEffect(() => {
    initialize();
  }, [initialize]);

  // 自动滚动聊天到底部
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages]);

  // ── 服务管理 ────────────────────────────────────────────────

  const handleStartServer = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await window.soloforge.localLLM.startServer();
      if (res.ok) {
        setServerRunning(true);
        const [deviceRes] = await Promise.all([
          window.soloforge.localLLM.device(),
        ]);
        setDeviceInfo(deviceRes);
        setInfo('推理服务已启动');
      } else {
        setError(res.error || '启动失败');
      }
    } catch (e: any) {
      setError(e.message || '启动失败');
    }
    setLoading(false);
  };

  const handleStopServer = async () => {
    chatStreamRef.current?.abort();
    chatStreamRef.current = null;
    await window.soloforge.localLLM.stopServer();
    setServerRunning(false);
    setStatus(null);
    setSelectedPath('');
    setChatMessages([]);
    setMetrics(null);
    setChatStreaming(false);
    setInfo('推理服务已停止');
  };

  // ── 模型选择 & 加载 ──────────────────────────────────────────

  const refreshStatus = async () => {
    const res = await window.soloforge.localLLM.status();
    setStatus(res);
  };

  const handleSelectModel = async (modelPath: string) => {
    if (!modelPath) {
      setSelectedPath('');
      return;
    }

    if (status?.loaded && status.model_path !== modelPath) {
      setConfirmSwitch(modelPath);
      return;
    }

    setSelectedPath(modelPath);

    if (deviceInfo?.suggested) {
      setNCtx(deviceInfo.suggested.n_ctx);
      setNThreads(deviceInfo.suggested.n_threads);
      setNGpuLayers(deviceInfo.suggested.n_gpu_layers);
    }

    if (!status?.loaded) {
      await doLoadModel(modelPath);
    }
  };

  const confirmSwitchModel = async () => {
    if (!confirmSwitch) return;
    const targetPath = confirmSwitch;
    setConfirmSwitch(null);
    setSelectedPath(targetPath);

    if (deviceInfo?.suggested) {
      setNCtx(deviceInfo.suggested.n_ctx);
      setNThreads(deviceInfo.suggested.n_threads);
      setNGpuLayers(deviceInfo.suggested.n_gpu_layers);
    }

    await doLoadModel(targetPath);
  };

  const doLoadModel = async (modelPath: string) => {
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      const res = await window.soloforge.localLLM.load(modelPath, {
        n_ctx: nCtx,
        n_threads: nThreads,
        n_gpu_layers: nGpuLayers,
      });
      if (res.ok) {
        await refreshStatus();
        setInfo(`模型 ${res.model_name} 加载成功`);
      } else {
        setError(res.error || '加载失败');
      }
    } catch (e: any) {
      setError(e.message || '加载失败');
    }
    setLoading(false);
  };

  const handleUnload = async () => {
    chatStreamRef.current?.abort();
    chatStreamRef.current = null;
    setLoading(true);
    await window.soloforge.localLLM.unload();
    await refreshStatus();
    setSelectedPath('');
    setChatMessages([]);
    setMetrics(null);
    setChatStreaming(false);
    // 后端 unloadModel 会自动停止 HTTP 服务器，同步 UI 状态
    setHttpRunning(false);
    setHttpInfo(null);
    _stopHttpPolling();
    setLoading(false);
    setInfo('模型已卸载');
  };

  const handleReload = async () => {
    if (!selectedPath) return;
    await doLoadModel(selectedPath);
  };

  // ── 局域网共享 ────────────────────────────────────────────

  const _startHttpPolling = useCallback(() => {
    if (httpPollRef.current) clearInterval(httpPollRef.current);
    httpPollRef.current = setInterval(async () => {
      try {
        const info = await window.soloforge.localLLM.getHttpServerInfo();
        setHttpInfo(info);
      } catch {}
    }, 2000);
  }, []);

  const _stopHttpPolling = useCallback(() => {
    if (httpPollRef.current) {
      clearInterval(httpPollRef.current);
      httpPollRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => _stopHttpPolling();
  }, [_stopHttpPolling]);

  const handleStartHttpServer = async () => {
    setError(null);
    setInfo(null);
    try {
      const res = await window.soloforge.localLLM.startHttpServer('0.0.0.0', httpPort);
      if (res.ok) {
        setHttpRunning(true);
        const info = await window.soloforge.localLLM.getHttpServerInfo();
        setHttpInfo(info);
        _startHttpPolling();
        setInfo(`局域网共享已启动: http://${res.lanIP}:${res.port}`);
      } else {
        setError(res.error || '启动失败');
      }
    } catch (e: any) {
      setError(e.message || '启动失败');
    }
  };

  const handleStopHttpServer = async () => {
    await window.soloforge.localLLM.stopHttpServer();
    setHttpRunning(false);
    setHttpInfo(null);
    _stopHttpPolling();
    setInfo('局域网共享已停止');
  };

  const handleCopyUrl = async () => {
    if (!httpInfo?.url) return;
    try {
      await navigator.clipboard.writeText(httpInfo.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  // ── 聊天测试 ────────────────────────────────────────────────

  const sendChat = () => {
    if (!chatInput.trim() || chatStreaming) return;
    if (!status?.loaded) {
      setError('请先加载模型');
      return;
    }

    const userText = chatInput.trim();
    const userMsg: ChatMessage = { role: 'user', content: userText };
    setChatMessages((prev) => [...prev, userMsg]);
    setChatInput('');
    setChatStreaming(true);
    setError(null);

    let assistantContent = '';
    setChatMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

    const stream = window.soloforge.localLLM.chat(userText, {
      temperature,
      top_p: topP,
      max_tokens: maxTokens,
      repeat_penalty: repeatPenalty,
    });
    chatStreamRef.current = stream;

    let unsubToken: (() => void) | null = null;
    let unsubDone: (() => void) | null = null;
    let unsubError: (() => void) | null = null;

    unsubToken = stream.onToken((token) => {
      assistantContent += token;
      setChatMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: 'assistant',
          content: assistantContent,
        };
        return updated;
      });
    });

    unsubDone = stream.onDone(() => {
      setChatStreaming(false);
      chatStreamRef.current = null;
      unsubToken?.();
      unsubDone?.();
      unsubError?.();
      window.soloforge.localLLM.metrics().then(setMetrics).catch(() => {});
    });

    unsubError = stream.onError((err) => {
      setError(err || '推理失败');
      setChatStreaming(false);
      chatStreamRef.current = null;
      unsubToken?.();
      unsubDone?.();
      unsubError?.();
    });

    stream.start().catch((e: any) => {
      setError(e?.message || '启动推理失败');
      setChatStreaming(false);
      chatStreamRef.current = null;
      unsubToken?.();
      unsubDone?.();
      unsubError?.();
    });
  };

  const stopChat = () => {
    chatStreamRef.current?.abort();
  };

  const clearChat = () => {
    setChatMessages([]);
    setMetrics(null);
    window.soloforge.localLLM.chatReset();
  };

  // ── 渲染 ────────────────────────────────────────────────────

  const loaded = status?.loaded ?? false;

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center p-4 font-sans overflow-hidden animate-fadeIn"
      style={{
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        backgroundColor: 'rgba(0, 0, 0, 0.45)',
      }}
    >
      {/* 背景层：点击关闭 */}
      <div
        onClick={() => setShowLocalLLMPage(false)}
        className="absolute inset-0 z-0"
        style={{ cursor: 'default' }}
      />

      {/* 主卡片 */}
      <div
        className="relative z-10 bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-2xl w-full max-w-4xl shadow-[0_12px_45px_rgba(0,0,0,0.4)] overflow-hidden flex flex-col text-[var(--color-on-surface)] select-none"
        style={{ height: '88vh', flexShrink: 0 }}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 px-6 border-b border-[var(--color-outline)]/20 bg-[var(--color-bg)] shrink-0">
          <div className="flex items-center gap-3">
            <Cpu className="text-[var(--color-primary)] w-5 h-5" />
            <div>
              <h2 className="text-lg font-bold text-[var(--color-on-surface)] tracking-wide">本地推理服务</h2>
              <p className="text-xs text-on-surface/50 mt-0.5">启动 llama.cpp 引擎，加载 GGUF 模型进行本地推理</p>
            </div>
          </div>
          {/* 服务状态指示器 */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-lg">
              <span className={`w-2 h-2 rounded-full ${serverRunning ? 'bg-emerald-400' : 'bg-amber-400'}`} />
              <span className="text-xs text-on-surface/60 font-mono tabular-nums">
                {serverRunning ? '服务运行中' : '服务未启动'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowLocalLLMPage(false)}
              onMouseDown={(e) => e.stopPropagation()}
              className="select-text p-1.5 hover:bg-[var(--color-surface-bright)]/40 rounded-lg transition-colors text-on-surface/50 hover:text-[var(--color-on-surface)]"
              style={{ cursor: 'pointer' }}
              aria-label="关闭"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {/* 错误 / 信息提示 */}
          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
              <span className="text-xs text-red-400 flex-1">{error}</span>
              <button onClick={() => setError(null)} className="text-red-400/50 hover:text-red-400">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          {info && !error && (
            <div className="flex items-center gap-2 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span className="text-xs text-emerald-400 flex-1">{info}</span>
              <button onClick={() => setInfo(null)} className="text-emerald-400/50 hover:text-emerald-400">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* 服务未运行 */}
          {!serverRunning ? (
            <div className="p-10 bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-xl text-center">
              <Cpu className="w-10 h-10 text-[var(--color-primary)]/50 mx-auto mb-4" />
              <p className="text-sm text-[var(--color-on-surface)] mb-1">推理服务未启动</p>
              <p className="text-xs text-on-surface/40 mb-5">启动后将可以加载和管理本地 GGUF 模型</p>
              <button
                onClick={handleStartServer}
                disabled={loading}
                className="bg-[var(--color-primary)] hover:opacity-90 active:scale-[0.96] disabled:opacity-50 text-[var(--color-bg)] px-6 py-2.5 rounded-lg text-sm font-bold flex items-center gap-2 transition-all cursor-pointer mx-auto"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                <span>启动推理服务</span>
              </button>
              {models.length > 0 && (
                <p className="text-xs text-on-surface/30 mt-4">
                  已有 {models.length} 个模型可用
                </p>
              )}
            </div>
          ) : (
            <>
              {/* ── 模型选择 ── */}
              <div className="flex items-center gap-3">
                <div className="flex-1 relative">
                  <select
                    value={selectedPath}
                    onChange={(e) => handleSelectModel(e.target.value)}
                    className="w-full appearance-none bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-lg px-3 py-2.5 text-sm text-[var(--color-on-surface)] cursor-pointer hover:border-[var(--color-primary)]/30 transition-all focus:outline-none focus:border-[var(--color-primary)]/50"
                  >
                    <option value="">— 选择模型 —</option>
                    {models.map((m) => (
                      <option key={m.path} value={m.path}>
                        {m.name}{m.sizeMb ? ` (${m.sizeMb} MB)` : ''}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-4 h-4 text-on-surface/40 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
                <div className="flex items-center gap-2 px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-lg">
                  <span className={`w-2 h-2 rounded-full ${loaded ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                  <span className="text-xs text-on-surface/60 font-mono tabular-nums">
                    {loaded ? '已加载' : '未加载'}
                  </span>
                  <button
                    onClick={handleStopServer}
                    className="text-on-surface/40 hover:text-red-400 transition-colors ml-1"
                    title="停止服务"
                  >
                    <Square className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* 加载中 */}
              {loading && (
                <div className="flex items-center gap-2 p-3 bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded-lg">
                  <Loader2 className="w-4 h-4 text-[var(--color-primary)] animate-spin" />
                  <span className="text-xs text-on-surface/60">正在加载模型...</span>
                </div>
              )}

              {/* ── 系统参数 ── */}
              <div className="p-4 bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded-xl space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[var(--color-primary)] font-mono font-semibold">系统参数</span>
                  {loaded && selectedPath === status?.model_path && (
                    <button
                      onClick={handleReload}
                      disabled={loading}
                      className="text-xs text-[var(--color-primary)]/70 hover:text-[var(--color-primary)] flex items-center gap-1 transition-colors"
                    >
                      <RefreshCw className="w-3 h-3" />
                      重新加载
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <ParamInput
                    label="上下文长度"
                    value={nCtx}
                    onChange={setNCtx}
                    step={1024}
                    min={512}
                  />
                  <ParamInput
                    label="线程数"
                    value={nThreads}
                    onChange={setNThreads}
                    step={1}
                    min={1}
                  />
                  <ParamInput
                    label="GPU 层数"
                    value={nGpuLayers}
                    onChange={setNGpuLayers}
                    step={1}
                    min={0}
                    hint={nGpuLayers === -1 ? '全部' : nGpuLayers === 0 ? '纯 CPU' : undefined}
                  />
                </div>
                {deviceInfo && (
                  <p className="text-xs text-on-surface/30">
                    设备: {deviceInfo.cpu_cores} 核 CPU / {deviceInfo.ram_gb}GB RAM
                    {deviceInfo.gpu ? ` / ${deviceInfo.gpu}` : ' / 无 GPU'}
                  </p>
                )}
              </div>

              {/* ── 推理参数 ── */}
              <div className="p-4 bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded-xl space-y-3">
                <span className="text-xs text-[var(--color-primary)] font-mono font-semibold block">推理参数</span>
                <div className="grid grid-cols-2 gap-3">
                  <ParamInput
                    label="Temperature"
                    value={temperature}
                    onChange={setTemperature}
                    step={0.05}
                    min={0}
                    type="float"
                  />
                  <ParamInput
                    label="Top P"
                    value={topP}
                    onChange={setTopP}
                    step={0.05}
                    min={0}
                    type="float"
                  />
                  <ParamInput
                    label="Max Tokens"
                    value={maxTokens}
                    onChange={setMaxTokens}
                    step={64}
                    min={1}
                  />
                  <ParamInput
                    label="Repeat Penalty"
                    value={repeatPenalty}
                    onChange={setRepeatPenalty}
                    step={0.05}
                    min={0.1}
                    type="float"
                  />
                </div>
              </div>

              {/* ── 卸载按钮 ── */}
              {loaded && (
                <button
                  onClick={handleUnload}
                  disabled={loading}
                  className="text-xs text-red-400/70 hover:text-red-400 border border-red-500/20 hover:border-red-500/30 active:scale-[0.96] px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5"
                >
                  <Square className="w-3 h-3" />
                  卸载模型
                </button>
              )}

              {/* ── 局域网共享 ── */}
              {loaded && (
                <div className="p-4 bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded-xl space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-[var(--color-primary)] font-mono font-semibold flex items-center gap-1.5">
                      <Globe className="w-3.5 h-3.5" />
                      局域网共享
                    </span>
                    {httpRunning && (
                      <span className="text-xs text-on-surface/40 font-mono tabular-nums">
                        请求: {httpInfo?.requestCount ?? 0}
                      </span>
                    )}
                  </div>

                  {!httpRunning ? (
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-on-surface/50">端口</label>
                        <input
                          type="number"
                          value={httpPort}
                          onChange={(e) => setHttpPort(parseInt(e.target.value) || 8768)}
                          min={1024}
                          max={65535}
                          className="w-20 bg-[var(--color-bg)]/50 border border-[var(--color-outline)]/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--color-on-surface)] font-mono tabular-nums focus:outline-none focus:border-[var(--color-primary)]/30 transition-all"
                        />
                      </div>
                      <button
                        onClick={handleStartHttpServer}
                        className="bg-[var(--color-primary)] hover:opacity-90 active:scale-[0.96] text-[var(--color-bg)] px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer"
                      >
                        <Globe className="w-3.5 h-3.5" />
                        启动共享
                      </button>
                      <p className="text-xs text-on-surface/30">
                        启动后局域网内其他设备可通过 OpenAI 兼容 API 连接
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {/* 局域网地址 */}
                      {httpInfo?.url && (
                        <div className="flex items-center gap-2 p-2.5 bg-[var(--color-bg)]/50 border border-[var(--color-outline)]/15 rounded-lg">
                          <span className="text-xs text-on-surface/40 font-mono shrink-0">局域网</span>
                          <code className="flex-1 text-xs text-[var(--color-primary)] font-mono truncate">
                            {httpInfo.url}
                          </code>
                          <button
                            onClick={handleCopyUrl}
                            className="text-on-surface/40 hover:text-[var(--color-primary)] transition-colors shrink-0"
                            title="复制地址"
                          >
                            {copied
                              ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                              : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      )}
                      {/* 本机地址 */}
                      {httpInfo?.localUrl && (
                        <div className="flex items-center gap-2 p-2.5 bg-[var(--color-bg)]/50 border border-[var(--color-outline)]/15 rounded-lg">
                          <span className="text-xs text-on-surface/40 font-mono shrink-0">本机  </span>
                          <code className="flex-1 text-xs text-on-surface/60 font-mono truncate">
                            {httpInfo.localUrl}
                          </code>
                        </div>
                      )}
                      {/* 说明 */}
                      <p className="text-xs text-on-surface/30 leading-relaxed">
                        其他设备可将此地址设为 OpenAI base_url，兼容 <code className="text-on-surface/50">/v1/chat/completions</code> 和 <code className="text-on-surface/50">/v1/models</code>
                      </p>
                      {/* 停止按钮 */}
                      <button
                        onClick={handleStopHttpServer}
                        className="text-xs text-red-400/70 hover:text-red-400 border border-red-500/20 hover:border-red-500/30 active:scale-[0.96] px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5"
                      >
                        <Square className="w-3 h-3" />
                        停止共享
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* ── 聊天测试 ── */}
              {loaded && (
                <div className="border border-[var(--color-outline)]/15 rounded-xl overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2 bg-[var(--color-surface)] border-b border-[var(--color-outline)]/10">
                    <span className="text-xs text-[var(--color-primary)] font-mono font-semibold">调试对话（不保存）</span>
                    <div className="flex items-center gap-3">
                      {metrics && (
                        <span className="text-xs text-on-surface/40 font-mono tabular-nums">
                          {metrics.tokens_per_second} tok/s · {metrics.time_to_first_token_ms}ms
                        </span>
                      )}
                      {chatMessages.length > 0 && (
                        <button
                          onClick={clearChat}
                          className="text-xs text-on-surface/40 hover:text-red-400 transition-colors"
                        >
                          清空
                        </button>
                      )}
                    </div>
                  </div>

                  <div
                    ref={chatScrollRef}
                    className="h-64 overflow-y-auto p-3 space-y-2 bg-[var(--color-bg)]/50"
                  >
                    {chatMessages.length === 0 ? (
                      <p className="text-xs text-on-surface/30 text-center py-8">
                        输入消息测试模型推理效果
                      </p>
                    ) : (
                      chatMessages.map((msg, idx) => (
                        <div
                          key={idx}
                          className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                        >
                          <div
                            className={`max-w-[80%] px-3 py-2 rounded-lg text-xs whitespace-pre-wrap break-words ${
                              msg.role === 'user'
                                ? 'bg-[var(--color-primary)]/15 text-[var(--color-on-surface)]'
                                : 'bg-[var(--color-surface)] border border-[var(--color-outline)]/10 text-[var(--color-on-surface)]'
                            }`}
                          >
                            {msg.content || (msg.role === 'assistant' && chatStreaming ? '...' : '')}
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="flex items-center gap-2 p-2 border-t border-[var(--color-outline)]/10">
                    <input
                      type="text"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
                      placeholder="输入消息..."
                      disabled={chatStreaming}
                      className="flex-1 bg-transparent text-xs text-[var(--color-on-surface)] px-2 py-1.5 focus:outline-none placeholder:text-on-surface/30"
                    />
                    {chatStreaming ? (
                      <button
                        onClick={stopChat}
                        className="bg-red-500/20 hover:bg-red-500/30 active:scale-[0.96] text-red-400 px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 transition-all cursor-pointer"
                      >
                        <Square className="w-3 h-3" />
                        停止
                      </button>
                    ) : (
                      <button
                        onClick={sendChat}
                        disabled={!chatInput.trim()}
                        className="bg-[var(--color-primary)] hover:opacity-90 active:scale-[0.96] disabled:opacity-30 text-[var(--color-bg)] px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 transition-all cursor-pointer"
                      >
                        <Send className="w-3 h-3" />
                        发送
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* 确认切换模型对话框 */}
        {confirmSwitch && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                  <AlertCircle className="w-5 h-5 text-amber-400" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-[var(--color-on-surface)]">切换模型</h4>
                  <p className="text-xs text-on-surface/50">当前已有模型加载中</p>
                </div>
              </div>
              <p className="text-xs text-on-surface/60 mb-4">
                卸载当前模型并加载新模型？切换期间将无法进行推理。
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setConfirmSwitch(null)}
                  className="text-xs text-on-surface/60 hover:text-[var(--color-on-surface)] px-4 py-2 rounded-lg transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={confirmSwitchModel}
                  className="text-xs bg-[var(--color-primary)] hover:opacity-90 active:scale-[0.96] text-[var(--color-bg)] px-4 py-2 rounded-lg font-bold transition-all"
                >
                  确认切换
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 参数输入子组件 ────────────────────────────────────────────────

interface ParamInputProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  type?: 'int' | 'float';
  hint?: string;
}

function ParamInput({ label, value, onChange, step = 1, min, type = 'int', hint }: ParamInputProps) {
  return (
    <div>
      <label className="text-xs text-on-surface/50 block mb-1">{label}</label>
      <div className="relative">
        <input
          type="number"
          value={value}
          step={step}
          min={min}
          onChange={(e) => {
            const v = type === 'float' ? parseFloat(e.target.value) : parseInt(e.target.value);
            if (!isNaN(v)) onChange(v);
          }}
          className="w-full bg-[var(--color-bg)]/50 border border-[var(--color-outline)]/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--color-on-surface)] font-mono tabular-nums focus:outline-none focus:border-[var(--color-primary)]/30 transition-all"
        />
        {hint && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-on-surface/20 pointer-events-none">
            {hint}
          </span>
        )}
      </div>
    </div>
  );
}
