/**
 * commandPolicy — AI 触发的 shell 命令分级
 *
 * 三类输出:
 *   risk 'deny'        → 硬拦截, 任何模式都不允许 (del /s, format, rm -rf, reg delete, ssh 命令, ...)
 *   risk 'mutate'      → 写盘/联网, 默认需要 confirm, 看 permissionMode 决定是否自动通过
 *   risk 'read'        → 静默执行
 *
 * 与 permissionMode 对齐 (App.tsx 里已有的 normal/performance/ultimate/expert):
 *   normal      → mutate 全部 confirm, even `npm install`
 *   performance → mutate 默认通过, 网络外发仍 confirm
 *   ultimate    → mutate 默认通过, 仅 deny + workdir-traversal confirm
 *   expert      → 大部分 mutate 通过, 仅 deny + 范围外 confirm
 *
 * 这是纯函数模块, 不依赖 React / fetch, 方便单测.
 */

export type PermissionMode = 'normal' | 'performance' | 'ultimate' | 'expert';

export type RiskLevel = 'read' | 'mutate' | 'deny';

export interface PolicyDecision {
  risk: RiskLevel;
  reasons: string[];
  matchedKeyword?: string;
  /** 当前 mode 下需要 confirm? */
  requiresConfirm: boolean;
  /** 强制拦截 (无论 mode) */
  blocked: boolean;
  /** 给 UI 显示的简短标签 */
  label: string;
}

const READ_KEYWORDS = [
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'less', 'more',
  'pwd', 'cd', 'echo', 'whoami', 'date', 'uname', 'hostname',
  'git status', 'git log', 'git diff', 'git branch', 'git remote',
  'node -v', 'node --version', 'npm -v', 'python --version',
  'curl -i', 'curl -I',
];

const NETWORK_UPLOAD_HINT = /\bcurl\b[^\n]*\s-X\s*POST\b/i;

const MUTATE_KEYWORDS = [
  'npm install', 'npm i ', 'npm add',
  'yarn add', 'yarn install',
  'pnpm add', 'pnpm install',
  'pip install', 'pip3 install',
  'mkdir', 'touch', 'cp -r', 'mv ', 'echo >', 'tee ',
  'git add', 'git commit', 'git push', 'git pull --rebase',
];

const DENY_KEYWORDS = [
  'rmdir /s', 'rd /s',
  'del /f', 'del /q', 'del /s',
  'erase',
  'format',
  'reg delete', 'reg add',
  'shutdown', 'restart', 'taskkill /f',
  'net user', 'net localgroup',
  'wbadmin delete',
  'vssadmin delete',
  'diskpart',
  'bcdedit',
  'rm -rf', 'rm -fr',
  'mkfs',
  'dd if=',
  ':(){:|:&};:',                      // fork bomb
  'curl --upload-file',
  'powershell -enc',
  'iwr ', 'invoke-webrequest',         // PS 出网直传
  'scp ', 'rsync ',                   // 跨机传输, 容易外泄
  'ssh ', 'ssh-keygen',
];

const NETWORK_OUT_TARGETS = [
  /^curl\b[^\n]*\s-X\s*(POST|PUT|PATCH|DELETE)\b/i,
  /^curl\b[^\n]*\s-d\b/i,
  /^curl\b[^\n]*--data\b/i,
  /^curl\b[^\n]*--upload-file\b/i,
  /^wget\b[^\n]*--post/i,
];

export function evaluateCommand(command: string, mode: PermissionMode = 'normal'): PolicyDecision {
  const raw = (command ?? '').trim();
  if (!raw) return { risk: 'read', reasons: ['empty'], requiresConfirm: false, blocked: false, label: '空' };

  const low = raw.toLowerCase();

  for (const kw of DENY_KEYWORDS) {
    if (low.includes(kw.toLowerCase())) {
      return {
        risk: 'deny',
        reasons: [`命中拒绝关键词: ${kw}`],
        matchedKeyword: kw,
        requiresConfirm: false,
        blocked: true,
        label: '硬拦截',
      };
    }
  }

  if (NETWORK_OUT_TARGETS.some(re => re.test(raw))) {
    return {
      risk: 'mutate',
      reasons: ['外网写操作 (curl POST / 任意 --data)'],
      requiresConfirm: true,
      blocked: false,
      label: '网络外发',
    };
  }

  let mutated = false;
  const mutateReasons: string[] = [];
  for (const kw of MUTATE_KEYWORDS) {
    if (low.includes(kw.toLowerCase())) {
      mutated = true;
      mutateReasons.push(kw.trim());
    }
  }
  if (mutated) {
    return {
      risk: 'mutate',
      reasons: mutateReasons,
      requiresConfirm: requiresMutateConfirm(mode),
      blocked: false,
      label: '写盘/安装',
    };
  }

  for (const kw of READ_KEYWORDS) {
    if (low.includes(kw.toLowerCase())) {
      return {
        risk: 'read',
        reasons: [`只读: ${kw.trim()}`],
        requiresConfirm: false,
        blocked: false,
        label: '只读',
      };
    }
  }

  if (NETWORK_UPLOAD_HINT.test(raw)) {
    return {
      risk: 'mutate',
      reasons: ['网络外发 (curl POST)'],
      requiresConfirm: requiresMutateConfirm(mode),
      blocked: false,
      label: '网络外发',
    };
  }

  return {
    risk: 'mutate',
    reasons: ['未匹配白名单, 保守为写盘'],
    requiresConfirm: requiresMutateConfirm(mode),
    blocked: false,
    label: '未识别',
  };
}

function requiresMutateConfirm(mode: PermissionMode): boolean {
  switch (mode) {
    case 'normal':      return true;
    case 'performance': return false;
    case 'expert':      return false;
    case 'ultimate':    return false;
    default:            return true;
  }
}

export const POLICY_KW: { READ: string[]; MUTATE: string[]; DENY: string[] } = {
  READ: READ_KEYWORDS,
  MUTATE: MUTATE_KEYWORDS,
  DENY: DENY_KEYWORDS,
};
