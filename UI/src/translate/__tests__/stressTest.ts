/**
 * stressTest.ts — 11 款翻译器压力测试 (同步诊断版)
 *
 * 目标:
 *   - 用越复杂越好的 UI 代码压测每个翻译器
 *   - 不调 LLM / Agent, 纯本地翻译 (同步 in-thread)
 *   - 输出 AST 结构分析 (深度 / 节点数 / 类型分布)
 *   - 检测潜在问题 (空 children / 未识别属性 / 异常节点)
 *   - 打印 AST 树形结构便于人工核对
 *
 * 运行: npx tsx src/translate/__tests__/stressTest.ts
 */

import { translateCode } from '../index';
import type { UniversalNode } from '../../services/canvas/UniversalAST';

// ──────────────────────────── 11 款复杂 UI 样本 ────────────────────────────

interface Sample {
  language: string;
  label: string;
  code: string;
}

const samples: Sample[] = [
  // ── 1. HTML: 完整仪表盘 ──
  {
    language: 'html',
    label: 'HTML 仪表盘 (嵌套 + 样式 + 表单 + 列表)',
    code: `<!DOCTYPE html>
<html>
<head><title>Dashboard</title></head>
<body>
  <header class="navbar">
    <div class="logo">SoloForge</div>
    <nav>
      <ul>
        <li><a href="#home">首页</a></li>
        <li><a href="#projects">项目</a></li>
        <li><a href="#settings">设置</a></li>
      </ul>
    </nav>
  </header>
  <main>
    <section class="hero">
      <h1>欢迎回来</h1>
      <p>今日活跃任务 <strong>12</strong> 个</p>
      <button id="cta">查看详情</button>
    </section>
    <section class="stats">
      <div class="card">
        <h3>用户</h3>
        <p>1,234</p>
      </div>
      <div class="card">
        <h3>收入</h3>
        <p>¥56,789</p>
      </div>
      <div class="card">
        <h3>订单</h3>
        <p>89</p>
      </div>
    </section>
    <section class="form">
      <form>
        <label>用户名</label>
        <input type="text" placeholder="输入用户名" />
        <label>密码</label>
        <input type="password" placeholder="输入密码" />
        <button type="submit">登录</button>
      </form>
    </section>
  </main>
  <footer>
    <p>&copy; 2026 SoloForge</p>
  </footer>
</body>
</html>`,
  },

  // ── 2. React: 函数组件 + props + 列表 ──
  {
    language: 'react',
    label: 'React TSX (组件 + 列表 + 表单 + 样式)',
    code: `interface Props { title: string; items: string[] }
const Dashboard = ({ title, items }: Props) => {
  return (
    <div className="app">
      <header>
        <h1>{title}</h1>
        <button onClick={() => alert('hi')}>刷新</button>
      </header>
      <main>
        <section className="list">
          {items.map((item, i) => (
            <div key={i} className="item">
              <span>{item}</span>
              <button>删除</button>
            </div>
          ))}
        </section>
        <section className="form">
          <form>
            <input type="text" placeholder="新条目" />
            <button type="submit">添加</button>
          </form>
        </section>
      </main>
    </div>
  );
};`,
  },

  // ── 3. Vue: SFC + 指令 + 插值 ──
  {
    language: 'vue',
    label: 'Vue SFC (template + script + v-for + v-if)',
    code: `<template>
  <div class="container">
    <header>
      <h1>{{ title }}</h1>
      <button @click="refresh">刷新</button>
    </header>
    <main>
      <section v-if="items.length > 0">
        <div v-for="(item, i) in items" :key="i" class="row">
          <span>{{ item.name }}</span>
          <span>{{ item.price }}</span>
          <button @click="remove(i)">删除</button>
        </div>
      </section>
      <p v-else>暂无数据</p>
      <form @submit.prevent="add">
        <input v-model="newItem" placeholder="新增条目" />
        <button type="submit">添加</button>
      </form>
    </main>
  </div>
</template>
<script setup>
import { ref } from 'vue'
const title = ref('商品列表')
const items = ref([])
const newItem = ref('')
</script>`,
  },

  // ── 4. Flutter: 嵌套 Widget + 修饰符 ──
  {
    language: 'flutter',
    label: 'Flutter (Scaffold + AppBar + 列表 + 表单)',
    code: `import 'package:flutter/material.dart';
class DashboardPage extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        appBar: AppBar(
          title: Text('SoloForge'),
          actions: [
            IconButton(icon: Icon(Icons.refresh), onPressed: () {}),
          ],
        ),
        body: Column(
          children: [
            Container(
              padding: EdgeInsets.all(16),
              color: Colors.blue,
              child: Text(
                '欢迎回来',
                style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold),
              ),
            ),
            Expanded(
              child: ListView(
                children: [
                  ListTile(
                    leading: Icon(Icons.person),
                    title: Text('用户1'),
                    subtitle: Text('admin@example.com'),
                  ),
                  ListTile(
                    leading: Icon(Icons.person),
                    title: Text('用户2'),
                    subtitle: Text('user@example.com'),
                  ),
                ],
              ),
            ),
            Padding(
              padding: EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: TextField(
                decoration: InputDecoration(
                  labelText: '搜索',
                  border: OutlineInputBorder(),
                ),
              ),
            ),
            ElevatedButton(
              onPressed: () {},
              child: Text('提交'),
            ),
          ],
        ),
        floatingActionButton: FloatingActionButton(
          onPressed: () {},
          child: Icon(Icons.add),
        ),
      ),
    );
  }
}`,
  },

  // ── 5. SwiftUI: VStack/HStack + 修饰符链 ──
  {
    language: 'swiftui',
    label: 'SwiftUI (VStack + HStack + List + 修饰符)',
    code: `import SwiftUI
struct DashboardView: View {
    var body: some View {
        NavigationView {
            VStack(spacing: 16) {
                HStack {
                    Text("SoloForge")
                        .font(.title)
                        .fontWeight(.bold)
                    Spacer()
                    Button("刷新") {
                        print("refresh")
                    }
                }
                .padding(16)
                .background(Color.blue)
                .foregroundColor(.white)
                .cornerRadius(8)

                List {
                    HStack {
                        Image(systemName: "person")
                        VStack(alignment: .leading) {
                            Text("用户1")
                                .font(.headline)
                            Text("admin@example.com")
                                .font(.caption)
                                .foregroundColor(.gray)
                        }
                    }
                    HStack {
                        Image(systemName: "person")
                        VStack(alignment: .leading) {
                            Text("用户2")
                                .font(.headline)
                            Text("user@example.com")
                                .font(.caption)
                                .foregroundColor(.gray)
                        }
                    }
                }

                HStack {
                    TextField("搜索", text: .constant(""))
                        .textFieldStyle(RoundedBorderTextFieldStyle())
                    Button("提交") {
                        print("submit")
                    }
                }
                .padding(16)
            }
            .navigationTitle("Dashboard")
        }
    }
}`,
  },

  // ── 6. Compose: Column/Row + Modifier ──
  {
    language: 'compose',
    label: 'Jetpack Compose (Column + Row + LazyColumn + Card)',
    code: `@Composable
fun DashboardScreen() {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(
                text = "SoloForge",
                fontSize = 24.sp,
                fontWeight = FontWeight.Bold
            )
            Button(onClick = { }) {
                Text("刷新")
            }
        }
        Spacer(modifier = Modifier.height(16.dp))
        Card(
            modifier = Modifier.fillMaxWidth(),
            elevation = 4.dp
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("用户1", fontSize = 18.sp)
                Text("admin@example.com", color = Color.Gray)
            }
        }
        Spacer(modifier = Modifier.height(8.dp))
        Card(
            modifier = Modifier.fillMaxWidth(),
            elevation = 4.dp
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("用户2", fontSize = 18.sp)
                Text("user@example.com", color = Color.Gray)
            }
        }
        Spacer(modifier = Modifier.height(16.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            OutlinedTextField(
                value = "",
                onValueChange = { },
                label = { Text("搜索") },
                modifier = Modifier.weight(1f)
            )
            Spacer(modifier = Modifier.width(8.dp))
            Button(onClick = { }) {
                Text("提交")
            }
        }
    }
}`,
  },

  // ── 7. Android XML: LinearLayout 嵌套 ──
  {
    language: 'android',
    label: 'Android XML (LinearLayout 嵌套 + CardView)',
    code: `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical"
    android:padding="16dp">

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:gravity="center_vertical">

        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="SoloForge"
            android:textSize="24sp"
            android:textStyle="bold" />

        <View
            android:layout_width="0dp"
            android:layout_height="0dp"
            android:layout_weight="1" />

        <Button
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="刷新" />
    </LinearLayout>

    <androidx.cardview.widget.CardView
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="16dp">

        <LinearLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:orientation="vertical"
            android:padding="16dp">

            <TextView
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="用户1"
                android:textSize="18sp" />

            <TextView
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="admin@example.com"
                android:textColor="#888888" />
        </LinearLayout>
    </androidx.cardview.widget.CardView>

    <EditText
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="16dp"
        android:hint="搜索"
        android:inputType="text" />

    <Button
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="8dp"
        android:text="提交" />
</LinearLayout>`,
  },

  // ── 8. XAML: WPF StackPanel + Grid ──
  {
    language: 'xaml',
    label: 'XAML WPF (StackPanel + Grid + Border)',
    code: `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        Title="Dashboard" Height="600" Width="400">
    <StackPanel Orientation="Vertical" Margin="16">
        <Grid Margin="0,0,0,16">
            <Grid.ColumnDefinitions>
                <ColumnDefinition Width="*" />
                <ColumnDefinition Width="Auto" />
            </Grid.ColumnDefinitions>
            <TextBlock Grid.Column="0" Text="SoloForge" FontSize="24" FontWeight="Bold" />
            <Button Grid.Column="1" Content="刷新" />
        </Grid>
        <Border Background="#F0F0F0" CornerRadius="8" Padding="16" Margin="0,0,0,8">
            <StackPanel Orientation="Vertical">
                <TextBlock Text="用户1" FontSize="18" />
                <TextBlock Text="admin@example.com" Foreground="Gray" />
            </StackPanel>
        </Border>
        <Border Background="#F0F0F0" CornerRadius="8" Padding="16" Margin="0,0,0,16">
            <StackPanel Orientation="Vertical">
                <TextBlock Text="用户2" FontSize="18" />
                <TextBlock Text="user@example.com" Foreground="Gray" />
            </StackPanel>
        </Border>
        <StackPanel Orientation="Horizontal" Margin="0,0,0,8">
            <TextBox Width="280" Text="搜索" />
            <Button Content="提交" Margin="8,0,0,0" />
        </StackPanel>
    </StackPanel>
</Window>`,
  },

  // ── 9. QML: Rectangle 嵌套 ──
  {
    language: 'qml',
    label: 'Qt QML (Rectangle + Column + Row + 颜色)',
    code: `import QtQuick 2.15
import QtQuick.Controls 2.15

Rectangle {
    width: 400
    height: 600
    color: "#FFFFFF"

    Column {
        anchors.fill: parent
        anchors.margins: 16
        spacing: 16

        Rectangle {
            width: parent.width
            height: 60
            color: "#3B82F6"
            radius: 8

            Row {
                anchors.fill: parent
                anchors.margins: 12

                Text {
                    text: "SoloForge"
                    color: "white"
                    font.pixelSize: 24
                    font.bold: true
                    anchors.verticalCenter: parent.verticalCenter
                }

                Item { width: parent.width - 200; height: 1 }

                Button {
                    text: "刷新"
                    anchors.verticalCenter: parent.verticalCenter
                }
            }
        }

        Rectangle {
            width: parent.width
            height: 80
            color: "#F3F4F6"
            radius: 8

            Column {
                anchors.fill: parent
                anchors.margins: 12
                spacing: 4

                Text {
                    text: "用户1"
                    font.pixelSize: 18
                }

                Text {
                    text: "admin@example.com"
                    color: "#6B7280"
                    font.pixelSize: 14
                }
            }
        }

        Rectangle {
            width: parent.width
            height: 80
            color: "#F3F4F6"
            radius: 8

            Column {
                anchors.fill: parent
                anchors.margins: 12
                spacing: 4

                Text {
                    text: "用户2"
                    font.pixelSize: 18
                }

                Text {
                    text: "user@example.com"
                    color: "#6B7280"
                    font.pixelSize: 14
                }
            }
        }

        Row {
            width: parent.width
            spacing: 8

            TextField {
                width: parent.width - 100
                placeholderText: "搜索"
            }

            Button {
                text: "提交"
            }
        }
    }
}`,
  },

  // ── 10. Python: Tkinter 复杂界面 ──
  {
    language: 'python',
    label: 'Python Tkinter (Frame 嵌套 + 表单 + 按钮)',
    code: `import tkinter as tk
from tkinter import ttk

root = tk.Tk()
root.title("SoloForge Dashboard")
root.geometry("400x600")

# 顶部栏
header = tk.Frame(root, bg="#3B82F6", padx=16, pady=12)
title_label = tk.Label(header, text="SoloForge", bg="#3B82F6", fg="white",
                       font=("Arial", 24, "bold"))
refresh_btn = tk.Button(header, text="刷新", bg="white", fg="#3B82F6")
title_label.pack(side="left")
refresh_btn.pack(side="right")
header.pack(fill="x")

# 用户列表区
list_frame = tk.Frame(root, padx=16, pady=16)
list_frame.pack(fill="both", expand=True)

# 用户卡片 1
card1 = tk.Frame(list_frame, bg="#F3F4F6", padx=12, pady=12)
name1 = tk.Label(card1, text="用户1", bg="#F3F4F6", font=("Arial", 18))
email1 = tk.Label(card1, text="admin@example.com", bg="#F3F4F6", fg="#6B7280")
name1.pack(anchor="w")
email1.pack(anchor="w")
card1.pack(fill="x", pady=(0, 8))

# 用户卡片 2
card2 = tk.Frame(list_frame, bg="#F3F4F6", padx=12, pady=12)
name2 = tk.Label(card2, text="用户2", bg="#F3F4F6", font=("Arial", 18))
email2 = tk.Label(card2, text="user@example.com", bg="#F3F4F6", fg="#6B7280")
name2.pack(anchor="w")
email2.pack(anchor="w")
card2.pack(fill="x", pady=(0, 8))

# 底部表单
form_frame = tk.Frame(root, padx=16, pady=16)
form_frame.pack(side="bottom", fill="x")

search_entry = tk.Entry(form_frame)
submit_btn = tk.Button(form_frame, text="提交")
search_entry.pack(side="left", fill="x", expand=True)
submit_btn.pack(side="right", padx=(8, 0))

root.mainloop()`,
  },

  // ── 11. C: Win32 完整窗口 ──
  {
    language: 'c',
    label: 'C Win32 (父窗口 + 按钮 + 静态文本 + 编辑框)',
    code: `#include <windows.h>

LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
        case WM_CREATE: {
            // 顶部标题
            HWND hTitle = CreateWindow("static", "SoloForge Dashboard",
                WS_CHILD | WS_VISIBLE | SS_CENTER,
                10, 10, 380, 30,
                hwnd, NULL, NULL, NULL);

            // 刷新按钮
            HWND hRefresh = CreateWindow("button", "刷新",
                WS_CHILD | WS_VISIBLE,
                320, 50, 70, 24,
                hwnd, NULL, NULL, NULL);

            // 用户卡片 1 - 容器
            HWND hCard1 = CreateWindowEx(0, "static", "",
                WS_CHILD | WS_VISIBLE,
                10, 90, 380, 60,
                hwnd, NULL, NULL, NULL);

            HWND hName1 = CreateWindow("static", "用户1",
                WS_CHILD | WS_VISIBLE,
                12, 12, 200, 20,
                hCard1, NULL, NULL, NULL);

            HWND hEmail1 = CreateWindow("static", "admin@example.com",
                WS_CHILD | WS_VISIBLE,
                12, 36, 200, 16,
                hCard1, NULL, NULL, NULL);

            // 用户卡片 2 - 容器
            HWND hCard2 = CreateWindowEx(0, "static", "",
                WS_CHILD | WS_VISIBLE,
                10, 160, 380, 60,
                hwnd, NULL, NULL, NULL);

            HWND hName2 = CreateWindow("static", "用户2",
                WS_CHILD | WS_VISIBLE,
                12, 12, 200, 20,
                hCard2, NULL, NULL, NULL);

            HWND hEmail2 = CreateWindow("static", "user@example.com",
                WS_CHILD | WS_VISIBLE,
                12, 36, 200, 16,
                hCard2, NULL, NULL, NULL);

            // 底部搜索框
            HWND hSearch = CreateWindow("edit", "",
                WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL,
                10, 550, 300, 24,
                hwnd, NULL, NULL, NULL);

            HWND hSubmit = CreateWindow("button", "提交",
                WS_CHILD | WS_VISIBLE,
                320, 550, 70, 24,
                hwnd, NULL, NULL, NULL);
            break;
        }
        case WM_DESTROY:
            PostQuitMessage(0);
            break;
        default:
            return DefWindowProc(hwnd, msg, wParam, lParam);
    }
    return 0;
}`,
  },
];

