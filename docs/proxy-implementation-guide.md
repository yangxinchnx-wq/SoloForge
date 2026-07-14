# SoloForge 网络代理功能 — 完整设计方案 (v2)

> 基于 Electron 官方 API、VS Code / Slack / Chromium 代理机制的深度调研重新设计

---

## 一、核心技术选型

### 1.1 Electron 代理三层架构

Chromium 网络栈的代理解析链路（优先级从高到低）：

```
① PAC 脚本 (pacScript)         → 自动代理配置，企业网络常用
② 固定代理规则 (proxyRules)    → 手动指定代理服务器
③ 系统代理 (system)            → 读取 OS 代理设置（含 WPAD 自动发现）
④ 直连 (direct)                → 不使用代理
```

**关键发现**：Electron `session.setProxy()` 的 `mode` 参数已原生支持四种模式：

```typescript
// Electron 官方 API (v20+)
session.defaultSession.setProxy({
  mode: 'direct' | 'system' | 'fixed_servers' | 'pac_script',
  proxyRules?: string,      // fixed_servers 模式下的代理规则
  pacScript?: string,       // pac_script 模式下的 PAC URL
  proxyBypassList?: string   // 绕过代理的地址列表
});
```

### 1.2 与 VS Code 方案对齐

VS Code 的代理设置体系（业界标杆）：

| VS Code 设置 | 对应 SoloForge 模式 |
|---|---|
| `http.proxy` | 手动代理地址 |
| `http.proxySupport` = `"on"` / `"off"` / `"override"` / `"fallback"` | 代理支持策略 |
| `http.proxyStrictSSL` | 是否严格校验代理 SSL |
| 无显式代理 = 系统代理 | `system` 模式 |

### 1.3 SoloForge 特殊需求

SoloForge 有**两层网络请求**需要代理：

```
┌─────────────────────────────────────────────────────┐
│  层 1: Electron 渲染进程 (React UI)                 │
│    fetch() / XMLHttpRequest / WebSocket              │
│    → session.setProxy() 覆盖                        │
├─────────────────────────────────────────────────────┤
│  层 2: Node.js 后端 (main.cjs / server.ts)          │
│    fetch() / http.request() / undici                 │
│    → 需要额外处理（Node.js 不走 session.setProxy）  │
├─────────────────────────────────────────────────────┤
│  层 3: 子进程 (Java Agent, SurrealDB, Garnet)       │
│    → 通过环境变量 HTTP_PROXY / HTTPS_PROXY 传递     │
└─────────────────────────────────────────────────────┘
```

---

## 二、四模式设计（对标 Chromium）

### 2.1 模式定义

| 模式 ID | 显示名称 | Chromium mode | 说明 |
|---|---|---|---|
| `system` | 系统代理 | `system` | 读取 OS 代理设置，含 WPAD/PAC 自动发现 |
| `direct` | 直连模式 | `direct` | 不使用代理，所有请求直连 |
| `manual` | 手动代理 | `fixed_servers` | 用户手动配置代理服务器 |
| `pac` | 自动配置 (PAC) | `pac_script` | 通过 PAC URL 自动决定代理规则 |

### 2.2 各模式详细参数

#### 模式 1: 系统代理 (`system`) — **默认模式**

```typescript
interface SystemProxyConfig {
  mode: 'system';
}
```

实现：
```javascript
await session.defaultSession.setProxy({ mode: 'system' });
```

工作原理：
- Windows: 读取注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
  - `ProxyEnable` = 1 → 使用 `ProxyServer` 地址
  - `AutoConfigURL` 存在 → 使用 PAC 脚本
  - 均未设置 → WPAD 自动发现 (DHCP/DNS)
- macOS: 读取系统偏好设置 → 网络 → 代理
- Linux: 读取 `gsettings` / 环境变量

**这是 VS Code、Slack、Discord 等主流 Electron 应用的默认行为。**

#### 模式 2: 直连 (`direct`)

```typescript
interface DirectProxyConfig {
  mode: 'direct';
}
```

实现：
```javascript
await session.defaultSession.setProxy({ mode: 'direct' });
```

适用场景：
- 已有全局 VPN/加速器
- 本地开发调试
- 网络环境不需要代理

#### 模式 3: 手动代理 (`manual`)

