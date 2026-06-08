// ─────────────────────────────────────────────────────────────────
// 语音对话 — VoiceChat
// - 浏览器 Web Speech API 封装
// - 录音波形可视化
// - 语音转文字 + 文字转语音
// - 多语言识别
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
  onSend?: (text: string) => void;
}

interface Transcript {
  id: string;
  text: string;
  ts: number;
  confidence: number;
  lang: string;
  final: boolean;
}

const LANGS = [
  { code: 'zh-CN', label: '中文 (简体)' },
  { code: 'zh-TW', label: '中文 (繁体)' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'ja-JP', label: '日本語' },
  { code: 'ko-KR', label: '한국어' },
  { code: 'fr-FR', label: 'Français' },
  { code: 'de-DE', label: 'Deutsch' },
  { code: 'es-ES', label: 'Español' },
];

const SAMPLE_VOICES = [
  { name: '晓晓 (女声·中)', rate: 1.0, pitch: 1.0, lang: 'zh-CN' },
  { name: '云希 (男声·中)', rate: 1.0, pitch: 0.8, lang: 'zh-CN' },
  { name: 'Samantha (女声·英)', rate: 1.0, pitch: 1.0, lang: 'en-US' },
  { name: 'Daniel (男声·英)', rate: 0.95, pitch: 0.9, lang: 'en-GB' },
];

const STORAGE_KEY = 'soloforge.voice.history.v1';

function loadHistory(): Transcript[] {
  try {
    const r = localStorage.getItem(STORAGE_KEY);
    if (r) return JSON.parse(r);
  } catch { /* ignore */ }
  return [];
}
function saveHistory(arr: Transcript[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr.slice(-200))); } catch { /* ignore */ }
}

