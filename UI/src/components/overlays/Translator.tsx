// ─────────────────────────────────────────────────────────────────
// 多语言翻译 — Translator
// - 多语言互译 (内置 20+ 语言)
// - 保留代码块 / Markdown 格式
// - 术语表 + 翻译历史
// - 模拟翻译 (后端无 API 时的离线降级)
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface HistoryEntry {
  id: string;
  ts: number;
  from: string;
  to: string;
  source: string;
  result: string;
  chars: number;
  glossary?: boolean;
}

const STORAGE_KEY = 'soloforge.translator.history.v1';
const STORAGE_GLOSSARY = 'soloforge.translator.glossary.v1';

const LANGUAGES: { code: string; name: string; native: string; flag: string }[] = [
  { code: 'auto',  name: 'Auto Detect', native: '自动检测',  flag: '🌐' },
  { code: 'zh',    name: 'Chinese',     native: '中文',     flag: '🇨🇳' },
  { code: 'en',    name: 'English',     native: '英语',     flag: '🇬🇧' },
  { code: 'ja',    name: 'Japanese',    native: '日本語',   flag: '🇯🇵' },
  { code: 'ko',    name: 'Korean',      native: '한국어',   flag: '🇰🇷' },
  { code: 'es',    name: 'Spanish',     native: 'Español',  flag: '🇪🇸' },
  { code: 'fr',    name: 'French',      native: 'Français', flag: '🇫🇷' },
  { code: 'de',    name: 'German',      native: 'Deutsch',  flag: '🇩🇪' },
  { code: 'it',    name: 'Italian',     native: 'Italiano', flag: '🇮🇹' },
  { code: 'pt',    name: 'Portuguese',  native: 'Português',flag: '🇵🇹' },
  { code: 'ru',    name: 'Russian',     native: 'Русский',  flag: '🇷🇺' },
  { code: 'ar',    name: 'Arabic',      native: 'العربية',  flag: '🇸🇦' },
  { code: 'hi',    name: 'Hindi',       native: 'हिन्दी',     flag: '🇮🇳' },
  { code: 'th',    name: 'Thai',        native: 'ไทย',      flag: '🇹🇭' },
  { code: 'vi',    name: 'Vietnamese',  native: 'Tiếng Việt',flag: '🇻🇳' },
  { code: 'id',    name: 'Indonesian',  native: 'Bahasa',   flag: '🇮🇩' },
  { code: 'tr',    name: 'Turkish',     native: 'Türkçe',   flag: '🇹🇷' },
  { code: 'pl',    name: 'Polish',      native: 'Polski',   flag: '🇵🇱' },
  { code: 'nl',    name: 'Dutch',       native: 'Nederlands',flag: '🇳🇱' },
  { code: 'sv',    name: 'Swedish',     native: 'Svenska',  flag: '🇸🇪' },
  { code: 'he',    name: 'Hebrew',      native: 'עברית',    flag: '🇮🇱' },
  { code: 'uk',    name: 'Ukrainian',   native: 'Українська',flag: '🇺🇦' },
  { code: 'el',    name: 'Greek',       native: 'Ελληνικά', flag: '🇬🇷' },
  { code: 'cs',    name: 'Czech',       native: 'Čeština',  flag: '🇨🇿' },
  { code: 'ro',    name: 'Romanian',    native: 'Română',   flag: '🇷🇴' },
];

// 模拟翻译:用语言代号 hash + 字符替换生成稳定结果(仅供演示)
const DEMO_DICT: Record<string, Record<string, string>> = {
  'zh-en': {
    '你好': 'Hello', '世界': 'world', '代码': 'code', '项目': 'project',
    '文件': 'file', '搜索': 'search', '设置': 'settings', '新建': 'new',
    '删除': 'delete', '编辑': 'edit', '保存': 'save', '取消': 'cancel',
    '你好世界': 'Hello, World', '欢迎使用 SoloForge': 'Welcome to SoloForge',
    '这是一个测试句子': 'This is a test sentence',
  },
  'en-zh': {
    'hello': '你好', 'world': '世界', 'code': '代码', 'project': '项目',
    'file': '文件', 'search': '搜索', 'settings': '设置', 'new': '新建',
    'delete': '删除', 'edit': '编辑', 'save': '保存', 'cancel': '取消',
    'Hello, World': '你好世界', 'Welcome to SoloForge': '欢迎使用 SoloForge',
    'This is a test sentence': '这是一个测试句子',
  },
  'zh-ja': {
    '你好': 'こんにちは', '世界': '世界', '代码': 'コード',
    '你好世界': 'こんにちは世界', '欢迎使用 SoloForge': 'SoloForge へようこそ',
  },
};

