# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Predictive Governor v2: Risk Accumulator
# Path: python/training/simulator/predictive_governor_v2.py
#
# 核心创新：
# 1. Risk Accumulator - 累积 precursor 证据
# 2. Gradual Scaling Response - 渐进响应
# 3. Control Acceleration Penalty - 控制加速惩罚
# 4. Confidence-Aware Prediction - 置信度感知
#
# 从 binary emergency → continuous risk regulation
# ─────────────────────────────────────────────────────────────────

import sys
import os
from typing import Dict, Any, List, Optional
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
from training.simulator.precursor_observatory import PrecursorDetector, PrecursorMetrics


@dataclass
class RiskAccumulator:
    """
    风险累积器

    核心思想：
    - 不是 binary emergency
    - 而是累积 risk evidence
    - risk_score ∈ [0, 1]
    """
    # 配置
    accumulation_rate: float = 0.3  # 风险累积速率
    decay_rate: float = 0.1  # 风险衰减速率
    confidence_threshold: float = 0.7  # 置信度阈值

    # 状态
    risk_score: float = 0.0  # 累积风险分数
    confidence: float = 0.0  # 风险置信度
    risk_history: List[float] = field(default_factory=list)

    def update(self, precursor: PrecursorMetrics) -> Dict[str, float]:
        """
        更新风险累积器

        Returns:
            {'risk_score': float, 'confidence': float, 'risk_level': str}
        """
        # 新的风险信号
        new_risk = precursor.precursor_score

        # 累积风险
        if new_risk > 0.1:  # 只有显著信号才累积
            self.risk_score += self.accumulation_rate * new_risk
        else:
            # 风险衰减
            self.risk_score = max(0, self.risk_score - self.decay_rate)

        # 限制在 [0, 1]
        self.risk_score = min(1.0, max(0.0, self.risk_score))

        # 更新置信度（基于风险历史的一致性）
        self.risk_history.append(self.risk_score)
        if len(self.risk_history) > 20:
            self.risk_history.pop(0)

        # 置信度 = 高风险持续时间 / 总时间
        high_risk_count = sum(1 for r in self.risk_history if r > 0.5)
        self.confidence = high_risk_count / max(1, len(self.risk_history))

        # 确定风险等级
        if self.risk_score > 0.8:
            risk_level = "critical"
        elif self.risk_score > 0.6:
            risk_level = "high"
        elif self.risk_score > 0.4:
            risk_level = "medium"
        elif self.risk_score > 0.2:
            risk_level = "low"
        else:
            risk_level = "minimal"

        return {
            "risk_score": self.risk_score,
            "confidence": self.confidence,
            "risk_level": risk_level,
        }


@dataclass
class GradualScalingController:
    """
    渐进式扩容控制器

    核心思想：
    - 根据 risk_score 渐进调整扩容力度
    - 而非 binary emergency
    """
    # 配置
    max_scaling_rate: float = 0.2  # 最大扩容速率 (workers/tick)
    min_scaling_rate: float = 0.02  # 最小扩容速率

    # 状态
    current_scaling_rate: float = 0.05  # 当前扩容速率
    target_workers: int = 0  # 目标 workers 数

    def update(
        self,
        risk_score: float,
        current_workers: int,
        queue_depth: int,
        queue_trend: float,
    ) -> int:
        """
        根据 risk_score 计算扩容决策

        Returns:
            worker delta (可以为负)
        """
        # 计算目标 workers
        # 基于 queue 和 queue_trend
        base_target = max(1, int(queue_depth / 10))
        trend_adjustment = int(queue_trend / 10)
        self.target_workers = max(1, base_target + trend_adjustment)

        # 根据 risk_score 调整
        if risk_score > 0.8:
            # Critical: 快速扩容到目标
            self.current_scaling_rate = self.max_scaling_rate
        elif risk_score > 0.6:
            # High: 较快扩容
            self.current_scaling_rate = self.max_scaling_rate * 0.7
        elif risk_score > 0.4:
            # Medium: 正常扩容
            self.current_scaling_rate = 0.1
        elif risk_score > 0.2:
            # Low: 缓慢扩容
            self.current_scaling_rate = self.min_scaling_rate * 2
        else:
            # Minimal: 极慢扩容
            self.current_scaling_rate = self.min_scaling_rate

        # 计算 worker delta
        delta = self.target_workers - current_workers

        # 限制最大变化量
        max_delta = int(current_workers * self.current_scaling_rate)
        max_delta = max(1, max_delta)  # 至少 1

        if delta > 0:
            return min(delta, max_delta)
        else:
            return max(delta, -max_delta)


