# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Chaos Injection
# Path: python/governor_rl/scenarios/chaos_injection.py
#
# 混沌注入器 - 模拟真实系统的各种故障场景
# ─────────────────────────────────────────────────────────────────

import numpy as np
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from enum import Enum


class ChaosType(Enum):
    """混沌类型"""
    CPU_SPIKE = "cpu_spike"
    WORKER_FAILURE = "worker_failure"
    NETWORK_DELAY = "network_delay"
    QUEUE_FLOOD = "queue_flood"
    PROCESS_SLOWDOWN = "process_slowdown"
    WORKER_LATENCY = "worker_latency"


@dataclass
class ChaosEvent:
    """混沌事件"""
    tick: int
    event_type: ChaosType
    intensity: float
    duration: int
    metadata: Dict = None


class ChaosEngine:
    """
    混沌引擎
    
    管理系统中的各种故障注入
    """
    
    def __init__(self, seed: int = None):
        if seed is not None:
            np.random.seed(seed)
        
        # 事件追踪
        self.active_events: List[ChaosEvent] = []
        self.event_history: List[ChaosEvent] = []
        
        # 调度
        self.next_cpu_spike = 0
        self.next_worker_failure = 0
        self.next_queue_flood = 0
        
        # 当前状态
        self.current_cpu_mult = 1.0
        self.workers_to_kill = 0
    
    def reset(self):
        """重置引擎"""
        self.active_events = []
        self.event_history = []
        self.current_cpu_mult = 1.0
        self.workers_to_kill = 0
    
    def step(
        self,
        tick: int,
        cpu_spike_prob: float = 0.0,
        cpu_spike_dur: int = 20,
        cpu_spike_mult: float = 2.0,
        worker_failure_prob: float = 0.0,
        worker_failure_batch: int = 5,
        queue_flood_prob: float = 0.0,
        queue_flood_amount: int = 500,
    ) -> Tuple[float, int, int]:
        """
        步进混沌引擎
        
        Args:
            tick: 当前 tick
            cpu_spike_prob: CPU 抖动概率
            cpu_spike_dur: CPU 抖动持续时间
            cpu_spike_mult: CPU 抖动倍数
            worker_failure_prob: Worker 故障概率
            worker_failure_batch: 每次故障的 worker 数
            queue_flood_prob: 队列洪泛概率
            queue_flood_amount: 每次洪泛的队列深度
            
        Returns:
            (cpu_multiplier, workers_to_kill, queue_injection)
        """
        queue_injection = 0
        
        # CPU 抖动
        if tick >= self.next_cpu_spike:
            if np.random.random() < cpu_spike_prob:
                event = ChaosEvent(
                    tick=tick,
                    event_type=ChaosType.CPU_SPIKE,
                    intensity=cpu_spike_mult,
                    duration=cpu_spike_dur,
                )
                self.active_events.append(event)
                self.event_history.append(event)
                self.next_cpu_spike = tick + cpu_spike_dur + int(1 / cpu_spike_prob)
        
        # Worker 故障
        if tick >= self.next_worker_failure:
            if np.random.random() < worker_failure_prob:
                event = ChaosEvent(
                    tick=tick,
                    event_type=ChaosType.WORKER_FAILURE,
                    intensity=worker_failure_batch,
                    duration=1,
                )
                self.active_events.append(event)
                self.event_history.append(event)
                self.workers_to_kill = worker_failure_batch
                self.next_worker_failure = tick + int(1 / worker_failure_prob)
        
        # 队列洪泛
        if tick >= self.next_queue_flood:
            if np.random.random() < queue_flood_prob:
                event = ChaosEvent(
                    tick=tick,
                    event_type=ChaosType.QUEUE_FLOOD,
                    intensity=queue_flood_amount,
                    duration=1,
                )
                self.active_events.append(event)
                self.event_history.append(event)
                queue_injection = queue_flood_amount
                self.next_queue_flood = tick + int(1 / queue_flood_prob)
        
        # 处理活跃事件
        self.current_cpu_mult = 1.0
        workers_killed_this_step = 0
        
        still_active = []
        for event in self.active_events:
            remaining = event.duration - (tick - event.tick)
            
            if remaining > 0:
                still_active.append(event)
                
                if event.event_type == ChaosType.CPU_SPIKE:
                    self.current_cpu_mult = max(self.current_cpu_mult, event.intensity)
                elif event.event_type == ChaosType.WORKER_FAILURE:
                    if remaining == event.duration - 1:  # 刚发生
                        workers_killed_this_step = int(event.intensity)
            else:
                # 事件结束
                if event.event_type == ChaosType.WORKER_FAILURE:
                    workers_killed_this_step = 0
                    self.workers_to_kill = 0
        
        self.active_events = still_active
        
        return self.current_cpu_mult, workers_killed_this_step, queue_injection
    
    def get_active_intensity(self, event_type: ChaosType) -> float:
        """获取当前活跃事件的强度"""
        for event in self.active_events:
            if event.event_type == event_type:
                return event.intensity
        return 0.0
    
    def get_event_summary(self) -> Dict:
        """获取事件摘要"""
        return {
            "total_events": len(self.event_history),
            "active_events": len(self.active_events),
            "cpu_spikes": sum(1 for e in self.event_history if e.event_type == ChaosType.CPU_SPIKE),
            "worker_failures": sum(1 for e in self.event_history if e.event_type == ChaosType.WORKER_FAILURE),
            "queue_floods": sum(1 for e in self.event_history if e.event_type == ChaosType.QUEUE_FLOOD),
        }