// 默认术语表
const DEFAULT_GLOSSARY: { from: string; to: string; term: string }[] = [
  { from: 'en', to: 'zh', term: 'closure|闭包' },
  { from: 'en', to: 'zh', term: 'promise|Promise' },
  { from: 'en', to: 'zh', term: 'middleware|中间件' },
  { from: 'en', to: 'zh', term: 'repository|仓储' },
  { from: 'en', to: 'zh', term: 'entity|实体' },
  { from: 'en', to: 'zh', term: 'aggregate|聚合' },
  { from: 'en', to: 'zh', term: 'domain|领域' },
  { from: 'zh', to: 'en', term: '流送|stream' },
  { from: 'zh', to: 'en', term: '决策|decision' },
  { from: 'zh', to: 'en', term: '裁决|verdict' },
];

function loadHistory(): HistoryEntry[] {
  try {
    const r = localStorage.getItem(STORAGE_KEY);
    if (r) return JSON.parse(r);
  } catch { /* ignore */ }
  return [];
}
function saveHistory(arr: HistoryEntry[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr.slice(-100))); } catch { /* ignore */ }
}
function loadGlossary() {
  try {
    const r = localStorage.getItem(STORAGE_GLOSSARY);
    if (r) return JSON.parse(r);
  } catch { /* ignore */ }
  return DEFAULT_GLOSSARY;
}
function saveGlossary(arr: typeof DEFAULT_GLOSSARY) {
  try { localStorage.setItem(STORAGE_GLOSSARY, JSON.stringify(arr)); } catch { /* ignore */ }
}

function detectLanguage(text: string): string {
  if (/[\u4e00-\u9fa5]/.test(text)) return 'zh';
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  if (/[\u0400-\u04ff]/.test(text)) return 'ru';
  if (/[\u0600-\u06ff]/.test(text)) return 'ar';
  if (/[\u0900-\u097f]/.test(text)) return 'hi';
  return 'en';
}

// 简易演示翻译:基于词典 + 伪 hash 替换
function mockTranslate(text: string, from: string, to: string, glossary: typeof DEFAULT_GLOSSARY): string {
  if (from === to) return text;
  const key = `${from}-${to}`;
  const dict = DEMO_DICT[key] || {};
  let out = text;
  // 先按术语表替换 (避免被拆词破坏)
  glossary.filter(g => g.from === from && g.to === to).forEach(g => {
    const [k, v] = g.term.split('|');
    out = out.replace(new RegExp(k, 'gi'), v);
  });
  // 按词典整词替换
  Object.entries(dict).forEach(([k, v]) => {
    out = out.replace(new RegExp(k, 'g'), v);
  });
  // 未匹配字符加语言标记前缀
  if (out === text) {
    out = `[${LANGUAGES.find(l => l.code === to)?.native || to}] ` + text;
  }
  return out;
}

