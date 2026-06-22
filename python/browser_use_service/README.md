# SoloForge Browser-Use Service

独立 Python 包, 封装 `browser-use` 库, 走 **Obscura CDP** 引擎, 通过 **MCP stdio** 协议暴露高层 LLM 任务编排能力给 SoloForge Node 后端。

## 架构位置

```
┌──────────────────────────────────────────────┐
│ SoloForge UI (Electron)                      │
│  ├─ ChatPanel.tsx (ReAct 流式区)             │
│  └─ SettingsModal (LLM 凭据)                 │
└────────────┬─────────────────────────────────┘
             │ HTTP /api/browser-use/*
┌────────────▼─────────────────────────────────┐
│ SoloForge Backend (Node, src/api-server.ts)   │
│  └─ src/core/browser-use/ (orchestrator)      │
└────────────┬─────────────────────────────────┘
             │ MCP stdio (JSON-RPC 2.0)
┌────────────▼─────────────────────────────────┐
│ browser_use_service (本包, Python)            │
│  ├─ obscura_bridge.py — Obscura 子进程        │
│  ├─ agent.py         — Browser-Use Agent     │
│  ├─ streaming.py     — ReAct 事件总线        │
│  └─ server.py        — MCP stdio 入口        │
└────────────┬─────────────────────────────────┘
             │ CDP (ws://127.0.0.1:9222)
┌────────────▼─────────────────────────────────┐
│ Obscura (Rust headless browser)               │
│  └─ Chromium DevTools Protocol                │
└──────────────────────────────────────────────┘
```

## 启动

### 安装依赖

```bash
pip install -e python/browser_use_service/
# 或:
pip install -r python/browser_use_service/requirements.txt
```

### 配置

```bash
# LLM 凭据 (必需)
export SOLOFORGE_LLM_API_KEY="sk-..."

# LLM provider/model (可选, 默认 google/gemini-2.0-flash)
export SOLOFORGE_LLM_PROVIDER="google"  # google | openai | anthropic
export SOLOFORGE_LLM_MODEL="gemini-2.0-flash"

# Obscura (可选, 默认走项目内 Windows 二进制 + 端口 9222)
export SOLOFORGE_OBSCURA_PORT="9222"
export SOLOFORGE_OBSCURA_STEALTH="1"  # 0 关闭

# Agent 行为
export SOLOFORGE_BU_MAX_STEPS="25"
```

### 启动 MCP stdio server

```bash
python -m browser_use_service.server
# 或 Windows:
python\run_browser_use_service.bat
```

服务启动后会:
1. 拉起 Obscura 子进程 (`obscura serve --port 9222 --stealth`)
2. 等待 CDP 健康
3. 监听 stdin, 处理 JSON-RPC 2.0 请求
4. 每个 ReAct 步骤通过 `notifications/progress` 推给 Node 端

## 暴露的 MCP 工具

| 工具 | 用途 |
|---|---|
| `browser_run_task` | 提交自然语言任务, 返回 taskId |
| `browser_get_task_state` | 查询任务状态 |
| `browser_list_tasks` | 列出所有任务 |
| `browser_pause_task` | 暂停任务 |
| `browser_resume_task` | 恢复任务 |
| `browser_cancel_task` | 取消任务 |

## 测试

```bash
# 单元测试 (不需要 Obscura)
pytest python/browser_use_service/tests/ -v

# 集成测试 (需要 Obscura 二进制)
pytest python/browser_use_service/tests/ --run-integration -v
```

## 设计原则

1. **CDP 引擎替换**: browser-use 默认拉 Chromium, 这里通过 `Browser(cdp_url=...)` 替换为 Obscura, 享受 30MB/低内存/stealth 优势
2. **MCP stdio 协议**: 跟 Obscura 自带 MCP 协议一致, Node 端可以共用一套 client
3. **单例 Obscura**: 一次只跑一个浏览器进程, 任务排队; 避免每个任务拉一次 Chromium
4. **ReAct 事件流**: 每步 thought / action / observation 推 notification, UI 实时渲染
5. **崩溃自愈**: Obscura 启动失败重试 3 次带指数退避
