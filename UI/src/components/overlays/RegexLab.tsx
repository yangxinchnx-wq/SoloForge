// ─────────────────────────────────────────────────────────────────
// 正则表达式工作台
// - 多 flag 实时高亮匹配 / 替换 / 拆分 / 解释
// - 内置 cheat sheet + 常用预设
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface MatchGroup {
  full: string;
  index: number;
  end: number;
  groups: string[];
  named: Record<string, string>;
}

interface ExplainToken {
  type: 'literal' | 'meta' | 'class' | 'group' | 'quant' | 'anchor' | 'look' | 'flag';
  text: string;
  desc: string;
}

const PRESETS: { name: string; pattern: string; flags: string; note: string }[] = [
  { name: '邮箱',      pattern: '[\\w.+-]+@[\\w-]+\\.[\\w.-]+',           flags: 'gi', note: '简单邮箱校验' },
  { name: 'URL',       pattern: 'https?:\\/\\/[\\w.-]+(?:\\:[\\d]+)?(?:\\/[^\\s]*)?', flags: 'gi', note: 'http/https 链接' },
  { name: 'IPv4',      pattern: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b',       flags: 'g', note: 'IPv4 地址' },
  { name: '手机号(中国)', pattern: '\\b1[3-9]\\d{9}\\b',                  flags: 'g', note: '11 位手机号' },
  { name: '身份证',    pattern: '\\b\\d{17}[\\dXx]\\b',                   flags: 'g', note: '18 位身份证' },
  { name: '十六进制色', pattern: '#(?:[0-9a-fA-F]{3}){1,2}\\b',           flags: 'gi', note: '#fff / #ffffff' },
  { name: '日期 YMD',  pattern: '\\b\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}\\b',    flags: 'g', note: '2024-01-15' },
  { name: '时间 HMS',  pattern: '\\b\\d{1,2}:\\d{2}:\\d{2}\\b',           flags: 'g', note: '13:45:30' },
  { name: '数字',      pattern: '\\b\\d+(?:\\.\\d+)?\\b',                 flags: 'g', note: '整数/小数' },
  { name: '中文',      pattern: '[\\u4e00-\\u9fa5]+',                     flags: 'gu', note: '中文字符串' },
  { name: 'Markdown 链接', pattern: '\\[([^\\]]+)\\]\\(([^)]+)\\)',        flags: 'g', note: '捕获文本+URL' },
  { name: 'import 路径', pattern: "import\\s+.*?from\\s+['\"]([^'\"]+)['\"]", flags: 'g', note: 'ES import 路径' },
];

// 简单解释器 — 把 regex 拆成可读 token, 仅供参考
function explain(pattern: string): ExplainToken[] {
  const tokens: ExplainToken[] = [];
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    // 转义
    if (c === '\\' && i + 1 < pattern.length) {
      const n = pattern[i + 1];
      const escapeMap: Record<string, string> = {
        d: '数字 (0-9)', D: '非数字', w: '单词字符 (a-zA-Z0-9_)', W: '非单词字符',
        s: '空白', S: '非空白', b: '单词边界', B: '非单词边界',
        n: '换行', t: '制表符', r: '回车', '.': '字面点',
      };
      tokens.push({ type: 'meta', text: '\\' + n, desc: escapeMap[n] || `转义 ${n}` });
      i += 2;
      continue;
    }
    if (c === '[') {
      // 字符类
      let j = i + 1;
      let neg = false;
      if (pattern[j] === '^') { neg = true; j++; }
      while (j < pattern.length && pattern[j] !== ']') {
        if (pattern[j] === '\\' && j + 1 < pattern.length) j += 2;
        else j++;
      }
      const cls = pattern.slice(i, j + 1);
      tokens.push({ type: 'class', text: cls, desc: (neg ? '否定 ' : '') + '字符类' });
      i = j + 1;
      continue;
    }
    if (c === '(') {
      let j = i + 1;
      let kind = '捕获组';
      if (pattern[j] === '?') {
        if (pattern[j + 1] === ':') kind = '非捕获组';
        else if (pattern[j + 1] === '=') kind = '正向预查';
        else if (pattern[j + 1] === '!') kind = '负向预查';
        else if (pattern[j + 1] === '<') {
          if (pattern[j + 2] === '=') kind = '正向回顾';
          else if (pattern[j + 2] === '!') kind = '负向回顾';
          else kind = '命名捕获组';
        }
      }
      tokens.push({ type: 'group', text: pattern.slice(i, j + 1), desc: kind + ' 起点' });
      i = j + 1;
      continue;
    }
    if (c === ')') { tokens.push({ type: 'group', text: ')', desc: '组结束' }); i++; continue; }
    if (c === '|') { tokens.push({ type: 'meta', text: '|', desc: '或' }); i++; continue; }
    if (c === '^' || c === '$') { tokens.push({ type: 'anchor', text: c, desc: c === '^' ? '行首' : '行尾' }); i++; continue; }
    if ('*+?{'.includes(c)) {
      let j = i;
      if (c === '{') {
        while (j < pattern.length && pattern[j] !== '}') j++;
      } else {
        j = i;
      }
      const q = pattern.slice(i, j + 1);
      const desc = c === '*' ? '0 或多次' : c === '+' ? '1 或多次' : c === '?' ? '0 或 1 次' : `指定次数 ${q}`;
      tokens.push({ type: 'quant', text: q, desc });
      i = j + 1;
      continue;
    }
    if (c === '.') { tokens.push({ type: 'meta', text: '.', desc: '任意字符 (除换行)' }); i++; continue; }
    tokens.push({ type: 'literal', text: c, desc: `字面 "${c}"` });
    i++;
  }
  return tokens;
}

