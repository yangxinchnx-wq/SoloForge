// ─────────────────────────────────────────────────────────────────
// 终端面板 - 模拟 shell 输出
// 支持命令历史、命令补全、自动滚动
// ─────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { PanelHeader, IconButton, Tooltip, Button } from '../ui/Button';
import { executeCommand, loadRealHistory, saveRealHistory, isDangerous, type ExecEvent } from '../../api/terminal';

interface Line {
  id: string;
  kind: 'in' | 'out' | 'err' | 'sys' | 'ok';
  text: string;
  ts: number;
}

const SCRIPT: Record<string, { out: string[]; delay?: number }> = {
  help: {
    out: [
      '可用命令 (粗体 = 常用, * = 别名):',
      '  help                 显示帮助',
      '  ls [path]            列出文件',
      '  cat <file>           查看文件内容',
      '  pwd                  当前工作目录',
      '  echo <text>          回显',
      '  clear * cls          清空屏幕',
      '  status * st          系统状态',
      '  agents * ag          智能体列表',
      '  trace <id>           追踪决策链',
      '  git log              查看提交',
      '  history * hist       命令历史',
      '  date                 当前时间',
      '  whoami               当前用户',
      '  uptime               运行时长',
      '  df                   磁盘空间',
      '  free                 内存用量',
      '  env                  环境变量',
      '  grep <pat> <text>    文本搜索',
      '  export <k>=<v>       设置变量',
      '  unset <k>            取消变量',
      '  npm run <script>     运行脚本',
      '  exit                 关闭终端',
    ],
  },
  pwd: { out: ['/soloforge/ui'] },
  ls: {
    out: [
      'src/',
      '├── api/         (3 files)',
      '├── components/  (24 files)',
      '├── hooks/       (6 files)',
      '├── themes/      (1 file)',
      '├── types/       (1 file)',
      '└── App.tsx',
      'package.json   vite.config.ts   README.md',
    ],
  },
  status: {
    out: [
      '● Kernel       OK   v1.4.2   uptime 2h 14m',
      '● Database     OK   SurrealDB 0.3.0   1.2k records',
      '● Scheduler    OK   Rust     0.3.1   8 tasks pending',
      '● Governor     OK   MAPPO    v2.1    142 episodes',
      '● Agents       5 active  12 idle',
      '● Memory       312 episodes  48MB',
    ],
  },
  agents: {
    out: [
      '┌──────────────┬──────────┬────────┬─────────┐',
      '│ id           │ role     │ status │ last_at │',
      '├──────────────┼──────────┼────────┼─────────┤',
      '│ AIRuntime-1  │ runtime  │ active │ 2s ago  │',
      '│ Governor-1   │ train    │ active │ 5s ago  │',
      '│ Court-1      │ judge    │ idle   │ 1m ago  │',
      '│ Engineer-1   │ code     │ active │ 3s ago  │',
      '│ Planner-1    │ plan     │ idle   │ 30s ago │',
      '└──────────────┴──────────┴────────┴─────────┘',
    ],
  },
  'git log': {
    out: [
      '* a3f21b8  (HEAD -> main) feat: 增加终端面板',
      '* 8c9e122  fix: 修复代理路径问题',
      '* b4f6d05  chore: 更新依赖',
      '* e7d8a91  docs: 补充 README',
      '* c2b1f44  refactor: 拆分 useChat hook',
    ],
  },
};

// 命令别名映射
const ALIASES: Record<string, string> = {
  cls: 'clear',
  st: 'status',
  ag: 'agents',
  hist: 'history',
  ll: 'ls -l',
  la: 'ls -a',
  '?': 'help',
  h: 'help',
  q: 'exit',
};

const TIPS = [
  '提示: 试试输入 help 查看可用命令',
  '提示: Ctrl+L 清空屏幕',
  '提示: ↑/↓ 浏览历史命令',
  '提示: 输入 status 查看系统状态',
  '提示: history 查看所有执行过的命令',
  '提示: export KEY=value 设置环境变量',
];

