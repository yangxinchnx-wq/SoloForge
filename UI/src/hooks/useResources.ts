// ─────────────────────────────────────────────────────────────────
// 资源管理 Hook
// 文件树 + 选中文件 + 内容（前端内置示例树，便于开箱即用）
// ─────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react';
import type { FileNode } from '../types';

const STORAGE_KEY = 'soloforge.files.tree.v1';

const DEFAULT_TREE: FileNode = {
  id: 'root',
  name: 'soloforge-workspace',
  type: 'folder',
  path: '/',
  children: [
    {
      id: 'src', name: 'src', type: 'folder', path: '/src',
      children: [
        {
          id: 'src_components', name: 'components', type: 'folder', path: '/src/components',
          children: [
            { id: 'c_layout',     name: 'Layout.tsx',        type: 'file', path: '/src/components/Layout.tsx',        language: 'typescript', size: 1840 },
            { id: 'c_chat',       name: 'ChatInput.tsx',     type: 'file', path: '/src/components/ChatInput.tsx',     language: 'typescript', size: 3220 },
            { id: 'c_filetree',   name: 'FileTree.tsx',      type: 'file', path: '/src/components/FileTree.tsx',      language: 'typescript', size: 2480 },
            { id: 'c_modal',      name: 'Modal.tsx',         type: 'file', path: '/src/components/Modal.tsx',         language: 'typescript', size: 1120 },
            { id: 'c_button',     name: 'Button.tsx',        type: 'file', path: '/src/components/Button.tsx',        language: 'typescript', size: 940  },
            { id: 'c_editor',     name: 'CodeEditor.tsx',    type: 'file', path: '/src/components/CodeEditor.tsx',    language: 'typescript', size: 5610 },
            { id: 'c_settings',   name: 'SettingsPanel.tsx', type: 'file', path: '/src/components/SettingsPanel.tsx', language: 'typescript', size: 3010 },
          ],
        },
        { id: 'src_index', name: 'index.ts', type: 'file', path: '/src/index.ts', language: 'typescript', size: 1240 },
        { id: 'src_api', name: 'api-server.ts', type: 'file', path: '/src/api-server.ts', language: 'typescript', size: 9872 },
        { id: 'src_kernel', name: 'runtime-kernel.ts', type: 'file', path: '/src/kernel/runtime-kernel.ts', language: 'typescript', size: 5402 },
        { id: 'src_court', name: 'consensagent.ts', type: 'file', path: '/src/core/court/consensagent.ts', language: 'typescript', size: 3300 },
        { id: 'src_repos', name: 'surreal-repositories.ts', type: 'file', path: '/src/data/repositories/surreal-repositories.ts', language: 'typescript', size: 4120 },
        { id: 'src_migrations', name: 'db-migrate.ts', type: 'file', path: '/scripts/db-migrate.ts', language: 'typescript', size: 2200 },
      ],
    },
    {
      id: 'rust', name: 'rust_core', type: 'folder', path: '/rust_core',
      children: [
        { id: 'rust_main', name: 'main.rs', type: 'file', path: '/rust_core/src/main.rs', language: 'rust', size: 880 },
        { id: 'rust_sched', name: 'scheduler.rs', type: 'file', path: '/rust_core/src/scheduler.rs', language: 'rust', size: 4220 },
      ],
    },
    {
      id: 'python', name: 'python', type: 'folder', path: '/python',
      children: [
        { id: 'py_mappo', name: 'mappo_server.py', type: 'file', path: '/python/mappo_server.py', language: 'python', size: 6720 },
        { id: 'py_env', name: 'env.py', type: 'file', path: '/python/env.py', language: 'python', size: 1900 },
      ],
    },
    {
      id: 'migrations', name: 'migrations', type: 'folder', path: '/migrations',
      children: [
        { id: 'm1', name: 'v1_base.surql', type: 'file', path: '/migrations/v1_base.surql', language: 'sql', size: 980 },
        { id: 'm2', name: 'v2_decision.surql', type: 'file', path: '/migrations/v2_decision.surql', language: 'sql', size: 1100 },
        { id: 'm3', name: 'v3_court.surql', type: 'file', path: '/migrations/v3_court.surql', language: 'sql', size: 1430 },
        { id: 'm4', name: 'v4_governor.surql', type: 'file', path: '/migrations/v4_governor.surql', language: 'sql', size: 1680 },
        { id: 'm5', name: 'v5_events.surql', type: 'file', path: '/migrations/v5_events.surql', language: 'sql', size: 2210 },
      ],
    },
    { id: 'pkg', name: 'package.json', type: 'file', path: '/package.json', language: 'json', size: 740 },
    { id: 'readme', name: 'README.md', type: 'file', path: '/README.md', language: 'markdown', size: 4400 },
  ],
};

