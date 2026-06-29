// tests/mocks/mock-llm-server.mjs
// OpenAI-compatible mock LLM for SoloForge full-pipeline E2E testing
//
// 端点:
//   GET  /v1/models             → 列出模型
//   POST /v1/chat/completions   → SSE 流式响应
//   GET  /health                → 健康检查
//
// 用法:
//   node tests/mocks/mock-llm-server.mjs
//   PORT=4000 node tests/mocks/mock-llm-server.mjs

import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '127.0.0.1';
const DELAY = Number(process.env.MOCK_DELAY_MS || 60); // 每个 token 间隔

// 一个"会回话"的小脚本式应答器, 用简单的关键词匹配
// 真实对话不会这么简单, 但对"测全链路"够用 — 重点是验证
//  ① UI 发出去的消息能到 mock
//  ② mock 的 SSE 流式响应能回到 UI
//  ③ vault 拿到的 key 真的被加到 Authorization header 里
function makeReply(userText) {
  const t = (userText || '').toLowerCase();
  if (t.includes('你好') || t.includes('hello') || t.includes('hi')) {
    return `你好! 我是 SoloForge 全链路测试用的 mock LLM, 正在通过 Windows 凭据管理器 + 后端 vault 代理 + SSE 流式响应跟你对话。\n\n你刚才说的是: "${userText}"`;
  }
  if (t.includes('key') || t.includes('密钥')) {
    return `本测试使用 OS 钥匙串 (Windows Credential Manager) 存储 API Key, service="SoloForge", account="test-mock"。这把 key 的明文只会出现在后端进程内存中, 永远不会进 localStorage 或任何前端 JSON 文件。`;
  }
  if (t.includes('who are you') || t.includes('你是谁')) {
    return `我是 mock LLM, 跑在 127.0.0.1:${PORT}。作用: 模拟一个真实 OpenAI 兼容 API, 让 SoloForge 能在没有真 key 的情况下完成全链路 (UI → 钥匙串 → 后端代理 → 上游 → SSE 回显) 验证。`;
  }
  if (t.includes('test') || t.includes('测试')) {
    return `E2E 状态: ✓ UI 发送成功, ✓ 后端 vault.getKey 成功, ✓ Authorization Bearer 头正确, ✓ mock 收到请求, ✓ SSE 流式回显正常。请继续在对话框输入测试。`;
  }
  // 默认回声 + 标注来源, 方便在 UI 里肉眼确认链路
  return `收到: "${userText}"\n\n[mock-llm @ 127.0.0.1:${PORT}] 这是 mock LLM 的回声响应。每个 token 之间有 ${DELAY}ms 间隔, 用于在 UI 看到逐字流式效果。`;
}

function splitIntoTokens(text) {
  // 中英混合, 按"汉字 1 个 / 英文词 1 个 / 标点 1 个"拆, 让流式看着像样
  const tokens = [];
  const re = /[\u4e00-\u9fa5]|[A-Za-z]+|\s+|[^A-Za-z\s]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    tokens.push(m[0]);
  }
  return tokens;
}

// ── HTTP 服务器 ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const ts = new Date().toISOString().slice(11, 19);

  // 健康检查
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ts, port: PORT }));
    return;
  }

  // 模型列表
  if (url.pathname === '/v1/models' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'mock-fast', object: 'model', created: Date.now(), owned_by: 'mock' },
        { id: 'mock-smart', object: 'model', created: Date.now(), owned_by: 'mock' },
        { id: 'mock-echo', object: 'model', created: Date.now(), owned_by: 'mock' },
      ],
    }));
    return;
  }

  // Chat completions (OpenAI 兼容, SSE 流式)
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    // 1) 读 body
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* 忽略, 当作空 */ }

    // 2) 验 Authorization — 如果后端没把 vault 拿到的 key 加到 header, 报 401
    //    这条路径用来测 "vault 真的在用, 没走空 key"
    const auth = req.headers['authorization'] || '';
    if (!auth.toLowerCase().startsWith('bearer ')) {
      console.log(`[${ts}] ✗ 401: missing/invalid Authorization: ${auth.slice(0, 20)}`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Missing or invalid Authorization header (vault did not provide key?)', type: 'invalid_request_error' } }));
      return;
    }
    const apiKey = auth.slice(7).trim();
    if (apiKey.length < 4) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'API key too short', type: 'invalid_request_error' } }));
      return;
    }

    // 3) 提取用户最后一条消息
    const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
    const lastUser = [...msgs].reverse().find((m) => m?.role === 'user');
    const userText = lastUser?.content || '';
    const model = parsed.model || 'mock-fast';
    const stream = parsed.stream !== false;

    console.log(`[${ts}] ✓ 收到请求: model=${model}, key=${apiKey.slice(0, 4)}***, user="${userText.slice(0, 80)}", stream=${stream}`);

    // 4) 非流式: 直接 JSON
    if (!stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: makeReply(userText) },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: userText.length, completion_tokens: makeReply(userText).length, total_tokens: userText.length + makeReply(userText).length },
      }));
      return;
    }

    // 5) 流式 SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const reply = makeReply(userText);
    const tokens = splitIntoTokens(reply);
    const id = 'chatcmpl-mock-' + Math.random().toString(36).slice(2, 8);
    const created = Math.floor(Date.now() / 1000);

    // 5.1 发送首块 (role)
    res.write(`data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    })}\n\n`);

    // 5.2 逐 token 推
    for (const tok of tokens) {
      await new Promise((r) => setTimeout(r, DELAY));
      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { content: tok }, finish_reason: null }],
      })}\n\n`);
    }

    // 5.3 收尾
    res.write(`data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    console.log(`[${ts}] ✓ 流式响应完成: ${tokens.length} tokens, ${tokens.length * DELAY}ms`);
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not Found', path: url.pathname } }));
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-llm] listening on http://${HOST}:${PORT}`);
  console.log(`[mock-llm] endpoints:`);
  console.log(`[mock-llm]   GET  /health`);
  console.log(`[mock-llm]   GET  /v1/models`);
  console.log(`[mock-llm]   POST /v1/chat/completions   (SSE streaming)`);
  console.log(`[mock-llm] token delay: ${DELAY}ms`);
});
