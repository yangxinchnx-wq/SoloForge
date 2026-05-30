# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Transition Detector
# Path: python/governor_rl/phases/transition_detector.py
#
# 核心职责：检测 Runtime Phase Transition
# 不是检测当前绝对状态，而是检测"正在发生什么变化"
# ─────────────────────────────────────────────────────────────────

import numpy as np
from typing import List, Optional, Tuple
from dataclasses import dataclass

from .runtime_phase import RuntimePhase


@dataclass
class PhaseFeatures:
    """用于 phase 判定的特征"""
    queue_depth: int
    queue_velocity: float      # queue 变化率
    queue_acceleration: float   # queue 变化加速度
    worker_count: int
    worker_delta: int          # action 导致的 worker 变化
    precursor_score: float     # 0-1
    oscillation_score: float   # 0-1
    cpu_usage: float           # 0-1
    max_workers: int           # 最大 worker 数


class TransitionDetector:
    """
    Transition Detector

    核心职责：分析 timeline，判定每个 tick 属于哪个 Runtime Phase

    Recovery 的新定义：
    - 不再是"一个 phase"，而是"高负载后到稳定的过渡过程"
    - 包括：precursor/saturated 结束后，系统正在恢复的阶段
    - 持续直到 queue_velocity 稳定且 oscillation 降低
    """

    # 判定阈值
    VELOCITY_THRESHOLD = 10.0
    PRECURSOR_VELOCITY = 15.0
    PRECURSOR_THRESHOLD = 0.3
    OSCILLATION_THRESHOLD = 0.2
    SATURATION_RATIO = 0.8
    STABLE_QUEUE_VELOCITY = 5.0
    STABLE_PRECURSOR = 0.2
    STABLE_OSCILLATION = 0.1
    RECOVERY_OSCILLATION = 0.15  # Recovery 期间的 oscillation 阈值
    
    def __init__(self, history_window: int = 20):
        self.history_window = history_window
        
        # 状态历史
        self.queue_history: List[int] = []
        self.precursor_history: List[float] = []
        self.action_history: List[int] = []
        self.phase_history: List[RuntimePhase] = []
    
    def reset(self):
        """重置状态"""
        self.queue_history = []
        self.precursor_history = []
        self.action_history = []
        self.phase_history = []
    
    def compute_features(
        self,
        queue_depth: int,
        precursor_score: float,
        oscillation_score: float,
        worker_count: int,
        action_delta: int,
        cpu_usage: float,
        max_workers: int = 200,
    ) -> PhaseFeatures:
        """
        计算用于 phase 判定的特征
        
        Returns:
            PhaseFeatures
        """
        # 计算 queue velocity
        if len(self.queue_history) > 0:
            queue_velocity = float(queue_depth - self.queue_history[-1])
        else:
            queue_velocity = 0.0
        
        # 计算 queue acceleration
        if len(self.queue_history) > 1:
            prev_velocity = float(self.queue_history[-1] - self.queue_history[-2])
            queue_acceleration = queue_velocity - prev_velocity
        else:
            queue_acceleration = 0.0
        
        return PhaseFeatures(
            queue_depth=queue_depth,
            queue_velocity=queue_velocity,
            queue_acceleration=queue_acceleration,
            worker_count=worker_count,
            worker_delta=action_delta,
            precursor_score=precursor_score,
            oscillation_score=oscillation_score,
            cpu_usage=cpu_usage,
            max_workers=max_workers,
        )
    
    def detect_phase(self, features: PhaseFeatures) -> RuntimePhase:
        """
        判定当前 Runtime Phase

        Args:
            features: 当前特征

        Returns:
            RuntimePhase
        """
        # 优先级判定（按重要性排序）

        # 1. SATURATED - 资源饱和
        if features.worker_count / max(features.max_workers, 1) > self.SATURATION_RATIO:
            return RuntimePhase.SATURATED

        # 2. PRECURSOR - 崩溃前兆（高优先级）
        # 使用 queue_velocity 作为主要指标
        if (features.queue_velocity > self.PRECURSOR_VELOCITY or
            (features.precursor_score > self.PRECURSOR_THRESHOLD and features.queue_velocity > 5)):
            return RuntimePhase.PRECURSOR

        # 3. OSCILLATING - 系统振荡
        if features.oscillation_score > self.OSCILLATION_THRESHOLD:
            return RuntimePhase.OSCILLATING

        # 4. RECOVERY - precursor/saturated 结束后的恢复期
        # 检查最近是否经历过 precursor/saturated（高负载期）
        recent_phases = self.phase_history[-30:] if self.phase_history else []
        had_high_stress = any(
            p in [RuntimePhase.PRECURSOR, RuntimePhase.SATURATED]
            for p in recent_phases
        )

        # RECOVERY 条件：
        # - 经历过 high stress
        # - 且 oscillation > 稳定阈值（还没完全稳定）
        # - 且不是正在扩张
        if had_high_stress:
            if (features.oscillation_score > self.STABLE_OSCILLATION and
                features.queue_velocity <= self.VELOCITY_THRESHOLD):
                return RuntimePhase.RECOVERY

        # 5. EXPANDING - 扩张中
        if features.queue_velocity > self.VELOCITY_THRESHOLD and features.worker_delta > 0:
            return RuntimePhase.EXPANDING

        # 6. SHRINKING - 收缩中
        if features.queue_velocity < -self.VELOCITY_THRESHOLD and features.worker_delta < 0:
            return RuntimePhase.SHRINKING

        # 7. STABLE - 稳定状态
        if (abs(features.queue_velocity) < self.STABLE_QUEUE_VELOCITY and
            features.oscillation_score < self.STABLE_OSCILLATION):
            return RuntimePhase.STABLE

        # 默认：STABLE
        return RuntimePhase.STABLE
    
    def update(
        self,
        queue_depth: int,
        precursor_score: float,
        oscillation_score: float,
        worker_count: int,
        action_delta: int,
        cpu_usage: float,
        max_workers: int = 200,
    ) -> RuntimePhase:
        """
        更新状态并返回当前 phase
        
        Args:
            queue_depth: 当前队列深度
            precursor_score: 前兆分数
            oscillation_score: 振荡分数
            worker_count: 当前 worker 数
            action_delta: action 导致的 worker 变化
            cpu_usage: CPU 使用率
            max_workers: 最大 worker 数
            
        Returns:
            当前 RuntimePhase
        """
        features = self.compute_features(
            queue_depth=queue_depth,
            precursor_score=precursor_score,
            oscillation_score=oscillation_score,
            worker_count=worker_count,
            action_delta=action_delta,
            cpu_usage=cpu_usage,
            max_workers=max_workers,
        )
        
        phase = self.detect_phase(features)
        
        # 更新历史
        self.queue_history.append(queue_depth)
        self.precursor_history.append(precursor_score)
        self.action_history.append(action_delta)
        self.phase_history.append(phase)
        
        # 限制历史长度
        if len(self.queue_history) > self.history_window:
            self.queue_history.pop(0)
        if len(self.precursor_history) > self.history_window:
            self.precursor_history.pop(0)
        if len(self.action_history) > self.history_window:
            self.action_history.pop(0)
        if len(self.phase_history) > self.history_window:
            self.phase_history.pop(0)
        
        return phase
    
    def get_previous_phase(self) -> Optional[RuntimePhase]:
        """获取前一个 phase"""
        if len(self.phase_history) > 1:
            return self.phase_history[-2]
        return None
    
    def is_transitioning(self) -> bool:
        """检测是否正在发生 phase transition"""
        if len(self.phase_history) < 2:
            return False
        return self.phase_history[-1] != self.phase_history[-2]