```typescript
interface ManualProxyConfig {
  mode: 'manual';
  protocol: 'http' | 'https' | 'socks4' | 'socks5';
  server: string;        // 如 "127.0.0.1"
  port: string;          // 如 "7890"
  bypassList: string[];  // 绕过代理的地址列表
  // 可选: 分协议代理
  httpProxy?: string;    // HTTP 专用代理
  httpsProxy?: string;   // HTTPS 专用代理
  ftpProxy?: string;     // FTP 专用代理
}
```

proxyRules 格式（遵循 Chromium 规范）：
```
// 单一代理所有协议
http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7891

// 简写（所有协议走同一代理）
127.0.0.1:7890

// SOCKS5
socks5://127.0.0.1:7890

// 带 fallback
http=127.0.0.1:7890,direct://
```

默认 bypassList：
```
localhost,127.0.0.1,::1,*.local,<local>
```

#### 模式 4: PAC 自动配置 (`pac`)

```typescript
interface PacProxyConfig {
  mode: 'pac';
  pacUrl: string;  // PAC 脚本 URL，如 "http://proxy.company.com/proxy.pac"
}
```

实现：
```javascript
await session.defaultSession.setProxy({
  mode: 'pac_script',
  pacScript: 'http://proxy.company.com/proxy.pac'
});
```

适用场景：
- 企业网络统一代理策略
- 复杂的代理路由规则（按域名/IP 段分流）

---

## 三、架构设计

### 3.1 整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                        渲染进程 (React UI)                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  ProxyTab.tsx — 四模式切换 UI                          │  │
│  │    ↓ 读写配置                                          │  │
│  │  SettingsStore (settingsStorage.cjs)                    │  │
│  └────────────────────────────────────────────────────────┘  │
│                          ↓ IPC (soloforge.proxy.*)           │
├──────────────────────────────────────────────────────────────┤
│                        主进程 (main.cjs)                      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  ProxyService (单例)                                   │  │
│  │    ├── apply(config) → session.setProxy()              │  │
│  │    ├── readSystemProxy() → 检测 OS 代理               │  │
│  │    ├── testConnection(url) → 代理连通性测试           │  │
│  │    └── buildProxyRules(config) → 生成 Chromium 规则   │  │
│  └────────────────────────────────────────────────────────┘  │
│              ↓                          ↓                    │
│  ┌──────────────────┐    ┌──────────────────────────────┐   │
│  │ session.setProxy │    │ process.env.HTTP_PROXY 等    │   │
│  │ (渲染进程网络)   │    │ (Node.js 子进程网络)         │   │
│  └──────────────────┘    └──────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 数据流

```
┌─────────────┐    ┌─────────────┐    ┌──────────────┐    ┌─────────────────┐
│  用户操作   │───→│ ProxyTab UI │───→│ IPC invoke   │───→│ ProxyService    │
│  切换模式   │    │ 更新状态    │    │ proxy:apply  │    │ .apply(config)  │
└─────────────┘    └─────────────┘    └──────────────┘    └────────┬────────┘
                                                                   │
                          ┌────────────────────────────────────────┤
                          ↓                                        ↓
                 ┌─────────────────┐                   ┌─────────────────────┐
                 │ session.setProxy│                   │ process.env.*_PROXY │
                 │ (Chromium 层)   │                   │ (Node.js 层)        │
                 └─────────────────┘                   └─────────────────────┘
                          ↓                                        ↓
                 ┌─────────────────┐                   ┌─────────────────────┐
                 │ 渲染进程 fetch  │                   │ 后端 API 请求       │
                 │ WebSocket 等    │                   │ LLM 流式请求等      │
                 └─────────────────┘                   └─────────────────────┘
```

### 3.3 启动时序

```
app 启动
  │
  ├─ 1. 读取持久化配置 (settingsStorage.cjs)
  │     → 如果上次是 manual/pac 模式，立即设置环境变量
  │
  ├─ 2. app.whenReady()
  │     → session.defaultSession.setProxy(config)
  │     → 渲染进程网络请求自动走代理
  │
  ├─ 3. 创建 BrowserWindow
  │     → 前端 ProxyTab 从 IPC 读取当前配置并展示
  │
  └─ 4. 用户修改设置
        → IPC → ProxyService.apply() → 立即生效
        → 同时更新 process.env (Node.js 层)
```

---

