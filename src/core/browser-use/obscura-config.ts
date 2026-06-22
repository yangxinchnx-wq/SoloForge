// ============================================================
// Obscura 子进程配置 (Node 端镜像)
// ============================================================
//
// python/browser_use_service/ 内部自己管 Obscura 进程, 这里只暴露
// 启动配置给 Electron 主进程 / 调试面板看

import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

export interface ObscuraConfig {
  binaryPath: string;
  port: number;
  host: string;
  stealth: boolean;
  storageDir: string;
  startupTimeoutMs: number;
  startupRetries: number;
  startupRetryBackoffMs: number;
}

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

function defaultBinaryPath(): string {
  const candidates = [
    join(REPO_ROOT, 'UI', 'resources', 'tools', 'obscura', 'bin', 'obscura.exe'),
    join(REPO_ROOT, 'UI', 'resources', 'tools', 'obscura', 'bin', 'obscura'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'obscura';
}

export function loadObscuraConfig(): ObscuraConfig {
  return {
    binaryPath: process.env.SOLOFORGE_OBSCURA_BINARY || defaultBinaryPath(),
    port: Number(process.env.SOLOFORGE_OBSCURA_PORT ?? 9222),
    host: process.env.SOLOFORGE_OBSCURA_HOST ?? '127.0.0.1',
    stealth: (process.env.SOLOFORGE_OBSCURA_STEALTH ?? '1') !== '0',
    storageDir: process.env.SOLOFORGE_OBSCURA_STORAGE ?? '',
    startupTimeoutMs: Number(process.env.SOLOFORGE_OBSCURA_TIMEOUT_MS ?? 30000),
    startupRetries: Number(process.env.SOLOFORGE_OBSCURA_RETRIES ?? 3),
    startupRetryBackoffMs: Number(process.env.SOLOFORGE_OBSCURA_BACKOFF_MS ?? 2000),
  };
}

export function buildObscuraArgs(cfg: ObscuraConfig): string[] {
  const args = [
    'serve',
    '--port', String(cfg.port),
    '--host', cfg.host,
  ];
  if (cfg.stealth) args.push('--stealth');
  if (cfg.storageDir) args.push('--storage', cfg.storageDir);
  return args;
}
