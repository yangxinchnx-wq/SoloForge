# Obscura CDP × Browser-Use 兼容性矩阵

> 由 Phase A 验证得出, 持续更新

## 验证方法

```bash
# 1. 启动 Obscura CDP server
obscura serve --port 9222 --stealth

# 2. 列已实现的 CDP domain (静态分析)
grep -E "^\s*\"[A-Z][a-zA-Z]+\"" crates/obscura-cdp/src/dispatch.rs
```

## 兼容性矩阵

### 完全支持 (Puppeteer/Playwright 兼容层)

| Domain | 关键方法 | Obscura 实现 | browser-use 是否需要 |
|---|---|---|---|
| **Page** | `navigate` | ✅ server.rs:413-426 | ✅ |
| | `captureScreenshot` | ✅ fast-path + page.rs | ✅ (每步截图) |
| | `printToPDF` | ✅ fast-path 列表 | ⚠️ (可选) |
| | `setLifecycleEventsEnabled` | ✅ | ✅ |
| | `getFrameTree` | ✅ | ✅ |
| | `addScriptToEvaluateOnNewDocument` | ✅ | ✅ |
| | `createIsolatedWorld` | ✅ | ✅ (Playwright utility world) |
| | `bringToFront` | ❌ 未在 dispatch | ⚠️ (低频) |
| **Runtime** | `evaluate` | ✅ | ✅ |
| | `callFunctionOn` | ✅ | ✅ |
| | `getProperties` | ✅ | ✅ |
| | `addBinding` | ✅ | ✅ (Playwright 注入) |
| **DOM** | `getDocument` | ✅ | ✅ |
| | `querySelector` / `querySelectorAll` | ✅ | ✅ |
| | `resolveNode` | ✅ | ✅ |
| **Input** | `dispatchMouseEvent` | ✅ | ✅ |
| | `dispatchKeyEvent` | ✅ | ✅ |
| **Network** | `enable` / `setExtraHTTPHeaders` | ✅ | ✅ |
| | `setUserAgentOverride` | ✅ | ✅ |
| | `setCookies` / `getCookies` | ✅ | ✅ |
| **Fetch** | `enable` / `continueRequest` / `fulfillRequest` | ✅ | ⚠️ (Playwright route 使用) |
| **Accessibility** | `getFullAXTree` | ✅ domains/accessibility.rs | ✅ (browser-use 的可访问性快照) |
| **DOMSnapshot** | `captureSnapshot` | ✅ fast-path | ⚠️ |
| **Storage** | `getCookies` / `setCookies` | ✅ | ✅ |
| **Browser** | `getVersion` / `close` | ✅ | ✅ |
| **Target** | `createTarget` / `attachToTarget` | ✅ | ✅ (multipage) |
| **Emulation** | `setDeviceMetricsOverride` | ✅ fast-path | ⚠️ (viewport) |

### 已知缺口 (低优先级, 不阻塞 browser-use)

| Domain | 方法 | 状态 | 影响 |
|---|---|---|---|
| Emulation | `setGeolocationOverride` | ❌ 无 | 不影响基本任务 |
| Page | `handleJavaScriptDialog` | ❌ 无 | alert/confirm/prompt 弹出时静默 |
| Page | `setBypassCSP` | ❌ 无 | CSP 严格站可能阻止注入 |
| Network | `getResponseBody` | ✅ fast-path 列表 (无实际实现) | browser-use 抓页面内容用 evaluate, 影响小 |
| HeapProfiler | `takeHeapSnapshot` | ❌ fast-path 仅返回 `{}` | 不影响任务执行 |
| Tracing | `start` / `end` | ❌ Unknown domain | 性能分析用, 任务不影响 |

### 结论

**CDP 覆盖率足够支持 browser-use 的核心流程:**
- 页面导航 ✅
- 元素定位 (DOM + a11y snapshot) ✅
- 鼠标/键盘交互 ✅
- JS 求值 ✅
- 截图 (ReAct 观察用) ✅
- Cookie 持久化 ✅

**已知 3 个低优缺口** (Phase E 端到端时验证是否需要补):
1. `Page.handleJavaScriptDialog` — alert/confirm/prompt 站可能需要
2. `Page.setBypassCSP` — CSP 严格站需要
3. `Emulation.setGeolocationOverride` — 地理限制站需要

## 兼容性补丁计划 (按需执行)

S1 阶段暂不写补丁代码, 等 Phase B 跑通最小 browser-use demo 后, 用实际错误列表再补。
