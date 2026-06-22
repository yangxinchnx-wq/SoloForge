/**
 * BrowserUseSettingsModal — Browser-Use LLM 凭据 + 行为配置
 *
 * 字段:
 *  - provider: google | openai | anthropic
 *  - apiKey
 *  - model (provider-specific)
 *  - baseUrl (openai 自托管)
 *  - maxSteps
 *  - stealth (Obscura 反指纹)
 *  - port (Obscura CDP 端口)
 *
 * 持久化: localStorage (key=soloforge_browser_use_config)
 * 后续: 同步到后端 PUT /api/browser-use/config (TODO)
 */
import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Globe, Key, Cpu, Eye, Network, Save, AlertCircle, CheckCircle2 } from 'lucide-react';

export interface BrowserUseConfig {
  provider: 'google' | 'openai' | 'anthropic';
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxSteps: number;
  stealth: boolean;
  port: number;
  useScreenshots: boolean;
}

const DEFAULTS: BrowserUseConfig = {
  provider: 'google',
  apiKey: '',
  model: 'gemini-2.0-flash',
  baseUrl: '',
  maxSteps: 25,
  stealth: true,
  port: 9222,
  useScreenshots: true,
};

const PROVIDER_MODELS: Record<string, { value: string; label: string }[]> = {
  google: [
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (推荐, 快速)' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (高质)' },
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash (稳定)' },
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o mini (便宜)' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
  ],
  anthropic: [
    { value: 'claude-3-5-sonnet-latest', label: 'Claude 3.5 Sonnet' },
    { value: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku' },
    { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus' },
  ],
};

const STORAGE_KEY = 'soloforge_browser_use_config';

interface Props {
  onClose: () => void;
}

export function BrowserUseSettingsModal({ onClose }: Props): React.ReactElement {
  const [cfg, setCfg] = useState<BrowserUseConfig>(DEFAULTS);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        try {
          setCfg({ ...DEFAULTS, ...JSON.parse(stored) });
        } catch {
          /* ignore */
        }
      }
    }
  }, []);

  const handleSave = () => {
    if (!cfg.apiKey.trim()) {
      setError('API Key 必填');
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    setSaved(true);
    setError(null);
    setTimeout(() => setSaved(false), 2000);
  };

  const update = (patch: Partial<BrowserUseConfig>) => {
    setCfg((prev) => ({ ...prev, ...patch }));
  };

  const models = PROVIDER_MODELS[cfg.provider] ?? [];

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      >
        <motion.div
          initial={{ scale: 0.95, y: 20 }}
          animate={{ scale: 1, y: 0 }}
          exit={{ scale: 0.95, y: 20 }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-lg max-h-[90vh] overflow-y-auto scrollbar-thin bg-surface border border-outline/40 rounded-lg shadow-2xl"
        >
          {/* Header */}
          <div className="sticky top-0 z-10 bg-surface/95 backdrop-blur px-4 py-3 border-b border-outline/30 flex items-center gap-2">
            <Globe className="w-4 h-4 text-blue-400" />
            <h2 className="text-sm font-semibold text-on-surface">Browser-Use 配置</h2>
            <div className="flex-1" />
            <button
              onClick={onClose}
              className="p-1 hover:bg-on-surface/10 rounded text-on-surface/60"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div className="px-4 py-3 space-y-3 text-[12px]">
            {/* Provider */}
            <div>
              <label className="flex items-center gap-1.5 text-[10px] font-semibold text-on-surface/70 mb-1">
                <Cpu className="w-3 h-3" /> LLM Provider
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                {(['google', 'openai', 'anthropic'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => update({
                      provider: p,
                      model: PROVIDER_MODELS[p]?.[0]?.value ?? '',
                    })}
                    className={`px-2 py-1.5 text-[10px] rounded border transition-colors ${
                      cfg.provider === p
                        ? 'bg-blue-500/20 border-blue-500/50 text-blue-300'
                        : 'bg-bg/40 border-outline/30 text-on-surface/70 hover:bg-on-surface/5'
                    }`}
                  >
                    {p === 'google' ? 'Google' : p === 'openai' ? 'OpenAI' : 'Anthropic'}
                  </button>
                ))}
              </div>
            </div>

            {/* API Key */}
            <div>
              <label className="flex items-center gap-1.5 text-[10px] font-semibold text-on-surface/70 mb-1">
                <Key className="w-3 h-3" /> API Key
              </label>
              <input
                type="password"
                value={cfg.apiKey}
                onChange={(e) => update({ apiKey: e.target.value })}
                placeholder="sk-..."
                className="w-full px-2 py-1.5 text-[11px] bg-bg border border-outline/30 rounded focus:border-blue-500/50 outline-none font-mono"
              />
            </div>

            {/* Model */}
            <div>
              <label className="flex items-center gap-1.5 text-[10px] font-semibold text-on-surface/70 mb-1">
                <Cpu className="w-3 h-3" /> Model
              </label>
              <select
                value={cfg.model}
                onChange={(e) => update({ model: e.target.value })}
                className="w-full px-2 py-1.5 text-[11px] bg-bg border border-outline/30 rounded focus:border-blue-500/50 outline-none"
              >
                {models.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>

            {/* baseUrl (openai only) */}
            {cfg.provider === 'openai' && (
              <div>
                <label className="flex items-center gap-1.5 text-[10px] font-semibold text-on-surface/70 mb-1">
                  <Network className="w-3 h-3" /> Base URL (自托管可选)
                </label>
                <input
                  type="text"
                  value={cfg.baseUrl ?? ''}
                  onChange={(e) => update({ baseUrl: e.target.value })}
                  placeholder="https://api.openai.com/v1"
                  className="w-full px-2 py-1.5 text-[11px] bg-bg border border-outline/30 rounded focus:border-blue-500/50 outline-none font-mono"
                />
              </div>
            )}

            {/* Advanced */}
            <div className="border-t border-outline/20 pt-2 mt-2">
              <div className="text-[10px] font-semibold text-on-surface/70 mb-2">高级</div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-1.5 text-[11px] text-on-surface/80">
                    <Eye className="w-3 h-3" /> 启用 stealth 模式 (反指纹)
                  </label>
                  <input
                    type="checkbox"
                    checked={cfg.stealth}
                    onChange={(e) => update({ stealth: e.target.checked })}
                    className="w-4 h-4"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-1.5 text-[11px] text-on-surface/80">
                    <Globe className="w-3 h-3" /> 任务截图上传到 LLM
                  </label>
                  <input
                    type="checkbox"
                    checked={cfg.useScreenshots}
                    onChange={(e) => update({ useScreenshots: e.target.checked })}
                    className="w-4 h-4"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-on-surface/70 mb-1 block">
                    最大步数 (max_steps)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={cfg.maxSteps}
                    onChange={(e) => update({ maxSteps: Number(e.target.value) || 25 })}
                    className="w-24 px-2 py-1 text-[11px] bg-bg border border-outline/30 rounded focus:border-blue-500/50 outline-none font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-on-surface/70 mb-1 block">
                    Obscura 端口
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={cfg.port}
                    onChange={(e) => update({ port: Number(e.target.value) || 9222 })}
                    className="w-24 px-2 py-1 text-[11px] bg-bg border border-outline/30 rounded focus:border-blue-500/50 outline-none font-mono"
                  />
                </div>
              </div>
            </div>

            {/* Status */}
            {error && (
              <div className="text-[10px] bg-red-500/10 border border-red-500/30 rounded p-2 text-red-300 flex items-center gap-1.5">
                <AlertCircle className="w-3 h-3 shrink-0" />
                {error}
              </div>
            )}
            {saved && (
              <div className="text-[10px] bg-green-500/10 border border-green-500/30 rounded p-2 text-green-300 flex items-center gap-1.5">
                <CheckCircle2 className="w-3 h-3 shrink-0" />
                已保存到 localStorage. 重启 Browser-Use 服务后生效.
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="sticky bottom-0 bg-surface/95 backdrop-blur px-4 py-2.5 border-t border-outline/30 flex justify-end gap-1.5">
            <button
              onClick={onClose}
              className="px-3 py-1 text-[10px] hover:bg-on-surface/10 rounded text-on-surface/70"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              className="px-3 py-1 text-[10px] bg-blue-500 hover:bg-blue-600 rounded text-white flex items-center gap-1"
            >
              <Save className="w-3 h-3" /> 保存
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

export default BrowserUseSettingsModal;
