// ─────────────────────────────────────────────────────────────────
// 主题编辑器
// - 实时调整每个 token 的颜色
// - 拾色器 + 文本输入 + 预设组 (Surface / Text / Accent / Brand / Status)
// - 预览区: 渲染一段小卡片展示当前效果
// - 一键重置 / 导出 / 复制 JSON
// ─────────────────────────────────────────────────────────────────

import { useState, useMemo } from 'react';
import { useTheme } from '../../themes';
import { Button, Tooltip, Badge } from '../ui/Button';
import type { ThemeTokens } from '../../themes/types';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface TokenGroup {
  id: string;
  label: string;
  icon: string;
  tokens: Array<{ key: keyof ThemeTokens; label: string; help?: string }>;
}

const GROUPS: TokenGroup[] = [
  {
    id: 'surface', label: '表面', icon: 'layers',
    tokens: [
      { key: 'bg',          label: '页面背景', help: '整体底色' },
      { key: 'bgDim',       label: '深色背景', help: '输入框 / 嵌套区' },
      { key: 'surface',     label: '表面',     help: '面板 / 卡片' },
      { key: 'surfaceLow',  label: '次表面',   help: '次级层级' },
      { key: 'surfaceHigh', label: '高亮表面', help: 'hover / 激活' },
    ],
  },
  {
    id: 'text', label: '文字', icon: 'text_fields',
    tokens: [
      { key: 'text',         label: '正文' },
      { key: 'textSecondary',label: '次要文字' },
    ],
  },
  {
    id: 'border', label: '边框', icon: 'crop_square',
    tokens: [
      { key: 'border',      label: '主边框' },
      { key: 'borderLight', label: '淡边框' },
    ],
  },
  {
    id: 'brand', label: '品牌色', icon: 'palette',
    tokens: [
      { key: 'primary',            label: '主色', help: '按钮 / 高亮' },
      { key: 'onPrimary',          label: '主色文字' },
      { key: 'primaryContainer',   label: '主色容器' },
      { key: 'onPrimaryContainer', label: '主色容器文字' },
      { key: 'accent',             label: '强调色' },
    ],
  },
  {
    id: 'status', label: '状态', icon: 'flag',
    tokens: [
      { key: 'success', label: '成功' },
      { key: 'warning', label: '警告' },
      { key: 'danger',  label: '危险' },
    ],
  },
];

const PRESET_PALETTES: Array<{ id: string; name: string; primary: string; accent: string }> = [
  { id: 'gold',    name: '暗金',     primary: '#e7c35a', accent: '#58a6ff' },
  { id: 'ocean',   name: '海洋',     primary: '#58a6ff', accent: '#bc8cff' },
  { id: 'sun',     name: '暖橙',     primary: '#f59e0b', accent: '#ef4444' },
  { id: 'forest',  name: '森林',     primary: '#22c55e', accent: '#14b8a6' },
  { id: 'rose',    name: '玫瑰',     primary: '#f43f5e', accent: '#a855f7' },
  { id: 'ice',     name: '冰蓝',     primary: '#38bdf8', accent: '#6366f1' },
  { id: 'mono',    name: '单色',     primary: '#94a3b8', accent: '#cbd5e1' },
];

