/**
 * astCache.test.ts — AST 缓存层单测
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { astCache, hashPrompt, astKeyFor, makeAstKey } from './astCache';
import type { PreviewPayload } from './UniversalAST';

const SAMPLE: PreviewPayload = {
  language: 'python',
  framework: 'Flask',
  source_code: 'print(1)',
  preview: { root: { type: 'column', children: [] } },
};

describe('astCache', () => {
  beforeEach(() => astCache.clear());

  it('set + get round-trip', () => {
    astCache.set('ast:python:abc12345', SAMPLE);
    expect(astCache.get('ast:python:abc12345')).toEqual(SAMPLE);
  });

  it('returns undefined on miss', () => {
    expect(astCache.get('ast:nothing')).toBeUndefined();
  });

  it('invalidate removes entry', () => {
    astCache.set('k1', SAMPLE);
    astCache.invalidate('k1');
    expect(astCache.get('k1')).toBeUndefined();
  });

  it('clear empties cache', () => {
    astCache.set('a', SAMPLE);
    astCache.set('b', SAMPLE);
    expect(astCache.size()).toBe(2);
    astCache.clear();
    expect(astCache.size()).toBe(0);
  });

  it('expired entries are treated as miss', async () => {
    astCache.set('short', SAMPLE, { ttlMs: 30 });
    expect(astCache.get('short')).toEqual(SAMPLE);
    await new Promise((r) => setTimeout(r, 80));
    expect(astCache.get('short')).toBeUndefined();
  });

  it('setByPrompt computes key from language+prompt', () => {
    astCache.setByPrompt('python', 'hello', SAMPLE);
    const key = astKeyFor('python', 'hello');
    expect(astCache.get(key)).toEqual(SAMPLE);
  });

  it('hashPrompt is stable for same input', () => {
    expect(hashPrompt('hello')).toBe(hashPrompt('hello'));
  });

  it('hashPrompt differs for different input', () => {
    expect(hashPrompt('hello')).not.toBe(hashPrompt('world'));
  });

  it('different languages have separate cache spaces', () => {
    const pyPayload: PreviewPayload = { ...SAMPLE, language: 'python' };
    const cPayload: PreviewPayload = { ...SAMPLE, language: 'c' };
    const pyKey = astKeyFor('python', 'same');
    const cKey = astKeyFor('c', 'same');
    astCache.set(pyKey, pyPayload);
    astCache.set(cKey, cPayload);
    expect(astCache.get(pyKey)).toEqual(pyPayload);
    expect(astCache.get(cKey)).toEqual(cPayload);
  });

  it('makeAstKey lowercases language', () => {
    expect(makeAstKey('Python', 'abc12345')).toBe('ast:python:abc12345');
    expect(makeAstKey('JAVA', 'abc12345')).toBe('ast:java:abc12345');
  });
});
