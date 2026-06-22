"""MCP stdio server — SoloForge Node 后端通过 stdio 协议调用本服务

启动: python -m browser_use_service.server

协议:
  - JSON-RPC 2.0 over stdin/stdout
  - 客户端: SoloForge Node 端 (src/core/browser-use/mcp-client.ts)
  - 工具: tools.py 暴露 6 个

事件推送 (MCP notifications/progress):
  - 每收到一个 ReActStep, 发 notifications/progress,
    params = { progressToken: <taskId>, data: <step.to_dict()> }
  - Node 端按 taskId 路由, 推 SSE 到 UI
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

from .agent import ObscuraAgent
from .config import RuntimeConfig
from .obscura_bridge import ObscuraBridge
from .tools import TOOL_DEFINITIONS, dispatch_tool, serialize_step, serialize_state

# ============================================================
# 日志
# ============================================================
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stderr,  # 重要: stdout 留给 JSON-RPC
)
logger = logging.getLogger("browser-use-service")


# ============================================================
# 工具 schema 转换 (我们的 dict 定义 -> mcp.types.Tool)
# ============================================================
def _to_mcp_tools() -> list[Tool]:
    out: list[Tool] = []
    for t in TOOL_DEFINITIONS:
        out.append(
            Tool(
                name=t["name"],
                description=t.get("description", ""),
                inputSchema=t["inputSchema"],
            )
        )
    return out


# ============================================================
# Server bootstrap
# ============================================================

async def run() -> None:
    config = RuntimeConfig.load()
    logger.info(
        "Starting SoloForge Browser-Use service | llm=%s model=%s | obscura=%s stealth=%s",
        config.llm.provider, config.llm.model,
        config.obscura.cdp_url(), config.obscura.stealth,
    )

    bridge = ObscuraBridge(config.obscura)
    agent = ObscuraAgent(config.llm, config.agent, bridge)

    server: Server = Server("soloforge-browser-use")

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        return _to_mcp_tools()

    @server.call_tool()
    async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
        result = await dispatch_tool(agent, name, arguments)
        return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, default=str))]

    # 注册 step subscriber: 把每个 step 推成 MCP notification
    async def on_step_global(step) -> None:
        # 走 MCP 的 notifications/progress, progressToken=taskId 让 Node 端路由
        try:
            await server.request_context.session.send_notification(
                "notifications/progress",
                {
                    "progressToken": step.task_id,
                    "data": serialize_step(step),
                },
            )
        except Exception as e:
            # 没有 active session 时 (启动初期) 静默忽略
            logger.debug("notification skipped: %s", e)

    # hook 现有所有任务 + 后续新任务
    def _wrap_agent_submit(orig_submit):
        async def wrapped(task_desc):
            state = await orig_submit(task_desc)
            if state.publisher:
                state.publisher.subscribe(on_step_global)
            return state
        return wrapped

    agent.submit = _wrap_agent_submit(agent.submit)  # type: ignore

    # 启动 agent (会拉起 Obscura 子进程)
    try:
        await agent.start()
    except Exception as e:
        logger.error("Failed to start agent: %s", e)
        # 不直接退出, 仍然提供 tool 列表但调用会返回 error

    # MCP 协议主循环
    try:
        async with stdio_server() as (read_stream, write_stream):
            await server.run(
                read_stream,
                write_stream,
                server.create_initialization_options(),
            )
    finally:
        await agent.stop()


def main() -> None:
    """CLI 入口"""
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        logger.info("Interrupted")
    except Exception as e:
        logger.exception("Fatal: %s", e)
        sys.exit(1)


if __name__ == "__main__":
    main()
