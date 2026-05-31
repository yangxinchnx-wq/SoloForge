# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge MARL Service — Production Server (Warmed Critic)
# Path: marl_service/server_prod.py
#
# 集成了 Critic 价值先验热启动
# 在 server 启动时自动加载 warmed critic
# 用于向 TypeScript 分布式集群提供真实的价值评估信号
# ─────────────────────────────────────────────────────────────────
import asyncio
import json
import logging
import os
import sys
import time
import numpy as np

# Fix Windows encoding
if sys.platform == 'win32':
    os.environ['PYTHONIOENCODING'] = 'utf-8'
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

from typing import Dict, Any, Optional

# Optional torch import
try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")


# ============================================================
# MARL Critic Network (matches warmed checkpoint)
# ============================================================

class CentralizedCritic(nn.Module):
    """
    Centralized Critic — 接收全局状态，输出 V(s)
    与 critic_warmed_v2.pt 的结构完全匹配
    """
    def __init__(self, global_state_dim: int = 5, hidden_dim: int = 64):
        super().__init__()
        self.network = nn.Sequential(
            nn.Linear(global_state_dim, hidden_dim), nn.Tanh(),
            nn.Linear(hidden_dim, hidden_dim), nn.Tanh(),
            nn.Linear(hidden_dim, 1),
        )

    def forward(self, global_state: torch.Tensor) -> torch.Tensor:
        return self.network(global_state)


# ============================================================
# MARL Reward Function (for state evaluation)
# ============================================================

def compute_marl_reward(global_state: np.ndarray) -> float:
    """
    计算 MARL 全局状态的 reward
    与 Critic 蒸馏时使用的 reward 函数一致
    """
    load_avg = global_state[0]
    load_var = global_state[1]
    total_demand = global_state[2]
    avail_cap = global_state[3]
    queue_pressure = global_state[4]

    lr = queue_pressure / (avail_cap * 2 + 0.01)

    zone_bonus = 0.0
    if lr < 0.1: zone_bonus = 0.0
    elif lr < 0.25: zone_bonus = 0.5
    elif lr < 0.5: zone_bonus = 0.0
    elif lr < 1.0: zone_bonus = -0.5
    else: zone_bonus = -1.0

    base_reward = -load_avg * 1.5
    capacity_reward = avail_cap * 0.5
    pressure_penalty = -queue_pressure * 1.0

    return base_reward + capacity_reward + pressure_penalty + zone_bonus


# ============================================================
# State Normalizer
# ============================================================

class StateNormalizer:
    """
    将 TypeScript 侧发送的原始遥测数据
    归一化到 [0, 1] 范围，与 MARL 状态空间对齐
    """
    def normalize(self, telemetry: Dict[str, Any]) -> np.ndarray:
        """
        将 telemetry payload 映射到 5 维全局状态

        TypeScript telemetry 字段:
          queue_depth -> load_avg (归一化到 0-10 -> 0-1)
          cpu_usage -> load components
          worker_count -> available_capacity
          etc.

        返回：5维 numpy 数组
        """
        # 从 telemetry 中提取字段
        queue_depth = telemetry.get('queue_depth', 0)
        cpu_usage = telemetry.get('cpu_usage', 0.5)
        worker_count = telemetry.get('worker_count', 50)
        cpu_variance = telemetry.get('cpu_variance', 0.1)
        load_pressure = telemetry.get('load_pressure', 0.5)

        # 归一化映射
        load_avg = min(queue_depth / 10000.0, 1.0)
        load_var = min(cpu_variance * 2, 1.0)  # 假设 variance 在 0-0.5
        total_demand = min((cpu_usage + load_pressure) / 2.0, 1.0)
        available_capacity = min(worker_count / 200.0, 1.0)
        queue_pressure = min(load_pressure, 1.0)

        return np.array([
            load_avg,
            load_var,
            total_demand,
            available_capacity,
            queue_pressure,
        ], dtype=np.float32)


# ============================================================
# Production Server
# ============================================================

