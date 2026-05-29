# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor Comparison: 零阻尼 vs 带阻尼
# Path: python/training/simulator/governor_comparison.py
#
# 核心实验：验证 Hysteresis + Cooldown 是否能稳定系统
# ─────────────────────────────────────────────────────────────────

import sys
import os

# 设置路径
script_dir = os.path.dirname(os.path.abspath(__file__))
training_dir = os.path.dirname(script_dir)
python_dir = os.path.dirname(training_dir)
sys.path.insert(0, python_dir)

import random
from dataclasses import dataclass
from typing import Dict, Any, Optional, List

# 设置 UTF-8 输出
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

from training.simulator.runtime_simulator import RuntimeSimulator
from training.simulator.stability_metrics import StabilityAnalyzer, StabilityMetrics
from training.simulator.timeline_recorder import (
    RuntimeTimelineRecorder,
    RuntimeState,
    Action,
    RawTelemetry,
    DerivedMetrics,
    Event,
)


@dataclass
class GovernorConfig:
    """Governor 配置"""
    # 阈值
    expand_threshold: int = 80       # 扩容阈值
    shrink_threshold: int = 20      # 缩容阈值
    cpu_high: float = 0.85           # CPU 高阈值
    cpu_low: float = 0.5           # CPU 低阈值

    # 阻尼
    cooldown_ticks: int = 10       # 冷却时间
    hysteresis_gap: int = 60       # 滞后间隙 (expand - shrink)

    # 反射控制
    reflection_suppress_threshold: float = 0.8


class ZeroDampingGovernor(RuntimeSimulator):
    """
    零阻尼 Governor（对照组）

    特点：
    - 单一阈值（扩张 = 收缩）
    - 无冷却时间
    - 无滞后区间
    """

    def __init__(self, config: Optional[GovernorConfig] = None, timeline_recorder: RuntimeTimelineRecorder = None):
        super().__init__(config)
        self.config = config or GovernorConfig()

        # 简化为单一阈值
        self.threshold = 50

        # 稳定性分析器
        self.analyzer = StabilityAnalyzer()

        # 时间线记录器
        self.recorder = timeline_recorder or RuntimeTimelineRecorder()

        # 统计
        self.expansion_count = 0
        self.contraction_count = 0
        self.reflection_requests = 0
        self.reflection_suppressed = 0

        print(f"[ZeroDamping Governor] 初始化: threshold={self.threshold}")

    def governor_decide(self) -> str:
        """零阻尼决策"""
        cpu = self.state.cpu_usage

        # CPU 过高 → 禁用 Reflection
        if cpu > self.config.cpu_high and self.state.reflection_load > 0.1:
            action = "disable_reflection"
            self.reflection_suppressed += 1
            self._record_action(action)
            return action

        # 队列 > 阈值 → 扩容
        if self.state.queue_depth > self.threshold:
            action = "spawn_worker"
            self.expansion_count += 1
            self._record_action(action)
            return action

        # 队列 < 阈值 → 缩容
        if self.state.queue_depth < self.threshold and self.state.worker_count > 2:
            action = "reduce_workers"
            self.contraction_count += 1
            self._record_action(action)
            return action

        # 恢复 Reflection（如果被长期禁用）
        recent = self.state.action_history[-30:]
        suppress_ratio = sum(1 for a in recent if a == "disable_reflection") / max(1, len(recent))
        if suppress_ratio > self.config.reflection_suppress_threshold and cpu < self.config.cpu_low:
            action = "enable_reflection"
            self.reflection_requests += 1
            self._record_action(action)
            return action

        self._record_action("no_op")
        return "no_op"

    def _record_action(self, action: str):
        """记录动作"""
        self.state.action_history.append(action)
        self.analyzer.record(self.state.tick, {
            'queue_depth': self.state.queue_depth,
            'cpu_usage': self.state.cpu_usage,
            'worker_count': self.state.worker_count,
        }, action)

    def tick(self):
        """覆写 tick 以集成时间线记录"""
        # 调用父类 tick（生成任务、决策、执行、处理、遥测）
        state = super().tick()

        # 记录到时间线
        self._record_to_timeline()

        return state

    def _record_to_timeline(self):
        """将当前状态记录到时间线"""
        # 构建 RuntimeState
        runtime_state = RuntimeState(
            queue_depth=self.state.queue_depth,
            worker_count=self.state.worker_count,
            cpu_usage=self.state.cpu_usage,
            token_pressure=self.state.token_pressure,
            reflection_load=self.state.reflection_load,
            memory_pressure=0.0,
            active_agents=self.state.active_agents,
            projection_lag=0.0,
            scheduler_congestion=0.0,
            attention_collapse=0.0,
            starvation_penalty_count=0,
        )

        # 构建 RawTelemetry
        raw_telemetry = RawTelemetry(
            spawn_count=self.expansion_count,
            kill_count=self.contraction_count,
            reflection_requests=self.reflection_requests,
            reflection_suppressed=self.reflection_suppressed,
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
            reason=f"queue={self.state.queue_depth}, cpu={self.state.cpu_usage:.2f}",
            blocked_by_cooldown=False,
        )

        # 事件标记
        events = []
        if self.state.queue_depth > self.threshold * 1.5:
            events.append(Event(type="queue_high_warning", severity="warning", data={"queue": self.state.queue_depth}))
        if self.state.cpu_usage > self.config.cpu_high:
            events.append(Event(type="cpu_high_warning", severity="warning", data={"cpu": self.state.cpu_usage}))

        # 记录到时间线
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

    def save_timeline(self, filename: str = None) -> str:
        """保存时间线到文件"""
        return self.recorder.save(filename or f"zero_damping_{self.recorder.run_id}.jsonl")

    def get_stability_metrics(self) -> StabilityMetrics:
        """获取稳定性指标"""
        return self.analyzer.compute_metrics(self.state.tick)

    def get_summary(self) -> Dict[str, Any]:
        """获取实验摘要"""
        metrics = self.get_stability_metrics()
        return {
            'expansion_count': self.expansion_count,
            'contraction_count': self.contraction_count,
            'oscillation_score': metrics.oscillation_score,
            'worker_churn_rate': metrics.worker_churn_rate,
            'overshoot_ratio': metrics.overshoot_ratio,
            'recovery_half_life': metrics.queue_recovery_half_life,
            'final_queue': metrics.queue_depth,
            'final_workers': metrics.worker_count,
            'final_cpu': metrics.cpu_usage,
        }


