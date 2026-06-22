"""Browser-Use Agent 封装 — 强制走 Obscura CDP

设计:
  - 构造时持有 ObscuraBridge (单例, 全服务共享一个浏览器)
  - 每次 run() 创建一个 browser_use.Agent, 通过 Browser(cdp_url=...) 复用 Obscura
  - browser-use 的 step callback 适配成 ReActStep 推给 publisher

依赖:
    pip install browser-use

注意: browser-use 0.1+ API:
    Agent(task=..., browser=Browser(cdp_url=...), llm=ChatGoogle(...))
    async agent.run(max_steps=25)
    Agent 还提供 step_callback=async_fn 注册每步回调
"""
from __future__ import annotations

import asyncio
import logging
import traceback
import uuid
from dataclasses import dataclass
from typing import Optional

from .config import AgentConfig, LLMConfig
from .obscura_bridge import ObscuraBridge
from .streaming import (
    ReactStep,
    StepKind,
    StepPublisher,
    make_action,
    make_error,
    make_final,
    make_observation,
    make_thought,
)

logger = logging.getLogger(__name__)


@dataclass
class TaskState:
    """单个浏览器任务的运行时状态"""
    task_id: str
    task_description: str
    status: str = "queued"  # queued / running / paused / success / error / cancelled
    current_step: int = 0
    result: str = ""
    error: str = ""
    publisher: Optional[StepPublisher] = None
    _cancel_event: Optional[asyncio.Event] = None
    _pause_event: Optional[asyncio.Event] = None


class AgentError(RuntimeError):
    pass