// 安全地构造 RegExp,捕获语法错误
function safeCompile(pattern: string, flags: string): { re: RegExp | null; err: string | null } {
  try {
    return { re: new RegExp(pattern, flags), err: null };
  } catch (e: any) {
    return { re: null, err: e?.message || String(e) };
  }
}

const SAMPLE_TEXT = `SoloForge v2.3.1 - 2024-01-15 13:45:30
联系: dev@soloforge.io, support@anthropic.com
项目地址: https://github.com/soloforge/ide
Bug 报告 ID: #f3a9c2
价格: $1,299.00 (USD)
身份证示例: 110101199003078812
代码: const re = /\\d+/g;  // 匹配数字
中文测试: 你好世界 hello world
错误日志: [2024-01-15 14:23:01] ERROR: connection refused
`;

// 简易高亮:把命中位置切出来,返回 { text, matched }[]
function highlightMatches(text: string, re: RegExp | null): { text: string; matched: boolean; groups: string[] }[] {
  if (!re) return [{ text, matched: false, groups: [] }];
  const out: { text: string; matched: boolean; groups: string[] }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), matched: false, groups: [] });
    const groups: string[] = [];
    for (let i = 1; i < m.length; i++) groups.push(m[i] ?? '');
    out.push({ text: m[0], matched: true, groups });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++; // 防止零宽死循环
  }
  if (last < text.length) out.push({ text: text.slice(last), matched: false, groups: [] });
  return out;
}

