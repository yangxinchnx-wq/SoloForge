# SoloForge API 接口文档(单机/桌面版)

> 本文档列出前端与 SoloForge 后端交互时需要知道的**所有公开 HTTP 接口和 CLI 命令**。
> 涵盖鉴权(API Token)、事件流(SSE)、WebSocket、管理面板、Vault、Agent 调度等。

---

## 0. 鉴权基础

### 0.1 API Token 是什么

SoloForge 的后端只接受**带 token 的请求**。Token 是一串 64 字符的十六进制随机字符串,等价于前端与后端通信的"密码"。

**Token 的来源(三处优先查找):**
1. **环境变量** `SOLOFORGE_API_TOKENS`(逗号分隔多个,适合 CI/容器)
2. **OS 钥匙串(vault)**,provider id 固定为 `soloforge.api.tokens`
3. **自动生成**(仅当 `SOLOFORGE_REQUIRE_TOKENS=0` 时,单机/桌面版的默认行为)

### 0.2 三种调用方式

| 场景 | 怎么传 token |
|---|---|
| **浏览器 / fetch / axios** | `Authorization: Bearer <token>` 请求头 |
| **Server-Sent Events(EventSource)** | EventSource 不能设 header,改用 query: `?token=<token>` |
| **WebSocket** | 子协议方式: `new WebSocket(url, ['bearer', token])` 或在握手后第一帧发 token |

### 0.3 同机不需要传 token

如果你的前端和后端跑在同一台机器(127.0.0.1 / ::1),`SOLOFORGE_TRUST_LOOPBACK=1`(默认)时,所有 loopback 请求自动被信任为 admin,不需要带 token。但**显式带 token 更稳**,便于以后关掉 loopback 信任时不用改前端代码。

### 0.4 Token 解析顺序(后端)

```
1) 读 HTTP 头 Authorization: Bearer xxx
2) 读 query 参数 ?token=xxx(仅 SSE / EventSource 允许)
3) 如果是 127.0.0.1,自动信任
4) 否则 401 Unauthorized
```

---

## 1. 鉴权与 Token 管理接口

### 1.1 `GET /api/auth/bootstrap` ⭐ 关键

**作用**:同机前端启动时,一次性拉取当前生效的 API token。

**鉴权要求**:无(因为只能从 loopback 访问,被鉴权层自动放行)

**请求**:
```http
GET /api/auth/bootstrap HTTP/1.1
Host: 127.0.0.1:<port>
```

**响应 200**:
```json
{
  "token":  "a3f7c91b2e4d6f8a1c3b5d7e9f1a3c5b7d9e1f3a5c7b9d1e3f5a7c9b1d3e5f7a9",
  "count":  1,
  "source": "vault"
}
```

**字段说明**:
| 字段 | 类型 | 含义 |
|---|---|---|
| `token` | string \| null | 当前主 token(从 vault 或 env 取的第一个)。null 表示未配置 |
| `count` | number | vault/env 中有效 token 总数(轮换期可能 > 1) |
| `source` | `"env"` \| `"vault"` | 主 token 来源。env 优先 |

**错误**:
| 状态码 | 含义 |
|---|---|
| 403 | 不是从 loopback 访问(被 auth 层拒) |
| 404 | 该路由不存在(检查端口和路径) |

**前端使用范式**:
```js
// 启动时调用
const { token } = await fetch('http://127.0.0.1:8080/api/auth/bootstrap').then(r => r.json());

// 存起来
sessionStorage.setItem('soloforge_token', token);

// 后续请求带上
fetch('http://127.0.0.1:8080/api/vault/keys', {
  headers: { 'Authorization': `Bearer ${token}` }
});

// 收到 401 时重新拉
async function authFetch(url, opts = {}) {
  let token = sessionStorage.getItem('soloforge_token');
  let res = await fetch(url, { ...opts, headers: { ...opts.headers, Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    const fresh = await fetch('http://127.0.0.1:8080/api/auth/bootstrap').then(r => r.json());
    sessionStorage.setItem('soloforge_token', fresh.token);
    token = fresh.token;
    res = await fetch(url, { ...opts, headers: { ...opts.headers, Authorization: `Bearer ${token}` } });
  }
  return res;
}
```

---

## 2. 系统状态接口

### 2.1 `GET /api/health`

**作用**:基础健康检查(不鉴权)

**响应 200**:
```json
{ "status": "ok", "uptime": 12345 }
```

### 2.2 `GET /api/kernel/status`

**作用**:获取内核状态(运行模式、当前状态、关键模块健康度)

**鉴权要求**:operator 角色(任意有效 token)

**响应 200**:
```json
{
  "mode": "NORMAL",
  "state": "READY",
  "uptime": 12345,
  "modules": {
    "kernel": "READY",
    "scheduler": "READY",
    "court": "READY"
  }
}
```

### 2.3 `GET /api/kernel/events?limit=50`

