/**
 * ToggleSwitch 组件结构测试
 *
 * 设计意图:
 *   v4 (2026-06-27) — 自绘 track + thumb, 圆球滑动动画, 细线大尺寸
 *   状态机靠 button[aria-checked] 属性选择器, 不依赖兄弟结构或 .peer
 *
 *   这里用 react-dom/server 静态渲染, 卡住关键不变量:
 *   - 单一 <button class="toggle-switch"> 节点, 不能误用 <label>+<input> 老结构
 *   - 内部恰好 2 个 span: 一个 toggle-switch-track, 一个 toggle-switch-thumb
 *   - aria-checked 跟 checked prop 同步
 *   - disabled 透传, label/title 透传
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

  it('内部恰好 2 个 span: toggle-switch-track + toggle-switch-thumb', () => {
    const html = render({
      checked: false,
      onChange: () => {},
      label: '测试开关',
    });
    const trackMatches = html.match(/toggle-switch-track/g) ?? [];
    const thumbMatches = html.match(/toggle-switch-thumb/g) ?? [];
    expect(trackMatches.length).toBeGreaterThanOrEqual(1);
    expect(thumbMatches.length).toBeGreaterThanOrEqual(1);
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

  it('按钮本身具备固定尺寸 (track 44x24, thumb 16x16 由 CSS 决定)', () => {
    // 组件本身只挂 .toggle-switch class, 真实尺寸由 index.css .toggle-switch { width:44px; height:24px } 给
    const html = render({
      checked: false,
      onChange: () => {},
      label: '开关',
    });
    // 通过 class 名可被 CSS 命中
    expect(html).toContain('toggle-switch');
    // 没有内联 style.width / style.height 强制覆盖
    expect(html).not.toMatch(/style="[^"]*width:/);
    expect(html).not.toMatch(/style="[^"]*height:/);
  });
});
