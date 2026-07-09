/**
 * translatorsSmoke.test.ts — 6 个新翻译器的烟雾测试
 *
 * 不追求 100% 覆盖, 只验证核心功能可用:
 *   - detect 返回合理置信度
 *   - translate 不抛错, 返回正确类型的根节点
 *   - 统一入口 translateCode 能正常调用
 */

import { describe, it, expect } from 'vitest';
import { flutterTranslator } from '../flutterTranslator';
import { swiftuiTranslator } from '../swiftuiTranslator';
import { composeTranslator } from '../composeTranslator';
import { androidXmlTranslator } from '../androidXmlTranslator';
import { xamlTranslator } from '../xamlTranslator';
import { qmlTranslator } from '../qmlTranslator';
import { translateCode, isLanguageSupported, getSupportedLanguages } from '../index';

// ──────────────────────────── Flutter ────────────────────────────

describe('flutterTranslator 烟雾测试', () => {
  it('detect 完整 Flutter 代码', () => {
    const code = `import 'package:flutter/material.dart';
      class App extends StatelessWidget {
        Widget build(BuildContext context) {
          return MaterialApp(home: Scaffold(body: Center(child: Text('hi'))));
        }
      }`;
    expect(flutterTranslator.detect(code)).toBeGreaterThanOrEqual(0.6);
  });

  it('translate 简单 Container', () => {
    const ast = flutterTranslator.translate(`return Container(child: Text('hello'));`);
    expect(ast.type).toBe('container');
  });

  it('translate Row + Column', () => {
    const code = `return Row(children: [Text('a'), Text('b')]);`;
    const ast = flutterTranslator.translate(code);
    expect(ast.type).toBe('row');
    expect(ast.children).toHaveLength(2);
  });

  it('translate Button', () => {
    const ast = flutterTranslator.translate(`return ElevatedButton(child: Text('Click'), onPressed: () {});`);
    expect(ast.type).toBe('button');
    expect(ast.label).toBe('Click');
  });

  it('translate Padding + EdgeInsets', () => {
    const ast = flutterTranslator.translate(`return Padding(padding: EdgeInsets.all(16), child: Text('hi'));`);
    expect(ast.type).toBe('container');
    expect(ast.style?.padding).toBe(16);
  });

  it('translate 颜色 Color(0xFF42A5F5)', () => {
    const ast = flutterTranslator.translate(`return Container(color: Color(0xFF42A5F5), child: Text('hi'));`);
    expect(ast.style?.background).toBe('#42A5F5');
  });
});

// ──────────────────────────── SwiftUI ────────────────────────────

describe('swiftuiTranslator 烟雾测试', () => {
  it('detect SwiftUI 代码', () => {
    const code = `import SwiftUI
      struct ContentView: View {
        var body: some View {
          VStack { Text("Hello") }
        }
      }`;
    expect(swiftuiTranslator.detect(code)).toBeGreaterThanOrEqual(0.6);
  });

  it('translate VStack', () => {
    const ast = swiftuiTranslator.translate(`VStack { Text("hello") }`);
    expect(ast.type).toBe('column');
  });

  it('translate Text + 修饰符', () => {
    const ast = swiftuiTranslator.translate(`Text("hello").padding(16).background(Color.red)`);
    expect(ast.type).toBe('text');
    expect(ast.content).toBe('hello');
    expect(ast.style?.padding).toBe(16);
    expect(ast.style?.background).toBe('red');
  });

  it('translate Button', () => {
    const ast = swiftuiTranslator.translate(`Button("Click") { }`);
    expect(ast.type).toBe('button');
    expect(ast.label).toBe('Click');
  });

  it('translate HStack', () => {
    const ast = swiftuiTranslator.translate(`HStack { Text("a"); Text("b") }`);
    expect(ast.type).toBe('row');
    expect(ast.children).toHaveLength(2);
  });
});

// ──────────────────────────── Compose ────────────────────────────

describe('composeTranslator 烟雾测试', () => {
  it('detect Compose 代码', () => {
    const code = `@Composable
      fun App() {
        Column { Text("Hello") }
      }`;
    expect(composeTranslator.detect(code)).toBeGreaterThanOrEqual(0.6);
  });

  it('translate Column', () => {
    const ast = composeTranslator.translate(`Column { Text("hello") }`);
    expect(ast.type).toBe('column');
  });

  it('translate Text', () => {
    const ast = composeTranslator.translate(`Text("hello")`);
    expect(ast.type).toBe('text');
    expect(ast.content).toBe('hello');
  });

  it('translate Button with Text child', () => {
    const ast = composeTranslator.translate(`Button(onClick = {}) { Text("Click") }`);
    expect(ast.type).toBe('button');
    expect(ast.label).toBe('Click');
  });

  it('translate Row', () => {
    const ast = composeTranslator.translate(`Row { Text("a"); Text("b") }`);
    expect(ast.type).toBe('row');
    expect(ast.children).toHaveLength(2);
  });
});

// ──────────────────────────── Android XML ────────────────────────────

