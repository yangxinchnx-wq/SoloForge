import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ChevronDown, RefreshCw, Plus, Trash2, FolderOpen,
  Cpu, Play, Square, Send, AlertCircle, CheckCircle2,
  X, Loader2,
} from '../../utils/icons';

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

// ── window.soloforge.localLLM 类型声明 ────────────────────────────

declare global {
  interface Window {
    soloforge: {
      localLLM: {
        list: () => Promise<{ ok: boolean; models: ModelEntry[] }>;
        add: (path: string) => Promise<{ ok: boolean; error?: string; model?: ModelEntry }>;
        remove: (path: string) => Promise<{ ok: boolean }>;
        delete: (path: string) => Promise<{ ok: boolean; error?: string }>;
        browse: () => Promise<{ ok: boolean; canceled?: boolean; path?: string }>;
        load: (path: string, params: { n_ctx: number; n_threads: number; n_gpu_layers: number }) => Promise<{ ok: boolean; error?: string; model_name?: string }>;
        unload: () => Promise<{ ok: boolean }>;
        status: () => Promise<ModelStatus>;
        device: () => Promise<DeviceInfo>;
        metrics: () => Promise<Metrics>;
        startServer: () => Promise<{ ok: boolean; error?: string; port?: number }>;
        stopServer: () => Promise<{ ok: boolean }>;
        serverRunning: () => Promise<{ running: boolean }>;
        serverUrl: () => Promise<{ url: string }>;
      };
    };
  }
}

// ── 组件 ──────────────────────────────────────────────────────────

