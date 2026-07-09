/**
 * reactTranslator.test.ts — React JSX/TSX 翻译器测试
 *
 * 覆盖: detect / translate (基础 JSX / 函数组件 / 箭头组件 / Fragment / Style / 表达式 / 嵌套)
 */

import { describe, it, expect } from 'vitest';
import { reactTranslator } from '../reactTranslator';
import { translateCode, isLanguageSupported, detectLanguage } from '../index';

// ──────────────────────────── detect ────────────────────────────

describe('reactTranslator.detect', () => {
  it('检测 import react + JSX → 0.9', () => {
    const code = `import React from 'react';\nfunction App() { return <div>hi</div>; }`;
    expect(reactTranslator.detect(code)).toBe(0.9);
  });

  it('检测函数组件 + JSX (无 import) → 0.8', () => {
    const code = `function Button() { return <button>Click</button>; }`;
    expect(reactTranslator.detect(code)).toBe(0.8);
  });

  it('检测箭头函数组件 → 0.8', () => {
    const code = `const Card = () => <div className="card">Hello</div>`;
    expect(reactTranslator.detect(code)).toBe(0.8);
  });

  it('检测自定义组件 <MyComponent /> → 0.6', () => {
    const code = `<MyComponent title="hello" />`;
    expect(reactTranslator.detect(code)).toBe(0.6);
  });

  it('检测 JSX 表达式 + 标签 → 0.4', () => {
    const code = `<div>{name}</div>`;
    expect(reactTranslator.detect(code)).toBe(0.4);
  });

  it('纯 HTML (无 JSX 特征) → 0 或低值', () => {
    const code = `<div><p>hello</p></div>`;
    // 纯 HTML 没有 JSX 表达式, detect 返回 0 (因为 hasJsxExpr false)
    // 但 <div> 有标签, hasJsxTag true, hasJsxExpr false → 不匹配任何条件 → 0
    expect(reactTranslator.detect(code)).toBe(0);
  });

  it('空字符串 → 0', () => {
    expect(reactTranslator.detect('')).toBe(0);
  });

  it('非字符串 → 0', () => {
    expect(reactTranslator.detect(null as any)).toBe(0);
  });
});

// ──────────────────────────── translate: 基础 ────────────────────────────

describe('reactTranslator.translate: 基础 JSX', () => {
  it('简单 div', () => {
    const ast = reactTranslator.translate('<div>hello</div>');
    expect(ast.type).toBe('container');
    expect(ast.children).toBeDefined();
    expect(ast.children![0]).toMatchObject({ type: 'text', content: 'hello' });
  });

  it('p 标签 → text', () => {
    const ast = reactTranslator.translate('<p>hello world</p>');
    expect(ast.type).toBe('text');
    expect(ast.content).toBe('hello world');
  });

  it('h1 标题 → text + fontSize', () => {
    const ast = reactTranslator.translate('<h1>Title</h1>');
    expect(ast.type).toBe('text');
    expect(ast.content).toBe('Title');
    expect(ast.style?.fontSize).toBe(32);
    expect(ast.style?.fontWeight).toBe(700);
  });

  it('button → button 节点', () => {
    const ast = reactTranslator.translate('<button>Click me</button>');
    expect(ast.type).toBe('button');
    expect(ast.label).toBe('Click me');
    expect(ast.variant).toBe('filled');
  });

  it('input → input 节点', () => {
    const ast = reactTranslator.translate('<input type="text" placeholder="Name" />');
    expect(ast.type).toBe('input');
    expect(ast.placeholder).toBe('Name');
    expect(ast.kind).toBe('text');
  });

  it('input password → kind=password', () => {
    const ast = reactTranslator.translate('<input type="password" />');
    expect(ast.type).toBe('input');
    expect(ast.kind).toBe('password');
  });

  it('img → image 节点', () => {
    const ast = reactTranslator.translate('<img src="x.png" alt="pic" />');
    expect(ast.type).toBe('image');
    expect(ast.src).toBe('x.png');
    expect(ast.alt).toBe('pic');
  });

  it('hr → divider', () => {
    const ast = reactTranslator.translate('<hr />');
    expect(ast.type).toBe('divider');
  });
});

// ──────────────────────────── translate: 函数组件 ────────────────────────────