export function ThemeEditor({ open, onClose }: Props) {
  const { current, customizeToken, customizeTokens, resetCustom, isCustomized } = useTheme();
  const [activeGroup, setActiveGroup] = useState('surface');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const tokens = current.tokens;
  const group = GROUPS.find(g => g.id === activeGroup) || GROUPS[0];

  const exportJson = () => {
    const json = JSON.stringify(current, null, 2);
    navigator.clipboard?.writeText(json).catch(() => {});
  };

  const importJson = () => {
    const raw = prompt('粘贴主题 JSON (tokens 部分):');
    if (!raw) return;
    try {
      const obj = JSON.parse(raw);
      const patch: Partial<ThemeTokens> = {};
      for (const k of Object.keys(obj) as Array<keyof ThemeTokens>) {
        if (typeof obj[k] === 'string' && obj[k].startsWith('#')) {
          patch[k] = obj[k];
        }
      }
      customizeTokens(patch);
    } catch (e) {
      alert('JSON 解析失败');
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[170] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[860px] max-w-[94vw] h-[640px] max-h-[90vh] overflow-hidden bg-surface rounded-2xl border border-border shadow-2xl flex animate-slide-in-up"
        onClick={e => e.stopPropagation()}
      >
        {/* 左:类别导航 */}
        <div className="w-48 border-r border-border bg-surface-low p-2 flex flex-col">
          <div className="flex items-center gap-1.5 px-2 py-1.5 mb-1">
            <span className="material-symbols-outlined filled text-primary text-lg">palette</span>
            <span className="font-display font-bold text-text text-sm">主题编辑器</span>
          </div>

          <div className="flex-1 space-y-0.5">
            {GROUPS.map(g => (
              <button
                key={g.id}
                onClick={() => setActiveGroup(g.id)}
                className={`w-full flex items-center gap-2 px-2 h-7 rounded-md text-xs transition-colors ${
                  activeGroup === g.id
                    ? 'bg-primary-container text-on-primary-container'
                    : 'text-text-secondary hover:text-text hover:bg-surface-high'
                }`}
              >
                <span className={`material-symbols-outlined text-sm ${activeGroup === g.id ? 'filled' : ''}`}>
                  {g.icon}
                </span>
                <span>{g.label}</span>
                <span className="ml-auto text-[9px] text-text-secondary/70 font-mono">
                  {g.tokens.length}
                </span>
              </button>
            ))}
          </div>

          <div className="px-1 py-1.5 border-t border-border-light">
            <button
              onClick={onClose}
              className="w-full flex items-center gap-2 px-2 h-7 rounded-md text-xs text-text-secondary hover:text-text hover:bg-surface-high transition-colors"
            >
              <span className="material-symbols-outlined text-sm">arrow_back</span>
              <span>返回</span>
            </button>
          </div>
        </div>

        {/* 中:token 调整 */}
        <div className="flex-1 flex flex-col bg-bg">
          {/* 顶部 */}
          <div className="flex items-center justify-between px-4 h-11 border-b border-border">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-base">{group.icon}</span>
              <h3 className="font-display font-semibold text-text text-sm">{group.label}</h3>
              <span className="text-[10px] text-text-secondary">{group.tokens.length} 个 token</span>
              {isCustomized && (
                <Badge variant="warning" dot>已自定义</Badge>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Tooltip content="高级 (JSON 编辑)">
                <Button variant="ghost" size="sm" icon="data_object" onClick={importJson} />
              </Tooltip>
              <Tooltip content="复制为 JSON">
                <Button variant="ghost" size="sm" icon="content_copy" onClick={exportJson} />
              </Tooltip>
              <Tooltip content="重置默认">
                <Button
                  variant="ghost"
                  size="sm"
                  icon="restart_alt"
                  onClick={() => {
                    if (confirm('恢复当前主题为默认值?')) resetCustom();
                  }}
                  disabled={!isCustomized}
                />
              </Tooltip>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-thin">
            {/* 预设调色板 */}
            {group.id === 'brand' && (
              <div className="p-3 rounded-lg border border-border-light bg-bg-dim">
                <div className="text-[10px] text-text-secondary uppercase tracking-wider mb-2 flex items-center gap-1">
                  <span className="material-symbols-outlined text-xs">auto_awesome</span>
                  预设组合
                </div>
                <div className="grid grid-cols-7 gap-1.5">
                  {PRESET_PALETTES.map(p => (
                    <button
                      key={p.id}
                      onClick={() => customizeTokens({ primary: p.primary, accent: p.accent })}
                      className="group flex flex-col items-center gap-0.5 p-1.5 rounded-md hover:bg-surface-high transition-colors"
                      title={p.name}
                    >
                      <div className="flex w-full h-4 rounded overflow-hidden">
                        <div className="flex-1" style={{ background: p.primary }} />
                        <div className="flex-1" style={{ background: p.accent }} />
                      </div>
                      <span className="text-[9px] text-text-secondary group-hover:text-text">{p.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* token 列表 */}
            {group.tokens.map(t => (
              <TokenRow
                key={t.key}
                tokenKey={t.key}
                label={t.label}
                help={t.help}
                value={tokens[t.key]}
                onChange={v => customizeToken(t.key, v)}
              />
            ))}

            {showAdvanced && (
              <div className="p-3 rounded-lg border border-warning/30 bg-warning/5">
                <div className="text-[10px] text-warning uppercase tracking-wider mb-1.5 flex items-center gap-1">
                  <span className="material-symbols-outlined text-xs">warning</span>
                  高级模式
                </div>
                <pre className="text-[10px] font-mono text-text-secondary overflow-x-auto scrollbar-thin">
                  {JSON.stringify(tokens, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>

        {/* 右:实时预览 */}
        <div className="w-[280px] border-l border-border bg-surface-low p-3 flex flex-col">
          <div className="flex items-center gap-1.5 mb-2">
            <span className="material-symbols-outlined text-primary text-base">preview</span>
            <span className="font-display font-semibold text-text text-sm">预览</span>
          </div>
          <PreviewPanel tokens={tokens} />
        </div>
      </div>
    </div>
  );
}

function TokenRow({ tokenKey, label, help, value, onChange }: {
  tokenKey: keyof ThemeTokens;
  label: string;
  help?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 p-2.5 rounded-lg border border-border-light bg-surface">
      <div className="shrink-0 relative w-10 h-10 rounded-md border border-border-light overflow-hidden cursor-pointer group">
        <input
          type="color"
          value={value}
          onChange={e => onChange(e.target.value)}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
        <div
          className="w-full h-full"
          style={{ background: value }}
        />
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/40 transition-opacity">
          <span className="material-symbols-outlined text-white text-sm">edit</span>
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-text">{label}</div>
        <div className="text-[10px] text-text-secondary font-mono">{tokenKey}</div>
        {help && <div className="text-[9px] text-text-secondary/70 mt-0.5">{help}</div>}
      </div>
      <input
        type="text"
        value={value}
        onChange={e => {
          const v = e.target.value;
          if (/^#[0-9a-fA-F]{0,6}$/.test(v) || v === '') onChange(v);
        }}
        onBlur={e => {
          if (!/^#[0-9a-fA-F]{6}$/.test(e.target.value)) {
            onChange(value);
          }
        }}
        className="w-20 bg-bg-dim border border-border rounded px-2 py-1 text-[10px] font-mono text-text focus:outline-none focus:border-primary text-center"
      />
    </div>
  );
}

function PreviewPanel({ tokens }: { tokens: ThemeTokens }) {
  return (
    <div className="flex-1 overflow-y-auto space-y-2 scrollbar-thin">
      {/* 颜色一览 */}
      <div className="grid grid-cols-5 gap-1">
        {Object.entries(tokens).map(([k, v]) => (
          <div key={k} className="aspect-square rounded border border-border-light flex items-end p-0.5" style={{ background: v as string }} title={`${k} = ${v}`}>
            <span className="text-[7px] font-mono text-white mix-blend-difference truncate w-full">{k}</span>
          </div>
        ))}
      </div>

      {/* 模拟组件 */}
      <div className="p-3 rounded-lg space-y-2" style={{ background: tokens.bg, color: tokens.text }}>
        <div className="flex items-center gap-1.5">
          <span className="material-symbols-outlined text-sm" style={{ color: tokens.primary }}>token</span>
          <span className="text-xs font-semibold" style={{ color: tokens.text }}>SoloForge</span>
        </div>
        <div className="text-[10px]" style={{ color: tokens.textSecondary }}>
          实时主题预览
        </div>
        <div className="flex flex-wrap gap-1">
          <span className="px-1.5 h-5 inline-flex items-center rounded text-[9px] font-semibold" style={{ background: tokens.primary, color: tokens.onPrimary }}>
            Primary
          </span>
          <span className="px-1.5 h-5 inline-flex items-center rounded text-[9px]" style={{ background: tokens.primaryContainer, color: tokens.onPrimaryContainer }}>
            Container
          </span>
          <span className="px-1.5 h-5 inline-flex items-center rounded text-[9px]" style={{ background: tokens.surface, color: tokens.text, border: `1px solid ${tokens.border}` }}>
            Surface
          </span>
        </div>
        <div className="flex items-center gap-1.5 pt-1">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: tokens.success }} />
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: tokens.warning }} />
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: tokens.danger }} />
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: tokens.accent }} />
        </div>
        <div className="p-2 rounded text-[10px]" style={{ background: tokens.surface, border: `1px solid ${tokens.border}` }}>
          <div className="font-mono" style={{ color: tokens.accent }}>const</div>
          <div className="font-mono pl-2" style={{ color: tokens.text }}>x = <span style={{ color: tokens.success }}>"hello"</span>;
          </div>
        </div>
        <button
          className="w-full h-7 rounded text-[10px] font-semibold"
          style={{ background: tokens.primary, color: tokens.onPrimary }}
        >
          主按钮
        </button>
      </div>
    </div>
  );
}