class DampedGovernor(RuntimeSimulator):
    """
    带阻尼 Governor（实验组）

    特点：
    - Hysteresis: 扩张阈值 != 收缩阈值
    - Cooldown: 动作后冷却一段时间
    - 防止过度反应
    """

    def __init__(self, config: Optional[GovernorConfig] = None, timeline_recorder: RuntimeTimelineRecorder = None):
        super().__init__(config)
        self.config = config or GovernorConfig()

        # 稳定性分析器
        self.analyzer = StabilityAnalyzer()

        # 时间线记录器
        self.recorder = timeline_recorder or RuntimeTimelineRecorder()

        # 冷却状态
        self.cooldown_ticks = 0
        self.last_action_tick = 0

        # 历史追踪
        self.expansion_count = 0
        self.contraction_count = 0
        self.reflection_requests = 0
        self.reflection_suppressed = 0

        print(f"[Damped Governor] 初始化:")
        print(f"  expand_threshold={self.config.expand_threshold}")
        print(f"  shrink_threshold={self.config.shrink_threshold}")
        print(f"  cooldown_ticks={self.config.cooldown_ticks}")
        print(f"  hysteresis_gap={self.config.hysteresis_gap}")

    def governor_decide(self) -> str:
        """带阻尼决策"""

        # 更新冷却
        if self.cooldown_ticks > 0:
            self.cooldown_ticks -= 1

        # 记录当前状态到分析器
        self.analyzer.record(self.state.tick, {
            'queue_depth': self.state.queue_depth,
            'cpu_usage': self.state.cpu_usage,
            'worker_count': self.state.worker_count,
        }, 'pending')

        cpu = self.state.cpu_usage

        # === CPU 紧急处理（优先，不受冷却限制）===
        if cpu > self.config.cpu_high and self.state.reflection_load > 0.1:
            action = "disable_reflection"
            self.reflection_suppressed += 1
            self._record_action(action)
            return action

        # === 检查冷却 ===
        if self.cooldown_ticks > 0:
            self._record_action("no_op")
            return "no_op"

        # === Hysteresis 决策 ===

        # 扩容条件：队列 > 扩张阈值
        if self.state.queue_depth > self.config.expand_threshold:
            action = "spawn_worker"
            self.expansion_count += 1
            self.cooldown_ticks = self.config.cooldown_ticks
            self._record_action(action)
            return action

        # 缩容条件：队列 < 收缩阈值 AND worker 数充足
        if self.state.queue_depth < self.config.shrink_threshold and self.state.worker_count > 3:
            action = "reduce_workers"
            self.contraction_count += 1
            self.cooldown_ticks = self.config.cooldown_ticks
            self._record_action(action)
            return action

        # === 恢复 Reflection ===
        recent = self.state.action_history[-30:]
        suppress_ratio = sum(1 for a in recent if a == "disable_reflection") / max(1, len(recent))
        if suppress_ratio > self.config.reflection_suppress_threshold and cpu < self.config.cpu_low:
            action = "enable_reflection"
            self.reflection_requests += 1
            self._record_action(action)
            return action

        self._record_action("no_op")
        return "no_op"

    def _record_action(self, action: str):
        """记录动作到分析器"""
        self.state.action_history.append(action)
        self.last_action_tick = self.state.tick

        # 更新分析器
        self.analyzer.record(self.state.tick, {
            'queue_depth': self.state.queue_depth,
            'cpu_usage': self.state.cpu_usage,
            'worker_count': self.state.worker_count,
        }, action)

    def tick(self):
        """覆写 tick 以集成时间线记录"""
        # 调用父类 tick
        state = super().tick()

        # 记录到时间线
        self._record_to_timeline()

        return state

    def _record_to_timeline(self):
        """将当前状态记录到时间线"""
        # 构建 RuntimeState
        runtime_state = RuntimeState(
            queue_depth=self.state.queue_depth,
            worker_count=self.state.worker_count,
            cpu_usage=self.state.cpu_usage,
            token_pressure=self.state.token_pressure,
            reflection_load=self.state.reflection_load,
            memory_pressure=0.0,
            active_agents=self.state.active_agents,
            projection_lag=0.0,
            scheduler_congestion=0.0,
            attention_collapse=0.0,
            starvation_penalty_count=0,
        )

        # 构建 RawTelemetry
        raw_telemetry = RawTelemetry(
            spawn_count=self.expansion_count,
            kill_count=self.contraction_count,
            reflection_requests=self.reflection_requests,
            reflection_suppressed=self.reflection_suppressed,
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
            reason=f"queue={self.state.queue_depth}, cpu={self.state.cpu_usage:.2f}, cooldown={self.cooldown_ticks}",
            blocked_by_cooldown=self.cooldown_ticks > 0,
        )

        # 事件标记
        events = []
        if self.state.queue_depth > self.config.expand_threshold:
            events.append(Event(type="queue_high_warning", severity="warning", data={"queue": self.state.queue_depth}))
        if self.state.cpu_usage > self.config.cpu_high:
            events.append(Event(type="cpu_high_warning", severity="warning", data={"cpu": self.state.cpu_usage}))
        if self.cooldown_ticks > 0:
            events.append(Event(type="cooldown_active", severity="info", data={"cooldown_remaining": self.cooldown_ticks}))

        # 记录到时间线
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

    def save_timeline(self, filename: str = None) -> str:
        """保存时间线到文件"""
        return self.recorder.save(filename or f"damped_{self.recorder.run_id}.jsonl")

    def get_stability_metrics(self) -> StabilityMetrics:
        """获取稳定性指标"""
        return self.analyzer.compute_metrics(self.state.tick)

    def get_summary(self) -> Dict[str, Any]:
        """获取实验摘要"""
        metrics = self.get_stability_metrics()
        return {
            'expansion_count': self.expansion_count,
            'contraction_count': self.contraction_count,
            'oscillation_score': metrics.oscillation_score,
            'worker_churn_rate': metrics.worker_churn_rate,
            'overshoot_ratio': metrics.overshoot_ratio,
            'recovery_half_life': metrics.queue_recovery_half_life,
            'final_queue': metrics.queue_depth,
            'final_workers': metrics.worker_count,
            'final_cpu': metrics.cpu_usage,
        }


