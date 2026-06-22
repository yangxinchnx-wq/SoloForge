"""config 单元测试"""
import os
import pytest

from browser_use_service.config import (
    LLMConfig, ObscuraConfig, AgentConfig, RuntimeConfig,
)


def test_llm_config_from_env_google(monkeypatch):
    monkeypatch.setenv("SOLOFORGE_LLM_PROVIDER", "google")
    monkeypatch.setenv("SOLOFORGE_LLM_API_KEY", "test-google-key")
    monkeypatch.setenv("SOLOFORGE_LLM_MODEL", "gemini-2.5-pro")
    cfg = LLMConfig.from_env()
    assert cfg.provider == "google"
    assert cfg.api_key == "test-google-key"
    assert cfg.model == "gemini-2.5-pro"


def test_llm_config_from_env_fallback(monkeypatch):
    monkeypatch.delenv("SOLOFORGE_LLM_API_KEY", raising=False)
    monkeypatch.delenv("SOLOFORGE_LLM_PROVIDER", raising=False)
    monkeypatch.setenv("GOOGLE_API_KEY", "fallback-google")
    cfg = LLMConfig.from_env()
    assert cfg.api_key == "fallback-google"


def test_obscura_config_defaults(monkeypatch):
    monkeypatch.delenv("SOLOFORGE_OBSCURA_PORT", raising=False)
    monkeypatch.delenv("SOLOFORGE_OBSCURA_STEALTH", raising=False)
    cfg = ObscuraConfig.from_env()
    assert cfg.port == 9222
    assert cfg.host == "127.0.0.1"
    assert cfg.stealth is True


def test_obscura_stealth_disable(monkeypatch):
    monkeypatch.setenv("SOLOFORGE_OBSCURA_STEALTH", "0")
    cfg = ObscuraConfig.from_env()
    assert cfg.stealth is False


def test_obscura_cdp_url():
    cfg = ObscuraConfig(host="127.0.0.1", port=9333)
    assert cfg.cdp_url() == "ws://127.0.0.1:9333"


def test_agent_config_defaults(monkeypatch):
    monkeypatch.delenv("SOLOFORGE_BU_MAX_STEPS", raising=False)
    cfg = AgentConfig.from_env()
    assert cfg.max_steps == 25
    assert cfg.use_vision is True


def test_runtime_load_combines_all(monkeypatch):
    monkeypatch.setenv("SOLOFORGE_LLM_API_KEY", "k")
    monkeypatch.setenv("SOLOFORGE_OBSCURA_PORT", "9555")
    rt = RuntimeConfig.load()
    assert rt.llm.api_key == "k"
    assert rt.obscura.port == 9555
    assert rt.agent.max_steps > 0
