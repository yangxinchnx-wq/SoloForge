// ─────────────────────────────────────────────────────────────────
// 终端 API 客户端
// - 通过 WebSocket 与后端通信 (mock 时使用本地模拟)
// - 流式返回 stdout/stderr
// - 支持 abort / exit code
// - 持久化: 最近 20 条命令历史 (跨终端面板)
// ─────────────────────────────────────────────────────────────────

import { API_BASE } from './client';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  command: string;
}

export type ExecEvent =
  | { type: 'start'; command: string; pid?: number }
  | { type: 'stdout'; chunk: string; ts: number }
  | { type: 'stderr'; chunk: string; ts: number }
  | { type: 'exit'; code: number; durationMs: number }
  | { type: 'error'; message: string };

const HISTORY_KEY = 'soloforge.terminal.realHistory';

export function loadRealHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}
export function saveRealHistory(h: string[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 20))); } catch { /* ignore */ }
}

// ─── 检测后端是否可达 ───
let backendAvailable: boolean | null = null;
export async function checkBackend(): Promise<boolean> {
  if (backendAvailable !== null) return backendAvailable;
  try {
    const r = await fetch(`${API_BASE}/api/health`, { method: 'GET' });
    backendAvailable = r.ok;
  } catch {
    backendAvailable = false;
  }
  return backendAvailable;
}