## 四、ProxyBypass 设计（关键细节）

### 4.1 默认绕过列表

SoloForge 有大量本地服务，必须默认绕过代理：

```
localhost, 127.0.0.1, ::1, *.local, <local>
```

### 4.2 SoloForge 专用绕过

> 基于代码审查报告 Table 3 的完整代理链路扫描，确保所有内部服务端口均已覆盖。

```javascript
const SOLOFORGE_BYPASS = [
  // 通用本地绕过
  'localhost',
  '127.0.0.1',
  '::1',
  '*.local',
  '<local>',           // Chromium 内置: 所有不含 "." 的主机名
  // SoloForge 内部服务 (完整端口清单)
  'localhost:3000',    // UI Server (Express 前端)
  'localhost:3001',    // RACER Core / Node.js 后端
  'localhost:3002',    // git-service (Go)
  'localhost:6379',    // Garnet (Redis 兼容缓存)
  'localhost:8400',    // SurrealDB (图数据库)
  'localhost:8765',    // MARL (预留: 外部独立进程，非 main.cjs 启动)
  'localhost:8766',    // MARL Reputation HTTP (预留: 外部独立进程)
  'localhost:8770',    // Java Agent (Spring AI)
].join(',');
```

> **⚠️ 关键**：若遗漏任何内部服务端口，手动代理模式下 Express 反向代理请求
> 会经过代理服务器 → 无法到达本地服务 → 请求死循环或超时。
> 未来新增内部服务时，必须同步更新此列表。

### 4.3 用户可扩展

允许用户在 UI 中追加自定义绕过规则（如内网地址）。

---

## 五、Node.js 层代理同步（关键差异）

### 5.1 问题

`session.setProxy()` 只影响 Chromium 网络栈（渲染进程的 fetch、WebSocket）。
Node.js 主进程的 `fetch()` / `http.request()` **不经过 Chromium**，需要单独处理。

### 5.2 方案：环境变量注入

在 `ProxyService.apply()` 中同步设置环境变量：

```javascript
function syncNodeProxyEnv(config) {
  // 清除旧的代理环境变量
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.ALL_PROXY;
  delete process.env.NO_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  delete process.env.all_proxy;
  delete process.env.no_proxy;

  if (config.mode === 'direct') return;

  if (config.mode === 'system') {
    // 读取系统环境变量（已有的不需要覆盖）
    return;
  }

  if (config.mode === 'manual') {
    const proxyUrl = buildProxyUrl(config);
    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.ALL_PROXY = proxyUrl;
    process.env.NO_PROXY = SOLOFORGE_BYPASS;
  }
}
```

### 5.3 子进程代理传递

Java Agent、SurrealDB 等子进程通过 `spawn()` 的 `env` 选项继承环境变量：

```javascript
spawn('java', ['-jar', 'agent.jar'], {
  env: { ...process.env }  // 自动继承 HTTP_PROXY 等
});
```

> **⚠️ 时效性警告**：`process.env.HTTP_PROXY` 变更**仅对变更后新 spawn 的子进程生效**。
> 已运行的子进程（如 Java Agent）持有启动时的环境变量副本，不会感知后续变更。
> 
> **应对策略**：
> - 若用户在运行中切换代理模式，需提示"已运行的服务需重启才能生效"
> - 或在 `ProxyService.apply()` 中记录"需重启的服务列表"，UI 展示提醒

---

## 六、代理连通性测试

### 6.1 测试端点

> **⚠️ 国内网络风险**：`httpbin.org` 在国内可能超时或被墙，需增加备选端点。

```javascript
// 测试端点优先级列表（国内可用性排序）
const TEST_ENDPOINTS = [
  { url: 'https://httpbin.org/ip',   extract: (d) => d.origin },
  { url: 'https://api.ipify.org?format=json', extract: (d) => d.ip },
  { url: 'https://ipinfo.io/json',  extract: (d) => d.ip },
];

async function testProxyConnection() {
  for (const endpoint of TEST_ENDPOINTS) {
    try {
      const res = await fetch(endpoint.url, {
        signal: AbortSignal.timeout(8000)
      });
      const data = await res.json();
      return { ok: true, ip: endpoint.extract(data) };
    } catch {
      continue;  // 超时或失败，尝试下一个
    }
  }
  return { ok: false, error: '所有测试端点均不可达' };
}
```