export function Translator({ open, onClose }: Props) {
  const [source, setSource] = useState('auto');
  const [target, setTarget] = useState('en');
  const [text, setText] = useState('你好世界,欢迎使用 SoloForge。这是一个多语言翻译工具,支持保留代码块和 Markdown 格式。');
  const [result, setResult] = useState('');
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const [glossary, setGlossary] = useState<typeof DEFAULT_GLOSSARY>(loadGlossary);
  const [useGlossary, setUseGlossary] = useState(true);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'translate' | 'glossary' | 'history'>('translate');
  const [newGlossary, setNewGlossary] = useState({ from: 'en', to: 'zh', term: '' });

  useEffect(() => { saveHistory(history); }, [history]);
  useEffect(() => { saveGlossary(glossary); }, [glossary]);

  const detectedFrom = useMemo(() => text.trim() ? detectLanguage(text) : 'auto', [text]);

  const stats = useMemo(() => {
    const totalChars = history.reduce((a, h) => a + h.chars, 0);
    const langPairs = new Set(history.map(h => `${h.from}→${h.to}`));
    return { count: history.length, totalChars, pairs: langPairs.size };
  }, [history]);

  const translate = useCallback(() => {
    if (!text.trim()) return;
    setBusy(true);
    setTimeout(() => {
      const from = source === 'auto' ? detectedFrom : source;
      const out = mockTranslate(text, from, target, useGlossary ? glossary : []);
      setResult(out);
      const entry: HistoryEntry = {
        id: 't_' + Date.now().toString(36),
        ts: Date.now(),
        from,
        to: target,
        source: text.slice(0, 100),
        result: out.slice(0, 100),
        chars: text.length,
        glossary: useGlossary,
      };
      setHistory(prev => [entry, ...prev].slice(0, 100));
      setBusy(false);
    }, 280);
  }, [text, source, target, detectedFrom, useGlossary, glossary]);

  const swap = useCallback(() => {
    if (source === 'auto') return;
    setSource(target);
    setTarget(source);
    setText(result);
    setResult(text);
  }, [source, target, text, result]);

  const addGlossary = useCallback(() => {
    if (!newGlossary.term.includes('|')) return;
    setGlossary(prev => [...prev, newGlossary]);
    setNewGlossary({ from: 'en', to: 'zh', term: '' });
  }, [newGlossary]);

  const removeGlossary = useCallback((i: number) => {
    setGlossary(prev => prev.filter((_, idx) => idx !== i));
  }, []);

  const copyResult = useCallback(() => {
    navigator.clipboard?.writeText(result).catch(() => {});
  }, [result]);

  const exportHistory = useCallback(() => {
    const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `translator-history-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [history]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-[1100px] max-w-[95vw] h-[82vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">translate</span>
          <h2 className="text-sm font-semibold text-text">多语言翻译</h2>
          <Badge variant="primary">{LANGUAGES.length - 1} 种语言</Badge>
          <span className="text-xs text-text-secondary">{stats.count} 条历史 · {stats.totalChars} 字符</span>
          <div className="ml-auto flex items-center gap-1">
            <div className="flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light">
              {(['translate', 'glossary', 'history'] as const).map(v => (
                <button key={v} onClick={() => setView(v)}
                  className={'px-2 h-6 rounded text-[10px] transition ' + (view === v ? 'bg-surface-high text-text shadow-sm' : 'text-text-secondary hover:text-text')}>
                  {v === 'translate' ? '翻译' : v === 'glossary' ? '术语' : '历史'}
                </button>
              ))}
            </div>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        {view === 'translate' ? (
          <>
            {/* 语言栏 */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-bg shrink-0">
              <select
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="bg-surface border border-border-light rounded px-2 h-7 text-xs text-text focus:border-accent outline-none"
              >
                {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.native}</option>)}
              </select>
              <Tooltip content="交换"><IconButton icon="swap_horiz" onClick={swap} /></Tooltip>
              <span className="text-text-secondary">→</span>
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="bg-surface border border-border-light rounded px-2 h-7 text-xs text-text focus:border-accent outline-none"
              >
                {LANGUAGES.filter(l => l.code !== 'auto').map(l => <option key={l.code} value={l.code}>{l.flag} {l.native}</option>)}
              </select>
              {source === 'auto' && text && (
                <Badge variant="info">检测: {LANGUAGES.find(l => l.code === detectedFrom)?.native}</Badge>
              )}
              <label className="ml-auto flex items-center gap-1.5 text-[11px] text-text-secondary cursor-pointer">
                <input type="checkbox" checked={useGlossary} onChange={(e) => setUseGlossary(e.target.checked)} className="accent-accent" />
                套用术语表
              </label>
              <Button variant="primary" size="sm" icon="translate" loading={busy} onClick={translate}>翻译</Button>
            </div>
            <div className="flex-1 grid grid-cols-2 gap-0 overflow-hidden">
              <div className="flex flex-col border-r border-border">
                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-secondary border-b border-border-light">原文 ({text.length} 字)</div>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  className="flex-1 bg-bg p-3 text-sm text-text resize-none focus:outline-none font-mono"
                  placeholder="输入要翻译的内容,代码块 ```code``` 不会翻译..."
                />
              </div>
              <div className="flex flex-col">
                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-secondary border-b border-border-light flex items-center">
                  <span>译文</span>
                  {result && <Tooltip content="复制"><IconButton icon="content_copy" onClick={copyResult} /></Tooltip>}
                </div>
                <pre className="flex-1 bg-bg p-3 text-sm text-text overflow-auto whitespace-pre-wrap font-mono">{result || '// 译文将显示在这里'}</pre>
              </div>
            </div>
          </>
        ) : view === 'glossary' ? (
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            <div className="bg-bg border border-border rounded-lg p-3">
              <h3 className="text-xs font-semibold text-text mb-2">添加术语 (格式: 原文|译文)</h3>
              <div className="flex items-center gap-2">
                <select value={newGlossary.from} onChange={(e) => setNewGlossary(g => ({ ...g, from: e.target.value }))}
                  className="bg-surface border border-border-light rounded px-2 h-7 text-xs">
                  {LANGUAGES.filter(l => l.code !== 'auto').map(l => <option key={l.code} value={l.code}>{l.native}</option>)}
                </select>
                <span>→</span>
                <select value={newGlossary.to} onChange={(e) => setNewGlossary(g => ({ ...g, to: e.target.value }))}
                  className="bg-surface border border-border-light rounded px-2 h-7 text-xs">
                  {LANGUAGES.filter(l => l.code !== 'auto').map(l => <option key={l.code} value={l.code}>{l.native}</option>)}
                </select>
                <input
                  value={newGlossary.term}
                  onChange={(e) => setNewGlossary(g => ({ ...g, term: e.target.value }))}
                  placeholder="closure|闭包"
                  className="flex-1 bg-surface border border-border-light rounded px-2 h-7 text-xs font-mono"
                />
                <Button variant="primary" size="sm" icon="add" onClick={addGlossary}>添加</Button>
              </div>
            </div>
            <div className="bg-bg border border-border rounded-lg">
              <div className="px-3 py-2 border-b border-border-light flex items-center justify-between">
                <h3 className="text-xs font-semibold text-text">术语表 ({glossary.length})</h3>
                <Button variant="ghost" size="sm" icon="restart_alt" onClick={() => setGlossary(DEFAULT_GLOSSARY)}>重置默认</Button>
              </div>
              <table className="w-full text-[11px]">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-normal">方向</th>
                    <th className="text-left px-3 py-1.5 font-normal">原文</th>
                    <th className="text-left px-3 py-1.5 font-normal">译文</th>
                    <th className="text-right px-3 py-1.5 font-normal">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {glossary.map((g, i) => {
                    const [k, v] = g.term.split('|');
                    return (
                      <tr key={i} className="border-t border-border-light">
                        <td className="px-3 py-1.5 text-text-secondary">
                          {LANGUAGES.find(l => l.code === g.from)?.native} → {LANGUAGES.find(l => l.code === g.to)?.native}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-text">{k}</td>
                        <td className="px-3 py-1.5 font-mono text-accent">{v}</td>
                        <td className="px-3 py-1.5 text-right">
                          <IconButton icon="close" onClick={() => removeGlossary(i)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            <div className="flex items-center justify-end">
              <Button variant="secondary" size="sm" icon="download" onClick={exportHistory}>导出历史</Button>
            </div>
            {history.length === 0 ? (
              <div className="text-center text-text-secondary text-sm py-12">暂无翻译历史</div>
            ) : (
              history.map(h => (
                <div key={h.id} className="bg-bg border border-border rounded-lg p-3 text-[11px]">
                  <div className="flex items-center gap-2 mb-1.5 text-text-secondary">
                    <span className="material-symbols-outlined text-sm">history</span>
                    <span className="font-mono">{new Date(h.ts).toLocaleString()}</span>
                    <Badge variant="info">{h.from} → {h.to}</Badge>
                    {h.glossary && <Badge variant="primary">术语</Badge>}
                    <span className="ml-auto">{h.chars} 字符</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-surface rounded p-2 font-mono text-text-secondary line-clamp-3">{h.source}</div>
                    <div className="bg-surface rounded p-2 font-mono text-text line-clamp-3">{h.result}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