const CHEATSHEET: { category: string; rows: { pat: string; desc: string }[] }[] = [
  { category: '字符类', rows: [
    { pat: '\\d', desc: '数字 0-9' },
    { pat: '\\D', desc: '非数字' },
    { pat: '\\w', desc: '单词字符 [A-Za-z0-9_]' },
    { pat: '\\W', desc: '非单词字符' },
    { pat: '\\s', desc: '空白 (空格/换行/制表)' },
    { pat: '\\S', desc: '非空白' },
    { pat: '.',   desc: '任意字符 (除换行)' },
    { pat: '[abc]', desc: '字符类,匹配 a/b/c' },
    { pat: '[^abc]', desc: '否定字符类' },
    { pat: '[a-z]', desc: '范围' },
  ]},
  { category: '量词', rows: [
    { pat: '*',  desc: '0 或多次' },
    { pat: '+',  desc: '1 或多次' },
    { pat: '?',  desc: '0 或 1 次' },
    { pat: '{n}', desc: '恰好 n 次' },
    { pat: '{n,}', desc: '至少 n 次' },
    { pat: '{n,m}', desc: 'n 到 m 次' },
    { pat: '*?', desc: '懒惰量词 (尽可能少)' },
  ]},
  { category: '锚点', rows: [
    { pat: '^', desc: '行/字符串开头' },
    { pat: '$', desc: '行/字符串结尾' },
    { pat: '\\b', desc: '单词边界' },
    { pat: '\\B', desc: '非单词边界' },
  ]},
  { category: '组与回溯', rows: [
    { pat: '(abc)', desc: '捕获组' },
    { pat: '(?:abc)', desc: '非捕获组' },
    { pat: '(?<name>abc)', desc: '命名捕获' },
    { pat: 'a|b', desc: '或' },
    { pat: '\\1', desc: '反向引用第 1 组' },
  ]},
  { category: '预查', rows: [
    { pat: '(?=abc)', desc: '正向预查 (后面是)' },
    { pat: '(?!abc)', desc: '负向预查 (后面不是)' },
    { pat: '(?<=abc)', desc: '正向回顾 (前面是)' },
    { pat: '(?<!abc)', desc: '负向回顾 (前面不是)' },
  ]},
  { category: '标志', rows: [
    { pat: 'g', desc: '全局' },
    { pat: 'i', desc: '忽略大小写' },
    { pat: 'm', desc: '多行' },
    { pat: 's', desc: 'dotAll (. 匹配换行)' },
    { pat: 'u', desc: 'Unicode' },
    { pat: 'y', desc: '粘性 (sticky)' },
  ]},
];

