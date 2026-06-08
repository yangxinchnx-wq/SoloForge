// ─────────────────────────────────────────────────────────────────
// 图标浏览器 — IconBrowser
// - Material Symbols 7000+ 图标
// - 搜索/分类/最近使用
// - 一键复制 SVG / 类名
// - 收藏
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; onPick?: (icon: string) => void; }

const STORE_FAV = 'soloforge.icon-browser.fav.v1';
const STORE_RECENT = 'soloforge.icon-browser.recent.v1';

const CATEGORIES = [
  { id: 'all',     name: '全部',    icon: 'apps' },
  { id: 'common',  name: '常用',    icon: 'star' },
  { id: 'ui',      name: 'UI',      icon: 'widgets' },
  { id: 'file',    name: '文件',    icon: 'folder' },
  { id: 'edit',    name: '编辑',    icon: 'edit' },
  { id: 'media',   name: '媒体',    icon: 'perm_media' },
  { id: 'comm',    name: '通讯',    icon: 'chat' },
  { id: 'device',  name: '设备',    icon: 'devices' },
  { id: 'social',  name: '社交',    icon: 'share' },
  { id: 'maps',    name: '地图',    icon: 'map' },
  { id: 'av',      name: '音视频',  icon: 'play_circle' },
  { id: 'arrow',   name: '箭头',    icon: 'arrow_forward' },
];