def run_experiment(
    GovernorClass,
    name: str,
    config: Optional[GovernorConfig] = None,
    duration: int = 500,
    burst_prob: float = 0.15,
    arrival_rate: float = 15.0,
    save_timeline: bool = True,
) -> Dict[str, Any]:
    """运行实验"""

    print(f"\n{'='*60}")
    print(f"实验: {name}")
    print(f"{'='*60}")

    # 创建时间线记录器
    recorder = RuntimeTimelineRecorder()
    recorder.set_random_seed(42)
    recorder.set_workload_config({
        "base_arrival_rate": arrival_rate,
        "burst_probability": burst_prob,
        "burst_multiplier": 5.0,
        "duration": duration,
    })
    recorder.set_governor_config(config.__dict__ if config else {})

    # 创建 Governor（注入时间线记录器）
    governor = GovernorClass(config, recorder)
    governor.workload.burst_probability = burst_prob
    governor.workload.base_arrival_rate = arrival_rate

    # 设置随机种子
    random.seed(42)

    # 运行
    governor.run(duration_ticks=duration)

    # 保存时间线
    if save_timeline:
        filename = f"{'zero_damping' if 'ZeroDamping' in GovernorClass.__name__ else 'damped'}_{governor.recorder.run_id}.jsonl"
        timeline_path = recorder.save(filename)
        print(f"  时间线已保存: {timeline_path}")
        print(f"  总条目: {len(recorder.entries)}")

    # 获取结果
    summary = governor.get_summary()
    summary['timeline_entries'] = len(recorder.entries)

    # 打印结果
    print(f"\n结果摘要:")
    print(f"  扩张次数: {summary['expansion_count']}")
    print(f"  收缩次数: {summary['contraction_count']}")
    print(f"  振荡分数: {summary['oscillation_score']:.3f}")
    print(f"  Worker 变更率: {summary['worker_churn_rate']:.3f}")
    print(f"  超调比例: {summary['overshoot_ratio']:.3f}")
    print(f"  恢复半衰期: {summary['recovery_half_life']:.1f}")
    print(f"  最终队列: {summary['final_queue']}")
    print(f"  最终 Worker: {summary['final_workers']}")
    print(f"  最终 CPU: {summary['final_cpu']:.2f}")

    return summary