**作用**:拉取最近 N 条内核事件(SSE 之外的轮询版)

**响应**:事件数组,每条含 `event`、`payload`、`timestamp` 三个字段。

### 2.4 `GET /api/events/stream` (SSE)

**作用**:订阅实时事件流(任务进度、Agent 活动、决策结果等)

**鉴权**:token 通过 query 传 `?token=xxx`,因为 EventSource 不能设 header

**示例**:
```js
const token = sessionStorage.getItem('soloforge_token');
const es = new EventSource(`http://127.0.0.1:8080/api/events/stream?token=${token}`);
es.onmessage = (e) => {
  const { event, payload, timestamp } = JSON.parse(e.data);
  console.log(event, payload, timestamp);
};
```

---

## 3. Agent 管理接口

### 3.1 `POST /api/agents/dispatch`

**作用**:派发一个任务给 Agent(RACER 决策 + 真实执行)

**鉴权要求**:operator 角色

**请求体**:
```json
{
  "agentId": "agent-001",
  "taskType": "execute",
  "payload": { "action": "compute", "args": [...] }
}
```

**响应 200**:
```json
{
  "taskId": "task_01HX...",
  "status": "queued",
  "estimatedDuration": 1500
}
```

---

## 4. Vault 密钥管理接口

### 4.1 `GET /api/vault/keys`

**作用**:列出所有 LLM provider 密钥(脱敏后)

**鉴权要求**:admin 角色

**响应 200**:
```json
{
  "items": [
    {
      "id": "openai",
      "baseUrl": "https://api.openai.com",
      "hasKey": true,
      "source": "keychain",
      "createdAt": 1700000000000,
      "updatedAt": 1700000001000
    }
  ],
  "count": 1
}
```

**重要**:`apiKey` 字段**永远不会**出现在响应里(白名单深度防御)。

### 4.2 `GET /api/vault/keys/:id`

**作用**:获取某个 provider 的元信息(同样无 apiKey)

### 4.3 `PUT /api/vault/keys/:id`

**作用**:写入/更新一个 provider 的 apiKey + baseUrl

**请求体**:
```json
{ "apiKey": "sk-...", "baseUrl": "https://api.openai.com/v1" }
```

### 4.4 `DELETE /api/vault/keys/:id`

**作用**:删除一个 provider 的密钥

### 4.5 `POST /api/vault/keys/:id/verify`

**作用**:用这个密钥发一个测试请求,验证连通性

### 4.6 `POST /api/vault/export`

**作用**:加密导出所有密钥(用用户提供的 passphrase 加密)

**请求体**:`{ "passphrase": "..." }`

### 4.7 `POST /api/vault/import`

**作用**:导入加密的密钥文件

### 4.8 `POST /api/vault/verify-passphrase`

**作用**:验证 passphrase 是否能解密已存的导出文件

---

## 5. CLI:Token 管理(`npm run token:*`)

> 这些命令操作的是**API Token**(前端鉴权用),不是 LLM 密钥(vault 里的 apiKey)。

### 5.1 `npm run token:show`

**作用**:查看 token 配置概况(env 几个 / vault 几个 / 主 token 摘要)

**示例输出**:
```
[token] 环境变量 SOLOFORGE_API_TOKENS 未设置(将走 vault 或自动生成)。
[token] vault 持有 1 个 token。
[token] 主 token: a3f7c9...f7a9 (len=64)
[token] 启动期 token 解析顺序:env -> vault -> 自动生成(需 SOLOFORGE_REQUIRE_TOKENS=0)
```

### 5.2 `npm run token:list [--reveal]`

**作用**:列出 vault 中所有 token(默认遮罩,加 `--reveal` 显示明文)

**示例**:
```
$ npm run token:list
[token] vault 中有 1 个 token:
  [1] a3f7c9...f7a9 (len=64)

$ npm run token:list -- --reveal
[token] vault 中有 1 个 token:
  [1] a3f7c91b2e4d6f8a1c3b5d7e9f1a3c5b7d9e1f3a5c7b9d1e3f5a7c9b1d3e5f7a9   <- 明文
```

### 5.3 `npm run token:init [--force]`

**作用**:生成新 token 并写入 vault。已存在则拒绝(加 `--force` 强制覆盖)

### 5.4 `npm run token:rotate`

**作用**:追加一个新 token,旧 token 仍有效(用于平滑轮换)

**工作流**:rotate → 前端拿新 token → 验证新 token 正常 → revoke 旧 token

### 5.5 `npm run token:revoke`

**作用**:交互式吊销指定 token(列出所有,选序号删除;输入 `all` 清空)

### 5.6 `npm run token:clear`

**作用**:无条件清空 vault 所有 token。**不可逆**,下次启动需重新 init。

---

## 6. WebSocket 接口

### 6.1 `ws://localhost:<port>/ws/agents`

