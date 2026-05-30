# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Adaptive Predictive Governor V3
# Path: python/training/simulator/adaptive_governor.py
#
# 核心创新：
# 1. Governor Self-Monitoring - 监控自身调节有效性
# 2. Regime-Aware Mode Switching - 根据 regime 切换调节模式
# 3. Adaptive Parameter Tuning - 动态调整调节参数
# 4. Meta-Regulation - 调节自己的调节机制
#
# 从 Runtime Regulation → Meta-Regulation
# ─────────────────────────────────────────────────────────────────

import sys
import os
from typing import Dict, Any, List, Optional, Tuple
from dataclasses import dataclass, field
from collections import deque

# 设置 UTF-8 输出
sys.stdout.reconfigure(encoding='utf-8')

# 添加项目根目录到路径
script_dir = os.path.dirname(os.path.abspath(__file__))
training_dir = os.path.dirname(script_dir)
python_dir = os.path.dirname(training_dir)
sys.path.insert(0, python_dir)

from training.simulator.runtime_simulator import RuntimeSimulator
from training.simulator.stability_metrics import StabilityAnalyzer
from training.simulator.timeline_recorder import (
    RuntimeTimelineRecorder,
    RuntimeState,
    Action,
    RawTelemetry,
    DerivedMetrics,
    Event,
)
from training.simulator.precursor_observatory import PrecursorDetector


@dataclass
class GovernorHealthMetrics:
    """Governor 健康指标"""
    tick: int = 0

    # 自身调节有效性
    responsiveness: float = 0.0  # 0-1, 扩容反应多快
    smoothness: float = 0.0  # 0-1, 控制多平滑
    oscillation_tendency: float = 0.0  # 0-1, 振荡趋势
    precursor_sensitivity: float = 0.0  # 0-1, precursor 响应程度

    # 整体健康分
    health_score: float = 0.0  # 0-1, 综合健康分

    # 当前模式
    mode: str = "balanced"


@dataclass
class RegulationProfile:
    """调节配置模板"""
    name: str
    risk_accumulation_rate: float  # 风险累积速率
    risk_decay_rate: float  # 风险衰减
    max_scaling_rate: float  # 最大扩容速率
    cooldown_base: int  # 基础冷却时间
    aggressiveness: float  # 激进程度 0-1


# 预定义调节模式
REGULATION_PROFILES = {
    "conservative": RegulationProfile(
        name="conservative",
        risk_accumulation_rate=0.2,  # 慢累积
        risk_decay_rate=0.15,  # 快衰减
        max_scaling_rate=0.1,  # 慢扩容
        cooldown_base=15,  # 长冷却
        aggressiveness=0.3,
    ),
    "balanced": RegulationProfile(
        name="balanced",
        risk_accumulation_rate=0.3,
        risk_decay_rate=0.1,
        max_scaling_rate=0.15,
        cooldown_base=10,
        aggressiveness=0.5,
    ),
    "aggressive": RegulationProfile(
        name="aggressive",
        risk_accumulation_rate=0.4,
        risk_decay_rate=0.05,
        max_scaling_rate=0.25,
        cooldown_base=5,
        aggressiveness=0.8,
    ),
    "emergency": RegulationProfile(
        name="emergency",
        risk_accumulation_rate=0.6,
        risk_decay_rate=0.02,
        max_scaling_rate=0.5,
        cooldown_base=2,
        aggressiveness=1.0,
    ),
}


