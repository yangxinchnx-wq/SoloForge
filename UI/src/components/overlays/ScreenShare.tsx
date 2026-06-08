// ─────────────────────────────────────────────────────────────────
// 屏幕共享接收端 — ScreenShare
// - getDisplayMedia 屏幕捕获演示
// - 视频流预览 / 帧捕获 / 标注绘制
// - 录制状态管理
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Annotation {
  id: string;
  type: 'arrow' | 'rect' | 'circle' | 'text';
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  text?: string;
}

const STORAGE_KEY = 'soloforge.screen.annotations.v1';

function loadAnnotations(): Annotation[] {
  try {
    const r = localStorage.getItem(STORAGE_KEY);
    if (r) return JSON.parse(r);
  } catch { /* ignore */ }
  return [];
}
function saveAnnotations(arr: Annotation[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr)); } catch { /* ignore */ }
}

export function ScreenShare({ open, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [recording, setRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [fps, setFps] = useState(0);
  const [frames, setFrames] = useState(0);
  const [annotations, setAnnotations] = useState<Annotation[]>(loadAnnotations);
  const [tool, setTool] = useState<'arrow' | 'rect' | 'circle' | 'text'>('arrow');
  const [color, setColor] = useState('#ef4444');
  const [drawing, setDrawing] = useState<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  const [textInput, setTextInput] = useState<{ x: number; y: number; v: string } | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const fpsRef = useRef({ frames: 0, last: Date.now() });
  const timerRef = useRef<number | null>(null);

  useEffect(() => { saveAnnotations(annotations); }, [annotations]);

  const startShare = useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
      });
      setStream(s);
      setSize({ w: s.getVideoTracks()[0].getSettings().width || 0, h: s.getVideoTracks()[0].getSettings().height || 0 });
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        videoRef.current.play();
      }
      // 结束分享
      s.getVideoTracks()[0].onended = () => stopShare();
      // FPS 测量
      const v = videoRef.current;
      if (v) {
        let lastFrameTime = 0;
        const measure = (now: number) => {
          if (lastFrameTime) {
            const dt = now - lastFrameTime;
            if (dt > 0) {
              const instFps = 1000 / dt;
              fpsRef.current.frames++;
              const elapsed = Date.now() - fpsRef.current.last;
              if (elapsed >= 1000) {
                setFps(Math.round((fpsRef.current.frames * 1000) / elapsed));
                setFrames(f => f + fpsRef.current.frames);
                fpsRef.current = { frames: 0, last: Date.now() };
              }
            }
          }
          lastFrameTime = now;
          if (videoRef.current) requestAnimationFrame(measure);
        };
        requestAnimationFrame(measure);
      }
    } catch (e: any) {
      if (e?.name !== 'NotAllowedError') alert('屏幕共享失败: ' + (e?.message || e));
    }
  }, []);

  const stopShare = useCallback(() => {
    stream?.getTracks().forEach(t => t.stop());
    setStream(null);
    setFps(0);
    setDuration(0);
    setRecording(false);
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, [stream]);

  // 录制
  const startRecording = useCallback(() => {
    if (!stream) return;
    recordedChunksRef.current = [];
    const mr = new MediaRecorder(stream);
    mediaRecorderRef.current = mr;
    mr.ondataavailable = (e) => { if (e.data.size > 0) recordedChunksRef.current.push(e.data); };
    mr.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `recording-${Date.now()}.webm`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    mr.start();
    setRecording(true);
    const start = Date.now();
    timerRef.current = window.setInterval(() => {
      setDuration(Math.floor((Date.now() - start) / 1000));
    }, 250);
  }, [stream]);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  // 截图
  const captureFrame = useCallback(() => {
    if (!videoRef.current) return;
    const v = videoRef.current;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(v, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `frame-${Date.now()}.png`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }, []);

  // 标注绘制
  const getPos = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!stream) return;
    const p = getPos(e);
    if (tool === 'text') {
      setTextInput({ x: p.x, y: p.y, v: '' });
      return;
    }
    if (tool === 'arrow' || tool === 'rect' || tool === 'circle') {
      setDrawing({ sx: p.x, sy: p.y, cx: p.x, cy: p.y });
    }
  }, [stream, tool]);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!drawing) return;
    const p = getPos(e);
    setDrawing(d => d ? { ...d, cx: p.x, cy: p.y } : null);
  }, [drawing]);

  const onMouseUp = useCallback(() => {
    if (!drawing) return;
    const id = 'a_' + Date.now().toString(36);
    setAnnotations(prev => [...prev, {
      id,
      type: tool,
      x: Math.min(drawing.sx, drawing.cx),
      y: Math.min(drawing.sy, drawing.cy),
      w: Math.abs(drawing.cx - drawing.sx),
      h: Math.abs(drawing.cy - drawing.sy),
      color,
    }]);
    setDrawing(null);
  }, [drawing, tool, color]);

  const removeAnnotation = (id: string) => setAnnotations(prev => prev.filter(a => a.id !== id));
  const clearAnnotations = () => { if (confirm('清空所有标注?')) setAnnotations([]); };

  const submitText = useCallback(() => {
    if (!textInput) return;
    setAnnotations(prev => [...prev, {
      id: 'a_' + Date.now().toString(36),
      type: 'text',
      x: textInput.x,
      y: textInput.y,
      w: 100, h: 20,
      color,
      text: textInput.v || '文字',
    }]);
    setTextInput(null);
  }, [textInput, color]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">desktop_windows</span>
          <h2 className="text-sm font-semibold text-text">屏幕共享</h2>
          <Badge variant={stream ? 'success' : 'default'} dot pulse={!!stream}>
            {stream ? '已连接' : '未连接'}
          </Badge>
          {stream && (
            <>
              <span className="text-xs text-text-secondary">{size.w}×{size.h} · {fps} FPS</span>
              {recording && <Badge variant="danger" dot pulse>REC {Math.floor(duration / 60).toString().padStart(2, '0')}:{(duration % 60).toString().padStart(2, '0')}</Badge>}
            </>
          )}
          <div className="ml-auto flex items-center gap-1">
            {!stream ? (
              <Button variant="primary" size="sm" icon="play_arrow" onClick={startShare}>开始共享</Button>
            ) : (
              <>
                {!recording ? (
                  <Button variant="danger" size="sm" icon="fiber_manual_record" onClick={startRecording}>录制</Button>
                ) : (
                  <Button variant="secondary" size="sm" icon="stop" onClick={stopRecording}>停止录制</Button>
                )}
                <Tooltip content="截图"><IconButton icon="screenshot" onClick={captureFrame} /></Tooltip>
                <Tooltip content="停止共享"><IconButton icon="stop_screen_share" onClick={stopShare} /></Tooltip>
              </>
            )}
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* 视频区 */}
          <div className="flex-1 bg-black flex items-center justify-center p-2 relative">
            {!stream ? (
              <div className="text-center text-text-secondary">
                <span className="material-symbols-outlined text-6xl opacity-30">desktop_windows</span>
                <p className="mt-3 text-sm">点击「开始共享」选择屏幕/窗口/标签页</p>
                <p className="text-[10px] mt-1 text-text-secondary/70">演示模式,需要用户授权屏幕访问</p>
              </div>
            ) : (
              <div className="relative inline-block max-w-full max-h-full">
                <video
                  ref={videoRef}
                  className="max-w-full max-h-[70vh] block"
                  muted
                />
                {/* 标注画布 */}
                <div
                  className="absolute inset-0 cursor-crosshair"
                  onMouseDown={onMouseDown}
                  onMouseMove={onMouseMove}
                  onMouseUp={onMouseUp}
                  onMouseLeave={() => setDrawing(null)}
                >
                  <svg className="absolute inset-0 w-full h-full pointer-events-none">
                    {annotations.map(a => {
                      if (a.type === 'rect') {
                        return <rect key={a.id} x={a.x} y={a.y} width={a.w} height={a.h} stroke={a.color} strokeWidth={2} fill="none" />;
                      }
                      if (a.type === 'circle') {
                        return <ellipse key={a.id} cx={a.x + a.w/2} cy={a.y + a.h/2} rx={a.w/2} ry={a.h/2} stroke={a.color} strokeWidth={2} fill="none" />;
                      }
                      return null;
                    })}
                    {drawing && tool === 'rect' && <rect x={Math.min(drawing.sx, drawing.cx)} y={Math.min(drawing.sy, drawing.cy)} width={Math.abs(drawing.cx - drawing.sx)} height={Math.abs(drawing.cy - drawing.sy)} stroke={color} strokeWidth={2} fill="none" strokeDasharray="4 2" />}
                    {drawing && tool === 'circle' && <ellipse cx={(drawing.sx + drawing.cx)/2} cy={(drawing.sy + drawing.cy)/2} rx={Math.abs(drawing.cx - drawing.sx)/2} ry={Math.abs(drawing.cy - drawing.sy)/2} stroke={color} strokeWidth={2} fill="none" strokeDasharray="4 2" />}
                  </svg>
                  {annotations.map(a => a.type === 'arrow' && (
                    <div
                      key={a.id}
                      className="absolute pointer-events-auto group"
                      style={{ left: a.x, top: a.y, width: a.w, height: a.h }}
                    >
                      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-full">
                        <line x1="0" y1="0" x2="100" y2="100" stroke={a.color} strokeWidth="3" markerEnd="url(#arrowhead)" />
                        <defs>
                          <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="5" refY="3" orient="auto">
                            <path d="M0,0 L0,6 L6,3 z" fill={a.color} />
                          </marker>
                        </defs>
                      </svg>
                      <button onClick={() => removeAnnotation(a.id)} className="absolute -top-2 -right-2 w-4 h-4 rounded-full bg-danger text-white text-[10px] opacity-0 group-hover:opacity-100">×</button>
                    </div>
                  ))}
                  {annotations.map(a => a.type === 'text' && a.text && (
                    <div
                      key={a.id}
                      className="absolute pointer-events-auto group px-1 rounded"
                      style={{ left: a.x, top: a.y, color: a.color, fontWeight: 600, textShadow: '0 0 3px black' }}
                    >
                      {a.text}
                      <button onClick={() => removeAnnotation(a.id)} className="ml-1 text-danger opacity-0 group-hover:opacity-100">×</button>
                    </div>
                  ))}
                  {textInput && (
                    <div className="absolute" style={{ left: textInput.x, top: textInput.y }}>
                      <input
                        autoFocus
                        value={textInput.v}
                        onChange={(e) => setTextInput({ ...textInput, v: e.target.value })}
                        onBlur={submitText}
                        onKeyDown={(e) => e.key === 'Enter' && submitText()}
                        className="bg-black/50 border border-white/30 rounded px-1 text-sm"
                        style={{ color }}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 工具栏 */}
          {stream && (
            <div className="w-56 border-l border-border p-3 space-y-3 overflow-y-auto">
              <div>
                <h3 className="text-xs font-semibold text-text mb-1.5">标注工具</h3>
                <div className="grid grid-cols-4 gap-1">
                  {([
                    { id: 'arrow',  icon: 'arrow_forward' },
                    { id: 'rect',   icon: 'crop_square' },
                    { id: 'circle', icon: 'circle' },
                    { id: 'text',   icon: 'text_fields' },
                  ] as const).map(t => (
                    <button
                      key={t.id}
                      onClick={() => setTool(t.id as any)}
                      className={'p-2 rounded text-xs flex items-center justify-center ' + (tool === t.id ? 'bg-accent/15 text-accent ring-1 ring-accent' : 'bg-bg text-text-secondary hover:bg-surface-high')}
                    >
                      <span className="material-symbols-outlined text-base">{t.icon}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <h3 className="text-xs font-semibold text-text mb-1.5">颜色</h3>
                <div className="grid grid-cols-6 gap-1">
                  {['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#ffffff', '#000000'].map(c => (
                    <button
                      key={c}
                      onClick={() => setColor(c)}
                      className={'w-6 h-6 rounded border-2 ' + (color === c ? 'border-accent scale-110' : 'border-border')}
                      style={{ background: c }}
                    />
                  ))}
                </div>
              </div>
              <div>
                <h3 className="text-xs font-semibold text-text mb-1.5">统计</h3>
                <div className="text-[11px] text-text-secondary space-y-0.5">
                  <div>帧数 <span className="font-mono text-text">{frames}</span></div>
                  <div>实时 FPS <span className="font-mono text-text">{fps}</span></div>
                  <div>标注数 <span className="font-mono text-text">{annotations.length}</span></div>
                  <div>分辨率 <span className="font-mono text-text">{size.w}×{size.h}</span></div>
                </div>
              </div>
              <div>
                <Button variant="ghost" size="sm" icon="delete" block onClick={clearAnnotations}>清空标注</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
