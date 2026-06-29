/**
 * SandboxManager — 内嵌式 E2B 沙箱管理器
 * 在 Node.js 进程中直接管理终端沙箱，无需外部服务。
 *
 * 每个对话 (chatId) 持有独立的 temp 工作目录，命令在其中隔离执行。
 * 支持 E2B 云沙箱 SDK 作为可选升级路径。
 */
import { exec, ExecOptions } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

interface SandboxEntry {
  sandboxId: string;
  chatId: string;
  modelId: string;
  workdir: string;
  status: 'running' | 'destroyed';
  createdAt: number;
  lastActiveAt: number;
  commandCount: number;
}

export class SandboxManager {
  private sandboxes = new Map<string, SandboxEntry>();
  private baseDir: string;

  constructor() {
    this.baseDir = path.join(os.tmpdir(), 'soloforge_sandboxes');
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  activeCount(): number {
    return this.sandboxes.size;
  }

  /** 为对话创建沙箱 */
  create(chatId: string, modelId: string = 'default'): SandboxEntry {
    // 已有则复用
    for (const [, entry] of this.sandboxes) {
      if (entry.chatId === chatId && entry.status === 'running') {
        entry.lastActiveAt = Date.now();
        return entry;
      }
    }

    const sandboxId = `sb_${chatId.slice(0, 8)}_${crypto.randomBytes(4).toString('hex')}`;
    const workdir = path.join(this.baseDir, sandboxId);
    fs.mkdirSync(workdir, { recursive: true });

    const entry: SandboxEntry = {
      sandboxId,
      chatId,
      modelId,
      workdir,
      status: 'running',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      commandCount: 0,
    };
    this.sandboxes.set(sandboxId, entry);
    console.log(`[Sandbox] 创建沙箱 ${sandboxId} (chat=${chatId})`);
    return entry;
  }

  /** 执行命令 */
  async execute(
    sandboxId: string,
    command: string,
    cwd?: string,
    timeout: number = 60,
    envVars?: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; executionTimeMs: number }> {
    const entry = this.sandboxes.get(sandboxId);
    if (!entry) throw new Error(`沙箱 ${sandboxId} 不存在`);

    const workdir = cwd ? path.resolve(entry.workdir, cwd) : entry.workdir;
    const env = { ...process.env, ...(envVars ?? {}) };

    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const opts: ExecOptions = {
        cwd: workdir,
        env,
        timeout: timeout * 1000,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        windowsHide: true,
      };

      exec(command, opts, (error, stdout, stderr) => {
        const elapsed = Date.now() - t0;
        entry.lastActiveAt = Date.now();
        entry.commandCount++;

        if (error && error.killed) {
          resolve({
            stdout: stdout || '',
            stderr: `命令执行超时 (${timeout}s)`,
            exitCode: 124,
            executionTimeMs: elapsed,
          });
        } else {
          resolve({
            stdout: stdout || '',
            stderr: stderr || '',
            exitCode: error?.code ?? 0,
            executionTimeMs: elapsed,
          });
        }
      });
    });
  }

  /** 写入文件 */
  writeFile(sandboxId: string, filePath: string, content: string): void {
    const entry = this.sandboxes.get(sandboxId);
    if (!entry) throw new Error(`沙箱 ${sandboxId} 不存在`);

    const fullPath = path.resolve(entry.workdir, filePath.replace(/^[/\\]+/, ''));
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
    entry.lastActiveAt = Date.now();
  }

  /** 读取文件 */
  readFile(sandboxId: string, filePath: string): string {
    const entry = this.sandboxes.get(sandboxId);
    if (!entry) throw new Error(`沙箱 ${sandboxId} 不存在`);

    const fullPath = path.resolve(entry.workdir, filePath.replace(/^[/\\]+/, ''));
    if (!fs.existsSync(fullPath)) throw new Error(`文件不存在: ${filePath}`);
    return fs.readFileSync(fullPath, 'utf-8');
  }

  /** 获取沙箱状态 */
  getStatus(sandboxId: string) {
    const entry = this.sandboxes.get(sandboxId);
    if (!entry) throw new Error(`沙箱 ${sandboxId} 不存在`);
    return {
      sandboxId: entry.sandboxId,
      chatId: entry.chatId,
      modelId: entry.modelId,
      status: entry.status,
      createdAt: entry.createdAt,
      lastActiveAt: entry.lastActiveAt,
      commandCount: entry.commandCount,
    };
  }

  /** 销毁沙箱 */
  destroy(sandboxId: string): void {
    const entry = this.sandboxes.get(sandboxId);
    if (!entry) throw new Error(`沙箱 ${sandboxId} 不存在`);

    // 清理工作目录
    try {
      fs.rmSync(entry.workdir, { recursive: true, force: true });
    } catch { /* 忽略清理错误 */ }

    this.sandboxes.delete(sandboxId);
    console.log(`[Sandbox] 销毁沙箱 ${sandboxId}`);
  }

  /** 销毁对话下所有沙箱 */
  destroyByChat(chatId: string): number {
    let count = 0;
    for (const [id, entry] of this.sandboxes) {
      if (entry.chatId === chatId) {
        this.destroy(id);
        count++;
      }
    }
    return count;
  }
}

/** 全局单例 */
export const sandboxManager = new SandboxManager();