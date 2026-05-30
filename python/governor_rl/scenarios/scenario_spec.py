# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Scenario Specification
# Path: python/governor_rl/scenarios/scenario_spec.py
#
# 场景规格定义
# ─────────────────────────────────────────────────────────────────

from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional
from enum import Enum

# 导入 ScenarioObjective
try:
    from .scenario_objectives import ScenarioObjective
except ImportError:
    # 如果还没定义，先创建占位
    ScenarioObjective = None


class ArrivalPattern(Enum):
    """到达模式"""
    STEADY = "steady"          # 稳定负载
    BURST = "burst"            # 突发流量
    SPIKE = "spike"            # 尖峰
    GRADUAL = "gradual"        # 渐进变化
    PERIODIC = "periodic"       # 周期性
    CHAOS = "chaos"            # 混沌


class RegimeTarget(Enum):
    """目标 regime"""
    SHRINK = "shrink"          # 收缩
    BALANCED = "balanced"      # 平衡
    EXPAND = "expand"          # 扩张
    RECOVERY = "recovery"       # 恢复
    STABILITY = "stability"    # 稳定性优先


@dataclass
class ScenarioSpec:
    """
    场景规格定义
    
    定义一个完整的测试/训练场景
    """
    # 基本信息
    name: str
    description: str = ""
    
    # 时间参数
    duration: int = 5000        # tick 数
    warmup_ticks: int = 100     # 预热阶段
    
    # 到达模式
    arrival_pattern: str = "steady"
    base_arrival_rate: float = 15.0
    arrival_std: float = 0.0   # 到达率波动
    
    # 突发流量
    burst_probability: float = 0.0
    burst_multiplier: float = 1.0
    burst_duration_min: int = 50
    burst_duration_max: int = 200
    
    # 空闲期
    idle_probability: float = 0.0
    idle_rate: float = 1.0
    
    # CPU 抖动
    cpu_spike_probability: float = 0.0
    cpu_spike_duration: int = 20
    cpu_spike_multiplier: float = 2.0
    
    # Worker 故障
    worker_failure_probability: float = 0.0
    worker_failure_batch: int = 5  # 每次故障 worker 数
    
    # 队列洪泛
    queue_flood_probability: float = 0.0
    queue_flood_amount: int = 500
    
    # 目标 regime（用于评估）
    target_regime: str = "balanced"
    
    # 混沌注入参数
    chaos_params: Dict[str, Any] = field(default_factory=dict)
    
    def __post_init__(self):
        """验证参数"""
        if self.duration < 100:
            raise ValueError(f"duration must be >= 100, got {self.duration}")
        if not 0 <= self.burst_probability <= 1:
            raise ValueError(f"burst_probability must be in [0, 1], got {self.burst_probability}")
        if not 0 <= self.idle_probability <= 1:
            raise ValueError(f"idle_probability must be in [0, 1], got {self.idle_probability}")
    
    def get_tags(self) -> List[str]:
        """获取场景标签"""
        tags = []
        
        if self.arrival_pattern == "steady":
            if self.base_arrival_rate < 10:
                tags.append("low_load")
            elif self.base_arrival_rate > 25:
                tags.append("high_load")
            else:
                tags.append("medium_load")
        else:
            tags.append(self.arrival_pattern)
        
        if self.burst_probability > 0:
            tags.append("burst")
        if self.idle_probability > 0:
            tags.append("idle")
        if self.cpu_spike_probability > 0:
            tags.append("cpu_spike")
        if self.worker_failure_probability > 0:
            tags.append("worker_failure")
        if self.queue_flood_probability > 0:
            tags.append("queue_flood")
        
        return tags


