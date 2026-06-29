/**
 * visualRegression.test.ts — 视觉回归工具单测
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  stableStringify,
  hashOf,
  astSnapshot,
  pixelSnapshot,
  SnapshotStore,
} from './visualRegression';

describe('stableStringify', () => {
  it('sorts object keys', () => {
    const a = stableStringify({ b: 1, a: 2 });
    const b = stableStringify({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('handles nested objects', () => {
    const a = stableStringify({ outer: { z: 1, a: 2 } });
    const b = stableStringify({ outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it('handles arrays (order matters)', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('handles null / undefined / primitives', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(undefined)).toBe('null');
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify('hi')).toBe('"hi"');
  });
});

describe('hashOf', () => {
  it('produces 16-char hex', () => {
    expect(hashOf({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });
  it('is order-independent for objects', () => {
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
  });
  it('is order-dependent for arrays', () => {
    expect(hashOf([1, 2])).not.toBe(hashOf([2, 1]));
  });
});

describe('astSnapshot', () => {
  it('returns same hash for same structure', () => {
    const a = astSnapshot({ type: 'column', children: [] });
    const b = astSnapshot({ type: 'column', children: [] });
    expect(a.hash).toBe(b.hash);
  });

  it('detects changes vs baseline', () => {
    const baseline = { type: 'column', children: [{ type: 'text' }] };
    const next = { type: 'row', children: [{ type: 'text' }, { type: 'button' }] };
    const snap = astSnapshot(next, baseline);
    expect(snap.changedFields).toBeDefined();
    expect(snap.changedFields!.length).toBeGreaterThan(0);
    expect(snap.changedFields).toContain('type');
  });

  it('no changed fields when identical to baseline', () => {
    const t = { type: 'column', children: [] };
    const snap = astSnapshot(t, t);
    expect(snap.changedFields).toEqual([]);
  });
});

describe('pixelSnapshot', () => {
  it('hashes the same bytes identically', () => {
    const buf = new Uint8Array([1, 2, 3, 4, 5]);
    const a = pixelSnapshot(buf);
    const b = pixelSnapshot(Buffer.from([1, 2, 3, 4, 5]));
    expect(a.hash).toBe(b.hash);
  });

  it('detects pixel change vs baseline', () => {
    const base = pixelSnapshot(new Uint8Array([1, 2, 3]));
    const next = pixelSnapshot(new Uint8Array([1, 2, 4]), base);
    expect(next.changedFields).toEqual(['pixels']);
  });

  it('match when identical', () => {
    const base = pixelSnapshot(new Uint8Array([1, 2, 3]));
    const next = pixelSnapshot(new Uint8Array([1, 2, 3]), base);
    expect(next.changedFields).toEqual([]);
  });
});

describe('SnapshotStore (filesystem)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'snap-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves and loads a snapshot', () => {
    const store = new SnapshotStore(dir);
    store.save('foo', { hash: 'abc', size: 100, preview: '<foo>' });
    const loaded = store.load('foo');
    expect(loaded).toEqual({ hash: 'abc', size: 100, preview: '<foo>' });
  });

  it('load returns null for missing snapshot', () => {
    const store = new SnapshotStore(dir);
    expect(store.load('nope')).toBeNull();
  });

  it('diff reports match for identical', () => {
    const store = new SnapshotStore(dir);
    const snap = { hash: 'abc', size: 1, preview: '' };
    store.save('foo', snap);
    const r = store.diff('foo', snap);
    expect(r.match).toBe(true);
    expect(r.changes).toEqual([]);
  });

  it('diff reports change for different', () => {
    const store = new SnapshotStore(dir);
    store.save('foo', { hash: 'aaa', size: 1, preview: '' });
    const r = store.diff('foo', { hash: 'bbb', size: 1, preview: '' });
    expect(r.match).toBe(false);
    expect(r.changes).toContain('hash-mismatch');
  });

  it('diff returns no-baseline when missing', () => {
    const store = new SnapshotStore(dir);
    const r = store.diff('missing', { hash: 'x', size: 1, preview: '' });
    expect(r.match).toBe(false);
    expect(r.changes).toEqual(['no-baseline']);
  });

  it('save creates nested directory', () => {
    const store = new SnapshotStore(dir);
    store.save('a/b/c', { hash: 'x', size: 1, preview: '' });
    expect(existsSync(join(dir, 'a/b/c.snap.json'))).toBe(true);
    const content = JSON.parse(readFileSync(join(dir, 'a/b/c.snap.json'), 'utf8'));
    expect(content.hash).toBe('x');
  });
});
