// ─────────────────────────────────────────────────────────────────
// 主题包管理 — ThemeMarket
// - 内置主题库 (12+ 主题)
// - 导入/导出主题包 (.json)
// - 收藏/评分/搜索
// - 一键应用 + 实时预览
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
  currentTheme: string;
  onApply: (themeId: string) => void;
}

interface ThemePack {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
  category: 'dark' | 'light' | 'auto';
  rating: number;
  downloads: number;
  favorite: boolean;
  installed: boolean;
  preview: string;  // 主色
  tokens: Record<string, string>;  // CSS 变量
}

const STORAGE_KEY = 'soloforge.theme-market.v1';

const BUILTIN_THEMES: Omit<ThemePack, 'favorite' | 'installed'>[] = [
  {
    id: 'dark-default', name: '深邃黑', description: '默认深色,适合长时间编码', author: 'SoloForge', version: '1.0.0',
    tags: ['官方', '深色', '经典'], category: 'dark', rating: 4.7, downloads: 18230, preview: '#0f172a',
    tokens: { '--color-bg': '#0f172a', '--color-surface': '#1e293b', '--color-text': '#f1f5f9', '--color-primary': '#3b82f6' },
  },
  {
    id: 'light-clean', name: '极简白', description: '清爽白色,适合白天使用', author: 'SoloForge', version: '1.0.0',
    tags: ['官方', '浅色'], category: 'light', rating: 4.5, downloads: 12450, preview: '#ffffff',
    tokens: { '--color-bg': '#ffffff', '--color-surface': '#f8fafc', '--color-text': '#0f172a', '--color-primary': '#2563eb' },
  },
  {
    id: 'cyberpunk', name: '赛博朋克', description: '霓虹紫粉,大胆前卫', author: '霓虹工坊', version: '1.2.0',
    tags: ['社区', '深色', '霓虹'], category: 'dark', rating: 4.6, downloads: 8230, preview: '#ec4899',
    tokens: { '--color-bg': '#0a0118', '--color-surface': '#1a0a2e', '--color-text': '#fce7f3', '--color-primary': '#ec4899' },
  },
  {
    id: 'forest', name: '森林清晨', description: '绿色调,清新自然', author: '自然系', version: '1.0.0',
    tags: ['社区', '深色', '自然'], category: 'dark', rating: 4.4, downloads: 5612, preview: '#10b981',
    tokens: { '--color-bg': '#052e1a', '--color-surface': '#0a3d24', '--color-text': '#d1fae5', '--color-primary': '#10b981' },
  },
  {
    id: 'sunset', name: '黄昏海岸', description: '橙红渐变,温暖', author: '日落组', version: '1.1.0',
    tags: ['社区', '深色', '暖色'], category: 'dark', rating: 4.3, downloads: 4320, preview: '#f97316',
    tokens: { '--color-bg': '#1c0a05', '--color-surface': '#2d1208', '--color-text': '#fed7aa', '--color-primary': '#f97316' },
  },
  {
    id: 'deepsea', name: '深海蓝', description: '深邃海洋蓝,沉浸感强', author: 'Aqua', version: '1.0.0',
    tags: ['社区', '深色', '海洋'], category: 'dark', rating: 4.5, downloads: 6780, preview: '#06b6d4',
    tokens: { '--color-bg': '#0a1f2e', '--color-surface': '#0e2d40', '--color-text': '#cffafe', '--color-primary': '#06b6d4' },
  },
  {
    id: 'sakura', name: '樱花粉', description: '柔和粉色,优雅', author: '樱组', version: '1.0.0',
    tags: ['社区', '浅色', '粉色'], category: 'light', rating: 4.2, downloads: 3210, preview: '#fda4af',
    tokens: { '--color-bg': '#fff1f2', '--color-surface': '#ffe4e6', '--color-text': '#500724', '--color-primary': '#f43f5e' },
  },
  {
    id: 'midnight', name: '夜行', description: '极暗,夜间省眼', author: '暗夜', version: '1.0.0',
    tags: ['社区', '深色', '省眼'], category: 'dark', rating: 4.8, downloads: 9120, preview: '#1e1b4b',
    tokens: { '--color-bg': '#000000', '--color-surface': '#0a0a0a', '--color-text': '#e0e7ff', '--color-primary': '#6366f1' },
  },
  {
    id: 'desert', name: '沙漠金', description: '米黄暖色,纸质感', author: '游牧', version: '1.0.0',
    tags: ['社区', '浅色', '复古'], category: 'light', rating: 4.0, downloads: 2340, preview: '#d4a574',
    tokens: { '--color-bg': '#fef3c7', '--color-surface': '#fde68a', '--color-text': '#451a03', '--color-primary': '#b45309' },
  },
  {
    id: 'aurora', name: '极光', description: '青绿渐变,梦幻', author: 'Aurora', version: '1.0.0',
    tags: ['社区', '深色', '渐变'], category: 'dark', rating: 4.7, downloads: 7890, preview: '#22d3ee',
    tokens: { '--color-bg': '#022c22', '--color-surface': '#064e3b', '--color-text': '#a7f3d0', '--color-primary': '#22d3ee' },
  },
  {
    id: 'grape', name: '葡萄紫', description: '高贵紫色,神秘', author: 'Grape', version: '1.0.0',
    tags: ['社区', '深色', '紫色'], category: 'dark', rating: 4.4, downloads: 4120, preview: '#a855f7',
    tokens: { '--color-bg': '#1a0a2e', '--color-surface': '#2d1b4e', '--color-text': '#e9d5ff', '--color-primary': '#a855f7' },
  },
  {
    id: 'cappuccino', name: '焦糖', description: '咖啡色,温暖商务', author: 'Coffee', version: '1.0.0',
    tags: ['社区', '深色', '咖啡'], category: 'dark', rating: 4.3, downloads: 3450, preview: '#92400e',
    tokens: { '--color-bg': '#1c1410', '--color-surface': '#2d1f17', '--color-text': '#fed7aa', '--color-primary': '#92400e' },
  },
];