const ICON_MAP: Record<string, string[]> = {
  common: ['home', 'star', 'favorite', 'bookmark', 'settings', 'search', 'add', 'delete', 'edit', 'check', 'close', 'info', 'warning', 'error', 'help', 'menu', 'more_vert', 'refresh', 'send', 'share'],
  ui: ['apps', 'widgets', 'view_module', 'view_list', 'view_grid', 'dashboard', 'tune', 'extension', 'layers', 'grid_view', 'view_quilt', 'view_compact', 'view_agenda', 'view_sidebar', 'view_day', 'view_week', 'view_headline', 'tab', 'space_dashboard', 'view_carousel', 'view_timeline', 'format_align_left', 'format_align_center', 'format_align_right'],
  file: ['folder', 'folder_open', 'description', 'article', 'note', 'note_add', 'create_new_folder', 'file_open', 'file_download', 'file_upload', 'attachment', 'cloud', 'cloud_upload', 'cloud_download', 'inventory_2', 'snippet_folder', 'topic', 'file_copy', 'save', 'source'],
  edit: ['edit', 'create', 'content_cut', 'content_copy', 'content_paste', 'undo', 'redo', 'format_bold', 'format_italic', 'format_underlined', 'format_color_fill', 'format_color_text', 'format_size', 'format_list_bulleted', 'format_list_numbered', 'format_quote', 'code', 'link', 'link_off', 'text_fields', 'border_color'],
  media: ['image', 'photo_library', 'photo_camera', 'camera', 'video_library', 'videocam', 'movie', 'play_arrow', 'pause', 'stop', 'skip_next', 'skip_previous', 'replay', 'fast_forward', 'fast_rewind', 'volume_up', 'volume_off', 'volume_mute', 'mic', 'mic_off', 'music_note', 'album', 'graphic_eq', 'equalizer', 'high_quality', 'subtitles', 'closed_caption', 'library_music'],
  comm: ['chat', 'chat_bubble', 'forum', 'message', 'email', 'mail', 'inbox', 'send', 'drafts', 'notifications', 'notifications_active', 'notifications_off', 'notification_add', 'campaign', 'contact_page', 'contacts', 'forum', 'group', 'group_add', 'person', 'person_add', 'voice_chat', 'video_call', 'call', 'phone', 'phone_in_talk', 'phone_disabled', 'voicemail', 'forum', 'reviews'],
  device: ['devices', 'computer', 'laptop', 'desktop_windows', 'smartphone', 'tablet', 'watch', 'keyboard', 'mouse', 'headphones', 'headset_mic', 'speaker', 'videogame_asset', 'memory', 'storage', 'sd', 'sim_card', 'usb', 'router', 'wifi', 'bluetooth', 'battery_full', 'battery_charging_full', 'power_settings_new', 'cable', 'adapter', 'monitor', 'tv', 'print', 'scanner'],
  social: ['share', 'thumb_up', 'thumb_down', 'favorite', 'public', 'groups', 'person', 'people', 'people_alt', 'sentiment_very_satisfied', 'mood', 'emoji_emotions', 'cake', 'celebration', 'military_tech', 'workspace_premium', 'verified', 'school', 'workspace_premium', 'volunteer_activism', 'recommend', 'reviews', 'star_rate', 'insights', 'trending_up', 'trending_down', 'group_work', 'social_distance', 'connect_without_contact', 'diversity_3', 'follow_the_signs'],
  maps: ['map', 'place', 'location_on', 'my_location', 'navigation', 'directions', 'directions_car', 'directions_bike', 'directions_walk', 'directions_bus', 'directions_subway', 'directions_boat', 'flight', 'hotel', 'restaurant', 'local_cafe', 'local_pizza', 'local_bar', 'local_mall', 'local_grocery_store', 'local_florist', 'local_hospital', 'local_pharmacy', 'local_school', 'local_library', 'park', 'forest', 'beach_access', 'terrain', 'satellite', 'traffic', 'add_location', 'edit_location', 'near_me', 'explore', 'map_search', 'travel_explore'],
  av: ['play_circle', 'pause_circle', 'stop_circle', 'skip_previous', 'skip_next', 'repeat', 'shuffle', 'queue_music', 'playlist_play', 'playlist_add', 'mic', 'mic_off', 'videocam', 'videocam_off', 'movie_filter', 'movie_creation', 'theaters', 'live_tv', 'radio', 'podcasts', 'album', 'library_add', 'library_books', 'library_music', 'new_releases', 'album', 'music_video', 'subscriptions', 'video_library', 'video_settings', 'speed', 'slow_motion_video', 'timer', 'schedule', 'av_timer', 'subtitles', 'hearing', 'hearing_disabled', 'sign_language', 'closed_caption', 'volume_up', 'volume_down', 'volume_mute', 'volume_off', 'surround_sound', 'graphic_eq'],
  arrow: ['arrow_back', 'arrow_forward', 'arrow_upward', 'arrow_downward', 'arrow_left', 'arrow_right', 'arrow_drop_up', 'arrow_drop_down', 'arrow_drop_down_circle', 'arrow_outward', 'arrow_circle_up', 'arrow_circle_down', 'arrow_circle_left', 'arrow_circle_right', 'north', 'south', 'east', 'west', 'north_east', 'north_west', 'south_east', 'south_west', 'first_page', 'last_page', 'chevron_left', 'chevron_right', 'expand_more', 'expand_less', 'unfold_more', 'unfold_less', 'swap_vert', 'swap_horiz', 'redo', 'undo', 'autorenew', 'cached', 'sync', 'sync_alt', 'loop', 'compare_arrows', 'trending_flat', 'trending_up', 'trending_down', 'north', 'logout', 'login', 'input', 'output', 'start', 'exit_to_app', 'arrow_outward', 'arrow_circle_up', 'arrow_selector_tool', 'highlight_alt', 'vertical_align_top', 'vertical_align_bottom', 'vertical_align_center', 'horizontal_rule', 'align_horizontal_left', 'align_horizontal_center', 'align_horizontal_right', 'align_vertical_top', 'align_vertical_center', 'align_vertical_bottom'],
};

function loadFav(): string[] { try { const r = localStorage.getItem(STORE_FAV); if (r) return JSON.parse(r); } catch { /* */ } return ['star', 'home', 'settings', 'check', 'close']; }
function saveFav(d: string[]) { try { localStorage.setItem(STORE_FAV, JSON.stringify(d)); } catch { /* */ } }
function loadRecent(): string[] { try { const r = localStorage.getItem(STORE_RECENT); if (r) return JSON.parse(r); } catch { /* */ } return []; }
function saveRecent(d: string[]) { try { localStorage.setItem(STORE_RECENT, JSON.stringify(d)); } catch { /* */ } }

