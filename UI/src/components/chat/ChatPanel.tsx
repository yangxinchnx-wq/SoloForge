// ─────────────────────────────────────────────────────────────────
// 对话区
// - 自动撑高输入框
// - 拖拽上传附件
// - 工具栏：技能 / 记忆 / 上传 / 工具 / 标签 / 知识库
// - @ 提及命令
// - 发送按钮 + 停止按钮
// - 建议提示
// ─────────────────────────────────────────────────────────────────

import { useState, useRef, useEffect, useMemo } from 'react';
import type { useChat } from '../../hooks/useChat';
import { PanelHeader, Tooltip, IconButton, Badge, Button, StatusDot } from '../ui/Button';
import { pushNotification } from '../overlays/Notifications';
import { RoleSelector, ROLES, type AgentRole } from '../overlays/RoleSelector';

interface Props {
  chat: ReturnType<typeof useChat>;
}

interface Tool {
  id: string;
  icon: string;
  label: string;
  description: string;
}

const TOOLS: Tool[] = [
  { id: 'skill',  icon: 'auto_awesome',  label: '技能',   description: '使用预设技能' },
  { id: 'memory', icon: 'memory',        label: '记忆',   description: '召回长期记忆' },
  { id: 'upload', icon: 'attach_file',   label: '上传',   description: '上传文件' },
  { id: 'tool',   icon: 'build_circle',  label: '工具',   description: '调用外部工具' },
  { id: 'tag',    icon: 'label',         label: '标签',   description: '添加标签' },
  { id: 'kb',     icon: 'library_books', label: '知识库', description: '检索知识库' },
];

const QUICK_PROMPTS = [
  { icon: 'auto_awesome', text: '解释这段代码的逻辑',  tag: '代码' },
  { icon: 'bug_report',   text: '帮我找一下潜在 bug',  tag: '调试' },
  { icon: 'science',      text: '运行测试并报告结果',  tag: '测试' },
  { icon: 'edit_note',    text: '添加 TypeScript 注释', tag: '文档' },
  { icon: 'transform',    text: '将 Python 改写为 Rust', tag: '迁移' },
  { icon: 'psychology',   text: '分析这个架构的优缺点', tag: '架构' },
];