export default function LocalModelTab() {
  // 模型列表
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [newModelPath, setNewModelPath] = useState('');

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
  const chatAbortRef = useRef<AbortController | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // 确认对话框
  const [confirmSwitch, setConfirmSwitch] = useState<string | null>(null);

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

        // 如果有模型已加载，选中它
        if (statusRes.loaded && statusRes.model_path) {
          setSelectedPath(statusRes.model_path);
          if (statusRes.params) {
            setNCtx(statusRes.params.n_ctx);
            setNThreads(statusRes.params.n_threads);
            setNGpuLayers(statusRes.params.n_gpu_layers);
          }
        }
      }
    } catch (e) {
      console.error('[LocalModelTab] init failed:', e);
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
    await window.soloforge.localLLM.stopServer();
    setServerRunning(false);
    setStatus(null);
    setSelectedPath('');
    setChatMessages([]);
    setMetrics(null);
    setInfo('推理服务已停止');
  };

  // ── 模型选择 & 加载 ──────────────────────────────────────────

  const refreshModels = async () => {
    const res = await window.soloforge.localLLM.list();
    setModels(res.models || []);
  };

  const refreshStatus = async () => {
    const res = await window.soloforge.localLLM.status();
    setStatus(res);
  };

  const handleSelectModel = async (modelPath: string) => {
    if (!modelPath) {
      setSelectedPath('');
      return;
    }

    // 如果有模型已加载且不是同一个，弹出确认
    if (status?.loaded && status.model_path !== modelPath) {
      setConfirmSwitch(modelPath);
      return;
    }

    setSelectedPath(modelPath);

    // 自动调整参数
    if (deviceInfo?.suggested) {
      setNCtx(deviceInfo.suggested.n_ctx);
      setNThreads(deviceInfo.suggested.n_threads);
      setNGpuLayers(deviceInfo.suggested.n_gpu_layers);
    }

    // 如果没有模型加载，自动加载选中的
    if (!status?.loaded) {
      await doLoadModel(modelPath);
    }
  };

  const confirmSwitchModel = async () => {
    if (!confirmSwitch) return;
    const targetPath = confirmSwitch;
    setConfirmSwitch(null);
    setSelectedPath(targetPath);

    // 自动调整参数
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
    setLoading(true);
    await window.soloforge.localLLM.unload();
    await refreshStatus();
    setSelectedPath('');
    setChatMessages([]);
    setMetrics(null);
    setLoading(false);
    setInfo('模型已卸载');
  };

  // 重新加载（参数变更后）
  const handleReload = async () => {
    if (!selectedPath) return;
    await doLoadModel(selectedPath);
  };

  // ── 模型列表 CRUD ───────────────────────────────────────────

  const handleBrowse = async () => {
    const res = await window.soloforge.localLLM.browse();
    if (res.ok && res.path) {
      setNewModelPath(res.path);
    }
  };

  const handleAddModel = async () => {
    if (!newModelPath.trim()) return;
    setError(null);
    const res = await window.soloforge.localLLM.add(newModelPath.trim());
    if (res.ok) {
      setNewModelPath('');
      await refreshModels();
      setInfo('模型已添加');
    } else {
      setError(res.error || '添加失败');
    }
  };

  const handleRemoveModel = async (modelPath: string) => {
    await window.soloforge.localLLM.remove(modelPath);
    if (selectedPath === modelPath) {
      setSelectedPath('');
    }
    await refreshModels();
    setInfo('模型已从列表移除');
  };

  const handleDeleteModel = async (modelPath: string) => {
    const modelName = models.find((m) => m.path === modelPath)?.name || modelPath;
    if (!confirm(`确定要删除 "${modelName}" 吗？\n\n这将从列表移除并从磁盘删除文件，不可恢复。`)) return;

    const res = await window.soloforge.localLLM.delete(modelPath);
    if (res.ok) {
      if (selectedPath === modelPath) {
        setSelectedPath('');
      }
      await refreshModels();
      setInfo('模型已删除');
    } else {
      setError(res.error || '删除失败');
    }
  };

  // ── 聊天测试 ────────────────────────────────────────────────

  const sendChat = async () => {
    if (!chatInput.trim() || chatStreaming) return;
    if (!status?.loaded) {
      setError('请先加载模型');
      return;
    }

    const userMsg: ChatMessage = { role: 'user', content: chatInput.trim() };
    setChatMessages((prev) => [...prev, userMsg]);
    setChatInput('');
    setChatStreaming(true);
    setError(null);

    // 添加空的 assistant 消息，逐步填充
    setChatMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

    try {
      const { url } = await window.soloforge.localLLM.serverUrl();
      const allMessages = [...chatMessages, userMsg].map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const controller = new AbortController();
      chatAbortRef.current = controller;

      const response = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: allMessages,
          temperature,
          top_p: topP,
          max_tokens: maxTokens,
          repeat_penalty: repeatPenalty,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let assistantContent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const chunk = JSON.parse(data);
              const delta = chunk.choices?.[0]?.delta?.content;
              if (delta) {
                assistantContent += delta;
                setChatMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: 'assistant',
                    content: assistantContent,
                  };
                  return updated;
                });
              }
            } catch {
              // skip parse errors
            }
          }
        }
      }

      // 获取性能指标
      const m = await window.soloforge.localLLM.metrics();
      setMetrics(m);
    } catch (e: any) {
      if (e.name === 'AbortError') {
        setInfo('已停止生成');
      } else {
        setError(e.message || '推理失败');
      }
    } finally {
      setChatStreaming(false);
      chatAbortRef.current = null;
    }
  };

  const stopChat = () => {
    chatAbortRef.current?.abort();
  };

  const clearChat = () => {
    setChatMessages([]);
    setMetrics(null);
  };

  // ── 渲染 ────────────────────────────────────────────────────

  const loaded = status?.loaded ?? false;

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* 标题 */}
      <div className="border-b border-[var(--color-outline)]/20 pb-3 mb-2">
        <h3 className="text-base font-bold text-[var(--color-on-surface)]">本地模型管理</h3>
        <p className="text-xs text-on-surface/50 mt-1">
          手动添加 GGUF 模型，本地推理，无需外部 API
        </p>
      </div>

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
        <div className="p-6 bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-xl text-center">
          <Cpu className="w-8 h-8 text-[var(--color-primary)]/50 mx-auto mb-3" />
          <p className="text-sm text-[var(--color-on-surface)] mb-1">推理服务未启动</p>
          <p className="text-xs text-on-surface/40 mb-4">启动后将可以加载和管理本地 GGUF 模型</p>
          <button
            onClick={handleStartServer}
            disabled={loading}
            className="bg-[var(--color-primary)] hover:opacity-90 disabled:opacity-50 text-[var(--color-bg)] px-5 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition-all cursor-pointer mx-auto"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            <span>启动推理服务</span>
          </button>
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
            {/* 右侧预留：服务状态 */}
            <div className="flex items-center gap-2 px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-lg">
              <span className={`w-2 h-2 rounded-full ${loaded ? 'bg-emerald-400' : 'bg-amber-400'}`} />
              <span className="text-xs text-on-surface/60 font-mono">
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
              className="text-xs text-red-400/70 hover:text-red-400 border border-red-500/20 hover:border-red-500/30 px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5"
            >
              <Square className="w-3 h-3" />
              卸载模型
            </button>
          )}

          {/* ── 聊天测试 ── */}
          {loaded && (
            <div className="border border-[var(--color-outline)]/15 rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2 bg-[var(--color-surface)] border-b border-[var(--color-outline)]/10">
                <span className="text-xs text-[var(--color-primary)] font-mono font-semibold">调试对话（不保存）</span>
                <div className="flex items-center gap-3">
                  {metrics && (
                    <span className="text-xs text-on-surface/40 font-mono">
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
                    className="bg-red-500/20 hover:bg-red-500/30 text-red-400 px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 transition-all cursor-pointer"
                  >
                    <Square className="w-3 h-3" />
                    停止
                  </button>
                ) : (
                  <button
                    onClick={sendChat}
                    disabled={!chatInput.trim()}
                    className="bg-[var(--color-primary)] hover:opacity-90 disabled:opacity-30 text-[var(--color-bg)] px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 transition-all cursor-pointer"
                  >
                    <Send className="w-3 h-3" />
                    发送
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ── 模型列表 ── */}
          <div className="space-y-2">
            <span className="text-xs text-[var(--color-primary)] font-mono font-semibold block">已添加模型</span>

            {/* 添加模型 */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newModelPath}
                onChange={(e) => setNewModelPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddModel(); }}
                placeholder="输入 GGUF 模型文件路径..."
                className="flex-1 bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded-lg px-3 py-2 text-xs text-[var(--color-on-surface)] focus:outline-none focus:border-[var(--color-primary)]/30 transition-all"
              />
              <button
                onClick={handleBrowse}
                className="bg-[var(--color-surface)] border border-[var(--color-outline)]/15 hover:border-[var(--color-primary)]/30 text-[var(--color-on-surface)]/60 hover:text-[var(--color-primary)] px-3 py-2 rounded-lg transition-all cursor-pointer"
                title="浏览文件"
              >
                <FolderOpen className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={handleAddModel}
                disabled={!newModelPath.trim()}
                className="bg-[var(--color-primary)] hover:opacity-90 disabled:opacity-30 text-[var(--color-bg)] px-3 py-2 rounded-lg transition-all cursor-pointer"
                title="添加模型"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* 模型列表 */}
            {models.length === 0 ? (
              <p className="text-xs text-on-surface/30 text-center py-4">
                还没有添加模型，请输入路径或点击浏览按钮
              </p>
            ) : (
              <div className="space-y-1.5">
                {models.map((m) => (
                  <div
                    key={m.path}
                    className="p-3 bg-[var(--color-surface)] border border-[var(--color-outline)]/10 rounded-lg flex items-center justify-between hover:border-[var(--color-primary)]/15 transition-all"
                  >
                    <div className="flex items-center gap-2.5 flex-1 min-w-0">
                      <div className={`w-2 h-2 rounded-full shrink-0 ${
                        loaded && status?.model_path === m.path
                          ? 'bg-emerald-400'
                          : 'bg-on-surface/20'
                      }`} />
                      <div className="min-w-0">
                        <span className="text-xs font-semibold text-[var(--color-on-surface)] block truncate">
                          {m.name}
                        </span>
                        {m.sizeMb && (
                          <span className="text-xs text-on-surface/30 font-mono">{m.sizeMb} MB</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {/* 移除（从列表移除，不删文件） */}
                      <button
                        onClick={() => handleRemoveModel(m.path)}
                        className="text-on-surface/30 hover:text-amber-400 p-1.5 rounded transition-colors"
                        title="从列表移除（保留文件）"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                      {/* 删除（从列表移除 + 磁盘删除） */}
                      <button
                        onClick={() => handleDeleteModel(m.path)}
                        className="text-on-surface/30 hover:text-red-400 p-1.5 rounded transition-colors"
                        title="从列表移除并删除文件"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── 确认切换模型对话框 ── */}
      {confirmSwitch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
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
                className="text-xs bg-[var(--color-primary)] hover:opacity-90 text-[var(--color-bg)] px-4 py-2 rounded-lg font-bold transition-all"
              >
                确认切换
              </button>
            </div>
          </div>
        </div>
      )}
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
          className="w-full bg-[var(--color-bg)]/50 border border-[var(--color-outline)]/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--color-on-surface)] font-mono focus:outline-none focus:border-[var(--color-primary)]/30 transition-all"
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