@dataclass
class GovernorSelfMonitor:
    """
    Governor 自我监控

    监控指标：
    1. Responsiveness - 扩容反应速度
    2. Smoothness - 控制平滑度
    3. Oscillation Tendency - 振荡趋势
    4. Precursor Sensitivity - precursor 响应程度
    """
    def __init__(self):
        # 历史数据
        self.worker_history: deque = deque(maxlen=100)
        self.action_history: deque = deque(maxlen=100)
        self.precursor_history: deque = deque(maxlen=50)
        self.queue_history: deque = deque(maxlen=100)

        # 健康指标
        self.metrics = GovernorHealthMetrics()

    def update(
        self,
        tick: int,
        worker_count: int,
        action: str,
        precursor_score: float,
        queue_depth: int,
    ):
        """更新监控"""
        self.worker_history.append(worker_count)
        self.action_history.append(action)
        self.precursor_history.append(precursor_score)
        self.queue_history.append(queue_depth)

        # 计算健康指标
        self._compute_health_metrics(tick)

    def _compute_health_metrics(self, tick: int):
        """计算健康指标"""
        m = self.metrics
        m.tick = tick

        # 1. Responsiveness: action 频率
        actions = list(self.action_history)
        if len(actions) > 10:
            non_noop = sum(1 for a in actions[-20:] if a != 'no_op')
            m.responsiveness = non_noop / 20.0
        else:
            m.responsiveness = 0.5

        # 2. Smoothness: worker 变化方差
        workers = list(self.worker_history)
        if len(workers) > 5:
            changes = [abs(workers[i] - workers[i-1]) for i in range(1, len(workers))]
            avg_change = sum(changes[-20:]) / max(1, len(changes[-20:]))
            m.smoothness = 1.0 / (1.0 + avg_change * 0.1)
        else:
            m.smoothness = 1.0

        # 3. Oscillation Tendency: worker 方向变化频率
        if len(workers) > 10:
            directions = [workers[i] - workers[i-1] for i in range(1, len(workers))]
            sign_changes = sum(1 for i in range(1, len(directions)) if directions[i] * directions[i-1] < 0)
            m.oscillation_tendency = sign_changes / max(1, len(directions))
        else:
            m.oscillation_tendency = 0.0

        # 4. Precursor Sensitivity: precursor 与 action 的相关性
        precursors = list(self.precursor_history)
        if len(precursors) > 5 and len(actions) > 5:
            recent = min(20, len(precursors), len(actions))
            high_precursor = [precursors[-i] > 0.3 for i in range(1, recent)]
            took_action = [actions[-i] != 'no_op' for i in range(1, recent)]
            if high_precursor and took_action:
                matches = sum(1 for i in range(len(high_precursor)) if high_precursor[i] == took_action[i])
                m.precursor_sensitivity = matches / len(high_precursor)
            else:
                m.precursor_sensitivity = 0.5
        else:
            m.precursor_sensitivity = 0.5

        # 5. Health Score
        m.health_score = (
            m.smoothness * 0.4 +
            (1.0 - m.oscillation_tendency) * 0.3 +
            m.responsiveness * 0.2 +
            m.precursor_sensitivity * 0.1
        )

        # 6. 确定模式
        if m.health_score > 0.8:
            m.mode = "healthy"
        elif m.oscillation_tendency > 0.5:
            m.mode = "oscillating"
        elif m.responsiveness < 0.1:
            m.mode = "under_responsive"
        elif m.responsiveness > 0.8:
            m.mode = "over_responsive"
        else:
            m.mode = "balanced"


@dataclass
class ModeArbiter:
    """
    模式仲裁器

    根据 Governor 健康状态决定使用哪个调节模式
    """
    def __init__(self):
        self.current_profile = REGULATION_PROFILES["balanced"]
        self.profile_history: List[str] = []

    def decide_mode(self, health: GovernorHealthMetrics, runtime_regime: str) -> RegulationProfile:
        """
        决定调节模式

        决策因素：
        1. Governor 健康状态
        2. Runtime Regime
        3. 历史模式切换频率（避免频繁切换）
        """
        # 根据 Runtime Regime 选择基础模式
        if runtime_regime == "under_reactive" or runtime_regime == "dead":
            profile = REGULATION_PROFILES["aggressive"]
        elif runtime_regime == "hyper_reactive":
            profile = REGULATION_PROFILES["conservative"]
        elif runtime_regime == "critical":
            profile = REGULATION_PROFILES["emergency"]
        else:
            # 根据 Governor 健康状态调整
            if health.oscillation_tendency > 0.4:
                profile = REGULATION_PROFILES["conservative"]
            elif health.responsiveness < 0.2:
                profile = REGULATION_PROFILES["aggressive"]
            elif health.smoothness < 0.5:
                profile = REGULATION_PROFILES["balanced"]
            else:
                profile = REGULATION_PROFILES["balanced"]

        # 避免频繁切换
        if self.profile_history and self.profile_history[-1] != profile.name:
            # 检查是否最近刚切换
            recent_switches = sum(
                1 for i in range(1, min(10, len(self.profile_history)))
                if self.profile_history[-i] != self.profile_history[-i-1]
            )
            if recent_switches > 3:
                # 切换太频繁，保持当前模式
                profile = self.current_profile

        self.current_profile = profile
        self.profile_history.append(profile.name)

        return profile