def main():
    """主实验对比"""
    print("="*60)
    print("SoloForge Governor 对比实验")
    print("零阻尼 vs 带阻尼 (Hysteresis + Cooldown)")
    print("="*60)

    # 配置
    config = GovernorConfig(
        expand_threshold=80,
        shrink_threshold=20,
        cooldown_ticks=15,
        hysteresis_gap=60,
        cpu_high=0.85,
        cpu_low=0.5,
    )

    # 实验参数
    duration = 500
    burst_prob = 0.15
    arrival_rate = 15.0

    # === 实验1: 零阻尼 Governor ===
    print("\n>>> 运行零阻尼 Governor 实验（随机种子=42）")
    zero_damping_results = run_experiment(
        ZeroDampingGovernor,
        "零阻尼 Governor",
        config,
        duration=duration,
        burst_prob=burst_prob,
        arrival_rate=arrival_rate,
        save_timeline=True,
    )

    # === 实验2: 带阻尼 Governor ===
    print("\n>>> 运行带阻尼 Governor 实验（随机种子=42）")
    damped_results = run_experiment(
        DampedGovernor,
        "带阻尼 Governor (Hysteresis + Cooldown)",
        config,
        duration=duration,
        burst_prob=burst_prob,
        arrival_rate=arrival_rate,
        save_timeline=True,
    )

    # === 对比分析 ===
    print("\n" + "="*60)
    print("对比分析")
    print("="*60)

    def compare(metric: str, val1: float, val2: float, lower_is_better: bool = True):
        if lower_is_better:
            better = "✅" if val2 < val1 else "❌"
            improvement = ((val1 - val2) / val1 * 100) if val1 > 0 else 0
        else:
            better = "✅" if val2 > val1 else "❌"
            improvement = ((val2 - val1) / val1 * 100) if val1 > 0 else 0

        print(f"  {metric}:")
        print(f"    零阻尼: {val1:.3f}")
        print(f"    带阻尼: {val2:.3f}")
        print(f"    改善: {better} {improvement:.1f}%")

    compare("振荡分数", zero_damping_results['oscillation_score'], damped_results['oscillation_score'])
    compare("Worker变更率", zero_damping_results['worker_churn_rate'], damped_results['worker_churn_rate'])
    compare("超调比例", zero_damping_results['overshoot_ratio'], damped_results['overshoot_ratio'])

    print("\n  扩张次数:")
    print(f"    零阻尼: {zero_damping_results['expansion_count']}")
    print(f"    带阻尼: {damped_results['expansion_count']}")

    print("\n  收缩次数:")
    print(f"    零阻尼: {zero_damping_results['contraction_count']}")
    print(f"    带阻尼: {damped_results['contraction_count']}")

    # 结论
    print("\n" + "="*60)
    print("结论")
    print("="*60)

    if damped_results['oscillation_score'] < zero_damping_results['oscillation_score']:
        print("✅ 带阻尼 Governor 显著降低了系统振荡")
        print("✅ Hysteresis + Cooldown 有效")
    else:
        print("⚠️ 结果不符合预期，可能需要调参")

    if damped_results['worker_churn_rate'] < zero_damping_results['worker_churn_rate']:
        print("✅ Worker 变更频率降低，系统更稳定")

    if damped_results['overshoot_ratio'] < zero_damping_results['overshoot_ratio']:
        print("✅ 超调减少，控制更精准")


if __name__ == '__main__':
    main()