@dataclass
class ControlCostTracker:
    """
    控制成本追踪器

    核心思想：
    - 扩容有代价
    - 变化过快有代价
    - 需要平衡风险与代价
    """
    # 状态
    worker_count_history: deque = field(default_factory=deque)
    acceleration_history: deque = field(default_factory=deque)

    # 成本系数
    spawn_cost: float = 0.1  # 每次 spawn 的基础代价
    acceleration_cost: float = 0.5  # 加速变化的高额代价
    churn_cost: float = 0.2  # worker 变更代价

    def compute_cost(self, worker_delta: int) -> float:
        """
        计算控制动作的代价

        Returns:
            控制代价 (越高越不倾向于该动作)
        """
        cost = 0.0

        if worker_delta > 0:
            # Spawn 代价
            cost += self.spawn_cost * worker_delta

            # 计算加速度
            if len(self.worker_count_history) >= 2:
                current_accel = worker_delta - (self.worker_count_history[-1] - self.worker_count_history[-2])
                self.acceleration_history.append(current_accel)

                # 高加速度 = 高代价
                if abs(current_accel) > 5:
                    cost += self.acceleration_cost * abs(current_accel)

        elif worker_delta < 0:
            # Kill 代价
            cost += self.churn_cost * abs(worker_delta)

        return cost

    def update(self, new_worker_count: int):
        """更新历史"""
        self.worker_count_history.append(new_worker_count)
        if len(self.worker_count_history) > 10:
            self.worker_count_history.popleft()

    def get_smoothness(self) -> float:
        """获取控制平滑度 (0-1, 越高越平滑)"""
        if len(self.worker_count_history) < 3:
            return 1.0

        # 计算方差
        values = list(self.worker_count_history)
        mean = sum(values) / len(values)
        variance = sum((v - mean) ** 2 for v in values) / len(values)

        # 平滑度 = 1 / (1 + variance)
        return 1.0 / (1.0 + variance * 0.01)


@dataclass
class PredictiveGovernorV2Config:
    """Predictive Governor V2 配置"""
    # 基础阈值
    expand_threshold: int = 100
    shrink_threshold: int = 20

    # Risk Accumulator
    risk_accumulation_rate: float = 0.3
    risk_decay_rate: float = 0.1
    risk_confidence_threshold: float = 0.7

    # Gradual Scaling
    max_scaling_rate: float = 0.2
    min_scaling_rate: float = 0.02

    # Control Cost
    spawn_cost: float = 0.1
    acceleration_cost: float = 0.5
    churn_cost: float = 0.2

    # CPU 控制
    cpu_high: float = 0.85
    cpu_low: float = 0.5

    # 反射控制
    reflection_suppress_threshold: float = 0.8