describe('reactTranslator.translate: 函数组件', () => {
  it('function 声明组件', () => {
    const code = `
      function App() {
        return (
          <div>
            <h1>Hello</h1>
            <p>World</p>
          </div>
        );
      }
    `;
    const ast = reactTranslator.translate(code);
    expect(ast.type).toBe('container');
    expect(ast.children).toHaveLength(2);
    expect(ast.children![0].type).toBe('text');
    expect(ast.children![1].type).toBe('text');
  });

  it('箭头函数组件 (带 return)', () => {
    const code = `
      const Card = () => {
        return <div className="card"><p>Content</p></div>;
      };
    `;
    const ast = reactTranslator.translate(code);
    expect(ast.type).toBe('container');
    expect(ast.children![0]).toMatchObject({ type: 'text', content: 'Content' });
  });

  it('箭头函数组件 (隐式 return)', () => {
    const code = `const Button = () => <button>Click</button>;`;
    const ast = reactTranslator.translate(code);
    expect(ast.type).toBe('button');
    expect(ast.label).toBe('Click');
  });

  it('带 import 语句的完整组件', () => {
    const code = `
      import React, { useState } from 'react';
      import './App.css';

      function App() {
        const [count, setCount] = useState(0);
        return (
          <div className="app">
            <h1>Counter</h1>
            <button>Count: {count}</button>
          </div>
        );
      }
    `;
    const ast = reactTranslator.translate(code);
    expect(ast.type).toBe('container');
    expect(ast.children).toHaveLength(2);
    // button 文本应该是 "Count: {count}" (变量作为占位)
    const btn = ast.children![1];
    expect(btn.type).toBe('button');
    expect(btn.label).toContain('Count:');
    expect(btn.label).toContain('{count}');
  });
});

// ──────────────────────────── translate: Fragment ────────────────────────────

describe('reactTranslator.translate: Fragment', () => {
  it('<>...</> → container', () => {
    const code = `<>hello world</>`;
    const ast = reactTranslator.translate(code);
    expect(ast.type).toBe('container');
  });

  it('Fragment 带多个子节点', () => {
    const code = `<><p>first</p><p>second</p></>`;
    const ast = reactTranslator.translate(code);
    expect(ast.type).toBe('container');
    expect(ast.children).toHaveLength(2);
  });
});

// ──────────────────────────── translate: Style ────────────────────────────

describe('reactTranslator.translate: Style prop', () => {
  it('style 对象 → UniversalStyle', () => {
    const code = `<div style={{ padding: 16, color: 'red' }}>hi</div>`;
    const ast = reactTranslator.translate(code);
    expect(ast.type).toBe('container');
    expect(ast.style?.padding).toBe(16);
    expect(ast.style?.color).toBe('red');
  });

  it('style fontSize + fontWeight', () => {
    const code = `<p style={{ fontSize: 20, fontWeight: 600 }}>text</p>`;
    const ast = reactTranslator.translate(code);
    expect(ast.style?.fontSize).toBe(20);
    expect(ast.style?.fontWeight).toBe(600);
  });

  it('display:flex + flexDirection:row → row 容器', () => {
    const code = `<div style={{ display: 'flex', flexDirection: 'row' }}><span>a</span><span>b</span></div>`;
    const ast = reactTranslator.translate(code);
    expect(ast.type).toBe('row');
  });

  it('display:flex (默认 column) → column 容器', () => {
    const code = `<div style={{ display: 'flex' }}><span>a</span></div>`;
    const ast = reactTranslator.translate(code);
    expect(ast.type).toBe('column');
  });

  it('borderRadius 解析', () => {
    const code = `<div style={{ borderRadius: 8 }}>hi</div>`;
    const ast = reactTranslator.translate(code);
    expect(ast.style?.radius).toBe(8);
  });

  it('字符串值 "16px" → 数字 16', () => {
    const code = `<div style={{ padding: '16px' }}>hi</div>`;
    const ast = reactTranslator.translate(code);
    expect(ast.style?.padding).toBe(16);
  });
});

// ──────────────────────────── translate: className ────────────────────────────

describe('reactTranslator.translate: className', () => {
  it('className="btn-outline" → outlined variant', () => {
    const ast = reactTranslator.translate('<button className="btn-outline">X</button>');
    expect(ast.type).toBe('button');
    expect(ast.variant).toBe('outlined');
  });

  it('className="text" → text variant', () => {
    const ast = reactTranslator.translate('<button className="btn-text">X</button>');
    expect(ast.variant).toBe('text');
  });

  it('无 className → filled', () => {
    const ast = reactTranslator.translate('<button>X</button>');
    expect(ast.variant).toBe('filled');
  });
});

// ──────────────────────────── translate: 表达式 ────────────────────────────

