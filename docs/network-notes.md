# SoloForge 网络/调用栈技术备忘 (2026-07-02)

> 本篇只沉淀"为什么这样做"的网络/HTTP 调用栈决策。
> 不写开发指引、不写 API 文档——只回答"为什么不用 SDK / 为什么避开 curl.exe"这类问题。

---

## 1. 为什么 SoloForge LLM 链路用 Node 内置 `fetch`,而不用 `openai` SDK

### 1.1 现状

- 后端 SSE 流：`src/llm/openaiStreamClient.ts`
- 后端非流：`src/llm/openaiSyncClient.ts`(2026-07-02 新增)
- /admin health 探针：`src/llm/llmProxyHandler.ts:handleLLMHealth`

三者都是 **零 npm 依赖**,只用 Node 18+ 自带:

| Node 内置能力 | 用来做什么 |
|---------------|----------|
| `fetch` (新版) | HTTP 客户端 |
| `AbortController` | 超时/取消 |
| `TextDecoder` | SSE byte → string |
| `Stream / getReader` | 流式分块读取 |

### 1.2 三层动机

#### ① 零依赖 = 更小的 lockfile & 更少的安全审计面
`openai` SDK 体积大、会拖进一堆 transitive 包；项目里所有 OpenAI 兼容(OpenAI / DeepSeek / Moonshot / 自建 / Agnes AI)只需要发一个 `POST /chat/completions`,**自己写反而更直观**,因为协议本身只有 4 个字段(`model`/`messages`/`stream`/`temperature`)。

#### ② Node 自带 OpenSSL 3,**天生不踩 Windows Schannel OCSP 墙**
Windows 平台的 `curl.exe`(libcurl 8.9.1)绑 **Schannel** 作为 SSL 后端,而 Schannel 默认会做 CRL/OCSP 证书吊销检查:
- 当 CA 的吊销服务器不可达(常见于企业网/大陆网络),直接抛 `CRYPT_E_REVOCATION_OFFLINE`
- 错误信息:`curl: (35) schannel: next InitializeSecurityContext failed: CRYPT_E_REVOCATION_OFFLINE (0x80092013)`

Node 的 `fetch` 走 **OpenSSL 3**,**完全不经过 Schannel**,也就没有 OCSP 这个关卡。

**结论**:SoloForge 项目里所有 LLM 调用天然避开了 Windows Schannel/OCSP 风险,**不需要给 Node 代码加任何参数**。

#### ③ 跨平台一致
- Linux/macOS:Node 跑 OpenSSL,稳定
- Windows:Node 跑 OpenSSL 3,稳定(不走系统 Schannel)
- 都不需要 per-invocation flag,降低 dev/QA 沟通成本

### 1.3 兜底:Windows 上需要用 `curl` 时
某些 dev ops 脚本(健康探针、Postman、Docker 一次性 curl)无法用 Node 写,这时:
- 必须加 `--ssl-no-revoke`(只关 OCSP 校验,不影响 TLS 加密 / 主机名校验 / 证书链)

```bash
curl --ssl-no-revoke https://apihub.agnes-ai.com/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"agnes-2.0-flash","messages":[{"role":"user","content":"hi"}]}'
```

---

## 2. 实战对照(2026-07-02 用 Agnes AI vLLM 端点实测)

| 方式 | 调用链 | 实测 |
|------|--------|------|
| `curl.exe --ssl-no-revoke` | Schannel + 跳过 OCSP | HTTP 200 |
| `curl.exe`(不加) | Schannel + OCSP | **偶发** `CRYPT_E_REVOCATION_OFFLINE` |
| `node "import 'openai'"` | OpenSSL 3 + Node fetch | (未走通:项目里未装 openai,故意为之) |
| **SoloForge `callOpenAIChat` (Node 内置 fetch)** | **OpenSSL 3 + Node fetch** | **HTTP 200,稳定,11.2s** |

---

## 3. 何时**不要**用 Node fetch,改用其它方案

| 场景 | 推荐 | 原因 |
|------|------|------|
| 探测 TCP 端口是否在 listen | Node `net.createConnection` | 比 HTTP 握手快 5-10 倍,见 `start-all.mjs:portOpen` |
| 大文件下载/上传(>100MB) | curl.exe / 第三方工具 | Node fetch 在大体积下内存控制不如 curl |
| 与 PowerShell 兼容 | PowerShell `Invoke-WebRequest` | 旧 Windows 运维 |
| **不能**做的事 | — | **不要改系统注册表 / 不要替换 curl.exe / 不要关全局 OCSP** |

---

## 4. 总结一句

> SoloForge 默认原则:**LLM 走 Node,不走 curl.exe**。
> 这是零依赖 + 跨平台稳定 + 自动避开 Windows Schannel OCSP 的最优组合。

后续若新增 LLM 集成、tool-calling 调用、embedding、rerank 等,**沿用 openaiSyncClient.ts / openaiStreamClient.ts 的同源设计**(零 npm 依赖 + Node fetch + AbortController + 复用 llmConfig)。
