/**
 * commandPolicy — AI 触发的 shell 命令分级 [PATCHED]
 *
 * 三类输出:
 *   risk 'deny'        → 硬拦截, 任何模式都不允许
 *   risk 'mutate'      → 写盘/联网, 默认需要 confirm
 *   risk 'read'        → 静默执行
 *
 * 安全加固 (2026-07-11):
 *   - DENY_KEYWORDS 改为正则精确语义匹配 (非子串)
 *   - 新增 SHELL_INJECTION_PATTERNS 检测
 *   - 未知命令默认 deny (原为 mutate)
 *   - 新增 extractBaseCommand() 处理 sudo/env 等前缀
 */

export type PermissionMode = 'normal' | 'performance' | 'ultimate' | 'expert';

export type RiskLevel = 'read' | 'mutate' | 'deny';

export interface PolicyDecision {
  risk: RiskLevel;
  reasons: string[];
  matchedKeyword?: string;
  requiresConfirm: boolean;
  blocked: boolean;
  label: string;
}

const READ_COMMANDS = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'less', 'more',
  'pwd', 'echo', 'whoami', 'date', 'uname', 'hostname',
  'node', 'npm', 'python', 'pip', 'python3', 'pip3',
  'git', 'curl', 'wget', 'find', 'grep', 'awk', 'sed',
  'which', 'whereis', 'env', 'printenv', 'id', 'uptime',
  'df', 'du', 'free', 'top', 'ps', 'wc', 'sort', 'uniq',
  'tree', 'file', 'stat', 'basename', 'dirname', 'realpath',
  'readlink', 'xargs', 'tee', 'cut', 'tr', 'base64', 'md5sum',
  'sha256sum', 'jq', 'diff', 'patch', 'tar', 'zip', 'unzip',
]);

const MUTATE_COMMANDS = new Set([
  'npm', 'yarn', 'pnpm', 'pip', 'pip3', 'python', 'python3',
  'mkdir', 'touch', 'cp', 'mv', 'ln', 'chmod', 'chown',
  'git', 'cargo', 'go', 'composer', 'gem', 'nuget',
  'conda', 'docker', 'kubectl', 'terraform', 'ansible',
  'rsync', 'scp', 'aws', 'gcloud', 'az',
]);

const DENY_PATTERNS = [
  /\brm\s+-[a-zA-Z]*rf\b/i,
  /\brm\s+-[a-zA-Z]*r[f\s]/i,
  /\bdel\s+\/[sfq]/i,
  /\brmdir\s+\/[sq]/i,
  /\bformat\b/i,
  /\bmkfs\./i,
  /\bdd\s+if=/i,
  /\breg\s+(delete|add)\b/i,
  /\bshutdown\b/i,
  /\brestart\b/i,
  /\btaskkill\b.*\/[f]\b/i,
  /\bnet\s+(user|localgroup)\b/i,
  /\bwbadmin\b.*delete/i,
  /\bvssadmin\b.*delete/i,
  /\bdiskpart\b/i,
  /\bbcdedit\b/i,
  /\b:\(\)\{:\|:&\}\;:/,
  /\bpowershell\s+-[eE][Nn][Cc]\b/i,
  /\binvoke-webrequest\b/i,
  /\biwr\s/i,
  />\s*\/dev\/sd[a-z]/i,
  />\s*\/dev\/[a-z]*disk/i,
  /mkfifo/i,
  /nc\s+-[lp]/i,
  /\bssh\s/i,
  /\bssh-keygen\b/i,
];