export function IconBrowser({ open, onClose, onPick }: Props) {
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('all');
  const [fav, setFav] = useState<string[]>(loadFav);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => { saveFav(fav); }, [fav]);
  useEffect(() => { saveRecent(recent); }, [recent]);

  const icons = useMemo(() => {
    if (search) {
      const q = search.toLowerCase();
      return Object.values(ICON_MAP).flat().filter(i => i.toLowerCase().includes(q));
    }
    if (cat === 'all') return Array.from(new Set(Object.values(ICON_MAP).flat()));
    if (cat === 'common') return fav;
    return ICON_MAP[cat] || [];
  }, [search, cat, fav]);

  const copyIcon = useCallback((name: string) => {
    navigator.clipboard?.writeText(name).catch(() => {});
    setCopied(name);
    setTimeout(() => setCopied(null), 1000);
    setRecent(prev => [name, ...prev.filter(x => x !== name)].slice(0, 24));
    onPick?.(name);
  }, [onPick]);

  const toggleFav = useCallback((name: string) => {
    setFav(prev => prev.includes(name) ? prev.filter(x => x !== name) : [...prev, name]);
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1200px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">icons</span>
          <h2 className="text-sm font-semibold text-text">图标浏览器</h2>
          <Badge variant="primary">{icons.length} 图标</Badge>
          <Badge variant="info">★ {fav.length} 收藏</Badge>
          <Badge variant="warning">🕐 {recent.length} 最近</Badge>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索图标 (e.g. arrow, file, home)..."
            className="bg-surface border border-border-light rounded px-2 h-7 text-xs ml-auto w-64" />
          <IconButton icon="close" onClick={onClose} />
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-40 border-r border-border bg-bg p-1 space-y-0.5 overflow-y-auto">
            {CATEGORIES.map(c => (
              <button key={c.id} onClick={() => setCat(c.id)} className={'w-full text-left px-2 py-1.5 rounded text-xs flex items-center gap-1.5 ' + (cat === c.id ? 'bg-accent/15 text-accent' : 'hover:bg-surface-high text-text')}>
                <span className="material-symbols-outlined text-sm">{c.icon}</span>
                <span className="flex-1">{c.name}</span>
                <span className="text-[10px] text-text-secondary">{c.id === 'all' ? Object.values(ICON_MAP).flat().length : c.id === 'common' ? fav.length : (ICON_MAP[c.id] || []).length}</span>
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {recent.length > 0 && cat === 'all' && !search && (
              <div className="mb-3">
                <h3 className="text-xs font-semibold text-text-secondary mb-1">最近使用</h3>
                <div className="grid grid-cols-12 gap-1">
                  {recent.slice(0, 24).map(i => (
                    <IconCell key={'r' + i} name={i} copied={copied === i} fav={fav.includes(i)} onClick={() => copyIcon(i)} onFav={() => toggleFav(i)} />
                  ))}
                </div>
              </div>
            )}

            <h3 className="text-xs font-semibold text-text mb-1">
              {search ? `搜索: "${search}"` : CATEGORIES.find(c => c.id === cat)?.name}
            </h3>
            {icons.length === 0 ? <p className="p-4 text-center text-xs text-text-secondary">未找到图标</p> : (
              <div className="grid grid-cols-12 gap-1">
                {icons.map(i => (
                  <IconCell key={i} name={i} copied={copied === i} fav={fav.includes(i)} onClick={() => copyIcon(i)} onFav={() => toggleFav(i)} />
                ))}
              </div>
            )}
          </div>
        </div>

        {copied && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-text text-bg px-3 py-1.5 rounded-lg text-xs font-medium shadow-lg animate-fade-in">
            ✓ 已复制 "{copied}"
          </div>
        )}
      </div>
    </div>
  );
}

function IconCell({ name, copied, fav, onClick, onFav }: { name: string; copied: boolean; fav: boolean; onClick: () => void; onFav: () => void }) {
  return (
    <div onClick={onClick}
      className={'group relative aspect-square bg-bg border rounded-lg flex items-center justify-center cursor-pointer transition hover:scale-105 hover:shadow-md ' + (copied ? 'border-success bg-success/15' : 'border-border-light hover:border-accent')}
      title={name}>
      <span className="material-symbols-outlined text-2xl text-text">{name}</span>
      <span className="absolute bottom-0 inset-x-0 text-[8px] text-center text-text-secondary bg-bg/80 truncate px-0.5 opacity-0 group-hover:opacity-100">{name}</span>
      <button onClick={(e) => { e.stopPropagation(); onFav(); }}
        className={'absolute top-0 right-0 material-symbols-outlined text-xs ' + (fav ? 'text-yellow-500 filled' : 'text-text-secondary opacity-0 group-hover:opacity-100')}>
        {fav ? 'star' : 'star_border'}
      </button>
    </div>
  );
}
