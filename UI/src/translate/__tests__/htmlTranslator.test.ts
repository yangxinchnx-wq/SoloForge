/**
 * htmlTranslator.test.ts — HTML 翻译器测试
 *
 * 测试覆盖:
 *   1. detect() — HTML 检测置信度
 *   2. translate() — 各种 HTML 结构翻译
 *   3. 边界情况 — 空输入/纯文本/嵌套
 *   4. Style 解析 — inline style 各属性
 *   5. 完整页面 — <html><body>...</body></html>
 */

import { describe, it, expect } from 'vitest';
import { htmlTranslator } from '../htmlTranslator';
import { translateCode, translateCodeDetailed, detectLanguage, isLanguageSupported } from '../index';
import { TranslateError } from '../types';

describe('htmlTranslator.detect', () => {
  it('完整 HTML 文档检测置信度 0.9', () => {
    expect(htmlTranslator.detect('<!DOCTYPE html><html><body>hi</body></html>')).toBe(0.9);
    expect(htmlTranslator.detect('<html><head></head><body></body></html>')).toBe(0.9);
  });

  it('包含常见 HTML 标签检测置信度 0.7', () => {
    expect(htmlTranslator.detect('<div class="card">hello</div>')).toBe(0.7);
    expect(htmlTranslator.detect('<button>click</button>')).toBe(0.7);
    expect(htmlTranslator.detect('<p>text</p>')).toBe(0.7);
  });

  it('纯文本检测置信度 0', () => {
    expect(htmlTranslator.detect('hello world')).toBe(0);
    expect(htmlTranslator.detect('')).toBe(0);
  });

  it('非字符串检测置信度 0', () => {
    expect(htmlTranslator.detect(null as any)).toBe(0);
    expect(htmlTranslator.detect(undefined as any)).toBe(0);
  });
});

describe('htmlTranslator.translate — 基础标签', () => {
  it('div 翻译为 container', () => {
    const ast = htmlTranslator.translate('<div>hello</div>');
    expect(ast.type).toBe('container');
  });

  it('p 翻译为 text', () => {
    const ast = htmlTranslator.translate('<p>hello world</p>');
    expect(ast.type).toBe('text');
    expect((ast as any).content).toBe('hello world');
  });

  it('h1 翻译为 text 且自动设置 fontSize=32, fontWeight=700', () => {
    const ast = htmlTranslator.translate('<h1>标题</h1>');
    expect(ast.type).toBe('text');
    expect((ast as any).content).toBe('标题');
    expect((ast as any).style?.fontSize).toBe(32);
    expect((ast as any).style?.fontWeight).toBe(700);
  });

  it('button 翻译为 button', () => {
    const ast = htmlTranslator.translate('<button>点击</button>');
    expect(ast.type).toBe('button');
    expect((ast as any).label).toBe('点击');
  });

  it('input 翻译为 input, 推断 kind', () => {
    const ast = htmlTranslator.translate('<input type="password" placeholder="密码" />');
    expect(ast.type).toBe('input');
    expect((ast as any).kind).toBe('password');
    expect((ast as any).placeholder).toBe('密码');
  });

  it('img 翻译为 image', () => {
    const ast = htmlTranslator.translate('<img src="https://example.com/x.png" alt="图片" />');
    expect(ast.type).toBe('image');
    expect((ast as any).src).toBe('https://example.com/x.png');
    expect((ast as any).alt).toBe('图片');
  });

  it('hr 翻译为 divider', () => {
    const ast = htmlTranslator.translate('<hr />');
    expect(ast.type).toBe('divider');
  });
});

describe('htmlTranslator.translate — 嵌套结构', () => {
  it('div 包含多个子元素', () => {
    const html = `<div>
      <h1>标题</h1>
      <p>段落</p>
      <button>按钮</button>
    </div>`;
    const ast = htmlTranslator.translate(html);
    expect(ast.type).toBe('container');
    const children = (ast as any).children;
    expect(children).toHaveLength(3);
    expect(children[0].type).toBe('text');
    expect(children[1].type).toBe('text');
    expect(children[2].type).toBe('button');
  });

  it('多层嵌套 div', () => {
    const html = '<div><div><div><p>深层文本</p></div></div></div>';
    const ast = htmlTranslator.translate(html);
    expect(ast.type).toBe('container');
    let node: any = ast;
    // 三层 container
    expect(node.children[0].type).toBe('container');
    node = node.children[0];
    expect(node.children[0].type).toBe('container');
    node = node.children[0];
    expect(node.children[0].type).toBe('text');
    expect(node.children[0].content).toBe('深层文本');
  });

  it('ul/li 列表翻译为 column + children', () => {
    const html = '<ul><li>项目1</li><li>项目2</li><li>项目3</li></ul>';
    const ast = htmlTranslator.translate(html);
    expect(ast.type).toBe('column');
    expect((ast as any).children).toHaveLength(3);
    expect((ast as any).children[0].type).toBe('container');
  });
});

