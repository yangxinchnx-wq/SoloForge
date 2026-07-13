# SoloForge 网络代理功能 — 补充说明 (v2.1)

> 本文档为 `proxy-implementation-guide.md` (v2) 的修正与增补，涵盖审阅中发现的 9 项问题。
>
> **生成日期**: 2026-07-13
> **适用版本**: proxy-implementation-guide v2 → v2.1
> **状态**: 待合入主文档

---

## 目录

- [§A 严重问题修正](#a-严重问题修正)
  - [A.1 PAC 模式 Node.js 层同步](#a1-pac-模式-nodejs-层同步)
  - [A.2 System 模式注册表→环境变量桥接](#a2-system-模式注册表环境变量桥接)
- [§B 中等优先级补充](#b-中等优先级补充)
  - [B.1 跨平台系统代理检测](#b1-跨平台系统代理检测)
  - [B.2 连通性测试端点优化](#b2-连通性测试端点优化)
  - [B.3 代理认证支持设计](#b3-代理认证支持设计)
- [§C 低优先级增强](#c-低优先级增强)
  - [C.1 WebSocket 代理路径](#c1-websocket-代理路径)
  - [C.2 错误处理与回滚机制](#c2-错误处理与回滚机制)
  - [C.3 版本兼容性声明](#c3-版本兼容性声明)
  - [C.4 安全性考量](#c4-安全性考量)
- [§D 完整修正版伪代码](#d-完整修正版伪代码)

---

## §A 严重问题修正

### A.1 PAC 模式 Node.js 层同步

**问题描述**（原文 §5.2）：

`syncNodeProxyEnv()` 函数仅处理 `manual` 模式，`pac` 和 `system` 模式下 Node.js 层不会走代理——**静默失败**。

**根因分析**：

| 模式 | Chromium 层 | Node.js 层（v2 原文） | Node.js 层（v2.1 修正） |
|------|-----------|----------------------|------------------------|
| `system` | ✅ session.setProxy({mode:'system'}) | ❌ 直接 return，不注入环境变量 | ✅ 读取 OS 代理地址并注入 |
| `direct` | ✅ 直连 | ✅ 清除环境变量 | ✅ 不变 |
| `manual` | ✅ fixed_servers | ✅ 注入 HTTP_PROXY 等 | ✅ 不变 |
| `pac` | ✅ pac_script | ❌ **未处理** — 后端直连 | ⚠️ 提示用户 / fallback |

**PAC 模式的核心矛盾**：

Chromium 内核原生支持 PAC 脚本解析（V8 引擎执行 JavaScript），但 Node.js 运行时**不内置 PAC 解析器**。要在 Node.js 层完整支持 PAC，需要引入额外依赖：

```bash
npm install pac-proxy-agent
```

**推荐方案（三选一）**：

| 方案 | 复杂度 | 效果 | 推荐场景 |
|------|--------|------|----------|
| **A: UI 提示 + 直连** | 低 | 渲染进程走 PAC，后端直连 | MVP 首发版本 |
| **B: pac-proxy-agent** | 中 | 全链路 PAC 支持 | 企业版/完整版 |
| **C: PAC → system fallback** | 中 | PAC 模式下后端 fallback 到系统代理 | 折中方案 |

#### 方案 A 实现（推荐用于 v2.1 最小修复）

在 `_syncNodeEnv()` 中增加 PAC 分支：

```javascript
_syncNodeEnv(config) {
    // 清除旧值（不变）
    for (const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY',
                        'http_proxy','https_proxy','all_proxy','no_proxy']) {
        delete process.env[key];
    }

    if (config.mode === 'direct') return;

    if (config.mode === 'system') {
        // ★ 修正: 不再直接 return，改为读取 OS 代理并注入
        // （见 A.2 节详细实现）
        this._syncSystemProxyToNode();
        return;
    }

    if (config.mode === 'manual') {
        const url = this._buildProxyUrl(config);
        process.env.HTTP_PROXY = url;
        process.env.HTTPS_PROXY = url;
        process.env.ALL_PROXY = url;
        process.env.NO_PROXY = config.bypassList || BYPASS_DEFAULT;
        return;
    }

    if (config.mode === 'pac') {
        // ★ 新增: PAC 模式处理
        console.warn(
            '[ProxyService] PAC 模式仅对渲染进程(Chromium)生效。\n' +
            'Node.js 后端请求将直连。如需全链路 PAC 支持，请引入 pac-proxy-agent。'
        );
    }
}
```

#### 方案 B 实现（完整 PAC 支持）

```javascript
// 需要额外依赖: npm install pac-proxy-agent
async _syncPacToNode(pacUrl) {
    try {
        const { PacProxyAgent } = await import('pac-proxy-agent');
        const agent = new PacProxyAgent(pacUrl);
        globalThis.__proxyAgent = agent;
        console.log(`[ProxyService] PAC agent 已初始化: ${pacUrl}`);
    } catch (err) {
        console.error('[ProxyService] PAC agent 初始化失败:', err.message);
        console.warn('[ProxyService] 回退到直连模式');
    }
}
```

---

### A.2 System 模式注册表→环境变量桥接

**问题描述**（原文 §5.2）：

`system` 模式下 `syncNodeProxyEnv()` 直接 `return`，不注入任何环境变量。

**为什么这是个 bug**：

Windows 用户通过 **设置 → 网络和 Internet → 代理** 配置的系统代理存储在注册表中：
```
HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
  ProxyEnable = 1
  ProxyServer = "127.0.0.1:7890"
```

这些配置**不会自动映射**到 `process.env.HTTP_PROXY`。因此：
- 渲染进程 ✅ Chromium 读取注册表 → 正常走代理
- Node.js ❌ 没有 HTTP_PROXY 环境变量 → **静默直连**

**修正方案**：复用已有的 `getSystemProxyInfo()` 能力，桥接到环境变量。

```javascript
/**
 * ★ 新增方法: 将 OS 系统代理信息同步到 Node.js 环境变量
 * 仅在 mode === 'system' 时调用
 */
_syncSystemProxyToNode() {
    const info = this.getSystemProxyInfo();

    if (!info.enabled) return;

    if (info.server) {
        const proxyUrl = this._parseSystemProxyUrl(info.server);
        if (proxyUrl) {
            process.env.HTTP_PROXY = proxyUrl;
            process.env.HTTPS_PROXY = proxyUrl;
            process.env.ALL_PROXY = proxyUrl;
            process.env.NO_PROXY = BYPASS_DEFAULT;
            console.log(`[ProxyService] 系统代理已同步到 Node.js: ${proxyUrl}`);
        }
    }

    if (info.pacUrl && !info.server) {
        console.warn(
            '[ProxyService] 系统使用 PAC 自动配置(' + info.pacUrl + ')。\n' +
            'Node.js 后端请求将直连。'
        );
    }
}

/**
 * ★ 新增方法: 解析 Windows 注册表中的 ProxyServer 字段
 * 支持格式:
 *   "127.0.0.1:7890"                    → http://127.0.0.1:7890
 *   "socks=127.0.0.1:7891"             → socks5://127.0.0.1:7891
 *   "http=127.0.0.1:7890;https=..."     → 取 http 部分
 */
_parseSystemProxyUrl(proxyServer) {
    if (!proxyServer) return null;

    // 分协议格式: "http=host:port;https=host:port;socks=host:port"
    if (proxyServer.includes(';')) {
        const parts = proxyServer.split(';');
        const httpPart = parts.find(p => p.toLowerCase().startsWith('http='));
        if (httpPart) return 'http://' + httpPart.substring(5);
        return 'http://' + parts[0];
    }

    // SOCKS 格式: "socks=host:port" 或 "socks5=host:port"
    if (proxyServer.toLowerCase().startsWith('socks5=')) {
        return 'socks5://' + proxyServer.substring(7);
    }
    if (proxyServer.toLowerCase().startsWith('socks=')) {
        return 'socks5://' + proxyServer.substring(6);
    }

    // 简单格式: "host:port"
    if (proxyServer.includes(':')) return 'http://' + proxyServer;
    return null;
}
```

---

## §B 中等优先级补充

### B.1 跨平台系统代理检测

**问题描述**：`getSystemProxyInfo()` 仅实现了 Windows 注册表读取。

**补充 macOS 实现**：

```javascript
_getSystemProxyInfo_macOS() {
    try {
        const { execSync } = require('child_process');
        const output = execSync('scutil --proxy', { encoding: 'utf8' });

        const enableMatch = output.match(/ProxyEnable\s*:\s*(\d+)/);
        const enabled = enableMatch?.[1] === '1';
        if (!enabled) return { enabled: false };

        const httpHost = output.match(/HTTPProxy\s*:\s*(.+)/)?.[1]?.trim();
        const httpPort = output.match(/HTTPPort\s*:\s*(\d+)/)?.[1]?.trim();
        const server = (httpHost && httpPort) ? `${httpHost}:${httpPort}` : null;
        const pacEnabled = output.match(/ProxyAutoDiscoveryEnabled\s*:\s*(\d+)/)?.[1] === '1';

        return { enabled: true, server, pacUrl: pacEnabled ? 'auto (WPAD)' : null };
    } catch (err) {
        console.error('[ProxyService] macOS 系统代理检测失败:', err.message);
        return { enabled: false };
    }
}
```

**补充 Linux 实现**：

```javascript
_getSystemProxyInfo_linux() {
    try {
        let enabled = false;
        let server = null;

        // 尝试 GNOME gsettings
        try {
            const mode = execSync(
                'gsettings get org.gnome.system.proxy.mode 2>/dev/null',
                { encoding: 'utf8' }
            ).trim();
            if (mode === "'manual'") {
                enabled = true;
                const host = execSync(
                    'gsettings get org.gnome.system.proxy.http host 2>/dev/null',
                    { encoding: 'utf8' }
                ).trim().replace(/'/g, '');
                const port = execSync(
                    'gsettings get org.gnome.system.proxy.http port 2>/dev/null',
                    { encoding: 'utf8' }
                ).trim();
                server = `${host}:${port}`;
            }
        } catch {
            // 非 GNOME 环境: fallback 到环境变量
            const envProxy = process.env.HTTP_PROXY || process.env.http_proxy;
            if (envProxy) {
                enabled = true;
                server = envProxy.replace(/^https?:\/\//, '');
            }
        }

        return { enabled, server, pacUrl: null };
    } catch (err) {
        console.error('[ProxyService] Linux 系统代理检测失败:', err.message);
        return { enabled: false };
    }
}
```

**统一入口修改**：

```javascript
getSystemProxyInfo() {
    switch (process.platform) {
        case 'win32': return this._getSystemProxyInfo_windows();  // 原有实现
        case 'darwin': return this._getSystemProxyInfo_macOS();    // 新增
        case 'linux':  return this._getSystemProxyInfo_linux();     // 新增
        default:
            const envProxy = process.env.HTTP_PROXY || process.env.http_proxy;
            return {
                enabled: !!envProxy,
                server: envProxy ? envProxy.replace(/^https?:\/\//, '') : null,
                pacUrl: null,
            };
    }
}
```

### B.2 连通性测试端点优化

**问题描述**：原端点 `https://httpbin.org/ip` 在中国大陆不可达或极不稳定。

**修正方案：多端点备选 + 本地回退**

```javascript
const TEST_ENDPOINTS = [
    { url: 'https://api.ipify.org?format=json',       parser: (j) => ({ ip: j.ip }) },
    { url: 'https://ipinfo.io/json',                   parser: (j) => ({ ip: j.ip, geo: j.city + ',' + j.country }) },
    { url: 'https://api.ip.sb/geoip',                  parser: (j) => ({ ip: j.ip, isp: j.isp }) },
    { url: 'https://httpbin.org/ip',                   parser: (j) => ({ ip: j.origin }) },  // 保底
];

const TEST_TIMEOUT = 10000;  // 10 秒超时

async testConnection(customUrl) {
    const endpoints = customUrl
        ? [{ url: customUrl, parser: (j) => ({ ip: j.ip || j.origin || j.query }) }]
        : TEST_ENDPOINTS;

    let lastError = null;
    for (const endpoint of endpoints) {
        try {
            const result = await this._testSingleEndpoint(endpoint);
            if (result.ok) return result;
            lastError = result.error;
        } catch (err) {
            lastError = err.message;
        }
    }

    return {
        ok: false,
        error: lastError || '所有测试端点均不可达',
        hint: '如果使用国内网络，可能是测试服务器被墙而非代理故障。',
        latency: -1,
    };
}

async _testSingleEndpoint(endpoint) {
    const { net } = require('electron');
    return new Promise((resolve) => {
        const start = Date.now();
        const request = net.request(endpoint.url);
        request.on('response', (res) => {
            if (res.statusCode !== 200) {
                resolve({ ok: false, error: `HTTP ${res.statusCode}`, latency: Date.now() - start });
                return;
            }
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    resolve({ ok: true, ...endpoint.parser(data), latency: Date.now() - start, testedEndpoint: endpoint.url });
                } catch {
                    resolve({ ok: true, ip: 'unknown', latency: Date.now() - start });
                }
            });
        });
        request.on('error', (err) => resolve({ ok: false, error: err.message, latency: Date.now() - start }));
        setTimeout(() => { request.abort(); resolve({ ok: false, error: 'timeout', latency: Date.now() - start }); }, TEST_TIMEOUT);
        request.end();
    });
}
```

**UI 展示更新建议**：

```
┌─────────────────────────────────────────────────────┐
│ [✅ 测试连接]                                        │
│ 出口 IP:  203.0.113.42                               │
│ 延迟:      123ms                                     │
│ ISP:      China Telecom                              │
│ 测试端点: api.ipify.org                              │
│                                                     │
│ 💡 如果测试失败但代理实际正常，可能是测试服务器不可达。 │
└─────────────────────────────────────────────────────┘
```

### B.3 代理认证支持设计

**背景**：企业代理和个人代理常需用户名/密码认证。

**Chromium 层限制**：`session.setProxy()` 的 `proxyRules` 参数**不支持内联认证**。
正确做法是通过 `session.setAuthentication()` handler 提供凭据。

#### 接口扩展

```typescript
// ★ 扩展 ManualProxyConfig 接口
interface ManualProxyConfig {
    mode: 'manual';
    protocol: 'http' | 'https' | 'socks4' | 'socks5';
    server: string;
    port: string;
    bypassList?: string;
    // ★ 新增认证字段
    auth?: {
        username: string;
        password: string;  // ⚠️ 见 C.4 安全章节关于加密存储
    };
}
```

#### main.cjs 认证 handler

```javascript
// 在 app.whenReady() 中注册
session.defaultSession.setAuthentication((details, callback) => {
    const config = proxyService.getConfig();
    if (config.mode === 'manual' && config.auth) {
        callback(config.auth.username, config.auth.password);
    } else {
        callback();  // 无认证信息 → 取消
    }
});
```

#### UI 扩展（ProxyTab.tsx）

手动代理模式下增加认证区域：

```
┌─────────────────────────────────────────────────┐
│ 手动代理模式                                      │
│                                                 │
│ 协议: [HTTP ▾]  地址: [127.0.0.1]  端口: [7890] │
│                                                 │
│ □ 需要认证                                       │
│   ┌─ 认证区域（勾选后展开） ─────────────────┐  │
│   │ 用户名: [admin              ]           │  │
│   │ 密码:   [••••••••            ]  👁 显示  │  │
│   └───────────────────────────────────────────┘  │
│                                                 │
│ 绕过: [localhost,127.0.0.1,...         ] [编辑] │
└─────────────────────────────────────────────────┘
```

---

## §C 低优先级增强

### C.1 WebSocket 代理路径

**各层 WS 代理能力矩阵**：

| 组件 | WS/WSS 代理支持 | 说明 |
|------|----------------|------|
| 渲染进程 WebSocket | ✅ | session.setProxy() 对所有网络请求生效 |
| Node.js `ws` 库 | ❌ | **不读取** HTTP_PROXY 环境变量 |
| Node.js `undici` fetch | ✅ | 支持 ProxyAgent |
| Electron `net` 模块 | ✅ | 走 session 代理 |

**解决方案**：

```javascript
// 方案 1: undici ProxyAgent（推荐）
import { ProxyAgent, setGlobalDispatcher } from 'undici';

function setupWsProxy(config) {
    if (config.mode !== 'manual' && config.mode !== 'system') return;
    const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
    if (!proxyUrl) return;
    const agent = new ProxyAgent(proxyUrl);
    setGlobalDispatcher(agent);
}

// 方案 2: ws 库手动指定代理
import { WebSocket } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

function createProxiedWebSocket(url) {
    const proxyUrl = process.env.HTTP_PROXY || process.env.ALL_PROXY;
    if (!proxyUrl) return new WebSocket(url);
    let agent = proxyUrl.startsWith('socks')
        ? new SocksProxyAgent(proxyUrl)
        : new HttpsProxyAgent(proxyUrl);
    return new WebSocket(url, { agent });
}
```

### C.2 错误处理与回滚机制

**错误分类枚举**：

```javascript
const ProxyErrorCode = Object.freeze({
    INVALID_MODE:          'INVALID_MODE',
    INVALID_PROTOCOL:      'INVALID_PROTOCOL',
    INVALID_PORT:          'INVALID_PORT',
    INVALID_SERVER:        'INVALID_SERVER',
    INVALID_PAC_URL:       'INVALID_PAC_URL',
    PAC_UNREACHABLE:       'PAC_UNREACHABLE',
    PROXY_UNREACHABLE:     'PROXY_UNREACHABLE',
    AUTH_FAILED:           'AUTH_FAILED',
    TIMEOUT:               'TIMEOUT',
    REGISTRY_ACCESS_DENIED:'REGISTRY_ACCESS_DENIED',
    STORE_WRITE_FAILED:    'STORE_WRITE_FAILED',
    UNKNOWN:               'UNKNOWN',
});

class ProxyError extends Error {
    constructor(code, message, previousConfig = null) {
        super(message);
        this.name = 'ProxyError';
        this.code = code;
        this.previousConfig = previousConfig;
    }
}
```

**带回滚的 apply 方法**：

```javascript
async apply(config) {
    const validation = this._validateConfig(config);
    if (!validation.valid) throw new ProxyError(validation.code, validation.message);

    const previousConfig = { ...this.config };

    try {
        this.config = config;
        store.set(CONFIG_KEY, config);
        await this._applyChromiumProxy(config);
        this._syncNodeEnv(config);
        return { ok: true };
    } catch (err) {
        console.error('[ProxyService] 应用新配置失败:', err.message);
        console.log('[ProxyService] 回滚到上一份有效配置...');

        try {
            this.config = previousConfig;
            store.set(CONFIG_KEY, previousConfig);
            await this._applyChromiumProxy(previousConfig);
            this._syncNodeEnv(previousConfig);
        } catch (rollbackErr) {
            console.error('[ProxyService] 回滚也失败了!', rollbackErr.message);
            await this._applyChromiumProxy({ mode: 'direct' });
            this._syncNodeEnv({ mode: 'direct' });
        }

        throw new ProxyError(ProxyErrorCode.UNKNOWN,
            `代理配置应用失败，已回滚: ${err.message}`, previousConfig);
    }
}

_validateConfig(config) {
    if (!config || !config.mode)
        return { valid: false, code: ProxyErrorCode.INVALID_MODE, message: '缺少 mode 字段' };

    const validModes = ['system', 'direct', 'manual', 'pac'];
    if (!validModes.includes(config.mode))
        return { valid: false, code: ProxyErrorCode.INVALID_MODE, message: `无效模式: ${config.mode}` };

    if (config.mode === 'manual') {
        if (!config.server)
            return { valid: false, code: ProxyErrorCode.INVALID_SERVER, message: 'server 不能为空' };
        const port = parseInt(config.port, 10);
        if (isNaN(port) || port < 1 || port > 65535)
            return { valid: false, code: ProxyErrorCode.INVALID_PORT, message: `无效端口: ${config.port}` };
        const validProtos = ['http', 'https', 'socks4', 'socks5'];
        if (!validProtos.includes(config.protocol))
            return { valid: false, code: ProxyErrorCode.INVALID_PROTOCOL, message: `无效协议: ${config.protocol}` };
    }

    if (config.mode === 'pac') {
        if (!config.pacUrl || !(config.pacUrl.startsWith('http://') || config.pacUrl.startsWith('https://')))
            return { valid: false, code: ProxyErrorCode.INVALID_PAC_URL, message: 'PAC URL 必须以 http(s) 开头' };
        try { new URL(config.pacUrl); }
        catch { return { valid: false, code: ProxyErrorCode.INVALID_PAC_URL, message: 'PAC URL 格式非法' }; }
    }

    return { valid: true };
}
```

### C.3 版本兼容性声明

**新增章节（放在原文 § 一之后）**：

```markdown
## 零、前提条件与版本兼容性

### 运行时要求

| 组件 | 最低版本 | 推荐版本 | 说明 |
|------|---------|---------|------|
| Node.js | >= 18.0.0 | >= 20.0.0 | 需要 AbortSignal.timeout() (Node 18+) |
| Electron | >= 20.0.0 | >= 28.0.0 | session.setProxy({mode}) 需要 Electron 8+，推荐 20+ |
| 操作系统 | Windows 10+, macOS 12+, Ubuntu 20.04+ | 最新稳定版 | 各平台功能覆盖度不同 |

### API 兼容性备注

| API | 引入版本 | 替代方案（旧版本）|
|-----|---------|------------------|
| session.setProxy({mode}) | Electron 8 | 旧版: session.setProxy(proxyRules字符串) |
| AbortSignal.timeout(ms) | Node 18.0 | 旧版: setTimeout + request.abort() |
| net.request() (主进程) | Electron 1.0 | 无替代 |

### 平台功能矩阵

| 功能 | Windows | macOS | Linux |
|------|---------|-------|-------|
| 系统代理自动检测 | ✅ 完整 | ✅ 完整 | ⚠️ 仅 GNOME |
| PAC/WPAD 检测 | ✅ | ✅ | ⚠️ 有限 |
```

### C.4 安全性考量

#### C.4.1 敏感数据存储

代理密码等敏感信息的存储方案：

| 方案 | 复杂度 | 效果 | 推荐阶段 |
|------|--------|------|----------|
| **OS Keychain (keytar)** | 高 | 最佳 | 生产版 |
| **AES-256-GCM 加密** | 中 | 良好 | Beta 版 |
| **明文 + 文件权限限制** | 低 | 基础 | MVP |

**加密存储示例**：

```javascript
const crypto = require('crypto');

const ENCRYPTION_KEY = process.env.SOLOFORGE_MASTER_KEY ||
    'default-change-in-production!!!';  // ⚠️ 生产环境必须更换

function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm',
        Buffer.from(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32)), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return iv.toString('hex') + ':' + tag + ':' + encrypted;
}

function decrypt(encryptedText) {
    const [ivHex, tagHex, encrypted] = encryptedText.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm',
        Buffer.from(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32)),
        Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
}
```

#### C.4.2 PAC URL 安全校验

```javascript
function validatePacUrl(url) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new ProxyError(ProxyErrorCode.INVALID_PAC_URL, 'PAC URL 必须使用 http 或 https 协议');
    }
    return true;
}
```

#### C.4.3 IPC 权限最小化

```javascript
// preload.cjs — 不暴露密码明文给渲染进程
proxy: {
    getConfig: () => ipcRenderer.invoke('proxy:get-config'),
    apply: (c) => ipcRenderer.invoke('proxy:apply', c),
    testConnection: () => ipcRenderer.invoke('proxy:test'),
    getSystemInfo: () => ipcRenderer.invoke('proxy:system-info'),
},

// main.cjs — 脱敏处理
ipcMain.handle('proxy:get-config', () => {
    const config = proxyService.getConfig();
    if (config.auth?.password) {
        return { ...config, auth: { ...config.auth, password: '***' } };
    }
    return config;
});
```

#### C.4.4 日志安全

```javascript
// ⚠️ 切勿在日志中输出包含密码的完整配置
function safeLogConfig(config) {
    const safe = { ...config };
    if (safe.auth?.password) safe.auth.password = '***';
    console.log(`[Proxy] 应用配置: ${JSON.stringify(safe)}`);
}
```

---

## §D 完整修正版伪代码

以下为整合了所有修正后的 `proxy-service.cjs` 完整版本，可直接替换原文 §10.1：

```javascript
// ============================================================
//  UI/electron/proxy-service.cjs  —  v2.1 完整修正版
//  修正内容:
//    [A.1] PAC 模式 Node.js 同步
//    [A.2] System 模式注册表→环境变量桥接
//    [B.1] 跨平台系统代理检测 (macOS/Linux)
//    [B.2] 多端点连通性测试
//    [B.3] 代理认证接口预留
//    [C.1] WebSocket 代理提示
//    [C.2] 错误处理 + 回滚
//    [C.3] 输入校验
// ============================================================

const { session, net } = require('electron');
const Store = require('electron-store');
const { execSync } = require('child_process');

const store = new Store();
const CONFIG_KEY = 'proxy.config';
const BYPASS_DEFAULT = 'localhost,127.0.0.1,::1,*.local,<local>';

// ---- 错误码定义 ----
const ProxyErrorCode = Object.freeze({
    INVALID_MODE:          'INVALID_MODE',
    INVALID_PROTOCOL:      'INVALID_PROTOCOL',
    INVALID_PORT:          'INVALID_PORT',
    INVALID_SERVER:        'INVALID_SERVER',
    INVALID_PAC_URL:       'INVALID_PAC_URL',
    PAC_UNREACHABLE:       'PAC_UNREACHABLE',
    PROXY_UNREACHABLE:     'PROXY_UNREACHABLE',
    AUTH_FAILED:           'AUTH_FAILED',
    TIMEOUT:               'TIMEOUT',
    REGISTRY_ACCESS_DENIED:'REGISTRY_ACCESS_DENIED',
    STORE_WRITE_FAILED:    'STORE_WRITE_FAILED',
    UNKNOWN:               'UNKNOWN',
});

class ProxyError extends Error {
    constructor(code, message, previousConfig = null) {
        super(message);
        this.name = 'ProxyError';
        this.code = code;
        this.previousConfig = previousConfig;
    }
}

// ---- 测试端点配置 ----
const TEST_ENDPOINTS = [
    { url: 'https://api.ipify.org?format=json', parser: (j) => ({ ip: j.ip }) },
    { url: 'https://ipinfo.io/json',           parser: (j) => ({ ip: j.ip, geo: j.city + ',' + j.country }) },
    { url: 'https://api.ip.sb/geoip',          parser: (j) => ({ ip: j.ip, isp: j.isp }) },
    { url: 'https://httpbin.org/ip',           parser: (j) => ({ ip: j.origin }) },
];
const TEST_TIMEOUT = 10000;

// ============================================================
//  ProxyService 主类
// ============================================================
class ProxyService {
    constructor() {
        this.config = store.get(CONFIG_KEY, { mode: 'system' });
    }

    getConfig() {
        const cfg = { ...this.config };
        if (cfg.auth?.password && cfg.auth.password !== '***') {
            cfg.auth = { ...cfg.auth, password: '***' };
        }
        return cfg;
    }

    async apply(config) {
        const validation = this._validateConfig(config);
        if (!validation.valid) throw new ProxyError(validation.code, validation.message);

        const previousConfig = { ...this.config };

        try {
            this.config = config;
            store.set(CONFIG_KEY, config);
            await this._applyChromiumProxy(config);
            this._syncNodeEnv(config);
            this._safeLog(`配置已应用: mode=${config.mode}`);
            return { ok: true };
        } catch (err) {
            this._safeLog(`配置应用失败: ${err.message}，正在回滚...`);
            try {
                this.config = previousConfig;
                store.set(CONFIG_KEY, previousConfig);
                await this._applyChromiumProxy(previousConfig);
                this._syncNodeEnv(previousConfig);
                this._safeLog('回滚成功');
            } catch (rollbackErr) {
                this._safeLog(`回滚失败! ${rollbackErr.message}，强制直连`);
                await this._applyChromiumProxy({ mode: 'direct' });
                this._syncNodeEnv({ mode: 'direct' });
                this.config = { mode: 'direct' };
            }
            throw new ProxyError(ProxyErrorCode.UNKNOWN,
                `代理配置失败，已回滚: ${err.message}`, previousConfig);
        }
    }

    // ---- Chromium 层代理设置 ----
    async _applyChromiumProxy(config) {
        const ses = session.defaultSession;
        switch (config.mode) {
            case 'system': await ses.setProxy({ mode: 'system' }); break;
            case 'direct': await ses.setProxy({ mode: 'direct' }); break;
            case 'manual': {
                const rules = this._buildProxyRules(config);
                const bypass = config.bypassList || BYPASS_DEFAULT;
                await ses.setProxy({ mode: 'fixed_servers', proxyRules: rules, proxyBypassList: bypass });
                break;
            }
            case 'pac':
                await ses.setProxy({ mode: 'pac_script', pacScript: config.pacUrl });
                break;
            default:
                throw new ProxyError(ProxyErrorCode.INVALID_MODE, `未知代理模式: ${config.mode}`);
        }
    }

    // ---- Node.js 层环境变量同步（★ 完整修正版）----
    _syncNodeEnv(config) {
        for (const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY',
                            'http_proxy','https_proxy','all_proxy','no_proxy']) {
            delete process.env[key];
        }

        switch (config.mode) {
            case 'direct': break;
            case 'system':
                this._syncSystemProxyToNode();  // ★ 不再直接 return
                break;
            case 'manual': {
                const url = this._buildProxyUrl(config);
                process.env.HTTP_PROXY = url;
                process.env.HTTPS_PROXY = url;
                process.env.ALL_PROXY = url;
                process.env.NO_PROXY = config.bypassList || BYPASS_DEFAULT;
                break;
            }
            case 'pac':
                console.warn(
                    '[ProxyService] ⚠️  PAC 模式仅对渲染进程(Chromium)生效。\n' +
                    '  Node.js 后端请求将直连。\n' +
                    '  如需全链路 PAC 支持，请安装: npm install pac-proxy-agent'
                );
                break;
        }
    }

    // ---- ★ 系统代理 → Node.js 环境变量桥接 ----
    _syncSystemProxyToNode() {
        const info = this.getSystemProxyInfo();
        if (!info.enabled) return;
        if (info.server) {
            const proxyUrl = this._parseSystemProxyUrl(info.server);
            if (proxyUrl) {
                process.env.HTTP_PROXY = proxyUrl;
                process.env.HTTPS_PROXY = proxyUrl;
                process.env.ALL_PROXY = proxyUrl;
                process.env.NO_PROXY = BYPASS_DEFAULT;
                this._safeLog(`系统代理已同步到 Node.js: ${proxyUrl}`);
            }
        }
        if (info.pacUrl && !info.server) {
            console.warn(`[ProxyService] 系统使用 PAC (${info.pacUrl})。Node.js 后端将直连。`);
        }
    }

    // ---- ★ 解析 OS 代理地址字符串 ----
    _parseSystemProxyUrl(proxyServer) {
        if (!proxyServer) return null;
        if (proxyServer.includes(';')) {
            const parts = proxyServer.split(';');
            const httpPart = parts.find(p => p.toLowerCase().startsWith('http='));
            if (httpPart) return 'http://' + httpPart.substring(5);
            return 'http://' + parts[0];
        }
        if (proxyServer.toLowerCase().startsWith('socks5=')) return 'socks5://' + proxyServer.substring(7);
        if (proxyServer.toLowerCase().startsWith('socks=')) return 'socks5://' + proxyServer.substring(6);
        if (proxyServer.includes(':')) return 'http://' + proxyServer;
        return null;
    }

    _buildProxyRules(config) {
        const { protocol, server, port } = config;
        if (protocol === 'socks4' || protocol === 'socks5') return `${protocol}://${server}:${port}`;
        return `http=${server}:${port};https=${server}:${port}`;
    }

    _buildProxyUrl(config) {
        const { protocol, server, port } = config;
        if (protocol === 'socks5') return `socks5://${server}:${port}`;
        if (protocol === 'socks4') return `socks4://${server}:${port}`;
        return `http://${server}:${port}`;
    }

    // ---- 系统代理信息检测（★ 跨平台完整版）----
    getSystemProxyInfo() {
        switch (process.platform) {
            case 'win32': return this._getSystemProxyInfo_windows();
            case 'darwin': return this._getSystemProxyInfo_macOS();
            case 'linux':  return this._getSystemProxyInfo_linux();
            default:      return this._getSystemProxyInfo_fallback();
        }
    }

    _getSystemProxyInfo_windows() {
        try {
            const enableResult = execSync(
                'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
                { encoding: 'utf8' }
            );
            const enabled = enableResult.includes('0x1');
            if (!enabled) return { enabled: false };
            const serverResult = execSync(
                'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
                { encoding: 'utf8' }
            );
            const proxyServer = serverResult.match(/ProxyServer\s+REG_SZ\s+(.+)/)?.[1]?.trim();
            let pacUrl = null;
            try {
                const pacResult = execSync(
                    'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v AutoConfigURL',
                    { encoding: 'utf8' }
                );
                pacUrl = pacResult.match(/AutoConfigURL\s+REG_SZ\s+(.+)/)?.[1]?.trim();
            } catch {}
            return { enabled: true, server: proxyServer, pacUrl };
        } catch { return { enabled: false }; }
    }

    _getSystemProxyInfo_macOS() {
        try {
            const output = execSync('scutil --proxy', { encoding: 'utf8' });
            const enableMatch = output.match(/ProxyEnable\s*:\s*(\d+)/);
            const enabled = enableMatch?.[1] === '1';
            if (!enabled) return { enabled: false };
            const httpHost = output.match(/HTTPProxy\s*:\s*(.+)/)?.[1]?.trim();
            const httpPort = output.match(/HTTPPort\s*:\s*(\d+)/)?.[1]?.trim();
            const server = (httpHost && httpPort) ? `${httpHost}:${httpPort}` : null;
            const pacEnabled = output.match(/ProxyAutoDiscoveryEnabled\s*:\s*(\d+)/)?.[1] === '1';
            return { enabled: true, server, pacUrl: pacEnabled ? 'auto (WPAD)' : null };
        } catch (err) {
            this._safeLog(`macOS 代理检测失败: ${err.message}`);
            return { enabled: false };
        }
    }

    _getSystemProxyInfo_linux() {
        try {
            let enabled = false, server = null;
            try {
                const mode = execSync('gsettings get org.gnome.system.proxy.mode 2>/dev/null', { encoding: 'utf8' }).trim();
                if (mode === "'manual'") {
                    enabled = true;
                    const host = execSync('gsettings get org.gnome.system.proxy.http host 2>/dev/null', { encoding: 'utf8' }).trim().replace(/'/g, '');
                    const port = execSync('gsettings get org.gnome.system.proxy.http port 2>/dev/null', { encoding: 'utf8' }).trim();
                    server = `${host}:${port}`;
                }
            } catch {
                const envProxy = process.env.HTTP_PROXY || process.env.http_proxy;
                if (envProxy) { enabled = true; server = envProxy.replace(/^https?:\/\//, ''); }
            }
            return { enabled, server, pacUrl: null };
        } catch (err) {
            this._safeLog(`Linux 代理检测失败: ${err.message}`);
            return { enabled: false };
        }
    }

    _getSystemProxyInfo_fallback() {
        const envProxy = process.env.HTTP_PROXY || process.env.http_proxy;
        return { enabled: !!envProxy, server: envProxy ? envProxy.replace(/^https?:\/\//, '') : null, pacUrl: null };
    }

    // ---- 连通性测试（★ 多端点版）----
    async testConnection(customUrl) {
        const endpoints = customUrl
            ? [{ url: customUrl, parser: (j) => ({ ip: j.ip || j.origin || j.query }) }]
            : TEST_ENDPOINTS;
        let lastError = null;
        for (const endpoint of endpoints) {
            try {
                const result = await this._testSingleEndpoint(endpoint);
                if (result.ok) return result;
                lastError = result.error;
            } catch (err) { lastError = err.message; }
        }
        return { ok: false, error: lastError || '所有测试端点均不可达', hint: '如果使用国内网络，可能是测试服务器被墙而非代理故障。', latency: -1 };
    }

    _testSingleEndpoint(endpoint) {
        return new Promise((resolve) => {
            const start = Date.now();
            const req = net.request(endpoint.url);
            req.on('response', (res) => {
                if (res.statusCode !== 200) { resolve({ ok: false, error: `HTTP ${res.statusCode}`, latency: Date.now() - start }); return; }
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    try { const d = JSON.parse(body); resolve({ ok: true, ...endpoint.parser(d), latency: Date.now() - start, testedEndpoint: endpoint.url }); }
                    catch { resolve({ ok: true, ip: 'unknown', latency: Date.now() - start }); }
                });
            });
            req.on('error', (err) => resolve({ ok: false, error: err.message, latency: Date.now() - start }));
            setTimeout(() => { req.abort(); resolve({ ok: false, error: 'timeout', latency: Date.now() - start }); }, TEST_TIMEOUT);
            req.end();
        });
    }

    // ---- 输入校验 ----
    _validateConfig(config) {
        if (!config || !config.mode) return { valid: false, code: ProxyErrorCode.INVALID_MODE, message: '缺少 mode 字段' };
        const validModes = ['system', 'direct', 'manual', 'pac'];
        if (!validModes.includes(config.mode))
            return { valid: false, code: ProxyErrorCode.INVALID_MODE, message: `无效模式: ${config.mode}` };
        if (config.mode === 'manual') {
            if (!config.server) return { valid: false, code: ProxyErrorCode.INVALID_SERVER, message: 'server 不能为空' };
            const port = parseInt(config.port, 10);
            if (isNaN(port) || port < 1 || port > 65535)
                return { valid: false, code: ProxyErrorCode.INVALID_PORT, message: `无效端口: ${config.port}` };
            if (!['http','https','socks4','socks5'].includes(config.protocol))
                return { valid: false, code: ProxyErrorCode.INVALID_PROTOCOL, message: `无效协议: ${config.protocol}` };
        }
        if (config.mode === 'pac') {
            if (!config.pacUrl || !/^https?:\/\//.test(config.pacUrl))
                return { valid: false, code: ProxyErrorCode.INVALID_PAC_URL, message: 'PAC URL 必须以 http(s) 开头' };
            try { new URL(config.pacUrl); }
            catch { return { valid: false, code: ProxyErrorCode.INVALID_PAC_URL, message: 'PAC URL 格式非法' }; }
        }
        return { valid: true };
    }

    _safeLog(msg) {
        if (/password|secret/i.test(msg)) { console.log('[ProxyService] [日志包含敏感信息，已隐藏]'); return; }
        console.log(`[ProxyService] ${msg}`);
    }
}

module.exports = { ProxyService, ProxyErrorCode, ProxyError };
```

---

## 附录：修正对照速查表

| # | 问题 | 原文状态 | 修正位置 | 修正类型 |
|---|------|---------|---------|----------|
| A.1 | PAC 模式 Node.js 不同步 | §5.2 缺失 | §A.1 + §D | 伪代码补全 |
| A.2 | System 模式不注入环境变量 | §5.2 直接 return | §A.2 + §D | 新增方法 + 伪代码 |
| B.1 | 仅 Windows 注册表检测 | §10.1 | §B.1 + §D | 新增 macOS/Linux |
| B.2 | httpbin.org 国内不可达 | §6.1 | §B.2 + §D | 多端点备选 |
| B.3 | 无代理认证设计 | 全文缺失 | §B.3 | 接口 + handler + UI |
| C.1 | WebSocket 代理未讨论 | 全文缺失 | §C.1 | 分析 + 方案 |
| C.2 | 无错误分类和回滚 | §10.1 | §C.2 + §D | 枚举 + rollback |
| C.3 | 版本兼容性未声明 | 全文缺失 | §C.3 | 新增章节 |
| C.4 | 安全性无考量 | 全文缺失 | §C.4 | 4 小节完整安全设计 |

---

> **文档结束** — 本补充说明应与 `proxy-implementation-guide.md` (v2) 合并使用。
> 下一步建议: 按 §D 中的完整伪代码替换原文 §10.1，并将 §A~§C 的新增章节追加到对应位置。
