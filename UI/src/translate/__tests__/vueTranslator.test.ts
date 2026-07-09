/**
 * vueTranslator.test.ts — Vue SFC 翻译器测试
 */

import { describe, it, expect } from 'vitest';
import { vueTranslator } from '../vueTranslator';
import { translateCode, isLanguageSupported } from '../index';

// ──────────────────────────── detect ────────────────────────────

describe('vueTranslator.detect', () => {
  it('完整 SFC (template + script) → 0.95', () => {
    const code = `<template><div>hi</div></template><script>export default {}</script>`;
    expect(vueTranslator.detect(code)).toBe(0.95);
  });

  it('只有 <template> → 0.85', () => {
    const code = `<template><div>hi</div></template>`;
    expect(vueTranslator.detect(code)).toBe(0.85);
  });

  it('Vue 指令特征 → 0.7', () => {
    const code = `<div v-if="show">hi</div>`;
    expect(vueTranslator.detect(code)).toBe(0.7);
  });

  it('@click → 0.7', () => {
    const code = `<button @click="handle">click</button>`;
    expect(vueTranslator.detect(code)).toBe(0.7);
  });

  it(':class 绑定 → 0.7', () => {
    const code = `<div :class="cls">hi</div>`;
    expect(vueTranslator.detect(code)).toBe(0.7);
  });

  it('纯 HTML (无 Vue 特征) → 0', () => {
    const code = `<div><p>hello</p></div>`;
    expect(vueTranslator.detect(code)).toBe(0);
  });

  it('空字符串 → 0', () => {
    expect(vueTranslator.detect('')).toBe(0);
  });
});

// ──────────────────────────── translate: 基础 ────────────────────────────

describe('vueTranslator.translate: 基础', () => {
  it('完整 SFC', () => {
    const code = `
      <template>
        <div>
          <h1>Hello</h1>
          <p>World</p>
        </div>
      </template>
      <script>
      export default { name: 'App' };
      </script>
    `;
    const ast = vueTranslator.translate(code);
    expect(ast.type).toBe('container');
    expect(ast.children).toHaveLength(2);
    expect(ast.children![0].type).toBe('text');
    expect(ast.children![1].type).toBe('text');
  });

  it('只有 template', () => {
    const code = `<template><div><p>hi</p></div></template>`;
    const ast = vueTranslator.translate(code);
    expect(ast.type).toBe('container');
    expect(ast.children![0]).toMatchObject({ type: 'text', content: 'hi' });
  });

  it('p → text', () => {
    const code = `<template><p>hello</p></template>`;
    const ast = vueTranslator.translate(code);
    expect(ast.type).toBe('text');
    expect(ast.content).toBe('hello');
  });

  it('button → button', () => {
    const code = `<template><button>Click</button></template>`;
    const ast = vueTranslator.translate(code);
    expect(ast.type).toBe('button');
    expect(ast.label).toBe('Click');
  });

  it('input → input', () => {
    const code = `<template><input type="text" placeholder="Name" /></template>`;
    const ast = vueTranslator.translate(code);
    expect(ast.type).toBe('input');
    expect(ast.placeholder).toBe('Name');
    expect(ast.kind).toBe('text');
  });

  it('img → image', () => {
    const code = `<template><img src="x.png" alt="pic" /></template>`;
    const ast = vueTranslator.translate(code);
    expect(ast.type).toBe('image');
    expect(ast.src).toBe('x.png');
  });

  it('hr → divider', () => {
    const ast = vueTranslator.translate(`<template><hr /></template>`);
    expect(ast.type).toBe('divider');
  });
});

// ──────────────────────────── translate: 样式 ────────────────────────────

describe('vueTranslator.translate: 样式', () => {
  it('静态 style 字符串', () => {
    const code = `<template><div style="padding:16px;color:red">hi</div></template>`;
    const ast = vueTranslator.translate(code);
    expect(ast.style?.padding).toBe(16);
    expect(ast.style?.color).toBe('red');
  });

  it(':style 绑定对象', () => {
    const code = `<template><div :style="{ padding: 16, color: 'red' }">hi</div></template>`;
    const ast = vueTranslator.translate(code);
    expect(ast.style?.padding).toBe(16);
    expect(ast.style?.color).toBe('red');
  });

  it('style display:flex + flex-direction:row → row', () => {
    const code = `<template><div style="display:flex;flex-direction:row"><span>a</span></div></template>`;
    const ast = vueTranslator.translate(code);
    expect(ast.type).toBe('row');
  });

  it(':style 绑定 display:flex', () => {
    const code = `<template><div :style="{ display: 'flex', flexDirection: 'row' }"><span>a</span></div></template>`;
    const ast = vueTranslator.translate(code);
    expect(ast.type).toBe('row');
  });

  it('class 静态 → button variant', () => {
    const ast = vueTranslator.translate(`<template><button class="btn-outline">X</button></template>`);
    expect(ast.variant).toBe('outlined');
  });
});

// ──────────────────────────── translate: 插值 ────────────────────────────

