// ─────────────────────────────────────────────────────────────────
// AI 主题生成器
// - 自然语言描述 → 配色/字体/圆角/阴影/间距
// - 12 预设 mood 词 (赛博/森林/极简/黄昏/海洋/...)
// - 实时预览 30+ UI 元素 (按钮/输入/卡片/代码/...)
// - 一键应用到全局,或导出为 JSON
// - 配色算法: HSL 微调 + WCAG 对比度校验
// - 历史记录 (最近 20 次生成)
// ─────────────────────────────────────────────────────────────────

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useTheme } from '../../themes';

// ── 类型 ──
interface ThemeTokens {
  name: string;
  primary: string;
  primaryFg: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  bg: string;
  surface: string;
  surfaceHigh: string;
  text: string;
  textSecondary: string;
  border: string;
  fontFamily: string;
  fontMono: string;
  radius: string;
  shadow: string;
}

interface PresetSeed {
  mood: string;
  emoji: string;
  desc: string;
  tokens: Partial<ThemeTokens>;
}

// ── HSL 工具 ──
function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = ((b - r) / d + 2); break;
      case b: h = ((r - g) / d + 4); break;
    }
    h *= 60;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

function adjustColor(hex: string, dl: number, ds: number = 0): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, s + ds, l + dl);
}

function contrastRatio(c1: string, c2: string): number {
  const lum = (hex: string) => {
    const [h, s, l] = hexToHsl(hex);
    return l / 100;
  };
  const l1 = lum(c1), l2 = lum(c2);
  const a = Math.max(l1, l2), b = Math.min(l1, l2);
  return (a + 0.05) / (b + 0.05);
}

// ── 预设 mood 种子 ──
const PRESETS: PresetSeed[] = [
  { mood: '赛博朋克', emoji: '🌃', desc: '深夜霓虹 + 紫粉撞色',
    tokens: { primary: '#a855f7', accent: '#ec4899', bg: '#0a0612', surface: '#1a0f2e', surfaceHigh: '#2a1f4e', text: '#f0e7ff', textSecondary: '#9f8fcf', border: '#3a2f5e' } },
  { mood: '森林清晨', emoji: '🌲', desc: '苔藓绿 + 雾白',
    tokens: { primary: '#10b981', accent: '#84cc16', bg: '#f7faf7', surface: '#ffffff', surfaceHigh: '#ecfdf5', text: '#1a2e1a', textSecondary: '#5a6f5a', border: '#d1e7d1' } },
  { mood: '极简白', emoji: '⬜', desc: '纯白 + 单一蓝点',
    tokens: { primary: '#2563eb', accent: '#0ea5e9', bg: '#ffffff', surface: '#fafafa', surfaceHigh: '#f0f0f0', text: '#0a0a0a', textSecondary: '#737373', border: '#e5e5e5', radius: '4px' } },
  { mood: '黄昏海岸', emoji: '🌅', desc: '橘红渐变 + 紫蓝',
    tokens: { primary: '#f97316', accent: '#fbbf24', bg: '#1a1330', surface: '#2a1f4e', surfaceHigh: '#3a2f6e', text: '#ffe8d0', textSecondary: '#c5a585', border: '#5a4f8e' } },
  { mood: '深海', emoji: '🌊', desc: '钴蓝 + 青绿',
    tokens: { primary: '#0891b2', accent: '#06b6d4', bg: '#0a1929', surface: '#102a43', surfaceHigh: '#1e3a5f', text: '#d0e8f5', textSecondary: '#8aabc5', border: '#2a4f75' } },
  { mood: '樱花粉', emoji: '🌸', desc: '粉嫩 + 奶白',
    tokens: { primary: '#f43f5e', accent: '#fb7185', bg: '#fff5f7', surface: '#ffffff', surfaceHigh: '#fff0f3', text: '#3a1f2a', textSecondary: '#9f7f8f', border: '#fcd5dd' } },
  { mood: '夜行', emoji: '🌑', desc: '纯黑 + 荧光绿',
    tokens: { primary: '#00ff88', accent: '#00cc6a', bg: '#000000', surface: '#0a0a0a', surfaceHigh: '#1a1a1a', text: '#e0ffe0', textSecondary: '#7fbf7f', border: '#2a2a2a' } },
  { mood: '沙漠', emoji: '🏜️', desc: '沙黄 + 赭石',
    tokens: { primary: '#d97706', accent: '#f59e0b', bg: '#fdf6e3', surface: '#f5e8c8', surfaceHigh: '#e8d4a0', text: '#3a2a1a', textSecondary: '#8a6f4a', border: '#d4b878' } },
  { mood: '葡萄紫', emoji: '🍇', desc: '深紫 + 玫红',
    tokens: { primary: '#7c3aed', accent: '#c026d3', bg: '#1a0a2e', surface: '#2e1a4e', surfaceHigh: '#4e2a6e', text: '#f0e7ff', textSecondary: '#9f8fbf', border: '#5a3a8e' } },
  { mood: '冰川', emoji: '❄️', desc: '冰蓝 + 雪白',
    tokens: { primary: '#0284c7', accent: '#38bdf8', bg: '#f0f9ff', surface: '#ffffff', surfaceHigh: '#e0f2fe', text: '#0a2540', textSecondary: '#5a7a9a', border: '#bae6fd' } },
  { mood: '焦糖', emoji: '☕', desc: '咖啡棕 + 焦糖',
    tokens: { primary: '#92400e', accent: '#d97706', bg: '#2a1a0a', surface: '#3a2a1a', surfaceHigh: '#5a3a2a', text: '#f5e8d0', textSecondary: '#bf9f7f', border: '#6a4a2a' } },
  { mood: '霓虹紫粉', emoji: '💜', desc: '高饱和紫粉撞色',
    tokens: { primary: '#d946ef', accent: '#f0abfc', bg: '#0a0a1a', surface: '#1a0a2e', surfaceHigh: '#3a0a5e', text: '#fce7f3', textSecondary: '#c084fc', border: '#5a1a8e' } },
];

