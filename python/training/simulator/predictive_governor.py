# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Predictive Governor Prototype
# Path: python/training/simulator/predictive_governor.py
#
# 核心创新：
# 1. Precursor-Aware Decision Making
# 2. Gentle Preemptive Scaling
# 3. Adaptive Cooldown
#
# 从 reactive governance → predictive homeostasis
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
from training.simulator.runtime_regime_classifier import RuntimeRegimeClassifier, RuntimeRegime
from training.simulator.precursor_observatory import PrecursorDetector, PrecursorMetrics


@dataclass
class PredictiveGovernorConfig:
    """
    Predictive Governor 配置

    核心思想：
    1. 不只看 queue 大小
    2. 看 precursor_score 趋势
    3. Gentle preemptive scaling（温和预防性扩容）
    4. Adaptive cooldown（自适应冷却）
    """
    # 基础阈值
    expand_threshold: int = 100
    shrink_threshold: int = 20

    # Precursor 阈值（新增）
    precursor_expand_threshold: float = 0.3  # precursor > 0.3 → 预防性扩容
    precursor_shrink_threshold: float = 0.15  # precursor < 0.15 → 可以缩容
    precursor_emergency: float = 0.6  # precursor > 0.6 → 紧急扩容

    # Cooldown
    base_cooldown: int = 5
    min_cooldown: int = 1
    max_cooldown: int = 20

    # Gentle Scaling
    gentle_scaling_factor: float = 0.5  # 预防性扩容只用 50% 力度
    emergency_scaling_factor: float = 1.0  # 紧急扩容用 100% 力度

    # CPU 控制
    cpu_high: float = 0.85
    cpu_low: float = 0.5

    # 反射控制
    reflection_suppress_threshold: float = 0.8


@dataclass
class GovernorAction:
    """Governor 动作"""
    type: str  # spawn, reduce, no_op, enable_reflection, disable_reflection
    reason: str
    scaling_type: str = "normal"  # normal, gentle_preemptive, emergency
    precursor_score: float = 0.0
    cooldown_override: int = None  # None = 使用默认


