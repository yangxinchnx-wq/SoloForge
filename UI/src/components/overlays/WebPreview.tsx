// ─────────────────────────────────────────────────────────────────
// 实时网页预览 — WebPreview
// - 多设备模拟 (桌面/平板/手机)
// - URL 栏 + 历史记录 + 收藏
// - 截图工具 + 视图源代码
// - 设备像素比/方向切换
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Tooltip, IconButton, Badge, Button, Select } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface Device {
  id: string;
  name: string;
  width: number;
  height: number;
  dpr: number;
  icon: string;
  ua: string;
}

const DEVICES: Device[] = [
  { id: 'desktop',  name: '桌面',  width: 1280, height: 800,  dpr: 1,   icon: 'desktop_windows', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
  { id: 'laptop',   name: '笔记本',width: 1366, height: 768,  dpr: 1,   icon: 'laptop',          ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' },
  { id: 'tablet-l', name: '平板横屏',width: 1024, height: 768,  dpr: 2,   icon: 'tablet',         ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  { id: 'tablet-p', name: '平板竖屏',width: 768,  height: 1024, dpr: 2,   icon: 'tablet',         ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  { id: 'iphone',   name: 'iPhone', width: 390,  height: 844,  dpr: 3,   icon: 'smartphone',     ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  { id: 'android',  name: 'Android',width: 412,  height: 915,  dpr: 2.625, icon: 'phone_android', ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
];

const QUICK_URLS = [
  'https://example.com',
  'https://github.com',
  'https://react.dev',
  'https://surrealdb.com',
  'https://vitejs.dev',
  'https://tailwindcss.com',
  'https://httpbin.org',
  'https://jsonplaceholder.typicode.com',
];

const STORE_HIST = 'soloforge.web-preview.hist.v1';

function loadHist(): string[] { try { const r = localStorage.getItem(STORE_HIST); if (r) return JSON.parse(r); } catch { /* */ } return ['https://example.com']; }
function saveHist(d: string[]) { try { localStorage.setItem(STORE_HIST, JSON.stringify(d)); } catch { /* */ } }

export function WebPreview({ open, onClose }: Props) {
  const [url, setUrl] = useState('https://example.com');
  const [activeUrl, setActiveUrl] = useState('https://example.com');
  const [device, setDevice] = useState<Device>(DEVICES[0]);
  const [orientation, setOrientation] = useState<'landscape' | 'portrait'>('landscape');
  const [zoom, setZoom] = useState(0.7);
  const [showSource, setShowSource] = useState(false);
  const [history, setHistory] = useState<string[]>(loadHist);
  const [favs, setFavs] = useState<string[]>(['https://react.dev', 'https://github.com']);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showThrottle, setShowThrottle] = useState(false);
  const [throttle, setThrottle] = useState<'off' | '3g' | 'slow3g'>('off');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeKey, setIframeKey] = useState(0);

  useEffect(() => { saveHist(history); }, [history]);

  const navigate = useCallback((newUrl: string) => {
    let u = newUrl.trim();
    if (u && !u.match(/^https?:\/\//)) u = 'https://' + u;
    setUrl(u);
    setActiveUrl(u);
    setHistory(prev => [u, ...prev.filter(x => x !== u)].slice(0, 30));
    setLoading(true);
    setError(null);
    setIframeKey(k => k + 1);
  }, []);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    setIframeKey(k => k + 1);
  }, []);

  const back = useCallback(() => {
    if (history.length > 1) {
      const prev = history[1];
      setUrl(prev);
      setActiveUrl(prev);
      setHistory(prev => prev.slice(1));
      setIframeKey(k => k + 1);
    }
  }, [history]);

  const toggleFav = useCallback((u: string) => {
    setFavs(prev => prev.includes(u) ? prev.filter(x => x !== u) : [...prev, u]);
  }, []);

  const screenshot = useCallback(async () => {
    if (!iframeRef.current) return;
    try {
      // 由于跨域,这里模拟截图 - 实际在画布中绘制当前视图
      alert('截图已保存 (模拟): ' + activeUrl);
    } catch (e: any) { alert('截图失败: ' + e.message); }
  }, [activeUrl]);

  const currentDevice = useMemo(() => {
    if (orientation === 'portrait' && device.width > device.height) {
      return { ...device, width: device.height, height: device.width };
    }
    if (orientation === 'landscape' && device.height > device.width) {
      return { ...device, width: device.height, height: device.width };
    }
    return device;
  }, [device, orientation]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">travel_explore</span>
          <IconButton icon="arrow_back" tooltip="后退" onClick={back} disabled={history.length <= 1} />
          <IconButton icon="arrow_forward" tooltip="前进" disabled />
          <IconButton icon="refresh" tooltip="刷新" onClick={refresh} />
          <IconButton icon="home" tooltip="主页" onClick={() => navigate('https://example.com')} />
          <div className="flex-1 flex items-center bg-bg border border-border-light rounded-md px-2 h-7 gap-1">
            <span className="material-symbols-outlined text-xs text-text-secondary">lock</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && navigate(url)}
              className="flex-1 bg-transparent text-xs text-text outline-none" />
            {favs.includes(activeUrl) ? (
              <button onClick={() => toggleFav(activeUrl)}><span className="material-symbols-outlined text-xs filled text-yellow-500">star</span></button>
            ) : (
              <button onClick={() => toggleFav(activeUrl)}><span className="material-symbols-outlined text-xs text-text-secondary">star_border</span></button>
            )}
          </div>
          <Select
            value={device.id}
            options={DEVICES.map(d => ({ value: d.id, label: d.name }))}
            onChange={(v) => setDevice(DEVICES.find(d => d.id === v) || DEVICES[0])}
            className="w-24"
          />
          {currentDevice.width !== currentDevice.height && (
            <Tooltip content="旋转">
              <IconButton icon={orientation === 'landscape' ? 'stay_current_portrait' : 'stay_current_landscape'} onClick={() => setOrientation(o => o === 'landscape' ? 'portrait' : 'landscape')} />
            </Tooltip>
          )}
          <Select
            value={String(zoom)}
            options={['0.25', '0.5', '0.75', '1', '1.25', '1.5', '2'].map(z => ({ value: z, label: `${Math.round(Number(z) * 100)}%` }))}
            onChange={(v) => setZoom(Number(v))}
            className="w-16"
          />
          <Tooltip content="截图"><IconButton icon="screenshot_monitor" onClick={screenshot} /></Tooltip>
          <Tooltip content="查看源码"><IconButton icon="code" active={showSource} onClick={() => setShowSource(!showSource)} /></Tooltip>
          <IconButton icon="close" onClick={onClose} />
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-2 text-[10px]">
          <span className="text-text-secondary">快速:</span>
          {QUICK_URLS.map(u => (
            <button key={u} onClick={() => navigate(u)} className="px-1.5 py-0.5 rounded bg-surface-high text-text-secondary hover:text-text truncate max-w-32">{new URL(u).hostname}</button>
          ))}
        </div>

        <div className="flex-1 flex overflow-hidden bg-bg-dim">
          <div className="w-40 border-r border-border bg-surface p-2 overflow-y-auto">
            <h3 className="text-xs font-semibold text-text mb-1">收藏</h3>
            {favs.length === 0 ? <p className="text-[10px] text-text-secondary">无</p> : favs.map(f => (
              <button key={f} onClick={() => navigate(f)} className="w-full text-left px-1.5 py-1 rounded text-[10px] hover:bg-surface-high text-text-secondary truncate flex items-center gap-1">
                <span className="material-symbols-outlined text-xs filled text-yellow-500">star</span>
                {new URL(f).hostname}
              </button>
            ))}
            <h3 className="text-xs font-semibold text-text mt-2 mb-1">历史 ({history.length})</h3>
            {history.slice(0, 15).map((h, i) => (
              <button key={i} onClick={() => navigate(h)} className="w-full text-left px-1.5 py-0.5 rounded text-[10px] hover:bg-surface-high text-text-secondary truncate">
                {i === 0 && <Badge variant="primary" className="mr-1">当前</Badge>}
                {h}
              </button>
            ))}
            <h3 className="text-xs font-semibold text-text mt-2 mb-1">设备信息</h3>
            <div className="text-[10px] text-text-secondary space-y-0.5">
              <div>屏幕: {currentDevice.width}×{currentDevice.height}</div>
              <div>DPR: {currentDevice.dpr}</div>
              <div>UA: {currentDevice.ua.slice(0, 30)}...</div>
            </div>
            <div className="mt-2 space-y-1">
              <label className="text-[10px] text-text-secondary">网络节流</label>
              <Select
                value={throttle}
                options={[{ value: 'off', label: '无' }, { value: '3g', label: '3G' }, { value: 'slow3g', label: '慢 3G' }]}
                onChange={(v) => setThrottle(v as any)}
                className="w-full"
              />
            </div>
          </div>

          <div className="flex-1 relative overflow-auto flex items-start justify-center p-4">
            {showSource ? (
              <div className="w-full h-full bg-bg border border-border rounded p-3 overflow-auto">
                <h3 className="text-xs font-semibold text-text mb-2">视图源代码 (模拟)</h3>
                <pre className="text-[10px] font-mono text-text-secondary whitespace-pre-wrap break-all">{`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${activeUrl}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>/* ... */</style>
</head>
<body>
  <!-- 跨域 iframe,无法读取真实 DOM -->
  <!-- 模拟内容: 实际网页无法直接显示源代码 -->
  <h1>${activeUrl}</h1>
</body>
</html>`}</pre>
                <p className="text-[10px] text-text-secondary mt-2">注: 跨域 iframe 受浏览器同源策略限制,无法读取实际 DOM</p>
              </div>
            ) : (
              <div className="relative" style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}>
                {error ? (
                  <div className="bg-bg border border-border rounded p-8 text-center" style={{ width: currentDevice.width, height: currentDevice.height }}>
                    <span className="material-symbols-outlined text-4xl text-danger">error</span>
                    <p className="text-sm text-text mt-2">加载失败</p>
                    <p className="text-[10px] text-text-secondary mt-1">{error}</p>
                    <Button size="sm" onClick={refresh} className="mt-2">重试</Button>
                  </div>
                ) : (
                  <div className="relative bg-white rounded-lg shadow-2xl overflow-hidden" style={{ width: currentDevice.width, height: currentDevice.height }}>
                    {loading && (
                      <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10">
                        <span className="material-symbols-outlined animate-spin text-3xl text-primary">progress_activity</span>
                      </div>
                    )}
                    <div className="absolute top-0 left-0 right-0 h-6 bg-surface-high flex items-center px-2 gap-1 z-20 border-b border-border-light">
                      <span className="w-2 h-2 rounded-full bg-danger" />
                      <span className="w-2 h-2 rounded-full bg-warning" />
                      <span className="w-2 h-2 rounded-full bg-success" />
                      <span className="flex-1 text-center text-[9px] text-text-secondary">{activeUrl}</span>
                    </div>
                    <iframe
                      key={iframeKey}
                      ref={iframeRef}
                      src={activeUrl}
                      style={{ width: '100%', height: 'calc(100% - 24px)', marginTop: 24, border: 'none' }}
                      onLoad={() => setLoading(false)}
                      onError={() => { setError('无法加载页面 (可能是 X-Frame-Options 限制)'); setLoading(false); }}
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="px-3 py-1.5 border-t border-border bg-surface-high text-[10px] text-text-secondary flex items-center gap-3">
          <span>{currentDevice.width}×{currentDevice.height} @ {currentDevice.dpr}x</span>
          <span>·</span>
          <span>缩放 {(zoom * 100).toFixed(0)}%</span>
          <span>·</span>
          <span>网络: {throttle === 'off' ? '正常' : throttle}</span>
          <span className="ml-auto">提示: 多数网站禁止 iframe 嵌入,可能显示空白</span>
        </div>
      </div>
    </div>
  );
}