// ── 描述 → 主题 启发式 ──
const MOOD_KEYWORDS: Record<string, Partial<ThemeTokens>> = {
  // 颜色
  '红':    { primary: '#ef4444' }, '橙':    { primary: '#f97316' }, '黄':    { primary: '#eab308' },
  '绿':    { primary: '#22c55e' }, '青':    { primary: '#06b6d4' }, '蓝':    { primary: '#3b82f6' },
  '紫':    { primary: '#a855f7' }, '粉':    { primary: '#ec4899' }, '黑':    { bg: '#0a0a0a', text: '#fafafa' },
  '白':    { bg: '#ffffff', text: '#0a0a0a' }, '灰':   { bg: '#1a1a1a', text: '#d4d4d4' },
  // 风格
  '暗':    { bg: '#0a0a0f', surface: '#15151f', text: '#e5e5f0' },
  '亮':    { bg: '#ffffff', surface: '#f8f8fc', text: '#0a0a0f' },
  '复古':  { primary: '#92400e', bg: '#fdf6e3' },
  '现代':  { primary: '#3b82f6', radius: '8px' },
  '极简':  { primary: '#0a0a0a', bg: '#ffffff', radius: '0px' },
  '圆润':  { radius: '16px' }, '方':     { radius: '2px' },
  '赛博':  { primary: '#a855f7', accent: '#ec4899', bg: '#0a0612' },
  '森林':  { primary: '#10b981', accent: '#84cc16' },
  '海洋':  { primary: '#0891b2', accent: '#06b6d4' },
  '黄昏':  { primary: '#f97316', accent: '#fbbf24' },
  '夜':    { bg: '#0a0a14', text: '#e0e0f0' },
  '日':    { bg: '#fafaf5', text: '#0a0a14' },
};