describe('vueTranslator.translate: 插值 {{ }}', () => {
  it('变量插值 → text 占位', () => {
    const code = `<template><div>{{ name }}</div></template>`;
    const ast = vueTranslator.translate(code);
    expect(ast.children![0]).toMatchObject({ type: 'text', content: '{{ name }}' });
  });

  it('字符串字面量插值 → text', () => {
    const code = `<template><div>{{ 'hello' }}</div></template>`;
    const ast = vueTranslator.translate(code);
    expect(ast.children![0]).toMatchObject({ type: 'text', content: 'hello' });
  });

  it('数字字面量插值 → text', () => {
    const code = `<template><div>{{ 42 }}</div></template>`;
    const ast = vueTranslator.translate(code);
    expect(ast.children![0]).toMatchObject({ type: 'text', content: '42' });
  });

  it('混合文本和插值', () => {
    const code = `<template><p>Hello {{ name }}!</p></template>`;
    const ast = vueTranslator.translate(code);
    expect(ast.type).toBe('text');
    expect(ast.content).toContain('Hello');
    expect(ast.content).toContain('{{ name }}');
  });
});

// ──────────────────────────── translate: 嵌套 ────────────────────────────

describe('vueTranslator.translate: 嵌套结构', () => {
  it('深层嵌套', () => {
    const code = `
      <template>
        <div>
          <header>
            <nav>
              <a href="/">Home</a>
              <a href="/about">About</a>
            </nav>
          </header>
          <main>
            <h1>Welcome</h1>
          </main>
        </div>
      </template>
    `;
    const ast = vueTranslator.translate(code);
    expect(ast.type).toBe('container');
    expect(ast.children).toHaveLength(2);
    const header = ast.children![0];
    const nav = header.children![0];
    expect(nav.children).toHaveLength(2);
  });

  it('自定义组件嵌套', () => {
    const code = `
      <template>
        <MyCard>
          <p>Content</p>
        </MyCard>
      </template>
    `;
    const ast = vueTranslator.translate(code);
    // MyCard 自定义组件 → container
    expect(ast.type).toBe('container');
    expect(ast.children![0]).toMatchObject({ type: 'text', content: 'Content' });
  });

  it('kebab-case 自定义组件', () => {
    const code = `<template><my-card><p>hi</p></my-card></template>`;
    const ast = vueTranslator.translate(code);
    expect(ast.type).toBe('container');
    expect(ast.children![0]).toMatchObject({ type: 'text', content: 'hi' });
  });
});

// ──────────────────────────── translate: 指令 ────────────────────────────

describe('vueTranslator.translate: 指令', () => {
  it('v-if 保留 (无法静态求值, 默认渲染)', () => {
    const code = `<template><div v-if="show">visible</div></template>`;
    const ast = vueTranslator.translate(code);
    expect(ast.type).toBe('container');
    expect(ast.children![0]).toMatchObject({ type: 'text', content: 'visible' });
  });

  it('v-for 渲染第一个子节点', () => {
    const code = `<template><ul><li v-for="item in items">{{ item }}</li></ul></template>`;
    const ast = vueTranslator.translate(code);
    expect(ast.type).toBe('column');
    // v-for 子节点保留 (占位)
    expect(ast.children).toBeDefined();
  });

  it('@click 忽略 (不影响布局)', () => {
    const code = `<template><button @click="handle">Click</button></template>`;
    const ast = vueTranslator.translate(code);
    expect(ast.type).toBe('button');
    expect(ast.label).toBe('Click');
  });

  it(':class 字符串字面量', () => {
    const code = `<template><button :class="'btn-text'">X</button></template>`;
    const ast = vueTranslator.translate(code);
    expect(ast.variant).toBe('text');
  });
});

// ──────────────────────────── translate: 边界 ────────────────────────────

describe('vueTranslator.translate: 边界情况', () => {
  it('空 template', () => {
    const code = `<template></template>`;
    const ast = vueTranslator.translate(code);
    expect(ast.type).toBe('container');
  });

  it('多个顶级节点 → column', () => {
    const code = `<template><p>first</p><p>second</p></template>`;
    const ast = vueTranslator.translate(code);
    expect(ast.type).toBe('column');
    expect(ast.children).toHaveLength(2);
  });

  it('script setup', () => {
    const code = `
      <template>
        <div>{{ count }}</div>
      </template>
      <script setup>
      import { ref } from 'vue';
      const count = ref(0);
      </script>
    `;
    const ast = vueTranslator.translate(code);
    expect(ast.type).toBe('container');
    expect(ast.children![0]).toMatchObject({ type: 'text', content: '{{ count }}' });
  });

  it('带 <style> 块 (忽略)', () => {
    const code = `
      <template><div class="app">hi</div></template>
      <style scoped>
      .app { padding: 16px; }
      </style>
    `;
    const ast = vueTranslator.translate(code);
    expect(ast.type).toBe('container');
    expect(ast.children![0]).toMatchObject({ type: 'text', content: 'hi' });
  });
});

// ──────────────────────────── translate: 错误 ────────────────────────────

describe('vueTranslator.translate: 错误处理', () => {
  it('空字符串 → TranslateError', () => {
    expect(() => vueTranslator.translate('')).toThrow();
  });

  it('非 HTML 代码 → TranslateError', () => {
    expect(() => vueTranslator.translate('const x = 42;')).toThrow();
  });
});

// ──────────────────────────── 统一入口 ────────────────────────────

describe('统一入口 translateCode (vue)', () => {
  it('指定 language=vue', () => {
    const ast = translateCode(`<template><div>hi</div></template>`, 'vue');
    expect(ast.type).toBe('container');
  });

  it('isLanguageSupported("vue")', () => {
    expect(isLanguageSupported('vue')).toBe(true);
  });

  it('isLanguageSupported("VUE") 大小写不敏感', () => {
    expect(isLanguageSupported('VUE')).toBe(true);
  });
});
