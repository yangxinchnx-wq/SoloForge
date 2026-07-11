import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import fs from "fs";
import { Worker } from "worker_threads";
import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import { registerBrowserUseRoutes } from "../src/core/browser-use/routes";
import { bootstrapCanvasSessionLayer } from "./src/server/bootstrap/canvas";
import { registerChatSessionRoutes, flushChatStore } from "./src/server/routes/chatSession";
import { registerConversationRoutes, flushConversationStore } from "./src/server/routes/conversationRoutes";
import { getChatStore } from "./src/server/services/chat/ChatStore";
import { getConversationStore } from "./src/server/services/chat/ConversationStore";
import { registerSettingsRoutes, flushSettingsToDiskSync } from "./src/server/routes/settings";
import { registerFileRoutes } from "./src/server/routes/fileRoutes";
import { registerTrainingRoutes } from "./src/server/routes/trainingRoutes";
import { globalRateLimit } from "./src/server/middleware/rateLimitMiddleware";
import { initAuthToken, getStartupToken } from "./src/server/middleware/auth";

// Load Environment variables
dotenv.config();

// SoloForge 原后端地址（src/index.ts），所有业务 API 经此代理
const BACKEND_URL = process.env.SOLOFORGE_BACKEND_URL || "http://localhost:3001";
// Java Agent 直连地址 (SSE 流式聊天直连 8770, 绕过 3001 避免缓冲)
const JAVA_AGENT_URL = process.env.JAVA_AGENT_URL || "http://localhost:8770";

// ============================================================
// 系统指标采样 worker (CPU/内存/磁盘 IO 全部在 worker 内执行)
//   - 主线程不再有 setInterval,事件循环零阻塞
//   - 磁盘 IO 改为按需采样(收到 /api/system-metrics 请求才做)
//   - CPU/内存由 worker 内部 500ms 轮询,只读不写
// ============================================================
const __filename_srv = typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);
const __dirname_srv = path.dirname(__filename_srv);
const metricsWorker = new Worker(path.join(__dirname_srv, "metricsWorker.mjs"));

// 缓存最近一次指标(主线程只读,worker 推送更新)
let lastMetrics: any = {
  cpu: 0,
  memory: { total: 0, free: 0, used: 0, percentage: 0 },
  disk: {
    readSpeed: 0,
    writeSpeed: 0,
    drives: [],
  },
};

// worker 主动推送时,更新主线程缓存
metricsWorker.on("message", (msg: any) => {
  if (msg?.type === "metrics" || msg?.type === "sampled") {
    lastMetrics = {
      cpu: msg.cpu,
      memory: msg.memory,
      disk: {
        readSpeed: msg.readSpeed,
        writeSpeed: msg.writeSpeed,
        drives: msg.drives || lastMetrics.disk?.drives || [],
      },
    };
  }
});

metricsWorker.on("error", (err: Error) => {
  console.error("[metricsWorker] error:", err.message);
});

