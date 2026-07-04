// scripts/api-e2b-stub.ts
// 极简后端 stub, 实现前端 E2BService 需要的 3 个接口.
// 目的: 在端到端测试时给前端一个真实可 fetch 的 e2b 后端.
// 不动 src/api-server.ts, 不替代生产路由.
//
//   POST /api/e2b/sandbox              -> { sandbox_id }
//   POST /api/e2b/sandbox/:id/execute  -> { sandbox_id, command, stdout, stderr, exit_code, execution_time_ms }
//   GET  /health                       -> { ok: true, port }
//
// 沙箱 = 一次 child_process.exec (带 cwd + timeout + maxBuffer).
// 每个 sandboxId 记录初次创建时间 + workdir, 但执行时由请求体里的 cwd 决定本次 cwd.

import http from 'http';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const exec = promisify(execCb);

const PORT = Number(process.env.E2B_STUB_PORT || 3001);
const DEFAULT_CWD = process.env.E2B_STUB_CWD || path.join(os.homedir(), 'SoloForge');

function resolveShell(): string {
  if (process.platform !== 'win32') return '/bin/sh';
  if (process.env.E2B_STUB_SHELL) return process.env.E2B_STUB_SHELL;
  if (process.env.ComSpec && fs.existsSync(process.env.ComSpec)) return process.env.ComSpec;
  const candidates = [
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'cmd.exe',
    'powershell.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'cmd.exe';
}

interface SandboxRecord {
  id: string;
  chatId: string;
  createdAt: number;
  workdir: string;
}

const sandboxes = new Map<string, SandboxRecord>();

function json(res: http.ServerResponse, status: number, body: any): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const p = url.pathname;

  if (req.method === 'GET' && p === '/health') {
    json(res, 200, { ok: true, port: PORT, sandboxes: sandboxes.size });
    return;
  }

  if (req.method === 'POST' && p === '/api/e2b/sandbox') {
    const body = await readJson(req).catch(() => ({}));
    const chatId = String(body.chatId || `anon-${randomUUID().slice(0, 8)}`);
    const id = `sb-${randomUUID().slice(0, 8)}`;
    const rec: SandboxRecord = {
      id,
      chatId,
      createdAt: Date.now(),
      workdir: typeof body.workdir === 'string' ? body.workdir : DEFAULT_CWD,
    };
    sandboxes.set(id, rec);
    json(res, 200, { sandbox_id: id, chat_id: chatId, workdir: rec.workdir });
    return;
  }

  const m = p.match(/^\/api\/e2b\/sandbox\/([^/]+)\/execute$/);
  if (req.method === 'POST' && m) {
    const sandboxId = m[1];
    const rec = sandboxes.get(sandboxId);
    if (!rec) {
      json(res, 404, { detail: `sandbox not found: ${sandboxId}` });
      return;
    }
    const body = await readJson(req).catch(() => ({}));
    const command = String(body.command || '');
    const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : rec.workdir;
    const timeoutMs = Number(body.timeout) || 30_000;

    if (!command) {
      json(res, 400, { detail: 'command is required' });
      return;
    }

    const t0 = Date.now();
    const isWin = process.platform === 'win32';
    const shell = process.env.E2B_STUB_SHELL || (isWin ? undefined : '/bin/sh');
    try {
      const { stdout, stderr } = await exec(command, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        shell,
        ...(isWin ? {} : { env: { ...process.env, LANG: 'en_US.UTF-8' } }),
      });
      json(res, 200, {
        sandbox_id: sandboxId,
        command,
        cwd,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        exit_code: 0,
        execution_time_ms: Date.now() - t0,
      });
    } catch (err: any) {
      json(res, 200, {
        sandbox_id: sandboxId,
        command,
        cwd,
        stdout: err?.stdout ?? '',
        stderr: (err?.stderr ? err.stderr : String(err?.message ?? err)) ?? '',
        exit_code: typeof err?.code === 'number' ? err.code : 1,
        execution_time_ms: Date.now() - t0,
      });
    }
    return;
  }

  json(res, 404, { detail: `route not found: ${req.method} ${p}` });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    try { json(res, 500, { detail: String(err?.message ?? err) }); } catch { /* ignore */ }
  });
});

server.listen(PORT, () => {
  console.log(`[e2b-stub] listening on http://localhost:${PORT}`);
  console.log(`[e2b-stub] default workdir: ${DEFAULT_CWD}`);
  console.log(`[e2b-stub] shell: ${resolveShell()}`);
});

const shutdown = (sig: string) => () => {
  console.log(`[e2b-stub] ${sig} received, closing`);
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown('SIGINT'));
process.on('SIGTERM', shutdown('SIGTERM'));