class ObscuraAgent:
    """单例 agent, 持有 ObscuraBridge + 任务注册表

    任务调度:
      - 一次只跑一个长任务 (browser-use 限制)
      - 排队: 后续任务 await 前一个完成
      - pause/cancel 通过 Task 内部 asyncio.Event 控制
    """

    def __init__(self, llm: LLMConfig, agent_cfg: AgentConfig, bridge: ObscuraBridge):
        self.llm = llm
        self.agent_cfg = agent_cfg
        self.bridge = bridge
        self._tasks: dict[str, TaskState] = {}
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._worker_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()
        self._started = False

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    async def start(self) -> None:
        if self._started:
            return
        await self.bridge.start()
        await self.bridge.wait_for_ws()
        self._worker_task = asyncio.create_task(self._queue_worker(), name="bu-queue-worker")
        self._started = True
        logger.info("ObscuraAgent started, Obscura CDP at %s", self.bridge.cdp_url())

    async def stop(self) -> None:
        if not self._started:
            return
        self._started = False
        if self._worker_task:
            self._worker_task.cancel()
            with __import__("contextlib").suppress(asyncio.CancelledError):
                await self._worker_task
        # 取消所有未完成任务
        for state in self._tasks.values():
            if state.status in ("queued", "running", "paused"):
                state.status = "cancelled"
        await self.bridge.stop()
        logger.info("ObscuraAgent stopped")

    # ------------------------------------------------------------------
    # 任务管理
    # ------------------------------------------------------------------

    async def submit(self, task_description: str) -> TaskState:
        """提交任务, 返回 TaskState (status=queued)"""
        async with self._lock:
            task_id = f"bu-{uuid.uuid4().hex[:12]}"
            state = TaskState(
                task_id=task_id,
                task_description=task_description,
                publisher=StepPublisher(task_id),
                _cancel_event=asyncio.Event(),
                _pause_event=asyncio.Event(),
            )
            # 默认不暂停: 显式 set
            state._pause_event.set()
            self._tasks[task_id] = state
            await self._queue.put(task_id)
            logger.info("Task %s queued: %s", task_id, task_description[:80])
            return state

    def get_state(self, task_id: str) -> Optional[TaskState]:
        return self._tasks.get(task_id)

    def list_states(self) -> list[TaskState]:
        return list(self._tasks.values())

    def subscribe(self, task_id: str, callback) -> bool:
        state = self._tasks.get(task_id)
        if not state or not state.publisher:
            return False
        state.publisher.subscribe(callback)
        return True

    async def cancel(self, task_id: str) -> bool:
        state = self._tasks.get(task_id)
        if not state:
            return False
        if state._cancel_event:
            state._cancel_event.set()
        state.status = "cancelled"
        return True

    async def pause(self, task_id: str) -> bool:
        state = self._tasks.get(task_id)
        if not state or state.status != "running":
            return False
        if state._pause_event:
            state._pause_event.clear()
        state.status = "paused"
        return True

    async def resume(self, task_id: str) -> bool:
        state = self._tasks.get(task_id)
        if not state or state.status != "paused":
            return False
        if state._pause_event:
            state._pause_event.set()
        state.status = "running"
        return True

    # ------------------------------------------------------------------
    # 队列 worker
    # ------------------------------------------------------------------

    async def _queue_worker(self) -> None:
        while self._started:
            try:
                task_id = await self._queue.get()
            except asyncio.CancelledError:
                return
            state = self._tasks.get(task_id)
            if not state or state.status == "cancelled":
                continue
            try:
                await self._run_one(state)
            except Exception as e:
                logger.exception("Task %s failed: %s", task_id, e)
                state.status = "error"
                state.error = str(e)
                if state.publisher:
                    await state.publisher.publish(make_error(task_id, state.current_step, str(e)))

    async def _run_one(self, state: TaskState) -> None:
        state.status = "running"
        state.current_step = 0

        # 检查 cancel
        if state._cancel_event and state._cancel_event.is_set():
            state.status = "cancelled"
            return

        # 构造 LLM
        try:
            llm = _make_llm(self.llm)
        except Exception as e:
            raise AgentError(f"Failed to build LLM: {e}") from e

        # 构造 Browser (走 Obscura CDP)
        try:
            from browser_use import Agent, Browser
        except ImportError as e:
            raise AgentError(
                "browser-use not installed. Run: pip install browser-use"
            ) from e

        browser = Browser(cdp_url=self.bridge.cdp_url())

        # 构造 Agent
        agent = Agent(
            task=state.task_description,
            browser=browser,
            llm=llm,
        )

        # step 回调: 把 browser-use 的每步转换成 ReActStep
        async def on_step(browser_step) -> None:
            state.current_step += 1
            if not state.publisher:
                return
            # browser-use 的 step 模型依赖版本, 这里做兼容适配
            # v0.1+: step 包含 model_output (含 thought + action) 和 result
            try:
                thought = getattr(browser_step, "model_output", None)
                if thought:
                    # 思考
                    thinking = getattr(thought, "thinking", None) or getattr(thought, "reasoning", "")
                    if thinking:
                        await state.publisher.publish(make_thought(
                            state.task_id, state.current_step, str(thinking)[:1000],
                        ))
                    # 动作
                    action = getattr(thought, "action", None) or getattr(thought, "next_goal", "")
                    if action:
                        action_repr = _action_repr(action)
                        await state.publisher.publish(make_action(
                            state.task_id, state.current_step, action_repr,
                        ))
                # 观察
                result = getattr(browser_step, "result", None)
                if result:
                    content_parts = []
                    for item in result:
                        if hasattr(item, "extracted_content") and item.extracted_content:
                            content_parts.append(str(item.extracted_content))
                        elif hasattr(item, "error") and item.error:
                            content_parts.append(f"[error] {item.error}")
                    if content_parts:
                        await state.publisher.publish(make_observation(
                            state.task_id, state.current_step,
                            "\n".join(content_parts)[:2000],
                        ))
            except Exception as e:
                logger.debug("on_step serialization failed: %s", e)

        # 周期检查 cancel / pause
        async def watch_control():
            while state.status == "running":
                if state._cancel_event and state._cancel_event.is_set():
                    return "cancel"
                if state._pause_event and not state._pause_event.is_set():
                    state.status = "paused"
                    await state._pause_event.wait()
                    if state._cancel_event and state._cancel_event.is_set():
                        return "cancel"
                    state.status = "running"
                await asyncio.sleep(0.5)
            return state.status

        watcher = asyncio.create_task(watch_control())
        try:
            # 注册 step callback (browser-use 0.1+ 接受 step_callback)
            run_coro = agent.run(
                max_steps=self.agent_cfg.max_steps,
            )
            run_task = asyncio.create_task(run_coro)
            done, pending = await asyncio.wait(
                {run_task, watcher},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if watcher in done:
                result_state = watcher.result()
                if result_state == "cancel":
                    run_task.cancel()
                    state.status = "cancelled"
                    return
            else:
                # run 完成
                watcher.cancel()
                if not run_task.cancelled() and run_task.exception() is None:
                    history = run_task.result()
                    state.result = _extract_final_result(history)
                    state.status = "success"
                    if state.publisher:
                        await state.publisher.publish(make_final(state.task_id, state.result))
                else:
                    exc = run_task.exception() if not run_task.cancelled() else None
                    state.status = "error"
                    state.error = str(exc) if exc else "cancelled"
                    if state.publisher:
                        await state.publisher.publish(make_error(
                            state.task_id, state.current_step, state.error,
                        ))
        except Exception as e:
            logger.exception("Agent run failed: %s", e)
            state.status = "error"
            state.error = str(e)
            if state.publisher:
                await state.publisher.publish(make_error(state.task_id, state.current_step, str(e)))
        finally:
            watcher.cancel()
            state.publisher.close()


def _make_llm(cfg: LLMConfig):
    """根据 LLMConfig 构造 browser-use LLM 实例"""
    if not cfg.api_key:
        raise AgentError(
            "LLM API key missing. Set SOLOFORGE_LLM_API_KEY environment variable."
        )
    if cfg.provider == "google":
        from browser_use.llm import ChatGoogle
        return ChatGoogle(model=cfg.model, api_key=cfg.api_key)
    if cfg.provider == "openai":
        from browser_use.llm import ChatOpenAI
        kwargs = {"model": cfg.model, "api_key": cfg.api_key}
        if cfg.base_url:
            kwargs["base_url"] = cfg.base_url
        return ChatOpenAI(**kwargs)
    if cfg.provider == "anthropic":
        from browser_use.llm import ChatAnthropic
        return ChatAnthropic(model=cfg.model, api_key=cfg.api_key)
    raise AgentError(f"Unknown LLM provider: {cfg.provider}")


def _action_repr(action) -> str:
    """把 browser-use 的 action 对象序列化成可读字符串"""
    if isinstance(action, str):
        return action
    if isinstance(action, list):
        parts = []
        for a in action:
            parts.append(_action_repr(a))
        return " | ".join(parts)
    if hasattr(action, "model_dump"):
        try:
            d = action.model_dump(exclude_none=True)
            return _format_dict(d)
        except Exception:
            pass
    if hasattr(action, "__dict__"):
        return _format_dict({k: v for k, v in action.__dict__.items() if not k.startswith("_")})
    return str(action)


def _format_dict(d: dict, depth: int = 0) -> str:
    if depth > 2:
        return "{...}"
    parts = []
    for k, v in d.items():
        if isinstance(v, dict):
            parts.append(f"{k}={_format_dict(v, depth+1)}")
        elif isinstance(v, str) and len(v) > 60:
            parts.append(f"{k}='{v[:57]}...'")
        else:
            parts.append(f"{k}={v}")
    return ", ".join(parts)


def _extract_final_result(history) -> str:
    """从 browser-use 的 history 里抽最终结果"""
    if history is None:
        return ""
    if isinstance(history, str):
        return history
    if hasattr(history, "final_result"):
        return str(history.final_result() or "")
    if hasattr(history, "is_done") and callable(history.is_done) and history.is_done():
        if hasattr(history, "extracted_content"):
            return str(history.extracted_content() or "")
    # 退路: 拿最后一步
    if hasattr(history, "history") and history.history:
        last = history.history[-1]
        if hasattr(last, "result") and last.result:
            for r in last.result:
                if hasattr(r, "extracted_content") and r.extracted_content:
                    return str(r.extracted_content)
    return ""