class FailureDetector:
    """
    故障检测器
    
    检测系统中的各种故障状态，用于标注 failure trajectories
    """
    
    def __init__(self):
        self.history_length = 100
        self.queue_history = []
        self.oscillation_history = []
        self.worker_history = []
    
    def update(
        self,
        tick: int,
        queue_depth: int,
        oscillation_score: float,
        worker_count: int,
        action: int,
    ):
        """更新状态"""
        self.queue_history.append((tick, queue_depth))
        self.oscillation_history.append((tick, oscillation_score))
        self.worker_history.append((tick, worker_count, action))
        
        # 保持历史长度
        if len(self.queue_history) > self.history_length:
            self.queue_history.pop(0)
        if len(self.oscillation_history) > self.history_length:
            self.oscillation_history.pop(0)
        if len(self.worker_history) > self.history_length:
            self.worker_history.pop(0)
    
    def detect_near_collapse(self, threshold: float = 0.8) -> bool:
        """检测接近崩溃状态"""
        if len(self.queue_history) < 50:
            return False
        
        recent_queues = [q for _, q in self.queue_history[-50:]]
        max_queue = max(recent_queues)
        
        # 如果队列持续增长
        if len(recent_queues) >= 20:
            recent_avg = np.mean(recent_queues[-20:])
            older_avg = np.mean(recent_queues[-50:-20])
            if recent_avg > older_avg * 1.5 and recent_avg > 500:
                return True
        
        return False
    
    def detect_oscillation(self, threshold: float = 0.3) -> bool:
        """检测振荡"""
        if len(self.oscillation_history) < 20:
            return False
        
        recent_osc = [o for _, o in self.oscillation_history[-20:]]
        return np.mean(recent_osc) > threshold
    
    def detect_queue_explosion(self, threshold: int = 1000) -> bool:
        """检测队列爆炸"""
        if not self.queue_history:
            return False
        return self.queue_history[-1][1] > threshold
    
    def detect_worker_churn(self, threshold: float = 2.0) -> bool:
        """检测 worker 更替"""
        if len(self.worker_history) < 10:
            return False
        
        recent = self.worker_history[-10:]
        churns = [abs(a[2]) for a in recent if recent.index(a) > 0]
        return np.mean(churns) > threshold if churns else False
    
    def get_failure_type(self) -> Optional[str]:
        """获取当前故障类型"""
        if self.detect_queue_explosion():
            return "queue_explosion"
        if self.detect_oscillation():
            return "oscillation"
        if self.detect_near_collapse():
            return "near_collapse"
        if self.detect_worker_churn():
            return "worker_churn"
        return None
