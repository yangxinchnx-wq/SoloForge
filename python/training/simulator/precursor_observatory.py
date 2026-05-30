# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Collapse Precursor Observatory
# Path: python/training/simulator/precursor_observatory.py
#
# 核心功能：
# 1. 实时检测 collapse 前兆
# 2. 计算 Time-to-Collapse
# 3. 监控 Control Saturation
# 4. 识别 divergence onset
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


@dataclass
class PrecursorMetrics:
    """前兆指标"""
    tick: int = 0

    # 一阶导数: Queue 变化率
    queue_velocity: float = 0.0  # d(queue)/dt

    # 二阶导数: Queue 加速度
    queue_acceleration: float = 0.0  # d²(queue)/dt²

    # Divergence 指标
    queue_divergence_rate: float = 0.0  # velocity / mean_velocity
    is_diverging: bool = False

    # Control Saturation
    control_saturation_ratio: float = 0.0  # current / max workers
    is_saturated: bool = False

    # Time-to-Collapse 估算
    time_to_collapse: float = float('inf')  # ticks until collapse
    collapse_probability: float = 0.0  # 0-1

    # Recovery 能力
    can_recover: bool = True
    recovery_effort_needed: float = 0.0

    # Precursor 警告等级
    warning_level: str = "normal"  # normal, elevated, warning, critical
    precursor_score: float = 0.0  # 0-1


@dataclass
class CollapseSignature:
    """崩溃签名"""
    onset_tick: int = 0
    onset_queue: int = 0
    onset_workers: int = 0
    divergence_started: bool = False
    saturation_started: bool = False
    cascade_pattern: List[str] = field(default_factory=list)  # 前兆序列