function loadThemes(): ThemePack[] {
  try {
    const r = localStorage.getItem(STORAGE_KEY);
    if (r) return JSON.parse(r);
  } catch { /* ignore */ }
  return BUILTIN_THEMES.map(t => ({ ...t, favorite: false, installed: ['dark-default', 'light-clean'].includes(t.id) }));
}
function saveThemes(arr: ThemePack[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr)); } catch { /* ignore */ }
}

export function ThemeMarket({ open, onClose, currentTheme, onApply }: Props) {
  const [themes, setThemes] = useState<ThemePack[]>(loadThemes);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<'all' | 'dark' | 'light' | 'fav' | 'installed'>('all');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => { saveThemes(themes); }, [themes]);

  const filtered = useMemo(() => {
    return themes.filter(t => {
      if (category === 'fav' && !t.favorite) return false;
      if (category === 'installed' && !t.installed) return false;
      if (category !== 'all' && category !== 'fav' && category !== 'installed' && t.category !== category) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return t.name.toLowerCase().includes(q)
        || t.description.toLowerCase().includes(q)
        || t.tags.some(tag => tag.toLowerCase().includes(q))
        || t.author.toLowerCase().includes(q);
    });
  }, [themes, search, category]);

  const active = useMemo(() => themes.find(t => t.id === activeId) || null, [themes, activeId]);

  const toggleFav = useCallback((id: string) => {
    setThemes(prev => prev.map(t => t.id === id ? { ...t, favorite: !t.favorite } : t));
  }, []);

  const toggleInstall = useCallback((id: string) => {
    setThemes(prev => prev.map(t => t.id === id ? { ...t, installed: !t.installed, downloads: t.installed ? t.downloads : t.downloads + 1 } : t));
  }, []);

  const applyTheme = useCallback((t: ThemePack) => {
    onApply(t.id);
  }, [onApply]);

  const exportTheme = useCallback((t: ThemePack) => {
    const blob = new Blob([JSON.stringify(t, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `theme-${t.id}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, []);

  const importTheme = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const t = JSON.parse(reader.result as string);
        if (t.id && t.tokens) {
          setThemes(prev => [{ ...t, favorite: false, installed: true }, ...prev]);
        }
      } catch { /* ignore */ }
    };
    reader.readAsText(file);
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-[1200px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">palette</span>
          <h2 className="text-sm font-semibold text-text">主题市场</h2>
          <Badge variant="primary">{themes.length} 主题</Badge>
          <span className="text-xs text-text-secondary">已安装 {themes.filter(t => t.installed).length}</span>
          <div className="ml-auto flex items-center gap-1">
            <Tooltip content="导入主题包"><IconButton icon="upload" onClick={() => {
              const inp = document.createElement('input');
              inp.type = 'file';
              inp.accept = '.json';
              inp.onchange = () => { const f = inp.files?.[0]; if (f) importTheme(f); };
              inp.click();
            }} /></Tooltip>
            <div className="flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light">
              {(['grid', 'list'] as const).map(v => (
                <button key={v} onClick={() => setView(v)}
                  className={'px-2 h-6 rounded text-[10px] ' + (view === v ? 'bg-surface-high text-text' : 'text-text-secondary hover:text-text')}>
                  {v === 'grid' ? '网格' : '列表'}
                </button>
              ))}
            </div>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        {/* 工具条 */}
        <div className="px-4 py-2 border-b border-border bg-bg shrink-0 flex items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索主题名/作者/标签..."
            className="flex-1 bg-surface border border-border-light rounded px-2 h-7 text-xs text-text focus:border-accent outline-none"
          />
          <div className="flex items-center gap-0.5 p-0.5 bg-surface rounded-md border border-border-light">
            {(['all', 'dark', 'light', 'fav', 'installed'] as const).map(c => (
              <button key={c} onClick={() => setCategory(c)}
                className={'px-2 h-6 rounded text-[10px] ' + (category === c ? 'bg-surface-high text-text' : 'text-text-secondary hover:text-text')}>
                {c === 'all' ? '全部' : c === 'dark' ? '🌙 深色' : c === 'light' ? '☀️ 浅色' : c === 'fav' ? '★ 收藏' : '✓ 已装'}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* 主区 */}
          <div className={'flex-1 overflow-y-auto p-3 ' + (active ? 'border-r border-border' : '')}>
            {view === 'grid' ? (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                {filtered.map(t => (
                  <div
                    key={t.id}
                    onClick={() => setActiveId(t.id)}
                    onDoubleClick={() => applyTheme(t)}
                    className={'rounded-lg border overflow-hidden cursor-pointer transition hover:shadow-lg ' + (activeId === t.id ? 'border-accent ring-2 ring-accent/30' : 'border-border')}
                  >
                    {/* 预览 */}
                    <div
                      className="h-24 p-2 flex items-center gap-1"
                      style={{ background: t.tokens['--color-bg'] || '#0f172a' }}
                    >
                      <div className="flex-1 space-y-1">
                        <div className="h-2 rounded" style={{ background: t.tokens['--color-primary'], width: '60%' }} />
                        <div className="h-1.5 rounded opacity-50" style={{ background: t.tokens['--color-text'], width: '80%' }} />
                        <div className="h-1.5 rounded opacity-30" style={{ background: t.tokens['--color-text'], width: '50%' }} />
                      </div>
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-bold"
                        style={{ background: t.tokens['--color-primary'], color: t.tokens['--color-bg'] }}
                      >
                        Aa
                      </div>
                    </div>
                    {/* 卡片底 */}
                    <div className="p-2 bg-surface">
                      <div className="flex items-center gap-1">
                        <span className="text-xs font-medium text-text truncate flex-1">{t.name}</span>
                        {t.id === currentTheme && <Badge variant="success">当前</Badge>}
                        {t.favorite && <span className="material-symbols-outlined text-xs filled text-yellow-500">star</span>}
                      </div>
                      <div className="text-[10px] text-text-secondary mt-0.5 line-clamp-1">{t.description}</div>
                      <div className="flex items-center gap-1 mt-1 text-[9px] text-text-secondary">
                        <span className="material-symbols-outlined text-xs filled text-yellow-500">star</span>
                        <span>{t.rating.toFixed(1)}</span>
                        <span>·</span>
                        <span className="material-symbols-outlined text-xs">download</span>
                        <span>{t.downloads}</span>
                        <span className="ml-auto">v{t.version}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-1">
                {filtered.map(t => (
                  <div
                    key={t.id}
                    onClick={() => setActiveId(t.id)}
                    className={'flex items-center gap-2 p-2 rounded-lg border cursor-pointer hover:bg-surface-high transition ' + (activeId === t.id ? 'bg-accent/10 border-accent/30' : 'border-border')}
                  >
                    <div
                      className="w-12 h-12 rounded shrink-0"
                      style={{ background: `linear-gradient(135deg, ${t.tokens['--color-primary']}, ${t.tokens['--color-surface']})` }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-text truncate">{t.name}</span>
                        {t.id === currentTheme && <Badge variant="success">当前</Badge>}
                        {t.favorite && <span className="material-symbols-outlined text-xs filled text-yellow-500">star</span>}
                      </div>
                      <div className="text-[10px] text-text-secondary truncate">{t.description}</div>
                    </div>
                    <div className="text-[10px] text-text-secondary">★ {t.rating.toFixed(1)} · ⬇ {t.downloads}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 详情 */}
          {active && (
            <div className="w-80 bg-bg flex flex-col overflow-hidden">
              <div
                className="h-32 p-3"
                style={{ background: active.tokens['--color-bg'] }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-lg font-bold" style={{ color: active.tokens['--color-text'] }}>{active.name}</span>
                </div>
                <div className="text-xs opacity-70" style={{ color: active.tokens['--color-text'] }}>{active.description}</div>
                <div className="mt-2 flex gap-1">
                  {active.tags.map(tag => (
                    <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: active.tokens['--color-primary'], color: active.tokens['--color-bg'] }}>
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
              <div className="px-3 py-2 border-b border-border bg-surface-high flex items-center gap-1">
                <Tooltip content="收藏"><IconButton icon={active.favorite ? 'star' : 'star_border'} filled={active.favorite} onClick={() => toggleFav(active.id)} /></Tooltip>
                <Tooltip content={active.installed ? '卸载' : '安装'}><IconButton icon={active.installed ? 'uninstall' : 'install_desktop'} onClick={() => toggleInstall(active.id)} /></Tooltip>
                <Tooltip content="导出"><IconButton icon="download" onClick={() => exportTheme(active)} /></Tooltip>
                <Button size="sm" variant="primary" icon="play_arrow" onClick={() => applyTheme(active)} block>
                  {active.id === currentTheme ? '当前主题' : '应用主题'}
                </Button>
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-2 text-[11px]">
                <div>
                  <h4 className="text-[10px] text-text-secondary uppercase tracking-wider mb-1">信息</h4>
                  <div className="space-y-0.5 text-text">
                    <div>作者: {active.author}</div>
                    <div>版本: v{active.version}</div>
                    <div>分类: {active.category === 'dark' ? '🌙 深色' : '☀️ 浅色'}</div>
                    <div>评分: ★ {active.rating.toFixed(1)} / 5.0</div>
                    <div>下载: {active.downloads.toLocaleString()}</div>
                  </div>
                </div>
                <div>
                  <h4 className="text-[10px] text-text-secondary uppercase tracking-wider mb-1">颜色 Token</h4>
                  {Object.entries(active.tokens).map(([k, v]) => (
                    <div key={k} className="flex items-center gap-2">
                      <span className="w-4 h-4 rounded border border-border" style={{ background: v }} />
                      <code className="text-[10px] font-mono text-text-secondary flex-1 truncate">{k}</code>
                      <code className="text-[10px] font-mono text-text">{v}</code>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
