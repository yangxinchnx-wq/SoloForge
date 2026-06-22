# Obscura × Browser-Use 混合集成方案

## Summary

把 Browser-Use(高层 LLM 任务规划)架在 Obscura(Rust 无头浏览器引擎)之上,在 SoloForge UI 里同时暴露"低层原子工具"和"高层任务编排"两套能力,并在 ChatPanel 流式区里实时可视化 ReAct 推理轨迹。

四个层次从下到上:

| 层 | 组件 | 职责 |
|---|---|---|
| 引擎 | Obscura `obscura.exe` (已有) | V8 + DOM + CDP server, stealth 反指纹 |
| 编排 | `browser-use` Python 库 | LLM 决策循环, 走 CDP 驱动 Obscura |
| 桥接 | `python/browser_use_service/` (新建) | MCP server, 进程管理, 事件流 |
| 呈现 | UI 组件 + Node 代理 | 任务卡片、ReAct 流、原子工具 |

---

## Current State Analysis

**已存在:**
- [UI/resources/tools/manifest.json](file:///c:/Users/yangx/Desktop/SoloForge/UI/resources/tools/manifest.json) 声明 `obscura` 工具组, 7 个子能力 (DevTools / Console / Network / DOM / Screenshot / Perf / Cookies)
- [UI/src/components/ChatPanel.tsx#L939-L970](file:///c:/Users/yangx/Desktop/SoloForge/UI/src/components/ChatPanel.tsx#L939-L970) `DEFAULT_TOOLS_MANIFEST` 里硬编码同样内容
- [UI/active_resources_db.json](file:///c:/Users/yangx/Desktop/SoloForge/UI/active_resources_db.json) 分组 `浏览器` / `Windows`
- [UI/resources/tools/obscura/bin/obscura.exe](file:///c:/Users/yangx/Desktop/SoloForge/UI/resources/tools/obscura/bin/obscura.exe) Windows 二进制已构建
- [UI/resources/tools/obscura/crates/obscura-cdp/](file:///c:/Users/yangx/Desktop/SoloForge/UI/resources/tools/obscura/crates/obscura-cdp/) CDP 实现覆盖 11 个 domain
- [UI/resources/tools/obscura/crates/obscura-mcp/](file:///c:/Users/yangx/Desktop/SoloForge/UI/resources/tools/obscura/crates/obscura-mcp/) Obscura 自带的 MCP server (12 个低层工具)
- [python/marl_service/server.py](file:///c:/Users/yangx/Desktop/SoloForge/python/marl_service/server.py) Python IPC 服务已有先例
- [UI/server.ts](file:///c:/Users/yangx/Desktop/SoloForge/UI/server.ts) 3000 端口前端, 代理到 3001 后端
- [src/api-server.ts](file:///c:/Users/yangx/Desktop/SoloForge/src/api-server.ts) 3001 主后端
- Electron 主进程 [UI/electron/main.cjs](file:///c:/Users/yangx/Desktop/SoloForge/UI/electron/main.cjs) 可派生子进程

**完全不存在:**
- Browser-Use 库 (`pip install browser-use`) 未安装
- 任何 Python MCP 服务
- Obscura 子进程生命周期管理
- ReAct 流式事件总线

**核心风险点:**
- **CDP 覆盖缺口**: Obscura CDP 实现 11 个 domain, 但 browser-use 底层走 Playwright/patchright, 需要 `Page.captureScreenshot` / `Page.printToPDF` / `Accessibility.getFullAXTree` 等. 已在 [crates/obscura-cdp/src/domains/mod.rs](file:///c:/Users/yangx/Desktop/SoloForge/UI/resources/tools/obscura/crates/obscura-cdp/src/domains/mod.rs) 确认 `input`/`dom`/`page`/`runtime`/`network` 都有, 截图和 a11y 待验证.
- **LLM 凭据传递**: SoloForge 主后端用 `@google/genai`, browser-use 默认用 `langchain` 系 (OpenAI/Anthropic/Gemini 都支持). 需在配置面板里加 LLM 凭据入口.
- **Python 3.13 兼容**: 项目用 `python-3.13.14` standalone, browser-use 要求 `Python>=3.11`, 需要验证 3.13 wheel 可用.

---

## Proposed Changes

### 1. 新增 Python 服务 `python/browser_use_service/`

新建独立 Python 包, 跟 `marl_service` / `soloforge_ai_society` 同级.

**目录结构:**
```
python/browser_use_service/
├── __init__.py
├── server.py              # MCP stdio server 入口
├── agent.py               # browser-use Agent 封装
├── obscura_bridge.py      # Obscura 子进程生命周期 + CDP attach
├── tools.py               # 暴露的 MCP 工具
├── streaming.py           # ReAct 步骤事件发布
├── config.py              # LLM 凭据 / stealth / 端口
├── pyproject.toml
└── tests/
    ├── test_obscura_bridge.py
    └── test_agent.py
```

**关键模块:**

[`python/browser_use_service/obscura_bridge.py`](file:///c:/Users/yangx/Desktop/SoloForge/python/browser_use_service/obscura_bridge.py) — Obscura 生命周期
```python
class ObscuraBridge:
    """管理 obscura.exe 子进程, 通过 ws://127.0.0.1:9222 对外暴露"""
    async def start(self, port: int = 9222, stealth: bool = True): ...
    async def stop(self): ...
    def cdp_endpoint(self) -> str: ...
    async def health_check(self) -> bool: ...
```

[`python/browser_use_service/agent.py`](file:///c:/Users/yangx/Desktop/SoloForge/python/browser_use_service/agent.py) — Browser-Use 封装
```python
from browser_use import Agent, Browser
from browser_use.llm import ChatGoogle  # 复用 SoloForge 的 Gemini 凭据

class ObscuraAgent:
    """browser-use Agent 强制走 Obscura CDP"""
    def __init__(self, task: str, cdp: str, llm_config: LLMConfig):
        self.browser = Browser(cdp_url=cdp)  # 关键: 替换默认 Chromium
        self.agent = Agent(task=task, browser=self.browser, llm=self._make_llm(llm_config))
    async def run(self, on_step: Callable[[ReactStep], Awaitable[None]]): ...
    async def pause(self): ...
    async def resume(self): ...
    async def cancel(self): ...
```

[`python/browser_use_service/server.py`](file:///c:/Users/yangx/Desktop/SoloForge/python/browser_use_service/server.py) — MCP server (stdio)
- 用 `mcp` Python SDK (`pip install mcp`)
- 暴露 6 个工具: `browser_run_task`, `browser_pause_task`, `browser_resume_task`, `browser_get_task_state`, `browser_list_tasks`, `browser_close_browser`
- `on_step` 回调通过 MCP `notifications/progress` 推送, 嵌入 JSON-RPC 的 `_meta` 字段

**依赖更新:**
- `python/requirements.txt` 新增: `browser-use>=0.1.0`, `mcp>=1.0.0`, `playwright>=1.40`(实际只用来 attach CDP, 可选)

### 2. 后端编排 `src/core/browser-use/`

新建 TypeScript 模块, 管理 Python 子进程 + 任务状态 + 事件总线.

**文件:**
- [`src/core/browser-use/orchestrator.ts`](file:///c:/Users/yangx/Desktop/SoloForge/src/core/browser-use/orchestrator.ts) — 启动/停止 `python -m browser_use_service.server`, 健康检查
- [`src/core/browser-use/task-store.ts`](file:///c:/Users/yangx/Desktop/SoloForge/src/core/browser-use/task-store.ts) — 任务状态持久化 (用现有 SurrealDB)
- [`src/core/browser-use/event-bus.ts`](file:///c:/Users/yangx/Desktop/SoloForge/src/core/browser-use/event-bus.ts) — ReAct 事件分发
- [`src/core/browser-use/mcp-client.ts`](file:///c:/Users/yangx/Desktop/SoloForge/src/core/browser-use/mcp-client.ts) — 跟 Python MCP server 通信

**新增 API 端点** (在 [src/api-server.ts](file:///c:/Users/yangx/Desktop/SoloForge/src/api-server.ts) 注册):
- `POST /api/browser-use/run` — 启动任务, body `{ task, options }`, 返回 `{ taskId }`
- `POST /api/browser-use/cancel/:id` — 取消
- `POST /api/browser-use/pause/:id` / `POST /api/browser-use/resume/:id`
- `GET  /api/browser-use/stream/:id` — SSE, 推送 ReAct 步骤
- `GET  /api/browser-use/tasks` — 列表
- `GET  /api/browser-use/config` / `POST /api/browser-use/config` — LLM 凭据

### 3. UI 工具清单扩展

**修改 1:** [UI/resources/tools/manifest.json](file:///c:/Users/yangx/Desktop/SoloForge/UI/resources/tools/manifest.json)
在 `obscura` 之外新增一个顶层工具组, 标识编排层:
```json
{
  "id": "browser-use",
  "name": "Browser-Use",
  "description": "高层浏览器任务编排, LLM 自主规划+执行, 底层由 Obscura 驱动",
  "group": "浏览器",
  "children": [
    { "id": "bu_run_task", "name": "运行浏览器任务", "description": "自然语言描述任务, LLM 自动规划执行步骤" },
    { "id": "bu_pause", "name": "暂停任务", "description": "暂停正在执行的浏览器任务" },
    { "id": "bu_resume", "name": "恢复任务", "description": "恢复暂停的任务" },
    { "id": "bu_state", "name": "任务状态查询", "description": "查看当前任务执行进度与轨迹" },
    { "id": "bu_screenshot", "name": "任务截图", "description": "对当前浏览器页面截图" },
    { "id": "bu_history", "name": "历史轨迹", "description": "查看任务 ReAct 推理历史" }
  ]
}
```

**修改 2:** [UI/src/components/ChatPanel.tsx#L939-L970](file:///c:/Users/yangx/Desktop/SoloForge/UI/src/components/ChatPanel.tsx#L939-L970) `DEFAULT_TOOLS_MANIFEST` 数组追加 `browser-use` 条目 (跟 manifest.json 保持一致).

**修改 3:** [UI/active_resources_db.json](file:///c:/Users/yangx/Desktop/SoloForge/UI/active_resources_db.json) `groupAssignments` 加 6 行:
```json
"bu_run_task": "浏览器",
"bu_pause": "浏览器",
"bu_resume": "浏览器",
"bu_state": "浏览器",
"bu_screenshot": "浏览器",
"bu_history": "浏览器"
```

### 4. UI 组件: 任务卡片 + ReAct 流

**新增组件:**

[`UI/src/components/BrowserTaskCard.tsx`](file:///c:/Users/yangx/Desktop/SoloForge/UI/src/components/BrowserTaskCard.tsx) — 任务生命周期
- 显示任务状态: `queued` / `running` / `paused` / `success` / `error` / `cancelled`
- 任务描述、开始时间、当前步骤、最终结果
- 操作按钮: 暂停 / 恢复 / 取消 / 查看完整轨迹
- 失败时显示错误码 + 浏览器最后一次截图缩略图

[`UI/src/components/ReactStepBubble.tsx`](file:///c:/Users/yangx/Desktop/SoloForge/UI/src/components/ReactStepBubble.tsx) — 单步 ReAct
- 三种类型渲染: 
  - `thought` 🤔 — LLM 思考文本 (灰色斜体)
  - `action` 🖱️ — 具体动作 (`click('#x')` / `type('hello')`), 带语法高亮
  - `observation` 👁️ — 观察结果 (页面标题变化、URL、关键文本摘要)
- 折叠: 同一步骤折叠成一组, 展开看完整

**接入流式区:**

[UI/src/components/ChatPanel.tsx](file:///c:/Users/yangx/Desktop/SoloForge/UI/src/components/ChatPanel.tsx) 在 SSE 消息处理里加一条:
```ts
if (msg.type === 'browser.react_step') {
  appendReactStep(msg.taskId, msg.step);  // 往 chat stream 追加 ReactStepBubble
}
if (msg.type === 'browser.task_state') {
  upsertTaskCard(msg.taskId, msg.state);  // 更新 BrowserTaskCard
}
```

具体参考 [ChatPanel.tsx#L920-L930](file:///c:/Users/yangx/Desktop/SoloForge/UI/src/components/ChatPanel.tsx#L920-L930) 的现有 scrollRef 模式.

### 5. LLM 凭据配置

**修改:** [UI/src/components/AgentSettingsModal.tsx](file:///c:/Users/yangx/Desktop/SoloForge/UI/src/components/AgentSettingsModal.tsx)
新增一个折叠面板 "Browser-Use LLM":
- Provider 选择: Gemini / OpenAI / Anthropic
- API Key 输入
- Model 选择 (provider-dependent)
- 高级: max_steps / timeout / stealth 开关

**持久化:** 存到现有 electron `userData` 目录的 `browser-use-config.json`, 启动时 Python 端读环境变量 `SOLOFORGE_LLM_API_KEY` 等.

### 6. Obscura 启动配置

[`src/core/browser-use/obscura-config.ts`](file:///c:/Users/yangx/Desktop/SoloForge/src/core/browser-use/obscura-config.ts) (新文件)
- 端口默认 9222, 跟 Python 端约定一致
- 启动参数: `obscura serve --port 9222 --stealth --workers 1`
- 工作目录: `<userData>/obscura-data`(持久化 cookies/profile)
- 启动失败重试 3 次, 指数退避

### 7. CDP 兼容性补丁(按需)

如果验证发现 Obscura CDP 缺关键方法, 在 [crates/obscura-cdp/src/domains/page.rs](file:///c:/Users/yangx/Desktop/SoloForge/UI/resources/tools/obscura/crates/obscura-cdp/src/domains/page.rs) 补:
- `Page.captureScreenshot`(高优, Playwright 截图需要)
- `Page.printToPDF`(中优)
- `Accessibility.getFullAXTree`(browser-use 的可访问性快照需要, 可能在 [obscura-cdp/src/domains/accessibility.rs](file:///c:/Users/yangx/Desktop/SoloForge/UI/resources/tools/obscura/crates/obscura-cdp/src/domains/accessibility.rs) 已实现, 待验证)

**做法:** 先不写代码, Phase 1 验证后, 用 todo 列出实际缺哪些再补.

### 8. 文档与脚本

**新增脚本:** [`python/run_browser_use_service.bat`](file:///c:/Users/yangx/Desktop/SoloForge/python/run_browser_use_service.bat) — 跟 `run_service.bat` 同模板

**新增 Skill 描述:** [`UI/resources/tools/obscura/skills/browser-use/SKILL.md`](file:///c:/Users/yangx/Desktop/SoloForge/UI/resources/tools/obscura/skills/browser-use/SKILL.md) — 给 AI Agent 触发用, 描述"何时用高层任务 vs 原子工具"

**修改:** [`.trae/documents/obscura-browseruse-hybrid-integration.md`](file:///c:/Users/yangx/Desktop/SoloForge/.trae/documents/obscura-browseruse-hybrid-integration.md) (本文档) — Phase 1 验证结果追加到附录

---

## Assumptions & Decisions

| 决策 | 选择 | 理由 |
|---|---|---|
| 集成架构 | 混合 (Obscura 引擎 + browser-use 编排) | 用户已确认 |
| 浏览器引擎 | Obscura 替换 Chromium | 轻量、stealth、APACHE-2.0 |
| UI 暴露 | 高层 + 原子两套 | 用户已确认 |
| ReAct 可视化 | 流式区 (不阻塞主消息) | 用户已确认 |
| 进程通信 | MCP stdio (Python ↔ Node) | 跟 Obscura 自带 MCP 一致, 复用 mcp 协议 |
| LLM 凭据 | 复用 SoloForge 现有 Gemini 凭据 | 避免重复, 减少配置面 |
| 持久化 | 任务状态入 SurrealDB, 浏览器 profile 落盘 | 跟现有架构对齐 |
| 错误处理 | 浏览器崩溃 → 自动重启 Obscura → 任务标记 retry-able | 沿用 SoloForge retry 模式 |
| 不做 | 自建 ReAct Agent (不引 browser-use) | 否决, 用户选了混合 |
| 不做 | Playwright/puppeteer 独立进程 | Obscura 已支持 CDP, 无需中间层 |

**待用户二次确认 (非阻塞):**
- LLM 凭据是否复用 SoloForge 的 Gemini, 还是允许用户单独配 OpenAI/Anthropic? — 默认走复用
- browser-use 失败时是否自动重启 Obscura? — 默认是
- 任务历史保留多久? — 默认 7 天

---

## Verification

### Phase A: 引擎层验证 (首先做, 阻塞后续)
1. `obscura serve --port 9222 --stealth` 启动成功
2. `chromiumoxide` 或 `playwright-core` 连 `ws://127.0.0.1:9222` 能 `newPage()`
3. 跑 Playwright 的 `examples/playwright-cdp.ts`: navigate / click / type / screenshot / accessibility.snapshot 全部 OK
4. 把缺失的 CDP 方法列出来, 决定哪些要补

### Phase B: 编排层验证
1. `pip install browser-use` 在 Python 3.13 下成功
2. 最小 demo: `agent = Agent(task="Find HN top story", browser=Browser(cdp_url="ws://127.0.0.1:9222")); await agent.run()`
3. 确认每步 action 走的是 Obscura (而不是默认 Chromium)
4. stealth 模式下能过 Cloudflare 基础挑战

### Phase C: MCP 桥接验证
1. `python -m browser_use_service.server` 启动, stdio 通信 OK
2. Node 端 `mcp-client.ts` 能 invoke `browser_run_task`, 收到 taskId
3. ReAct 步骤通过 MCP `notifications/progress` 推送, Node 端能解
4. SSE 流式输出到 UI 浏览器

### Phase D: UI 集成验证
1. ChatPanel 资源面板出现新工具组 `browser-use`, 6 个子项可勾选
2. AI 调用 `bu_run_task` → 流式区依次出现 thought / action / observation 气泡
3. ChatPanel 主消息流出现 BrowserTaskCard, 状态实时更新
4. 暂停/恢复/取消按钮在 Electron 里能操作
5. LLM 凭据缺失时给出明确错误提示, 不崩溃

### Phase E: 端到端
1. 真实任务: "在 Hacker News 找前 5 条新闻标题, 写入 `reports/hn-top5.md`"
2. 验证:
   - Obscura 被启动 (任务管理器看进程)
   - LLM 至少规划 2 步 (navigate → extract)
   - ReAct 气泡在 UI 流式区按时间顺序出现
   - 最终文件内容正确
3. Stealth 任务: 访问 nairaland.com, 确认不被 CF 拦截

### Phase F: 回归
1. 原 7 个 Obscura 原子工具全部仍能直接调用 (不被破坏)
2. `npm run lint` 通过
3. `cargo nextest run -p obscura-cdp` 通过
4. Python 端 `pytest python/browser_use_service/tests/` 通过

---

## Execution Order (建议分 4 个 sprint)

| Sprint | 内容 | 阻塞关系 |
|---|---|---|
| S1 | Phase A: Obscura CDP 兼容性验证 + 按需补 patch | 阻塞 S2 |
| S2 | Phase B + C: Python `browser_use_service` (含 Obscura 桥 + MCP server) | 阻塞 S3 |
| S3 | Phase D: 后端编排 + API 端点 + Electron 子进程管理 | 阻塞 S4 |
| S4 | Phase D UI + Phase E 端到端 + 文档 | 无 |

每 sprint 结束都给用户演示一次, 通过再进下一个.