describe('reactTranslator.translate: JSX 表达式', () => {
  it('字符串字面量 → text', () => {
    const ast = reactTranslator.translate('<div>{"hello"}</div>');
    expect(ast.children![0]).toMatchObject({ type: 'text', content: 'hello' });
  });

  it('数字字面量 → text', () => {
    const ast = reactTranslator.translate('<div>{42}</div>');
    expect(ast.children![0]).toMatchObject({ type: 'text', content: '42' });
  });

  it('变量名 → text 占位', () => {
    const ast = reactTranslator.translate('<div>{name}</div>');
    expect(ast.children![0]).toMatchObject({ type: 'text', content: '{name}' });
  });

  it('true && <X/> → 渲染 X', () => {
    const code = `<div>{true && <p>shown</p>}</div>`;
    const ast = reactTranslator.translate(code);
    expect(ast.children![0]).toMatchObject({ type: 'text', content: 'shown' });
  });

  it('false && <X/> → 跳过', () => {
    const code = `<div>{false && <p>hidden</p>}</div>`;
    const ast = reactTranslator.translate(code);
    // children 为空 (false && expr → null → 不渲染)
    expect(ast.children).toBeUndefined();
  });

  it('三元条件 → 取第一个分支', () => {
    const code = `<div>{cond ? <p>yes</p> : <p>no</p>}</div>`;
    const ast = reactTranslator.translate(code);
    expect(ast.children![0]).toMatchObject({ type: 'text', content: 'yes' });
  });

  it('arr.map(...) → 跳过', () => {
    const code = `<ul>{items.map(i => <li>{i}</li>)}</ul>`;
    const ast = reactTranslator.translate(code);
    expect(ast.type).toBe('column');
    // map 表达式跳过, children 为空
    expect(ast.children).toBeUndefined();
  });
});

// ──────────────────────────── translate: 嵌套 ────────────────────────────

describe('reactTranslator.translate: 嵌套结构', () => {
  it('深层嵌套', () => {
    const code = `
      <div className="app">
        <header>
          <nav>
            <a href="/">Home</a>
            <a href="/about">About</a>
          </nav>
        </header>
        <main>
          <section>
            <h1>Welcome</h1>
            <p>This is a paragraph.</p>
          </section>
        </main>
      </div>
    `;
    const ast = reactTranslator.translate(code);
    expect(ast.type).toBe('container');
    expect(ast.children).toHaveLength(2);
    // header > nav > 2 个 a
    const header = ast.children![0];
    expect(header.type).toBe('container');
    const nav = header.children![0];
    expect(nav.type).toBe('container');
    expect(nav.children).toHaveLength(2);
    // main > section > h1 + p
    const main = ast.children![1];
    expect(main.type).toBe('container');
    const section = main.children![0];
    expect(section.type).toBe('container');
    expect(section.children).toHaveLength(2);
  });

  it('自定义组件嵌套', () => {
    const code = `
      <Card>
        <CardHeader title="Hello" />
        <CardBody>
          <p>Content here</p>
        </CardBody>
      </Card>
    `;
    const ast = reactTranslator.translate(code);
    // Card 是自定义组件 → container
    expect(ast.type).toBe('container');
    expect(ast.children).toHaveLength(2);
    // CardHeader 自闭合, 无 children → container 无 children
    expect(ast.children![0].type).toBe('container');
    // CardBody 自定义组件 → container, 有 <p> 子节点
    const body = ast.children![1];
    expect(body.type).toBe('container');
    expect(body.children).toHaveLength(1);
    expect(body.children![0]).toMatchObject({ type: 'text', content: 'Content here' });
  });
});

// ──────────────────────────── translate: TypeScript ────────────────────────────

describe('reactTranslator.translate: TSX (TypeScript)', () => {
  it('TSX 带类型注解', () => {
    const code = `
      interface Props { name: string; }
      const Greeting = ({ name }: Props) => <h1>Hello {name}</h1>;
    `;
    const ast = reactTranslator.translate(code);
    expect(ast.type).toBe('text');
    expect(ast.content).toContain('Hello');
    expect(ast.content).toContain('{name}');
  });

  it('TSX 带 import type', () => {
    const code = `
      import type { FC } from 'react';
      const App: FC = () => <div>app</div>;
    `;
    const ast = reactTranslator.translate(code);
    expect(ast.type).toBe('container');
    expect(ast.children![0]).toMatchObject({ type: 'text', content: 'app' });
  });
});

// ──────────────────────────── translate: 错误处理 ────────────────────────────

describe('reactTranslator.translate: 错误处理', () => {
  it('空字符串 → TranslateError', () => {
    expect(() => reactTranslator.translate('')).toThrow();
  });

  it('非 JSX 代码 → TranslateError (未找到根)', () => {
    const code = `const x = 42; console.log(x);`;
    expect(() => reactTranslator.translate(code)).toThrow(/未找到/);
  });
});

// ──────────────────────────── 统一入口 ────────────────────────────

describe('统一入口 translateCode (react)', () => {
  it('指定 language=react', () => {
    const ast = translateCode('<div>hi</div>', 'react');
    expect(ast.type).toBe('container');
  });

  it('isLanguageSupported("react")', () => {
    expect(isLanguageSupported('react')).toBe(true);
  });

  it('isLanguageSupported("REACT") 大小写不敏感', () => {
    expect(isLanguageSupported('REACT')).toBe(true);
  });

  it('自动检测 React 代码', () => {
    const code = `import React from 'react';\nconst App = () => <div><p>Hello</p></div>;`;
    const translator = detectLanguage(code);
    expect(translator).not.toBeNull();
    // 注意: htmlTranslator 也可能匹配, 但 react 置信度更高 (0.9 vs 0.7)
    // 这里只验证能检测到某个翻译器
  });
});
