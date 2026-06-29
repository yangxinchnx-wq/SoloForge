/**
 * visualRegression.ts — 视觉回归工具
 *
 * 提供两种快照：
 *   1. AST 快照：把渲染树序列化后哈希，AI 输出的 UI 结构稳定即通过
 *   2. 像素快照：把 PNG buffer 哈希，配合 Playwright screenshot 使用
 *
 * 用法（AST）：
 *   const snap = astSnapshot(renderTree);
 *   expect(snap.hash).toBe('a1b2c3...');   // 固定 → 通过
 *   expect(snap.changedFields).toEqual([]); // 描述变化范围
 *
 * 用法（Playwright）：
 *   test('preview looks right', async ({ page }) => {
 *     await page.goto('...');
 *     const buf = await page.screenshot();
 *     const snap = pixelSnapshot(buf);
 *     if (process.env.UPDATE_SNAPSHOTS) saveSnapshot('preview', snap);
 *     else expect(snap.hash).toBe(loadSnapshot('preview').hash);
 *   });
 *
 * 设计动机：
 *   - 不依赖图像 diff 库（避免像素级误报）
 *   - hash 抗噪（结构稳定即可）
 *   - 给"是否退化"提供客观依据
 */

import { createHash } from 'crypto';

/** 通用快照：把任意 JSON-serializable 对象去 key 排序后哈希 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value as object).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify((value as any)[k])).join(',') + '}';
  }
  return JSON.stringify(String(value));
}

export interface Snapshot {
  hash: string;
  size: number;
  preview: string;
  changedFields?: string[];
}

export function hashOf(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

/** AST 快照：检测两棵树之间的变化字段 */
export function astSnapshot(renderTree: unknown, baseline?: unknown): Snapshot {
  const hash = hashOf(renderTree);
  const preview = stableStringify(renderTree).slice(0, 120);
  const snap: Snapshot = { hash, size: stableStringify(renderTree).length, preview };
  if (baseline !== undefined) {
    snap.changedFields = diffKeys(baseline, renderTree);
  }
  return snap;
}

function diffKeys(a: unknown, b: unknown, prefix = ''): string[] {
  if (a === b) return [];
  if (typeof a !== typeof b) return [prefix || '(root)'];
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return [prefix || '(root)'];
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
  const out: string[] = [];
  for (const k of allKeys) {
    const childPath = prefix ? `${prefix}.${k}` : k;
    if (!(k in aObj)) { out.push(`${childPath}=added`); continue; }
    if (!(k in bObj)) { out.push(`${childPath}=removed`); continue; }
    out.push(...diffKeys(aObj[k], bObj[k], childPath));
  }
  return out;
}

// ============================================================
// 像素快照（PNG/SVG 字节级）
// ============================================================

export function pixelSnapshot(buf: Uint8Array | Buffer, baseline?: { hash: string }): Snapshot {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const snap: Snapshot = { hash, size: bytes.length, preview: `<${bytes.length} bytes>` };
  if (baseline) {
    snap.changedFields = baseline.hash === hash ? [] : ['pixels'];
  }
  return snap;
}

// ============================================================
// 简易 snapshot store（filesystem backed）
// ============================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';

export class SnapshotStore {
  constructor(public dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private pathFor(name: string): string {
    return join(this.dir, `${name}.snap.json`);
  }

  save(name: string, snap: Snapshot): void {
    const p = this.pathFor(name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(snap, null, 2), 'utf8');
  }

  load(name: string): Snapshot | null {
    const p = this.pathFor(name);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  }

  /** 比对：返回 diff 描述 */
  diff(name: string, current: Snapshot): { match: boolean; baseline: Snapshot | null; changes: string[] } {
    const baseline = this.load(name);
    if (!baseline) return { match: false, baseline: null, changes: ['no-baseline'] };
    if (baseline.hash === current.hash) return { match: true, baseline, changes: [] };
    return { match: false, baseline, changes: current.changedFields ?? ['hash-mismatch'] };
  }
}