const TIPS_INTERVAL = 18000;

const SUGGESTIONS = ['help', 'ls', 'pwd', 'status', 'agents', 'git log', 'clear', 'history'];

const HIST_KEY = 'soloforge.terminal.history';
const ENV_KEY = 'soloforge.terminal.env';
const START_TIME = Date.now();

export function Terminal() {
  const [lines, setLines] = useState<Line[]>([
    { id: 'b0', kind: 'sys', text: 'SoloForge Terminal v1.1 — 键入 help 开始', ts: Date.now() },
    { id: 'b1', kind: 'sys', text: '工作目录: /soloforge/ui  ·  连接到 http://localhost:3001  ·  ↑↓/Tab', ts: Date.now() },
  ]);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(HIST_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return [];
  });
  const [histIdx, setHistIdx] = useState(-1);
  const [env, setEnv] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem(ENV_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return { USER: 'yangx', HOST: 'soloforge-dev', SHELL: '/bin/zsh' };
  });
  const [tip, setTip] = useState(TIPS[0]);
  const [tabIdx, setTabIdx] = useState(0);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [realMode, setRealMode] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 持久化
  useEffect(() => {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(history.slice(0, 100))); } catch { /* ignore */ }
  }, [history]);
  useEffect(() => {
    try { localStorage.setItem(ENV_KEY, JSON.stringify(env)); } catch { /* ignore */ }
  }, [env]);

  // 自动滚动
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines]);

  // 提示轮换
  useEffect(() => {
    const t = setInterval(() => {
      setTip(TIPS[Math.floor(Math.random() * TIPS.length)]);
    }, TIPS_INTERVAL);
    return () => clearInterval(t);
  }, []);

  const push = useCallback((l: Omit<Line, 'id' | 'ts'>) => {
    setLines(prev => [...prev, { ...l, id: 'l_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), ts: Date.now() }]);
  }, []);

  // 替换变量
  const expandVars = (s: string): string => {
    return s.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (_, k) => env[k.toUpperCase()] ?? '');
  };

  const run = useCallback((raw: string) => {
    const text = raw.trim();
    push({ kind: 'in', text: raw });
    if (!text) return;

    setHistory(h => [text, ...h.filter(x => x !== text)].slice(0, 50));
    setHistIdx(-1);

    // 别名展开
    const expanded = ALIASES[text.split(/\s+/)[0]] ? text.replace(/^\S+/, ALIASES[text.split(/\s+/)[0]]) : text;
    const [cmd, ...args] = expanded.split(/\s+/);

    // 变量展开
    const args2 = args.map(expandVars);
    const finalText = [cmd, ...args2].join(' ');

    if (cmd === 'clear' || cmd === 'cls') {
      setLines([]);
      return;
    }
    if (cmd === 'exit' || cmd === 'quit') {
      push({ kind: 'sys', text: '(终端将持续运行,只是模拟; 按 Ctrl+L 清屏)' });
      return;
    }
    if (cmd === 'echo') {
      push({ kind: 'out', text: args2.join(' ') });
      return;
    }
    if (cmd === 'date') {
      push({ kind: 'out', text: new Date().toString() });
      push({ kind: 'out', text: `本地: ${new Date().toLocaleString('zh-CN', { hour12: false })}` });
      push({ kind: 'out', text: `UTC:   ${new Date().toISOString()}` });
      return;
    }
    if (cmd === 'whoami') {
      push({ kind: 'out', text: `${env.USER || 'yangx'}  (uid=1000, gid=1000)` });
      return;
    }
    if (cmd === 'uptime') {
      const ms = Date.now() - START_TIME;
      const s = Math.floor(ms / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      push({ kind: 'out', text: `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} up ${h}h ${m}m, 1 user, load average: 0.42, 0.38, 0.31` });
      return;
    }
    if (cmd === 'df') {
      push({ kind: 'out', text: 'Filesystem      Size  Used Avail Use% Mounted on' });
      push({ kind: 'out', text: '/dev/sda1       256G  48G  208G  19% /' });
      push({ kind: 'out', text: 'tmpfs           16G  120M  16G   1% /tmp' });
      push({ kind: 'out', text: '/dev/sda2       512G  82G  430G  17% /soloforge' });
      return;
    }
    if (cmd === 'free') {
      push({ kind: 'out', text: '              total        used        free      shared  buff/cache   available' });
      push({ kind: 'out', text: 'Mem:        33554432    8402000    12400000      320000   12752432    24600000' });
      push({ kind: 'out', text: 'Swap:        8388608           0     8388608' });
      return;
    }
    if (cmd === 'env') {
      Object.entries(env).forEach(([k, v]) => push({ kind: 'out', text: `${k}=${v}` }));
      return;
    }
    if (cmd === 'export') {
      const expr = args[0];
      if (!expr || !expr.includes('=')) {
        push({ kind: 'err', text: 'export: 语法错误 (使用: export KEY=VALUE)' });
        return;
      }
      const [k, ...rest] = expr.split('=');
      const v = rest.join('=');
      setEnv(prev => ({ ...prev, [k.toUpperCase()]: v }));
      push({ kind: 'ok', text: `已设置 ${k.toUpperCase()}=${v}` });
      return;
    }
    if (cmd === 'unset') {
      const k = args[0]?.toUpperCase();
      if (!k) { push({ kind: 'err', text: 'unset: 缺少变量名' }); return; }
      setEnv(prev => { const n = { ...prev }; delete n[k]; return n; });
      push({ kind: 'ok', text: `已取消 ${k}` });
      return;
    }
    if (cmd === 'history' || cmd === 'hist') {
      if (history.length === 0) { push({ kind: 'sys', text: '(无历史)' }); return; }
      push({ kind: 'sys', text: `最近 ${history.length} 条命令:` });
      history.slice(0, 30).forEach((h, i) => push({ kind: 'out', text: `  ${String(i + 1).padStart(3, ' ')}  ${h}` }));
      return;
    }
    if (cmd === 'grep') {
      const pat = args[0];
      if (!pat) { push({ kind: 'err', text: 'grep: 缺少 pattern' }); return; }
      const re = new RegExp(pat, 'i');
      const hits = lines.filter(l => re.test(l.text));
      if (hits.length === 0) {
        push({ kind: 'sys', text: `(无匹配: ${pat})` });
      } else {
        push({ kind: 'sys', text: `匹配 ${hits.length} 条:` });
        hits.slice(0, 20).forEach(h => push({ kind: 'out', text: h.text }));
      }
      return;
    }
    if (cmd === 'cat') {
      const f = args[0];
      if (!f) { push({ kind: 'err', text: 'cat: 缺少文件参数' }); return; }
      push({ kind: 'out', text: `─── ${f} ───` });
      push({ kind: 'out', text: 'export const version = "1.0.0";' });
      push({ kind: 'out', text: 'export const kernel = { status: "OK", uptime: 7820 };' });
      return;
    }
    if (cmd === 'trace') {
      const id = args[0] || 'dec_001';
      push({ kind: 'out', text: `追踪 ${id}:` });
      push({ kind: 'sys', text: '  → observation      [12:34:01]' });
      push({ kind: 'sys', text: '  → candidate (x3)   [12:34:02]' });
      push({ kind: 'ok',  text: '  → decision         [12:34:03]   score: 0.87' });
      push({ kind: 'sys', text: '  → court review     [12:34:04]   pass' });
      push({ kind: 'ok',  text: '  → action executed  [12:34:05]' });
      return;
    }
    if (cmd === 'npm' && args[0] === 'run') {
      const script = args[1] || 'dev';
      push({ kind: 'sys', text: `> soloforge@1.0.0 ${script}` });
      push({ kind: 'out', text: 'VITE v5.4.0  ready in 234 ms' });
      push({ kind: 'out', text: '  ➜  Local:   http://localhost:5173/' });
      push({ kind: 'ok',  text: '✓ 运行中' });
      return;
    }

    const key = expanded;
    if (SCRIPT[key]) {
      SCRIPT[key].out.forEach(o => push({ kind: 'out', text: o }));
      return;
    }

    // 危险命令拦截
    if (isDangerous(text)) {
      if (!confirm(`检测到危险命令: ${text}\n确认执行?`)) {
        push({ kind: 'err', text: '⏹ 已拦截' });
        return;
      }
    }

    // 真实执行: 通过 API 流式返回
    const fullText = [cmd, ...args2].join(' ');
    const execId = 'ex_' + Date.now().toString(36);
    push({ kind: 'sys', text: `⏵ 真实执行 (${realMode ? '后端' : '本地模拟'}): ${fullText}` });
    let stdoutBuf = '';
    let stderrBuf = '';
    let exitCode: number | null = null;

    // 推送真实历史
    const realHist = loadRealHistory();
    saveRealHistory([text, ...realHist.filter(x => x !== text)].slice(0, 20));

    executeCommand(fullText, (e: ExecEvent) => {
      switch (e.type) {
        case 'start':
          push({ kind: 'sys', text: `  ⎇ pid=${e.pid ?? 'mock'} · 启动于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}` });
          break;
        case 'stdout':
          stdoutBuf += e.chunk;
          // 流式推送, 每个 chunk 单独一行
          e.chunk.split('\n').filter(Boolean).forEach(line => {
            if (line.trim()) push({ kind: 'out', text: line });
          });
          break;
        case 'stderr':
          stderrBuf += e.chunk;
          e.chunk.split('\n').filter(Boolean).forEach(line => {
            if (line.trim()) push({ kind: 'err', text: line });
          });
          break;
        case 'exit':
          exitCode = e.code;
          const ok = e.code === 0;
          push({
            kind: ok ? 'ok' : 'err',
            text: `  ⏹ exit ${e.code} · 用时 ${e.durationMs}ms`,
          });
          if (stdoutBuf) push({ kind: 'sys', text: `  ⎘ stdout ${stdoutBuf.length}B` });
          if (stderrBuf) push({ kind: 'sys', text: `  ⎘ stderr ${stderrBuf.length}B` });
          break;
        case 'error':
          push({ kind: 'err', text: `  ✗ ${e.message}` });
          break;
      }
    }, realMode).then(({ abort: _abort }) => {
      // 暂存 abort 以支持 Ctrl+C 中断
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      abortRef.current = _abort;
    });
    return;
  }, [push, env, history, lines, realMode]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      run(input);
      setInput('');
      setTabIdx(0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const idx = histIdx < 0 ? 0 : Math.min(histIdx + 1, history.length - 1);
      setHistIdx(idx);
      setInput(history[idx]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx <= 0) { setHistIdx(-1); setInput(''); return; }
      const idx = histIdx - 1;
      setHistIdx(idx);
      setInput(history[idx]);
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      setLines([]);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const matches = SUGGESTIONS.filter(s => s.startsWith(input));
      if (matches.length === 0) return;
      if (matches.length === 1) {
        setInput(matches[0]);
        setTabIdx(0);
      } else {
        // 循环切换
        const next = matches[tabIdx % matches.length];
        setInput(next);
        setTabIdx(i => i + 1);
      }
    } else if (e.key === 'c' && e.ctrlKey) {
      // Ctrl+C 中断: 中止正在执行的任务
      e.preventDefault();
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
        push({ kind: 'in', text: input + '^C' });
        push({ kind: 'sys', text: '⏹ 已中断当前任务' });
      } else {
        push({ kind: 'in', text: input + '^C' });
      }
      setInput('');
      setHistIdx(-1);
    }
  };

  // 关键字高亮: 在输入框上方 inline 显示解析
  const inputTokens = useMemo(() => {
    const m = input.match(/^(\S*)(.*)$/);
    if (!m) return null;
    const cmd = m[1];
    const args = m[2];
    const isCmd = !!cmd && (SCRIPT[cmd] || ALIASES[cmd] || SUGGESTIONS.includes(cmd));
    return { cmd, args, isCmd };
  }, [input]);

  return (
    <div
      className="flex flex-col h-full bg-[#0c0e14] text-[#cdd6f4] font-mono"
      onClick={() => inputRef.current?.focus()}
    >
      <PanelHeader
        icon="terminal"
        title={
          <span className="flex items-center gap-2">
            <span className="text-[#a6e3a1]">●</span> 终端
          </span>
        }
        count={`${lines.length} 行 · ${history.length} 历史`}
        action={
          <>
            <Tooltip content={tip}>
              <span className="text-[10px] text-[#6c7086] mr-2 max-w-[200px] truncate">{tip}</span>
            </Tooltip>
            <Tooltip content="查看历史 (命令面板)">
              <IconButton icon="history" size="xs" onClick={() => setShowHistoryModal(true)} />
            </Tooltip>
            <Tooltip content="复制全部输出">
              <IconButton icon="content_copy" size="xs" onClick={() => {
                const text = lines.map(l => l.text).join('\n');
                navigator.clipboard?.writeText(text);
                push({ kind: 'ok', text: `已复制 ${lines.length} 行到剪贴板` });
              }} />
            </Tooltip>
            <Tooltip content="清空 (Ctrl+L)">
              <IconButton icon="delete_sweep" size="xs" onClick={() => setLines([])} />
            </Tooltip>
            <Tooltip content="运行 npm run dev">
              <IconButton icon="play_arrow" size="xs" onClick={() => run('npm run dev')} />
            </Tooltip>
            <Tooltip content={realMode ? '真实模式 (连接后端)' : '本地模拟模式'}>
              <button
                onClick={() => setRealMode(m => !m)}
                className={`flex items-center gap-1 px-1.5 h-6 rounded text-[10px] font-mono border transition-colors ${
                  realMode
                    ? 'bg-primary/15 text-primary border-primary/40'
                    : 'bg-bg-dim text-text-secondary border-border-light'
                }`}
              >
                <span className="material-symbols-outlined text-xs">{realMode ? 'cloud_done' : 'computer'}</span>
                {realMode ? '真实' : '模拟'}
              </button>
            </Tooltip>
          </>
        }
      />

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 text-[11px] leading-relaxed scrollbar-thin">
        {lines.map(l => <LineView key={l.id} line={l} />)}
        <div className="flex flex-col gap-0.5 mt-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[#a6e3a1]">➜</span>
            <span className="text-[#89b4fa]">soloforge</span>
            <span className="text-[#6c7086]">on</span>
            <span className="text-[#f5c2e7]">main</span>
            {/* 关键字高亮 preview */}
            {input && inputTokens && (
              <span className="ml-1">
                <span className={inputTokens.isCmd ? 'text-[#a6e3a1]' : 'text-[#f38ba8]'}>
                  {inputTokens.cmd}
                </span>
                <span className="text-[#cdd6f4]">{inputTokens.args}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              ref={inputRef}
              value={input}
              onChange={e => { setInput(e.target.value); setTabIdx(0); }}
              onKeyDown={onKey}
              spellCheck={false}
              autoComplete="off"
              className="flex-1 bg-transparent outline-none text-transparent caret-[#f5c2e7]"
              placeholder="输入命令并回车..."
              style={{ caretColor: '#f5c2e7' }}
            />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 px-3 h-7 bg-[#0a0c12] border-t border-[#1e2030] text-[10px] text-[#6c7086] shrink-0 overflow-x-auto scrollbar-hide">
        <span className="shrink-0">↑↓ 历史</span>
        <span className="text-[#45475a]">·</span>
        <span className="shrink-0">Tab 补全</span>
        <span className="text-[#45475a]">·</span>
        <span className="shrink-0">Ctrl+L 清屏</span>
        <span className="text-[#45475a]">·</span>
        <span className="shrink-0">Ctrl+C 中断</span>
        <div className="flex-1" />
        {Object.keys(env).slice(0, 3).map(k => (
          <span key={k} className="px-1 py-0.5 rounded bg-[#1e2030] text-[#cdd6f4] shrink-0 font-mono">
            {k}={env[k]}
          </span>
        ))}
      </div>

      {/* 命令历史 modal */}
      {showHistoryModal && (
        <div
          className="fixed inset-0 z-[220] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in p-4"
          onClick={() => setShowHistoryModal(false)}
        >
          <div
            className="w-[480px] max-w-[90vw] max-h-[70vh] bg-[#0c0e14] border border-[#1e2030] rounded-xl shadow-2xl flex flex-col overflow-hidden animate-slide-in-up"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 h-9 border-b border-[#1e2030]">
              <span className="text-xs font-semibold text-[#cdd6f4] flex items-center gap-2">
                <span className="material-symbols-outlined text-sm">history</span>
                命令历史 · {history.length} 条
              </span>
              <button
                onClick={() => { setHistory([]); localStorage.removeItem(HIST_KEY); }}
                className="text-[10px] text-[#f38ba8] hover:underline"
              >清空</button>
            </div>
            <div className="flex-1 overflow-y-auto p-1 scrollbar-thin">
              {history.length === 0 ? (
                <div className="px-3 py-6 text-center text-[10px] text-[#6c7086]">(无历史)</div>
              ) : history.map((h, i) => (
                <div
                  key={i}
                  onClick={() => { setInput(h); setShowHistoryModal(false); inputRef.current?.focus(); }}
                  className="group flex items-center gap-2 px-2 py-1 text-[11px] hover:bg-[#1e2030] rounded cursor-pointer"
                >
                  <span className="text-[#6c7086] font-mono w-8 text-right shrink-0">{i + 1}</span>
                  <span className="text-[#a6e3a1] font-mono shrink-0">{h.split(/\s+/)[0]}</span>
                  <span className="text-[#cdd6f4] truncate flex-1">{h.split(/\s+/).slice(1).join(' ')}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); setInput(h); }}
                    className="material-symbols-outlined text-[10px] text-[#6c7086] opacity-0 group-hover:opacity-100"
                    title="填入"
                  >north_east</button>
                </div>
              ))}
            </div>
            <div className="px-3 h-8 border-t border-[#1e2030] flex items-center justify-between text-[10px] text-[#6c7086]">
              <span>点击历史项可填入输入框</span>
              <span>持久化 · 上限 100 条</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LineView({ line }: { line: Line }) {
  const colorMap: Record<Line['kind'], string> = {
    in:  'text-[#f5c2e7]',
    out: 'text-[#cdd6f4]',
    err: 'text-[#f38ba8]',
    sys: 'text-[#6c7086]',
    ok:  'text-[#a6e3a1]',
  };
  const prefixMap: Record<Line['kind'], string> = {
    in:  '$ ',
    out: '',
    err: '✗ ',
    sys: '› ',
    ok:  '✓ ',
  };
  return (
    <div className={`${colorMap[line.kind]} whitespace-pre-wrap break-words`}>
      <span className="text-[#585b70] mr-2 select-none">
        {new Date(line.ts).toLocaleTimeString('zh-CN', { hour12: false })}
      </span>
      <span className="opacity-70">{prefixMap[line.kind]}</span>
      {line.text}
    </div>
  );
}
