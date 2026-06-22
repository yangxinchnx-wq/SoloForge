"""Browser-Use Service — SoloForge 高层浏览器任务编排服务

封装 browser-use 库, 强制走 Obscura CDP 引擎, 通过 MCP stdio 协议对外暴露任务编排能力。

模块结构:
    obscura_bridge.py  — Obscura 子进程生命周期 (start / stop / health)
    agent.py           — Browser-Use Agent 封装 (走 Obscura CDP)
    streaming.py       — ReAct 步骤事件发布 (MCP notifications)
    config.py          — LLM 凭据 / stealth / 端口配置
    tools.py           — 暴露的 MCP 工具定义
    server.py          — MCP stdio server 入口

CLI:
    python -m browser_use_service.server
"""

__version__ = "0.1.0"
