// ─────────────────────────────────────────────────────────────────
// 资源库 (图片/图标/字体/音视频) — AssetLibrary
// - 网格/列表视图
// - 上传/拖拽/复制 URL
// - 标签/分类/搜索
// - 使用统计
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Tooltip, IconButton, Badge, Button, Select } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; onPick?: (asset: Asset) => void; }

interface Asset {
  id: string;
  name: string;
  type: 'image' | 'icon' | 'font' | 'video' | 'audio' | 'svg';
  url: string;
  thumbnail?: string;  // emoji or color
  size: number;        // bytes
  width?: number;
  height?: number;
  tags: string[];
  category: string;
  uploadedAt: number;
  usedCount: number;
  uploadedBy: string;
}

const STORE = 'soloforge.asset-library.v1';

const CATEGORIES = [
  { id: 'all', name: '全部', icon: 'apps' },
  { id: 'logo', name: 'Logo', icon: 'workspaces' },
  { id: 'icon', name: '图标', icon: 'emoji_objects' },
  { id: 'photo', name: '照片', icon: 'photo_library' },
  { id: 'illust', name: '插画', icon: 'palette' },
  { id: 'bg', name: '背景', icon: 'wallpaper' },
  { id: 'font', name: '字体', icon: 'text_fields' },
  { id: 'video', name: '视频', icon: 'movie' },
  { id: 'audio', name: '音频', icon: 'audio_file' },
];

const SEED: Asset[] = [
  { id: 'a1', name: 'logo-primary.svg', type: 'svg', url: '/assets/logo.svg', thumbnail: '🟦', size: 4096, width: 256, height: 64, tags: ['logo', 'brand'], category: 'logo', uploadedAt: Date.now() - 86400000 * 30, usedCount: 42, uploadedBy: 'Alice' },
  { id: 'a2', name: 'hero-bg.png', type: 'image', url: '/img/hero.png', thumbnail: '🌅', size: 102400, width: 1920, height: 1080, tags: ['hero', 'gradient'], category: 'bg', uploadedAt: Date.now() - 86400000 * 14, usedCount: 3, uploadedBy: 'Bob' },
  { id: 'a3', name: 'icon-home.svg', type: 'icon', url: '/icons/home.svg', thumbnail: '🏠', size: 512, width: 24, height: 24, tags: ['ui', 'navigation'], category: 'icon', uploadedAt: Date.now() - 86400000 * 7, usedCount: 87, uploadedBy: 'Alice' },
  { id: 'a4', name: 'avatar-default.png', type: 'image', url: '/img/avatar.png', thumbnail: '👤', size: 2048, width: 64, height: 64, tags: ['avatar'], category: 'photo', uploadedAt: Date.now() - 86400000 * 5, usedCount: 156, uploadedBy: 'System' },
  { id: 'a5', name: 'Inter-Regular.woff2', type: 'font', url: '/fonts/Inter.woff2', thumbnail: 'Aa', size: 51200, tags: ['sans', 'body'], category: 'font', uploadedAt: Date.now() - 86400000 * 3, usedCount: 12, uploadedBy: 'Carol' },
  { id: 'a6', name: 'product-shot.jpg', type: 'image', url: '/img/product.jpg', thumbnail: '📦', size: 256000, width: 1024, height: 1024, tags: ['product', 'marketing'], category: 'photo', uploadedAt: Date.now() - 86400000 * 2, usedCount: 8, uploadedBy: 'Dan' },
  { id: 'a7', name: 'illustration-team.svg', type: 'svg', url: '/img/team.svg', thumbnail: '👥', size: 8192, tags: ['team', 'about'], category: 'illust', uploadedAt: Date.now() - 86400000, usedCount: 1, uploadedBy: 'Eve' },
  { id: 'a8', name: 'bg-pattern.png', type: 'image', url: '/img/pattern.png', thumbnail: '🟫', size: 16384, tags: ['pattern', 'bg'], category: 'bg', uploadedAt: Date.now() - 3600000 * 6, usedCount: 5, uploadedBy: 'Alice' },
  { id: 'a9', name: 'sound-success.mp3', type: 'audio', url: '/audio/success.mp3', thumbnail: '🔊', size: 8192, tags: ['sfx'], category: 'audio', uploadedAt: Date.now() - 3600000, usedCount: 0, uploadedBy: 'System' },
  { id: 'a10', name: 'demo-video.mp4', type: 'video', url: '/video/demo.mp4', thumbnail: '🎬', size: 4194304, tags: ['demo', 'marketing'], category: 'video', uploadedAt: Date.now() - 7200000, usedCount: 2, uploadedBy: 'Bob' },
];

function load(): Asset[] { try { const r = localStorage.getItem(STORE); if (r) return JSON.parse(r); } catch { /* */ } return SEED; }
function save(d: Asset[]) { try { localStorage.setItem(STORE, JSON.stringify(d)); } catch { /* */ } }

function formatSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(2)} MB`;
}

export function AssetLibrary({ open, onClose, onPick }: Props) {
  const [assets, setAssets] = useState<Asset[]>(load);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [search, setSearch] = useState('');
  const [activeCat, setActiveCat] = useState('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'name' | 'size' | 'used' | 'date'>('date');
  const [activeId, setActiveId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { save(assets); }, [assets]);

  const filtered = useMemo(() => {
    let r = assets.filter(a => {
      if (activeCat !== 'all' && a.category !== activeCat) return false;
      if (typeFilter !== 'all' && a.type !== typeFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!a.name.toLowerCase().includes(q) && !a.tags.some(t => t.toLowerCase().includes(q))) return false;
      }
      return true;
    });
    r = [...r].sort((x, y) => {
      if (sortBy === 'name') return x.name.localeCompare(y.name);
      if (sortBy === 'size') return y.size - x.size;
      if (sortBy === 'used') return y.usedCount - x.usedCount;
      return y.uploadedAt - x.uploadedAt;
    });
    return r;
  }, [assets, activeCat, typeFilter, search, sortBy]);

  const active = useMemo(() => assets.find(a => a.id === activeId) || null, [assets, activeId]);

  const upload = useCallback((files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach(file => {
      const id = 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const type: Asset['type'] = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('font/') ? 'font' : file.name.endsWith('.svg') ? 'svg' : 'image';
      const newAsset: Asset = {
        id, name: file.name, type, url: URL.createObjectURL(file),
        thumbnail: type === 'image' ? '🖼️' : type === 'video' ? '🎬' : type === 'audio' ? '🔊' : type === 'font' ? 'Aa' : '📄',
        size: file.size, tags: [], category: type === 'image' ? 'photo' : type === 'video' ? 'video' : type === 'audio' ? 'audio' : type === 'font' ? 'font' : 'icon',
        uploadedAt: Date.now(), usedCount: 0, uploadedBy: 'me',
      };
      setAssets(prev => [newAsset, ...prev]);
    });
  }, []);

  const del = useCallback((id: string) => {
    setAssets(prev => prev.filter(a => a.id !== id));
    if (activeId === id) setActiveId(null);
  }, [activeId]);

  const incUse = useCallback((id: string) => {
    setAssets(prev => prev.map(a => a.id === id ? { ...a, usedCount: a.usedCount + 1 } : a));
  }, []);

  const copyUrl = useCallback((a: Asset) => {
    navigator.clipboard?.writeText(a.url).catch(() => {});
    incUse(a.id);
  }, [incUse]);

  if (!open) return null;

  const totalSize = assets.reduce((a, x) => a + x.size, 0);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">photo_library</span>
          <h2 className="text-sm font-semibold text-text">资源库</h2>
          <Badge variant="primary">{assets.length} 资源</Badge>
          <Badge variant="info">{formatSize(totalSize)}</Badge>
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => upload(e.target.files)} accept="image/*,video/*,audio/*,.svg,.woff,.woff2,.ttf,.otf" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索资源名/标签..."
            className="bg-surface border border-border-light rounded px-2 h-7 text-xs w-48 ml-auto" />
          <div className="flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light">
            {(['grid', 'list'] as const).map(v => (
              <button key={v} onClick={() => setView(v)} className={'px-2 h-6 rounded text-[10px] ' + (view === v ? 'bg-surface-high text-text' : 'text-text-secondary')}>
                {v === 'grid' ? '网格' : '列表'}
              </button>
            ))}
          </div>
          <Button size="sm" icon="upload" onClick={() => fileRef.current?.click()}>上传</Button>
          <IconButton icon="close" onClick={onClose} />
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-44 border-r border-border bg-bg p-2 space-y-0.5">
            {CATEGORIES.map(c => {
              const count = assets.filter(a => c.id === 'all' || a.category === c.id).length;
              return (
                <button key={c.id} onClick={() => setActiveCat(c.id)} className={'w-full text-left px-2 py-1.5 rounded text-xs flex items-center gap-1.5 ' + (activeCat === c.id ? 'bg-accent/15 text-accent' : 'hover:bg-surface-high text-text')}>
                  <span className="material-symbols-outlined text-sm">{c.icon}</span>
                  <span className="flex-1">{c.name}</span>
                  <span className="text-[10px] text-text-secondary">{count}</span>
                </button>
              );
            })}
            <div className="border-t border-border-light my-2" />
            <p className="text-[10px] text-text-secondary px-2 mb-1">类型</p>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="w-full bg-surface border border-border-light rounded px-1.5 h-6 text-[10px]">
              <option value="all">全部</option>
              <option value="image">图片</option>
              <option value="svg">SVG</option>
              <option value="icon">图标</option>
              <option value="font">字体</option>
              <option value="video">视频</option>
              <option value="audio">音频</option>
            </select>
            <p className="text-[10px] text-text-secondary px-2 mb-1 mt-2">排序</p>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)} className="w-full bg-surface border border-border-light rounded px-1.5 h-6 text-[10px]">
              <option value="date">最新</option>
              <option value="name">名称</option>
              <option value="size">大小</option>
              <option value="used">使用</option>
            </select>
          </div>

          <div className="flex-1 flex overflow-hidden">
            <div className="flex-1 overflow-y-auto p-3">
              {filtered.length === 0 ? <p className="p-4 text-center text-xs text-text-secondary">无资源</p> : view === 'grid' ? (
                <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                  {filtered.map(a => (
                    <div key={a.id} onClick={() => setActiveId(a.id)}
                      onDoubleClick={() => { onPick?.(a); incUse(a.id); }}
                      className={'bg-bg border rounded-lg overflow-hidden cursor-pointer transition hover:shadow-md ' + (activeId === a.id ? 'border-accent ring-2 ring-accent/30' : 'border-border')}>
                      <div className="aspect-square flex items-center justify-center text-4xl bg-surface-high">
                        {a.thumbnail}
                      </div>
                      <div className="p-1.5">
                        <div className="text-[10px] font-medium text-text truncate">{a.name}</div>
                        <div className="flex items-center gap-1 text-[9px] text-text-secondary mt-0.5">
                          <span>{formatSize(a.size)}</span>
                          {a.width && <span>· {a.width}×{a.height}</span>}
                          <span className="ml-auto">使用 {a.usedCount}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="bg-bg border border-border rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-surface-high text-text-secondary text-[10px]">
                      <tr>
                        <th className="text-left px-2 py-1.5 w-10"></th>
                        <th className="text-left px-2 py-1.5">名称</th>
                        <th className="text-left px-2 py-1.5 w-16">类型</th>
                        <th className="text-left px-2 py-1.5 w-20">大小</th>
                        <th className="text-left px-2 py-1.5 w-16">使用</th>
                        <th className="text-left px-2 py-1.5 w-20">上传</th>
                        <th className="text-left px-2 py-1.5 w-32">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map(a => (
                        <tr key={a.id} onClick={() => setActiveId(a.id)} className={'border-t border-border-light hover:bg-surface-high cursor-pointer ' + (activeId === a.id ? 'bg-accent/10' : '')}>
                          <td className="px-2 py-1 text-2xl">{a.thumbnail}</td>
                          <td className="px-2 py-1 text-text truncate">{a.name}</td>
                          <td className="px-2 py-1"><Badge variant="info">{a.type}</Badge></td>
                          <td className="px-2 py-1 text-text-secondary">{formatSize(a.size)}</td>
                          <td className="px-2 py-1 text-text-secondary">{a.usedCount}</td>
                          <td className="px-2 py-1 text-text-secondary">{new Date(a.uploadedAt).toLocaleDateString()}</td>
                          <td className="px-2 py-1">
                            <IconButton icon="content_copy" size="xs" tooltip="复制 URL" onClick={(e) => { e.stopPropagation(); copyUrl(a); }} />
                            <IconButton icon="visibility" size="xs" tooltip="预览" onClick={(e) => { e.stopPropagation(); setActiveId(a.id); }} />
                            <IconButton icon="delete" size="xs" tooltip="删除" onClick={(e) => { e.stopPropagation(); del(a.id); }} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {active && (
              <div className="w-72 border-l border-border bg-bg p-3 space-y-2">
                <h3 className="text-xs font-semibold text-text">资源详情</h3>
                <div className="aspect-square bg-surface-high rounded-lg flex items-center justify-center text-6xl">
                  {active.thumbnail}
                </div>
                <div className="text-xs">
                  <div className="font-semibold text-text truncate">{active.name}</div>
                  <div className="text-[10px] text-text-secondary mt-1 space-y-0.5">
                    <div>类型: {active.type}</div>
                    <div>大小: {formatSize(active.size)}</div>
                    {active.width && <div>尺寸: {active.width}×{active.height}</div>}
                    <div>分类: {CATEGORIES.find(c => c.id === active.category)?.name}</div>
                    <div>使用: {active.usedCount} 次</div>
                    <div>上传: {active.uploadedBy}</div>
                    <div>时间: {new Date(active.uploadedAt).toLocaleString()}</div>
                  </div>
                </div>
                <div className="bg-surface border border-border-light rounded p-2">
                  <div className="text-[10px] text-text-secondary mb-0.5">URL</div>
                  <code className="text-[10px] font-mono text-text break-all">{active.url}</code>
                </div>
                <div className="flex gap-1">
                  {active.tags.map(t => <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent">#{t}</span>)}
                </div>
                <Button size="sm" icon="content_copy" block onClick={() => copyUrl(active)}>复制 URL</Button>
                <Button size="sm" icon="add" block variant="primary" onClick={() => { onPick?.(active); incUse(active.id); }}>插入</Button>
                <Button size="sm" icon="delete" block variant="danger" onClick={() => del(active.id)}>删除</Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
