/**
 * tests/fixtures/scenarios.ts — 测试场景 fixture
 *
 * 提供 3 个完整的 PreviewPayload（Python / C / Java）用于单测和 e2e 测试。
 * 来自 spike/scenarios.ts 的移植版，适配 UI 项目结构（不依赖 React/UI）。
 *
 * 用途：
 *   - vitest 单测的 mock LLM 输出
 *   - e2e 测试的 fixture
 *   - 手动测试时的样本
 */

import type { PreviewPayload } from '../../src/services/canvas/UniversalAST';

export interface Scenario {
  id: string;
  title: string;
  language: string;
  framework: string;
  prompt: string;
  payload: PreviewPayload;
}

const pythonPayload: PreviewPayload = {
  language: 'python',
  framework: 'Flask + Jinja2',
  source_code: `# app.py
from flask import Flask, render_template, request, redirect, url_for

app = Flask(__name__)

@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        email = request.form["email"]
        password = request.form["password"]
        if authenticate(email, password):
            return redirect(url_for("dashboard"))
        return render_template("login.html", error="Invalid credentials"), 401
    return render_template("login.html")

def authenticate(email: str, password: str) -> bool:
    return email == "demo@soloforge.dev" and password == "forge"

if __name__ == "__main__":
    app.run(debug=True, port=5000)`,
  preview: {
    notes: 'Mobile-first login. Indigo gradient.',
    root: {
      type: 'column',
      style: {
        width: '100%',
        height: '100%',
        padding: [32, 24, 24, 24],
        gap: 20,
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      },
      children: [
        {
          type: 'text',
          content: 'Welcome back',
          style: { color: '#ffffff', fontSize: 28, fontWeight: 700 },
        },
        {
          type: 'text',
          content: 'Sign in to continue to SoloForge.',
          style: { color: 'rgba(255,255,255,0.78)', fontSize: 14 },
        },
        {
          type: 'column',
          style: {
            gap: 12,
            margin: [24, 0, 0, 0],
            padding: [20, 18, 20, 18],
            background: 'rgba(255,255,255,0.96)',
            radius: 16,
          },
          children: [
            {
              type: 'input',
              placeholder: 'you@soloforge.dev',
              kind: 'email',
              style: { background: '#f5f5f7', radius: 10, padding: [12, 14, 12, 14], width: '100%' },
            },
            {
              type: 'input',
              placeholder: 'Password',
              kind: 'password',
              style: { background: '#f5f5f7', radius: 10, padding: [12, 14, 12, 14], width: '100%' },
            },
            {
              type: 'button',
              label: 'Sign in',
              variant: 'filled',
              style: {
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                color: '#ffffff',
                radius: 12,
                padding: [14, 0, 14, 0],
                width: '100%',
                margin: [8, 0, 0, 0],
                fontSize: 15,
                fontWeight: 600,
              },
            },
          ],
        },
      ],
    },
  },
};

const cPayload: PreviewPayload = {
  language: 'c',
  framework: 'GTK3',
  source_code: `// notepad.c
#include <gtk/gtk.h>

int main(int argc, char **argv) {
    GtkApplication *app = gtk_application_new("dev.soloforge.notepad", G_APPLICATION_FLAGS_NONE);
    return g_application_run(G_APPLICATION(app), argc, argv);
}`,
  preview: {
    notes: 'GTK look: dense menus, monospace editor.',
    root: {
      type: 'column',
      style: { width: '100%', height: '100%', background: '#ffffff' },
      children: [
        {
          type: 'row',
          style: { background: '#e0e0e0', padding: [6, 12, 6, 12], gap: 14, border: '1px solid #c8c8c8' },
          children: [
            { type: 'text', content: 'File', style: { fontSize: 13, fontWeight: 500 } },
            { type: 'text', content: 'Edit', style: { fontSize: 13 } },
            { type: 'text', content: 'View', style: { fontSize: 13 } },
            { type: 'text', content: 'Help', style: { fontSize: 13 } },
          ],
        },
        {
          type: 'column',
          style: { flex: 1, padding: [16, 16, 16, 16], gap: 6, background: '#fefefe' },
          children: [
            { type: 'text', content: '# Meeting notes', style: { fontSize: 14, fontWeight: 700 } },
            { type: 'text', content: '', style: { fontSize: 12 } },
            { type: 'text', content: '- Discuss migration to WASM renderer', style: { fontSize: 13 } },
          ],
        },
      ],
    },
  },
};

const javaPayload: PreviewPayload = {
  language: 'java',
  framework: 'Swing',
  source_code: `// Calculator.java
import javax.swing.*;

public class Calculator extends JFrame {
    public Calculator() {
        setTitle("Calculator");
        setSize(320, 440);
        setDefaultCloseOperation(EXIT_ON_CLOSE);
        setLayout(new BorderLayout(8, 8));
    }

    public static void main(String[] args) {
        SwingUtilities.invokeLater(() -> new Calculator().setVisible(true));
    }
}`,
  preview: {
    notes: 'Swing dark theme: Menlo monospace, 4×4 grid.',
    root: {
      type: 'column',
      style: { width: '100%', height: '100%', background: '#2b2b2b', padding: [8, 8, 8, 8], gap: 6 },
      children: [
        {
          type: 'text',
          content: '1,234.56',
          style: {
            background: '#3c3c3c',
            color: '#ffffff',
            fontSize: 28,
            fontWeight: 700,
            textAlign: 'right',
            padding: [14, 14, 14, 14],
            width: '100%',
            radius: 6,
          },
        },
      ],
    },
  },
};

export const scenarios: Scenario[] = [
  {
    id: 'python-login',
    title: 'Mobile login — Python · Flask',
    language: 'python',
    framework: 'Flask + Jinja2',
    prompt: 'Build a calm, mobile-first login screen with email + password.',
    payload: pythonPayload,
  },
  {
    id: 'c-gtk-notepad',
    title: 'Minimal notepad — C · GTK3',
    language: 'c',
    framework: 'GTK3',
    prompt: 'Sketch a minimal notepad in GTK3 with a menu bar and body text.',
    payload: cPayload,
  },
  {
    id: 'java-calc',
    title: 'Dark calculator — Java · Swing',
    language: 'java',
    framework: 'Swing',
    prompt: 'Make a dark-themed calculator in Java Swing, 4×4 grid, monospace digits.',
    payload: javaPayload,
  },
];

/** 按 id 取场景 */
export function getScenario(id: string): Scenario | undefined {
  return scenarios.find((s) => s.id === id);
}