### 6.2 UI 展示

在 ProxyTab 底部添加"测试连接"按钮，点击后显示：
- 当前出口 IP
- 连接延迟
- 是否通过代理

---

## 七、文件修改清单

### 7.1 新建文件

| 文件 | 说明 |
|---|---|
| `UI/electron/proxy-service.cjs` | ProxyService 单例，核心代理管理逻辑 |

### 7.2 修改文件

| 文件 | 修改内容 | 备注 |
|---|---|---|
| `UI/electron/main.cjs` | 初始化 ProxyService，注册 IPC handler | — |
| `UI/electron/preload.cjs` | 暴露 `soloforge.proxy.*` API | — |
| `UI/src/components/settingsTabs/ProxyTab.tsx` | **全新重写**（当前为纯 UI 壳，无 IPC/无持久化/无测试） | 严格类型，禁止新增 `any` |
| `UI/package.json` | 无新增依赖 | **复用现有 `settingsStorage.cjs`，零依赖** |

### 7.3 顺手修复（代码审查报告建议）

| 文件 | 修改内容 | 成本 |
|---|---|---|
| `.env` / `src/security/auth.ts` | CORS 白名单补全：追加 `http://localhost:3000` | 5 分钟 |

> **⚠️ 注意**：CORS 白名单修复前需确认 `auth.ts` 的确切位置和配置格式。
> 本轮可行性审计未深入验证该文件，实施前需先定位 `auth.ts` 中的 CORS 配置代码。

> **CORS 问题说明**（来自代码审查报告）：
> 后端 `auth.ts` 仅允许 `localhost:5173/5174`（Vite 默认端口），
> 当前自定义 Server 模式端口 3000 不在白名单中。
> 生产模式走服务端代理（同源请求）不触发 CORS，但开发调试时可能踩坑。
> 修复：在 `.env` 中设置 `SOLOFORGE_CORS_ORIGINS=http://localhost:3000,http://localhost:5173,http://localhost:5174`

---

## 八、API 设计

### 8.1 IPC 接口

| IPC Channel | 方向 | 参数 | 返回值 |
|---|---|---|---|
| `proxy:get-config` | render → main | 无 | `ProxyConfig` |
| `proxy:apply` | render → main | `ProxyConfig` | `{ ok: boolean }` |
| `proxy:test` | render → main | 无 | `{ ok, ip?, latency?, error? }` |
| `proxy:system-info` | render → main | 无 | `{ enabled, server?, port?, pacUrl? }` |

### 8.2 ProxyConfig 类型

```typescript
type ProxyConfig =
  | { mode: 'system' }
  | { mode: 'direct' }
  | { mode: 'manual'; protocol: string; server: string; port: string; bypassList?: string }
  | { mode: 'pac'; pacUrl: string };
```

### 8.3 preload.cjs 暴露

```javascript
// 已有 soloforge 命名空间下新增
proxy: {
  getConfig:     ()  => ipcRenderer.invoke('proxy:get-config'),
  apply:         (c) => ipcRenderer.invoke('proxy:apply', c),
  testConnection:()  => ipcRenderer.invoke('proxy:test'),
  getSystemInfo: ()  => ipcRenderer.invoke('proxy:system-info'),
}
```

---

## 九、ProxyTab UI 设计

> **⚠️ 工作量评估**：当前 `ProxyTab.tsx` 为纯 UI 壳（仅 `useState` 管理本地状态），
> 无 IPC 通信、无配置持久化、无连通性测试。本次为**全新重写**，非升级改造。

### 9.1 布局