// 启动时预触发一次采样,让首次请求有数据
metricsWorker.postMessage({ type: "sample-and-get" });

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Add JSON parsing middleware
  app.use(express.json({ limit: '10mb' }));

  // ============================================================
  // 全局速率限制 (每个 IP 每分钟 100 次)
  //   - 防暴力破解、DDoS、爬虫
  //   - 在所有路由之前挂载
  // ============================================================
  app.use(globalRateLimit);
  console.log('[server] ✅ 全局速率限制已启用 (100 req/min per IP)');

  // ============================================================
  // 认证 Token 初始化 (开箱即用, 无需环境变量)
  //   - 首次启动: 生成 64 字符随机 token, 持久化到 .soloforge-token
  //   - 后续启动: 从文件读取, 保证 token 跨重启稳定
  //   - Electron 主进程可通过读取 .soloforge-token 获取 token
  //   - 仅 localhost 可访问 /api/auth/startup-token 端点
  // ============================================================
  const authToken = initAuthToken(process.cwd());
  console.log(`[server] ✅ 认证 token 已初始化 (长度: ${authToken.length})`);

  // 仅允许 localhost 访问的 token 获取端点 (供 Electron 前端首次启动时使用)
  app.get('/api/auth/startup-token', (req, res) => {
    const clientIp = req.ip || req.socket?.remoteAddress || '';
    const isLocal = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1' || clientIp === 'localhost';
    if (!isLocal) {
      res.status(403).json({ error: 'Token endpoint only accessible from localhost' });
      return;
    }
    const token = getStartupToken();
    if (!token) {
      res.status(500).json({ error: 'Token not initialized' });
      return;
    }
    res.json({ token });
  });

  // ============================================================
  // Canvas Session API (3000 本地路由, 跨进程持久化)
  //   /api/canvas/sessions/*         — 会话 CRUD + 设备增删改
  //   /api/canvas/persistence/*      — flush / restore-all / status
  //
  // 设计:
  //   - Garnet(6379) 为热存储, SurrealDB(rocksdb) 为冷存储
  //   - 启动失败/未连接时降级为内存模式 (路由仍可用, 跨重启丢数据)
  //   - 优雅退出时自动 flushAll 到持久层
  // ============================================================
  bootstrapCanvasSessionLayer(app);

  // ============================================================
  // Chat Session API (3000 本地路由, 三层架构)
  //   GET    /api/chats/list          — 列出所有对话 + 选中ID + liveStates
  //   POST   /api/chats               — 创建新对话
  //   PATCH  /api/chats/:id           — 更新对话 (title/tag/permission)
  //   DELETE /api/chats/:id           — 删除对话 (级联删除画布)
  //   POST   /api/chats/reorder       — 重排对话顺序
  //   POST   /api/chats/select        — 设置当前选中对话
  //   POST   /api/chats/:id/state     — 上报实时流式状态
  //   DELETE /api/chats/:id/state     — 清除实时流式状态
  //
  // ★ 2026-07-11: 三层架构
  //   - 内存 Map → Garnet (热, 24h TTL) → SurrealDB (温, 持久) → JSONL (冷, 归档)
  //   - 冷启动从 SurrealDB 恢复, 旧 JSON 自动迁移
  // ============================================================
  registerChatSessionRoutes(app);

  // ★ 三层架构: 冷启动从温存储 (SurrealDB) 恢复对话列表
  void getChatStore().restoreFromWarm().catch((e: Error) => {
    console.warn('[server] ChatStore 冷启动恢复失败:', e.message);
  });

  // ── 临时诊断端点 ──
  app.post('/api/debug-log', (req, res) => {
    console.log('[FRONTEND DEBUG]', JSON.stringify(req.body));
    res.json({ ok: true });
  });

  // ============================================================
  // Conversation API (3000 本地路由, 三层架构)
  //   GET    /api/conversations              — 获取所有对话消息 + 配置
  //   PUT    /api/conversations              — 全量替换所有对话消息
  //   GET    /api/conversations/:chatId      — 获取单个对话消息
  //   PUT    /api/conversations/:chatId      — 替换单个对话消息
  //   DELETE /api/conversations/:chatId      — 删除单个对话消息 + 配置
  //   GET    /api/conversations/:chatId/config   — 获取配置
  //   PUT    /api/conversations/:chatId/config   — 替换配置
  //   DELETE /api/conversations/:chatId/config   — 删除配置
  //
  // ★ 2026-07-11: 三层架构
  //   - 内存 Map → Garnet (热, 24h TTL) → SurrealDB (温, 持久) → JSONL (冷, 归档)
  //   - 冷启动从 SurrealDB 恢复, 旧 JSON 自动迁移
  // ============================================================
  registerConversationRoutes(app);

  // ★ 三层架构: 冷启动从温存储 (SurrealDB) 恢复对话消息
  void getConversationStore().restoreFromWarm().catch((e: Error) => {
    console.warn('[server] ConversationStore 冷启动恢复失败:', e.message);
  });

  // ============================================================
  // Settings API (3000 本地路由, JSON 文件持久化)
  //   GET    /api/settings              → 返回整个 settings 对象
  //   GET    /api/settings/:key         → 返回单个 key 值
  //   PUT    /api/settings/:key         → 写入单个 key 值
  //   PATCH  /api/settings              → 批量合并更新
  //   DELETE /api/settings/:key         → 删除 key
  // 必须放在 backendApiProxy 之前,避免被代理到 3001
  // ============================================================
  registerSettingsRoutes(app);

  // ============================================================
  // File System API (3000 本地路由, 直接读写宿主机磁盘)
  //   GET    /api/files/read?path=xxx   → 读取文件内容
  //   POST   /api/files/save            → 保存文件内容
  //   GET    /api/files/list?dir=xxx    → 列出目录内容
  //   POST   /api/files/create          → 创建文件/文件夹
  //   DELETE /api/files/delete?path=xxx → 删除文件/文件夹
  //   POST   /api/files/rename          → 重命名
  //   GET    /api/files/stats           → 文件统计
  // 必须放在 backendApiProxy 之前,避免被代理到 3001
  // ============================================================
  registerFileRoutes(app);

  // ============================================================
  // Training Data Routes (3000 本地路由, URL 抓取等)
  //   POST /api/training/fetch-url   → 抓取 URL 内容 (绕过 CORS)
  // 必须放在 backendApiProxy 之前,避免被代理到 3001
  // ============================================================
  registerTrainingRoutes(app);

  // Canvas Tools MCP 已在 bootstrapCanvasSessionLayer 内部注册 (canvas.ts L96)
  // 不再重复调用 registerCanvasToolRoutes(app)

  // ============================================================
  // Browser-Use API (高层 LLM 任务编排, 走 Obscura CDP)
  //   /api/browser-use/run            — 提交任务
  //   /api/browser-use/tasks          — 列表
  //   /api/browser-use/state/:id      — 状态
  //   /api/browser-use/{pause,resume,cancel}/:id
  //   /api/browser-use/stream/:id     — SSE 步进流
  //   /api/browser-use/health         — 探活
  // ============================================================
  const repoRootSrv = path.resolve(__dirname_srv, "..", "..");
  registerBrowserUseRoutes(app, repoRootSrv);

  // ============================================================
  // ★ Java Agent SSE 流式直连: /api/java-agent/api/chat/stream → 8770
  //   绕过 3001 Core, 直连 8770 Java Agent, 避免中间层缓冲 SSE 流
  //
  //   ⚠️ 2026-07-11 关键修复:
  //   旧代码用 app.use("/api/java-agent/api/chat/stream", createProxyMiddleware({...}))
  //   Express app.use(path, middleware) 会剥离 path 前缀 → req.url 变成 "/"
  //   → pathRewrite {"^/api/java-agent": ""} 匹配不到 "/" → 不生效
  //   → 代理发送 POST http://localhost:8770/ (而非 /api/chat/stream) → Java 返回 404
  //
  //   修复: 改用 pathFilter (不在 app.use 中传 path, Express 不剥离前缀)
  //   + v4 on:{...} 语法 (旧 onProxyReq/onProxyRes 在 v4 中已废弃)
  //   + 添加 on.error 返回 502, 让前端 executeJavaPath 能检测 Java 不可用并 fallback
  // ============================================================
  app.use(createProxyMiddleware({
    target: JAVA_AGENT_URL,
    changeOrigin: true,
    selfHandleResponse: false,
    pathFilter: (pathname, req) => req.method === 'POST' && pathname === '/api/java-agent/api/chat/stream',
    pathRewrite: { "^/api/java-agent": "" },
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader("Connection", "close");
        proxyReq.setHeader("Accept", "text/event-stream");
        if ((req as any).body && (req as any).body instanceof Object) {
          fixRequestBody(proxyReq, req as any);
        }
      },
      proxyRes: (proxyRes) => {
        proxyRes.headers["cache-control"] = "no-cache";
        proxyRes.headers["x-accel-buffering"] = "no";
        proxyRes.headers["connection"] = "keep-alive";
      },
      error: (err, _req, res) => {
        console.error('[proxy→8770 SSE] error:', err.message);
        if (res && 'writeHead' in res) {
          try {
            (res as any).writeHead(502, { 'Content-Type': 'application/json' });
            (res as any).end(JSON.stringify({
              success: false,
              error: `Java Agent (8770) 不可达: ${err.message}`,
            }));
          } catch { /* response already sent */ }
        }
      },
    },
    proxyTimeout: 0 as any,
    timeout: 0 as any,
  }));
  console.log(`[proxy] Java Agent SSE /api/java-agent/api/chat/stream → ${JAVA_AGENT_URL}/api/chat/stream (pathFilter, 无超时)`);

  // ============================================================
  // ★ Java Agent 专用转发: /api/java-agent/* → 3001 → 8770
  //   LLM 调用可能需要 60-90 秒,使用 120s 超时
  //   使用 fetch 手动转发 (避免 HPM 在高错误率环境下的连接挂死)
  // ============================================================
  app.use("/api/java-agent", async (req, res) => {
    const javaPath = req.url; // 相对路径, 如 /api/chat/send
    const targetUrl = BACKEND_URL + "/api/java-agent" + javaPath;
    console.log(`[java-agent-fwd] ${req.method} ${javaPath} -> ${targetUrl}`);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 110_000);

      const fwdHeaders: Record<string, string> = {
        "Content-Type": "application/json",
      };
      // 透传 Authorization 等关键 header
      if (req.headers["authorization"]) {
        fwdHeaders["Authorization"] = req.headers["authorization"] as string;
      }

      const fwdOptions: any = {
        method: req.method,
        headers: fwdHeaders,
        signal: controller.signal,
      };

      // POST/PUT 需要 body
      if ((req.method === "POST" || req.method === "PUT") && req.body) {
        fwdOptions.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      }

      const upstreamRes = await fetch(targetUrl, fwdOptions);
      clearTimeout(timeout);

      const respBody = await upstreamRes.text();
      console.log(`[java-agent-fwd] upstream status=${upstreamRes.status} bodyLen=${respBody.length}`);
      // 用 writeHead+end 替代 status+send, 避免 Express 对非 2xx 状态码的 body 丢失
      res.writeHead(upstreamRes.status, { "Content-Type": "application/json" });
      res.end(respBody);
    } catch (err: any) {
      console.error(`[java-agent-fwd] error: ${err?.message}`);
      if (err?.name === "AbortError") {
        res.status(504).json({
          success: false,
          error: "Java Agent 响应超时 (>110s)。请检查 LLM 服务商连通性或减小 max_tokens。",
        });
      } else {
        res.status(502).json({
          success: false,
          error: `Java Agent 服务不可达: ${err?.message || String(err)}`,
        });
      }
    }
  });
  console.log(`[proxy] Java Agent /api/java-agent/* → ${BACKEND_URL} (fetch 转发, 110s 超时)`);

  // ============================================================
  // 第一优先：3000 本地专属端点（3001 没有这些功能）
  //   - /api/git/*         : 本地 git 工具调用
  //   - /api/custom-rules  : 本地规则文件读写
  //   - /api/channels/test : 第三方 webhook 转发测试
  //   - /api/system-metrics: 实时磁盘 IO 基准（3001 没有）
  // 必须放在 /api 代理之前，否则会被代理转发到 3001 然后 404
  // ============================================================
  // [本地端点声明见下方 — 已从原位置移动到这里]

  // SSE 长连接（events/stream + llm/stream）需要特殊处理：禁用缓冲 + 流式透传 + 无超时
  // events/stream: GET, 后端事件总线广播
  // llm/stream: POST, 后端 LLM 代理 SSE 回流 (可能持续 60-120s)
  const backendSseProxy = createProxyMiddleware({
    target: BACKEND_URL,
    changeOrigin: true,
    ws: false,
    on: {
      proxyReq: (proxyReq, req) => {
        // SSE 不需要 chunked 改写，但需要清掉 keep-alive 让代理立即转发
        proxyReq.setHeader("Connection", "close");
        if ((req as any).body && Object.keys((req as any).body).length) {
          fixRequestBody(proxyReq, req as any);
        }
      },
      proxyRes: (proxyRes) => {
        // SSE 必须禁用缓冲，且保持连接打开
        proxyRes.headers["cache-control"] = "no-cache";
        proxyRes.headers["x-accel-buffering"] = "no";
      },
    },
    proxyTimeout: 0 as any,
    timeout: 0 as any,
  });

  // LLM stream + Agent dispatch 专用代理 (POST, SSE 回流, 无超时)
  // /api/agents/dispatch 是 SSE 流式端点, LLM 生成可能持续 60-120s
  // 必须放在 backendApiPrefixes 的 /api/llm + /api/agents filterProxy 之前
  // 否则会被 30s proxyTimeout 截断 → 504
  const llmStreamSseProxy = createProxyMiddleware({
    target: BACKEND_URL,
    changeOrigin: true,
    ws: false,
    pathFilter: (pathname, req) => {
      return req.method === 'POST' && (pathname === '/api/llm/stream' || pathname === '/api/agents/dispatch');
    },
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader("Connection", "close");
        if ((req as any).body && Object.keys((req as any).body).length) {
          fixRequestBody(proxyReq, req as any);
        }
      },
      proxyRes: (proxyRes) => {
        proxyRes.headers["cache-control"] = "no-cache";
        proxyRes.headers["x-accel-buffering"] = "no";
      },
    },
    proxyTimeout: 0 as any,
    timeout: 0 as any,
  });

  // WebSocket（3001 同端口复用 /ws）
  const backendWsProxy = createProxyMiddleware({
    target: BACKEND_URL.replace(/^http/, "ws"),
    ws: true,
    changeOrigin: true,
    logger: console,
  });

  // 普通业务 API（含 SSE/WS 之外的绝大多数端点）
  const backendApiProxy = createProxyMiddleware({
    target: BACKEND_URL,
    changeOrigin: true,
    logger: console,
    proxyTimeout: 30000 as any,
    timeout: 30000 as any,
    on: {
      proxyReq: (proxyReq, req) => {
        if ((req as any).body && Object.keys((req as any).body).length) {
          fixRequestBody(proxyReq, req as any);
        }
      },
      error: (err, _req, res) => {
        console.error("[proxy→3001] error:", err.message);
        if (res && 'writeHead' in res) {
          try {
            (res as any).writeHead(502, { "Content-Type": "application/json" });
            (res as any).end(JSON.stringify({
              success: false,
              error: `后端 3001 不可达: ${err.message}`,
              backend: BACKEND_URL,
            }));
          } catch { /* response already sent */ }
        }
      },
    },
  });

  // SSE 必须单独挂载（路径精确匹配）
  app.get("/api/events/stream", backendSseProxy);
  // LLM stream SSE 代理 (POST, 无超时, 放在 /api/llm filterProxy 之前)
  app.use(llmStreamSseProxy);

  // ============================================================
  // 归一化上游模型元数据 → 统一格式
  // 支持: OpenRouter / Gemini / OpenAI / DeepSeek / 通用
  // ============================================================
  function normalizeMetadata(raw: any): Record<string, any> {
    if (!raw || typeof raw !== 'object') return {};
    const meta: Record<string, any> = {};

    // ── OpenRouter 格式 ──
    if (raw.context_length) meta.contextWindow = raw.context_length;
    if (raw.top_provider?.max_completion_tokens) meta.maxOutput = raw.top_provider.max_completion_tokens;
    if (raw.architecture?.input_modalities) meta.inputModalities = raw.architecture.input_modalities;
    if (raw.architecture?.output_modalities) meta.outputModalities = raw.architecture.output_modalities;
    if (raw.architecture?.modality) meta.architecture = raw.architecture.modality;
    if (raw.pricing?.prompt) meta.pricingInput = parseFloat(raw.pricing.prompt) * 1e6;
    if (raw.pricing?.completion) meta.pricingOutput = parseFloat(raw.pricing.completion) * 1e6;
    if (raw.description) meta.description = raw.description;
    if (raw.top_provider?.context_length) meta.contextWindow = raw.top_provider.context_length;

    // ── Gemini 格式 ──
    if (raw.inputTokenLimit) {
      meta.contextWindow = (meta.contextWindow || 0) + raw.inputTokenLimit;
      meta.maxOutput = raw.outputTokenLimit;
    }
    if (raw.outputTokenLimit && !meta.maxOutput) meta.maxOutput = raw.outputTokenLimit;
    if (raw.supportedGenerationMethods) {
      meta.supportedMethods = raw.supportedGenerationMethods;
      meta.supportsStreaming = raw.supportedGenerationMethods.includes('generateContent');
    }

    // ── 通用字段 (OpenAI / DeepSeek / 其他) ──
    if (raw.owned_by) meta.owner = raw.owned_by;
    if (raw.owner) meta.owner = raw.owner;
    if (raw.created) meta.created = raw.created;
    if (raw.object) meta.object = raw.object;
    if (raw.permission) meta.permission = raw.permission;
    if (raw.root) meta.root = raw.root;
    if (raw.parent) meta.parent = raw.parent;
    if (raw.id && !meta.description) meta.id = raw.id;

    // ── 推断能力 (基于模型名) ──
    const idLower = String(raw.id || raw.name || '').toLowerCase();
    if (idLower.includes('vision') || idLower.includes('vl') || idLower.includes('4o') || idLower.includes('gemini')) {
      meta.supportsVision = true;
      if (!meta.inputModalities) meta.inputModalities = ['text', 'image'];
    }
    if (idLower.includes('audio') || idLower.includes('whisper')) {
      meta.supportsAudio = true;
    }
    if (idLower.includes('reason') || idLower.includes('o1') || idLower.includes('o3') || idLower.includes('r1')) {
      meta.isReasoningModel = true;
    }

    return meta;
  }

  // ============================================================
  // 数据库持久化：加载与保存云端大模型服务商配置
  // ============================================================
  app.get("/api/providers/config", (req, res) => {
    try {
      const filePath = path.join(process.cwd(), "providers_db.json");
      if (!fs.existsSync(filePath)) {
        return res.json({ success: true, providers: null });
      }
      const data = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(data);
      res.json({ success: true, providers: parsed });
    } catch (err: any) {
      console.error("[Get Providers Config DB] Error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/providers/config", (req, res) => {
    try {
      const { providers } = req.body;
      if (!providers || !Array.isArray(providers)) {
        return res.status(400).json({ success: false, error: "providers list is required and must be an array" });
      }
      const filePath = path.join(process.cwd(), "providers_db.json");
      fs.writeFileSync(filePath, JSON.stringify(providers, null, 2), "utf-8");
      res.json({ success: true });
    } catch (err: any) {
      console.error("[Post Providers Config DB] Error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ============================================================
  // 资源选择面板：读取/扫描资源 manifests 列表
  // ============================================================
  app.get("/api/resources/:type/manifest", (req, res) => {
    try {
      const { type } = req.params;
      const validTypes = ["tools", "knowledge", "skills"];
      if (!validTypes.includes(type)) {
        return res.status(400).json({ success: false, error: "Invalid resource type" });
      }
      const filePath = path.join(process.cwd(), "resources", type, "manifest.json");
      if (!fs.existsSync(filePath)) {
        return res.json({ success: true, items: [] });
      }
      const data = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(data);
      res.json({ success: true, items: parsed });
    } catch (err: any) {
      console.error(`[Get Resource ${req.params.type} Manifest] Error:`, err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ============================================================
  // 资源选择面板：持久化存取已选中的资源 ID 集合
  // ============================================================
  app.get("/api/resources/active", (req, res) => {
    try {
      const filePath = path.join(process.cwd(), "active_resources_db.json");
      if (!fs.existsSync(filePath)) {
        return res.json({
          success: true,
          active: {
            tools: [],
            knowledge: [],
            skills: []
          }
        });
      }
      const data = fs.readFileSync(filePath, "utf-8");
      res.json({ success: true, active: JSON.parse(data) });
    } catch (err: any) {
      console.error("[Get Active Resources DB] Error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/resources/active", (req, res) => {
    try {
      const { tools, knowledge, skills, customGroups, groupAssignments } = req.body;
      const dataToSave = {
        tools: Array.isArray(tools) ? tools : [],
        knowledge: Array.isArray(knowledge) ? knowledge : [],
        skills: Array.isArray(skills) ? skills : [],
        customGroups: customGroups || { tools: [], knowledge: [], skills: [] },
        groupAssignments: groupAssignments || {}
      };
      const filePath = path.join(process.cwd(), "active_resources_db.json");
      fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2), "utf-8");
      res.json({ success: true });
    } catch (err: any) {
      console.error("[Post Active Resources DB] Error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ============================================================
  // 真实代理：上游 LLM 服务的 /models 列表扫描
  // 浏览器直接 fetch 容易被 CORS 拦截，由 3000 服务端代为请求
  // ============================================================
  app.post("/api/providers/scan-models", async (req, res) => {
    const { baseUrl, apiKey, defaultUrl } = req.body || {};
    const target = (baseUrl && baseUrl.trim()) || (defaultUrl && defaultUrl.trim());
    if (!target || !/^https?:\/\//i.test(target)) {
      return res.status(400).json({ success: false, error: "接口重定向网址 (baseUrl) 非法或缺失" });
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey && apiKey.trim()) headers["Authorization"] = `Bearer ${apiKey.trim()}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const t0 = Date.now();
    try {
      const upstream = await fetch(target.replace(/\/+$/, "") + "/models", {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      const latency = Date.now() - t0;
      const text = await upstream.text();
      if (!upstream.ok) {
        return res.status(upstream.status).json({
          success: false,
          error: `上游 ${upstream.status} ${upstream.statusText}`,
          body: text.slice(0, 500),
          latency,
        });
      }
      let data: any;
      try { data = JSON.parse(text); } catch { return res.status(502).json({ success: false, error: "上游响应不是 JSON", body: text.slice(0, 500) }); }
      const list = Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.models) ? data.models
        : Array.isArray(data) ? data
        : [];
      const models = list
        .map((m: any) => {
          if (typeof m === "string") return { id: m, name: m };
          const id = m.id || m.name || m.model;
          if (!id) return null;
          // 保留上游返回的所有原始字段，供前端展示模型详情
          return { id, name: id, raw: m };
        })
        .filter((m: any) => !!m)
        .slice(0, 500);
      res.json({ success: true, count: models.length, models, latency });
    } catch (err: any) {
      const latency = Date.now() - t0;
      res.status(502).json({
        success: false,
        error: err.name === "AbortError" ? `请求超时（>15s）: ${target}` : (err.message || "上游不可达"),
        latency,
      });
    } finally {
      clearTimeout(timeout);
    }
  });

  // 真实测试：直接发一个最小 chat-completion 请求，验证鉴权 + 连通
  app.post("/api/providers/test", async (req, res) => {
    const { baseUrl, apiKey, defaultUrl, model } = req.body || {};
    const target = (baseUrl && baseUrl.trim()) || (defaultUrl && defaultUrl.trim());
    if (!target || !/^https?:\/\//i.test(target)) {
      return res.status(400).json({ success: false, error: "接口重定向网址 (baseUrl) 非法或缺失" });
    }
    if (!apiKey || !apiKey.trim()) {
      return res.status(400).json({ success: false, error: "API 密钥为空，请先填写密钥再测试" });
    }
    const headers: Record<string, string> = { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey.trim()}` };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const t0 = Date.now();
    try {
      // 先尝试 chat/completions，失败则回退到 /models 只验证鉴权
      const probe = await fetch(target.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: model || "gpt-3.5-turbo",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        }),
      });
      const latency = Date.now() - t0;
      const text = await probe.text();
      if (probe.ok) {
        res.json({ success: true, latency, status: probe.status, snippet: text.slice(0, 300) });
      } else {
        // 鉴权失败明确
        const authFail = probe.status === 401 || probe.status === 403;
        res.status(probe.status).json({
          success: false,
          latency,
          status: probe.status,
          error: authFail ? `鉴权失败 (${probe.status})，请检查 API 密钥` : `上游 ${probe.status} ${probe.statusText}`,
          snippet: text.slice(0, 300),
        });
      }
    } catch (err: any) {
      const latency = Date.now() - t0;
      res.status(502).json({
        success: false,
        latency,
        error: err.name === "AbortError" ? `请求超时（>12s）: ${target}` : (err.message || "上游不可达"),
      });
    } finally {
      clearTimeout(timeout);
    }
  });

  // ============================================================
  // 模型详情探测：获取单个模型的完整元数据
  // 策略：
  //   1. GET {baseUrl}/models/{modelId} — 部分服务商支持
  //   2. 回退 GET {baseUrl}/models → 在列表中查找
  //   3. 返回上游原始数据 + 归一化的 metadata
  // ============================================================
  app.post("/api/providers/model-detail", async (req, res) => {
    const { baseUrl, apiKey, defaultUrl, modelId } = req.body || {};
    const target = (baseUrl && baseUrl.trim()) || (defaultUrl && defaultUrl.trim());
    if (!target || !/^https?:\/\//i.test(target)) {
      return res.status(400).json({ success: false, error: "接口重定向网址 (baseUrl) 非法或缺失" });
    }
    if (!modelId || !modelId.trim()) {
      return res.status(400).json({ success: false, error: "modelId 为空" });
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey && apiKey.trim()) headers["Authorization"] = `Bearer ${apiKey.trim()}`;

    const base = target.replace(/\/+$/, "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const t0 = Date.now();

    try {
      // 尝试 1: GET /models/{modelId}
      let upstream = await fetch(`${base}/models/${encodeURIComponent(modelId)}`, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      // 如果 404/405 → 回退到 GET /models 全列表查找
      if (!upstream.ok && upstream.status !== 200) {
        upstream = await fetch(`${base}/models`, {
          method: "GET",
          headers,
          signal: controller.signal,
        });
        const text2 = await upstream.text();
        if (!upstream.ok) {
          const latency2 = Date.now() - t0;
          return res.status(upstream.status).json({
            success: false,
            error: `上游 ${upstream.status} ${upstream.statusText}`,
            latency: latency2,
          });
        }
        let data2: any;
        try { data2 = JSON.parse(text2); } catch {
          return res.status(502).json({ success: false, error: "上游响应不是 JSON" });
        }
        const list2 = Array.isArray(data2?.data) ? data2.data
          : Array.isArray(data2?.models) ? data2.models
          : Array.isArray(data2) ? data2 : [];
        const found = list2.find((m: any) => {
          const mid = typeof m === "string" ? m : (m.id || m.name || m.model);
          return mid === modelId;
        });
        if (!found) {
          const latency3 = Date.now() - t0;
          return res.json({
            success: true,
            modelId,
            raw: null,
            metadata: {},
            latency: latency3,
            note: "模型未在 /models 列表中找到",
          });
        }
        const raw = typeof found === "string" ? { id: found } : found;
        const latency4 = Date.now() - t0;
        const metadata = normalizeMetadata(raw);
        return res.json({ success: true, modelId, raw, metadata, latency: latency4 });
      }

      // /models/{modelId} 成功
      const text = await upstream.text();
      const latency = Date.now() - t0;
      let raw: any;
      try { raw = JSON.parse(text); } catch {
        return res.status(502).json({ success: false, error: "上游响应不是 JSON", latency });
      }
      const metadata = normalizeMetadata(raw);
      res.json({ success: true, modelId, raw, metadata, latency });
    } catch (err: any) {
      const latency = Date.now() - t0;
      res.status(502).json({
        success: false,
        error: err.name === "AbortError" ? `请求超时（>15s）: ${target}` : (err.message || "上游不可达"),
        latency,
      });
    } finally {
      clearTimeout(timeout);
    }
  });

  // ============================================================
  // 模型上下文窗口数据库 — 多层数据获取系统
  //
  // 优先级 (从高到低):
  //   1. 运行时探针缓存 (model_probe_cache.json) — 探针成功后自动记住
  //   2. OpenRouter 动态注册表 — 定期从 openrouter.ai/api/v1/models 拉取
  //   3. 本地 JSON 数据库 (model_context_db.json) — 手动维护, 热加载
  //
  // 新模型发布时的更新方式:
  //   - 自动: 调用 POST /api/providers/refresh-model-db 触发 OpenRouter 同步
  //   - 手动: 直接编辑 UI/model_context_db.json, 无需重启服务 (热加载)
  //   - 运行时: 探针成功后自动写入 model_probe_cache.json
  // ============================================================

  const MODEL_DB_PATH = path.join(__dirname_srv, "model_context_db.json");
  const MODEL_CACHE_PATH = path.join(__dirname_srv, "model_probe_cache.json");

  // ── Layer 3: 本地 JSON 数据库 (热加载) ──
  let KNOWN_MODEL_CONTEXT: Record<string, { context: number; maxOutput?: number }> = {};
  function loadLocalModelDb(): void {
    try {
      const raw = fs.readFileSync(MODEL_DB_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      KNOWN_MODEL_CONTEXT = parsed.models || parsed || {};
      console.log(`[model-db] ✅ 已加载本地数据库: ${Object.keys(KNOWN_MODEL_CONTEXT).length} 个模型`);
    } catch (e: any) {
      console.warn(`[model-db] ⚠️  加载本地数据库失败: ${e.message}, 使用空数据库`);
      KNOWN_MODEL_CONTEXT = {};
    }
  }
  loadLocalModelDb();

  // 监听文件变化, 实现热加载 (无需重启服务)
  try {
    fs.watch(MODEL_DB_PATH, { persistent: false }, (eventType) => {
      if (eventType === 'change') {
        // 防抖: 文件写入可能触发多次
        clearTimeout((loadLocalModelDb as any)._debounce);
        (loadLocalModelDb as any)._debounce = setTimeout(() => {
          console.log('[model-db] 📦 检测到文件变化, 热加载中...');
          loadLocalModelDb();
        }, 300);
      }
    });
  } catch { /* 文件可能不存在, 忽略 */ }

  // ── Layer 2: OpenRouter 动态注册表 ──
  let openRouterRegistry: Record<string, { context: number; maxOutput?: number }> = {};
  let openRouterLastSync: Date | null = null;

  async function syncOpenRouterRegistry(): Promise<{ success: boolean; count: number; error?: string }> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return { success: false, count: 0, error: `OpenRouter ${res.status}` };
      const data = await res.json() as any;
      const list: any[] = Array.isArray(data?.data) ? data.data : [];
      const registry: Record<string, { context: number; maxOutput?: number }> = {};
      let added = 0;
      for (const m of list) {
        const id = (m.id || m.name || '').toLowerCase();
        if (!id) continue;
        const ctx = m.context_length || m.top_provider?.context_length || 0;
        const maxOut = m.top_provider?.max_completion_tokens || 0;
        if (ctx > 0) {
          registry[id] = { context: ctx, maxOutput: maxOut > 0 ? maxOut : undefined };
          added++;
        }
      }
      openRouterRegistry = registry;
      openRouterLastSync = new Date();
      console.log(`[model-db] 🌐 OpenRouter 同步完成: ${added} 个模型 (总计 ${list.length} 个)`);
      return { success: true, count: added };
    } catch (e: any) {
      console.warn(`[model-db] ⚠️  OpenRouter 同步失败: ${e.message}`);
      return { success: false, count: 0, error: e.message };
    }
  }
  // 启动时异步同步 (不阻塞服务启动)
  syncOpenRouterRegistry().then(() => {
    // 同步完成后每小时自动刷新一次
    setInterval(() => syncOpenRouterRegistry(), 60 * 60 * 1000);
  });

  // ── Layer 1: 运行时探针缓存 ──
  let probeCache: Record<string, { context: number; maxOutput?: number; probedAt: string }> = {};
  try {
    const raw = fs.readFileSync(MODEL_CACHE_PATH, "utf-8");
    probeCache = JSON.parse(raw) || {};
    console.log(`[model-db] ✅ 已加载探针缓存: ${Object.keys(probeCache).length} 个模型`);
  } catch { /* 首次运行, 缓存文件不存在 */ }

  function saveProbeCache(): void {
    try {
      fs.writeFileSync(MODEL_CACHE_PATH, JSON.stringify(probeCache, null, 2), "utf-8");
    } catch (e: any) {
      console.warn(`[model-db] ⚠️  保存探针缓存失败: ${e.message}`);
    }
  }

  /** 探针成功后调用, 将结果写入缓存 */
  function cacheProbeResult(modelId: string, context: number | null, maxOutput: number | null): void {
    if (!context && !maxOutput) return;
    const idLower = modelId.toLowerCase();
    probeCache[idLower] = {
      context: context || 0,
      maxOutput: maxOutput || undefined,
      probedAt: new Date().toISOString(),
    };
    saveProbeCache();
    console.log(`[model-db] 💾 探针结果已缓存: ${modelId} → ctx=${context}, maxOut=${maxOutput}`);
  }

  /**
   * 多层模糊匹配 — 按优先级查找模型上下文
   * 优先级: 探针缓存 → OpenRouter → 本地JSON
   */
  function lookupKnownContext(modelId: string): { context: number; maxOutput?: number } | null {
    const idLower = modelId.toLowerCase();

    // Layer 1: 探针缓存 (最可靠, 来自真实 API 测试)
    if (probeCache[idLower]) {
      const c = probeCache[idLower];
      if (c.context > 0) return { context: c.context, maxOutput: c.maxOutput };
    }

    // Layer 2: OpenRouter 动态注册表 (覆盖面最广)
    if (openRouterRegistry[idLower]) return openRouterRegistry[idLower];

    // Layer 3: 本地 JSON 数据库 (手动维护)
    if (KNOWN_MODEL_CONTEXT[idLower]) return KNOWN_MODEL_CONTEXT[idLower];

    // 模糊匹配 (在前缀和子串上查找, 覆盖带版本号的模型名)
    // 优先在探针缓存中模糊匹配
    for (const [key, val] of Object.entries(probeCache)) {
      if (idLower.startsWith(key) && val.context > 0) return { context: val.context, maxOutput: val.maxOutput };
    }
    // 然后在 OpenRouter 中模糊匹配
    for (const [key, val] of Object.entries(openRouterRegistry)) {
      if (idLower.startsWith(key) || idLower.includes(key)) return val;
    }
    // 最后在本地数据库中模糊匹配
    for (const [key, val] of Object.entries(KNOWN_MODEL_CONTEXT)) {
      if (idLower.startsWith(key)) return val;
    }
    for (const [key, val] of Object.entries(KNOWN_MODEL_CONTEXT)) {
      if (idLower.includes(key) || key.includes(idLower)) return val;
    }

    return null;
  }

  // ============================================================
  // 模型能力探针：发送真实 API 请求探测模型能力
  //
  // 探测项 (全部使用 max_tokens:1, 成本极低):
  //   1. 基础连通 — POST /chat/completions { messages:[{content:"Hi"}], max_tokens:1 }
  //   2. 视觉     — 同上，但 messages 包含 image_url (1x1 透明 PNG)
  //   3. 工具     — 同上，但带 tools 参数
  //   4. JSON     — 同上，但带 response_format:{type:"json_object"}
  //   5. 流式     — 同上，但 stream:true，读取首个 SSE chunk
  //   6. 限制     — 发送 max_tokens:999999，从 400 错误信息中解析上下文/输出上限
  //   7. 元信息   — GET /models/{id} 获取 owner/created 等
  //   8. 已知库   — 从多层数据库补充上下文窗口 (探针缓存→OpenRouter→本地JSON)
  // ============================================================

  // ============================================================
  // 模型数据库刷新端点 — 手动触发 OpenRouter 同步 + 查看数据库状态
  // ============================================================
  app.post("/api/providers/refresh-model-db", async (req, res) => {
    const result = await syncOpenRouterRegistry();
    res.json({
      success: result.success,
      openRouter: {
        ...result,
        lastSync: openRouterLastSync?.toISOString() || null,
        modelCount: Object.keys(openRouterRegistry).length,
      },
      localDb: {
        modelCount: Object.keys(KNOWN_MODEL_CONTEXT).length,
        path: MODEL_DB_PATH,
      },
      probeCache: {
        modelCount: Object.keys(probeCache).length,
        path: MODEL_CACHE_PATH,
      },
    });
  });

  app.get("/api/providers/model-db-status", (req, res) => {
    res.json({
      openRouter: {
        modelCount: Object.keys(openRouterRegistry).length,
        lastSync: openRouterLastSync?.toISOString() || null,
      },
      localDb: {
        modelCount: Object.keys(KNOWN_MODEL_CONTEXT).length,
      },
      probeCache: {
        modelCount: Object.keys(probeCache).length,
        models: Object.keys(probeCache).slice(0, 50),
      },
    });
  });

  app.post("/api/providers/model-probe", async (req, res) => {
   try {
    const { baseUrl, apiKey, defaultUrl, modelId } = req.body || {};
    const target = (baseUrl && baseUrl.trim()) || (defaultUrl && defaultUrl.trim());
    if (!target || !/^https?:\/\//i.test(target)) {
      return res.status(400).json({ success: false, error: "接口重定向网址 (baseUrl) 非法或缺失" });
    }
    if (!modelId || !modelId.trim()) {
      return res.status(400).json({ success: false, error: "modelId 为空" });
    }
    if (!apiKey || !apiKey.trim()) {
      return res.status(400).json({ success: false, error: "API 密钥为空" });
    }

    const base = target.replace(/\/+$/, "");
    const authHeader = `Bearer ${apiKey.trim()}`;
    const headers: Record<string, string> = { "Content-Type": "application/json", "Authorization": authHeader };

    // 1x1 透明 PNG (base64)
    const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    const result = {
      success: false,
      modelId,
      latency: 0,
      probed: {
        basic: false,
        vision: null as boolean | null,
        tools: null as boolean | null,
        json: null as boolean | null,
        streaming: null as boolean | null,
        embeddings: null as boolean | null,
      },
      limits: {
        contextWindow: null as number | null,
        maxOutput: null as number | null,
      },
      usage: null as Record<string, unknown> | null,
      pricing: null as Record<string, unknown> | null,
      rawModelInfo: null as Record<string, unknown> | null,
      responseHeaders: {} as Record<string, string>,
      pingResponse: null as Record<string, unknown> | null,
      serverInfo: {} as Record<string, unknown>,
      errors: {} as Record<string, string>,
    };

    const t0 = Date.now();
    const mkTimeout = (ms: number) => {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), ms);
      return { c, t };
    };

    // ── 辅助：发 chat/completions 请求 ──
    async function chatProbe(body: Record<string, unknown>, timeoutMs = 12000): Promise<{ ok: boolean; status: number; text: string }> {
      const { c, t } = mkTimeout(timeoutMs);
      try {
        const r = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers,
          signal: c.signal,
          body: JSON.stringify({ model: modelId, max_tokens: 1, stream: false, ...body }),
        });
        const text = await r.text();
        return { ok: r.ok, status: r.status, text };
      } catch (e: any) {
        return { ok: false, status: 0, text: e?.name === "AbortError" ? "timeout" : (e?.message || "error") };
      } finally {
        clearTimeout(t);
      }
    }

    // ── 辅助：发 chat/completions 并捕获完整响应 + headers ──
    async function chatProbeFull(body: Record<string, unknown>, timeoutMs = 12000): Promise<{ ok: boolean; status: number; text: string; json: any | null; headers: Record<string, string> }> {
      const { c, t } = mkTimeout(timeoutMs);
      try {
        const r = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers,
          signal: c.signal,
          body: JSON.stringify({ model: modelId, max_tokens: 1, stream: false, ...body }),
        });
        const text = await r.text();
        let json: any = null;
        try { json = JSON.parse(text); } catch {}
        // 捕获关键响应头
        const respHeaders: Record<string, string> = {};
        r.headers.forEach((v, k) => {
          const kl = k.toLowerCase();
          if (kl.startsWith('x-ratelimit') || kl.startsWith('x-request') || kl.includes('remaining') || kl.includes('limit') || kl.includes('reset') || kl === 'date' || kl === 'server' || kl === 'content-type') {
            respHeaders[k] = v;
          }
        });
        return { ok: r.ok, status: r.status, text, json, headers: respHeaders };
      } catch (e: any) {
        return { ok: false, status: 0, text: e?.name === "AbortError" ? "timeout" : (e?.message || "error"), json: null, headers: {} };
      } finally {
        clearTimeout(t);
      }
    }

    // ── Phase 1: 基础 ping (完整响应) + /models/{id} (并行) ──
    const [pingFull, modelsRes] = await Promise.all([
      chatProbeFull({ messages: [{ role: "user", content: "Hi" }] }),
      (async () => {
        const { c, t } = mkTimeout(10000);
        try {
          let r = await fetch(`${base}/models/${encodeURIComponent(modelId)}`, { method: "GET", headers, signal: c.signal });
          if (!r.ok) {
            // 回退到 /models 列表
            r = await fetch(`${base}/models`, { method: "GET", headers, signal: c.signal });
            if (!r.ok) return {};
            const data = await r.json();
            const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
            const found = list.find((m: any) => (typeof m === "string" ? m : (m.id || m.name)) === modelId);
            return typeof found === "string" ? { id: found } : (found || {});
          }
          return await r.json();
        } catch { return {}; }
        finally { clearTimeout(t); }
      })(),
    ]);

    const pingRes = { ok: pingFull.ok, status: pingFull.status, text: pingFull.text };

    // 保存完整 ping 响应 + usage + 响应头
    if (pingFull.json) {
      result.pingResponse = pingFull.json;
      if (pingFull.json.usage) result.usage = pingFull.json.usage;
    }
    result.responseHeaders = pingFull.headers;

    // 保存完整 /models/{id} 原始数据
    if (modelsRes && typeof modelsRes === "object") {
      result.rawModelInfo = modelsRes;
      result.serverInfo = modelsRes;
      if (modelsRes.owned_by) result.serverInfo.owner = modelsRes.owned_by;
      // 提取 pricing (OpenRouter 格式)
      if (modelsRes.pricing) result.pricing = modelsRes.pricing;
    }

    if (!pingRes.ok) {
      result.errors.basic = `${pingRes.status}: ${pingRes.text.slice(0, 300)}`;
      result.latency = Date.now() - t0;
      return res.json(result);
    }
    result.probed.basic = true;

    // ── Phase 2: 并行探测 vision / tools / json / streaming ──
    const [visionRes, toolsRes, jsonRes] = await Promise.all([
      // 视觉探测
      chatProbe({
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image_url", image_url: { url: TINY_PNG } },
          ],
        }],
      }),
      // 工具探测
      chatProbe({
        messages: [{ role: "user", content: "What's the weather?" }],
        tools: [{
          type: "function",
          function: {
            name: "get_weather",
            description: "Get current weather",
            parameters: { type: "object", properties: { location: { type: "string", description: "City name" } }, required: ["location"] },
          },
        }],
      }),
      // JSON 模式探测
      chatProbe({
        messages: [{ role: "user", content: 'Return {"hello":"world"}' }],
        response_format: { type: "json_object" },
      }),
    ]);

    result.probed.vision = visionRes.ok;
    if (!visionRes.ok && visionRes.status !== 0) result.errors.vision = `${visionRes.status}: ${visionRes.text.slice(0, 200)}`;
    else if (visionRes.status === 0) result.errors.vision = visionRes.text;

    result.probed.tools = toolsRes.ok;
    if (!toolsRes.ok && toolsRes.status !== 0) result.errors.tools = `${toolsRes.status}: ${toolsRes.text.slice(0, 200)}`;
    else if (toolsRes.status === 0) result.errors.tools = toolsRes.text;

    result.probed.json = jsonRes.ok;
    if (!jsonRes.ok && jsonRes.status !== 0) result.errors.json = `${jsonRes.status}: ${jsonRes.text.slice(0, 200)}`;
    else if (jsonRes.status === 0) result.errors.json = jsonRes.text;

    // 流式探测 (需要特殊处理：读取首个 chunk 后立即 abort)
    try {
      const { c, t } = mkTimeout(8000);
      const sr = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers,
        signal: c.signal,
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 1,
          stream: true,
        }),
      });
      if (sr.ok) {
        const ct = sr.headers.get("content-type") || "";
        if (ct.includes("text/event-stream") || ct.includes("stream")) {
          result.probed.streaming = true;
        } else {
          // 非 SSE header，尝试读取 body
          const reader = sr.body?.getReader();
          if (reader) {
            const { value } = await reader.read();
            result.probed.streaming = !!value && value.length > 0;
          }
        }
        c.abort(); // 主动中断流
      } else {
        const st = await sr.text();
        result.errors.streaming = `${sr.status}: ${st.slice(0, 200)}`;
      }
      clearTimeout(t);
    } catch (e: any) {
      // AbortError 在读取到数据后触发 = 流式正常
      if (e?.name === "AbortError" && result.probed.streaming !== false) {
        result.probed.streaming = result.probed.streaming ?? true;
      } else {
        result.errors.streaming = e?.message || "streaming probe failed";
      }
    }

    // ── Phase 3: 限制探测 — 发送超大 max_tokens，从错误信息解析 ──
    const limitRes = await chatProbe({
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 999999,
    }, 10000);

    if (!limitRes.ok && limitRes.text) {
      // 尝试提取 max_output / max_tokens 上限
      // 支持多种错误消息格式:
      //   "max_tokens must be less than or equal to 16384"
      //   "max tokens is too large: 999999. Max tokens: 8192"
      //   "maximum output is 4096 tokens"
      //   "The maximum allowed tokens is 4096"
      //   "max_tokens may not be greater than 8192"
      //   "This model has a maximum output of 4096 tokens"
      //   "max_tokens is too large: 999999. This model supports at most 131072 completion tokens"
      const maxOutPatterns = [
        /max_tokens?\s*(?:must be|is|should be|may not be)?\s*(?:less than|<=?|at most|up to|greater than)\s*(?:or equal to\s*)?(\d+)/i,
        /max(?:imum)?\s*(?:output|tokens?|allowed)\s*(?:is|of|:)?\s*(\d+)/i,
        /max_tokens?\s*(?:is|:)\s*(\d+)/i,
        /(?:maximum|max)\s+\d+\s*(?:output|completion)\s*tokens?/i,
        /tokens?\s*(?:limit|max|maximum)\s*(?:is|:)?\s*(\d+)/i,
        /supports\s+at\s+most\s+(\d+)\s*(?:completion|output)?\s*tokens?/i,
        /at\s+most\s+(\d+)\s*(?:completion|output)?\s*tokens?/i,
        /too\s+large.*?(\d{4,})\s*(?:completion|output)?\s*tokens?/i,
      ];
      for (const p of maxOutPatterns) {
        const m = limitRes.text.match(p);
        if (m) { result.limits.maxOutput = parseInt(m[m.length - 1]); break; }
      }

      // 尝试提取 context_length / context window
      // 支持多种错误消息格式:
      //   "This model's maximum context length is 128000 tokens"
      //   "context_length is 64000"
      //   "This model supports a maximum of 128000 tokens"
      //   "maximum input tokens: 128000"
      //   "total tokens cannot exceed 128000"
      //   "input tokens must be less than 64000"
      //   "This model supports at most 131072 completion tokens, whereas you provided 999999"
      //   "maximum context length of 131072 tokens"
      const ctxPatterns = [
        /(?:maximum\s+)?context\s*(?:length|window)\s*(?:is|:|of)?\s*(\d+)/i,
        /context_length\s*(?:is|:)?\s*(\d+)/i,
        /(?:maximum|max)\s+(?:of\s+)?(\d+)\s*tokens?/i,
        /(?:input|total)\s*tokens?\s*(?:cannot\s*exceed|must\s*be\s*less\s*than|limit(?:ed)?\s*to)\s*(\d+)/i,
        /tokens?\s*(?:limit|max)\s*(?:is|:)?\s*(\d+)/i,
        /(?:max|maximum)\s*(?:input|context)\s*tokens?\s*:?\s*(\d+)/i,
        /(\d+)\s*tokens?\s*(?:context|window|input\s*limit)/i,
        /context\s*(?:length|window)\s*(?:of|is)?\s*(\d+)/i,
      ];
      for (const p of ctxPatterns) {
        const m = limitRes.text.match(p);
        if (m) { result.limits.contextWindow = parseInt(m[m.length - 1]); break; }
      }

      result.errors.limits = `${limitRes.status}: ${limitRes.text.slice(0, 500)}`;
    } else if (limitRes.ok) {
      // API 接受了 999999 max_tokens — 可能静默截断了，无法确定上限
      result.errors.limits = "API accepted max_tokens:999999 without error (silent cap, limit unknown)";
    }

    // ── Phase 4: 从 /models 响应补充限制信息 (OpenRouter/Gemini/通用) ──
    if (modelsRes) {
      const m = modelsRes as any;
      if (!result.limits.contextWindow) {
        // 尝试所有可能的字段名
        const ctxFields = ['context_length', 'inputTokenLimit', 'max_input_tokens', 'context_window', 'maxContextLength', 'max_context_tokens', 'input_tokens_limit', 'maxInputTokens'];
        for (const f of ctxFields) {
          if (m[f] && typeof m[f] === 'number') { result.limits.contextWindow = m[f]; break; }
        }
        // OpenRouter 嵌套格式
        if (!result.limits.contextWindow && m.top_provider?.context_length) {
          result.limits.contextWindow = m.top_provider.context_length;
        }
        // 某些 API 在 architecture 中返回
        if (!result.limits.contextWindow && m.architecture?.context_length) {
          result.limits.contextWindow = m.architecture.context_length;
        }
      }
      if (!result.limits.maxOutput) {
        const outFields = ['max_completion_tokens', 'outputTokenLimit', 'max_output_tokens', 'maxOutputTokens', 'max_tokens', 'output_tokens_limit'];
        for (const f of outFields) {
          if (m[f] && typeof m[f] === 'number') { result.limits.maxOutput = m[f]; break; }
        }
        if (!result.limits.maxOutput && m.top_provider?.max_completion_tokens) {
          result.limits.maxOutput = m.top_provider.max_completion_tokens;
        }
        if (!result.limits.maxOutput && m.architecture?.max_output_tokens) {
          result.limits.maxOutput = m.architecture.max_output_tokens;
        }
      }
    }

    // ── Phase 4.5: 从多层数据库补充 (API 完全不返回时的兜底) ──
    if (!result.limits.contextWindow || !result.limits.maxOutput) {
      const known = lookupKnownContext(modelId);
      if (known) {
        if (!result.limits.contextWindow) result.limits.contextWindow = known.context;
        if (!result.limits.maxOutput) result.limits.maxOutput = known.maxOutput ?? null;
      }
    }

    // ── Phase 4.5b: 探针成功后自动缓存结果 (供下次直接使用) ──
    if (result.limits.contextWindow || result.limits.maxOutput) {
      cacheProbeResult(modelId, result.limits.contextWindow, result.limits.maxOutput);
    }

    // ── Phase 4.6: 如果 maxOutput 已知但 contextWindow 未知,推断 contextWindow >= maxOutput ──
    if (result.limits.maxOutput && !result.limits.contextWindow) {
      result.limits.contextWindow = result.limits.maxOutput;
    }

    // ── Phase 5: Embeddings 支持探测 ──
    try {
      const { c, t } = mkTimeout(8000);
      const embRes = await fetch(`${base}/embeddings`, {
        method: "POST",
        headers,
        signal: c.signal,
        body: JSON.stringify({ model: modelId, input: "test" }),
      });
      if (embRes.ok) {
        result.probed.embeddings = true;
      } else if (embRes.status === 404 || embRes.status === 400) {
        result.probed.embeddings = false;
      } else {
        result.probed.embeddings = null;
        result.errors.embeddings = `${embRes.status}: ${(await embRes.text()).slice(0, 150)}`;
      }
      clearTimeout(t);
    } catch {
      result.probed.embeddings = null;
    }

    result.success = true;
    result.latency = Date.now() - t0;

    // ── 探针结果自动同步到后端能力库 ──
    // 这样 agent 调用时能直接查询模型是否支持 tools/vision/json/streaming
    try {
      const capUrl = `http://localhost:3001/api/capabilities/save`;
      await fetch(capUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: modelId,
          capabilities: {
            supportsTools: result.probed.tools,
            supportsVision: result.probed.vision,
            supportsJson: result.probed.json,
            supportsStreaming: result.probed.streaming,
            contextWindow: result.limits.contextWindow,
            maxOutput: result.limits.maxOutput,
          },
        }),
      }).catch(() => {}); // 静默失败, 不影响探针返回
    } catch { /* 静默 */ }

    res.json(result);
   } catch (err: any) {
    console.error('[model-probe] 未捕获异常:', err);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: `探针内部错误: ${err?.message || err}`,
        latency: 0,
      });
    }
   }
  });

  // WebSocket upgrade
  app.get("/ws", backendWsProxy as any);
  // 兼容 /ws/ 前缀
  app.get("/ws/*", backendWsProxy as any);

  // 业务 API 代理（精确前缀匹配，避免吃掉本地端点）
  // 3001 真实端点清单（来自 src/api-server.ts）：
  //   /api/health /api/status /api/kernel/* /api/db/* /api/database/stats
  //   /api/agents /api/archiver/* /api/scheduler/* /api/events/list
  //   /api/observation/* /api/chat/* /api/ws/stats
  // 其它 /api/* (git/custom-rules/channels/system-metrics) 由本地处理
  const backendApiPrefixes = [
    '/api/health', '/api/status', '/api/kernel', '/api/db',
    '/api/database', '/api/agents', '/api/archiver', '/api/scheduler',
    '/api/events/list', '/api/observation', '/api/chat', '/api/ws/stats',
    '/api/audit',
    '/api/vault',    // OS 钥匙串 vault 系统（apiKey 加密存储）
    '/api/providers', // 云端模型服务商连通性测试 & 模型扫描
    '/api/llm',       // LLM 代理流 (/api/llm/stream) — AST 预览管线走此通道
    '/api/auth',      // Token bootstrap + 自动刷新 (/api/auth/bootstrap)
    '/api/terminal',  // 真实终端命令执行 (spawn shell → SSE 推 stdout/stderr/exit)
    '/api/names',     // 用户名称自定义 (双击胶囊名称 → 写入 names.txt [CUSTOM] 槽位)
    // '/api/java-agent' 已由上方专用代理处理 (120s 超时)
    '/api/feedback',   // 经验案例库反馈 (经 3001 代理到 Java Agent 8770)
    '/api/canvas',     // 画布中转端点 (relay/push-ui, relay/register-port, relay/unregister-port)
  ];
  for (const p of backendApiPrefixes) {
    // 关键：用 pathFilter 精确过滤，且不修改 req.url（HPM 默认行为会改写为相对路径）
    const filterProxy = createProxyMiddleware({
      target: BACKEND_URL,
      changeOrigin: true,
      ws: false,
      pathFilter: (pathname) => pathname === p || pathname.startsWith(p + '/'),
      logger: console,
      proxyTimeout: 30000 as any,
      timeout: 30000 as any,
      on: {
        proxyReq: (proxyReq, req) => {
          if ((req as any).body && Object.keys((req as any).body).length) {
            fixRequestBody(proxyReq, req as any);
          }
        },
        error: (err, _req, res) => {
          console.error("[proxy→3001] error:", err.message);
          if (res && 'writeHead' in res) {
            try {
              (res as any).writeHead(502, { "Content-Type": "application/json" });
              (res as any).end(JSON.stringify({
                success: false,
                error: `后端 3001 不可达: ${err.message}`,
                backend: BACKEND_URL,
              }));
            } catch { /* response already sent */ }
          }
        },
      },
    });
    app.use(filterProxy);
  }

  console.log(`[proxy] 业务 API 全部转发到 ${BACKEND_URL}`);
  console.log(`[proxy] SSE /api/events/stream → ${BACKEND_URL}（长连接模式）`);
  console.log(`[proxy] WS /ws → ${BACKEND_URL.replace(/^http/, "ws")}`);
  console.log(`[proxy] 代理前缀: ${backendApiPrefixes.join(", ")}`);

  // ============================================================
  // Git Service Proxy - 代理所有 /api/git/* 请求到 Go git-service
  // ============================================================
  const GIT_SERVICE_URL = process.env.GIT_SERVICE_URL || "http://localhost:3002";
  
  const gitServiceProxy = createProxyMiddleware({
    target: GIT_SERVICE_URL,
    changeOrigin: true,
    ws: false,
    pathFilter: (pathname) => pathname.startsWith('/api/git'),
    logger: console,
    proxyTimeout: 30000 as any,
    timeout: 30000 as any,
    on: {
      proxyReq: (proxyReq, req) => {
        if ((req as any).body && Object.keys((req as any).body).length) {
          fixRequestBody(proxyReq, req as any);
        }
      },
      error: (err, _req, res) => {
        console.error("[proxy→git-service] error:", err.message);
        if (res && 'writeHead' in res) {
          try {
            (res as any).writeHead(502, { "Content-Type": "application/json" });
            (res as any).end(JSON.stringify({
              success: false,
              error: `Git 服务不可达: ${err.message}`,
              service: GIT_SERVICE_URL,
            }));
          } catch { /* response already sent */ }
        }
      },
    },
  });
  
  app.use(gitServiceProxy);
  console.log(`[proxy] Git API /api/git/* → ${GIT_SERVICE_URL}（go-git 后端）`);

  // ============================================================
  // MARL Python /sync/reputation HTTP 接收端 (audit B2 修复)
  // 8766 端口独立于 3001 backend, 不走 P9 outbox 路径
  // 前端通过 3000/api/marl/reputation/* 间接访问, 主要用于:
  //   - 健康检查 (启动 / preflight)
  //   - 测试时手动 push 测试事件
  // ============================================================
  const MARL_REPUTATION_HTTP = process.env.SOLOFORGE_MARL_REPUTATION_URL
    || "http://127.0.0.1:8766";
  const marlReputationProxy = createProxyMiddleware({
    target: MARL_REPUTATION_HTTP,
    changeOrigin: true,
    pathRewrite: { "^/api/marl/reputation": "/sync/reputation" },
    pathFilter: (pathname) => pathname === "/api/marl/reputation" || pathname.startsWith("/api/marl/reputation/"),
    logger: console,
    on: {
      proxyReq: (proxyReq, req) => {
        // 上面 app.use(express.json({limit:'10mb'})) 会消费原始 POST body 流,
        // 必须用 fixRequestBody 从 req.body 重新写入 upstream, 否则 8766 receiver
        // 收到空 body, 触发 "Malformed payload string" 后 HPM 关闭连接.
        if ((req as any).body && Object.keys((req as any).body).length) {
          fixRequestBody(proxyReq, req as any);
        }
      },
      error: (err, _req, res) => {
        console.error(`[proxy→8766] error: ${err.message}`);
        if (res && 'writeHead' in res) {
          try {
            (res as any).writeHead(502, { "Content-Type": "application/json" });
            (res as any).end(JSON.stringify({
              success: false,
              error: `MARL 8766 不可达: ${err.message}`,
              target: MARL_REPUTATION_HTTP,
            }));
          } catch { /* response already sent */ }
        }
      },
    },
  });
  // 用 pathFilter 而非 app.use("/api/marl/reputation", ...) — Express 会先截 prefix,
  // HPM 拿到的 pathname 变 "/", pathRewrite 失效 (audit B2 验证后保留 pathFilter 写法).
  app.use(marlReputationProxy);
  console.log(`[proxy] MARL Reputation API /api/marl/reputation/* → ${MARL_REPUTATION_HTTP}/sync/reputation (P9 端, audit B2 修复)`);

  // GET custom rules markdown content
  app.get("/api/custom-rules", (req, res) => {
    try {
      const skill = req.query.skill as string || 'custom_rules';
      let fileName = "custom_rules.md";
      let defaultContent = `# AI 专属任务规划与行为约束\n\n## 🗓️ 核心要务 (To-do)\n- 遵循高内聚、低耦合的模块化设计。\n- 每次输出代码时，都优先进行行级精准分析，避免重构多余的逻辑。\n- 保证用户界面的视觉还原度，注重布局、内边距和排版的精致调校。\n\n## 🛡️ 强制约束 (Constraints)\n- 零冗余代码：不要在非必需处引入外部 telemetry 或干扰性的模拟状态行。\n- 类型安全：禁止使用任何 any 类型，必须定义完整的 TypeScript 接口。\n`;

      if (skill === 'frontend_expert') {
        fileName = "frontend_rules.md";
        defaultContent = `# 前端视觉专家规则 (frontend_rules.md)\n\n## 🗓️ 核心要务 (To-do)\n- 优雅运用 Tailwind CSS 创造高画质界面。\n- 重视元素间距（Margins / Paddings）、微动效（Transitions）与精巧阴影。\n- 保证完美的响应式适配（Desktop、Tablet 与 Mobile）。\n\n## 🛡️ 强制约束 (Constraints)\n- 严禁使用过饱和或刺眼的渐变。\n- 所有 UI 状态必须顺滑过渡，保持 100% 交互流畅与高对比度。\n`;
      } else if (skill === 'db_manager') {
        fileName = "db_rules.md";
        defaultContent = `# 数据库架构师规则 (db_rules.md)\n\n## 🗓️ 核心要务 (To-do)\n- 设计清晰、规范 of database schema and index.\n- 确保高度事务安全与实体关联完整性。\n- 精准控制大文本或频繁读写字段的读取速率。\n\n## 🛡️ 强制约束 (Constraints)\n- 绝不允许编写无约束的外键或无主键表。\n- 严禁使用未过滤的 RAW 查询拼接。\n`;
      } else if (skill === 'security_warden') {
        fileName = "security_rules.md";
        defaultContent = `# 安全防御卫士规则 (security_rules.md)\n\n## 🗓️ 核心要务 (To-do)\n- 注入严格的用户权限认证与接口访问守卫（Auth Guard）。\n- 对任意入参进行完备的 SQL 注入或 XSS 防护过滤。\n- 对日志与报错信息实行脱敏处理。\n\n## 🛡️ 强制约束 (Constraints)\n- 禁止将任何 API key 或原始明文密码泄露在客户端浏览器。\n- 所有安全凭证必须用安全加载。\n`;
      } else if (skill === 'hashline_auditor') {
        fileName = "hashline_rules.md";
        defaultContent = `# 行哈希速变器规则 (hashline_rules.md)\n\n## 🗓️ 核心要务 (To-do)\n- 按照 Hashline 行哈希规则对文件进行精准增量替换。\n- 完美一比一高拟真匹配 MCP 的 line-locked diff 反馈机制。\n- 针对修改部分生成严格对应的前后锚点行，绝不破坏文件整体结构。\n\n## 🛡️ 强制约束 (Constraints)\n- 严禁进行不可逆的任意全文件覆写。\n`;
      } else if (skill === 'extreme_mode') {
        fileName = "extreme_rules.md";
        defaultContent = `# 极致模式规则 (extreme_rules.md)\n\n## 🗓️ 核心要务 (To-do)\n- 极其挑剔的代码质量、高运行性能、高加载速度。\n- 深度优化页面渲染效率，彻底消除不必要的二次渲染与重新排版布局。\n- 设计最高雅的模块设计，最大化提炼通用复用逻辑，追求极佳美学追求。\n\n## 🛡️ 强制约束 (Constraints)\n- 严禁引入任何未压缩的无关杂音库。\n- 代码行数和依赖大小必须受到强力控守，追求最快、最准、最干练的最优性能解。\n`;
      }

      const filePath = path.join(process.cwd(), fileName);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, defaultContent, "utf-8");
      }
      const data = fs.readFileSync(filePath, "utf-8");
      res.json({ success: true, content: data, fileName });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST update custom rules markdown content
  app.post("/api/custom-rules", (req, res) => {
    try {
      const { content, skill } = req.body;
      const targetSkill = skill || 'custom_rules';
      let fileName = "custom_rules.md";

      if (targetSkill === 'frontend_expert') {
        fileName = "frontend_rules.md";
      } else if (targetSkill === 'db_manager') {
        fileName = "db_rules.md";
      } else if (targetSkill === 'security_warden') {
        fileName = "security_rules.md";
      } else if (targetSkill === 'hashline_auditor') {
        fileName = "hashline_rules.md";
      } else if (targetSkill === 'extreme_mode') {
        fileName = "extreme_rules.md";
      }

      const filePath = path.join(process.cwd(), fileName);
      fs.writeFileSync(filePath, content || "", "utf-8");
      res.json({ success: true, fileName });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ============================================================
  // /api/system-metrics — CPU/内存/磁盘 IO 指标端点
  //   - 主线程零计算,只读 worker 推送的缓存
  //   - 每次请求触发一次按需磁盘 IO 采样(worker 内节流 1s/次)
  //   - 磁盘驱动器列表由 worker 在 'sample-and-get' 时返回
  // ============================================================
  app.get("/api/system-metrics", (req, res) => {
    try {
      // 触发 worker 异步采样(不等待,下次请求能看到新值)
      metricsWorker.postMessage({ type: "sample-and-get" });
      res.json({
        success: true,
        timestamp: Date.now(),
        cpu: lastMetrics.cpu,
        memory: lastMetrics.memory,
        disk: {
          readSpeed: lastMetrics.disk?.readSpeed || 0,
          writeSpeed: lastMetrics.disk?.writeSpeed || 0,
          drives: lastMetrics.disk?.drives || [],
        },
      });
    } catch (err: any) {
      res.json({
        success: false,
        error: err.message
      });
    }
  });

  // Real endpoint for message channel webhook tests (bypassing browser CORS)
  app.post("/api/channels/test", async (req, res) => {
    try {
      const { channelType, webhookUrl } = req.body;
      
      if (!webhookUrl) {
        return res.status(400).json({ success: false, error: "Webhook URL 不能为空，请输入有效的通道接口地址。" });
      }

      // Quick syntax validate
      try {
        new URL(webhookUrl);
      } catch (e) {
        return res.status(400).json({ success: false, error: "输入的 URL 格式非法，必须是完整的 http:// 或 https:// 协议头链接。" });
      }

      let payload: any = {};
      const testMsg = `【SoloForge 开发控制台】消息连接配置成功！[触发时间: ${new Date().toLocaleString()}] — 您已成功绑定此消息通道并接收实时会话状态。🌻`;

      if (channelType === 'feishu') {
        payload = {
          msg_type: "text",
          content: {
            text: testMsg
          }
        };
      } else if (channelType === 'wechat') {
        // Support general 企业微信 webhook standard
        payload = {
          msgtype: "text",
          text: {
            content: testMsg,
            mentioned_list: []
          }
        };
      } else if (channelType === 'qq') {
        // Support standard QQ bot webhook structure or generic ones
        payload = {
          message: testMsg,
          msg_type: "text"
        };
      } else {
        payload = {
          text: testMsg
        };
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000); // 8-second safety timeout

      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "SoloForge-Message-Engine/1.0"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const status = response.status;
      const responseText = await response.text();

      if (response.ok) {
        res.json({
          success: true,
          status,
          apiReply: responseText.slice(0, 500) // truncate for safety
        });
      } else {
        res.json({
          success: false,
          status,
          apiReply: responseText.slice(0, 500) || "无响应报文"
        });
      }
    } catch (err: any) {
      console.error("Channel proxy fetch helper error:", err);
      res.json({
        success: false,
        error: err.name === 'AbortError' ? "请求响应超时 (8000ms)，可能该目标地址外部防火墙拦截。" : (err.message || "请求发送失败")
      });
    }
  });

  // Serve static assets / handle Vite development server middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    console.log("Vite development middleware mounted successfully.");
  } else {
    // Serve production static outputs
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    console.log("Production static server route configured.");
  }

  // 优雅退出: flush 对话列表 + 消息 + 设置到磁盘
  process.on('SIGINT', () => {
    console.log('[server] SIGINT received, flushing stores...');
    flushChatStore();
    flushConversationStore();
    flushSettingsToDiskSync();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    console.log('[server] SIGTERM received, flushing stores...');
    flushChatStore();
    flushConversationStore();
    flushSettingsToDiskSync();
    process.exit(0);
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Development custom full-stack server active on port ${PORT}`);
  });
}

startServer();