// ──────────────────────────── AST 分析 ────────────────────────────

interface AstStats {
  totalNodes: number;
  maxDepth: number;
  typeDistribution: Record<string, number>;
  containerCount: number;
  leafCount: number;
  emptyContainers: number;
  emptyTextOrButton: number;
  /** 带样式节点数 */
  styledNodes: number;
}

function analyzeAst(node: UniversalNode, depth = 1): AstStats {
  const stats: AstStats = {
    totalNodes: 1,
    maxDepth: depth,
    typeDistribution: { [node.type]: 1 },
    containerCount: 0,
    leafCount: 0,
    emptyContainers: 0,
    emptyTextOrButton: 0,
    styledNodes: 0,
  };

  const isContainer = ['container', 'row', 'column', 'stack'].includes(node.type);
  const isLeaf = ['text', 'button', 'input', 'image', 'divider', 'spacer'].includes(node.type);

  if (isContainer) {
    stats.containerCount++;
    const kids = (node as any).children || [];
    if (kids.length === 0) stats.emptyContainers++;
  }
  if (isLeaf) {
    stats.leafCount++;
    if (node.type === 'text' && !(node as any).content) stats.emptyTextOrButton++;
    if (node.type === 'button' && !(node as any).label) stats.emptyTextOrButton++;
  }
  if ((node as any).style && Object.keys((node as any).style).length > 0) {
    stats.styledNodes++;
  }

  const children = (node as any).children as UniversalNode[] | undefined;
  if (children && Array.isArray(children)) {
    for (const child of children) {
      const childStats = analyzeAst(child, depth + 1);
      stats.totalNodes += childStats.totalNodes;
      stats.maxDepth = Math.max(stats.maxDepth, childStats.maxDepth);
      for (const [k, v] of Object.entries(childStats.typeDistribution)) {
        stats.typeDistribution[k] = (stats.typeDistribution[k] || 0) + v;
      }
      stats.containerCount += childStats.containerCount;
      stats.leafCount += childStats.leafCount;
      stats.emptyContainers += childStats.emptyContainers;
      stats.emptyTextOrButton += childStats.emptyTextOrButton;
      stats.styledNodes += childStats.styledNodes;
    }
  }

  return stats;
}