@dataclass
class ParameterTuner:
    """
    参数调谐器

    动态调整调节参数
    """
    def __init__(self):
        # 当前参数
        self.risk_accumulation_rate = 0.3
        self.risk_decay_rate = 0.1
        self.max_scaling_rate = 0.15
        self.cooldown_base = 10
        self.aggressiveness = 0.5

        # 调谐历史
        self.tuning_history: List[Dict[str, float]] = []

    def tune(self, health: GovernorHealthMetrics, profile: RegulationProfile):
        """
        根据健康状态调整参数

        调整策略：
        - 如果 oscillation 太严重，降低 aggressiveness
        - 如果 responsiveness 太低，提高 aggressiveness
        - 如果 smoothness 很好，可以稍微激进
        """
        # 基于配置文件的基准值
        base_rate = profile.risk_accumulation_rate
        base_decay = profile.risk_decay_rate
        base_scaling = profile.max_scaling_rate
        base_cooldown = profile.cooldown_base
        base_aggression = profile.aggressiveness

        # 微调（±20%）
        adjustment = 0.0

        if health.oscillation_tendency > 0.4:
            # 振荡太严重，降低激进程度
            adjustment -= 0.1
        elif health.smoothness > 0.8 and health.oscillation_tendency < 0.2:
            # 非常平滑，可以稍微激进
            adjustment += 0.05

        if health.responsiveness < 0.15:
            # 反应太慢，提高激进程度
            adjustment += 0.1
        elif health.responsiveness > 0.9:
            # 反应过快，降低激进程度
            adjustment -= 0.1

        # 应用调整
        self.aggressiveness = max(0.1, min(1.0, base_aggression + adjustment))
        self.risk_accumulation_rate = base_rate * self.aggressiveness
        self.risk_decay_rate = base_decay / self.aggressiveness if self.aggressiveness > 0.1 else base_decay * 2
        self.max_scaling_rate = base_scaling * self.aggressiveness
        self.cooldown_base = int(base_cooldown / max(0.1, self.aggressiveness))

        # 记录调谐历史
        self.tuning_history.append({
            "health_score": health.health_score,
            "aggressiveness": self.aggressiveness,
            "oscillation": health.oscillation_tendency,
            "smoothness": health.smoothness,
        })

        # 限制历史长度
        if len(self.tuning_history) > 100:
            self.tuning_history.pop(0)


