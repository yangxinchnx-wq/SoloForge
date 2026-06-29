/**
 * astValidator.test.ts — 运行时校验器单测
 */

import { describe, it, expect } from 'vitest';
import {
  validatePreviewPayload,
  validateRoot,
  isValidNode,
  nodeType,
  NODE_TYPES,
} from './astValidator';

const VALID_PAYLOAD = {
  language: 'python',
  framework: 'Flask',
  source_code: 'print(1)',
  preview: {
    root: {
      type: 'column',
      style: { padding: 10, background: '#fff' },
      children: [{ type: 'text', content: 'Hi' }],
    },
  },
};

describe('astValidator', () => {
  it('accepts valid PreviewPayload', () => {
    const r = validatePreviewPayload(VALID_PAYLOAD);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects non-object payload', () => {
    expect(validatePreviewPayload(null).ok).toBe(false);
    expect(validatePreviewPayload('string').ok).toBe(false);
    expect(validatePreviewPayload(123).ok).toBe(false);
  });

  it('rejects missing language', () => {
    const r = validatePreviewPayload({ ...VALID_PAYLOAD, language: undefined });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('language'))).toBe(true);
  });

  it('rejects missing framework', () => {
    const r = validatePreviewPayload({ ...VALID_PAYLOAD, framework: undefined });
    expect(r.ok).toBe(false);
  });

  it('rejects missing source_code', () => {
    const r = validatePreviewPayload({ ...VALID_PAYLOAD, source_code: undefined });
    expect(r.ok).toBe(false);
  });

  it('rejects invalid node type', () => {
    const bad = {
      ...VALID_PAYLOAD,
      preview: { root: { type: 'unknown_type', content: 'x' } },
    };
    const r = validatePreviewPayload(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('invalid type'))).toBe(true);
  });

  it('rejects text node without content', () => {
    const bad = {
      ...VALID_PAYLOAD,
      preview: { root: { type: 'text' } },
    };
    const r = validatePreviewPayload(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('content'))).toBe(true);
  });

  it('rejects button node without label', () => {
    const bad = {
      ...VALID_PAYLOAD,
      preview: { root: { type: 'button' } },
    };
    const r = validatePreviewPayload(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('label'))).toBe(true);
  });

  it('accepts all 10 node types', () => {
    for (const t of NODE_TYPES) {
      const node: any = { type: t };
      if (t === 'text') node.content = 'hi';
      if (t === 'button') node.label = 'btn';
      const r = validateRoot(node);
      expect(r.ok).toBe(true);
    }
  });

  it('validates nested children', () => {
    const tree = {
      type: 'column',
      children: [
        { type: 'row', children: [{ type: 'text', content: 'a' }] },
        { type: 'text', content: 'b' },
      ],
    };
    expect(validateRoot(tree).ok).toBe(true);
  });

  it('rejects children with invalid child', () => {
    const tree = {
      type: 'column',
      children: [{ type: 'unknown' }],
    };
    expect(validateRoot(tree).ok).toBe(false);
  });

  it('rejects children that is not an array', () => {
    const tree = { type: 'column', children: 'not array' };
    expect(validateRoot(tree).ok).toBe(false);
  });

  it('rejects style that is not a plain object', () => {
    const tree = { type: 'text', content: 'x', style: 'not object' };
    expect(validateRoot(tree).ok).toBe(false);
  });

  it('rejects excessive depth', () => {
    let tree: any = { type: 'text', content: 'x' };
    for (let i = 0; i < 100; i++) {
      tree = { type: 'column', children: [tree] };
    }
    const r = validateRoot(tree, 64);
    expect(r.ok).toBe(false);
  });

  it('isValidNode fast-path', () => {
    expect(isValidNode({ type: 'text', content: 'x' })).toBe(true);
    expect(isValidNode({ type: 'unknown' })).toBe(false);
    expect(isValidNode(null)).toBe(false);
    expect(isValidNode('string')).toBe(false);
  });

  it('nodeType returns type or undefined', () => {
    expect(nodeType({ type: 'text' })).toBe('text');
    expect(nodeType({ type: 'unknown' })).toBeUndefined();
    expect(nodeType(null)).toBeUndefined();
  });
});
