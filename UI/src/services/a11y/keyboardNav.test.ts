/**
 * keyboardNav.test.ts — 键盘导航 + A11y 工具单测
 */

import { describe, it, expect, vi } from 'vitest';
import {
  rovingTabindex,
  isActionKey,
  isCancelKey,
  ariaProps,
  colorContrastRatio,
  meetsWCAGAA,
} from './keyboardNav';

function makeEvent(key: string, shift = false) {
  return {
    key,
    shiftKey: shift,
    preventDefault: vi.fn(),
  } as any;
}

describe('rovingTabindex', () => {
  it('ArrowRight moves to next in horizontal', () => {
    const onChange = vi.fn();
    const handler = rovingTabindex({ orientation: 'horizontal', itemCount: 5, activeIndex: 1, onChange });
    const e = makeEvent('ArrowRight');
    handler(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith(2);
  });

  it('ArrowLeft moves to previous in horizontal', () => {
    const onChange = vi.fn();
    const handler = rovingTabindex({ orientation: 'horizontal', itemCount: 5, activeIndex: 2, onChange });
    const e = makeEvent('ArrowLeft');
    handler(e);
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('ArrowDown / ArrowUp work in vertical', () => {
    let activeIndex = 1;
    const onChange = vi.fn((i) => { activeIndex = i; });
    const handler = rovingTabindex({
      orientation: 'vertical',
      itemCount: 5,
      get activeIndex() { return activeIndex; },
      onChange,
    });
    handler(makeEvent('ArrowDown'));
    expect(onChange).toHaveBeenLastCalledWith(2);
    handler(makeEvent('ArrowUp'));
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it('Arrow keys work in both orientation', () => {
    const onChange = vi.fn();
    let activeIndex = 0;
    const handler = rovingTabindex({
      orientation: 'both',
      itemCount: 5,
      get activeIndex() { return activeIndex; },
      onChange: (i) => { activeIndex = i; onChange(i); },
    });
    handler(makeEvent('ArrowRight'));
    expect(onChange).toHaveBeenLastCalledWith(1);
    handler(makeEvent('ArrowDown'));
    expect(onChange).toHaveBeenLastCalledWith(2);
  });

  it('Home / End jump to boundaries', () => {
    const onChange = vi.fn();
    const handler = rovingTabindex({ orientation: 'vertical', itemCount: 5, activeIndex: 2, onChange });
    handler(makeEvent('Home'));
    expect(onChange).toHaveBeenLastCalledWith(0);
    handler(makeEvent('End'));
    expect(onChange).toHaveBeenLastCalledWith(4);
  });

  it('Enter triggers onSelect', () => {
    const onSelect = vi.fn();
    const handler = rovingTabindex({ orientation: 'vertical', itemCount: 3, activeIndex: 1, onChange: vi.fn(), onSelect });
    const e = makeEvent('Enter');
    handler(e);
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('Space triggers onSelect', () => {
    const onSelect = vi.fn();
    const handler = rovingTabindex({ orientation: 'vertical', itemCount: 3, activeIndex: 0, onChange: vi.fn(), onSelect });
    handler(makeEvent(' '));
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it('wrap=true wraps around (default)', () => {
    const onChange = vi.fn();
    const handler = rovingTabindex({ orientation: 'vertical', itemCount: 3, activeIndex: 2, onChange });
    handler(makeEvent('ArrowDown'));
    expect(onChange).toHaveBeenCalledWith(0);
  });

  it('wrap=false clamps at boundary', () => {
    const onChange = vi.fn();
    const handler = rovingTabindex({ orientation: 'vertical', itemCount: 3, activeIndex: 2, onChange, wrap: false });
    handler(makeEvent('ArrowDown'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('unrelated key is ignored (no preventDefault)', () => {
    const onChange = vi.fn();
    const handler = rovingTabindex({ orientation: 'vertical', itemCount: 3, activeIndex: 1, onChange });
    const e = makeEvent('a');
    handler(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('empty list returns noop', () => {
    const onChange = vi.fn();
    const handler = rovingTabindex({ orientation: 'vertical', itemCount: 0, activeIndex: 0, onChange });
    const e = makeEvent('ArrowDown');
    expect(() => handler(e)).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('isActionKey / isCancelKey', () => {
  it('Enter + Space are action keys', () => {
    expect(isActionKey(makeEvent('Enter'))).toBe(true);
    expect(isActionKey(makeEvent(' '))).toBe(true);
    expect(isActionKey(makeEvent('a'))).toBe(false);
  });
  it('Escape is cancel key', () => {
    expect(isCancelKey(makeEvent('Escape'))).toBe(true);
    expect(isCancelKey(makeEvent('Esc'))).toBe(true);
    expect(isCancelKey(makeEvent('Enter'))).toBe(false);
  });
});

describe('ariaProps', () => {
  it('includes only provided fields', () => {
    expect(ariaProps('Hello')).toEqual({ 'aria-label': 'Hello' });
    expect(ariaProps()).toEqual({});
    expect(ariaProps('X', 'Y', 'Z', true)).toEqual({
      'aria-label': 'X',
      'aria-labelledby': 'Y',
      'aria-describedby': 'Z',
      'aria-hidden': true,
    });
  });
});

describe('color contrast (WCAG)', () => {
  it('black on white is 21:1', () => {
    const r = colorContrastRatio('#000000', '#ffffff');
    expect(r).toBeCloseTo(21, 0);
  });

  it('white on white is 1:1', () => {
    const r = colorContrastRatio('#ffffff', '#ffffff');
    expect(r).toBeCloseTo(1, 1);
  });

  it('mid gray on white fails AA', () => {
    expect(meetsWCAGAA('#777777', '#ffffff')).toBe(false);
  });

  it('high contrast dark gray on white passes AA', () => {
    expect(meetsWCAGAA('#595959', '#ffffff')).toBe(true);
  });

  it('large text has lower threshold (3:1)', () => {
    // #888888 ≈ 3.5:1 (under 4.5 normal, over 3 large)
    expect(meetsWCAGAA('#888888', '#ffffff')).toBe(false);
    expect(meetsWCAGAA('#888888', '#ffffff', true)).toBe(true);
  });

  it('accepts short hex form', () => {
    const r = colorContrastRatio('#000', '#fff');
    expect(r).toBeCloseTo(21, 0);
  });
});