class AdaptiveGovernorV3(RuntimeSimulator):
    """
    Adaptive Predictive Governor V3

    核心创新：
    1. Governor Self-Monitoring - 监控自身调节有效性
    2. Mode Arbiter - 根据状态切换调节模式
    3. Parameter Tuner - 动态调整调节参数
    4. Meta-Regulation - 调节自己的调节机制
    """

    def __init__(
        self,
        config=None,
        timeline_recorder: RuntimeTimelineRecorder = None,
    ):
        super().__init__(config)

        # 时间线记录器
        self.recorder = timeline_recorder or RuntimeTimelineRecorder()

        # Precursor 检测器
        self.precursor_detector = PrecursorDetector()

        # Governor 自我监控
        self.self_monitor = GovernorSelfMonitor()

        # 模式仲裁器
        self.mode_arbiter = ModeArbiter()

        # 参数调谐器
        self.parameter_tuner = ParameterTuner()

        # 风险累积器
        self.risk_score = 0.0
        self.risk_history: List[float] = []

        # Stability 分析器
        self.analyzer = StabilityAnalyzer()

        # Cooldown
        self.cooldown_ticks = 0

        # 统计
        self.expansion_count = 0
        self.contraction_count = 0
        self.mode_switches = 0
        self.previous_mode = None

        print("[AdaptiveGovernorV3] 初始化完成")
        print(f"  初始模式: {self.mode_arbiter.current_profile.name}")

    def tick(self):
        """覆写 tick"""
        self._tick_count += 1
        self.state.tick = self._tick_count

        # 1. 生成新任务
        new_tasks = self._generate_workload()
        self.state.queue_depth += new_tasks

        # 2. 获取 precursor
        precursor = self.precursor_detector.update(
            tick=self.state.tick,
            queue=self.state.queue_depth,
            workers=self.state.worker_count,
        )

        # 3. 累积风险
        self._accumulate_risk(precursor)

        # 4. Governor 决策
        action = self._adaptive_decide(precursor)

        # 5. 执行动作
        self._apply_action(action)

        # 6. 处理已有任务
        self._process_tasks()

        # 7. 收集遥测
        self._collect_telemetry()

        # 8. 自我监控
        self._self_monitor_update(action, precursor)

        return self.state

    def _accumulate_risk(self, precursor):
        """累积风险"""
        new_risk = precursor.precursor_score

        # 基于当前 aggressiveness 调整累积
        rate = self.parameter_tuner.risk_accumulation_rate
        decay = self.parameter_tuner.risk_decay_rate

        if new_risk > 0.1:
            self.risk_score += rate * new_risk
        else:
            self.risk_score = max(0, self.risk_score - decay)

        self.risk_score = min(1.0, max(0.0, self.risk_score))
        self.risk_history.append(self.risk_score)

    def _adaptive_decide(self, precursor) -> str:
        """自适应决策"""
        # 更新冷却
        if self.cooldown_ticks > 0:
            self.cooldown_ticks -= 1

        # CPU 紧急处理
        cpu = self.state.cpu_usage
        if cpu > 0.85 and self.state.reflection_load > 0.1:
            return "disable_reflection"

        # Cooldown
        if self.cooldown_ticks > 0:
            return "no_op"

        # 基于 risk_score 和 queue 决策
        queue = self.state.queue_depth
        risk = self.risk_score
        profile = self.mode_arbiter.current_profile

        # 计算扩容需求
        queue_trend = self._compute_queue_trend()
        target_workers = max(1, int(queue / 10) + int(queue_trend / 10))
        worker_delta = target_workers - self.state.worker_count

        # 扩容决策
        if queue > profile.risk_decay_rate * 100 or risk > 0.3:
            if worker_delta > 0:
                # 限制扩容速度
                max_delta = max(1, int(self.state.worker_count * profile.max_scaling_rate))
                worker_delta = min(worker_delta, max_delta)
                self.expansion_count += 1
                self.cooldown_ticks = self.parameter_tuner.cooldown_base
                return "spawn_worker"

        # 缩容决策
        if queue < 20 and risk < 0.2 and self.state.worker_count > 5:
            self.contraction_count += 1
            self.cooldown_ticks = self.parameter_tuner.cooldown_base
            return "reduce_workers"

        # 恢复反射
        recent = self.state.action_history[-30:]
        suppress_ratio = sum(1 for a in recent if a == "disable_reflection") / max(1, len(recent))
        if suppress_ratio > 0.8 and cpu < 0.5:
            return "enable_reflection"

        return "no_op"

    def _self_monitor_update(self, action: str, precursor):
        """自我监控更新"""
        # 更新监控
        self.self_monitor.update(
            tick=self.state.tick,
            worker_count=self.state.worker_count,
            action=action,
            precursor_score=precursor.precursor_score,
            queue_depth=self.state.queue_depth,
        )

        # 决定是否切换模式
        runtime_regime = self._classify_runtime_regime()
        new_profile = self.mode_arbiter.decide_mode(
            self.self_monitor.metrics,
            runtime_regime
        )

        # 检测模式切换
        if new_profile.name != self.previous_mode:
            self.mode_switches += 1
            if self.previous_mode is not None:
                print(f"  [Mode Switch] {self.previous_mode} → {new_profile.name}")
            self.previous_mode = new_profile.name

        # 调整参数
        self.parameter_tuner.tune(self.self_monitor.metrics, new_profile)

    def _classify_runtime_regime(self) -> str:
        """分类 Runtime Regime"""
        queue = self.state.queue_depth
        workers = self.state.worker_count

        if queue > 10000:
            return "critical"
        elif queue > 5000:
            return "under_reactive"
        elif workers > 200:
            return "over_responsive"
        elif queue < 100 and workers < 50:
            return "healthy"
        else:
            return "balanced"

    def _compute_queue_trend(self) -> float:
        """计算 queue 趋势"""
        if len(self.state.queue_history) < 3:
            return 0.0
        recent = self.state.queue_history[-5:]
        return (recent[-1] - recent[0]) / (len(recent) - 1)

    def get_summary(self) -> Dict[str, Any]:
        """获取实验摘要"""
        metrics = self.analyzer.compute_metrics(self.state.tick)
        health = self.self_monitor.metrics

        return {
            "final_queue": self.state.queue_depth,
            "final_workers": self.state.worker_count,
            "final_cpu": self.state.cpu_usage,
            "oscillation_score": metrics.oscillation_score,
            "worker_churn_rate": metrics.worker_churn_rate,
            "expansion_count": self.expansion_count,
            "contraction_count": self.contraction_count,
            "mode_switches": self.mode_switches,
            "final_mode": self.self_monitor.metrics.mode,
            "governor_health_score": health.health_score,
            "control_smoothness": health.smoothness,
            "oscillation_tendency": health.oscillation_tendency,
            "responsiveness": health.responsiveness,
            "final_aggressiveness": self.parameter_tuner.aggressiveness,
        }