describe('androidXmlTranslator 烟雾测试', () => {
  it('detect Android XML', () => {
    const code = `<?xml version="1.0" encoding="utf-8"?>
      <LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
        android:layout_width="match_parent"
        android:layout_height="match_parent"
        android:orientation="vertical">
        <TextView android:text="Hello" />
      </LinearLayout>`;
    expect(androidXmlTranslator.detect(code)).toBeGreaterThanOrEqual(0.85);
  });

  it('translate LinearLayout vertical', () => {
    const code = `<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
      android:orientation="vertical">
      <TextView android:text="Hello" />
    </LinearLayout>`;
    const ast = androidXmlTranslator.translate(code);
    expect(ast.type).toBe('column');
    expect(ast.children).toHaveLength(1);
    expect(ast.children![0]).toMatchObject({ type: 'text', content: 'Hello' });
  });

  it('translate Button', () => {
    const code = `<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android">
      <Button android:text="Click" />
    </LinearLayout>`;
    const ast = androidXmlTranslator.translate(code);
    expect(ast.children![0]).toMatchObject({ type: 'button', label: 'Click' });
  });

  it('translate EditText', () => {
    const code = `<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android">
      <EditText android:hint="Name" />
    </LinearLayout>`;
    const ast = androidXmlTranslator.translate(code);
    expect(ast.children![0]).toMatchObject({ type: 'input', placeholder: 'Name' });
  });
});

// ──────────────────────────── XAML ────────────────────────────

describe('xamlTranslator 烟雾测试', () => {
  it('detect XAML', () => {
    const code = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">
      <StackPanel><TextBlock Text="Hello" /></StackPanel>
    </Window>`;
    expect(xamlTranslator.detect(code)).toBeGreaterThanOrEqual(0.8);
  });

  it('translate StackPanel + TextBlock', () => {
    const code = `<StackPanel Orientation="Vertical">
      <TextBlock Text="Hello" />
    </StackPanel>`;
    const ast = xamlTranslator.translate(code);
    expect(ast.type).toBe('column');
    expect(ast.children![0]).toMatchObject({ type: 'text', content: 'Hello' });
  });

  it('translate Button', () => {
    const code = `<StackPanel><Button Content="Click" /></StackPanel>`;
    const ast = xamlTranslator.translate(code);
    expect(ast.children![0]).toMatchObject({ type: 'button', label: 'Click' });
  });

  it('translate Border + CornerRadius', () => {
    const code = `<Border CornerRadius="8"><TextBlock Text="hi" /></Border>`;
    const ast = xamlTranslator.translate(code);
    expect(ast.type).toBe('container');
    expect(ast.style?.radius).toBe(8);
  });
});

// ──────────────────────────── QML ────────────────────────────

describe('qmlTranslator 烟雾测试', () => {
  it('detect QML', () => {
    const code = `import QtQuick 2.0
      Rectangle { width: 100; height: 100; color: "red" }`;
    expect(qmlTranslator.detect(code)).toBeGreaterThanOrEqual(0.8);
  });

  it('translate Rectangle', () => {
    const ast = qmlTranslator.translate(`Rectangle { color: "red"; width: 100; height: 50 }`);
    expect(ast.type).toBe('container');
    expect(ast.style?.background).toBe('red');
    expect(ast.style?.width).toBe(100);
  });

  it('translate Column + Text', () => {
    const ast = qmlTranslator.translate(`Column { Text { text: "hello" } }`);
    expect(ast.type).toBe('column');
    expect(ast.children![0]).toMatchObject({ type: 'text', content: 'hello' });
  });

  it('translate Button', () => {
    const ast = qmlTranslator.translate(`Button { text: "Click" }`);
    expect(ast.type).toBe('button');
    expect(ast.label).toBe('Click');
  });
});

// ──────────────────────────── 统一入口 ────────────────────────────

describe('统一入口: 11 款翻译器', () => {
  it('getSupportedLanguages 返回 11 个语言', () => {
    const langs = getSupportedLanguages();
    expect(langs).toHaveLength(11);
    expect(langs).toContain('html');
    expect(langs).toContain('react');
    expect(langs).toContain('vue');
    expect(langs).toContain('flutter');
    expect(langs).toContain('swiftui');
    expect(langs).toContain('compose');
    expect(langs).toContain('android');
    expect(langs).toContain('xaml');
    expect(langs).toContain('qml');
    expect(langs).toContain('python');
    expect(langs).toContain('c');
  });

  it('isLanguageSupported 全部支持', () => {
    for (const lang of ['html', 'react', 'vue', 'flutter', 'swiftui', 'compose', 'android', 'xaml', 'qml', 'python', 'c']) {
      expect(isLanguageSupported(lang)).toBe(true);
    }
  });

  it('translateCode 指定各语言', () => {
    expect(() => translateCode('<div>hi</div>', 'html')).not.toThrow();
    expect(() => translateCode('<div>hi</div>', 'react')).not.toThrow();
    expect(() => translateCode('<template><div>hi</div></template>', 'vue')).not.toThrow();
    expect(() => translateCode(`return Text('hi');`, 'flutter')).not.toThrow();
    expect(() => translateCode(`Text("hi")`, 'swiftui')).not.toThrow();
    expect(() => translateCode(`Text("hi")`, 'compose')).not.toThrow();
    expect(() => translateCode('<LinearLayout><TextView android:text="hi" /></LinearLayout>', 'android')).not.toThrow();
    expect(() => translateCode('<StackPanel><TextBlock Text="hi" /></StackPanel>', 'xaml')).not.toThrow();
    expect(() => translateCode(`Rectangle { color: "red" }`, 'qml')).not.toThrow();
    expect(() => translateCode(`Label(root, text="hi")`, 'python')).not.toThrow();
    expect(() => translateCode(`GtkWidget *btn = gtk_button_new_with_label("hi");`, 'c')).not.toThrow();
  });
});
