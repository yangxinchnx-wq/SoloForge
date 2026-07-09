/**
 * pythonCTranslator.test.ts — Python + C 翻译器烟雾测试
 *
 * 验证:
 *   - detect 返回合理置信度
 *   - translate 不抛错, 返回正确类型的根节点
 *   - Tkinter / PyQt / Win32 / GTK / LVGL 各框架都能解析
 *   - 父子关系重建正确
 *   - 统一入口 + CPU 加速 worker 池
 */

import { describe, it, expect } from 'vitest';
import { pythonTranslator } from '../pythonTranslator';
import { cTranslator } from '../cTranslator';
import {
  translateCode,
  isLanguageSupported,
  getSupportedLanguages,
  translateCodeAsync,
  translateBatch,
  getTranslatorPoolStatus,
} from '../index';

// ──────────────────────────── Python: Tkinter ────────────────────────────

describe('pythonTranslator: Tkinter', () => {
  it('detect Tkinter 代码', () => {
    const code = `import tkinter as tk
root = tk.Tk()
label = tk.Label(root, text="Hello")
btn = tk.Button(root, text="Click")
root.mainloop()`;
    expect(pythonTranslator.detect(code)).toBeGreaterThanOrEqual(0.9);
  });

  it('translate 简单 Tkinter 窗口', () => {
    const code = `import tkinter as tk
root = tk.Tk()
label = tk.Label(root, text="Hello")
btn = tk.Button(root, text="Click")`;
    const ast = pythonTranslator.translate(code);
    expect(ast.type).toBe('container');
  });

  it('translate Label + Button (父子关系)', () => {
    const code = `root = Tk()
Label(root, text="用户名")
Button(root, text="登录")`;
    const ast = pythonTranslator.translate(code);
    expect(ast.type).toBe('container');
    expect(ast.children).toBeDefined();
    expect(ast.children!.length).toBe(2);
    expect(ast.children![0]).toMatchObject({ type: 'text', content: '用户名' });
    expect(ast.children![1]).toMatchObject({ type: 'button', label: '登录' });
  });

  it('translate Entry → input', () => {
    const code = `root = Tk()
entry = Entry(root)`;
    const ast = pythonTranslator.translate(code);
    expect(ast.type).toBe('container');
    expect(ast.children![0]).toMatchObject({ type: 'input' });
  });

  it('translate 颜色和字体属性', () => {
    const code = `root = Tk()
label = Label(root, text="hi", bg="red", fg="white", font=("Arial", 16))`;
    const ast = pythonTranslator.translate(code);
    const label = ast.children![0];
    expect(label.style?.background).toBe('red');
    expect(label.style?.color).toBe('white');
    expect(label.style?.fontSize).toBe(16);
  });
});

// ──────────────────────────── Python: PyQt ────────────────────────────

describe('pythonTranslator: PyQt', () => {
  it('detect PyQt 代码', () => {
    const code = `from PyQt5.QtWidgets import QApplication, QLabel, QPushButton
app = QApplication([])
label = QLabel("Hello")
btn = QPushButton("Click")`;
    expect(pythonTranslator.detect(code)).toBeGreaterThanOrEqual(0.9);
  });

  it('translate PyQt addWidget 父子关系', () => {
    const code = `from PyQt5.QtWidgets import QApplication, QWidget, QVBoxLayout, QLabel, QPushButton
app = QApplication([])
window = QWidget()
layout = QVBoxLayout()
label = QLabel("Hello")
btn = QPushButton("Click")
layout.addWidget(label)
layout.addWidget(btn)
window.setLayout(layout)`;
    const ast = pythonTranslator.translate(code);
    // window 或 layout 是根
    expect(['container', 'column']).toContain(ast.type);
  });
});

// ──────────────────────────── Python: Kivy ────────────────────────────

describe('pythonTranslator: Kivy', () => {
  it('detect Kivy 代码', () => {
    const code = `from kivy.app import App
from kivy.uix.button import Button
btn = Button(text="Click")`;
    expect(pythonTranslator.detect(code)).toBeGreaterThanOrEqual(0.9);
  });
});

// ──────────────────────────── C: Win32 ────────────────────────────

describe('cTranslator: Win32', () => {
  it('detect Win32 代码', () => {
    const code = `#include <windows.h>
HWND btn = CreateWindow("button", "Click", WS_CHILD, 0, 0, 80, 30, hwnd, NULL, hInst, NULL);`;
    expect(cTranslator.detect(code)).toBeGreaterThanOrEqual(0.9);
  });

  it('translate CreateWindow button', () => {
    const code = `#include <windows.h>
HWND btn = CreateWindow("button", "Click", WS_CHILD, 0, 0, 80, 30, NULL, NULL, NULL, NULL);`;
    const ast = cTranslator.translate(code);
    expect(ast.type).toBe('button');
    expect((ast as any).label).toBe('Click');
  });

  it('translate CreateWindow static → text', () => {
    const code = `HWND label = CreateWindow("static", "Hello", WS_CHILD, 0, 0, 100, 20, NULL, NULL, NULL, NULL);`;
    const ast = cTranslator.translate(code);
    expect(ast.type).toBe('text');
    expect((ast as any).content).toBe('Hello');
  });

  it('translate CreateWindow edit → input', () => {
    const code = `HWND edit = CreateWindow("edit", "", WS_CHILD, 0, 0, 100, 20, NULL, NULL, NULL, NULL);`;
    const ast = cTranslator.translate(code);
    expect(ast.type).toBe('input');
  });

  it('translate CreateWindowEx (含父窗口)', () => {
    const code = `#include <windows.h>
HWND parent = CreateWindowEx(0, "static", "", WS_CHILD, 0, 0, 200, 200, NULL, NULL, NULL, NULL);
HWND btn = CreateWindowEx(0, "button", "Click", WS_CHILD, 10, 10, 80, 30, parent, NULL, NULL, NULL);`;
    const ast = cTranslator.translate(code);
    expect(ast.type).toBe('container');
    expect(ast.children).toBeDefined();
    expect(ast.children![0]).toMatchObject({ type: 'button', label: 'Click' });
  });
});

