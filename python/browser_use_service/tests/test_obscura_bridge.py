"""obscura_bridge 集成测试 (需要 obscura.exe, 默认跳过)

执行: pytest python/browser_use_service/tests/test_obscura_bridge.py --run-integration
"""
import os
import sys
import pytest

from browser_use_service.obscura_bridge import ObscuraBridge, ObscuraStartupError
from browser_use_service.config import ObscuraConfig

# 默认跳过 (需要真正的 Obscura 二进制)
pytestmark = pytest.mark.skipif(
    "--run-integration" not in sys.argv,
    reason="integration test, use --run-integration to enable",
)


@pytest.fixture
def obscura_cfg():
    # 默认用项目内置 Windows 二进制
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))
    binary = os.path.join(repo_root, "UI", "resources", "tools", "obscura", "bin", "obscura.exe")
    if not os.path.exists(binary):
        binary = "obscura"
    return ObscuraConfig(
        binary_path=binary,
        port=19222,  # 避开默认 9222
        stealth=False,  # 测试时关 stealth 加速启动
        startup_timeout_s=20.0,
        startup_retries=1,
    )


@pytest.mark.asyncio
async def test_bridge_start_stop(obscura_cfg):
    bridge = ObscuraBridge(obscura_cfg)
    try:
        await bridge.start()
        assert bridge.is_running()
        assert await bridge.health_check()
        await bridge.wait_for_ws()
    finally:
        await bridge.stop()
    assert not bridge.is_running()


@pytest.mark.asyncio
async def test_bridge_double_start_is_idempotent(obscura_cfg):
    bridge = ObscuraBridge(obscura_cfg)
    try:
        await bridge.start()
        await bridge.start()  # 第二次不应报错
        assert bridge.is_running()
    finally:
        await bridge.stop()


@pytest.mark.asyncio
async def test_bridge_cdp_url():
    cfg = ObscuraConfig(host="10.0.0.1", port=9999)
    bridge = ObscuraBridge(cfg)
    assert bridge.cdp_url() == "ws://10.0.0.1:9999"