export function ChatPanel({ chat }: Props) {
  const [text, setText] = useState('');
  const [tools, setTools] = useState({
    skill: true, memory: true, upload: false, tool: true, tag: false, kb: false,
  });
  const [files, setFiles] = useState<Array<{ name: string; size: number }>>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [showQuick, setShowQuick] = useState(true);
  const [showRoleSelector, setShowRoleSelector] = useState(false);
  const [role, setRole] = useState<AgentRole>('assistant');
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const currentRole = useMemo(() => ROLES.find(r => r.id === role) || ROLES[0], [role]);

  // 自动撑高
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [text]);

  // 自动隐藏快速提示（有内容时）
  useEffect(() => {
    setShowQuick(text.length === 0);
  }, [text]);

  const submit = () => {
    if (!text.trim() || chat.busy) return;
    const refs = chat.consumeAttachments();
    const refPrefix = refs.length ? refs.map(p => `@file:${p}`).join(' ') + '\n' : '';

    // 斜杠命令处理
    const trimmed = text.trim();
    if (trimmed.startsWith('/')) {
      const [cmd, ...args] = trimmed.split(/\s+/);
      const arg = args.join(' ');
      const file = (chat as any).pendingAttachments?.[0] || (refs[0]);
      switch (cmd) {
        case '/clear': {
          chat.clearStream();
          setText('');
          return;
        }
        case '/help': {
          pushNotification({
            level: 'info',
            title: '斜杠命令帮助',
            message: '/explain · /test · /refactor · /doc · /translate · /clear · /new · /history · /model · /temperature · /system',
          });
          setText('');
          return;
        }
        case '/new': {
          chat.newSession();
          setText('');
          return;
        }
        case '/model': {
          if (arg) {
            chat.setSettings((s: any) => ({ ...s, primaryModel: arg }));
            pushNotification({ level: 'success', title: '主模型已切换', message: arg });
          } else {
            pushNotification({ level: 'info', title: '当前主模型', message: chat.settings.primaryModel });
          }
          setText('');
          return;
        }
        case '/temperature': {
          const t = parseFloat(arg);
          if (!isNaN(t)) {
            chat.setSettings((s: any) => ({ ...s, temperature: t }));
            pushNotification({ level: 'success', title: '温度已设置', message: arg });
          }
          setText('');
          return;
        }
        case '/system': {
          chat.setSettings((s: any) => ({ ...s, systemPrompt: arg || s.systemPrompt }));
          setText('');
          return;
        }
        case '/history': {
          // 切换到 history tab（通过 chat hook 的 activeSession 切换）
          pushNotification({ level: 'info', title: '历史对话', message: `${chat.sessions.length} 个会话` });
          setText('');
          return;
        }
        case '/explain':
        case '/test':
        case '/refactor':
        case '/doc':
        case '/translate': {
          const modeMap: Record<string, 'explain' | 'refactor' | 'test'> = {
            '/explain': 'explain', '/test': 'test', '/refactor': 'refactor',
          };
          const mode = modeMap[cmd];
          // 找到当前引用的文件
          const filePath = refs[0];
          if (!filePath) {
            pushNotification({ level: 'warning', title: '请先引用文件', message: '从左侧资源树拖入文件后再使用此命令' });
            setText('');
            return;
          }
          const fileName = filePath.split('/').pop() || filePath;
          const allFiles = (window as any).__soloforge_contents || {};
          const content = allFiles[filePath] || '';
          if (mode) {
            (chat as any).explainInline?.(filePath, 1, content.split('\n').length, content, mode);
            pushNotification({ level: 'success', title: '已生成' + cmd, message: `${fileName} · 见下方"AI 解释"面板` });
            setText('');
            return;
          }
          // 其它命令走普通 send
          const prompt = `${cmd} ${arg || filePath}`;
          chat.send(refPrefix + prompt, files.map(f => f.name));
          setText('');
          setFiles([]);
          return;
        }
        default: {
          pushNotification({ level: 'warning', title: '未知命令', message: `${cmd} — 输入 /help 查看可用命令` });
          setText('');
          return;
        }
      }
    }

    chat.send(refPrefix + text, files.map(f => f.name));
    setText('');
    setFiles([]);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // 斜杠命令（输入 / 触发）
  const slashCmds = useMemo(() => {
    if (!text.startsWith('/') || text.length > 20) return [];
    return [
      { cmd: '/explain',     desc: '解释当前文件',         icon: 'menu_book' },
      { cmd: '/test',        desc: '为当前代码生成测试',   icon: 'science' },
      { cmd: '/refactor',    desc: '重构当前函数',         icon: 'build' },
      { cmd: '/doc',         desc: '生成文档注释',         icon: 'edit_note' },
      { cmd: '/translate',   desc: '翻译为中文',           icon: 'translate' },
      { cmd: '/clear',       desc: '清空流送区',           icon: 'delete_sweep' },
      { cmd: '/new',         desc: '新建对话',             icon: 'add' },
      { cmd: '/history',     desc: '查看历史',             icon: 'history' },
      { cmd: '/model',       desc: '切换主模型 (用法: /model gpt-4o)', icon: 'model_training' },
      { cmd: '/temperature', desc: '设置温度 (0-2)',       icon: 'thermostat' },
      { cmd: '/system',      desc: '设置系统提示词',       icon: 'tune' },
      { cmd: '/help',        desc: '显示所有命令',         icon: 'help' },
    ].filter(c => c.cmd.startsWith(text));
  }, [text]);

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list) return;
    setFiles(prev => [...prev, ...Array.from(list).map(f => ({ name: f.name, size: f.size }))]);
    e.target.value = '';
  };

  // 拖拽 — 接收来自 FileExplorer 的引用 / 接收本地文件
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
  const onDragLeave = () => setIsDragging(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    // 来自 FileExplorer 的路径引用
    const refData = e.dataTransfer.getData('text/x-soloforge-paths');
    if (refData) {
      try {
        const paths = JSON.parse(refData) as string[];
        paths.forEach(p => chat.attachFiles([p]));
        return;
      } catch { /* ignore */ }
    }
    if (e.dataTransfer.files) {
      setFiles(prev => [...prev, ...Array.from(e.dataTransfer.files).map(f => ({ name: f.name, size: f.size }))]);
    }
  };

  // 同步 chat.pendingAttachments → 渲染为 @file 引用
  const refs = chat.pendingAttachments || [];

  const activeToolCount = useMemo(() => Object.values(tools).filter(Boolean).length, [tools]);
  const totalSize = useMemo(() => files.reduce((s, f) => s + f.size, 0), [files]);

  return (
    <div className="flex flex-col h-full bg-bg-dim">
      <PanelHeader
        icon="chat"
        title="对话区"
        count={
          <div className="flex items-center gap-1.5">
            {chat.busy ? (
              <>
                <StatusDot status="pending" pulse />
                <span className="text-warning">生成中</span>
              </>
            ) : (
              <>
                <StatusDot status="success" />
                <span>就绪</span>
              </>
            )}
            {activeToolCount > 0 && (
              <Badge variant="primary">{activeToolCount} 工具</Badge>
            )}
          </div>
        }
        action={
          <>
            <Tooltip content="温度">
              <div className="flex items-center gap-1.5 px-2 h-6 bg-surface-high border border-border-light rounded text-[10px] text-text-secondary">
                <span className="material-symbols-outlined text-xs">thermostat</span>
                <span>{chat.settings.temperature.toFixed(1)}</span>
              </div>
            </Tooltip>
            <Tooltip content="系统提示词">
              <IconButton icon="tune" size="xs" onClick={() => alert('打开系统提示词编辑')} />
            </Tooltip>
            <Tooltip content="语音输入">
              <IconButton icon="mic" size="xs" />
            </Tooltip>
          </>
        }
      />

      <div className="flex-1 overflow-y-auto p-3 scrollbar-thin">
        {/* 快速提示 */}
        {showQuick && (
          <div className="mb-3 animate-fade-in">
            <div className="flex items-center gap-2 mb-2 text-[10px] text-text-secondary">
              <span className="material-symbols-outlined text-sm">lightbulb</span>
              <span>建议提示 · </span>
              <button
                onClick={() => setShowRoleSelector(true)}
                className="flex items-center gap-1 text-primary hover:underline"
              >
                <span className={`material-symbols-outlined text-xs ${currentRole.color}`}>{currentRole.icon}</span>
                {currentRole.name}
                <span className="material-symbols-outlined text-[10px]">swap_horiz</span>
              </button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {QUICK_PROMPTS.map((p, i) => (
                <button
                  key={i}
                  onClick={() => setText(p.text)}
                  className="group flex items-start gap-2 p-2 rounded-lg border border-border-light bg-surface hover:border-primary hover:bg-primary/5 transition-all text-left"
                >
                  <span className="material-symbols-outlined text-primary text-sm shrink-0 mt-0.5">{p.icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] text-text truncate">{p.text}</div>
                    <Badge variant="default" className="mt-0.5">{p.tag}</Badge>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 附件预览 */}
        {files.length > 0 && (
          <div className="mb-2 animate-slide-in-up">
            <div className="flex items-center justify-between mb-1.5 text-[10px] text-text-secondary">
              <span className="flex items-center gap-1">
                <span className="material-symbols-outlined text-xs">attach_file</span>
                附件 ({files.length}) · {formatSize(totalSize)}
              </span>
              <button onClick={() => setFiles([])} className="text-text-secondary hover:text-danger">清空</button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {files.map((f, i) => (
                <div key={i} className="group flex items-center gap-1.5 px-2 py-1 rounded-md bg-surface border border-border-light text-[10px]">
                  <span className="material-symbols-outlined text-primary text-sm">description</span>
                  <span className="text-text max-w-[160px] truncate">{f.name}</span>
                  <span className="text-text-secondary font-mono">{formatSize(f.size)}</span>
                  <button
                    onClick={() => setFiles(files.filter((_, j) => j !== i))}
                    className="material-symbols-outlined text-xs text-text-secondary hover:text-danger ml-1"
                  >close</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 输入区 */}
        <div
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={`flex-1 flex flex-col bg-surface rounded-xl border-2 transition-colors ${
            isDragging ? 'border-primary border-dashed bg-primary/5' : 'border-border focus-within:border-primary'
          }`}
        >
          {isDragging && (
            <div className="flex items-center justify-center h-20 text-primary text-sm">
              <span className="material-symbols-outlined text-2xl mr-2">file_download</span>
              释放以引用文件 / 上传
            </div>
          )}

          {/* @file 引用展示 */}
          {refs.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2 animate-slide-in-up">
              {refs.map((p, i) => (
                <div
                  key={i}
                  className="group flex items-center gap-1 px-2 py-1 rounded-md bg-primary-container/40 border border-primary/30 text-[10px] animate-fade-in"
                >
                  <span className="material-symbols-outlined text-primary text-sm">alternate_email</span>
                  <span className="font-mono text-text max-w-[180px] truncate" title={p}>{p.split('/').pop()}</span>
                  <span className="text-text-secondary font-mono text-[9px]">{p}</span>
                  <button
                    onClick={() => {
                      const next = refs.filter((_, j) => j !== i);
                      // 简单清空再重设
                      chat.consumeAttachments();
                      next.forEach(x => chat.attachFiles([x]));
                    }}
                    className="material-symbols-outlined text-xs text-text-secondary hover:text-danger ml-1"
                  >close</button>
                </div>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKey}
            rows={2}
            placeholder="向 SoloForge 提问... (Shift+Enter 换行 · 输入 / 看命令)"
            className="w-full resize-none bg-transparent text-sm text-text placeholder-text-secondary p-3 focus:outline-none font-sans"
            style={{ display: isDragging ? 'none' : 'block' }}
          />

          {slashCmds.length > 0 && (
            <div className="absolute bottom-full mb-1 left-0 w-72 bg-surface border border-border rounded-lg shadow-2xl overflow-hidden z-30 animate-slide-in-up">
              <div className="px-3 py-1.5 text-[10px] text-text-secondary border-b border-border-light bg-bg-dim">
                <span className="material-symbols-outlined text-xs align-middle">bolt</span> 斜杠命令
              </div>
              {slashCmds.map(c => (
                <button
                  key={c.cmd}
                  onClick={() => { setText(c.cmd + ' '); textareaRef.current?.focus(); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-surface-high text-left"
                >
                  <span className="material-symbols-outlined text-sm text-primary">{c.icon}</span>
                  <span className="font-mono text-text">{c.cmd}</span>
                  <span className="text-text-secondary ml-auto">{c.desc}</span>
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1 px-2 py-1.5 border-t border-border-light">
            {TOOLS.map(t => {
              const isActive = tools[t.id as keyof typeof tools];
              return (
                <Tooltip key={t.id} content={t.description}>
                  <button
                    onClick={() => {
                      if (t.id === 'upload') {
                        fileRef.current?.click();
                      } else {
                        setTools(s => ({ ...s, [t.id]: !s[t.id as keyof typeof s] }));
                      }
                    }}
                    className={`flex items-center gap-1 px-2 h-6 rounded text-[10px] transition-colors ${
                      isActive
                        ? 'bg-primary-container text-on-primary-container'
                        : 'text-text-secondary hover:text-text hover:bg-surface-high'
                    }`}
                  >
                    <span className={`material-symbols-outlined text-sm ${isActive ? 'filled' : ''}`}>{t.icon}</span>
                    <span>{t.label}</span>
                  </button>
                </Tooltip>
              );
            })}

            <input ref={fileRef} type="file" multiple hidden onChange={onPickFiles} />

            <div className="flex-1" />

            <span className="text-[10px] text-text-secondary font-mono mr-1">
              {text.length} / 4096
            </span>

            {chat.busy ? (
              <Button variant="danger" size="sm" icon="stop" onClick={chat.stop}>停止</Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                icon="send"
                onClick={submit}
                disabled={!text.trim()}
              >
                发送
              </Button>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between mt-2 text-[10px] text-text-secondary">
          <div className="flex items-center gap-2">
            <span>模型:</span>
            <span className="text-text">{chat.settings.hybridEnabled ? `${chat.settings.primaryModel} + ${chat.settings.secondaryModel}` : chat.settings.primaryModel}</span>
            <span>·</span>
            <button onClick={() => setShowRoleSelector(true)} className="flex items-center gap-1 text-primary hover:underline">
              <span className={`material-symbols-outlined text-xs ${currentRole.color}`}>{currentRole.icon}</span>
              {currentRole.name}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span>快捷键:</span>
            <kbd className="px-1 bg-surface-high rounded font-mono">Enter</kbd>
            <span>发送</span>
            <kbd className="px-1 bg-surface-high rounded font-mono">Shift+Enter</kbd>
            <span>换行</span>
          </div>
        </div>
      </div>

      <RoleSelector
        open={showRoleSelector}
        onClose={() => setShowRoleSelector(false)}
        current={role}
        onSelect={setRole}
      />
    </div>
  );
}

function formatSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
