# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime Health System: 稳定性指标计算
# Path: python/training/simulator/stability_metrics.py
#
# 核心：把"振荡"变成一等公民
# ─────────────────────────────────────────────────────────────────

import sys
import os
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional
import statistics

# 设置 UTF-8 输出
sys.stdout.reconfigure(encoding='utf-8')

@dataclass
class StabilityMetrics:
    """运行时稳定性指标"""
    tick: int = 0

    # === Oscillation Metrics ===
    oscillation_score: float = 0.0      # 综合振荡分数
    worker_churn_rate: float = 0.0       # Worker 变更频率
    action_frequency: float = 0.0          # 动作切换频率
    queue_oscillation_amplitude: float = 0.0  # 队列振荡幅度
    cpu_oscillation_amplitude: float = 0.0    # CPU 振荡幅度

    # === Recovery Metrics ===
    queue_recovery_half_life: float = 0.0  # 队列恢复到50%需要多久
    stabilization_time: int = 0             # 稳定化时间
    recovery_rate: float = 0.0              # 恢复速率

    # === Control Quality Metrics ===
    overshoot_ratio: float = 0.0           # 超调比例
    worker_churn_count: int = 0             # Worker 变更次数
    consecutive_actions: int = 0            # 连续同向动作数

    # === System State ===
    queue_depth: int = 0
    cpu_usage: float = 0.0
    worker_count: int = 0