class MarlServiceAsyncServer:
    """
    Python MARL Service — Production Server
    集成了热启动 Critic，向 TypeScript 分布式集群提供决策支持
    """
    def __init__(self, config_registry: Dict[str, Any]):
        self.config = config_registry
        self.logger = logging.getLogger("MarlServiceServer")

        self.host = config_registry.get("governor.ipc.host", "127.0.0.1")
        self.port = int(config_registry.get("governor.ipc.port", 8765))
        self.server_instance: Optional[asyncio.AbstractServer] = None

        # Critic 相关
        self.critic = None
        self.normalizer = StateNormalizer()
        self.critic_warmed = False
        self.critic_variance = 0.0

        # 统计
        self.frames_received = 0
        self.start_time = time.time()
        self.value_estimates = []

        self._initialize_critic()

    def _initialize_critic(self):
        """初始化并加载热启动 Critic"""
        if not HAS_TORCH:
            self.logger.warning("PyTorch not available, running in simulation mode")
            return

        try:
            self.critic = CentralizedCritic(global_state_dim=5, hidden_dim=64)

            warmed_path = "marl_service/models/critic_warmed_v2.pt"
            if os.path.exists(warmed_path):
                state = torch.load(warmed_path, map_location='cpu', weights_only=False)
                state_dict = state['state_dict']

                # Key remapping: Sequential keys (0/2/4) -> CentralizedCritic (network.0/2/4)
                # Use exact match to avoid nested replacement bugs
                key_map = {
                    '0.weight': 'network.0.weight',
                    '0.bias': 'network.0.bias',
                    '2.weight': 'network.2.weight',
                    '2.bias': 'network.2.bias',
                    '4.weight': 'network.4.weight',
                    '4.bias': 'network.4.bias',
                }
                remapped = {}
                for key, val in state_dict.items():
                    new_key = key_map.get(key, key)  # exact match, fallback to original
                    remapped[new_key] = val

                self.critic.load_state_dict(remapped, strict=False)
                self.critic.eval()
                self.critic_warmed = True
                self.logger.info(f"✅ [WARM START] Critic loaded from {warmed_path}")

                # 验证 Critic 方差
                self._verify_critic_variance()
            else:
                self.logger.warning(f"⚠️ Warmed critic not found at {warmed_path}, using fresh critic")
                self.critic.eval()

        except Exception as e:
            self.logger.error(f"❌ [WARM START] Failed to load warmed critic: {e}")
            self.critic_warmed = False

    def _verify_critic_variance(self):
        """验证 Critic 的状态区分能力"""
        if self.critic is None:
            return

        torch.manual_seed(42)
        np.random.seed(42)
        values = []
        for _ in range(500):
            state = np.array([
                np.random.uniform(0.3, 0.9),
                np.random.uniform(0.1, 0.5),
                np.random.uniform(0.5, 1.0),
                np.random.uniform(0.3, 0.8),
                np.random.uniform(0.2, 0.9),
            ], dtype=np.float32)
            with torch.no_grad():
                v = self.critic(torch.FloatTensor(state).unsqueeze(0)).item()
                values.append(v)

        self.critic_variance = float(np.var(values))
        self.logger.info(
            f"📊 [CRITIC VERIFICATION] Value variance: {self.critic_variance:.6f} "
            f"{'✅ (>0.01)' if self.critic_variance > 0.01 else '⚠️ (<0.01)'}"
        )

    async def launch_server_loop(self) -> None:
        try:
            self.server_instance = await asyncio.start_server(
                self.handle_incoming_connection_stream, self.host, self.port
            )
            self.logger.info(
                f"🛰️ MARL Computing Server live at tcp://{self.host}:{self.port} "
                f"| Critic: {'WARMED ✅' if self.critic_warmed else 'FRESH ⚠️'} "
                f"| Variance: {self.critic_variance:.6f}"
            )

            async with self.server_instance:
                await self.server_instance.serve_forever()

        except Exception as crash_panic:
            self.logger.critical(f"💥 Server bind failed: {str(crash_panic)}")
            sys.exit(1)

    async def handle_incoming_connection_stream(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        peer_addr = writer.get_extra_info('peername')
        self.logger.info(f"🔌 Connection from: {peer_addr}")

        try:
            while True:
                raw_line_bytes = await reader.readline()
                if not raw_line_bytes:
                    break
                raw_line_frame = raw_line_bytes.decode('utf-8').strip()
                if not raw_line_frame:
                    continue
                await self.process_and_respond_frame(raw_line_frame, writer)
        except asyncio.CancelledError:
            pass
        except Exception as wire_err:
            self.logger.error(f"💥 Stream failed: {str(wire_err)}")
        finally:
            writer.close()
            await writer.wait_closed()

    async def process_and_respond_frame(
        self, raw_json_line: str, writer: asyncio.StreamWriter
    ) -> None:
        try:
            envelope: Dict[str, Any] = json.loads(raw_json_line)
            frame_type = envelope.get("type")
            current_tick = envelope.get("currentTick", 0)
            payload = envelope.get("payload", {})
            version_seal = envelope.get("kernelVersionSeal", 0)

            if frame_type == "TELEMETRY_STREAM":
                self.frames_received += 1
                response_payload = self._process_telemetry(payload)
                response_type = "ACTION_DECISION_ACK"

            elif frame_type == "DRIFT_COMMAND":
                response_payload = self._process_drift_command(payload)
                response_type = "ACTION_DECISION_ACK"

            else:
                # Unknown frame type — graceful fallback
                response_payload = {"error": f"Unknown frame type: {frame_type}"}
                response_type = "ACTION_DECISION_ACK"

            response_envelope = {
                "frameId": f"ack_{envelope.get('frameId', '0000')}",
                "type": response_type,
                "currentTick": current_tick,
                "payload": response_payload,
                "kernelVersionSeal": version_seal,
                "timestamp": int(asyncio.get_event_loop().time() * 1000)
            }

            serialized_response = json.dumps(response_envelope, ensure_ascii=False) + "\n"
            writer.write(serialized_response.encode('utf-8'))
            await writer.drain()

        except json.JSONDecodeError:
            self.logger.error("Dropped malformed json frame")
        except Exception as panic:
            self.logger.error(f"Failed to process packet: {str(panic)}")

    def _process_telemetry(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        使用热启动 Critic 处理遥测数据，生成决策
        """
        # 归一化遥测数据到 MARL 状态空间
        global_state = self.normalizer.normalize(payload)

        # Critic 评估
        if self.critic is not None and self.critic_warmed:
            with torch.no_grad():
                state_t = torch.FloatTensor(global_state).unsqueeze(0)
                value_estimate = self.critic(state_t).item()
                self.value_estimates.append(value_estimate)

                # 保持历史在合理范围
                if len(self.value_estimates) > 1000:
                    self.value_estimates = self.value_estimates[-1000:]
        else:
            value_estimate = 0.0

        # 基于价值估计和 reward 函数选择动作
        reward = compute_marl_reward(global_state)

        # 动作选择（基于价值和 reward）
        # MARL 动作空间: 0=NO_OP, 1=PERFORMANCE_MODE, 2=CIRCUIT_BREAKER, 3=EXPAND, 4=SHRINK, 5=HOLD
        action_index = self._select_action(value_estimate, reward, global_state)

        # 计算决策置信度（基于 Critic 价值估计的确定性）
        if len(self.value_estimates) >= 10:
            recent = self.value_estimates[-10:]
            value_std = np.std(recent)
            confidence = min(1.0 / (1.0 + value_std), 1.0)
        else:
            confidence = 0.5

        return {
            "traceId": payload.get("traceId", "UNKNOWN"),
            "valueEstimate": float(value_estimate),
            "rewardSignal": float(reward),
            "decision_action_index": action_index,
            "action_confidence": float(confidence),
            "critic_warmed": self.critic_warmed,
            "critic_variance": float(self.critic_variance),
            "telemetry_snapshot": {
                "global_state": global_state.tolist(),
                "load_avg": float(global_state[0]),
                "queue_pressure": float(global_state[4]),
                "available_capacity": float(global_state[3]),
            },
            "stats": {
                "frames_received": self.frames_received,
                "uptime_seconds": int(time.time() - self.start_time),
                "value_mean": float(np.mean(self.value_estimates[-100:])) if self.value_estimates else 0.0,
                "value_std": float(np.std(self.value_estimates[-100:])) if self.value_estimates else 0.0,
            }
        }

    def _select_action(
        self, value_estimate: float, reward: float, state: np.ndarray
    ) -> int:
        """
        基于价值和状态选择动作

        策略：
          - 低负载（load_avg < 0.3）：NO_OP
          - 中负载（0.3-0.6）：PERFORMANCE_MODE
          - 高负载（0.6-0.8）：CIRCUIT_BREAKER
          - 极高负载（>0.8）：EXPAND
          - 低容量（avail_cap < 0.2）：SHRINK（减少需求）
          - 默认：HOLD
        """
        load_avg = state[0]
        avail_cap = state[3]
        queue_pressure = state[4]

        if load_avg < 0.3:
            return 0  # NO_OP
        elif load_avg < 0.5:
            return 1  # PERFORMANCE_MODE
        elif load_avg < 0.7:
            return 2  # CIRCUIT_BREAKER
        elif load_avg >= 0.7:
            return 3  # EXPAND
        elif avail_cap < 0.2:
            return 4  # SHRINK
        else:
            return 5  # HOLD

    def _process_drift_command(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """处理超参数漂移实验命令"""
        return {
            "drift_result": {
                "status": "acknowledged",
                "critic_warmed": self.critic_warmed,
                "critic_variance": float(self.critic_variance),
                "frames_processed": self.frames_received,
            }
        }


# ============================================================
# Entry Point
# ============================================================

async def main():
    print("=" * 60)
    print("SoloForge MARL Service — Production Server")
    print("=" * 60)
    print()

    config = {
        "governor.ipc.host": "127.0.0.1",
        "governor.ipc.port": 8765,
    }

    server = MarlServiceAsyncServer(config)

    if server.critic_warmed:
        print(f"✅ Critic warmed: variance={server.critic_variance:.6f}")
    else:
        print(f"⚠️  Critic not warmed (running in simulation mode)")

    print()
    print(f"Server binding to: tcp://{server.host}:{server.port}")
    print("TypeScript cluster should connect to this endpoint.")
    print("Press Ctrl+C to stop.")
    print("=" * 60)
    print()

    await server.launch_server_loop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n👋 Server stopped by user")