# 预定义场景
PRESET_SCENARIOS = {
    "steady_low": ScenarioSpec(
        name="steady_low",
        description="低负载稳态 - 目标: 收缩",
        base_arrival_rate=5.0,
        arrival_pattern="steady",
        target_regime="shrink",
    ),

    "steady_medium": ScenarioSpec(
        name="steady_medium",
        description="中等负载稳态 - 目标: 平衡",
        base_arrival_rate=15.0,
        arrival_pattern="steady",
        target_regime="balanced",
    ),

    "steady_high": ScenarioSpec(
        name="steady_high",
        description="高负载稳态 - 目标: 扩张",
        base_arrival_rate=30.0,
        arrival_pattern="steady",
        target_regime="expand",
    ),

    "burst_traffic": ScenarioSpec(
        name="burst_traffic",
        description="突发流量 - 目标: 快速恢复",
        base_arrival_rate=15.0,
        arrival_pattern="burst",
        burst_probability=0.1,
        burst_multiplier=5.0,
        target_regime="recovery",
    ),

    "long_idle": ScenarioSpec(
        name="long_idle",
        description="长空闲期 - 目标: 收缩 worker",
        base_arrival_rate=15.0,
        arrival_pattern="steady",
        idle_probability=0.7,
        idle_rate=1.0,
        target_regime="shrink",
    ),

    "cpu_spike": ScenarioSpec(
        name="cpu_spike",
        description="CPU 抖动 - 目标: 保持稳定",
        base_arrival_rate=15.0,
        arrival_pattern="steady",
        cpu_spike_probability=0.05,
        cpu_spike_duration=20,
        cpu_spike_multiplier=2.0,
        target_regime="stability",
    ),

    "worker_failure": ScenarioSpec(
        name="worker_failure",
        description="Worker 故障 - 目标: 快速恢复",
        base_arrival_rate=15.0,
        arrival_pattern="steady",
        worker_failure_probability=0.03,
        worker_failure_batch=5,
        target_regime="recovery",
    ),

    "queue_flood": ScenarioSpec(
        name="queue_flood",
        description="队列洪泛 - 目标: 防止崩溃",
        base_arrival_rate=15.0,
        arrival_pattern="steady",
        queue_flood_probability=0.02,
        queue_flood_amount=500,
        target_regime="recovery",
    ),

    # ═══════════════════════════════════════════════════════════════════
    # TRANSITION-FORCING SCENARIOS（定向制造 Phase Transition）
    # ═══════════════════════════════════════════════════════════════════

    "precursor_trigger": ScenarioSpec(
        name="precursor_trigger",
        description="强制触发 precursor phase - 目标: queue divergence",
        duration=3000,
        base_arrival_rate=28.0,
        arrival_pattern="burst",
        burst_probability=0.3,
        burst_multiplier=8.0,
        burst_duration_min=100,
        burst_duration_max=300,
        queue_flood_probability=0.05,
        queue_flood_amount=800,
        target_regime="critical",
        chaos_params={"force_oscillation": False, "force_precursor": True},
    ),

    "oscillation_trigger": ScenarioSpec(
        name="oscillation_trigger",
        description="故意制造 oscillation - 目标: control instability",
        duration=3000,
        base_arrival_rate=20.0,
        arrival_pattern="chaos",
        burst_probability=0.15,
        burst_multiplier=4.0,
        cpu_spike_probability=0.2,
        cpu_spike_duration=30,
        cpu_spike_multiplier=3.0,
        worker_failure_probability=0.1,
        worker_failure_batch=3,
        target_regime="oscillating",
        chaos_params={"force_oscillation": True, "force_precursor": False},
    ),

    "saturation_trigger": ScenarioSpec(
        name="saturation_trigger",
        description="强制触发 saturation - 目标: worker 饱和",
        duration=3000,
        base_arrival_rate=35.0,
        arrival_pattern="steady",
        burst_probability=0.1,
        burst_multiplier=2.0,
        target_regime="saturated",
        chaos_params={"max_workers_limit": 40},
    ),

    "recovery_trigger": ScenarioSpec(
        name="recovery_trigger",
        description="强制触发 recovery - 目标: burst 后自然恢复",
        duration=3000,
        base_arrival_rate=30.0,
        arrival_pattern="burst",
        burst_probability=0.4,
        burst_multiplier=10.0,
        burst_duration_min=200,
        burst_duration_max=400,
        target_regime="recovery",
        chaos_params={"traffic_drop_after_burst": True},
    ),

    "worker_crash_recovery": ScenarioSpec(
        name="worker_crash_recovery",
        description="强制触发 catastrophic recovery",
        duration=3000,
        base_arrival_rate=15.0,
        arrival_pattern="steady",
        worker_failure_probability=0.15,
        worker_failure_batch=15,  # 大批量故障
        queue_flood_probability=0.03,
        queue_flood_amount=1000,
        target_regime="recovery",
        chaos_params={"instant_crash": True, "crash_tick": 500},
    ),

    # ═══════════════════════════════════════════════════════════════════
    # RECOVERY-DENSE SCENARIOS（定向制造长 Recovery Corridor）
    # ═══════════════════════════════════════════════════════════════════

    "gradual_relief": ScenarioSpec(
        name="gradual_relief",
        description="长 recovery corridor - 目标: extreme stress → slow recovery",
        duration=5000,
        base_arrival_rate=50.0,
        arrival_pattern="steady",
        burst_probability=0.6,
        burst_multiplier=10.0,
        queue_flood_probability=0.2,
        queue_flood_amount=3000,
        target_regime="recovery",
        chaos_params={
            "sudden_drop": True,
            "drop_tick": 1000,
            "drop_to_rate": 5.0,
            "initial_rate": 50.0,
        },
    ),

    "oscillation_decay": ScenarioSpec(
        name="oscillation_decay",
        description="振荡衰减 - 目标: burst → oscillation → dampen",
        duration=5000,
        base_arrival_rate=15.0,
        arrival_pattern="chaos",
        burst_probability=0.8,
        burst_multiplier=15.0,
        cpu_spike_probability=0.4,
        cpu_spike_duration=60,
        cpu_spike_multiplier=5.0,
        worker_failure_probability=0.3,
        worker_failure_batch=15,
        queue_flood_probability=0.25,
        queue_flood_amount=2000,
        target_regime="recovery",
        chaos_params={
            "burst_then_relief": True,
            "burst_start": 200,
            "burst_end": 1200,
            "burst_rate": 60.0,
            "relief_rate": 8.0,
        },
    ),
}


def get_scenario(name: str) -> ScenarioSpec:
    """获取预定义场景"""
    if name not in PRESET_SCENARIOS:
        raise ValueError(f"Unknown scenario: {name}. Available: {list(PRESET_SCENARIOS.keys())}")
    return PRESET_SCENARIOS[name]


def get_all_scenarios() -> List[ScenarioSpec]:
    """获取所有预定义场景"""
    return list(PRESET_SCENARIOS.values())