const SHELL_INJECTION_PATTERNS: RegExp[] = [
  /\$\(/,
  /`[^`]+`/,
  /\$\{[^}]+\}/,
  /\|\s*(bash|sh|zsh|ksh|csh|tcsh|pwsh|fish)\b/i,
  /;\s*(rm|del|format|shutdown|mkfs|dd)\b/i,
  /\$'[^']*'/,
  /(?:^|[\s;|&])(?:eval|exec|source|\.)\s+/i,
  /base64\s+[-d].*\|\s*(bash|sh)/i,
  /\bxargs\s+.*(-I|-i|--replace)/i,
];

const NETWORK_OUT_TARGETS = [
  /^curl\b[^\s]*\s-X\s*(POST|PUT|PATCH|DELETE)\b/i,
  /^curl\b[^\s]*\s-d\b/i,
  /^curl\b[^\s]*--data\b/i,
  /^curl\b[^\s]*--upload-file\b/i,
  /^wget\b[^\s]*--post/i,
];

const NETWORK_UPLOAD_HINT = /\bcurl\b[^\s]*\s-X\s*POST\b/i;

function detectObfuscation(command: string): string | null {
  for (const pattern of SHELL_INJECTION_PATTERNS) {
    if (pattern.test(command)) {
      return `检测到可疑模式: ${pattern.source}`;
    }
  }
  return null;
}

function extractBaseCommand(command: string): string | null {
  const trimmed = command.trim();
  const prefixes = /^(sudo|doas|env|nohup|timeout|nice|ionice|taskset|chroot|linux32|linux64)\s+/;
  const withoutPrefix = trimmed.replace(prefixes, '');
  const match = withoutPrefix.match(/^([^\s;|&<>]+)/);
  return match ? match[1].toLowerCase() : null;
}

export function evaluateCommand(command: string, mode: PermissionMode = 'normal'): PolicyDecision {
  const raw = (command ?? '').trim();
  if (!raw) return { risk: 'read', reasons: ['empty'], requiresConfirm: false, blocked: false, label: '空' };

  const obfuscation = detectObfuscation(raw);
  if (obfuscation) {
    return {
      risk: 'deny',
      reasons: [obfuscation],
      matchedKeyword: 'injection-pattern',
      requiresConfirm: false,
      blocked: true,
      label: '命令混淆/注入',
    };
  }

  for (const pattern of DENY_PATTERNS) {
    if (pattern.test(raw)) {
      return {
        risk: 'deny',
        reasons: [`命中危险模式: ${pattern.source}`],
        matchedKeyword: pattern.source,
        requiresConfirm: false,
        blocked: true,
        label: '硬拦截',
      };
    }
  }

  const baseCmd = extractBaseCommand(raw);

  if (baseCmd && READ_COMMANDS.has(baseCmd)) {
    if (/>\s*[^>]/.test(raw) && !/[>|]\s*&?1?$/.test(raw)) {
      return {
        risk: 'mutate',
        reasons: [`读命令含文件重定向: ${baseCmd}`],
        matchedKeyword: baseCmd,
        requiresConfirm: requiresMutateConfirm(mode),
        blocked: false,
        label: '读+写重定向',
      };
    }
    return {
      risk: 'read',
      reasons: [`只读: ${baseCmd}`],
      matchedKeyword: baseCmd,
      requiresConfirm: false,
      blocked: false,
      label: '只读',
    };
  }

  if (baseCmd && MUTATE_COMMANDS.has(baseCmd)) {
    if (NETWORK_OUT_TARGETS.some(re => re.test(raw))) {
      return {
        risk: 'mutate',
        reasons: [`写盘+网络外发: ${baseCmd}`],
        matchedKeyword: baseCmd,
        requiresConfirm: true,
        blocked: false,
        label: '写盘+外网',
      };
    }
    return {
      risk: 'mutate',
      reasons: [`写盘/安装: ${baseCmd}`],
      matchedKeyword: baseCmd,
      requiresConfirm: requiresMutateConfirm(mode),
      blocked: false,
      label: '写盘/安装',
    };
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
    risk: 'deny',
    reasons: [`未知命令: ${baseCmd || '(无法解析)'}`, '不在白名单中，需要手动确认'],
    matchedKeyword: baseCmd || 'unknown',
    requiresConfirm: false,
    blocked: mode === 'normal',
    label: '未知命令',
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

export const POLICY_CONFIG: {
  READ_COMMANDS: Set<string>;
  MUTATE_COMMANDS: Set<string>;
  DENY_PATTERNS: RegExp[];
  SHELL_INJECTION_PATTERNS: RegExp[];
} = {
  READ_COMMANDS,
  MUTATE_COMMANDS,
  DENY_PATTERNS,
  SHELL_INJECTION_PATTERNS,
};

/** @deprecated 使用 POLICY_CONFIG 代替 */
export const POLICY_KW = POLICY_CONFIG;
