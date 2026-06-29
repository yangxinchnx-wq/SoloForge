/**
 * Fetch Sync Adapter
 *
 * 实现 SyncAdapter,基于 fetch API
 * - PUT /api/settings/:key
 * - GET /api/settings
 * - DELETE /api/settings/:key (可选)
 *
 * 失败通过抛异常让 Store 处理(Store 会重试)
 */

import type { SyncAdapter } from '../types';

export interface FetchSyncOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
  timeout?: number;
}

export class FetchSync implements SyncAdapter {
  private baseUrl: string;
  private headers: Record<string, string>;
  private timeout: number;

  constructor(options: FetchSyncOptions = {}) {
    this.baseUrl = options.baseUrl ?? '/api/settings';
    this.headers = options.headers ?? { 'Content-Type': 'application/json' };
    this.timeout = options.timeout ?? 10000;
  }

  async put(key: string, value: unknown): Promise<void> {
    const url = `${this.baseUrl}/${encodeURIComponent(key)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: this.headers,
        body: JSON.stringify({ value }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`PUT ${key} failed: ${res.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async getAll(): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const res = await fetch(this.baseUrl, {
        method: 'GET',
        headers: this.headers,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`GET all failed: ${res.status}`);
      }
      const data = await res.json();
      if (!data.success || !data.settings) {
        throw new Error('GET all: invalid response');
      }
      return data.settings;
    } finally {
      clearTimeout(timer);
    }
  }

  async remove(key: string): Promise<void> {
    const url = `${this.baseUrl}/${encodeURIComponent(key)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const res = await fetch(url, {
        method: 'DELETE',
        headers: this.headers,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`DELETE ${key} failed: ${res.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}