class PrecursorDetector:
    """
    Collapse Precursor 检测器

    监控指标：
    1. Queue Velocity (d(queue)/dt)
    2. Queue Acceleration (d²(queue)/dt²)
    3. Control Saturation Ratio
    4. Time-to-Collapse
    """

    def __init__(
        self,
        window_size: int = 20,
        max_workers: int = 200,
        collapse_queue_threshold: int = 10000,
        divergence_threshold: float = 2.0,
    ):
        self.window_size = window_size
        self.max_workers = max_workers
        self.collapse_queue_threshold = collapse_queue_threshold
        self.divergence_threshold = divergence_threshold

        # 历史数据
        self.queue_history: deque = deque(maxlen=window_size * 2)
        self.worker_history: deque = deque(maxlen=window_size * 2)
        self.tick_history: deque = deque(maxlen=window_size * 2)

        # 崩溃签名
        self.collapse_signature: Optional[CollapseSignature] = None
        self.precursor_sequence: List[str] = []

    def update(self, tick: int, queue: int, workers: int) -> PrecursorMetrics:
        """
        更新状态并计算前兆指标
        """
        # 记录历史
        self.queue_history.append(queue)
        self.worker_history.append(workers)
        self.tick_history.append(tick)

        # 计算前兆指标
        metrics = self._compute_precursors()

        # 更新崩溃签名
        self._update_collapse_signature(tick, queue, workers, metrics)

        return metrics

    def _compute_precursors(self) -> PrecursorMetrics:
        """计算所有前兆指标"""
        metrics = PrecursorMetrics(tick=self.tick_history[-1] if self.tick_history else 0)

        if len(self.queue_history) < 3:
            return metrics

        queues = list(self.queue_history)
        workers = list(self.worker_history)

        # === 1. Queue Velocity: d(queue)/dt ===
        metrics.queue_velocity = queues[-1] - queues[-2]

        # === 2. Queue Acceleration: d²(queue)/dt² ===
        if len(queues) >= 3:
            v_curr = queues[-1] - queues[-2]
            v_prev = queues[-2] - queues[-3]
            metrics.queue_acceleration = v_curr - v_prev

        # === 3. Divergence Rate ===
        # 计算历史平均 velocity
        velocities = [queues[i] - queues[i-1] for i in range(1, len(queues))]
        if velocities:
            mean_v = sum(velocities) / len(velocities)
            if mean_v > 0:
                metrics.queue_divergence_rate = metrics.queue_velocity / mean_v
            else:
                metrics.queue_divergence_rate = 0

        metrics.is_diverging = metrics.queue_divergence_rate > self.divergence_threshold

        # === 4. Control Saturation Ratio ===
        metrics.control_saturation_ratio = workers[-1] / self.max_workers if self.max_workers > 0 else 0
        metrics.is_saturated = metrics.control_saturation_ratio > 0.8  # >80%

        # === 5. Time-to-Collapse ===
        metrics.time_to_collapse = self._estimate_time_to_collapse(queues, workers)

        # === 6. Collapse Probability ===
        metrics.collapse_probability = self._compute_collapse_probability(metrics)

        # === 7. Recovery 能力 ===
        metrics.can_recover = self._can_recover(queues, workers, metrics)

        # === 8. Warning Level ===
        metrics.warning_level = self._compute_warning_level(metrics)
        metrics.precursor_score = self._compute_precursor_score(metrics)

        return metrics

    def _estimate_time_to_collapse(self, queues: List[int], workers: List[int]) -> float:
        """
        估算 Time-to-Collapse

        基于当前趋势预测 queue 何时达到阈值
        """
        if len(queues) < 10:
            return float('inf')

        # 计算平均 velocity
        velocities = [queues[i] - queues[i-1] for i in range(1, len(queues))]
        avg_velocity = sum(velocities) / len(velocities)

        if avg_velocity <= 0:
            return float('inf')  # 不会崩溃

        # 计算加速度
        if len(velocities) >= 2:
            accelerations = [velocities[i] - velocities[i-1] for i in range(1, len(velocities))]
            avg_acceleration = sum(accelerations) / len(accelerations)
        else:
            avg_acceleration = 0

        current_queue = queues[-1]

        if avg_acceleration <= 0:
            # 线性增长
            ticks_to_collapse = (self.collapse_queue_threshold - current_queue) / avg_velocity
        else:
            # 加速增长 - 求解二次方程
            # queue = q0 + v*t + 0.5*a*t^2
            # 0.5*a*t^2 + v*t + (q0 - threshold) = 0
            a = 0.5 * avg_acceleration
            b = avg_velocity
            c = current_queue - self.collapse_queue_threshold

            discriminant = b * b - 4 * a * c
            if discriminant < 0:
                return float('inf')

            t1 = (-b + discriminant ** 0.5) / (2 * a)
            t2 = (-b - discriminant ** 0.5) / (2 * a)

            # 取正根
            ticks_to_collapse = min(t1, t2) if t1 > 0 and t2 > 0 else max(t1, t2)

        return max(0, ticks_to_collapse)

    def _compute_collapse_probability(self, metrics: PrecursorMetrics) -> float:
        """
        计算 Collapse 概率

        基于多个前兆指标综合判断
        """
        prob = 0.0

        # Divergence 增加概率
        if metrics.is_diverging:
            prob += 0.3

        # 高加速度增加概率
        if metrics.queue_acceleration > 100:
            prob += 0.2
        elif metrics.queue_acceleration > 50:
            prob += 0.1

        # Saturation 增加概率
        if metrics.is_saturated:
            prob += 0.2

        # Time-to-Collapse 短增加概率
        if metrics.time_to_collapse < 50:
            prob += 0.2
        elif metrics.time_to_collapse < 100:
            prob += 0.1

        # Queue 本身就高
        current_queue = self.queue_history[-1] if self.queue_history else 0
        if current_queue > 5000:
            prob += 0.1

        return min(1.0, prob)

    def _can_recover(self, queues: List[int], workers: List[int], metrics: PrecursorMetrics) -> bool:
        """
        判断系统是否能恢复
        """
        # 如果已经饱和且正在发散，很难恢复
        if metrics.is_saturated and metrics.is_diverging:
            return False

        # 如果 queue 已经超过阈值
        if queues[-1] > self.collapse_queue_threshold:
            return False

        # 如果 time-to-collapse 无限，说明不会崩溃
        if metrics.time_to_collapse == float('inf'):
            return True

        # 其他情况根据概率判断
        return metrics.collapse_probability < 0.5

    def _compute_warning_level(self, metrics: PrecursorMetrics) -> str:
        """计算警告等级"""
        if metrics.collapse_probability >= 0.7:
            return "critical"
        elif metrics.collapse_probability >= 0.4:
            return "warning"
        elif metrics.collapse_probability >= 0.2:
            return "elevated"
        return "normal"

    def _compute_precursor_score(self, metrics: PrecursorMetrics) -> float:
        """计算综合前兆分数 (0-1)"""
        score = 0.0

        # Divergence (权重 0.3)
        if metrics.is_diverging:
            score += 0.3 * min(1.0, metrics.queue_divergence_rate / 5.0)

        # Acceleration (权重 0.25)
        if metrics.queue_acceleration > 0:
            score += 0.25 * min(1.0, metrics.queue_acceleration / 500.0)

        # Saturation (权重 0.25)
        score += 0.25 * metrics.control_saturation_ratio

        # Time-to-Collapse (权重 0.2)
        if metrics.time_to_collapse < float('inf'):
            score += 0.2 * max(0, 1 - metrics.time_to_collapse / 200.0)

        return min(1.0, score)

    def _update_collapse_signature(
        self,
        tick: int,
        queue: int,
        workers: int,
        metrics: PrecursorMetrics
    ):
        """更新崩溃签名"""
        # 检测 onset
        if self.collapse_signature is None:
            if queue > 5000 or metrics.is_diverging:
                self.collapse_signature = CollapseSignature(
                    onset_tick=tick,
                    onset_queue=queue,
                    onset_workers=workers,
                )

        if self.collapse_signature:
            sig = self.collapse_signature

            # 记录 divergence 起始
            if not sig.divergence_started and metrics.is_diverging:
                sig.divergence_started = True
                sig.cascade_pattern.append(f"tick{tick}:divergence_onset")

            # 记录 saturation 起始
            if not sig.saturation_started and metrics.is_saturated:
                sig.saturation_started = True
                sig.cascade_pattern.append(f"tick{tick}:saturation_onset")

            # 记录 cascade
            if metrics.warning_level == "critical":
                sig.cascade_pattern.append(f"tick{tick}:critical")

    def get_collapse_signature(self) -> Optional[CollapseSignature]:
        """获取崩溃签名"""
        return self.collapse_signature

    def get_precursor_sequence(self) -> List[str]:
        """获取前兆序列"""
        return self.precursor_sequence


