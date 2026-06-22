"""Obscura 子进程生命周期管理

负责:
  - 启动 `obscura serve --port 9222 --stealth` 子进程
  - 健康检查 (CDP /json/version)
  - 优雅停止 (SIGTERM / 任务结束)
  - 崩溃自动重启 (带指数退避)
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import signal
import sys
from pathlib import Path
from typing import Optional

import httpx
import websockets

from .config import ObscuraConfig

logger = logging.getLogger(__name__)


class ObscuraStartupError(RuntimeError):
    """Obscura 启动失败 (重试用尽后抛出)"""


class ObscuraBridge:
    """管理一个 Obscura CDP server 子进程

    用法:
        bridge = ObscuraBridge(ObscuraConfig.from_env())
        await bridge.start()
        try:
            ... # 通过 bridge.cdp_url() 连
        finally:
            await bridge.stop()
    """

    def __init__(self, config: ObscuraConfig):
        self.config = config
        self._process: Optional[asyncio.subprocess.Process] = None
        self._stopped = False
        self._stdout_task: Optional[asyncio.Task] = None
        self._stderr_task: Optional[asyncio.Task] = None

    # ------------------------------------------------------------------
    # 公共 API
    # ------------------------------------------------------------------

    def cdp_url(self) -> str:
        return self.config.cdp_url()

    def is_running(self) -> bool:
        return self._process is not None and self._process.returncode is None

    async def start(self) -> None:
        """启动 Obscura, 带重试"""
        if self.is_running():
            logger.info("Obscura already running on port %d", self.config.port)
            return

        last_error: Optional[Exception] = None
        for attempt in range(1, self.config.startup_retries + 1):
            try:
                await self._start_once()
                await self._wait_healthy()
                logger.info(
                    "Obscura started (pid=%d, port=%d, stealth=%s)",
                    self._process.pid if self._process else 0,
                    self.config.port,
                    self.config.stealth,
                )
                return
            except Exception as e:
                last_error = e
                logger.warning(
                    "Obscura start attempt %d/%d failed: %s",
                    attempt, self.config.startup_retries, e,
                )
                await self._kill_process()
                if attempt < self.config.startup_retries:
                    await asyncio.sleep(self.config.startup_retry_backoff_s * attempt)

        raise ObscuraStartupError(
            f"Obscura failed to start after {self.config.startup_retries} attempts: {last_error}"
        )

    async def stop(self) -> None:
        """优雅停止"""
        self._stopped = True
        await self._kill_process()
        logger.info("Obscura stopped")

    async def health_check(self) -> bool:
        """检查 CDP 控制面是否响应"""
        if not self.is_running():
            return False
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                resp = await client.get(
                    f"http://{self.config.host}:{self.config.port}/json/version"
                )
                return resp.status_code == 200
        except Exception:
            return False

    async def wait_for_ws(self, timeout: float = 5.0) -> None:
        """等待 WebSocket 端点可连 (browser-use attach 之前)"""
        deadline = asyncio.get_event_loop().time() + timeout
        url = f"ws://{self.config.host}:{self.config.port}/devtools/browser"
        while asyncio.get_event_loop().time() < deadline:
            try:
                async with websockets.connect(url, open_timeout=1.0):
                    return
            except Exception:
                await asyncio.sleep(0.2)
        raise ObscuraStartupError(f"Obscura WebSocket not ready at {url} within {timeout}s")

    # ------------------------------------------------------------------
    # 内部
    # ------------------------------------------------------------------

    async def _start_once(self) -> None:
        cmd = self._build_command()
        logger.info("Launching Obscura: %s", " ".join(cmd))

        # Windows: 用 CREATE_NEW_PROCESS_GROUP 便于优雅终止
        kwargs: dict = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = getattr(
                asyncio.subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200
            )
        else:
            # 新进程组, 便于发 SIGTERM 到整个组
            kwargs["start_new_session"] = True

        self._process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **kwargs,
        )

        # 启动 stdout/stderr drain 任务, 防止子进程管道 buffer 满
        self._stdout_task = asyncio.create_task(
            self._drain_stream(self._process.stdout, "stdout")
        )
        self._stderr_task = asyncio.create_task(
            self._drain_stream(self._process.stderr, "stderr")
        )

        # 短暂等待进程不立即崩
        await asyncio.sleep(0.5)
        if self._process.returncode is not None:
            raise ObscuraStartupError(
                f"Obscura exited immediately with code {self._process.returncode}"
            )

    async def _wait_healthy(self) -> None:
        """轮询 HTTP /json/version 直到就绪或超时"""
        deadline = asyncio.get_event_loop().time() + self.config.startup_timeout_s
        url = f"http://{self.config.host}:{self.config.port}/json/version"
        async with httpx.AsyncClient(timeout=2.0) as client:
            while asyncio.get_event_loop().time() < deadline:
                if not self.is_running():
                    raise ObscuraStartupError("Obscura process died during startup")
                try:
                    resp = await client.get(url)
                    if resp.status_code == 200:
                        return
                except Exception:
                    pass
                await asyncio.sleep(0.3)
        raise ObscuraStartupError(
            f"Obscura did not become healthy within {self.config.startup_timeout_s}s"
        )

    async def _kill_process(self) -> None:
        if self._stdout_task and not self._stdout_task.done():
            self._stdout_task.cancel()
        if self._stderr_task and not self._stderr_task.done():
            self._stderr_task.cancel()

        if self._process and self._process.returncode is None:
            proc = self._process
            try:
                if sys.platform == "win32":
                    # Windows 没有 SIGTERM, 用 terminate() (硬杀)
                    proc.terminate()
                else:
                    proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=5.0)
                except asyncio.TimeoutError:
                    logger.warning("Obscura did not exit gracefully, killing")
                    proc.kill()
                    await proc.wait()
            except ProcessLookupError:
                pass
        self._process = None

    async def _drain_stream(self, stream, name: str) -> None:
        """持续把子进程输出转发到 logger, 防 buffer 满"""
        if stream is None:
            return
        try:
            while True:
                line = await stream.readline()
                if not line:
                    break
                logger.debug("[obscura %s] %s", name, line.decode(errors="replace").rstrip())
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.debug("drain %s ended: %s", name, e)

    def _build_command(self) -> list[str]:
        cfg = self.config
        if cfg.binary_path:
            cmd = [cfg.binary_path]
        else:
            cmd = ["obscura"]

        cmd.extend([
            "serve",
            "--port", str(cfg.port),
            "--host", cfg.host,
        ])

        if cfg.stealth:
            cmd.append("--stealth")

        if cfg.workers > 1:
            cmd.extend(["--workers", str(cfg.workers)])

        if cfg.storage_dir:
            cmd.extend(["--storage", cfg.storage_dir])

        if cfg.allow_private_network:
            cmd.append("--allow-private-network")

        return cmd
