# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Workload Patterns
# Path: python/governor_rl/scenarios/workload_patterns.py
#
# 工作负载生成器 - 多种模式的工作负载
# ─────────────────────────────────────────────────────────────────

import numpy as np
from typing import Dict, Optional, Tuple
from dataclasses import dataclass


@dataclass
class WorkloadEvent:
    """工作负载事件"""
    tick: int
    arrival_rate: float
    cpu_multiplier: float = 1.0
    queue_injection: int = 0
    worker_kill: int = 0


class WorkloadGenerator:
    """
    工作负载生成器
    
    根据场景规格生成动态工作负载
    """
    
    def __init__(
        self,
        base_arrival_rate: float = 15.0,
        arrival_std: float = 0.0,
        arrival_pattern: str = "steady",
        seed: int = None,
    ):
        self.base_arrival_rate = base_arrival_rate
        self.arrival_std = arrival_std
        self.arrival_pattern = arrival_pattern
        
        if seed is not None:
            np.random.seed(seed)
        
        # 内部状态
        self._burst_active = False
        self._burst_end_tick = 0
        self._burst_multiplier = 1.0
        self._burst_duration_min = 50
        self._burst_duration_max = 200
        
        self._idle_active = False
        self._idle_end_tick = 0
        
        self._cpu_spike_active = False
        self._cpu_spike_end_tick = 0
        
        self._queue_flood_next = 0
        self._worker_failure_next = 0
    
    def reset(self):
        """重置状态"""
        self._burst_active = False
        self._idle_active = False
        self._cpu_spike_active = False
        self._queue_flood_next = 0
        self._worker_failure_next = 0
    
    def generate(
        self,
        tick: int,
        cpu_multiplier: float = 1.0,
        burst_prob: float = 0.0,
        burst_multiplier: float = 1.0,
        burst_dur_min: int = 50,
        burst_dur_max: int = 200,
        idle_prob: float = 0.0,
        idle_rate: float = 1.0,
        cpu_spike_prob: float = 0.0,
        cpu_spike_dur: int = 20,
        cpu_spike_mult: float = 2.0,
        queue_flood_prob: float = 0.0,
        queue_flood_amount: int = 500,
        worker_failure_prob: float = 0.0,
        worker_failure_batch: int = 5,
    ) -> WorkloadEvent:
        """
        生成当前 tick 的工作负载
        
        Returns:
            WorkloadEvent
        """
        arrival_rate = self.base_arrival_rate
        cpu_mult = cpu_multiplier
        queue_injection = 0
        worker_kill = 0
        
        # 到达率波动
        if self.arrival_std > 0:
            arrival_rate += np.random.normal(0, self.arrival_std)
            arrival_rate = max(0, arrival_rate)
        
        # 突发流量
        if burst_prob > 0:
            if not self._burst_active and tick >= self._burst_end_tick:
                if np.random.random() < burst_prob:
                    self._burst_active = True
                    self._burst_multiplier = burst_multiplier
                    dur = np.random.randint(burst_dur_min, burst_dur_max + 1)
                    self._burst_end_tick = tick + dur
            
            if self._burst_active:
                if tick < self._burst_end_tick:
                    arrival_rate *= self._burst_multiplier
                else:
                    self._burst_active = False
                    self._burst_end_tick = tick + int(1 / burst_prob)
        
        # 空闲期
        if idle_prob > 0:
            if not self._idle_active and tick >= self._idle_end_tick:
                if np.random.random() < idle_prob:
                    self._idle_active = True
                    dur = np.random.randint(100, 500)
                    self._idle_end_tick = tick + dur
            
            if self._idle_active:
                if tick < self._idle_end_tick:
                    arrival_rate = idle_rate
                else:
                    self._idle_active = False
                    self._idle_end_tick = tick + int(1 / idle_prob)
        
        # CPU 抖动
        if cpu_spike_prob > 0:
            if not self._cpu_spike_active and tick >= self._cpu_spike_end_tick:
                if np.random.random() < cpu_spike_prob:
                    self._cpu_spike_active = True
                    self._cpu_spike_end_tick = tick + cpu_spike_dur
            
            if self._cpu_spike_active:
                if tick < self._cpu_spike_end_tick:
                    cpu_mult = cpu_spike_mult
                else:
                    self._cpu_spike_active = False
                    self._cpu_spike_end_tick = tick + int(1 / cpu_spike_prob)
        
        # 队列洪泛
        if queue_flood_prob > 0:
            if tick >= self._queue_flood_next:
                if np.random.random() < queue_flood_prob:
                    queue_injection = queue_flood_amount
                    self._queue_flood_next = tick + int(1 / queue_flood_prob)
                else:
                    self._queue_flood_next = tick + 10
        
        # Worker 故障
        if worker_failure_prob > 0:
            if tick >= self._worker_failure_next:
                if np.random.random() < worker_failure_prob:
                    worker_kill = worker_failure_batch
                    self._worker_failure_next = tick + int(1 / worker_failure_prob)
                else:
                    self._worker_failure_next = tick + 10
        
        return WorkloadEvent(
            tick=tick,
            arrival_rate=arrival_rate,
            cpu_multiplier=cpu_mult,
            queue_injection=queue_injection,
            worker_kill=worker_kill,
        )


class WorkloadPatternLibrary:
    """
    预定义工作负载模式库
    """
    
    @staticmethod
    def steady(rate: float, noise: float = 0.1) -> np.ndarray:
        """
        稳定负载
        
        Args:
            rate: 基础到达率
            noise: 噪声比例
            
        Returns:
            到达率数组
        """
        base = np.ones(1000) * rate
        noise = np.random.normal(0, rate * noise, 1000)
        return np.clip(base + noise, 0, None)
    
    @staticmethod
    def sinusoidal(period: int, amplitude: float, base: float) -> np.ndarray:
        """正弦波动"""
        t = np.arange(1000)
        return base + amplitude * np.sin(2 * np.pi * t / period)
    
    @staticmethod
    def step_changes(steps: list, values: list, duration: int = 5000) -> np.ndarray:
        """
        阶跃变化
        
        Args:
            steps: 切换时间点
            values: 对应值
            duration: 总时长
        """
        result = np.zeros(duration)
        for i, (t, v) in enumerate(zip(steps, values)):
            end = steps[i + 1] if i + 1 < len(steps) else duration
            result[t:end] = v
        return result
    
    @staticmethod
    def burst_pattern(
        base_rate: float,
        burst_rate: float,
        burst_prob: float,
        duration: int = 5000,
    ) -> np.ndarray:
        """
        突发模式
        
        生成带有随机突发的到达率序列
        """
        result = np.ones(duration) * base_rate
        t = 0
        while t < duration:
            if np.random.random() < burst_prob:
                # 突发开始
                burst_dur = np.random.randint(20, 200)
                result[t:t + burst_dur] = burst_rate
                t += burst_dur
            else:
                t += 1
        return result
    
    @staticmethod
    def sawtooth(
        min_rate: float,
        max_rate: float,
        period: int,
        duration: int = 5000,
    ) -> np.ndarray:
        """锯齿波"""
        t = np.arange(duration)
        phase = (t % period) / period
        return min_rate + (max_rate - min_rate) * phase


def create_workload_generator(spec, seed: int = None) -> WorkloadGenerator:
    """从场景规格创建工作负载生成器"""
    return WorkloadGenerator(
        base_arrival_rate=spec.base_arrival_rate,
        arrival_std=spec.arrival_std,
        arrival_pattern=spec.arrival_pattern,
        seed=seed,
    )
