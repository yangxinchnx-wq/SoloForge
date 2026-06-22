"""MCP 工具定义 — 暴露给 SoloForge Node 后端调用

工具清单 (6 个):
  1. browser_run_task       — 提交新任务 (返回 taskId)
  2. browser_get_task_state — 查询任务状态
  3. browser_list_tasks     — 列出所有任务
  4. browser_pause_task     — 暂停
  5. browser_resume_task    — 恢复
  6. browser_cancel_task    — 取消
"""
from __future__ import annotations

import json
import logging
from typing import Any

from .agent import ObscuraAgent, TaskState
from .streaming import StepKind

logger = logging.getLogger(__name__)


def serialize_state(state: TaskState) -> dict[str, Any]:
    """把 TaskState 序列化成 MCP 友好 dict"""
    return {
        "taskId": state.task_id,
        "task": state.task_description,
        "status": state.status,
        "currentStep": state.current_step,
        "result": state.result[:2000] if state.result else "",
        "error": state.error,
    }


def serialize_step(step) -> dict[str, Any]:
    return step.to_dict()


# ============================================================
# MCP Tool 注册表
# ============================================================

TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": "browser_run_task",
        "description": "提交一个自然语言描述的浏览器任务, LLM 自动规划执行步骤. 底层走 Obscura CDP 引擎.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "任务描述 (自然语言), 例如: '在 Hacker News 找前 5 条新闻标题'",
                },
            },
            "required": ["task"],
        },
    },
    {
        "name": "browser_get_task_state",
        "description": "查询任务当前状态 (status, currentStep, result, error).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "taskId": {"type": "string"},
            },
            "required": ["taskId"],
        },
    },
    {
        "name": "browser_list_tasks",
        "description": "列出所有浏览器任务 (按 taskId).",
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "browser_pause_task",
        "description": "暂停正在执行的浏览器任务.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "taskId": {"type": "string"},
            },
            "required": ["taskId"],
        },
    },
    {
        "name": "browser_resume_task",
        "description": "恢复已暂停的浏览器任务.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "taskId": {"type": "string"},
            },
            "required": ["taskId"],
        },
    },
    {
        "name": "browser_cancel_task",
        "description": "取消任务. 正在执行的任务会立即停止, queued 任务直接丢弃.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "taskId": {"type": "string"},
            },
            "required": ["taskId"],
        },
    },
]


async def dispatch_tool(agent: ObscuraAgent, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """MCP tool dispatcher, 把调用路由到 agent 对应方法"""
    try:
        if name == "browser_run_task":
            task_desc = arguments.get("task", "").strip()
            if not task_desc:
                return _err("task is required")
            state = await agent.submit(task_desc)
            return _ok(serialize_state(state))

        if name == "browser_get_task_state":
            tid = arguments.get("taskId", "")
            state = agent.get_state(tid)
            if not state:
                return _err(f"task {tid} not found")
            return _ok(serialize_state(state))

        if name == "browser_list_tasks":
            states = agent.list_states()
            return _ok({"tasks": [serialize_state(s) for s in states]})

        if name == "browser_pause_task":
            tid = arguments.get("taskId", "")
            ok = await agent.pause(tid)
            return _ok({"paused": ok, "taskId": tid})

        if name == "browser_resume_task":
            tid = arguments.get("taskId", "")
            ok = await agent.resume(tid)
            return _ok({"resumed": ok, "taskId": tid})

        if name == "browser_cancel_task":
            tid = arguments.get("taskId", "")
            ok = await agent.cancel(tid)
            return _ok({"cancelled": ok, "taskId": tid})

        return _err(f"unknown tool: {name}")
    except Exception as e:
        logger.exception("Tool %s failed: %s", name, e)
        return _err(str(e))


def _ok(data: Any) -> dict[str, Any]:
    """MCP tool result 包装"""
    return {
        "content": [
            {
                "type": "text",
                "text": json.dumps(data, ensure_ascii=False, default=str),
            }
        ],
        "isError": False,
    }


def _err(message: str) -> dict[str, Any]:
    return {
        "content": [
            {
                "type": "text",
                "text": json.dumps({"error": message}, ensure_ascii=False),
            }
        ],
        "isError": True,
    }
