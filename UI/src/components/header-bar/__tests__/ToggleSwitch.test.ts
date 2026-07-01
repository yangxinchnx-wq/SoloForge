/**
 * ToggleSwitch 组件结构测试
 *
 * 设计意图:
 *   v5 (2026-07-02) — 引入 framer-motion 弹簧动画驱动 thumb 滑动
 *   状态机靠 button[aria-checked] 属性选择器, 不依赖兄弟结构或 .peer
 *
 *   这里用 react-dom/server 静态渲染, 卡住关键不变量:
 *   - 单一 <button class="toggle-switch"> 节点, 不能误用 <label>+<input> 老结构
 *   - 内部 thumb 用 motion.span 渲染 (framer-motion SSR 会输出 <span style="transform:...">)
 *   - aria-checked 跟 checked prop 同步
 *   - disabled 透传, label/title 透传
 *   - 颜色靠 var(--color-primary) / var(--color-outline) 主题 token, 不写死
 *
 *   选 server-side 渲染而不是 @testing-library/react, 因为项目 devDeps 没装 testing-library;
 *   这里只要看 HTML 结构, 不需要交互式 mount。
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ToggleSwitch } from '../ToggleSwitch';

function render(props: Parameters<typeof ToggleSwitch>[0]): string {
  return renderToStaticMarkup(createElement(ToggleSwitch, props));
}

describe('ToggleSwitch — 结构防回归', () => {
  it('外层是 <button class="toggle-switch">, 不是 <label>+<input>', () => {
    const html = render({
      checked: false,
      onChange: () => {},
      label: '测试开关',
    });
    expect(html.startsWith('<button')).toBe(true);
    expect(html).toContain('class="toggle-switch');
    expect(html).not.toMatch(/<input/);
    expect(html).not.toContain('<label');
  });

  it('thumb 用 motion.span 渲染 (framer-motion SSR 输出含 transform inline style)', () => {
    const html = render({
      checked: false,
      onChange: () => {},
      label: '测试开关',
    });
    // framer-motion SSR 会输出 style="transform: translateX(...); translateZ(0); ..."
    expect(html).toMatch(/<span[^>]*style="[^"]*transform/);
  });

  it('不依赖老 .peer 兄弟选择器 (没有 peer sr-only input)', () => {
    const html = render({
      checked: false,
      onChange: () => {},
      label: '测试开关',
    });
    expect(html).not.toContain('peer sr-only');
    expect(html).not.toMatch(/<input[^>]*class="[^"]*peer/);
  });

  it('role="switch" + aria-checked 给出无障碍语义', () => {
    const html = render({
      checked: true,
      onChange: () => {},
      label: '开关',
    });
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
  });

  it('checked=true 时, aria-checked="true"', () => {
    const html = render({
      checked: true,
      onChange: () => {},
      label: '开',
    });
    expect(html).toContain('aria-checked="true"');
  });

  it('checked=false 时, aria-checked="false"', () => {
    const html = render({
      checked: false,
      onChange: () => {},
      label: '关',
    });
    expect(html).toContain('aria-checked="false"');
  });

  it('disabled=true 时, button 携带 disabled 属性', () => {
    const html = render({
      checked: false,
      onChange: () => {},
      label: '锁住',
      disabled: true,
    });
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it('label 透传到 aria-label (无障碍 + 自动化测试可定位)', () => {
    const html = render({
      checked: false,
      onChange: () => {},
      label: '多模型混合模式',
    });
    expect(html).toContain('aria-label="多模型混合模式"');
  });

  it('title 透传到 button', () => {
    const html = render({
      checked: false,
      onChange: () => {},
      label: '开关',
      title: '普通模式下停用',
    });
    expect(html).toContain('title="普通模式下停用"');
  });

  it('className 追加到外层 button', () => {
    const html = render({
      checked: false,
      onChange: () => {},
      label: '开关',
      className: 'ml-2 mr-3',
    });
    expect(html).toMatch(/<button[^>]*class="[^"]*ml-2 mr-3/);
  });

  it('track 颜色靠 var(--color-*) 主题 token (关闭时 outline, 开启时 primary)', () => {
    const off = render({ checked: false, onChange: () => {}, label: '关' });
    const on = render({ checked: true, onChange: () => {}, label: '开' });
    expect(off).toContain('var(--color-outline)');
    expect(on).toContain('var(--color-primary)');
  });

  it('按钮具备椭圆外观 (borderRadius:9999) + 固定尺寸 44x24', () => {
    const html = render({
      checked: false,
      onChange: () => {},
      label: '开关',
    });
    expect(html).toContain('border-radius:9999');
    expect(html).toMatch(/width:44px/);
    expect(html).toMatch(/height:24px/);
  });
});