```
┌─────────────────────────────────────────────────────────┐
│  网络与代理配置                                          │
│  配置应用程序的网络代理设置，影响所有网络请求            │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ 系统代理 │ │ 直连模式 │ │ 手动代理 │ │ PAC 自动 │  │
│  │ (默认)   │ │          │ │          │ │ 配置     │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
│                                                         │
│  ── 模式详情区域 (根据选择动态切换) ──                  │
│                                                         │
│  [系统代理模式]                                          │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 系统代理状态: 已启用                             │   │
│  │ 代理地址: 127.0.0.1:7890                        │   │
│  │ 来源: Windows Internet Settings                 │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  [手动代理模式]                                          │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 协议: [HTTP ▾] [HTTPS] [SOCKS5]                │   │
│  │ 地址: [127.0.0.1        ]                       │   │
│  │ 端口: [7890              ]                       │   │
│  │ 绕过: [localhost,127.0.0.1,...     ] [编辑]     │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  [PAC 模式]                                              │
│  ┌─────────────────────────────────────────────────┐   │
│  │ PAC URL: [http://proxy.company.com/proxy.pac   ]│   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ── 底部操作栏 ──                                       │
│  ┌─────────────────────────────────────────────────┐   │
│  │ [测试连接]  出口 IP: xxx.xxx.xxx.xxx  延迟: 120ms│   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## 十、实现伪代码

### 10.1 proxy-service.cjs

```javascript
// UI/electron/proxy-service.cjs
const { session } = require('electron');
const { createSettingsStorage } = require('./settingsStorage.cjs');
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

const SETTINGS_FILE = path.join(os.homedir(), '.soloforge', 'settings.json');

// 复用项目现有 settingsStorage，零外部依赖
// settingsStorage API: { load, getStore, flushSync, scheduleWrite, dispose }
const storage = createSettingsStorage(SETTINGS_FILE);

const BYPASS_DEFAULT = [
  'localhost', '127.0.0.1', '::1', '*.local', '<local>',
  // SoloForge 内部服务完整端口 (与 4.2 节保持同步)
  'localhost:3000', 'localhost:3001', 'localhost:3002',
  'localhost:6379', 'localhost:8400',
  'localhost:8765',    // MARL (预留)
  'localhost:8766',    // MARL Reputation HTTP (预留)
  'localhost:8770',    // Java Agent (Spring AI)
].join(',');

const DEFAULT_CONFIG = { mode: 'system' };

class ProxyService {
  constructor() {
    // getStore(storeName) 返回该 store 的原始对象（自动创建）
    const store = storage.getStore('proxy-config');
    this.config = store.config ?? DEFAULT_CONFIG;
  }

  getConfig() {
    return { ...this.config };
  }

  async apply(config) {
    this.config = config;

    // 持久化：修改 store 对象后调用 scheduleWrite() 异步落盘
    const store = storage.getStore('proxy-config');
    store.config = config;
    storage.scheduleWrite();

    // 1. 设置 Chromium 层代理 (渲染进程)
    await this._applyChromiumProxy(config);

    // 2. 同步 Node.js 环境变量 (后端/子进程)
    this._syncNodeEnv(config);

    return { ok: true };
  }

  async _applyChromiumProxy(config) {
    const ses = session.defaultSession;

    switch (config.mode) {
      case 'system':
        await ses.setProxy({ mode: 'system' });
        break;

      case 'direct':
        await ses.setProxy({ mode: 'direct' });
        break;

      case 'manual': {
        const rules = this._buildProxyRules(config);
        const bypass = config.bypassList || BYPASS_DEFAULT;
        await ses.setProxy({
          mode: 'fixed_servers',
          proxyRules: rules,
          proxyBypassList: bypass,
        });
        break;
      }

      case 'pac':
        await ses.setProxy({
          mode: 'pac_script',
          pacScript: config.pacUrl,
        });
        break;
    }
  }

  _buildProxyRules(config) {
    const { protocol, server, port } = config;
    if (protocol === 'socks4' || protocol === 'socks5') {
      return `${protocol}://${server}:${port}`;
    }
    return `http=${server}:${port};https=${server}:${port}`;
  }

  _syncNodeEnv(config) {
    // 清除旧值
    for (const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY',
                        'http_proxy','https_proxy','all_proxy','no_proxy']) {
      delete process.env[key];
    }

    if (config.mode === 'manual') {
      const url = this._buildProxyUrl(config);
      process.env.HTTP_PROXY = url;
      process.env.HTTPS_PROXY = url;
      process.env.ALL_PROXY = url;
      process.env.NO_PROXY = config.bypassList || BYPASS_DEFAULT;
    }