// ──────────────────────────── C: GTK ────────────────────────────

describe('cTranslator: GTK', () => {
  it('detect GTK 代码', () => {
    const code = `#include <gtk/gtk.h>
GtkWidget *btn = gtk_button_new_with_label("Click");`;
    expect(cTranslator.detect(code)).toBeGreaterThanOrEqual(0.9);
  });

  it('translate gtk_button_new_with_label', () => {
    const code = `GtkWidget *btn = gtk_button_new_with_label("Click");`;
    const ast = cTranslator.translate(code);
    expect(ast.type).toBe('button');
    expect((ast as any).label).toBe('Click');
  });

  it('translate gtk_label_new', () => {
    const ast = cTranslator.translate(`GtkWidget *label = gtk_label_new("Hello");`);
    expect(ast.type).toBe('text');
    expect((ast as any).content).toBe('Hello');
  });

  it('translate gtk_box_pack_start 父子关系', () => {
    const code = `GtkWidget *box = gtk_vbox_new(FALSE, 0);
GtkWidget *label = gtk_label_new("Hello");
GtkWidget *btn = gtk_button_new_with_label("Click");
gtk_box_pack_start(GTK_BOX(box), label, TRUE, FALSE, 0);
gtk_box_pack_start(GTK_BOX(box), btn, TRUE, FALSE, 0);`;
    const ast = cTranslator.translate(code);
    expect(['container', 'column']).toContain(ast.type);
    expect(ast.children).toBeDefined();
    expect(ast.children!.length).toBe(2);
  });
});

// ──────────────────────────── C: LVGL ────────────────────────────

describe('cTranslator: LVGL', () => {
  it('detect LVGL 代码', () => {
    const code = `#include "lvgl.h"
lv_obj_t *btn = lv_btn_create(parent);`;
    expect(cTranslator.detect(code)).toBeGreaterThanOrEqual(0.9);
  });

  it('translate lv_btn_create', () => {
    const ast = cTranslator.translate(`lv_obj_t *btn = lv_btn_create(NULL);`);
    expect(ast.type).toBe('button');
  });

  it('translate lv_label_create + set_text', () => {
    const code = `lv_obj_t *label = lv_label_create(NULL);
lv_label_set_text(label, "Hello");`;
    const ast = cTranslator.translate(code);
    expect(ast.type).toBe('text');
    expect((ast as any).content).toBe('Hello');
  });

  it('translate LVGL 父子关系', () => {
    const code = `lv_obj_t *parent = lv_obj_create(NULL);
lv_obj_t *btn = lv_btn_create(parent);
lv_obj_t *label = lv_label_create(btn);`;
    const ast = cTranslator.translate(code);
    expect(ast.type).toBe('container');
    expect(ast.children).toBeDefined();
  });
});

// ──────────────────────────── 统一入口 ────────────────────────────

describe('统一入口: 11 款翻译器', () => {
  it('getSupportedLanguages 返回 11 个语言', () => {
    const langs = getSupportedLanguages();
    expect(langs).toHaveLength(11);
    expect(langs).toContain('python');
    expect(langs).toContain('c');
  });

  it('isLanguageSupported 包含 python / c', () => {
    expect(isLanguageSupported('python')).toBe(true);
    expect(isLanguageSupported('c')).toBe(true);
  });

  it('translateCode 指定 python / c', () => {
    expect(() => translateCode(`Label(root, text="hi")`, 'python')).not.toThrow();
    expect(() => translateCode(`GtkWidget *btn = gtk_button_new_with_label("hi");`, 'c')).not.toThrow();
  });
});

// ──────────────────────────── CPU 加速 worker 池 ────────────────────────────

describe('CPU 加速 worker 池', () => {
  it('getTranslatorPoolStatus 返回状态', () => {
    const status = getTranslatorPoolStatus();
    expect(status).toHaveProperty('env');
    expect(status).toHaveProperty('workerEnabled');
    expect(status).toHaveProperty('cpuCount');
    expect(status.cpuCount).toBeGreaterThan(0);
  });

  it('translateCodeAsync 短代码 in-thread', async () => {
    const result = await translateCodeAsync(`Label(root, text="hi")`, 'python');
    expect(result.node).not.toBeNull();
    expect(result.language).toBe('python');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('translateBatch 小批量 in-thread', async () => {
    const results = await translateBatch([
      { code: `Label(root, text="hi")`, language: 'python' },
      { code: `GtkWidget *btn = gtk_button_new_with_label("hi");`, language: 'c' },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].node).not.toBeNull();
    expect(results[1].node).not.toBeNull();
  });

  it('translateBatch 大批量自动并行', async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      code: `Label(root, text="item ${i}")`,
      language: 'python' as const,
      id: i,
    }));
    const results = await translateBatch(tasks);
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.node).not.toBeNull();
    }
  });

  it('translateCodeAsync 失败返回 error 不抛异常', async () => {
    const result = await translateCodeAsync(`invalid code @@@`, 'python');
    // 失败时 node 为 null, error 有值
    expect(result.node).toBeNull();
    expect(result.error).toBeDefined();
  });
});
