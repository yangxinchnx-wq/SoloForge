// ─────────────────────────────────────────────────────────────────
// 对话历史导出工具
// - Markdown: 单文件 / 多文件
// - HTML: 自包含可搜索 (highlight + 时间线)
// - JSON: 结构化 (兼容 SQL 导入)
// ─────────────────────────────────────────────────────────────────

import type { ChatSession } from '../hooks/useChat';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}

function escapeMd(s: string): string {
  return s.replace(/([\\`*_{}[\]()#+\-.!])/g, '\\$1');
}

// ─── 导出为 Markdown (全部会话) ───
export function exportSessionsAsMarkdown(sessions: ChatSession[], ids?: string[]): string {
  const list = ids ? sessions.filter(s => ids.includes(s.id)) : sessions;
  const lines: string[] = [];
  lines.push(`# SoloForge 对话历史`);
  lines.push(``);
  lines.push(`> 导出时间: ${new Date().toISOString()}  ·  会话数: ${list.length}  ·  消息数: ${list.reduce((s, sess) => s + sess.messages.length, 0)}`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  for (const sess of list) {
    lines.push(`## ${escapeMd(sess.title || '(无标题)')}`);
    lines.push(``);
    lines.push(`- 会话 ID: \`${sess.id}\``);
    lines.push(`- 创建时间: ${new Date(sess.createdAt).toLocaleString('zh-CN', { hour12: false })}`);
    lines.push(`- 最后更新: ${new Date(sess.updatedAt).toLocaleString('zh-CN', { hour12: false })}`);
    lines.push(`- 消息数: ${sess.messages.length}`);
    lines.push(``);
    lines.push(`### 对话内容`);
    lines.push(``);
    for (const m of sess.messages) {
      const role = m.role === 'user' ? '🧑 用户' : m.role === 'assistant' ? '🤖 AI' : '⚙️ 系统';
      lines.push(`#### ${role} · ${new Date(m.timestamp).toLocaleString('zh-CN', { hour12: false })}`);
      if (m.model) lines.push(`*模型: ${m.model}*`);
      lines.push(``);
      lines.push(m.content);
      lines.push(``);
    }
    lines.push(`---`);
    lines.push(``);
  }
  return lines.join('\n');
}

// ─── 导出为 HTML (自包含, 带搜索 + 高亮) ───
export function exportSessionsAsHtml(sessions: ChatSession[], ids?: string[]): string {
  const list = ids ? sessions.filter(s => ids.includes(s.id)) : sessions;
  const totalMessages = list.reduce((s, sess) => s + sess.messages.length, 0);

  const sessionsHtml = list.map(sess => {
    const messagesHtml = sess.messages.map(m => {
      const roleClass = m.role === 'user' ? 'role-user' : m.role === 'assistant' ? 'role-ai' : 'role-sys';
      const roleLabel = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : '系统';
      return `<div class="msg ${roleClass}">
        <div class="msg-head">
          <span class="msg-role">${roleLabel}</span>
          <span class="msg-time">${new Date(m.timestamp).toLocaleString('zh-CN', { hour12: false })}</span>
          ${m.model ? `<span class="msg-model">${escapeHtml(m.model)}</span>` : ''}
        </div>
        <div class="msg-body">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div>
      </div>`;
    }).join('\n');
    return `<section class="session" data-title="${escapeHtml(sess.title.toLowerCase())}" data-id="${sess.id}">
      <h2>${escapeHtml(sess.title || '(无标题)')}</h2>
      <div class="meta">
        <span>ID: <code>${sess.id}</code></span>
        <span>创建: ${new Date(sess.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
        <span>消息: ${sess.messages.length}</span>
      </div>
      <div class="messages">${messagesHtml}</div>
    </section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>SoloForge 对话历史导出</title>
<style>
  :root { --bg: #0c0e14; --surface: #14171f; --border: #1e2030; --text: #cdd6f4; --text-secondary: #6c7086; --primary: #89b4fa; --user: #a6e3a1; --ai: #89b4fa; --sys: #6c7086; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 0; }
  header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 16px 24px; position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  h1 { font-size: 18px; margin: 0; }
  .stats { color: var(--text-secondary); font-size: 12px; font-family: monospace; }
  .search { flex: 1; min-width: 240px; max-width: 480px; padding: 8px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 14px; outline: none; }
  .search:focus { border-color: var(--primary); }
  main { max-width: 900px; margin: 0 auto; padding: 16px 24px; }
  .session { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; margin-bottom: 16px; padding: 16px; }
  .session h2 { margin: 0 0 8px 0; font-size: 16px; color: var(--primary); }
  .meta { display: flex; gap: 12px; color: var(--text-secondary); font-size: 11px; font-family: monospace; margin-bottom: 12px; flex-wrap: wrap; }
  .meta code { background: var(--bg); padding: 1px 6px; border-radius: 3px; }
  .messages { display: flex; flex-direction: column; gap: 8px; }
  .msg { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
  .msg-head { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; font-size: 11px; }
  .msg-role { padding: 1px 6px; border-radius: 3px; font-weight: 600; }
  .role-user .msg-role { background: rgba(166, 227, 161, 0.15); color: var(--user); }
  .role-ai .msg-role { background: rgba(137, 180, 250, 0.15); color: var(--ai); }
  .role-sys .msg-role { background: rgba(108, 112, 134, 0.15); color: var(--sys); }
  .msg-time { color: var(--text-secondary); font-family: monospace; }
  .msg-model { color: var(--text-secondary); font-family: monospace; font-size: 10px; }
  .msg-body { line-height: 1.6; word-break: break-word; }
  mark { background: #f5c2e7; color: #1e1e2e; padding: 0 2px; border-radius: 2px; }
  .hidden { display: none !important; }
  footer { text-align: center; color: var(--text-secondary); font-size: 11px; padding: 24px; }
</style>
</head>
<body>
<header>
  <h1>SoloForge 对话历史</h1>
  <span class="stats">${list.length} 会话 · ${totalMessages} 消息</span>
  <input id="search" class="search" placeholder="搜索会话或消息内容..." />
</header>
<main>
${sessionsHtml}
</main>
<footer>
  SoloForge 历史导出 · ${new Date().toISOString()} · 单文件 HTML · 无外部依赖
</footer>
<script>
  const search = document.getElementById('search');
  const sessions = document.querySelectorAll('.session');
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    sessions.forEach(s => {
      const title = s.dataset.title;
      const body = s.textContent.toLowerCase();
      if (!q) { s.classList.remove('hidden'); s.querySelectorAll('mark').forEach(m => { m.outerHTML = m.textContent; }); return; }
      if (title.includes(q) || body.includes(q)) {
        s.classList.remove('hidden');
        s.querySelectorAll('.msg-body').forEach(body => {
          let text = body.textContent;
          body.innerHTML = body.textContent.replace(new RegExp('(' + q.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\\$&') + ')', 'gi'), '<mark>\$1</mark>');
        });
      } else {
        s.classList.add('hidden');
      }
    });
  });
</script>
</body>
</html>`;
}

// ─── 导出为 JSON (结构化, 可被 SQLite 导入或 Soloforge 重新导入) ───
export function exportSessionsAsJson(sessions: ChatSession[], ids?: string[]): string {
  const list = ids ? sessions.filter(s => ids.includes(s.id)) : sessions;
  return JSON.stringify({
    __type: 'soloforge-chat-history',
    version: 1,
    exportedAt: new Date().toISOString(),
    sessionCount: list.length,
    messageCount: list.reduce((s, sess) => s + sess.messages.length, 0),
    sessions: list,
  }, null, 2);
}

// ─── 触发浏览器下载 ───
export function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── 复制到剪贴板 ───
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