class StabilityAnalyzer:
    """
    运行时稳定性分析器

    职责：
    1. 收集时间序列数据
    2. 计算稳定性指标
    3. 检测振荡模式
    """

    def __init__(self, window_size: int = 50):
        self.window_size = window_size

        # 历史数据
        self.queue_history: List[int] = []
        self.worker_history: List[int] = []
        self.cpu_history: List[float] = []
        self.action_history: List[str] = []
        self.tick_history: List[int] = []

        # 峰值追踪
        self.last_peak_tick: int = 0
        self.last_peak_queue: int = 0
        self.in_recovery: bool = False

        # 阻尼状态
        self.cooldown_remaining: int = 0
        self.last_action_direction: Optional[str] = None
        self.consecutive_same_direction: int = 0

    def record(self, tick: int, state: Dict[str, Any], action: str):
        """记录一个时间步的数据"""
        self.tick_history.append(tick)
        self.queue_history.append(state.get('queue_depth', 0))
        self.worker_history.append(state.get('worker_count', 0))
        self.cpu_history.append(state.get('cpu_usage', 0.0))
        self.action_history.append(action)

        # 峰值追踪
        current_queue = state.get('queue_depth', 0)
        if current_queue > self.last_peak_queue:
            self.last_peak_queue = current_queue
            self.last_peak_tick = tick
            self.in_recovery = False
        elif current_queue < self.last_peak_queue * 0.9:
            self.in_recovery = True

        # 阻尼追踪
        self._update_damping(action)

        # 限制历史长度
        self._trim_history()

    def _update_damping(self, action: str):
        """更新阻尼状态"""
        direction = self._get_action_direction(action)

        if direction == self.last_action_direction:
            self.consecutive_same_direction += 1
        else:
            self.consecutive_same_direction = 1
            self.last_action_direction = direction

    def _get_action_direction(self, action: str) -> Optional[str]:
        """获取动作方向"""
        if action in ['spawn_worker']:
            return 'expand'
        elif action in ['reduce_workers']:
            return 'contract'
        return None

    def _trim_history(self):
        """限制历史数据长度"""
        max_len = self.window_size * 2
        if len(self.queue_history) > max_len:
            self.queue_history = self.queue_history[-max_len:]
            self.worker_history = self.worker_history[-max_len:]
            self.cpu_history = self.cpu_history[-max_len:]
            self.action_history = self.action_history[-max_len:]
            self.tick_history = self.tick_history[-max_len:]

    def compute_metrics(self, current_tick: int) -> StabilityMetrics:
        """计算当前稳定性指标"""
        metrics = StabilityMetrics(tick=current_tick)

        if len(self.queue_history) < 10:
            return metrics

        # === Oscillation Metrics ===
        metrics.oscillation_score = self._compute_oscillation_score()
        metrics.worker_churn_rate = self._compute_churn_rate()
        metrics.action_frequency = self._compute_action_frequency()
        metrics.queue_oscillation_amplitude = self._compute_amplitude(self.queue_history)
        metrics.cpu_oscillation_amplitude = self._compute_amplitude(self.cpu_history)

        # === Recovery Metrics ===
        metrics.queue_recovery_half_life = self._compute_recovery_half_life(current_tick)
        metrics.stabilization_time = self._compute_stabilization_time()
        metrics.recovery_rate = self._compute_recovery_rate()

        # === Control Quality Metrics ===
        metrics.overshoot_ratio = self._compute_overshoot_ratio()
        metrics.worker_churn_count = self._compute_worker_churn_count()
        metrics.consecutive_actions = self.consecutive_same_direction

        # === System State ===
        metrics.queue_depth = self.queue_history[-1] if self.queue_history else 0
        metrics.cpu_usage = self.cpu_history[-1] if self.cpu_history else 0.0
        metrics.worker_count = self.worker_history[-1] if self.worker_history else 0

        return metrics

    def _compute_oscillation_score(self) -> float:
        """计算综合振荡分数"""
        if len(self.worker_history) < 10:
            return 0.0

        # Worker 变更频率
        changes = sum(
            1 for i in range(1, len(self.worker_history))
            if self.worker_history[i] != self.worker_history[i-1]
        )
        worker_osc = changes / len(self.worker_history)

        # Action 切换频率
        actions = [a for a in self.action_history if a != 'no_op']
        if len(actions) > 1:
            switches = sum(1 for i in range(1, len(actions)) if actions[i] != actions[i-1])
            action_osc = switches / len(actions)
        else:
            action_osc = 0.0

        # 综合分数（0-1）
        return min(1.0, (worker_osc + action_osc) / 2.0)

    def _compute_churn_rate(self) -> float:
        """计算 Worker 变更率"""
        if len(self.worker_history) < 2:
            return 0.0

        changes = sum(
            1 for i in range(1, len(self.worker_history))
            if self.worker_history[i] != self.worker_history[i-1]
        )

        return changes / len(self.worker_history)

    def _compute_action_frequency(self) -> float:
        """计算动作执行频率（不含 no_op）"""
        if len(self.action_history) < 1:
            return 0.0

        actions = [a for a in self.action_history if a != 'no_op']
        return len(actions) / len(self.action_history)

    def _compute_amplitude(self, values: List[float]) -> float:
        """计算振荡幅度（峰峰值 / 均值）"""
        if len(values) < 2:
            return 0.0

        try:
            max_val = max(values)
            min_val = min(values)
            mean_val = statistics.mean(values)

            if mean_val > 0:
                return (max_val - min_val) / mean_val
            return 0.0
        except:
            return 0.0

    def _compute_recovery_half_life(self, current_tick: int) -> float:
        """计算队列恢复到50%需要的时间"""
        if not self.in_recovery or self.last_peak_queue == 0:
            return 0.0

        current_queue = self.queue_history[-1] if self.queue_history else 0
        if current_queue >= self.last_peak_queue * 0.5:
            return 0.0

        # 估算恢复时间
        ticks_since_peak = current_tick - self.last_peak_tick
        current_ratio = current_queue / self.last_peak_queue

        if current_ratio < 0.5:
            # 已经低于50%，计算实际时间
            return float(ticks_since_peak)
        else:
            # 估算达到50%的时间
            recovery_rate = (self.last_peak_queue - current_queue) / max(1, ticks_since_peak)
            if recovery_rate > 0:
                ticks_to_50 = (self.last_peak_queue * 0.5 - current_queue) / recovery_rate
                return ticks_to_50 + ticks_since_peak

        return 0.0

    def _compute_stabilization_time(self) -> int:
        """计算稳定化时间"""
        if len(self.queue_history) < 20:
            return 0

        # 检查最近N个时间步的方差
        recent = self.queue_history[-20:]
        try:
            variance = statistics.variance(recent) if len(recent) > 1 else 0
            mean = statistics.mean(recent)

            if mean > 0:
                cv = (variance ** 0.5) / mean  # 变异系数
                if cv < 0.1:  # 变异系数小于10%认为稳定
                    return 0  # 稳定
        except:
            pass

        return len(self.queue_history)  # 返回未稳定的时间

    def _compute_recovery_rate(self) -> float:
        """计算恢复速率"""
        if len(self.queue_history) < 10:
            return 0.0

        # 计算队列变化趋势
        recent = self.queue_history[-10:]
        try:
            # 简单线性趋势
            changes = [recent[i] - recent[i-1] for i in range(1, len(recent))]
            avg_change = statistics.mean(changes)
            return -avg_change  # 负值表示在恢复
        except:
            return 0.0

    def _compute_overshoot_ratio(self) -> float:
        """计算超调比例"""
        if len(self.worker_history) < 10:
            return 0.0

        # 估算需要的 worker 数（基于队列）
        recent_queue = self.queue_history[-20:]
        avg_queue = statistics.mean(recent_queue) if recent_queue else 0
        needed_workers = max(1, avg_queue / 10)  # 简单估算

        # 实际最大 worker 数
        max_workers = max(self.worker_history[-50:]) if self.worker_history else 1

        if needed_workers > 0:
            return (max_workers - needed_workers) / needed_workers

        return 0.0

    def _compute_worker_churn_count(self) -> int:
        """计算 Worker 变更次数"""
        if len(self.worker_history) < 2:
            return 0

        return sum(
            1 for i in range(1, len(self.worker_history))
            if self.worker_history[i] != self.worker_history[i-1]
        )

    def get_damping_status(self) -> Dict[str, Any]:
        """获取阻尼状态"""
        return {
            'cooldown_remaining': self.cooldown_remaining,
            'last_action_direction': self.last_action_direction,
            'consecutive_same_direction': self.consecutive_same_direction,
            'in_recovery': self.in_recovery,
        }

    def set_cooldown(self, ticks: int):
        """设置冷却时间"""
        self.cooldown_remaining = ticks

    def tick_cooldown(self):
        """减少冷却时间"""
        if self.cooldown_remaining > 0:
            self.cooldown_remaining -= 1

    def is_in_cooldown(self) -> bool:
        """是否在冷却中"""
        return self.cooldown_remaining > 0

    def reset(self):
        """重置分析器"""
        self.queue_history.clear()
        self.worker_history.clear()
        self.cpu_history.clear()
        self.action_history.clear()
        self.tick_history.clear()
        self.last_peak_tick = 0
        self.last_peak_queue = 0
        self.in_recovery = False
        self.cooldown_remaining = 0
        self.last_action_direction = None
        self.consecutive_same_direction = 0