**作用**:Agent 实时双向通道(状态推送、任务接收、事件订阅)

**鉴权**:在 WebSocket 子协议里传 token:
```js
const ws = new WebSocket('ws://127.0.0.1:8080/ws/agents', ['bearer', token]);
```

**消息格式**(JSON):
```json
{
  "type": "agent.status" | "task.dispatch" | "decision.commit" | "...",
  "payload": { ... }
}
```

---

## 7. 错误响应统一格式

所有错误响应的 body 都是 JSON,形如:

```json
{ "error": "Unauthorized", "reason": "insufficient_credentials" }
```

| 状态码 | 含义 |
|---|---|
| 200 | 成功 |
| 204 | 成功(无 body),通常用于 OPTIONS 预检 |
| 400 | 请求体格式错(不是 JSON、字段缺失等) |
| 401 | 鉴权失败(token 缺失、过期、错误、吊销) |
| 403 | 权限不够(角色不够、IP 不在白名单) |
| 404 | 路径不存在 |
| 413 | 请求体超过 1 MiB 上限 |
| 415 | Content-Type 不是 application/json |
| 429 | 触发限流(`Retry-After` 头会告诉你等几秒) |
| 500 | 内部错误(响应已脱敏,详情在审计日志) |

---

## 8. 限流规则

| 维度 | 上限 |
|---|---|
| 每 IP 总体 | 10 RPS 持续 + burst 60,1 分钟 600 次 |
| `/api/vault/*` `/api/admin/*` 额外桶 | 1 RPS 持续 + burst 10,1 分钟 60 次 |
| Body 大小 | 1 MiB(超过 413) |

触发限流返回 429 + `Retry-After: <秒数>` 头。

---

## 9. 安全响应头(由服务端自动加)

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
X-DNS-Prefetch-Control: off
Strict-Transport-Security: max-age=63072000; includeSubDomains   (仅 HTTPS)
```

CORS:
```
Access-Control-Allow-Origin: <白名单里的 origin,或第一个作为兜底>
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Allow-Credentials: false
Vary: Origin
```

---

## 10. 完整调用示例

### 10.1 启动 → 拿 token → 派任务

```js
// 1. 启动期
const { token, source, count } = await fetch(
  'http://127.0.0.1:8080/api/auth/bootstrap'
).then(r => r.json());
console.log('Token from', source, '-', count, 'active');

// 2. 列出 vault(脱敏)
const vault = await fetch('http://127.0.0.1:8080/api/vault/keys', {
  headers: { Authorization: `Bearer ${token}` }
}).then(r => r.json());
console.log('Providers:', vault.items.map(i => i.id));

// 3. 派任务
const dispatch = await fetch('http://127.0.0.1:8080/api/agents/dispatch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    agentId: 'agent-001',
    taskType: 'execute',
    payload: { action: 'compute' }
  })
}).then(r => r.json());
console.log('Dispatched:', dispatch.taskId);

// 4. 订阅 SSE
const es = new EventSource(
  `http://127.0.0.1:8080/api/events/stream?token=${token}`
);
es.onmessage = (e) => {
  const evt = JSON.parse(e.data);
  console.log('Event:', evt.event);
};
```

### 10.2 服务端调 LLM 的凭证写入(Vault 操作)

```js
// 写入 OpenAI 凭证
await fetch('http://127.0.0.1:8080/api/vault/keys/openai', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    apiKey: 'sk-...',
    baseUrl: 'https://api.openai.com/v1'
  })
});

// 验证
const verify = await fetch('http://127.0.0.1:8080/api/vault/keys/openai/verify', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` }
}).then(r => r.json());
```

---

## 11. 环境变量参考(完整)

| 变量 | 默认 | 作用 |
|---|---|---|
| `SOLOFORGE_API_TOKENS` | 空 | 逗号分隔的 API token 列表(env 优先) |
| `SOLOFORGE_CORS_ORIGINS` | `http://localhost:5173,5174,127.0.0.1:5173` | CORS 白名单 |
| `SOLOFORGE_TRUST_LOOPBACK` | `1` | 是否信任 127.0.0.1 访问(0=否) |
| `SOLOFORGE_REQUIRE_TOKENS` | `1` | 启动时是否强制要求至少一个 token(0=允许自动生成) |
| `SOLOFORGE_REVOKED_TOKENS` | 空 | 已吊销的 token 列表(逗号分隔,紧急吊销用) |
| `SOLOFORGE_PII_SALT` | `soloforge-default-salt` | 远程 IP 哈希盐(审计日志用) |

---

## 12. 相关文档

- `docs/PRODUCTION.md` — 单机部署与运维指南
- `README.md` — 项目总览与架构
- `src/security/auth.ts` — 鉴权核心实现(内联 JSDoc)
- `src/security/token-store.ts` — vault-first token 存储
- `scripts/token.ts` — CLI 工具源码