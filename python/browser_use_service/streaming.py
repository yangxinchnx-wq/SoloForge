"""ReAct 步骤事件模型 + 发布总线

设计目标:
  - 任务运行时, 每个 ReAct 步骤 (思考 / 动作 / 观察) 异步推送到订阅者
  - 订阅者 = MCP server (转 notifications/progress) + Node 端 (转 SSE)
  - 步骤序列化后走 MCP _meta 字段, 不污染 JSON-RPC 协议

数据结构:
  ReactStep(
      task_id, step_index, kind,            # thought | action | observation
      content,                                # 文本
      url, title, screenshot_b64,             # 上下文
      timestamp_ms
  )
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any, AsyncIterator, Awaitable, Callable, Optional

logger = logging.getLogger(__name__)


class StepKind(str, Enum):
    THOUGHT = "thought"
    ACTION = "action"
    OBSERVATION = "observation"
    ERROR = "error"
    FINAL = "final"  # 任务结束, content 是 result


@dataclass
class ReactStep:
    task_id: str
    step_index: int
    kind: StepKind
    content: str
    url: str = ""
    title: str = ""
    screenshot_b64: str = ""  # 完整 base64 PNG, 可选
    duration_ms: int = 0
    timestamp_ms: int = field(default_factory=lambda: int(time.time() * 1000))

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["kind"] = self.kind.value
        return d


# 订阅者回调: (step) -> None
StepSubscriber = Callable[[ReactStep], Awaitable[None]]


class StepPublisher:
    """ReAct 步骤发布总线

    用法:
        pub = StepPublisher()
        pub.subscribe(my_async_callback)
        await pub.publish(some_step)
    """

    def __init__(self, task_id: str):
        self.task_id = task_id
        self._subscribers: list[StepSubscriber] = []
        self._queue: asyncio.Queue[ReactStep] = asyncio.Queue()
        self._closed = False

    def subscribe(self, callback: StepSubscriber) -> None:
        self._subscribers.append(callback)

    def unsubscribe(self, callback: StepSubscriber) -> None:
        try:
            self._subscribers.remove(callback)
        except ValueError:
            pass

    async def publish(self, step: ReactStep) -> None:
        """入队并通知所有订阅者 (fire-and-forget 风格)"""
        if self._closed:
            return
        await self._queue.put(step)
        for sub in list(self._subscribers):
            try:
                await sub(step)
            except Exception as e:
                logger.exception("Step subscriber failed: %s", e)

    async def stream(self) -> AsyncIterator[ReactStep]:
        """异步迭代器: 消费队列, 直到 close()"""
        while True:
            step = await self._queue.get()
            if step is None:  # 哨兵
                return
            yield step

    def close(self) -> None:
        self._closed = True
        self._queue.put_nowait(None)  # type: ignore


def make_thought(task_id: str, step_index: int, content: str) -> ReactStep:
    return ReactStep(
        task_id=task_id, step_index=step_index, kind=StepKind.THOUGHT, content=content,
    )


def make_action(
    task_id: str, step_index: int, action_repr: str, url: str = "", title: str = "",
) -> ReactStep:
    return ReactStep(
        task_id=task_id, step_index=step_index, kind=StepKind.ACTION,
        content=action_repr, url=url, title=title,
    )


def make_observation(
    task_id: str, step_index: int, content: str, url: str = "", title: str = "",
    screenshot_b64: str = "", duration_ms: int = 0,
) -> ReactStep:
    return ReactStep(
        task_id=task_id, step_index=step_index, kind=StepKind.OBSERVATION,
        content=content, url=url, title=title,
        screenshot_b64=screenshot_b64, duration_ms=duration_ms,
    )


def make_error(task_id: str, step_index: int, error: str) -> ReactStep:
    return ReactStep(
        task_id=task_id, step_index=step_index, kind=StepKind.ERROR, content=error,
    )


def make_final(task_id: str, result: str) -> ReactStep:
    return ReactStep(
        task_id=task_id, step_index=-1, kind=StepKind.FINAL, content=result,
    )