class PredictiveGovernor(RuntimeSimulator):
    """
    Predictive Governor

    核心创新：
    1. Precursor-Aware: 不仅仅看 queue，看 precursor_score
    2. Gentle Preemptive: 预防性扩容用 gentle 方式
    3. Adaptive Cooldown: 根据 precursor 动态调整 cooldown
    4. Regime-Aware: 根据 regime 调整决策
    """

    def __init__(
        self,
        config: PredictiveGovernorConfig = None,
        timeline_recorder: RuntimeTimelineRecorder = None,
    ):
        super().__init__(config)
        self.config = config or PredictiveGovernorConfig()

        # 时间线记录器
        self.recorder = timeline_recorder or RuntimeTimelineRecorder()

        # Precursor 检测器
        self.precursor_detector = PrecursorDetector()

        # Stability 分析器
        self.analyzer = StabilityAnalyzer()

        # Regime 分类器
        self.regime_classifier = RuntimeRegimeClassifier()

        # Cooldown 状态
        self.cooldown_ticks = 0
        self.current_cooldown = self.config.base_cooldown

        # 统计
        self.expansion_count = 0
        self.contraction_count = 0
        self.gentle_scaling_count = 0
        self.emergency_scaling_count = 0
        self.preemptive_actions = 0  # 预防性动作

        # 历史
        self.precursor_history: deque = deque(maxlen=50)
        self.action_reasons: List[str] = []

        print("[Predictive Governor] 初始化完成")
        self._print_config()

    def _print_config(self):
        """打印配置"""
        print(f"  [阈值]")
        print(f"    expand_threshold: {self.config.expand_threshold}")
        print(f"    shrink_threshold: {self.config.shrink_threshold}")
        print(f"  [Precursor]")
        print(f"    expand_threshold: {self.config.precursor_expand_threshold}")
        print(f"    emergency: {self.config.precursor_emergency}")
        print(f"  [Cooldown]")
        print(f"    base: {self.config.base_cooldown}")
        print(f"    range: {self.config.min_cooldown} - {self.config.max_cooldown}")
        print(f"  [Scaling]")
        print(f"    gentle_factor: {self.config.gentle_scaling_factor}")
        print(f"    emergency_factor: {self.config.emergency_scaling_factor}")

    def tick(self):
        """覆写 tick - 保持和父类一致的结构"""
        self._tick_count += 1
        self.state.tick = self._tick_count

        # 1. 生成新任务
        new_tasks = self._generate_workload()
        self.state.queue_depth += new_tasks

        # 2. 获取当前 precursor（在决策前）
        precursor = self.precursor_detector.update(
            tick=self.state.tick,
            queue=self.state.queue_depth,
            workers=self.state.worker_count,
        )
        self.precursor_history.append(precursor)

        # 3. Governor 决策
        action = self.governor_decide()

        # 4. 执行动作
        self._apply_action(action)

        # 5. 处理已有任务
        self._process_tasks()

        # 6. 收集遥测
        self._collect_telemetry()

        # 7. 记录到时间线
        self._record_to_timeline(precursor)

        return self.state

    def governor_decide(self) -> str:
        """
        Predictive Governor 决策

        决策优先级：
        1. CPU Emergency → 禁用反射
        2. Emergency (precursor > emergency OR diverging) → 紧急扩容
        3. Preemptive Scaling → 预防性扩容
        4. Normal Queue-Based
        5. Shrink
        6. Recovery Reflection
        7. No-op
        """
        # 更新冷却
        if self.cooldown_ticks > 0:
            self.cooldown_ticks -= 1

        # 获取当前 precursor
        precursor = self.precursor_history[-1] if self.precursor_history else PrecursorMetrics()
        precursor_score = precursor.precursor_score

        # 自适应 cooldown（基于 precursor）
        self._adaptive_cooldown(precursor_score)

        cpu = self.state.cpu_usage

        # === 1. CPU Emergency: 禁用反射 ===
        if cpu > self.config.cpu_high and self.state.reflection_load > 0.1:
            reason = f"cpu_emergency: cpu={cpu:.2f}"
            self.action_reasons.append(reason)
            return self._execute_action("disable_reflection", reason, "normal", precursor_score)

        # === 2. Emergency: precursor > emergency OR 队列发散 → 紧急扩容 ===
        precursor_trend = self._compute_precursor_trend()
        is_diverging = precursor.is_diverging if precursor else False
        queue_trend = self._compute_queue_trend()

        if precursor_score > self.config.precursor_emergency or is_diverging:
            self.emergency_scaling_count += 1
            self.preemptive_actions += 1
            reason = f"emergency: precursor={precursor_score:.2f}, diverging={is_diverging}"
            self.action_reasons.append(reason)
            return self._execute_action("spawn_worker", reason, "emergency", precursor_score)

        # === 3. Preemptive Scaling: precursor 上升 OR queue 增长快 → 预防性扩容 ===
        if (precursor_trend > 0.01 or queue_trend > 50) and self.state.queue_depth > self.config.expand_threshold * 0.3:
            self.gentle_scaling_count += 1
            self.preemptive_actions += 1
            reason = f"preemptive: precursor_trend={precursor_trend:.3f}, queue_trend={queue_trend:.0f}"
            self.action_reasons.append(reason)
            return self._execute_action("spawn_worker", reason, "gentle_preemptive", precursor_score)

        # === 4. Normal Queue-Based ===
        if self.state.queue_depth > self.config.expand_threshold:
            self.expansion_count += 1
            reason = f"queue_based: queue={self.state.queue_depth}"
            self.action_reasons.append(reason)
            return self._execute_action("spawn_worker", reason, "normal", precursor_score)

        # === 5. Shrink: queue 低且 precursor 低 ===
        if (self.state.queue_depth < self.config.shrink_threshold and
            precursor_score < self.config.precursor_shrink_threshold and
            self.state.worker_count > 5):
            self.contraction_count += 1
            reason = f"shrink: queue={self.state.queue_depth}, precursor={precursor_score:.2f}"
            self.action_reasons.append(reason)
            return self._execute_action("reduce_workers", reason, "normal", precursor_score)

        # === 6. Recovery Reflection ===
        recent = self.state.action_history[-30:]
        suppress_ratio = sum(1 for a in recent if a == "disable_reflection") / max(1, len(recent))
        if suppress_ratio > self.config.reflection_suppress_threshold and cpu < self.config.cpu_low:
            reason = f"recovery_reflection: suppress_ratio={suppress_ratio:.2f}"
            self.action_reasons.append(reason)
            return self._execute_action("enable_reflection", reason, "normal", precursor_score)

        # === 7. No-op ===
        reason = f"no_op: queue={self.state.queue_depth}, precursor={precursor_score:.2f}"
        self.action_reasons.append(reason)
        return self._execute_action("no_op", reason, "normal", precursor_score)

    def _adaptive_cooldown(self, precursor_score: float):
        """
        自适应 cooldown

        核心思想：
        - precursor 高 → 减少 cooldown（需要快速响应）
        - precursor 低 → 增加 cooldown（可以慢一点）
        """
        # 计算 cooldown 调整
        if precursor_score > 0.5:
            # 高危：最小 cooldown
            target_cooldown = self.config.min_cooldown
        elif precursor_score > 0.3:
            # 预警：中等 cooldown
            target_cooldown = int(self.config.base_cooldown * 0.5)
        elif precursor_score > 0.15:
            # 正常：基础 cooldown
            target_cooldown = self.config.base_cooldown
        else:
            # 安全：较长 cooldown
            target_cooldown = min(self.config.max_cooldown, int(self.config.base_cooldown * 1.5))

        # 平滑过渡
        self.current_cooldown = int(self.current_cooldown * 0.8 + target_cooldown * 0.2)

    def _compute_precursor_trend(self) -> float:
        """计算 precursor 趋势"""
        if len(self.precursor_history) < 5:
            return 0.0

        recent = list(self.precursor_history)[-5:]
        # 简单线性回归斜率
        n = len(recent)
        mean_x = (n - 1) / 2.0
        mean_y = sum(p.precursor_score for p in recent) / n
        cov = sum((i - mean_x) * (recent[i].precursor_score - mean_y) for i in range(n))
        var_x = sum((i - mean_x) ** 2 for i in range(n))

        if var_x == 0:
            return 0.0
        return cov / var_x

    def _compute_queue_trend(self) -> float:
        """计算 queue 趋势 (d(queue)/dt)"""
        if len(self.state.queue_history) < 3:
            return 0.0
        recent = self.state.queue_history[-5:]
        if len(recent) < 2:
            return 0.0
        return (recent[-1] - recent[0]) / (len(recent) - 1)

    def _execute_action(
        self,
        action_type: str,
        reason: str,
        scaling_type: str,
        precursor_score: float,
    ) -> str:
        """执行动作"""
        self.state.action_history.append(action_type)

        # 应用动作
        if action_type == "spawn_worker":
            self.state.worker_count += 1
            # Gentle scaling 力度控制
            if scaling_type == "gentle_preemptive":
                pass  # 已经只加 1
        elif action_type == "reduce_workers":
            self.state.worker_count = max(1, self.state.worker_count - 1)
        elif action_type == "enable_reflection":
            self.state.reflection_load = min(1.0, self.state.reflection_load + 0.2)
        elif action_type == "disable_reflection":
            self.state.reflection_load = max(0.0, self.state.reflection_load - 0.2)

        # 设置 cooldown
        if scaling_type == "emergency":
            self.cooldown_ticks = self.config.min_cooldown
        elif scaling_type == "gentle_preemptive":
            self.cooldown_ticks = int(self.current_cooldown * 0.5)
        else:
            self.cooldown_ticks = self.current_cooldown

        # 更新分析器
        self.analyzer.record(self.state.tick, {
            'queue_depth': self.state.queue_depth,
            'cpu_usage': self.state.cpu_usage,
            'worker_count': self.state.worker_count,
        }, action_type)

        return action_type

    def _record_to_timeline(self, precursor: PrecursorMetrics):
        """记录到时间线"""
        # 构建 RuntimeState
        runtime_state = RuntimeState(
            queue_depth=self.state.queue_depth,
            worker_count=self.state.worker_count,
            cpu_usage=self.state.cpu_usage,
            token_pressure=self.state.token_pressure,
            reflection_load=self.state.reflection_load,
            memory_pressure=0.0,
            active_agents=self.state.active_agents,
            projection_lag=precursor.time_to_collapse if precursor.time_to_collapse != float('inf') else 0.0,
            scheduler_congestion=0.0,
            attention_collapse=0.0,
            starvation_penalty_count=0,
        )

        # 构建 RawTelemetry
        raw_telemetry = RawTelemetry(
            spawn_count=self.expansion_count,
            kill_count=self.contraction_count,
            reflection_requests=0,
            reflection_suppressed=0,
            task_arrivals=int(self.workload.base_arrival_rate * self.state.tick),
            task_completions=self.state.queue_depth,
            cpu_samples=[self.state.cpu_usage],
            queue_samples=[self.state.queue_depth],
        )

        # 构建 DerivedMetrics
        stability = self.analyzer.compute_metrics(self.state.tick)
        derived_metrics = DerivedMetrics(
            oscillation_score=stability.oscillation_score,
            worker_churn_rate=stability.worker_churn_rate,
            queue_oscillation_amplitude=stability.queue_oscillation_amplitude,
            cpu_oscillation_amplitude=stability.cpu_oscillation_amplitude,
            overshoot_ratio=stability.overshoot_ratio,
            recovery_half_life=stability.queue_recovery_half_life,
            stabilization_time=stability.stabilization_time,
            action_frequency=stability.action_frequency,
        )

        # 构建 Action
        action_type = self.state.action_history[-1] if self.state.action_history else "no_op"
        action = Action(
            type=action_type,
            intent=self._get_action_intent(action_type),
            delta=1 if action_type in ["spawn_worker", "reduce_workers"] else 0,
            reason=self.action_reasons[-1] if self.action_reasons else "",
            blocked_by_cooldown=self.cooldown_ticks > 0,
        )

        # 事件
        events = []
        if precursor.warning_level == "warning":
            events.append(Event(type="precursor_warning", severity="warning",
                              data={"precursor_score": precursor.precursor_score}))
        elif precursor.warning_level == "critical":
            events.append(Event(type="precursor_critical", severity="critical",
                              data={"precursor_score": precursor.precursor_score}))
        if precursor.is_diverging:
            events.append(Event(type="diverging", severity="warning",
                              data={"divergence_rate": precursor.queue_divergence_rate}))
        if precursor.is_saturated:
            events.append(Event(type="saturated", severity="warning",
                              data={"saturation_ratio": precursor.control_saturation_ratio}))

        # 记录
        self.recorder.record(
            tick=self.state.tick,
            state=runtime_state,
            action=action,
            raw_telemetry=raw_telemetry,
            derived_metrics=derived_metrics,
            events=events,
        )

    def _get_action_intent(self, action: str) -> str:
        """获取动作意图"""
        intents = {
            "spawn_worker": "expand_capacity",
            "reduce_workers": "shrink_capacity",
            "enable_reflection": "enable_meta",
            "disable_reflection": "suppress_meta",
            "no_op": "none",
        }
        return intents.get(action, "unknown")

    def get_summary(self) -> Dict[str, Any]:
        """获取实验摘要"""
        metrics = self.analyzer.compute_metrics(self.state.tick)

        return {
            "final_queue": self.state.queue_depth,
            "final_workers": self.state.worker_count,
            "final_cpu": self.state.cpu_usage,
            "oscillation_score": metrics.oscillation_score,
            "worker_churn_rate": metrics.worker_churn_rate,
            "expansion_count": self.expansion_count,
            "contraction_count": self.contraction_count,
            "gentle_scaling_count": self.gentle_scaling_count,
            "emergency_scaling_count": self.emergency_scaling_count,
            "preemptive_actions": self.preemptive_actions,
            "preemptive_ratio": self.preemptive_actions / max(1, self.expansion_count + self.gentle_scaling_count + self.emergency_scaling_count),
        }

    def save_timeline(self, filename: str = None) -> str:
        """保存时间线"""
        return self.recorder.save(filename or f"predictive_{self.recorder.run_id}.jsonl")