class PrecursorTimeSeries:
    """
    前兆时间序列

    记录整个运行过程中的前兆指标变化
    """

    def __init__(self):
        self.metrics: List[PrecursorMetrics] = []

    def record(self, metrics: PrecursorMetrics):
        """记录一个时间步的前兆"""
        self.metrics.append(metrics)

    def get_velocity_timeline(self) -> List[Tuple[int, float]]:
        """获取 queue velocity 时间线"""
        return [(m.tick, m.queue_velocity) for m in self.metrics]

    def get_acceleration_timeline(self) -> List[Tuple[int, float]]:
        """获取 queue acceleration 时间线"""
        return [(m.tick, m.queue_acceleration) for m in self.metrics]

    def get_saturation_timeline(self) -> List[Tuple[int, float]]:
        """获取 saturation ratio 时间线"""
        return [(m.tick, m.control_saturation_ratio) for m in self.metrics]

    def get_ttc_timeline(self) -> List[Tuple[int, float]]:
        """获取 time-to-collapse 时间线"""
        return [(m.tick, m.time_to_collapse) for m in self.metrics]

    def get_warning_timeline(self) -> List[Tuple[int, str]]:
        """获取 warning level 时间线"""
        return [(m.tick, m.warning_level) for m in self.metrics]

    def detect_precursor_emergence(self) -> Dict[str, Any]:
        """
        检测前兆出现的时间点
        """
        if not self.metrics:
            return {}

        emergence = {
            "divergence_onset": None,
            "saturation_onset": None,
            "warning_onset": None,
            "critical_onset": None,
            "precursor_score_peak": (0, 0.0),
        }

        for m in self.metrics:
            if m.is_diverging and emergence["divergence_onset"] is None:
                emergence["divergence_onset"] = m.tick

            if m.is_saturated and emergence["saturation_onset"] is None:
                emergence["saturation_onset"] = m.tick

            if m.warning_level == "warning" and emergence["warning_onset"] is None:
                emergence["warning_onset"] = m.tick

            if m.warning_level == "critical" and emergence["critical_onset"] is None:
                emergence["critical_onset"] = m.tick

            if m.precursor_score > emergence["precursor_score_peak"][1]:
                emergence["precursor_score_peak"] = (m.tick, m.precursor_score)

        return emergence

    def analyze_collapse_dynamics(self) -> Dict[str, Any]:
        """
        分析崩溃动力学
        """
        if not self.metrics:
            return {}

        # 找到 warning 开始到 critical 的时间
        emergence = self.detect_precursor_emergence()

        # 计算 precursor cascade 速度
        cascade_events = []
        if emergence["divergence_onset"]:
            cascade_events.append(("divergence", emergence["divergence_onset"]))
        if emergence["saturation_onset"]:
            cascade_events.append(("saturation", emergence["saturation_onset"]))
        if emergence["warning_onset"]:
            cascade_events.append(("warning", emergence["warning_onset"]))
        if emergence["critical_onset"]:
            cascade_events.append(("critical", emergence["critical_onset"]))

        # 计算事件间隔
        cascade_intervals = []
        for i in range(1, len(cascade_events)):
            interval = cascade_events[i][1] - cascade_events[i-1][1]
            cascade_intervals.append((cascade_events[i-1][0], cascade_events[i][0], interval))

        return {
            "precursor_emergence": emergence,
            "cascade_events": cascade_events,
            "cascade_intervals": cascade_intervals,
            "total_precursors": len([m for m in self.metrics if m.warning_level != "normal"]),
        }