const DEMO_CONTENTS: Record<string, string> = {
  '/src/index.ts': `// SoloForge 全系统点火发射台
import { RuntimeKernel } from './kernel/runtime-kernel';
import { SoloForgeApiServer } from './api-server';

async function main() {
  const kernel = new RuntimeKernel();
  await kernel.boot();
  const api = new SoloForgeApiServer(kernel);
  await api.start();
}

mainSystemIgnitionEngine();
`,

  '/src/components/Layout.tsx': `// 主布局 - 顶栏 + 三栏
import React from 'react';

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col h-screen">
      <TopBar />
      <div className="flex flex-1">
        <ActivityBar />
        <Sidebar />
        <main className="flex-1">{children}</main>
      </div>
      <StatusBar />
    </div>
  );
}
`,

  '/src/components/ChatInput.tsx': `// 聊天输入组件
import { useState } from 'react';

export function ChatInput({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState('');

  const handleSend = () => {
    if (text.trim()) {
      onSend(text);
      setText('');
    }
  };

  return (
    <div className="chat-input">
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
          }
        }}
      />
      <button onClick={handleSend}>发送</button>
    </div>
  );
}
`,

  '/src/components/FileTree.tsx': `// 文件树组件
import { useState } from 'react';

interface Node {
  name: string;
  type: 'file' | 'folder';
  children?: Node[];
}

export function FileTree({ root }: { root: Node }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set([root.name]));

  return (
    <ul>
      <TreeNode node={root} depth={0} expanded={expanded} setExpanded={setExpanded} />
    </ul>
  );
}
`,

  '/src/components/Modal.tsx': `// 通用 Modal
import { ReactNode } from 'react';

export function Modal({ open, onClose, children }: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
`,

  '/src/components/Button.tsx': `// 通用按钮
export function Button({ children, onClick, variant = 'primary' }: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  return (
    <button
      className={\`btn btn-\${variant}\`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
`,

  '/src/components/CodeEditor.tsx': `// 代码编辑器
import { useState } from 'react';

export function CodeEditor({ file, value, onChange }: {
  file: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="editor">
      <div className="editor-tab">{file}</div>
      <textarea
        className="editor-textarea"
        value={value}
        onChange={e => onChange(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}
`,

  '/src/components/SettingsPanel.tsx': `// 设置面板
export function SettingsPanel() {
  return (
    <div className="settings">
      <h2>设置</h2>
      <ThemeSection />
      <BackendSection />
      <ShortcutSection />
    </div>
  );
}
`,
  '/src/api-server.ts': `// SoloForge API Server
// 暴露内核状态给前端：/api/status, /api/agents, /api/observation/* 等
import http from 'http';
import { RuntimeKernel } from './kernel/runtime-kernel';

export class SoloForgeApiServer {
  start() {
    return new Promise<void>((resolve) => {
      this.server = http.createServer(this.handle);
      this.server.listen(3001, resolve);
    });
  }
}
`,
  '/src/kernel/runtime-kernel.ts': `// RuntimeKernel - 微内核主体
export class RuntimeKernel {
  state = 'READY';
  version = 1;
  currentTick = 0;
  startedAt = Date.now();
  // ...
}
`,
  '/rust_core/src/main.rs': `// SoloForge Rust 调度器
fn main() {
    let scheduler = Scheduler::new();
    scheduler.run();
}
`,
  '/python/mappo_server.py': `# MAPPO 多智能体强化学习推理服务
from fastapi import FastAPI
app = FastAPI()

@app.post("/infer")
def infer(obs): ...
`,
  '/migrations/v1_base.surql': `DEFINE TABLE migration_history SCHEMAFULL;
DEFINE TABLE system_config SCHEMAFULL;`,
  '/package.json': `{
  "name": "soloforge",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts"
  }
}`,
  '/README.md': `# SoloForge

分布式 MARL 智能体治理系统。
`,
  '/src/core/court/consensagent.ts': `// 共识代理法庭
export class ConsensAgentCourtRoom {
  async bootCourtRoom() { /* ... */ }
}`,
  '/src/data/repositories/surreal-repositories.ts': `// SurrealDB 仓储层
export class SurrealRepositories { /* ... */ }`,
  '/scripts/db-migrate.ts': `// 迁移执行器
import { runMigrations } from '../migrations';
runMigrations();
`,
  '/rust_core/src/scheduler.rs': `pub struct Scheduler;
impl Scheduler { pub fn new() -> Self { Self } }`,
  '/python/env.py': `# Python 环境配置
OBS_DIM = 64
N_AGENTS = 8
`,
  '/migrations/v2_decision.surql': `DEFINE TABLE decision SCHEMAFULL;`,
  '/migrations/v3_court.surql': `DEFINE TABLE courtSubmission SCHEMAFULL;`,
  '/migrations/v4_governor.surql': `DEFINE TABLE marlEpisode SCHEMAFULL;`,
  '/migrations/v5_events.surql': `DEFINE TABLE eventLog SCHEMAFULL;`,
};