def run_comparison(
    arrival_rate: float = 30.0,
    duration: int = 500,
    seed: int = 42,
):
    """运行对比实验"""
    import random
    from training.simulator import GovernorConfig, DampedGovernor
    from training.simulator.predictive_governor import PredictiveGovernor, PredictiveGovernorConfig
    from training.simulator.predictive_governor_v2 import PredictiveGovernorV2, PredictiveGovernorV2Config

    print("\n" + "=" * 80)
    print(f"Adaptive Governor V3 对比实验 (rate={arrival_rate})")
    print("=" * 80)

    results = {}

    # === 1. Damped Governor ===
    print("\n[1] Damped Governor")
    random.seed(seed)
    damped_config = GovernorConfig(expand_threshold=100, shrink_threshold=20, cooldown_ticks=5, hysteresis_gap=80)
    damped_recorder = RuntimeTimelineRecorder()
    damped = DampedGovernor(damped_config, damped_recorder)
    damped.workload.burst_probability = 0.15
    damped.workload.base_arrival_rate = arrival_rate
    damped.run(duration_ticks=duration)
    damped_summary = damped.get_summary()
    results["damped"] = damped_summary
    print(f"  Queue={damped_summary['final_queue']}, Workers={damped_summary['final_workers']}, "
          f"Osc={damped_summary['oscillation_score']:.3f}")

    # === 2. Predictive V2 ===
    print("\n[2] Predictive V2")
    random.seed(seed)
    v2_config = PredictiveGovernorV2Config()
    v2_recorder = RuntimeTimelineRecorder()
    v2 = PredictiveGovernorV2(v2_config, v2_recorder)
    v2.workload.burst_probability = 0.15
    v2.workload.base_arrival_rate = arrival_rate
    v2.run(duration_ticks=duration)
    v2_summary = v2.get_summary()
    results["predictive_v2"] = v2_summary
    print(f"  Queue={v2_summary['final_queue']}, Workers={v2_summary['final_workers']}, "
          f"Osc={v2_summary['oscillation_score']:.3f}")

    # === 3. Adaptive Governor V3 ===
    print("\n[3] Adaptive Governor V3 (Meta-Regulation)")
    random.seed(seed)
    adaptive = AdaptiveGovernorV3()
    adaptive.workload.burst_probability = 0.15
    adaptive.workload.base_arrival_rate = arrival_rate
    adaptive.run(duration_ticks=duration)
    adaptive_summary = adaptive.get_summary()
    results["adaptive_v3"] = adaptive_summary
    print(f"  Queue={adaptive_summary['final_queue']}, Workers={adaptive_summary['final_workers']}, "
          f"Osc={adaptive_summary['oscillation_score']:.3f}, "
          f"ModeSwitches={adaptive_summary['mode_switches']}")
    print(f"  Governor Health={adaptive_summary['governor_health_score']:.3f}, "
          f"Aggressiveness={adaptive_summary['final_aggressiveness']:.2f}")

    # === 对比 ===
    print("\n" + "=" * 80)
    print("对比结果")
    print("=" * 80)
    print(f"{'Governor':<20} | {'Queue':>8} | {'Workers':>8} | {'Osc':>8} | {'Smooth':>8}")
    print("-" * 80)
    print(f"{'Damped':<20} | {results['damped']['final_queue']:>8} | "
          f"{results['damped']['final_workers']:>8} | "
          f"{results['damped']['oscillation_score']:>8.3f} | {'-':>8}")
    print(f"{'Predictive V2':<20} | {results['predictive_v2']['final_queue']:>8} | "
          f"{results['predictive_v2']['final_workers']:>8} | "
          f"{results['predictive_v2']['oscillation_score']:>8.3f} | "
          f"{results['predictive_v2']['control_smoothness']:>8.3f}")
    print(f"{'Adaptive V3':<20} | {results['adaptive_v3']['final_queue']:>8} | "
          f"{results['adaptive_v3']['final_workers']:>8} | "
          f"{results['adaptive_v3']['oscillation_score']:>8.3f} | "
          f"{results['adaptive_v3']['control_smoothness']:>8.3f}")

    return results


def main():
    """主函数"""
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--rate", "-r", type=float, default=30.0)
    parser.add_argument("--duration", "-d", type=int, default=500)
    parser.add_argument("--seed", "-s", type=int, default=42)
    args = parser.parse_args()

    run_comparison(args.rate, args.duration, args.seed)


if __name__ == '__main__':
    main()