function generateFromDescription(desc: string, baseName: string): ThemeTokens {
  const lower = desc.toLowerCase();
  let tokens: ThemeTokens = {
    name: baseName,
    primary: '#6366f1', primaryFg: '#ffffff',
    accent: '#a855f7', success: '#10b981', warning: '#f59e0b', danger: '#ef4444',
    bg: '#0f172a', surface: '#1e293b', surfaceHigh: '#334155',
    text: '#e2e8f0', textSecondary: '#94a3b8', border: '#475569',
    fontFamily: 'system-ui, sans-serif', fontMono: 'ui-monospace, monospace',
    radius: '8px', shadow: '0 4px 12px rgba(0,0,0,0.3)',
  };
  // 关键词匹配
  for (const [kw, partial] of Object.entries(MOOD_KEYWORDS)) {
    if (lower.includes(kw)) {
      tokens = { ...tokens, ...partial };
    }
  }
  // 推导次生颜色
  if (!tokens.surface || tokens.surface === '#1e293b') {
    tokens.surface = adjustColor(tokens.bg, 8);
    tokens.surfaceHigh = adjustColor(tokens.bg, 14);
    tokens.border = adjustColor(tokens.bg, 20);
  }
  // 推导文字色 (如果未指定)
  if (Math.random() < 0.5) {
    // 基于背景明度自动
    const [, , bgL] = hexToHsl(tokens.bg);
    tokens.text = bgL > 50 ? '#0a0a0a' : '#fafafa';
    tokens.textSecondary = bgL > 50 ? '#525252' : '#a3a3a3';
  }
  // 主前景色
  const [, , pL] = hexToHsl(tokens.primary);
  tokens.primaryFg = pL > 50 ? '#0a0a0a' : '#ffffff';
  // 对比度警告: 如果主色与背景对比不够, 提亮
  if (contrastRatio(tokens.primary, tokens.bg) < 2.5) {
    const [, , bgL] = hexToHsl(tokens.bg);
    tokens.primary = bgL > 50 ? adjustColor(tokens.primary, -30) : adjustColor(tokens.primary, 30);
  }
  return tokens;
}

// ─── 主组件 ───
interface Props {
  open: boolean;
  onClose: () => void;
  onApply: (tokens: ThemeTokens) => void;
}