function loadTree(): FileNode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return DEFAULT_TREE;
}

function saveTree(tree: FileNode) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tree)); } catch { /* ignore */ }
}

export function useResources() {
  const [tree, setTree] = useState<FileNode>(loadTree);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    root: true, src: true, rust: false, python: false, migrations: true,
  });
  const [activeFile, setActiveFile] = useState<string>('/src/index.ts');
  // 多文件 Tab 状态
  const [openFiles, setOpenFiles] = useState<string[]>(['/src/index.ts']);
  const [filter, setFilter] = useState('');

  useEffect(() => { saveTree(tree); }, [tree]);

  // 把 contents 暴露到 window 供斜杠命令使用
  useEffect(() => {
    (window as any).__soloforge_contents = DEMO_CONTENTS;
  }, []);

  const toggle = useCallback((id: string) => {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const resetTree = useCallback(() => {
    setTree(DEFAULT_TREE);
    setExpanded({ root: true, src: true });
  }, []);

  // 打开文件：加入 Tab，激活为 activeFile
  const openFile = useCallback((path: string) => {
    setActiveFile(path);
    setOpenFiles(prev => prev.includes(path) ? prev : [...prev, path]);
  }, []);

  // 关闭文件 Tab
  const closeFile = useCallback((path: string) => {
    setOpenFiles(prev => {
      const next = prev.filter(p => p !== path);
      if (activeFile === path) {
        const newActive = next[next.length - 1] || '';
        setActiveFile(newActive);
      }
      return next;
    });
  }, [activeFile]);

  // 关闭其他 / 关闭全部
  const closeOthers = useCallback((keep: string) => {
    setOpenFiles([keep]);
    setActiveFile(keep);
  }, []);
  const closeAll = useCallback(() => {
    setOpenFiles([]);
    setActiveFile('');
  }, []);

  const content = DEMO_CONTENTS[activeFile] ?? '// 暂无内容预览';

  // 平铺渲染
  const flat: Array<{ node: FileNode; depth: number }> = [];
  const walk = (n: FileNode, depth: number) => {
    if (filter) {
      if (!n.name.toLowerCase().includes(filter.toLowerCase())) {
        // 文件夹可能含匹配子项，简单跳过
        if (n.type === 'file') return;
      }
    }
    flat.push({ node: n, depth });
    if (n.type === 'folder' && expanded[n.id] && n.children) {
      for (const c of n.children) walk(c, depth + 1);
    }
  };
  walk(tree, 0);

  return {
    tree, setTree,
    expanded, toggle, setExpanded,
    activeFile, setActiveFile,
    openFiles, openFile, closeFile, closeOthers, closeAll,
    content,
    contents: DEMO_CONTENTS,
    filter, setFilter,
    flat,
    resetTree,
  };
}