def run_comparison_experiment(
    arrival_rate: float = 30.0,
    duration: int = 500,
    seed: int = 42,
) -> Dict[str, Any]:
    """
    对比实验：Predictive Governor vs Damped Governor
    """
    import random

    print("\n" + "=" * 70)
    print("Predictive Governor vs Damped Governor 对比实验")
    print(f"arrival_rate={arrival_rate}, duration={duration}, seed={seed}")
    print("=" * 70)

    from training.simulator import GovernorConfig, DampedGovernor

    # === Damped Governor ===
    print("\n[1] Damped Governor (baseline)")
    print("-" * 40)

    damped_config = GovernorConfig(
        expand_threshold=100,
        shrink_threshold=20,
        cooldown_ticks=5,
        hysteresis_gap=80,
    )

    damped_recorder = RuntimeTimelineRecorder()
    damped_recorder.set_random_seed(seed)
    damped_recorder.set_workload_config({
        "base_arrival_rate": arrival_rate,
        "burst_probability": 0.15,
    })

    damped = DampedGovernor(damped_config, damped_recorder)
    damped.workload.burst_probability = 0.15
    damped.workload.base_arrival_rate = arrival_rate

    random.seed(seed)
    damped.run(duration_ticks=duration)

    damped_summary = damped.get_summary()
    damped_recorder.save(f"compare_damped_rate{arrival_rate}.jsonl")

    print(f"  Final Queue: {damped_summary['final_queue']}")
    print(f"  Final Workers: {damped_summary['final_workers']}")
    print(f"  Oscillation: {damped_summary['oscillation_score']:.3f}")
    print(f"  Expansion: {damped_summary['expansion_count']}")

    # === Predictive Governor ===
    print("\n[2] Predictive Governor (our approach)")
    print("-" * 40)

    predictive_config = PredictiveGovernorConfig(
        expand_threshold=100,
        shrink_threshold=20,
        precursor_expand_threshold=0.3,
        precursor_emergency=0.6,
        base_cooldown=5,
    )

    predictive_recorder = RuntimeTimelineRecorder()
    predictive_recorder.set_random_seed(seed)
    predictive_recorder.set_workload_config({
        "base_arrival_rate": arrival_rate,
        "burst_probability": 0.15,
    })

    predictive = PredictiveGovernor(predictive_config, predictive_recorder)
    predictive.workload.burst_probability = 0.15
    predictive.workload.base_arrival_rate = arrival_rate

    random.seed(seed)
    predictive.run(duration_ticks=duration)

    predictive_summary = predictive.get_summary()
    predictive_recorder.save(f"compare_predictive_rate{arrival_rate}.jsonl")

    print(f"  Final Queue: {predictive_summary['final_queue']}")
    print(f"  Final Workers: {predictive_summary['final_workers']}")
    print(f"  Oscillation: {predictive_summary['oscillation_score']:.3f}")
    print(f"  Expansion: {predictive_summary['expansion_count']}")
    print(f"  Gentle Scaling: {predictive_summary['gentle_scaling_count']}")
    print(f"  Emergency Scaling: {predictive_summary['emergency_scaling_count']}")
    print(f"  Preemptive Ratio: {predictive_summary['preemptive_ratio']:.1%}")

    # === 对比 ===
    print("\n" + "=" * 70)
    print("对比结果")
    print("=" * 70)

    def compare(name, val1, val2, lower_is_better=True):
        if lower_is_better:
            diff = val1 - val2
            pct = abs(diff / val1 * 100) if val1 != 0 else 0
            better = "✅" if diff > 0 else "❌"
        else:
            diff = val2 - val1
            pct = abs(diff / val1 * 100) if val1 != 0 else 0
            better = "✅" if diff > 0 else "❌"
        print(f"  {name}: Damped={val1:.1f}, Predictive={val2:.1f} ({better} {pct:.0f}%)")

    compare("Final Queue", damped_summary['final_queue'], predictive_summary['final_queue'])
    compare("Oscillation", damped_summary['oscillation_score'], predictive_summary['oscillation_score'])
    compare("Expansion Count", damped_summary['expansion_count'], predictive_summary['expansion_count'])

    return {
        "damped": damped_summary,
        "predictive": predictive_summary,
    }


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="Predictive Governor Prototype")
    parser.add_argument("--rate", "-r", type=float, default=30.0, help="arrival_rate")
    parser.add_argument("--duration", "-d", type=int, default=500, help="duration")
    parser.add_argument("--seed", "-s", type=int, default=42, help="random seed")
    parser.add_argument("--compare", action="store_true", help="compare with Damped Governor")

    args = parser.parse_args()

    if args.compare:
        run_comparison_experiment(args.rate, args.duration, args.seed)
    else:
        print("Predictive Governor 单独运行...")
        import random

        config = PredictiveGovernorConfig()
        recorder = RuntimeTimelineRecorder()
        recorder.set_random_seed(args.seed)
        recorder.set_workload_config({"base_arrival_rate": args.rate})

        governor = PredictiveGovernor(config, recorder)
        governor.workload.burst_probability = 0.15
        governor.workload.base_arrival_rate = args.rate

        random.seed(args.seed)
        governor.run(duration_ticks=args.duration)

        summary = governor.get_summary()
        governor.save_timeline(f"predictive_rate{args.rate}.jsonl")

        print("\n结果摘要:")
        for key, value in summary.items():
            print(f"  {key}: {value}")


if __name__ == '__main__':
    main()