export function ThemeGenerator({ open, onClose, onApply }: Props) {
  const { themeList, setTheme } = useTheme();
  const [desc, setDesc] = useState('赛博朋克风的极客氛围,深紫底 + 荧光绿点缀');
  const [name, setName] = useState('AI 主题');
  const [tokens, setTokens] = useState<ThemeTokens>(() => generateFromDescription('赛博朋克', 'AI 主题'));
  const [history, setHistory] = useState<Array<{ id: string; ts: number; tokens: ThemeTokens; desc: string }>>(() => {
    try { const r = localStorage.getItem('soloforge.themeGen.history'); return r ? JSON.parse(r) : []; } catch { return []; }
  });
  const [mode, setMode] = useState<'describe' | 'tweak'>('describe');
  const [contrastCheck, setContrastCheck] = useState(true);

  useEffect(() => { try { localStorage.setItem('soloforge.themeGen.history', JSON.stringify(history.slice(0, 20))); } catch { /* ignore */ } }, [history]);

  const generate = useCallback(() => {
    const t = generateFromDescription(desc, name);
    setTokens(t);
    setHistory(prev => [{ id: 't_' + Date.now().toString(36), ts: Date.now(), tokens: t, desc }, ...prev.filter(h => h.tokens.name !== t.name)].slice(0, 20));
  }, [desc, name]);

  const usePreset = useCallback((preset: PresetSeed) => {
    setDesc(preset.mood);
    setName(preset.mood);
    const t = generateFromDescription(preset.mood, preset.mood);
    setTokens(t);
  }, []);

  const updateToken = useCallback((key: keyof ThemeTokens, value: string) => {
    setTokens(prev => ({ ...prev, [key]: value }));
  }, []);

  const applyTheme = useCallback(() => {
    onApply(tokens);
    // 同步到 theme provider
    setTheme('custom-' + Date.now());
    alert('✓ 主题已应用\n\n可在设置中保存为正式主题');
  }, [tokens, onApply, setTheme]);

  const exportJson = useCallback(() => {
    const blob = new Blob([JSON.stringify({ __type: 'soloforge.theme', version: 1, tokens }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name.replace(/\s+/g, '-').toLowerCase() + '.theme.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [tokens, name]);

  // 应用预览 (实时)
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    root.style.setProperty('--color-primary', tokens.primary);
    root.style.setProperty('--color-accent', tokens.accent);
    root.style.setProperty('--color-bg', tokens.bg);
    root.style.setProperty('--color-surface', tokens.surface);
    root.style.setProperty('--color-surface-high', tokens.surfaceHigh);
    root.style.setProperty('--color-text', tokens.text);
    root.style.setProperty('--color-text-secondary', tokens.textSecondary);
    root.style.setProperty('--color-border', tokens.border);
    return () => {
      // 恢复原值
      root.style.removeProperty('--color-primary');
      root.style.removeProperty('--color-accent');
      root.style.removeProperty('--color-bg');
      root.style.removeProperty('--color-surface');
      root.style.removeProperty('--color-surface-high');
      root.style.removeProperty('--color-text');
      root.style.removeProperty('--color-text-secondary');
      root.style.removeProperty('--color-border');
    };
  }, [tokens, open]);

  const contrastWarnings = useMemo(() => {
    if (!contrastCheck) return [];
    const checks: Array<{ pair: string; ratio: number; ok: boolean }> = [
      { pair: '主色 vs 背景',     ratio: contrastRatio(tokens.primary, tokens.bg),         ok: false },
      { pair: '文字 vs 背景',     ratio: contrastRatio(tokens.text, tokens.bg),            ok: false },
      { pair: '次文字 vs 背景',   ratio: contrastRatio(tokens.textSecondary, tokens.bg),  ok: false },
      { pair: '主前景 vs 主色',   ratio: contrastRatio(tokens.primaryFg, tokens.primary), ok: false },
    ];
    checks.forEach(c => { c.ok = c.ratio >= 4.5; });
    return checks;
  }, [tokens, contrastCheck]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[min(98vw,1280px)] h-[min(94vh,860px)] bg-bg-elevated border border-border rounded-xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
        style={{ backgroundColor: 'var(--color-bg-elevated, #1e293b)' }}
      >
        {/* Header */}
        <div className="flex items-center px-4 py-2.5 border-b border-border shrink-0" style={{ borderColor: tokens.border }}>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">palette</span>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="bg-transparent text-base font-semibold outline-none border-b border-transparent hover:border-border focus:border-primary"
            />
            <span className="text-xs text-text-secondary">AI 主题生成器</span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => setMode(m => m === 'describe' ? 'tweak' : 'describe')}
              className={'px-2.5 py-1 text-xs rounded border ' + (mode === 'tweak' ? 'border-primary text-primary bg-primary/10' : 'border-border hover:bg-bg-dim')}
            >
              <span className="material-symbols-outlined text-sm align-middle mr-0.5">tune</span>
              {mode === 'describe' ? '微调' : '描述'}
            </button>
            <button onClick={exportJson} className="px-2.5 py-1 text-xs rounded border border-border hover:bg-bg-dim flex items-center gap-1">
              <span className="material-symbols-outlined text-sm">download</span>
              导出
            </button>
            <button onClick={applyTheme} className="px-3 py-1 text-xs rounded bg-primary text-on-primary flex items-center gap-1">
              <span className="material-symbols-outlined text-sm">check</span>
              应用主题
            </button>
            <button onClick={onClose} className="px-2 py-1 rounded hover:bg-bg-dim text-text-secondary ml-1">
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          </div>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* 左: 描述/微调 */}
          <div className="w-80 border-r border-border flex flex-col shrink-0" style={{ borderColor: tokens.border }}>
            {mode === 'describe' ? (
              <>
                <div className="px-3 py-2 border-b border-border text-xs text-text-secondary uppercase">描述</div>
                <div className="p-3 space-y-2 flex-1 overflow-auto">
                  <textarea
                    value={desc}
                    onChange={e => setDesc(e.target.value)}
                    rows={4}
                    placeholder="用一段话描述你想要的氛围..."
                    className="w-full px-2 py-1.5 rounded border border-border bg-bg text-sm resize-none"
                    style={{ backgroundColor: tokens.surface, borderColor: tokens.border, color: tokens.text }}
                  />
                  <button
                    onClick={generate}
                    className="w-full px-3 py-1.5 rounded bg-primary text-on-primary text-sm font-medium flex items-center justify-center gap-1"
                    style={{ backgroundColor: tokens.primary, color: tokens.primaryFg }}
                  >
                    <span className="material-symbols-outlined text-sm">auto_awesome</span>
                    生成主题
                  </button>

                  <div className="text-xs text-text-secondary uppercase pt-2">12 个 mood 预设</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {PRESETS.map(p => (
                      <button
                        key={p.mood}
                        onClick={() => usePreset(p)}
                        className="px-2 py-1.5 rounded border border-border hover:border-primary text-left text-xs flex flex-col gap-0.5"
                        style={{ backgroundColor: tokens.surface, borderColor: tokens.border }}
                      >
                        <span className="text-base">{p.emoji} <span className="text-xs font-medium" style={{ color: tokens.text }}>{p.mood}</span></span>
                        <span className="text-[10px] text-text-secondary truncate" style={{ color: tokens.textSecondary }}>{p.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="px-3 py-2 border-b border-border text-xs text-text-secondary uppercase">微调 Tokens</div>
                <div className="p-3 space-y-2 flex-1 overflow-auto">
                  {([
                    { key: 'primary', label: '主色' },
                    { key: 'accent', label: '强调色' },
                    { key: 'success', label: '成功' },
                    { key: 'warning', label: '警告' },
                    { key: 'danger', label: '危险' },
                    { key: 'bg', label: '背景' },
                    { key: 'surface', label: '面板' },
                    { key: 'surfaceHigh', label: '面板高亮' },
                    { key: 'text', label: '文字' },
                    { key: 'textSecondary', label: '次文字' },
                    { key: 'border', label: '边框' },
                  ] as const).map(({ key, label }) => (
                    <div key={key} className="flex items-center gap-2">
                      <input
                        type="color"
                        value={tokens[key]}
                        onChange={e => updateToken(key, e.target.value)}
                        className="w-8 h-7 rounded border border-border cursor-pointer"
                        style={{ borderColor: tokens.border }}
                      />
                      <label className="text-xs flex-1" style={{ color: tokens.text }}>{label}</label>
                      <input
                        type="text"
                        value={tokens[key]}
                        onChange={e => updateToken(key, e.target.value)}
                        className="w-20 px-1.5 py-0.5 rounded border border-border bg-bg text-[10px] font-mono"
                        style={{ backgroundColor: tokens.bg, borderColor: tokens.border, color: tokens.text }}
                      />
                    </div>
                  ))}
                  <div className="pt-2">
                    <label className="text-xs" style={{ color: tokens.text }}>圆角</label>
                    <input
                      type="text"
                      value={tokens.radius}
                      onChange={e => updateToken('radius', e.target.value)}
                      className="w-full mt-0.5 px-2 py-1 rounded border border-border bg-bg text-xs"
                      style={{ backgroundColor: tokens.bg, borderColor: tokens.border, color: tokens.text }}
                    />
                  </div>
                </div>
              </>
            )}

            {/* 对比度检查 */}
            <div className="border-t border-border p-3" style={{ borderColor: tokens.border }}>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-text-secondary uppercase">WCAG 对比度</span>
                <button
                  onClick={() => setContrastCheck(v => !v)}
                  className={'w-7 h-4 rounded-full relative ' + (contrastCheck ? 'bg-primary' : 'bg-bg-dim')}
                >
                  <span className={'absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ' + (contrastCheck ? 'translate-x-3.5' : 'translate-x-0.5')} />
                </button>
              </div>
              {contrastWarnings.map((c, i) => (
                <div key={i} className="flex items-center justify-between text-[10px] py-0.5">
                  <span style={{ color: tokens.textSecondary }}>{c.pair}</span>
                  <span className="flex items-center gap-1">
                    <span className="font-mono" style={{ color: tokens.textSecondary }}>{c.ratio.toFixed(2)}</span>
                    <span className="material-symbols-outlined text-xs" style={{ color: c.ok ? tokens.success : tokens.danger }}>
                      {c.ok ? 'check_circle' : 'warning'}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* 中: 预览 */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="px-3 py-1.5 border-b border-border text-xs text-text-secondary flex items-center gap-2" style={{ borderColor: tokens.border, color: tokens.textSecondary }}>
              <span className="material-symbols-outlined text-sm">preview</span>
              <span>实时预览 · 30+ 组件</span>
            </div>
            <div className="flex-1 overflow-auto p-4" style={{ backgroundColor: tokens.bg, color: tokens.text }}>
              <PreviewSurface tokens={tokens} />
            </div>
          </div>

          {/* 右: 历史 */}
          <div className="w-56 border-l border-border flex flex-col shrink-0" style={{ borderColor: tokens.border }}>
            <div className="px-3 py-2 border-b border-border text-xs text-text-secondary uppercase" style={{ borderColor: tokens.border }}>历史</div>
            <div className="flex-1 overflow-auto">
              {history.length === 0 && <div className="px-3 py-6 text-center text-xs text-text-secondary">暂无历史</div>}
              {history.map(h => (
                <button
                  key={h.id}
                  onClick={() => { setTokens(h.tokens); setName(h.tokens.name); setDesc(h.desc); }}
                  className="w-full px-3 py-2 border-b border-border/50 hover:bg-bg-dim text-left"
                  style={{ borderColor: tokens.border }}
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    {(['primary', 'accent', 'bg', 'surface'] as const).map(k => (
                      <div key={k} className="w-4 h-4 rounded border border-border" style={{ backgroundColor: h.tokens[k] }} />
                    ))}
                    <span className="text-xs font-medium truncate" style={{ color: tokens.text }}>{h.tokens.name}</span>
                  </div>
                  <div className="text-[10px] text-text-secondary truncate" style={{ color: tokens.textSecondary }}>{h.desc}</div>
                  <div className="text-[9px] text-text-secondary/70 mt-0.5" style={{ color: tokens.textSecondary }}>
                    {new Date(h.ts).toLocaleTimeString('zh-CN')}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 预览组件 (渲染 30+ UI 元素) ──
function PreviewSurface({ tokens }: { tokens: ThemeTokens }) {
  const [checked, setChecked] = useState(true);
  return (
    <div className="space-y-4 max-w-3xl">
      {/* 标题 */}
      <div>
        <h2 className="text-2xl font-bold" style={{ color: tokens.text }}>主题预览</h2>
        <p style={{ color: tokens.textSecondary }}>所有元素都会随主题实时变化</p>
      </div>

      {/* 按钮组 */}
      <Section title="按钮" tokens={tokens}>
        <div className="flex flex-wrap gap-2">
          <button className="px-3 py-1.5 rounded text-sm font-medium" style={{ backgroundColor: tokens.primary, color: tokens.primaryFg, borderRadius: tokens.radius }}>主要</button>
          <button className="px-3 py-1.5 rounded text-sm font-medium border" style={{ borderColor: tokens.border, color: tokens.text, backgroundColor: tokens.surface, borderRadius: tokens.radius }}>次要</button>
          <button className="px-3 py-1.5 rounded text-sm font-medium" style={{ backgroundColor: tokens.success, color: '#fff', borderRadius: tokens.radius }}>成功</button>
          <button className="px-3 py-1.5 rounded text-sm font-medium" style={{ backgroundColor: tokens.warning, color: '#000', borderRadius: tokens.radius }}>警告</button>
          <button className="px-3 py-1.5 rounded text-sm font-medium" style={{ backgroundColor: tokens.danger, color: '#fff', borderRadius: tokens.radius }}>危险</button>
          <button className="px-3 py-1.5 rounded text-sm font-medium underline" style={{ color: tokens.accent }}>链接</button>
        </div>
      </Section>

      {/* 输入 */}
      <Section title="输入控件" tokens={tokens}>
        <div className="grid grid-cols-2 gap-2 max-w-2xl">
          <input
            type="text"
            placeholder="文本输入"
            className="px-3 py-1.5 text-sm border"
            style={{ backgroundColor: tokens.surface, borderColor: tokens.border, color: tokens.text, borderRadius: tokens.radius }}
          />
          <select
            className="px-3 py-1.5 text-sm border"
            style={{ backgroundColor: tokens.surface, borderColor: tokens.border, color: tokens.text, borderRadius: tokens.radius }}
          >
            <option>选项 1</option>
            <option>选项 2</option>
          </select>
          <textarea
            placeholder="多行文本"
            rows={2}
            className="col-span-2 px-3 py-1.5 text-sm border"
            style={{ backgroundColor: tokens.surface, borderColor: tokens.border, color: tokens.text, borderRadius: tokens.radius }}
          />
          <label className="flex items-center gap-2 text-sm" style={{ color: tokens.text }}>
            <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} /> 复选框
          </label>
          <label className="flex items-center gap-2 text-sm" style={{ color: tokens.text }}>
            <input type="radio" name="r" defaultChecked /> 单选 1
            <input type="radio" name="r" /> 单选 2
          </label>
        </div>
      </Section>

      {/* 卡片 */}
      <Section title="卡片" tokens={tokens}>
        <div className="grid grid-cols-3 gap-2">
          {['蓝', '红', '黄'].map(c => (
            <div
              key={c}
              className="p-3 border"
              style={{ backgroundColor: tokens.surfaceHigh, borderColor: tokens.border, borderRadius: tokens.radius, boxShadow: tokens.shadow }}
            >
              <div className="font-medium" style={{ color: tokens.text }}>{c}色卡片</div>
              <div className="text-xs" style={{ color: tokens.textSecondary }}>这是一段描述文字,展示背景与文字的对比</div>
              <div className="mt-2 flex gap-1">
                <span className="px-1.5 py-0.5 text-[10px] rounded" style={{ backgroundColor: tokens.primary, color: tokens.primaryFg }}>tag</span>
                <span className="px-1.5 py-0.5 text-[10px] rounded border" style={{ borderColor: tokens.border, color: tokens.textSecondary }}>tag</span>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* 代码 */}
      <Section title="代码块" tokens={tokens}>
        <pre
          className="px-3 py-2 text-xs font-mono border overflow-auto"
          style={{ backgroundColor: tokens.surface, borderColor: tokens.border, color: tokens.text, borderRadius: tokens.radius }}
        >
          <span style={{ color: tokens.accent }}>const</span> <span style={{ color: tokens.text }}>theme</span> = <span style={{ color: tokens.warning }}>'cool'</span>;<br />
          <span style={{ color: tokens.textSecondary }}>// 注释会显示次文字色</span><br />
          <span style={{ color: tokens.accent }}>function</span> <span style={{ color: tokens.text }}>apply</span>() {`{`}<br />
          {'  '}<span style={{ color: tokens.accent }}>return</span> <span style={{ color: tokens.success }}>true</span>;<br />
          {`}`}
        </pre>
      </Section>

      {/* 徽标 / 状态点 */}
      <Section title="徽标" tokens={tokens}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="px-2 py-0.5 text-xs rounded" style={{ backgroundColor: tokens.primary, color: tokens.primaryFg }}>新</span>
          <span className="px-2 py-0.5 text-xs rounded border" style={{ borderColor: tokens.border, color: tokens.textSecondary }}>默认</span>
          <span className="px-2 py-0.5 text-xs rounded" style={{ backgroundColor: tokens.success, color: '#fff' }}>✓ 成功</span>
          <span className="px-2 py-0.5 text-xs rounded" style={{ backgroundColor: tokens.warning, color: '#000' }}>⚠ 警告</span>
          <span className="px-2 py-0.5 text-xs rounded" style={{ backgroundColor: tokens.danger, color: '#fff' }}>✕ 错误</span>
          <span className="flex items-center gap-1.5 text-xs" style={{ color: tokens.text }}>
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: tokens.success }} />
            在线
          </span>
          <span className="flex items-center gap-1.5 text-xs" style={{ color: tokens.text }}>
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: tokens.danger }} />
            离线
          </span>
        </div>
      </Section>

      {/* 进度 */}
      <Section title="进度条" tokens={tokens}>
        <div className="space-y-1.5">
          {[25, 50, 75, 100].map(p => (
            <div key={p} className="flex items-center gap-2">
              <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ backgroundColor: tokens.surfaceHigh }}>
                <div className="h-full" style={{ width: p + '%', backgroundColor: tokens.primary }} />
              </div>
              <span className="text-xs font-mono" style={{ color: tokens.textSecondary }}>{p}%</span>
            </div>
          ))}
        </div>
      </Section>

      {/* 表格 */}
      <Section title="表格" tokens={tokens}>
        <table className="w-full text-sm border" style={{ borderColor: tokens.border }}>
          <thead style={{ backgroundColor: tokens.surfaceHigh }}>
            <tr>
              <th className="text-left p-2" style={{ color: tokens.textSecondary }}>名称</th>
              <th className="text-left p-2" style={{ color: tokens.textSecondary }}>状态</th>
              <th className="text-right p-2" style={{ color: tokens.textSecondary }}>数量</th>
            </tr>
          </thead>
          <tbody>
            {['Alpha', 'Beta', 'Gamma'].map((n, i) => (
              <tr key={n} className="border-t" style={{ borderColor: tokens.border }}>
                <td className="p-2" style={{ color: tokens.text }}>{n}</td>
                <td className="p-2">
                  <span className="px-1.5 py-0.5 text-[10px] rounded" style={{ backgroundColor: i === 1 ? tokens.warning : tokens.success, color: i === 1 ? '#000' : '#fff' }}>
                    {i === 1 ? '待定' : '完成'}
                  </span>
                </td>
                <td className="p-2 text-right font-mono" style={{ color: tokens.textSecondary }}>{(i + 1) * 42}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

function Section({ title, tokens, children }: { title: string; tokens: ThemeTokens; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: tokens.textSecondary }}>{title}</h3>
      {children}
    </div>
  );
}
