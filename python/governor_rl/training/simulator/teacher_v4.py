# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Teacher V4
# Path: governor_rl/training/simulator/teacher_v4.py
#
# Sprint 2E: Active Balance Governor
#
# 目标: 覆盖完整 5-action 空间
# - 基于 queue/worker_ratio 的平衡策略
# - 在低负载时主动缩容
# - 在高负载时主动扩容
# ─────────────────────────────────────────────────────────────────

import sys
import os
from typing import Optional, Tuple

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)


class TeacherV4:
    """
    Active Balance Governor V4

    核心策略: queue / (worker_count * 2) 比率决定动作

    动作选择 (基于 load_ratio):
    - ratio < 0.05: shrink2 (极度空闲)
    - ratio < 0.15: shrink1 (轻度空闲)
    - ratio < 0.6:  noop (稳定)
    - ratio < 1.2:  expand1 (轻度过载)
    - ratio >= 1.2: expand2 (严重过载)

    特点:
    - 主动缩容，在 queue 很小时减少 worker
    - 主动扩容，在 queue 很大时增加 worker
    - 覆盖完整 5-action 空间
    """

    # Cooldown (防止震荡)
    EXPAND_COOLDOWN = 8
    SHRINK_COOLDOWN = 12

    def __init__(self):
        # State
        self.queue_history = []
        self.action_history = []
        self.last_expand_tick = -100
        self.last_shrink_tick = -100
        self.tick = 0

        # Statistics
        self.action_counts = {i: 0 for i in range(-2, 3)}
        self.zone_counts = {"A": 0, "B": 0, "C": 0, "D": 0, "E": 0}

    def reset(self):
        """重置状态"""
        self.queue_history = []
        self.action_history = []
        self.last_expand_tick = -100
        self.last_shrink_tick = -100
        self.tick = 0

    def decide(self, queue_depth: int, worker_count: int = None) -> int:
        """
        决定动作

        策略：基于 load_ratio (queue_depth / capacity) 做决策

        Args:
            queue_depth: 当前队列深度
            worker_count: 当前 worker 数量

        Returns:
            action_value: -2, -1, 0, +1, 或 +2
        """
        self.tick += 1

        # 如果没有 worker_count，假设一个合理的值
        if worker_count is None or worker_count <= 0:
            worker_count = 200

        # 计算 load_ratio
        capacity = worker_count * 2  # base_rate = 2
        load_ratio = queue_depth / max(1, capacity)

        # 基于 load_ratio 决定动作
        if load_ratio < 0.1:
            # 低负载: shrink2
            action = -2
        elif load_ratio < 0.25:
            # 轻度负载: shrink1
            action = -1
        elif load_ratio < 0.5:
            # 稳定区: noop
            action = 0
        elif load_ratio < 1.0:
            # 轻度过载: expand1
            action = 1
        else:
            # 严重过载: expand2
            action = 2

        # 记录
        self.queue_history.append(queue_depth)
        self.action_history.append(action)
        self.action_counts[action] += 1

        # Zone 统计
        zone = self._get_zone(queue_depth)
        self.zone_counts[zone] += 1

        return action

    def _get_zone(self, queue_depth: int) -> str:
        """获取当前 Zone"""
        if queue_depth <= 20:
            return "A"
        elif queue_depth <= 100:
            return "B"
        elif queue_depth <= 500:
            return "C"
        elif queue_depth <= 2000:
            return "D"
        else:
            return "E"

    def get_action_distribution(self) -> dict:
        """获取动作分布"""
        total = sum(self.action_counts.values())
        if total == 0:
            return {}

        return {
            action: {
                "count": count,
                "ratio": count / total,
            }
            for action, count in self.action_counts.items()
        }

    def get_zone_distribution(self) -> dict:
        """获取 Zone 分布"""
        total = sum(self.zone_counts.values())
        if total == 0:
            return {}

        return {
            zone: {
                "count": count,
                "ratio": count / total,
            }
            for zone, count in self.zone_counts.items()
        }

    def get_stats(self) -> dict:
        """获取统计"""
        return {
            "action_distribution": self.get_action_distribution(),
            "zone_distribution": self.get_zone_distribution(),
            "total_ticks": self.tick,
        }