export function VoiceChat({ open, onClose, onSend }: Props) {
  const [lang, setLang] = useState('zh-CN');
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [transcripts, setTranscripts] = useState<Transcript[]>(loadHistory);
  const [current, setCurrent] = useState('');
  const [interim, setInterim] = useState('');
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [voiceRate, setVoiceRate] = useState(1.0);
  const [voicePitch, setVoicePitch] = useState(1.0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [permission, setPermission] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [ttsInput, setTtsInput] = useState('');
  const recognitionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animFrameRef = useRef<number>(0);

  useEffect(() => { saveHistory(transcripts); }, [transcripts]);

  // 初始化识别器
  const initRecognition = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = lang;
    r.onresult = (e: any) => {
      let interimT = '';
      let finalT = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalT += t;
        else interimT += t;
      }
      if (finalT) {
        const tr: Transcript = {
          id: 'tr_' + Date.now().toString(36),
          text: finalT,
          ts: Date.now(),
          confidence: e.results[e.results.length - 1][0].confidence,
          lang,
          final: true,
        };
        setTranscripts(prev => [...prev, tr]);
        setCurrent('');
        onSend?.(finalT);
      }
      setInterim(interimT);
      if (interimT) setCurrent(interimT);
    };
    r.onerror = (e: any) => {
      console.warn('Speech error', e);
      if (e.error === 'not-allowed') setPermission('denied');
    };
    r.onend = () => setListening(false);
    return r;
  }, [lang, onSend]);

  // 音频电平监测
  const startMeter = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setPermission('granted');
      const ctx = new AudioContext();
      audioContextRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const sum = data.reduce((a, b) => a + b, 0);
        const level = sum / data.length / 255;
        setAudioLevel(level);
        animFrameRef.current = requestAnimationFrame(tick);
      };
      tick();
      return stream;
    } catch (e: any) {
      setPermission('denied');
      return null;
    }
  }, []);

  const startListening = useCallback(async () => {
    const r = initRecognition();
    if (!r) { alert('浏览器不支持 SpeechRecognition API'); return; }
    recognitionRef.current = r;
    const stream = await startMeter();
    if (stream) {
      // 通知 SpeechRecognition 用这个流 (实际 API 不需要, 内部会用麦克风)
      stream.getTracks().forEach(t => t.stop()); // 关闭因为 SR 会自己请求
    }
    try {
      r.start();
      setListening(true);
    } catch { /* ignore */ }
  }, [initRecognition, startMeter]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
    setAudioLevel(0);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    audioContextRef.current?.close().catch(() => {});
  }, []);

  const speak = useCallback((text: string) => {
    if (!text) return;
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = lang;
    utt.rate = voiceRate;
    utt.pitch = voicePitch;
    utt.onstart = () => setSpeaking(true);
    utt.onend = () => setSpeaking(false);
    utt.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utt);
  }, [lang, voiceRate, voicePitch]);

  const stopSpeak = useCallback(() => {
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const clearHistory = useCallback(() => {
    if (confirm('清空所有语音历史?')) setTranscripts([]);
  }, []);

  const exportSrt = useCallback(() => {
    const lines = transcripts.map((t, i) =>
      `${i + 1}\n${new Date(t.ts).toISOString().slice(11, 19)},000 --> ${new Date(t.ts + 2000).toISOString().slice(11, 19)},000\n${t.text}\n`
    );
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'voice-transcripts.srt'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [transcripts]);

  if (!open) return null;

  // 波形条
  const bars = 24;
  const waveBars = Array.from({ length: bars }, (_, i) => {
    const t = (i / bars) * Math.PI * 2;
    const base = 0.3 + Math.abs(Math.sin(t)) * 0.7;
    const live = listening ? base * (0.4 + audioLevel * 1.2) : 0.1;
    return live;
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-[900px] max-w-[95vw] h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">mic</span>
          <h2 className="text-sm font-semibold text-text">语音对话</h2>
          <Badge variant={listening ? 'danger' : 'default'} dot pulse={listening}>
            {listening ? '录音中' : speaking ? '播放中' : '待机'}
          </Badge>
          <span className="text-xs text-text-secondary">
            权限: {permission === 'granted' ? '✓ 已授权' : permission === 'denied' ? '✗ 拒绝' : '未请求'}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <select value={lang} onChange={(e) => setLang(e.target.value)}
              className="bg-bg border border-border-light rounded px-2 h-7 text-xs text-text">
              {LANGS.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
            <Tooltip content="导出 SRT"><IconButton icon="download" onClick={exportSrt} /></Tooltip>
            <Tooltip content="清空"><IconButton icon="delete" onClick={clearHistory} /></Tooltip>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="flex-1 flex flex-col overflow-hidden p-4 space-y-3">
          {/* 录音可视化区 */}
          <div className="bg-bg border border-border rounded-xl p-4 flex flex-col items-center gap-3">
            <div className="flex items-end gap-1 h-24">
              {waveBars.map((v, i) => (
                <div
                  key={i}
                  className={'w-2 rounded-full transition-all ' + (listening ? 'bg-accent' : speaking ? 'bg-success' : 'bg-text-secondary/30')}
                  style={{ height: `${Math.max(4, v * 96)}px` }}
                />
              ))}
            </div>
            <div className="flex items-center gap-3">
              {!listening ? (
                <button
                  onClick={startListening}
                  className="w-16 h-16 rounded-full bg-primary text-on-primary hover:opacity-90 transition flex items-center justify-center shadow-lg"
                >
                  <span className="material-symbols-outlined text-3xl">mic</span>
                </button>
              ) : (
                <button
                  onClick={stopListening}
                  className="w-16 h-16 rounded-full bg-danger text-white hover:opacity-90 transition flex items-center justify-center shadow-lg animate-pulse"
                >
                  <span className="material-symbols-outlined text-3xl">stop</span>
                </button>
              )}
              {speaking && (
                <button
                  onClick={stopSpeak}
                  className="w-12 h-12 rounded-full bg-surface-high text-text hover:bg-border-light transition flex items-center justify-center"
                >
                  <span className="material-symbols-outlined text-xl">volume_off</span>
                </button>
              )}
            </div>
            <div className="text-xs text-text-secondary min-h-[1.5em] text-center max-w-full">
              {interim || current || (listening ? '请开始说话...' : speaking ? '正在播放...' : '点击麦克风开始')}
            </div>
          </div>

          {/* 语音参数 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-bg border border-border rounded-lg p-3">
              <h3 className="text-xs font-semibold text-text mb-2">识别语言</h3>
              <div className="grid grid-cols-2 gap-1.5">
                {LANGS.slice(0, 6).map(l => (
                  <button
                    key={l.code}
                    onClick={() => setLang(l.code)}
                    className={'px-2 h-6 rounded text-[10px] border ' + (lang === l.code ? 'bg-accent/15 text-accent border-accent/30' : 'border-border text-text-secondary')}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="bg-bg border border-border rounded-lg p-3">
              <h3 className="text-xs font-semibold text-text mb-2">合成参数</h3>
              <div className="space-y-1.5 text-[11px]">
                <div className="flex items-center gap-2">
                  <span className="text-text-secondary w-12">语速</span>
                  <input type="range" min={0.5} max={2} step={0.1} value={voiceRate} onChange={(e) => setVoiceRate(+e.target.value)} className="flex-1" />
                  <span className="text-text font-mono w-10 text-right">{voiceRate.toFixed(1)}x</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-text-secondary w-12">音调</span>
                  <input type="range" min={0.5} max={2} step={0.1} value={voicePitch} onChange={(e) => setVoicePitch(+e.target.value)} className="flex-1" />
                  <span className="text-text font-mono w-10 text-right">{voicePitch.toFixed(1)}</span>
                </div>
                <label className="flex items-center gap-1.5 text-text-secondary cursor-pointer pt-1">
                  <input type="checkbox" checked={autoSpeak} onChange={(e) => setAutoSpeak(e.target.checked)} className="accent-accent" />
                  收到回复自动朗读
                </label>
              </div>
            </div>
          </div>

          {/* TTS 输入 */}
          <div className="bg-bg border border-border rounded-lg p-3">
            <h3 className="text-xs font-semibold text-text mb-2">文字转语音 (TTS)</h3>
            <div className="flex gap-2">
              <input
                value={ttsInput}
                onChange={(e) => setTtsInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && speak(ttsInput)}
                placeholder="输入文字,按 Enter 朗读..."
                className="flex-1 bg-surface border border-border-light rounded px-2 h-7 text-xs text-text"
              />
              <Button size="sm" icon="volume_up" onClick={() => speak(ttsInput)}>朗读</Button>
              <Button size="sm" variant="secondary" icon="stop" onClick={stopSpeak}>停止</Button>
            </div>
          </div>

          {/* 历史 */}
          <div className="bg-bg border border-border rounded-lg flex-1 flex flex-col overflow-hidden">
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-secondary border-b border-border-light bg-bg">
              转写历史 ({transcripts.length})
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {transcripts.length === 0 ? (
                <div className="text-center text-text-secondary text-xs py-8">还没有转写记录</div>
              ) : (
                transcripts.slice().reverse().map(t => (
                  <div key={t.id} className="bg-surface rounded p-2 text-[11px] hover:bg-surface-high transition group">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-text-secondary font-mono">{new Date(t.ts).toLocaleTimeString().slice(0, 8)}</span>
                      <Badge variant="info">{t.lang}</Badge>
                      <span className="text-text-secondary ml-auto">置信 {(t.confidence * 100).toFixed(0)}%</span>
                      <Tooltip content="朗读"><button onClick={() => speak(t.text)} className="material-symbols-outlined text-xs text-text-secondary">volume_up</button></Tooltip>
                    </div>
                    <div className="text-text">{t.text}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
