"""tools 单元测试 — 验证 MCP tool dispatcher 行为"""
import json

import pytest

from browser_use_service.tools import (
    TOOL_DEFINITIONS, dispatch_tool, serialize_state, _ok, _err,
)
from browser_use_service.agent import ObscuraAgent, TaskState
from browser_use_service.config import LLMConfig, AgentConfig, ObscuraConfig
from browser_use_service.obscura_bridge import ObscuraBridge


def test_tool_definitions_have_required_fields():
    """6 个工具都必须有 name / description / inputSchema"""
    assert len(TOOL_DEFINITIONS) == 6
    for t in TOOL_DEFINITIONS:
        assert "name" in t
        assert t["name"].startswith("browser_")
        assert "description" in t
        assert "inputSchema" in t
        assert t["inputSchema"]["type"] == "object"


def test_tool_definitions_run_task_requires_task_field():
    run = next(t for t in TOOL_DEFINITIONS if t["name"] == "browser_run_task")
    assert "task" in run["inputSchema"]["required"]


def test_serialize_state_basic():
    state = TaskState(task_id="t1", task_description="do thing")
    state.status = "running"
    state.current_step = 3
    d = serialize_state(state)
    assert d["taskId"] == "t1"
    assert d["status"] == "running"
    assert d["currentStep"] == 3


def test_serialize_state_truncates_long_result():
    state = TaskState(task_id="t1", task_description="x")
    state.result = "a" * 5000
    d = serialize_state(state)
    assert len(d["result"]) <= 2000


@pytest.mark.asyncio
async def test_dispatch_unknown_tool_returns_error():
    bridge = ObscuraBridge(ObscuraConfig())
    agent = ObscuraAgent(
        LLMConfig(api_key="dummy"),
        AgentConfig(max_steps=1),
        bridge,
    )
    result = await dispatch_tool(agent, "browser_does_not_exist", {})
    assert result["isError"] is True
    assert "unknown tool" in result["content"][0]["text"]


@pytest.mark.asyncio
async def test_dispatch_run_task_requires_task():
    bridge = ObscuraBridge(ObscuraConfig())
    agent = ObscuraAgent(
        LLMConfig(api_key="dummy"),
        AgentConfig(max_steps=1),
        bridge,
    )
    result = await dispatch_tool(agent, "browser_run_task", {})
    assert result["isError"] is True


@pytest.mark.asyncio
async def test_dispatch_get_state_unknown_task():
    bridge = ObscuraBridge(ObscuraConfig())
    agent = ObscuraAgent(
        LLMConfig(api_key="dummy"),
        AgentConfig(max_steps=1),
        bridge,
    )
    result = await dispatch_tool(agent, "browser_get_task_state", {"taskId": "nope"})
    assert result["isError"] is True
    assert "not found" in result["content"][0]["text"]


def test_ok_and_err_helpers():
    r1 = _ok({"a": 1})
    assert r1["isError"] is False
    assert json.loads(r1["content"][0]["text"]) == {"a": 1}
    r2 = _err("bad")
    assert r2["isError"] is True
    assert "bad" in r2["content"][0]["text"]


import json
