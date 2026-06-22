"""配置加载: LLM 凭据 / stealth / 端口 / Obscura 路径

来源优先级 (高 → 低):
  1. 环境变量 (SOLOFORGE_BROWSER_USE_*)
  2. 启动参数 (server.py 入口覆盖)
  3. 内置默认值
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal


@dataclass(frozen=True)
class LLMConfig:
    """LLM 凭据配置

    provider:
      - "google"   — Google Gemini (SoloForge 默认, 复用 @google/genai 凭据)
      - "openai"   — OpenAI / OpenAI 兼容
      - "anthropic" — Anthropic Claude
    """
    provider: Literal["google", "openai", "anthropic"] = "google"
    api_key: str = ""
    model: str = "gemini-2.0-flash"
    base_url: str | None = None  # 仅 openai / 自托管场景

    @classmethod
    def from_env(cls) -> "LLMConfig":
        provider = os.environ.get("SOLOFORGE_LLM_PROVIDER", "google")
        api_key = (
            os.environ.get("SOLOFORGE_LLM_API_KEY")
            or os.environ.get("GOOGLE_API_KEY")
            or os.environ.get("OPENAI_API_KEY")
            or os.environ.get("ANTHROPIC_API_KEY")
            or ""
        )
        model = os.environ.get("SOLOFORGE_LLM_MODEL") or _default_model(provider)
        base_url = os.environ.get("SOLOFORGE_LLM_BASE_URL")
        return cls(provider=provider, api_key=api_key, model=model, base_url=base_url)


def _default_model(provider: str) -> str:
    return {
        "google": "gemini-2.0-flash",
        "openai": "gpt-4o",
        "anthropic": "claude-3-5-sonnet-latest",
    }.get(provider, "gemini-2.0-flash")


@dataclass(frozen=True)
class ObscuraConfig:
    """Obscura 子进程启动配置"""
    binary_path: str = ""  # 空 = 用 `obscura` 走 PATH
    port: int = 9222
    host: str = "127.0.0.1"
    stealth: bool = True
    workers: int = 1
    storage_dir: str = ""  # 空 = 不持久化 cookies/profile
    allow_private_network: bool = False
    # 启动失败重试
    startup_timeout_s: float = 30.0
    startup_retries: int = 3
    startup_retry_backoff_s: float = 2.0

    @classmethod
    def from_env(cls) -> "ObscuraConfig":
        # 默认 Windows 路径 (Electron userData)
        default_path = _default_obscura_binary()
        return cls(
            binary_path=os.environ.get("SOLOFORGE_OBSCURA_BINARY", default_path),
            port=int(os.environ.get("SOLOFORGE_OBSCURA_PORT", "9222")),
            host=os.environ.get("SOLOFORGE_OBSCURA_HOST", "127.0.0.1"),
            stealth=os.environ.get("SOLOFORGE_OBSCURA_STEALTH", "1") not in ("0", "false", "no"),
            workers=int(os.environ.get("SOLOFORGE_OBSCURA_WORKERS", "1")),
            storage_dir=os.environ.get("SOLOFORGE_OBSCURA_STORAGE", ""),
            allow_private_network=os.environ.get("SOLOFORGE_OBSCURA_PRIVATE_NET", "0") in ("1", "true"),
        )

    def cdp_url(self) -> str:
        return f"ws://{self.host}:{self.port}"


def _default_obscura_binary() -> str:
    """根据平台返回默认 Obscura 二进制路径"""
    # SoloForge 项目内的 windows 二进制
    repo_root = Path(__file__).resolve().parents[2]
    candidates = [
        repo_root / "UI" / "resources" / "tools" / "obscura" / "bin" / "obscura.exe",
        repo_root / "UI" / "resources" / "tools" / "obscura" / "bin" / "obscura",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    return "obscura"  # 退到 PATH 查找


@dataclass(frozen=True)
class AgentConfig:
    """Browser-Use Agent 行为配置"""
    max_steps: int = 25
    step_timeout_s: float = 60.0
    use_vision: bool = True
    # 失败时是否自动截图
    screenshot_on_error: bool = True

    @classmethod
    def from_env(cls) -> "AgentConfig":
        return cls(
            max_steps=int(os.environ.get("SOLOFORGE_BU_MAX_STEPS", "25")),
            step_timeout_s=float(os.environ.get("SOLOFORGE_BU_STEP_TIMEOUT", "60")),
            use_vision=os.environ.get("SOLOFORGE_BU_USE_VISION", "1") not in ("0", "false"),
            screenshot_on_error=os.environ.get("SOLOFORGE_BU_SCREENSHOT_ON_ERROR", "1") not in ("0", "false"),
        )


@dataclass
class RuntimeConfig:
    """运行时总配置, 包含上面三块"""
    llm: LLMConfig = field(default_factory=LLMConfig)
    obscura: ObscuraConfig = field(default_factory=ObscuraConfig)
    agent: AgentConfig = field(default_factory=AgentConfig)

    @classmethod
    def load(cls) -> "RuntimeConfig":
        return cls(
            llm=LLMConfig.from_env(),
            obscura=ObscuraConfig.from_env(),
            agent=AgentConfig.from_env(),
        )