def run_precursor_experiment(
    arrival_rate: float,
    cooldown: int = 5,
    duration: int = 500,
    seed: int = 42,
) -> Dict[str, Any]:
    """
    运行前兆检测实验
    """
    import random
    from training.simulator import GovernorConfig, DampedGovernor, RuntimeTimelineRecorder

    print(f"\n运行前兆检测实验: rate={arrival_rate}, cooldown={cooldown}")

    # 创建配置
    config = GovernorConfig(
        expand_threshold=100,
        shrink_threshold=20,
        cooldown_ticks=cooldown,
        hysteresis_gap=80,
    )

    # 创建时间线记录器
    recorder = RuntimeTimelineRecorder()
    recorder.set_random_seed(seed)
    recorder.set_workload_config({
        "base_arrival_rate": arrival_rate,
        "burst_probability": 0.15,
        "burst_multiplier": 5.0,
    })

    # 创建 Governor
    governor = DampedGovernor(config, recorder)
    governor.workload.burst_probability = 0.15
    governor.workload.base_arrival_rate = arrival_rate

    random.seed(seed)

    # 创建前兆检测器
    detector = PrecursorDetector()
    time_series = PrecursorTimeSeries()

    # 运行
    for tick in range(1, duration + 1):
        governor.tick()

        # 检测前兆
        metrics = detector.update(
            tick=governor.state.tick,
            queue=governor.state.queue_depth,
            workers=governor.state.worker_count,
        )
        time_series.record(metrics)

        # 记录到时间线
        if tick % 50 == 0:
            print(f"  tick={tick}: queue={governor.state.queue_depth}, "
                  f"workers={governor.state.worker_count}, "
                  f"precursor={metrics.precursor_score:.2f}, "
                  f"ttc={metrics.time_to_collapse:.0f}, "
                  f"warning={metrics.warning_level}")

    # 分析结果
    emergence = time_series.detect_precursor_emergence()
    dynamics = time_series.analyze_collapse_dynamics()

    return {
        "arrival_rate": arrival_rate,
        "final_queue": governor.state.queue_depth,
        "final_workers": governor.state.worker_count,
        "precursor_emergence": emergence,
        "collapse_dynamics": dynamics,
        "collapse_signature": detector.get_collapse_signature(),
    }


def print_precursor_analysis(results: Dict[str, Any]):
    """打印前兆分析结果"""
    print("\n" + "=" * 70)
    print("Collapse Precursor Analysis")
    print("=" * 70)

    print(f"\n[基本信息]")
    print(f"  arrival_rate: {results['arrival_rate']}")
    print(f"  final_queue: {results['final_queue']}")
    print(f"  final_workers: {results['final_workers']}")

    print(f"\n[前兆出现时间]")
    emergence = results['precursor_emergence']
    for event, tick in emergence.items():
        if tick:
            print(f"  {event}: tick={tick}")
        else:
            print(f"  {event}: 未出现")

    print(f"\n[Precursor Cascade 分析]")
    dynamics = results['collapse_dynamics']
    for prev, curr, interval in dynamics.get('cascade_intervals', []):
        print(f"  {prev} → {curr}: {interval} ticks")

    print(f"\n[崩溃签名]")
    sig = results.get('collapse_signature')
    if sig:
        print(f"  onset_tick: {sig.onset_tick}")
        print(f"  onset_queue: {sig.onset_queue}")
        print(f"  divergence_started: {sig.divergence_started}")
        print(f"  saturation_started: {sig.saturation_started}")
        print(f"  cascade_pattern: {' → '.join(sig.cascade_pattern)}")
    else:
        print("  无崩溃签名")


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="Collapse Precursor Observatory")
    parser.add_argument("--rates", "-r", nargs="+", type=float,
                        default=[25.0, 30.0, 35.0, 40.0],
                        help="arrival_rate 值列表")
    parser.add_argument("--cooldown", "-c", type=int, default=5)
    parser.add_argument("--duration", "-d", type=int, default=500)
    parser.add_argument("--seed", type=int, default=42)

    args = parser.parse_args()

    print("=" * 70)
    print("Collapse Precursor Observatory")
    print("研究 Runtime Collapse 前兆动力学")
    print("=" * 70)

    results = []
    for rate in args.rates:
        result = run_precursor_experiment(rate, args.cooldown, args.duration, args.seed)
        print_precursor_analysis(result)
        results.append(result)

    print("\n" + "=" * 70)
    print("Precursor Emergence Summary")
    print("=" * 70)

    for r in results:
        emergence = r['precursor_emergence']
        print(f"\nrate={r['arrival_rate']:.1f}:")
        print(f"  divergence: {emergence['divergence_onset'] or 'never'}")
        print(f"  saturation: {emergence['saturation_onset'] or 'never'}")
        print(f"  warning: {emergence['warning_onset'] or 'never'}")
        print(f"  critical: {emergence['critical_onset'] or 'never'}")


if __name__ == '__main__':
    main()