class PredictiveGovernorV2(RuntimeSimulator):
    """
    Predictive Governor V2

    核心创新：
    1. Risk Accumulator - 累积风险证据，而非 binary emergency
    2. Gradual Scaling - 渐进式扩容，而非激进扩容
    3. Control Cost - 控制扩容代价，避免频繁变更
    4. Control Smoothness - 追求平滑控制
    """

    def __init__(
        self,
        config: PredictiveGovernorV2Config = None,
        timeline_recorder: RuntimeTimelineRecorder = None,
    ):
        super().__init__(config)
        self.config = config or PredictiveGovernorV2Config()

        # 时间线记录器
        self.recorder = timeline_recorder or RuntimeTimelineRecorder()

        # Precursor 检测器
        self.precursor_detector = PrecursorDetector()

        # Risk Accumulator
        self.risk_accumulator = RiskAccumulator(
            accumulation_rate=self.config.risk_accumulation_rate,
            decay_rate=self.config.risk_decay_rate,
            confidence_threshold=self.config.risk_confidence_threshold,
        )

        # Gradual Scaling Controller
        self.scaling_controller = GradualScalingController(
            max_scaling_rate=self.config.max_scaling_rate,
            min_scaling_rate=self.config.min_scaling_rate,
        )

        # Control Cost Tracker
        self.cost_tracker = ControlCostTracker(
            spawn_cost=self.config.spawn_cost,
            acceleration_cost=self.config.acceleration_cost,
            churn_cost=self.config.churn_cost,
        )

        # Stability 分析器
        self.analyzer = StabilityAnalyzer()

        # Cooldown
        self.cooldown_ticks = 0

        # 统计
        self.expansion_count = 0
        self.contraction_count = 0
        self.risk_level_counts = {"minimal": 0, "low": 0, "medium": 0, "high": 0, "critical": 0}

        print("[PredictiveGovernorV2] 初始化完成")

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

        # 3. 更新 Risk Accumulator
        risk_info = self.risk_accumulator.update(precursor)
        self.risk_level_counts[risk_info["risk_level"]] += 1

        # 4. Governor 决策
        action = self.governor_decide(risk_info, precursor)

        # 5. 执行动作
        self._apply_action(action)

        # 6. 更新控制成本追踪
        if action == "spawn_worker":
            self.cost_tracker.update(self.state.worker_count)
        elif action == "reduce_workers":
            self.cost_tracker.update(self.state.worker_count)

        # 7. 处理已有任务
        self._process_tasks()

        # 8. 收集遥测
        self._collect_telemetry()

        return self.state

    def governor_decide(self, risk_info: Dict[str, float], precursor: PrecursorMetrics) -> str:
        """
        Predictive Governor V2 决策

        决策逻辑：
        1. CPU Emergency → 禁用反射
        2. Cooldown 检查
        3. 基于 Risk Score 的渐进式扩容/缩容
        """
        # 更新冷却
        if self.cooldown_ticks > 0:
            self.cooldown_ticks -= 1

        risk_score = risk_info["risk_score"]

        cpu = self.state.cpu_usage

        # === 1. CPU Emergency ===
        if cpu > self.config.cpu_high and self.state.reflection_load > 0.1:
            return "disable_reflection"

        # === 2. Cooldown ===
        if self.cooldown_ticks > 0:
            return "no_op"

        # === 3. Gradual Scaling ===
        queue_trend = self._compute_queue_trend()
        worker_delta = self.scaling_controller.update(
            risk_score=risk_score,
            current_workers=self.state.worker_count,
            queue_depth=self.state.queue_depth,
            queue_trend=queue_trend,
        )

        # 考虑控制代价
        control_cost = self.cost_tracker.compute_cost(worker_delta)

        # 缩容决策（只有当 queue 很低且 risk 很低时）
        if (self.state.queue_depth < self.config.shrink_threshold and
            risk_score < 0.2 and
            self.state.worker_count > 5 and
            worker_delta < 0):
            self.contraction_count += 1
            self.cooldown_ticks = 10
            return "reduce_workers"

        # 扩容决策
        if worker_delta > 0:
            # 计算扩容收益 vs 代价
            expansion_threshold = self.config.expand_threshold * (1.0 - risk_score * 0.5)

            if self.state.queue_depth > expansion_threshold:
                # 扩容收益大于代价
                self.expansion_count += 1
                self.cooldown_ticks = max(2, int(10 * (1 - risk_score)))
                return "spawn_worker"

        # === 4. Recovery Reflection ===
        recent = self.state.action_history[-30:]
        suppress_ratio = sum(1 for a in recent if a == "disable_reflection") / max(1, len(recent))
        if suppress_ratio > self.config.reflection_suppress_threshold and cpu < self.config.cpu_low:
            return "enable_reflection"

        return "no_op"

    def _compute_queue_trend(self) -> float:
        """计算 queue 趋势"""
        if len(self.state.queue_history) < 3:
            return 0.0
        recent = self.state.queue_history[-5:]
        if len(recent) < 2:
            return 0.0
        return (recent[-1] - recent[0]) / (len(recent) - 1)

    def get_summary(self) -> Dict[str, Any]:
        """获取实验摘要"""
        metrics = self.analyzer.compute_metrics(self.state.tick)
        smoothness = self.cost_tracker.get_smoothness()

        return {
            "final_queue": self.state.queue_depth,
            "final_workers": self.state.worker_count,
            "final_cpu": self.state.cpu_usage,
            "oscillation_score": metrics.oscillation_score,
            "worker_churn_rate": metrics.worker_churn_rate,
            "expansion_count": self.expansion_count,
            "contraction_count": self.contraction_count,
            "control_smoothness": smoothness,
            "risk_level_counts": self.risk_level_counts,
            "final_risk_score": self.risk_accumulator.risk_score,
        }


