// ─────────────────────────────────────────────────────────────────
// 调色板 / 颜色工具 — ColorPalette
// - 选色器 (HEX/RGB/HSL/HSB/CMYK)
// - 配色方案 (互补/三角/类比/分裂补色/单色)
// - 颜色调和 (明暗变化)
// - WCAG 对比度检查 (AA/AAA)
// - 收藏色板
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface Color { hex: string; }

const STORE = 'soloforge.color-palette.v1';

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.replace('#', '').match(/.{2}/g);
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[0], 16), g: parseInt(m[1], 16), b: parseInt(m[2], 16) };
}
function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  h /= 360; s /= 100; l /= 100;
  let r: number, g: number, b: number;
  if (s === 0) { r = g = b = l; } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: r * 255, g: g * 255, b: b * 255 };
}
function rgbToCmyk(r: number, g: number, b: number): { c: number; m: number; y: number; k: number } {
  r /= 255; g /= 255; b /= 255;
  const k = 1 - Math.max(r, g, b);
  if (k === 1) return { c: 0, m: 0, y: 0, k: 1 };
  return { c: (1 - r - k) / (1 - k), m: (1 - g - k) / (1 - k), y: (1 - b - k) / (1 - k), k };
}
function relLum(r: number, g: number, b: number): number {
  const norm = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * norm(r) + 0.7152 * norm(g) + 0.0722 * norm(b);
}
function contrast(a: string, b: string): number {
  const ra = hexToRgb(a); const rb = hexToRgb(b);
  const la = relLum(ra.r, ra.g, ra.b);
  const lb = relLum(rb.r, rb.g, rb.b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function rotate(h: number, deg: number): number { return (h + deg + 360) % 360; }

function schemes(hex: string): Record<string, string[]> {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  const c = (deg: number) => { const rgb = hslToRgb(rotate(h, deg), s, l); return rgbToHex(rgb.r, rgb.g, rgb.b); };
  return {
    互补:        [c(0), c(180)],
    三角:        [c(0), c(120), c(240)],
    类比:        [c(-30), c(0), c(30)],
    分裂补色:    [c(0), c(150), c(210)],
    四方:        [c(0), c(90), c(180), c(270)],
    单色:        Array.from({ length: 5 }, (_, i) => { const rgb = hslToRgb(h, s, Math.max(10, Math.min(90, l - 30 + i * 15))); return rgbToHex(rgb.r, rgb.g, rgb.b); }),
  };
}

const TAILWIND = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981', '#14b8a6',
  '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
  '#f43f5e', '#6b7280', '#374151', '#1f2937',
];

function load(): Color[] { try { const r = localStorage.getItem(STORE); if (r) return JSON.parse(r); } catch { /* */ } return [{ hex: '#3B82F6' }]; }
function save(d: Color[]) { try { localStorage.setItem(STORE, JSON.stringify(d)); } catch { /* */ } }

export function ColorPalette({ open, onClose }: Props) {
  const [current, setCurrent] = useState('#3B82F6');
  const [favs, setFavs] = useState<Color[]>(load);
  const [tab, setTab] = useState<'harmony' | 'shades' | 'a11y'>('harmony');

  useEffect(() => { save(favs); }, [favs]);

  const rgb = hexToRgb(current);
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const cmyk = rgbToCmyk(rgb.r, rgb.g, rgb.b);
  const all = schemes(current);
  const shades = useMemo(() => {
    return Array.from({ length: 11 }, (_, i) => {
      const l = 95 - i * 9;
      const c = hslToRgb(hsl.h, hsl.s, l);
      return rgbToHex(c.r, c.g, c.b);
    });
  }, [current]);

  const addFav = useCallback(() => {
    if (favs.some(f => f.hex === current)) return;
    setFavs(prev => [{ hex: current }, ...prev].slice(0, 24));
  }, [current, favs]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1100px] max-w-[95vw] h-[80vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">palette</span>
          <h2 className="text-sm font-semibold text-text">调色板</h2>
          <div className="w-8 h-8 rounded border-2 border-border shadow-inner" style={{ background: current }} />
          <code className="text-sm font-mono text-text">{current}</code>
          <input type="color" value={current} onChange={(e) => setCurrent(e.target.value.toUpperCase())} className="w-8 h-8 rounded cursor-pointer bg-transparent border-none" />
          <div className="ml-auto flex items-center gap-1">
            <Tooltip content="收藏"><IconButton icon="star" onClick={addFav} /></Tooltip>
            <div className="flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light">
              {(['harmony', 'shades', 'a11y'] as const).map(t => (
                <button key={t} onClick={() => setTab(t)} className={'px-2 h-6 rounded text-[10px] ' + (tab === t ? 'bg-surface-high text-text' : 'text-text-secondary')}>
                  {t === 'harmony' ? '配色' : t === 'shades' ? '明暗' : 'A11y'}
                </button>
              ))}
            </div>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 p-3 overflow-y-auto">
            {tab === 'harmony' && (
              <div className="space-y-3">
                {Object.entries(all).map(([name, colors]) => (
                  <div key={name}>
                    <h3 className="text-xs font-semibold text-text mb-1">{name} ({colors.length} 色)</h3>
                    <div className="flex gap-1">
                      {colors.map(c => (
                        <button key={c} onClick={() => setCurrent(c)}
                          className="flex-1 h-16 rounded transition hover:scale-105 hover:shadow-lg"
                          style={{ background: c, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.1)' }}>
                          <div className="bg-black/40 text-white text-[9px] px-1 py-0.5 rounded-bl inline-block font-mono">{c}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'shades' && (
              <div>
                <h3 className="text-xs font-semibold text-text mb-2">明暗变化 (11 阶)</h3>
                <div className="grid grid-cols-11 gap-1">
                  {shades.map((c, i) => (
                    <button key={c} onClick={() => setCurrent(c)} className="h-20 rounded transition hover:scale-105 relative group" style={{ background: c }}>
                      <span className="absolute inset-x-0 bottom-0 bg-black/60 text-white text-[9px] py-0.5 font-mono">{i * 10}</span>
                    </button>
                  ))}
                </div>
                <h3 className="text-xs font-semibold text-text mt-4 mb-2">Tailwind 调色板</h3>
                <div className="grid grid-cols-10 gap-1">
                  {TAILWIND.map(c => (
                    <button key={c} onClick={() => setCurrent(c)} className="h-10 rounded transition hover:scale-110" style={{ background: c }} title={c} />
                  ))}
                </div>
              </div>
            )}

            {tab === 'a11y' && (
              <div>
                <h3 className="text-xs font-semibold text-text mb-2">WCAG 对比度</h3>
                <p className="text-[10px] text-text-secondary mb-2">选择前景/背景色组合,查看 AA/AAA 合规</p>
                <div className="grid grid-cols-2 gap-2">
                  {['#FFFFFF', '#000000', '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#6B7280', '#F3F4F6'].map(fg => (
                    <div key={fg} className="rounded-lg p-3 border border-border-light" style={{ background: current }}>
                      <div className="text-lg font-bold" style={{ color: fg }}>Aa 大字</div>
                      <div className="text-xs" style={{ color: fg }}>普通字号示例文字</div>
                      <div className="mt-2 flex items-center gap-2">
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: fg, color: current }}>{fg}</span>
                        <span className="text-[10px] font-mono text-text-secondary bg-white/80 px-1.5 py-0.5 rounded">对比 {contrast(current, fg).toFixed(2)}</span>
                        <Badge variant={contrast(current, fg) >= 7 ? 'success' : contrast(current, fg) >= 4.5 ? 'info' : 'danger'}>
                          {contrast(current, fg) >= 7 ? 'AAA' : contrast(current, fg) >= 4.5 ? 'AA' : 'FAIL'}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="w-72 border-l border-border bg-bg p-3 space-y-2">
            <h3 className="text-xs font-semibold text-text">当前颜色</h3>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-surface border border-border-light rounded p-2">
                <div className="text-[10px] text-text-secondary">HEX</div>
                <input value={current} onChange={(e) => setCurrent(e.target.value.toUpperCase())}
                  className="w-full bg-transparent font-mono text-xs text-text" />
              </div>
              <div className="bg-surface border border-border-light rounded p-2">
                <div className="text-[10px] text-text-secondary">RGB</div>
                <div className="font-mono text-xs text-text">{rgb.r}, {rgb.g}, {rgb.b}</div>
              </div>
              <div className="bg-surface border border-border-light rounded p-2">
                <div className="text-[10px] text-text-secondary">HSL</div>
                <div className="font-mono text-xs text-text">{hsl.h.toFixed(0)}°, {hsl.s.toFixed(0)}%, {hsl.l.toFixed(0)}%</div>
              </div>
              <div className="bg-surface border border-border-light rounded p-2">
                <div className="text-[10px] text-text-secondary">CMYK</div>
                <div className="font-mono text-xs text-text">{Math.round(cmyk.c * 100)}, {Math.round(cmyk.m * 100)}, {Math.round(cmyk.y * 100)}, {Math.round(cmyk.k * 100)}</div>
              </div>
            </div>

            <h3 className="text-xs font-semibold text-text pt-2">收藏色板 ({favs.length})</h3>
            <div className="grid grid-cols-6 gap-1">
              {favs.map(f => (
                <button key={f.hex} onClick={() => setCurrent(f.hex)}
                  className="aspect-square rounded relative group" style={{ background: f.hex, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.1)' }}
                  title={f.hex}>
                  <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100">
                    <IconButton icon="close" size="xs" tooltip="删除" onClick={(e) => { e.stopPropagation(); setFavs(prev => prev.filter(x => x.hex !== f.hex)); }} />
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
