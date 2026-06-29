/**
 * Electron File Write Sync Adapter
 *
 * 通过 Electron IPC 将设置异步写入本地 JSON 文件,
 * 防止断电/崩溃导致 localStorage 数据丢失。
 *
 * 仅在 Electron 环境下激活;浏览器环境降级为 no-op。
 */

import type { SyncAdapter } from '../types';

export interface FileWriteSyncOptions {
  filePath?: string;
}

export class FileWriteSync implements SyncAdapter {
  private filePath: string;
  private enabled: boolean;

  constructor(options: FileWriteSyncOptions = {}) {
    this.filePath = options.filePath ?? 'settings.json';
    this.enabled = typeof window !== 'undefined' &&
      !!(window as any).soloforge &&
      typeof (window as any).soloforge?.settings?.writeFile === 'function';
  }

  async put(key: string, value: unknown): Promise<void> {
    if (!this.enabled) return;
    try {
      await (window as any).soloforge.settings.writeFile({
        filePath: this.filePath,
        key,
        value,
        append: true,
      });
    } catch (e) {
      console.warn('[FileWriteSync] put failed:', key, (e as Error).message);
    }
  }

  async getAll(): Promise<Record<string, unknown>> {
    if (!this.enabled) return {};
    try {
      const data = await (window as any).soloforge.settings.readFile({
        filePath: this.filePath,
      });
      return typeof data === 'object' && data !== null ? data : {};
    } catch (e) {
      console.warn('[FileWriteSync] getAll failed:', (e as Error).message);
      return {};
    }
  }

  async remove(key: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await (window as any).soloforge.settings.writeFile({
        filePath: this.filePath,
        key,
        value: undefined,
        append: true,
      });
    } catch (e) {
      console.warn('[FileWriteSync] remove failed:', key, (e as Error).message);
    }
  }
}
