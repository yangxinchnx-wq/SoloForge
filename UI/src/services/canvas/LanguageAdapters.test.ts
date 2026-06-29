/**
 * LanguageAdapters.test.ts — 多语言 Adapter 单测
 *
 * 覆盖：
 *   1. 每种语言能拿到 adapter
 *   2. system prompt 包含 AST 契约块
 *   3. system prompt 包含用户目标
 *   4. 兜底：未知语言 → typescript
 *   5. isSupported 准确判断
 *   6. listSupportedLanguages 列出全部
 */

import { describe, it, expect } from 'vitest';
import { getAdapter, listSupportedLanguages, isSupported } from './LanguageAdapters';

describe('LanguageAdapters', () => {
  it('returns adapter for each supported language', () => {
    const langs = listSupportedLanguages();
    expect(langs.length).toBeGreaterThanOrEqual(5);
    for (const lang of langs) {
      const adapter = getAdapter(lang);
      expect(adapter.language).toBe(lang);
      expect(adapter.defaultFrameworks.length).toBeGreaterThan(0);
    }
  });

  it('system prompt contains AST contract', () => {
    const py = getAdapter('python');
    const prompt = py.buildSystemPrompt('login screen');
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('language');
    expect(prompt).toContain('preview');
    expect(prompt).toContain('container'); // AST node
    expect(prompt).toContain('row'); // AST node
  });

  it('system prompt contains user goal', () => {
    const py = getAdapter('python');
    const prompt = py.buildSystemPrompt('a calculator app');
    expect(prompt).toContain('a calculator app');
  });

  it('different languages have different prompts', () => {
    const py = getAdapter('python');
    const c = getAdapter('c');
    expect(py.buildSystemPrompt('test')).not.toBe(c.buildSystemPrompt('test'));
  });

  it('falls back to typescript for unknown language', () => {
    const a = getAdapter('cobol');
    expect(a.language).toBe('typescript');
  });

  it('isSupported is accurate', () => {
    expect(isSupported('python')).toBe(true);
    expect(isSupported('PYTHON')).toBe(true); // case insensitive
    expect(isSupported('cobol')).toBe(false);
  });

  it('language-specific adapter mentions language-specific content', () => {
    expect(getAdapter('python').buildSystemPrompt('x')).toContain('Flask');
    expect(getAdapter('c').buildSystemPrompt('x')).toContain('GTK');
    expect(getAdapter('java').buildSystemPrompt('x')).toContain('Swing');
    expect(getAdapter('rust').buildSystemPrompt('x')).toContain('egui');
  });
});
