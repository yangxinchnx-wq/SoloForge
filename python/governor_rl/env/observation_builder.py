# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Observation Builder
# Path: python/governor_rl/env/observation_builder.py
#
# Observation Schema (冻结):
# 0: queue_depth (归一化)
# 1: queue_velocity (归一化)
# 2: queue_acceleration (归一化)
# 3: worker_count (归一化)
# 4: cpu_usage (归一化)
# 5: precursor_score (归一化)
# 6: risk_score (归一化)
# 7: oscillation_score (归一化)
# 8: regime_id (one-hot 或连续)
# ─────────────────────────────────────────────────────────────────

import numpy as np
from typing import Dict, Any

# 归一化常量
QUEUE_NORMALIZATION = 1000.0  # queue > 1000 视为高负载
WORKER_NORMALIZATION = 200.0   # worker > 200 视为高负载
VELOCITY_NORMALIZATION = 100.0  # velocity > 100 视为快速变化


class ObservationBuilder:
    """
    Observation Builder

    将 Runtime 状态转换为神经网络输入
    """

    def __init__(self):
        # 历史数据用于计算导数
        self.queue_history = []
        self.worker_history = []
        self.max_history = 20

    def reset(self):
        """重置历史"""
        self.queue_history = []
        self.worker_history = []

    def build(
        self,
        queue_depth: int,
        worker_count: int,
        cpu_usage: float,
        precursor_score: float = 0.0,
        risk_score: float = 0.0,
        oscillation_score: float = 0.0,
        regime: str = "balanced",
    ) -> np.ndarray:
        """
        构建 Observation

        Returns:
            np.ndarray: shape=(9,), dtype=np.float32
        """
        # 更新历史
        self.queue_history.append(queue_depth)
        self.worker_history.append(worker_count)

        if len(self.queue_history) > self.max_history:
            self.queue_history.pop(0)
        if len(self.worker_history) > self.max_history:
            self.worker_history.pop(0)

        # 计算 velocity 和 acceleration
        queue_velocity = self._compute_velocity(self.queue_history)
        queue_acceleration = self._compute_acceleration(self.queue_history)

        # 编码 regime
        regime_id = self._encode_regime(regime)

        # 构建 observation
        obs = np.array([
            queue_depth / QUEUE_NORMALIZATION,      # 0: queue_depth
            queue_velocity / VELOCITY_NORMALIZATION,  # 1: queue_velocity
            queue_acceleration / VELOCITY_NORMALIZATION,  # 2: queue_acceleration
            worker_count / WORKER_NORMALIZATION,   # 3: worker_count
            cpu_usage,                             # 4: cpu_usage (already 0-1)
            precursor_score,                       # 5: precursor_score (0-1)
            risk_score,                            # 6: risk_score (0-1)
            oscillation_score,                     # 7: oscillation_score (0-1)
            regime_id,                           # 8: regime_id (0-1)
        ], dtype=np.float32)

        return obs

    def _compute_velocity(self, history: list) -> float:
        """计算 queue 变化率"""
        if len(history) < 2:
            return 0.0
        return float(history[-1] - history[-2])

    def _compute_acceleration(self, history: list) -> float:
        """计算 queue 加速度"""
        if len(history) < 3:
            return 0.0
        v1 = history[-1] - history[-2]
        v2 = history[-2] - history[-3]
        return float(v1 - v2)

    def _encode_regime(self, regime: str) -> float:
        """编码 regime 为连续值"""
        regime_map = {
            "healthy": 0.0,
            "balanced": 0.2,
            "oscillating": 0.4,
            "over_responsive": 0.6,
            "under_responsive": 0.8,
            "critical": 1.0,
        }
        return regime_map.get(regime, 0.5)

    def get_observation_dim(self) -> int:
        """返回 observation 维度"""
        return 9