    // PAC 模式下 Node.js 层不支持 PAC 解析（仅 Chromium 原生支持）
    // 降级策略：读取系统代理环境变量（如有），否则直连
    if (config.mode === 'pac') {
      // Node.js fetch/http 不解析 PAC 脚本，此处不注入代理变量
      // 如需 PAC 路由，应在 PAC 模式 UI 中提示用户：
      // "Node.js 后端请求（LLM 调用等）将直连，不经过 PAC 路由"
      console.warn('[ProxyService] PAC mode: Node.js requests bypass PAC, using direct connection');
    }
  }

  _buildProxyUrl(config) {
    const { protocol, server, port } = config;
    if (protocol === 'socks5') return `socks5://${server}:${port}`;
    if (protocol === 'socks4') return `socks4://${server}:${port}`;
    return `http://${server}:${port}`;
  }

  getSystemProxyInfo() {
    // 平台兼容：当前仅实现 Windows 注册表检测
    // macOS: 需通过 `scutil --proxy` 或 Objective-C bridge 读取系统偏好设置
    // Linux: 需通过 `gsettings get org.gnome.system.proxy` 或环境变量检测
    // TODO: 后续版本补充 macOS/Linux 平台支持
    if (process.platform !== 'win32') {
      console.warn(`[ProxyService] System proxy detection not implemented for ${process.platform}`);
      return { enabled: false, platform: process.platform };
    }

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

      // 检查 PAC URL
      let pacUrl = null;
      try {
        const pacResult = execSync(
          'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v AutoConfigURL',
          { encoding: 'utf8' }
        );
        pacUrl = pacResult.match(/AutoConfigURL\s+REG_SZ\s+(.+)/)?.[1]?.trim();
      } catch {}

      return { enabled: true, server: proxyServer, pacUrl };
    } catch {
      return { enabled: false };
    }
  }

  async testConnection() {
    // 多端点容灾（与 §6.1 设计保持一致）
    // httpbin.org 在国内可能超时，ipify/ipinfo 作为备选
    const TEST_ENDPOINTS = [
      { url: 'https://httpbin.org/ip', extract: (d) => d.origin },
      { url: 'https://api.ipify.org?format=json', extract: (d) => d.ip },
      { url: 'https://ipinfo.io/json', extract: (d) => d.ip },
    ];

    const { net } = require('electron');

    for (const endpoint of TEST_ENDPOINTS) {
      const result = await this._probeEndpoint(net, endpoint);
      if (result.ok) return result;
    }
    return { ok: false, error: '所有测试端点均不可达', latency: 0 };
  }

  _probeEndpoint(net, endpoint) {
    return new Promise((resolve) => {
      const start = Date.now();
      const request = net.request(endpoint.url);
      request.on('response', (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve({ ok: true, ip: endpoint.extract(data), latency: Date.now() - start });
          } catch {
            resolve({ ok: true, ip: 'unknown', latency: Date.now() - start });
          }
        });
      });
      request.on('error', () => {
        resolve({ ok: false, error: 'connection failed', latency: Date.now() - start });
      });
      setTimeout(() => {
        request.abort();
        resolve({ ok: false, error: 'timeout', latency: Date.now() - start });
      }, 8000);
      request.end();
    });
  }
}

module.exports = { ProxyService };
```

### 10.2 main.cjs 集成

```javascript
// 在 main.cjs 中添加
const { ProxyService } = require('./proxy-service.cjs');
const proxyService = new ProxyService();

// app.whenReady 之后
app.whenReady().then(async () => {
  // 应用上次保存的代理配置
  await proxyService.apply(proxyService.getConfig());

  // 注册 IPC
  ipcMain.handle('proxy:get-config', () => proxyService.getConfig());
  ipcMain.handle('proxy:apply', (_, config) => proxyService.apply(config));
  ipcMain.handle('proxy:test', () => proxyService.testConnection());
  ipcMain.handle('proxy:system-info', () => proxyService.getSystemProxyInfo());

  // ... 其余窗口创建逻辑
});
```

### 10.3 preload.cjs 集成

```javascript
// 在 contextBridge.exposeInMainWorld('soloforge', { ... }) 中新增
proxy: {
  getConfig:      ()  => ipcRenderer.invoke('proxy:get-config'),
  apply:          (c) => ipcRenderer.invoke('proxy:apply', c),
  testConnection: ()  => ipcRenderer.invoke('proxy:test'),
  getSystemInfo:  ()  => ipcRenderer.invoke('proxy:system-info'),
},
```

### 10.4 ProxyTab.tsx 类型安全约束

> **⚠️ 代码审查报告指出项目有 76 处 `any`，ProxyTab.tsx 改造时严禁新增。**

```typescript
// ✅ 正确：使用严格类型
type ProxyMode = 'system' | 'direct' | 'manual' | 'pac';
type ProxyProtocol = 'http' | 'https' | 'socks4' | 'socks5';