describe('htmlTranslator.translate — Style 解析', () => {
  it('解析 padding 单值', () => {
    const ast = htmlTranslator.translate('<div style="padding:16px">x</div>');
    expect((ast as any).style?.padding).toBe(16);
  });

  it('解析 margin 双值', () => {
    const ast = htmlTranslator.translate('<div style="margin:8px 12px">x</div>');
    expect((ast as any).style?.margin).toEqual([8, 12]);
  });

  it('解析 color 和 background', () => {
    const ast = htmlTranslator.translate('<div style="color:red;background:#fff">x</div>');
    expect((ast as any).style?.color).toBe('red');
    expect((ast as any).style?.background).toBe('#fff');
  });

  it('解析 font-size 和 font-weight', () => {
    const ast = htmlTranslator.translate('<p style="font-size:14px;font-weight:bold">x</p>');
    expect((ast as any).style?.fontSize).toBe(14);
    expect((ast as any).style?.fontWeight).toBe(700);
  });

  it('解析 border-radius', () => {
    const ast = htmlTranslator.translate('<div style="border-radius:8px">x</div>');
    expect((ast as any).style?.radius).toBe(8);
  });

  it('display:flex + flex-direction:row → row 容器', () => {
    const ast = htmlTranslator.translate('<div style="display:flex;flex-direction:row"><p>a</p><p>b</p></div>');
    expect(ast.type).toBe('row');
    expect((ast as any).children).toHaveLength(2);
  });

  it('display:flex 无 direction → column 容器', () => {
    const ast = htmlTranslator.translate('<div style="display:flex"><p>a</p><p>b</p></div>');
    expect(ast.type).toBe('column');
  });

  it('忽略不支持的 CSS 属性', () => {
    const ast = htmlTranslator.translate('<div style="transform:rotate(45deg);animation:fade 1s;padding:8px">x</div>');
    expect((ast as any).style?.padding).toBe(8);
    expect((ast as any).style?.transform).toBeUndefined();
  });
});

describe('htmlTranslator.translate — 完整页面', () => {
  it('完整 HTML 文档 (DOCTYPE + html + body)', () => {
    const html = `<!DOCTYPE html>
<html>
<head><title>测试</title></head>
<body>
  <div style="padding:24px">
    <h1>登录</h1>
    <input type="text" placeholder="用户名" />
    <input type="password" placeholder="密码" />
    <button>登录</button>
  </div>
</body>
</html>`;
    const ast = htmlTranslator.translate(html);
    expect(ast.type).toBe('container');
    expect((ast as any).style?.padding).toBe(24);
    expect((ast as any).children).toHaveLength(4);
    expect((ast as any).children[0].type).toBe('text');
    expect((ast as any).children[0].content).toBe('登录');
    expect((ast as any).children[3].type).toBe('button');
  });

  it('多个顶级元素包装为 column', () => {
    const html = '<div>A</div><div>B</div><div>C</div>';
    const ast = htmlTranslator.translate(html);
    expect(ast.type).toBe('column');
    expect((ast as any).children).toHaveLength(3);
  });

  it('HTML 片段 (无 body)', () => {
    const html = '<section><h2>标题</h2><p>内容</p></section>';
    const ast = htmlTranslator.translate(html);
    expect(ast.type).toBe('container');
    expect((ast as any).children).toHaveLength(2);
  });
});

describe('htmlTranslator.translate — 边界情况', () => {
  it('空字符串抛出 TranslateError', () => {
    expect(() => htmlTranslator.translate('')).toThrow(TranslateError);
  });

  it('null 抛出 TranslateError', () => {
    expect(() => htmlTranslator.translate(null as any)).toThrow(TranslateError);
  });

  it('纯文本包装为 text 节点', () => {
    const ast = htmlTranslator.translate('hello world');
    expect(ast.type).toBe('text');
    expect((ast as any).content).toBe('hello world');
  });

  it('未知标签兜底为 container', () => {
    const ast = htmlTranslator.translate('<custom-element><p>x</p></custom-element>');
    expect(ast.type).toBe('container');
  });

  it('script 标签被忽略', () => {
    const html = '<div><script>alert(1)</script><p>text</p></div>';
    const ast = htmlTranslator.translate(html);
    expect((ast as any).children).toHaveLength(1);
    expect((ast as any).children[0].type).toBe('text');
  });

  it('style 标签被忽略', () => {
    const html = '<div><style>.x{color:red}</style><p>text</p></div>';
    const ast = htmlTranslator.translate(html);
    expect((ast as any).children).toHaveLength(1);
    expect((ast as any).children[0].type).toBe('text');
  });
});

describe('translate 统一入口', () => {
  it('translateCode 指定 html 语言', () => {
    const ast = translateCode('<div>x</div>', 'html');
    expect(ast.type).toBe('container');
  });

  it('translateCode 自动检测', () => {
    const ast = translateCode('<div><p>auto detect</p></div>');
    expect(ast.type).toBe('container');
  });

  it('translateCodeDetailed 返回详细信息', () => {
    const result = translateCodeDetailed('<div>x</div>', 'html');
    expect(result.node.type).toBe('container');
    expect(result.language).toBe('html');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.warnings).toEqual([]);
  });

  it('translateCode 不支持的语言抛出 TranslateError', () => {
    expect(() => translateCode('<div/>', 'klingon')).toThrow(TranslateError);
  });

  it('detectLanguage 返回 html 翻译器', () => {
    const t = detectLanguage('<div>test</div>');
    expect(t).not.toBeNull();
    expect(t?.language).toBe('html');
  });

  it('isLanguageSupported html 返回 true', () => {
    expect(isLanguageSupported('html')).toBe(true);
    expect(isLanguageSupported('HTML')).toBe(true);
    expect(isLanguageSupported('klingon')).toBe(false);
  });
});