def run_comparison(
    arrival_rate: float = 30.0,
    duration: int = 500,
    seed: int = 42,
) -> Dict[str, Any]:
    """
    对比实验: Damped vs Predictive V1 vs Predictive V2
    """
    import random
    from training.simulator import GovernorConfig, DampedGovernor
    from training.simulator.predictive_governor import PredictiveGovernor, PredictiveGovernorConfig

    print("\n" + "=" * 80)
    print(f"Predictive Governor V2 对比实验 (rate={arrival_rate})")
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
    damped_summary["final_risk_score"] = 0.0
    results["damped"] = damped_summary
    print(f"  Queue={damped_summary['final_queue']}, Workers={damped_summary['final_workers']}, "
          f"Osc={damped_summary['oscillation_score']:.3f}")

    # === 2. Predictive V1 ===
    print("\n[2] Predictive V1 (binary emergency)")
    random.seed(seed)
    v1_config = PredictiveGovernorConfig()
    v1_recorder = RuntimeTimelineRecorder()
    v1 = PredictiveGovernor(v1_config, v1_recorder)
    v1.workload.burst_probability = 0.15
    v1.workload.base_arrival_rate = arrival_rate
    v1.run(duration_ticks=duration)
    v1_summary = v1.get_summary()
    v1_summary["final_risk_score"] = 0.0
    results["predictive_v1"] = v1_summary
    print(f"  Queue={v1_summary['final_queue']}, Workers={v1_summary['final_workers']}, "
          f"Osc={v1_summary['oscillation_score']:.3f}")

    # === 3. Predictive V2 ===
    print("\n[3] Predictive V2 (risk accumulator + gradual scaling)")
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
          f"Osc={v2_summary['oscillation_score']:.3f}, Smoothness={v2_summary['control_smoothness']:.3f}")

    # === 对比 ===
    print("\n" + "=" * 80)
    print("对比结果")
    print("=" * 80)
    print(f"{'Governor':<15} | {'Queue':>8} | {'Workers':>8} | {'Osc':>8} | {'Smoothness':>10}")
    print("-" * 80)
    print(f"{'Damped':<15} | {results['damped']['final_queue']:>8} | "
          f"{results['damped']['final_workers']:>8} | "
          f"{results['damped']['oscillation_score']:>8.3f} | {'-':>10}")
    print(f"{'Predictive V1':<15} | {results['predictive_v1']['final_queue']:>8} | "
          f"{results['predictive_v1']['final_workers']:>8} | "
          f"{results['predictive_v1']['oscillation_score']:>8.3f} | {'-':>10}")
    print(f"{'Predictive V2':<15} | {results['predictive_v2']['final_queue']:>8} | "
          f"{results['predictive_v2']['final_workers']:>8} | "
          f"{results['predictive_v2']['oscillation_score']:>8.3f} | "
          f"{results['predictive_v2']['control_smoothness']:>10.3f}")

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