/** 打印 AST 树 (深度限制避免输出过长) */
function printAst(node: UniversalNode, indent = 0, maxDepth = 5): string {
  if (indent > maxDepth) return '';
  const pad = '  '.repeat(indent);
  let line = `${pad}${node.type}`;

  const n = node as any;
  if (node.type === 'text' && n.content) line += ` "${String(n.content).slice(0, 30)}"`;
  if (node.type === 'button' && n.label) line += ` "${String(n.label).slice(0, 30)}"`;
  if (node.type === 'input' && n.placeholder) line += ` ph="${String(n.placeholder).slice(0, 20)}"`;
  if (node.type === 'image' && n.src) line += ` src="${String(n.src).slice(0, 20)}"`;

  const styleKeys = n.style ? Object.keys(n.style) : [];
  if (styleKeys.length > 0) line += ` {${styleKeys.join(',')}}`;

  let out = line + '\n';
  if (n.children && Array.isArray(n.children)) {
    for (const child of n.children) {
      out += printAst(child, indent + 1, maxDepth);
    }
  }
  return out;
}

// ──────────────────────────── 运行测试 ────────────────────────────

function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  SoloForge 翻译器压力测试 (11 款 · 越复杂越好 · 同步诊断)');
  console.log('═══════════════════════════════════════════════════════════\n');

  const issues: Array<{ sample: string; issue: string }> = [];
  const results: Array<{ sample: Sample; ast: UniversalNode | null; stats: AstStats | null; elapsed: number; error: string | null }> = [];

  // ── 阶段 1: 逐个翻译 + 分析 ──
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  阶段 1: 逐个翻译 (in-thread, 测量耗时)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  for (const sample of samples) {
    const start = performance.now();
    let ast: UniversalNode | null = null;
    let error: string | null = null;
    try {
      ast = translateCode(sample.code, sample.language);
    } catch (err: any) {
      error = err.message;
    }
    const elapsed = (performance.now() - start).toFixed(2);

    if (error) {
      console.log(`  [${sample.language.padEnd(8)}] ✗ 翻译失败`);
      console.log(`             错误: ${error}`);
      console.log(`             耗时: ${elapsed}ms\n`);
      issues.push({ sample: sample.language, issue: `翻译失败: ${error}` });
      results.push({ sample, ast: null, stats: null, elapsed: parseFloat(elapsed), error });
      continue;
    }

    const stats = analyzeAst(ast!);
    console.log(`  [${sample.language.padEnd(8)}] ✓ ${sample.label}`);
    console.log(`             耗时 ${elapsed}ms | 节点 ${stats.totalNodes} | 深度 ${stats.maxDepth} | 容器 ${stats.containerCount} | 叶子 ${stats.leafCount} | 带样式 ${stats.styledNodes}`);
    console.log(`             类型分布: ${JSON.stringify(stats.typeDistribution)}`);

    if (stats.emptyContainers > 0) {
      console.log(`             ⚠ 空容器: ${stats.emptyContainers}`);
      issues.push({ sample: sample.language, issue: `${stats.emptyContainers} 个空容器` });
    }
    if (stats.emptyTextOrButton > 0) {
      console.log(`             ⚠ 空文本/按钮: ${stats.emptyTextOrButton}`);
      issues.push({ sample: sample.language, issue: `${stats.emptyTextOrButton} 个空文本/按钮` });
    }
    console.log('');
    results.push({ sample, ast, stats, elapsed: parseFloat(elapsed), error: null });
  }

  // ── 阶段 2: AST 树形打印 (全部 11 个, 限深度 4) ──
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  阶段 2: AST 树形结构 (深度限制 4)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  for (const r of results) {
    if (!r.ast) {
      console.log(`【${r.sample.language}】(翻译失败, 跳过)\n`);
      continue;
    }
    console.log(`【${r.sample.language}】${r.sample.label}`);
    console.log(printAst(r.ast, 0, 4));
  }

  // ── 阶段 3: 大代码压力测试 ──
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  阶段 3: 大代码压力测试 (1000 节点 HTML)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const hugeHtml = '<div>' + Array.from({ length: 1000 }, (_, i) =>
    `<div class="item-${i}"><span>项目 ${i}</span><button>删除</button></div>`
  ).join('') + '</div>';

  const hugeStart = performance.now();
  let hugeAst: UniversalNode | null = null;
  let hugeError: string | null = null;
  try {
    hugeAst = translateCode(hugeHtml, 'html');
  } catch (err: any) {
    hugeError = err.message;
  }
  const hugeElapsed = (performance.now() - hugeStart).toFixed(2);

  if (hugeError) {
    console.log(`  ✗ 大 HTML 翻译失败: ${hugeError}\n`);
    issues.push({ sample: 'huge-html', issue: `大代码翻译失败: ${hugeError}` });
  } else if (hugeAst) {
    const hugeStats = analyzeAst(hugeAst);
    console.log(`  ✓ 大 HTML (1000 个 div)`);
    console.log(`    字符数 ${hugeHtml.length} | 耗时 ${hugeElapsed}ms`);
    console.log(`    节点 ${hugeStats.totalNodes} | 深度 ${hugeStats.maxDepth} | 容器 ${hugeStats.containerCount} | 叶子 ${hugeStats.leafCount}`);
    console.log(`    类型分布: ${JSON.stringify(hugeStats.typeDistribution)}\n`);
  }

  // ── 阶段 4: 汇总 ──
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  汇总');
  console.log('═══════════════════════════════════════════════════════════\n');

  // 成功率
  const success = results.filter(r => r.ast !== null).length;
  console.log(`翻译成功: ${success}/${samples.length}`);

  // 耗时分布
  const times = results.filter(r => r.stats).map(r => ({ lang: r.sample.language, ms: r.elapsed, nodes: r.stats!.totalNodes }));
  times.sort((a, b) => b.ms - a.ms);
  console.log(`\n耗时排名 (高 → 低):`);
  for (const t of times) {
    console.log(`  ${t.lang.padEnd(8)} ${t.ms.toFixed(2).padStart(8)}ms  ${String(t.nodes).padStart(5)} 节点`);
  }

  // 节点规模分布
  console.log(`\n节点规模分布:`);
  const byNodes = [...results.filter(r => r.stats)].sort((a, b) => b.stats!.totalNodes - a.stats!.totalNodes);
  for (const r of byNodes) {
    const s = r.stats!;
    const leafRatio = s.containerCount > 0 ? (s.leafCount / s.totalNodes * 100).toFixed(0) : '0';
    console.log(`  ${r.sample.language.padEnd(8)} ${String(s.totalNodes).padStart(4)} 节点  深${s.maxDepth}  容器${String(s.containerCount).padStart(3)} 叶子${String(s.leafCount).padStart(3)}  叶子占比 ${leafRatio}%`);
  }

  // 问题清单
  if (issues.length === 0) {
    console.log(`\n✓ 无问题检出`);
  } else {
    console.log(`\n检出 ${issues.length} 个潜在问题:`);
    for (const { sample, issue } of issues) {
      console.log(`  [${sample.padEnd(8)}] ${issue}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  压力测试完成');
  console.log('═══════════════════════════════════════════════════════════\n');
}

main();