// ─── Mock 命令执行 (前端) ───
function mockExecute(command: string, onEvent: (e: ExecEvent) => void): AbortController {
  const abort = new AbortController();
  const start = Date.now();
  const [cmd, ...args] = command.split(/\s+/);
  const out = (s: string) => onEvent({ type: 'stdout', chunk: s, ts: Date.now() });
  const err = (s: string) => onEvent({ type: 'stderr', chunk: s, ts: Date.now() });

  // 模拟执行
  const delay = (ms: number) => new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    abort.signal.addEventListener('abort', () => { clearTimeout(t); r(); });
  });

  (async () => {
    onEvent({ type: 'start', command });
    switch (cmd) {
      case 'echo':
        out(args.join(' ') + '\n');
        break;
      case 'pwd':
        out('/soloforge/ui\n');
        break;
      case 'ls': {
        const files = [
          'src/',
          '├── api/',
          '├── components/',
          '├── hooks/',
          '├── themes/',
          '├── types/',
          '└── App.tsx',
          'package.json   vite.config.ts   README.md',
        ];
        if (args.includes('-l')) {
          files.unshift('total 48');
          files.push('drwxr-xr-x  8 yangx  staff   256B  6月  5 10:00 src/');
        }
        for (const f of files) out(f + '\n');
        break;
      }
      case 'cat': {
        const f = args[0] || '';
        out(`─── ${f} ───\n`);
        out('// (mock file content)\n');
        out('export const version = "1.0.0";\n');
        out('export const kernel = { status: "OK" };\n');
        break;
      }
      case 'date':
        out(new Date().toString() + '\n');
        out(new Date().toISOString() + '\n');
        break;
      case 'whoami':
        out('yangx\n');
        break;
      case 'uptime': {
        const s = Math.floor((Date.now() - 0) / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        out(`up ${h}h ${m}m, 1 user, load: 0.42 0.38 0.31\n`);
        break;
      }
      case 'df': {
        out('Filesystem      Size  Used Avail Use% Mounted on\n');
        out('/dev/sda1       256G  48G  208G  19% /\n');
        out('/dev/sda2       512G  82G  430G  17% /soloforge\n');
        break;
      }
      case 'free': {
        out('              total        used        free\n');
        out('Mem:        33554432    8402000    12400000\n');
        out('Swap:        8388608           0     8388608\n');
        break;
      }
      case 'env':
        out('USER=yangx\n');
        out('HOST=soloforge-dev\n');
        out('SHELL=/bin/zsh\n');
        out('PATH=/usr/local/bin:/usr/bin:/bin\n');
        break;
      case 'git':
        if (args[0] === 'log') {
          out('* a3f21b8  (HEAD -> main) feat: 增加终端面板\n');
          out('* 8c9e122  fix: 修复代理路径问题\n');
          out('* b4f6d05  chore: 更新依赖\n');
          out('* e7d8a91  docs: 补充 README\n');
          out('* c2b1f44  refactor: 拆分 useChat hook\n');
        } else if (args[0] === 'status') {
          out('On branch main\n');
          out('Your branch is up to date with \'origin/main\'.\n');
          out('\n');
          out('Changes not staged for commit:\n');
          out('  modified:   src/index.ts\n');
          out('  modified:   src/api-server.ts\n');
        } else if (args[0] === 'diff') {
          out('diff --git a/src/index.ts b/src/index.ts\n');
          out('@@ -10,7 +10,7 @@\n');
          out('- const x = 1;\n');
          out('+ const x = 2;\n');
        } else {
          err(`git: '${args[0] || ''}' is not a git command\n`);
          onEvent({ type: 'exit', code: 1, durationMs: Date.now() - start });
          return;
        }
        break;
      case 'npm':
        if (args[0] === 'run') {
          out(`> soloforge@1.0.0 ${args[1] || 'dev'}\n`);
          await delay(300);
          out('VITE v5.4.0  ready in 234 ms\n');
          out('  ➜  Local:   http://localhost:5173/\n');
          if (args[1] === 'build') {
            out('✓ built in 2.5s\n');
          } else {
            out('✓ running...\n');
            // 长任务, 用户需要 abort
            await delay(2000);
            out('[稍后]\n');
          }
        } else if (args[0] === 'install' || args[0] === 'i') {
          out('added 0 packages in 2s\n');
        } else {
          err(`npm: '${args[0] || ''}' is not a npm command\n`);
          onEvent({ type: 'exit', code: 1, durationMs: Date.now() - start });
          return;
        }
        break;
      case 'curl':
        out(`(mock) ${args.join(' ')}\n`);
        out('HTTP/1.1 200 OK\n');
        out('Content-Type: application/json\n');
        out('\n');
        out('{"ok": true}\n');
        break;
      case 'ping':
        out(`PING ${args[0] || 'localhost'}: 56 data bytes\n`);
        for (let i = 0; i < 4; i++) {
          await delay(150);
          out(`64 bytes from ${args[0] || 'localhost'}: icmp_seq=${i} ttl=64 time=${(Math.random() * 20).toFixed(1)} ms\n`);
        }
        out('--- statistics ---\n');
        out('4 packets transmitted, 4 received, 0% packet loss\n');
        break;
      case 'ps':
        out('  PID TTY          TIME CMD\n');
        out(' 1234 pts/0    00:00:01 zsh\n');
        out(' 5678 pts/0    00:00:00 soloforge\n');
        out(' 9012 pts/0    00:00:00 node\n');
        break;
      case 'kill':
        out(`(mock) killed ${args[0]}\n`);
        break;
      case 'uname':
        out('SoloForge v1.0.0 (mock)\n');
        break;
      case 'hostname':
        out('soloforge-dev\n');
        break;
      case 'ifconfig':
      case 'ip':
        out('eth0: flags=4163<UP,BROADCAST,RUNNING>  mtu 1500\n');
        out('  inet 192.168.1.42  netmask 255.255.255.0\n');
        break;
      case 'top':
        out('top - ' + new Date().toLocaleTimeString() + '  up 2:14,  1 user,  load average: 0.42, 0.38, 0.31\n');
        out('Tasks:  87 total,   1 running,  86 sleeping\n');
        out('%Cpu(s):  4.3 us,  1.2 sy,  0.0 ni, 94.5 id\n');
        out('MiB Mem :  32768 total,   8205 used,  24563 free\n');
        break;
      case 'exit':
        out('(session ended)\n');
        break;
      default:
        err(`command not found: ${cmd}（输入 help 查看可用命令）\n`);
        onEvent({ type: 'exit', code: 127, durationMs: Date.now() - start });
        return;
    }
    onEvent({ type: 'exit', code: 0, durationMs: Date.now() - start });
  })();

  return abort;
}

// ─── 真实执行 (尝试 WebSocket) ───
async function realExecute(command: string, onEvent: (e: ExecEvent) => void): Promise<AbortController | null> {
  // 由于后端尚未实现 WebSocket 终端协议, 暂时全部走 mock
  // 保留接口以便未来对接
  if (!API_BASE) return null;
  return null;
}

// ─── 公共执行入口 ───
export async function executeCommand(
  command: string,
  onEvent: (e: ExecEvent) => void,
  useReal: boolean = false,
): Promise<{ abort: AbortController; real: boolean }> {
  // 真实模式: 尝试用 WebSocket 连接后端
  if (useReal) {
    const real = await realExecute(command, onEvent);
    if (real) return { abort: real, real: true };
  }
  // 否则走 mock
  const abort = mockExecute(command, onEvent);
  return { abort, real: false };
}

// ─── 危险命令拦截 ───
const DANGEROUS = ['rm -rf', 'mkfs', 'dd if=', ':(){:|:&};:'];
export function isDangerous(command: string): boolean {
  return DANGEROUS.some(d => command.includes(d));
}