interface ProxyConfig {
  mode: ProxyMode;
  protocol?: ProxyProtocol;
  server?: string;
  port?: string;
  bypassList?: string;
  pacUrl?: string;
}

interface SystemProxyInfo {
  enabled: boolean;
  server?: string;
  pacUrl?: string;
}

interface TestResult {
  ok: boolean;
  ip?: string;
  latency?: number;
  error?: string;
}

// ❌ 错误：禁止以下写法
// const config: any = await window.soloforge.proxy.getConfig();
// interface ProxyConfig { [k: string]: any; }
```

**规则**：
- IPC 返回值必须用 `as` 断言为具体类型，或使用泛型 `invoke<T>()`
- 禁止 `[k: string]: any` 索引签名
- 所有 `useState` 必须声明泛型参数

---

## 十一、与上一版方案的对比

| 维度 | v1 方案 | v2 方案 (本方案) |
|---|---|---|
| 模式数量 | 3 个 | **4 个**（新增 PAC 模式） |
| 默认模式 | 直连 | **系统代理**（与 VS Code/Slack 一致） |
| Chromium 层 | `session.setProxy()` | `session.setProxy()` + `mode` 参数 |
| Node.js 层 | 未处理 | **环境变量同步** |
| 子进程代理 | 未处理 | **env 继承** |
| 绕过列表 | 无 | **完整覆盖 8 个内部服务端口**（含 MARL 8765/8766 预留） |
| PAC 支持 | 无 | **原生支持** |
| 连通性测试 | 无 | **内置测试（3 端点容灾）** |
| 启动时序 | 未考虑 | **启动时恢复配置** |
| 系统代理检测 | 读注册表 | 读注册表 + **PAC/WPAD 检测** |
| 类型安全 | 未考虑 | **严格类型，禁止新增 any** |
| CORS 修复 | 未涉及 | **顺手补全 3000 端口白名单**（待验证） |
| 配置持久化 | `electron-store`（需安装） | **`settingsStorage.cjs`（零依赖）** |
| 子进程时效 | 未考虑 | **已 spawn 子进程需重启提醒** |

---

## 十二、测试计划

| 测试场景 | 步骤 | 预期 |
|---|---|---|
| 默认系统代理 | 首次启动，不修改设置 | 自动使用系统代理 |
| 切换直连 | 选择直连模式 | 所有请求直连，不经过代理 |
| 手动代理 | 输入 Clash 地址 127.0.0.1:7890 | 所有请求经过 Clash |
| SOCKS5 代理 | 输入 socks5://127.0.0.1:7891 | SOCKS5 代理生效 |
| PAC 配置 | 输入企业 PAC URL | 按 PAC 规则分流 |
| 绕过本地服务 | 手动代理模式下访问 localhost:3000/3001/8766/8770 | 直连，不走代理 |
| 配置持久化 | 设置手动代理 → 重启应用 | 代理配置自动恢复 |
| 连通性测试 | 点击测试连接 | 显示出口 IP 和延迟 |
| Node.js 层代理 | 手动代理下发送 LLM 请求 | 后端请求也走代理 |
| 即时生效 | 切换模式后立即发起请求 | 新配置立即生效 |
| MARL 服务绕过 | 手动代理模式下访问 localhost:8766 | 直连，不走代理 |
| 子进程重启提醒 | 运行中切换代理 → 检查已 spawn 子进程 | UI 提示"已运行的服务需重启才能生效" |
| TypeScript 编译 | `npx tsc --noEmit` 检查 ProxyTab.tsx | 零新增 `any`，零编译错误 |

---

## 十三、前置依赖与准备事项

### 13.1 依赖安装

**无需安装任何新依赖**。配置持久化复用项目现有的 `settingsStorage.cjs`（纯 Node.js 实现，零外部依赖）。

```javascript
// 直接 require 即可
const { createSettingsStorage } = require('./settingsStorage.cjs');
const storage = createSettingsStorage(settingsFilePath);
```

> **原方案**：使用 `electron-store`（需 `npm install`，有原生依赖）。
> **修正后**：复用 `settingsStorage.cjs`，已在 `main.cjs` 中使用，格式 v2 支持多 store 隔离。

### 13.2 CORS 白名单修复（顺手修复）

代码审查报告指出：后端 `auth.ts` 的 CORS 白名单仅允许 `localhost:5173/5174`（Vite 默认端口），
当前自定义 Server 模式端口 3000 不在白名单中。

**修复方式**（二选一）：

```bash
# 方式 1: .env 文件追加
SOLOFORGE_CORS_ORIGINS=http://localhost:3000,http://localhost:5173,http://localhost:5174