export function RegexLab({ open, onClose }: Props) {
  const [pattern, setPattern] = useState('\\b\\w+@\\w+\\.[a-z]+\\b');
  const [flags, setFlags] = useState('gi');
  const [text, setText] = useState(SAMPLE_TEXT);
  const [replace, setReplace] = useState('<$1>');
  const [mode, setMode] = useState<'test' | 'replace' | 'split' | 'explain'>('test');
  const [split, setSplit] = useState('');

  const { re, err } = useMemo(() => safeCompile(pattern, flags), [pattern, flags]);
  const parts = useMemo(() => highlightMatches(text, re), [text, re]);
  const matches: MatchGroup[] = useMemo(() => {
    if (!re) return [];
    const out: MatchGroup[] = [];
    const r = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = r.exec(text)) !== null) {
      const groups: string[] = [];
      for (let k = 1; k < m.length; k++) groups.push(m[k] ?? '');
      const named: Record<string, string> = {};
      if (m.groups) for (const k of Object.keys(m.groups)) named[k] = m.groups[k] || '';
      out.push({ full: m[0], index: m.index, end: m.index + m[0].length, groups, named });
      if (m[0].length === 0) r.lastIndex++;
      if (++i > 5000) break;
    }
    return out;
  }, [text, pattern, flags, re]);

  const replacedText = useMemo(() => {
    if (!re) return '';
    try {
      // 替换模式: $1, $2, $<name>, $$ 字面 $
      return text.replace(re, (m: string, ...args: any[]) => {
        const groups = (args.length > 0 && typeof args[args.length - 1] === 'object' && args[args.length - 1]) ? args[args.length - 1] as Record<string, string> : undefined;
        const captureArgs = args.slice(0, -2) as string[];
        let out = replace;
        out = out.replace(/\$\$/g, '\u0001');
        out = out.replace(/\$(\d+)/g, (_, n) => captureArgs[+n - 1] ?? '');
        out = out.replace(/\$<([^>]+)>/g, (_, name) => (groups?.[name]) ?? '');
        return out.replace(/\u0001/g, '$');
      });
    } catch (e: any) { return `// 错误: ${e?.message || e}`; }
  }, [text, replace, re]);

  const splitParts = useMemo(() => {
    if (!split) return [];
    try { return text.split(new RegExp(split, flags)); } catch { return []; }
  }, [text, split, flags]);

  const tokens = useMemo(() => explain(pattern), [pattern]);

  const applyPreset = useCallback((p: typeof PRESETS[number]) => {
    setPattern(p.pattern);
    setFlags(p.flags);
  }, []);

  const copyMatches = useCallback(() => {
    const s = matches.map(m => `[${m.index}-${m.end}] ${m.full}` + (m.groups.length ? ` groups=[${m.groups.join(', ')}]` : '')).join('\n');
    navigator.clipboard?.writeText(s).catch(() => {});
  }, [matches]);

  const exportJson = useCallback(() => {
    const blob = new Blob([JSON.stringify({ pattern, flags, matches, replacedText }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'regex-matches.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [pattern, flags, matches, replacedText]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-[1100px] max-w-[95vw] h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶栏 */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">data_object</span>
          <h2 className="text-sm font-semibold text-text">正则表达式工作台</h2>
          <span className="text-xs text-text-secondary">Regex Lab · 实时高亮 · 解释 · 替换</span>
          <div className="ml-auto flex items-center gap-1.5">
            <Tooltip content="复制匹配列表"><IconButton icon="content_copy" onClick={copyMatches} /></Tooltip>
            <Tooltip content="导出 JSON"><IconButton icon="download" onClick={exportJson} /></Tooltip>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        {/* 模式切换 */}
        <div className="flex items-center gap-1 px-4 py-2 border-b border-border bg-bg shrink-0">
          {([
            { id: 'test',    label: '测试', icon: 'search' },
            { id: 'replace', label: '替换', icon: 'find_replace' },
            { id: 'split',   label: '拆分', icon: 'call_split' },
            { id: 'explain', label: '解释', icon: 'help' },
          ] as const).map(t => (
            <button
              key={t.id}
              onClick={() => setMode(t.id)}
              className={
                'flex items-center gap-1.5 px-3 h-7 rounded-md text-xs transition ' +
                (mode === t.id ? 'bg-accent/15 text-accent border border-accent/30' : 'text-text-secondary hover:bg-surface-high border border-transparent')
              }
            >
              <span className="material-symbols-outlined text-sm">{t.icon}</span>
              {t.label}
            </button>
          ))}
          <div className="ml-auto text-[10px] text-text-secondary">
            {matches.length} 个匹配 · {matches.reduce((a, m) => a + m.full.length, 0)} 字符
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* 左侧:pattern + presets + cheatsheet */}
          <div className="w-72 border-r border-border bg-surface flex flex-col shrink-0">
            {/* 模式输入 */}
            <div className="p-3 border-b border-border">
              <label className="text-[10px] uppercase tracking-wider text-text-secondary">模式 (Pattern)</label>
              <div className="mt-1 flex items-center gap-1">
                <span className="text-text-secondary text-sm font-mono">/</span>
                <input
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  className="flex-1 bg-bg border border-border rounded px-2 py-1 text-xs font-mono text-text focus:border-accent outline-none"
                  spellCheck={false}
                />
                <span className="text-text-secondary text-sm font-mono">/</span>
                <input
                  value={flags}
                  onChange={(e) => setFlags(e.target.value.replace(/[^gimsuy]/g, ''))}
                  className="w-12 bg-bg border border-border rounded px-1.5 py-1 text-xs font-mono text-text text-center focus:border-accent outline-none"
                  spellCheck={false}
                  placeholder="gim"
                />
              </div>
              {err && <div className="mt-1 text-[10px] text-danger flex items-center gap-1"><span className="material-symbols-outlined text-xs">error</span>{err}</div>}
            </div>

            {/* 预设 */}
            <div className="p-3 border-b border-border">
              <label className="text-[10px] uppercase tracking-wider text-text-secondary">常用预设</label>
              <div className="mt-1 max-h-48 overflow-y-auto pr-1 space-y-0.5">
                {PRESETS.map(p => (
                  <button
                    key={p.name}
                    onClick={() => applyPreset(p)}
                    className="w-full text-left px-2 py-1 rounded hover:bg-surface-high transition flex items-center justify-between group"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-text">{p.name}</div>
                      <div className="text-[10px] text-text-secondary truncate font-mono">{p.pattern}</div>
                    </div>
                    <span className="material-symbols-outlined text-xs text-text-secondary opacity-0 group-hover:opacity-100">arrow_forward</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Cheat sheet */}
            <div className="flex-1 overflow-y-auto p-3">
              <label className="text-[10px] uppercase tracking-wider text-text-secondary">速查表</label>
              <div className="mt-1 space-y-2">
                {CHEATSHEET.map(sec => (
                  <div key={sec.category}>
                    <div className="text-[10px] font-semibold text-text-secondary mt-1 mb-0.5">{sec.category}</div>
                    {sec.rows.map(r => (
                      <div key={r.pat} className="flex items-baseline gap-2 text-[11px] py-0.5">
                        <code className="font-mono text-accent bg-accent/5 px-1 rounded shrink-0 min-w-[60px]">{r.pat}</code>
                        <span className="text-text-secondary">{r.desc}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* 右侧:主内容区 */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {mode === 'test' && (
              <>
                <div className="flex-1 flex flex-col overflow-hidden p-3">
                  <label className="text-[10px] uppercase tracking-wider text-text-secondary">测试文本</label>
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    className="mt-1 flex-1 bg-bg border border-border rounded p-2 text-xs font-mono text-text resize-none focus:border-accent outline-none"
                    spellCheck={false}
                  />
                </div>
                <div className="flex-1 flex flex-col overflow-hidden p-3 border-t border-border">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] uppercase tracking-wider text-text-secondary">高亮预览</label>
                    <div className="text-[10px] text-text-secondary">
                      {matches.length} 处 · 首个 @ 位置 {matches[0]?.index ?? '—'}
                    </div>
                  </div>
                  <pre className="mt-1 flex-1 bg-bg border border-border rounded p-3 text-xs font-mono text-text overflow-auto whitespace-pre-wrap break-all leading-relaxed">
                    {parts.map((p, i) => p.matched ? (
                      <span key={i}>
                        <mark className="bg-accent/30 text-accent rounded px-0.5 ring-1 ring-accent/50">{p.text}</mark>
                        {p.groups.length > 0 && (
                          <sub className="text-[9px] text-text-secondary ml-0.5">
                            {p.groups.filter(Boolean).map((g, gi) => <span key={gi} className="mr-1">${gi+1}={g.length > 12 ? g.slice(0, 12) + '…' : g}</span>)}
                          </sub>
                        )}
                      </span>
                    ) : <span key={i}>{p.text}</span>)}
                  </pre>
                </div>
                <div className="border-t border-border p-3 max-h-44 overflow-y-auto shrink-0">
                  <label className="text-[10px] uppercase tracking-wider text-text-secondary">捕获组详情</label>
                  {matches.length === 0 ? (
                    <div className="mt-1 text-[11px] text-text-secondary">无匹配</div>
                  ) : (
                    <table className="w-full mt-1 text-[11px]">
                      <thead className="text-text-secondary text-[10px]">
                        <tr className="text-left">
                          <th className="font-normal py-0.5 pr-2">#</th>
                          <th className="font-normal py-0.5 pr-2">位置</th>
                          <th className="font-normal py-0.5 pr-2">匹配</th>
                          <th className="font-normal py-0.5">捕获组</th>
                        </tr>
                      </thead>
                      <tbody>
                        {matches.slice(0, 50).map((m, i) => (
                          <tr key={i} className="border-t border-border-light">
                            <td className="py-0.5 pr-2 text-text-secondary">{i + 1}</td>
                            <td className="py-0.5 pr-2 text-text-secondary font-mono">{m.index}–{m.end}</td>
                            <td className="py-0.5 pr-2 font-mono text-accent">{m.full.length > 24 ? m.full.slice(0, 24) + '…' : m.full}</td>
                            <td className="py-0.5 font-mono text-text-secondary">
                              {m.groups.map((g, gi) => <span key={gi} className="mr-2">${gi+1}={g || '∅'}</span>)}
                              {Object.entries(m.named).map(([k, v]) => <span key={k} className="mr-2 text-success">${'<'}{k}{'>'}={v}</span>)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </>
            )}

            {mode === 'replace' && (
              <div className="flex-1 flex flex-col overflow-hidden p-3">
                <label className="text-[10px] uppercase tracking-wider text-text-secondary">替换模板 (支持 $1, $2, ${'<'}name{'>'}, $$)</label>
                <input
                  value={replace}
                  onChange={(e) => setReplace(e.target.value)}
                  className="mt-1 bg-bg border border-border rounded px-2 py-1.5 text-xs font-mono text-text focus:border-accent outline-none"
                  spellCheck={false}
                />
                <div className="mt-3 flex-1 grid grid-cols-2 gap-3 overflow-hidden">
                  <div className="flex flex-col">
                    <label className="text-[10px] uppercase tracking-wider text-text-secondary mb-1">原文</label>
                    <textarea
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      className="flex-1 bg-bg border border-border rounded p-2 text-xs font-mono text-text resize-none focus:border-accent outline-none"
                      spellCheck={false}
                    />
                  </div>
                  <div className="flex flex-col">
                    <label className="text-[10px] uppercase tracking-wider text-text-secondary mb-1">替换结果</label>
                    <pre className="flex-1 bg-bg border border-border rounded p-2 text-xs font-mono text-text overflow-auto whitespace-pre-wrap break-all">{replacedText || '// 无匹配'}</pre>
                  </div>
                </div>
              </div>
            )}

            {mode === 'split' && (
              <div className="flex-1 flex flex-col overflow-hidden p-3">
                <label className="text-[10px] uppercase tracking-wider text-text-secondary">拆分模式 (留空则使用主 pattern)</label>
                <input
                  value={split}
                  onChange={(e) => setSplit(e.target.value)}
                  placeholder={pattern || '输入拆分正则...'}
                  className="mt-1 bg-bg border border-border rounded px-2 py-1.5 text-xs font-mono text-text focus:border-accent outline-none"
                  spellCheck={false}
                />
                <div className="mt-3 flex-1 overflow-y-auto pr-1">
                  <div className="text-[10px] text-text-secondary mb-1">共 {splitParts.length} 段</div>
                  {splitParts.map((s, i) => (
                    <div key={i} className="mb-1 p-2 bg-bg border border-border rounded flex items-start gap-2">
                      <span className="text-[10px] text-text-secondary w-6 shrink-0 mt-0.5">{i + 1}</span>
                      <code className="text-xs font-mono text-text break-all whitespace-pre-wrap">{s || '(空)'}</code>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {mode === 'explain' && (
              <div className="flex-1 overflow-y-auto p-3">
                <div className="text-[10px] uppercase tracking-wider text-text-secondary mb-1">分词解释 ({tokens.length} 个 token)</div>
                {tokens.length === 0 ? (
                  <div className="text-xs text-text-secondary">空模式</div>
                ) : (
                  <div className="space-y-1">
                    {tokens.map((t, i) => (
                      <div key={i} className="flex items-center gap-2 p-2 bg-bg border border-border rounded">
                        <span className="text-[10px] text-text-secondary w-6 shrink-0">{i + 1}</span>
                        <code className={
                          'px-2 py-0.5 rounded font-mono text-xs shrink-0 ' +
                          (t.type === 'literal' ? 'bg-surface-high text-text' :
                           t.type === 'meta' ? 'bg-accent/15 text-accent' :
                           t.type === 'class' ? 'bg-success/15 text-success' :
                           t.type === 'group' ? 'bg-warning/15 text-warning' :
                           t.type === 'quant' ? 'bg-purple-500/15 text-purple-400' :
                           t.type === 'anchor' ? 'bg-danger/15 text-danger' :
                           'bg-text-secondary/15 text-text-secondary')
                        }>{t.text}</code>
                        <span className="text-xs text-text-secondary flex-1">{t.desc}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-3 p-3 bg-bg border border-border-light rounded text-[11px] text-text-secondary">
                  <strong className="text-text">提示:</strong> 本解释为启发式分词,仅供参考。完整语义请查阅 MDN — Regular Expressions。
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