# 方式 2: 启动时环境变量
SOLOFORGE_CORS_ORIGINS=http://localhost:3000 npm start
```

> **影响评估**：低风险 — 生产模式走服务端代理（同源请求），不触发浏览器 CORS。
> 但开发调试时若浏览器直连后端，会遇到跨域问题。

### 13.3 类型安全约束

代码审查报告指出项目有 **76 处 `any`**（services 34 + components 42）。
ProxyTab.tsx 改造时必须严格遵守以下规则：

| 规则 | 说明 |
|---|---|
| 禁止新增 `any` | IPC 返回值使用 `as` 断言或泛型 `invoke<T>()` |
| `useState` 泛型 | 所有 `useState` 必须声明类型参数 |
| 禁止索引签名 | 不使用 `[k: string]: any` |
| 接口导出 | `ProxyConfig` 等类型定义导出供其他模块复用 |

---

## 十四、可行性评估总结

### 14.1 评估结论

**整体可行性评分：4.25 / 5**，技术选型正确、架构设计合理，可直接实施。

### 14.2 核心验证结果

| 验证项 | 状态 | 说明 |
|---|---|---|
| Electron API 兼容性 | ✅ 通过 | `electron ^42.4.1` 完全支持四模式 `session.setProxy()` |
| 内部服务端口清单 | ✅ 5/5 确认 | 3000/3001/3002/6379/8400 均在 `main.cjs` 中实际启动 |
| 现有基础设施 | ✅ 就绪 | `main.cjs` 已 import `session`，`preload.cjs` 架构清晰可扩展 |
| 配置持久化方案 | ✅ 已修正 | 复用现有 `settingsStorage.cjs`，零外部依赖 |
| ProxyTab 现状 | ⚠️ 需重写 | 当前为纯 UI 壳（无 IPC/无持久化），全新实现而非改造 |

### 14.3 已修正项

| 修正项 | 原方案 | 修正后 |
|---|---|---|
| 配置持久化 | `electron-store`（需安装） | `settingsStorage.cjs`（已存在，零依赖） |
| MARL 端口标注 | 标注为内部服务 | 标注为**预留**（外部独立进程，非 main.cjs 启动） |
| ProxyTab 工作量 | "升级改造" | **"全新重写"**（无 IPC/无持久化/无测试功能） |
| 子进程时效 | 未考虑 | 已 spawn 子进程不会感知 env 变更，需重启提醒 |

### 14.4 潜在风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 连通性测试端点 | `httpbin.org` 在国内可能超时 | 已增加 `ipify.org` / `ipinfo.io` 备选 |
| CORS 白名单修复 | `auth.ts` 确切位置未验证 | 实施前需先定位 `auth.ts` 中的 CORS 配置代码 |

### 14.5 实施优先级

```
P0 → 新建 proxy-service.cjs + 重写 ProxyTab.tsx（四模式+IPC+类型安全）
P1 → main.cjs 注册 4 个 IPC handler + 启动时恢复配置
P1 → preload.cjs 扩展 soloforge.proxy 命名空间
P2 → 连通性测试端点增加国内备选
P2 → CORS 白名单补全 localhost:3000（需先验证 auth.ts 位置）
```

---

## 参考资料

- [Electron session.setProxy() 官方文档](https://www.electronjs.org/docs/latest/api/session#sessetproxyconfig)
- [Chromium 代理解析机制](https://chromium.googlesource.com/chromium/src/+/main/net/docs/proxy.md)
- [VS Code 代理设置源码](https://github.com/microsoft/vscode/blob/main/src/vs/platform/request/node/proxy.ts)
- [Chromium proxy-bypass-list 格式](https://chromium.googlesource.com/chromium/src/+/main/net/docs/proxy.md#Proxy-bypass-rules)
