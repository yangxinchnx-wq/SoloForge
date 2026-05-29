# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Phase Transition Experiment
# Path: python/training/simulator/phase_transition.py
#
# 核心实验：扫描 arrival_rate，观察 Regime Transition
# 寻找 Runtime Capacity Boundary
# ─────────────────────────────────────────────────────────────────

import sys
import os
import random
import json
from typing import List, Dict, Any, Tuple
from dataclasses import asdict

# 设置 UTF-8 输出
sys.stdout.reconfigure(encoding='utf-8')

# 添加项目根目录到路径
script_dir = os.path.dirname(os.path.abspath(__file__))
training_dir = os.path.dirname(script_dir)
python_dir = os.path.dirname(training_dir)
sys.path.insert(0, python_dir)

from training.simulator import (
    GovernorConfig,
    DampedGovernor,
    RuntimeTimelineRecorder,
)
from training.simulator.runtime_regime_classifier import (
    RuntimeRegimeClassifier,
    RuntimeRegime,
)


def compute_regime_transition_metrics(recorder: RuntimeTimelineRecorder) -> Dict[str, Any]:
    """
    计算 Regime Transition 指标

    包括：
    1. Regime Persistence Time
    2. Regime Transition Velocity
    3. Regime Stability Score
    """
    if not recorder.entries:
        return {}

    # 滑动窗口 Regime 分类
    window_size = 50
    regimes = []
    for i in range(len(recorder.entries)):
        start = max(0, i - window_size + 1)
        end = i + 1
        window_entries = recorder.entries[start:end]

        if len(window_entries) < 10:
            regimes.append("unknown")
            continue

        # 计算窗口指标
        osc_avg = sum(e.derived_metrics.oscillation_score for e in window_entries) / len(window_entries)
        churn_avg = sum(e.derived_metrics.worker_churn_rate for e in window_entries) / len(window_entries)
        queue_avg = sum(e.state.queue_depth for e in window_entries) / len(window_entries)
        queue_final = window_entries[-1].state.queue_depth

        # 分类
        if churn_avg < 0.01 and osc_avg < 0.05:
            regimes.append("dead")
        elif osc_avg > 0.3 and churn_avg > 0.2 and queue_final < 500:
            regimes.append("hyper")
        elif osc_avg < 0.15 and queue_final > 3000:
            regimes.append("under")
        elif osc_avg < 0.25 and queue_final < 1000:
            regimes.append("healthy")
        else:
            regimes.append("mixed")

    # Regime Persistence Time
    regime_persistence = _compute_persistence(regimes)

    # Regime Transition Velocity
    transition_velocity = _compute_transition_velocity(regimes)

    # Regime Stability Score
    regime_stability = _compute_regime_stability(regimes)

    # 找到 Capacity Boundary (queue 开始爆炸的点)
    capacity_boundary = _find_capacity_boundary(recorder)

    return {
        "regime_persistence": regime_persistence,
        "transition_velocity": transition_velocity,
        "regime_stability_score": regime_stability,
        "capacity_boundary": capacity_boundary,
        "final_regime": regimes[-1] if regimes else "unknown",
        "regime_timeline": regimes,
    }


def _compute_persistence(regimes: List[str]) -> Dict[str, float]:
    """
    计算 Regime Persistence Time

    每个 regime 平均持续多久
    """
    if not regimes:
        return {}

    persistence = {}
    current_regime = regimes[0]
    current_duration = 0

    for regime in regimes:
        if regime == current_regime:
            current_duration += 1
        else:
            persistence[current_regime] = persistence.get(current_regime, 0) + current_duration
            current_regime = regime
            current_duration = 1

    # 最后一个
    persistence[current_regime] = persistence.get(current_regime, 0) + current_duration

    # 转换为平均持续时间
    counts = {}
    for regime in regimes:
        counts[regime] = counts.get(regime, 0) + 1

    avg_persistence = {}
    for regime, total in persistence.items():
        avg_persistence[regime] = total / counts.get(regime, 1)

    return avg_persistence


def _compute_transition_velocity(regimes: List[str]) -> float:
    """
    计算 Regime Transition Velocity

    regime 切换的速度
    """
    if len(regimes) < 2:
        return 0.0

    transitions = sum(1 for i in range(1, len(regimes)) if regimes[i] != regimes[i-1])
    return transitions / len(regimes)


def _compute_regime_stability(regimes: List[str]) -> float:
    """
    计算 Regime Stability Score

    1.0 = 完全稳定，0.0 = 完全不稳定
    """
    if not regimes:
        return 0.0

    # 最后 N 个是否一致
    window = regimes[-20:] if len(regimes) >= 20 else regimes
    unique_regimes = set(window)

    if len(unique_regimes) == 1:
        return 1.0
    elif len(unique_regimes) == 2:
        return 0.5
    else:
        return 0.2


def _find_capacity_boundary(recorder: RuntimeTimelineRecorder) -> Dict[str, Any]:
    """
    寻找 Capacity Boundary

    找到 queue 开始指数增长的点
    """
    if len(recorder.entries) < 100:
        return {"found": False}

    # 计算 queue 增长率
    queues = [e.state.queue_depth for e in recorder.entries]

    # 找最大增长率
    max_growth = 0
    max_growth_idx = 0

    for i in range(10, len(queues)):
        growth = (queues[i] - queues[i-10]) / max(1, queues[i-10])
        if growth > max_growth:
            max_growth = growth
            max_growth_idx = i

    return {
        "found": max_growth > 1.0,  # 增长超过 100%
        "tick": recorder.entries[max_growth_idx].tick if max_growth > 1.0 else None,
        "growth_rate": max_growth,
        "queue_at_boundary": queues[max_growth_idx] if max_growth > 1.0 else None,
    }


def run_phase_transition_experiment(
    arrival_rates: List[float],
    cooldown: int = 5,
    duration: int = 500,
    seed: int = 42,
) -> List[Dict[str, Any]]:
    """
    运行 Phase Transition 实验

    固定 cooldown，逐步增加 arrival_rate，观察 regime 转变
    """
    print("=" * 80)
    print("SoloForge Phase Transition Experiment")
    print(f"Fixed cooldown={cooldown}, scanning arrival_rate")
    print("=" * 80)

    results = []

    for arrival_rate in arrival_rates:
        print(f"\narrival_rate={arrival_rate:.1f}: ", end="", flush=True)

        # 创建配置
        config = GovernorConfig(
            expand_threshold=100,
            shrink_threshold=20,
            cooldown_ticks=cooldown,
            hysteresis_gap=80,
            cpu_high=0.85,
            cpu_low=0.5,
        )

        # 创建时间线记录器
        recorder = RuntimeTimelineRecorder()
        recorder.set_random_seed(seed)
        recorder.set_workload_config({
            "base_arrival_rate": arrival_rate,
            "burst_probability": 0.15,
            "burst_multiplier": 5.0,
            "duration": duration,
        })
        recorder.set_governor_config(config.__dict__)

        # 创建 Governor
        governor = DampedGovernor(config, recorder)
        governor.workload.burst_probability = 0.15
        governor.workload.base_arrival_rate = arrival_rate

        # 设置随机种子
        random.seed(seed)

        # 运行
        governor.run(duration_ticks=duration)

        # 分类 Regime
        classifier = RuntimeRegimeClassifier()
        classification = classifier.classify_from_recorder(recorder)

        # 计算 Transition 指标
        transition_metrics = compute_regime_transition_metrics(recorder)

        # 获取指标
        metrics = governor.get_stability_metrics()

        print(f"regime={classification.regime.value[:6]}, "
              f"osc={metrics.oscillation_score:.3f}, "
              f"queue={metrics.queue_depth}, "
              f"workers={metrics.worker_count}")

        result = {
            "arrival_rate": arrival_rate,
            "cooldown": cooldown,
            "regime": classification.regime.value,
            "confidence": classification.confidence,
            "oscillation_score": metrics.oscillation_score,
            "final_queue": metrics.queue_depth,
            "final_workers": metrics.worker_count,
            "final_cpu": metrics.cpu_usage,
            "worker_churn_rate": metrics.worker_churn_rate,
            "control_energy": sum(abs(recorder.entries[i].state.worker_count - recorder.entries[i-1].state.worker_count)
                                  for i in range(1, len(recorder.entries))),
            "transition_metrics": transition_metrics,
            "timeline_file": f"phase_rate{arrival_rate:.1f}_cd{cooldown}_{recorder.run_id}.jsonl",
        }

        results.append(result)

        # 保存时间线
        recorder.save(result["timeline_file"])

    return results


def find_capacity_boundary(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    寻找 Capacity Boundary

    找到系统开始失去控制能力的 arrival_rate
    """
    # 找 queue 开始快速增长的点
    queues = [r["final_queue"] for r in results]
    rates = [r["arrival_rate"] for r in results]

    # 找增长率最大的点
    max_growth_rate = 0
    boundary_rate = None

    for i in range(1, len(queues)):
        if queues[i-1] > 0:
            growth = (queues[i] - queues[i-1]) / queues[i-1]
            if growth > max_growth_rate:
                max_growth_rate = growth
                boundary_rate = rates[i]

    # 找 regime 转变点
    regimes = [r["regime"] for r in results]
    transition_idx = None

    for i in range(1, len(regimes)):
        if regimes[i] != regimes[i-1]:
            transition_idx = i
            break

    return {
        "capacity_boundary_rate": boundary_rate,
        "max_queue_growth_rate": max_growth_rate,
        "regime_transition_idx": transition_idx,
        "regime_transition_rate": rates[transition_idx] if transition_idx else None,
    }


def print_results_table(results: List[Dict[str, Any]]):
    """打印结果表格"""
    print("\n" + "=" * 100)
    print("Phase Transition 实验结果")
    print("=" * 100)
    print(f"{'rate':>6} | {'regime':>12} | {'osc':>8} | {'queue':>8} | {'workers':>7} | {'churn':>8} | {'energy':>8}")
    print("-" * 100)

    for r in results:
        print(f"{r['arrival_rate']:>6.1f} | {r['regime']:>12} | {r['oscillation_score']:>8.3f} | "
              f"{r['final_queue']:>8} | {r['final_workers']:>7} | {r['worker_churn_rate']:>8.3f} | "
              f"{r['control_energy']:>8}")

    print("=" * 100)


def plot_phase_transition(results: List[Dict[str, Any]], output_path: str = "logs/timeline/phase_transition.png"):
    """绘制 Phase Transition 图"""
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        import numpy as np

        rates = [r["arrival_rate"] for r in results]
        queues = [r["final_queue"] for r in results]
        oscillations = [r["oscillation_score"] for r in results]
        regimes = [r["regime"] for r in results]

        # Regime 颜色
        regime_colors = {
            "hyper_reactive": "red",
            "healthy_dynamic": "green",
            "under_reactive": "orange",
            "dead_runtime": "gray",
            "mixed": "purple",
            "unknown": "blue"
        }

        fig, axes = plt.subplots(2, 2, figsize=(14, 10))

        # 图1: Queue vs Arrival Rate
        ax1 = axes[0, 0]
        colors = [regime_colors.get(r, "blue") for r in regimes]
        ax1.scatter(rates, [q/1000 for q in queues], c=colors, s=100, alpha=0.7)
        ax1.plot(rates, [q/1000 for q in queues], 'k--', alpha=0.3)
        ax1.set_xlabel('Arrival Rate')
        ax1.set_ylabel('Final Queue (×1000)')
        ax1.set_title('Queue vs Arrival Rate (Color = Regime)')
        ax1.grid(True, alpha=0.3)

        # 添加 regime 图例
        for regime, color in regime_colors.items():
            if regime in regimes:
                ax1.scatter([], [], c=color, label=regime)
        ax1.legend()

        # 图2: Oscillation vs Arrival Rate
        ax2 = axes[0, 1]
        ax2.scatter(rates, oscillations, c=colors, s=100, alpha=0.7)
        ax2.plot(rates, oscillations, 'k--', alpha=0.3)
        ax2.set_xlabel('Arrival Rate')
        ax2.set_ylabel('Oscillation Score')
        ax2.set_title('Oscillation vs Arrival Rate')
        ax2.grid(True, alpha=0.3)

        # 图3: Regime 分布
        ax3 = axes[1, 0]
        regime_counts = {}
        for r in regimes:
            regime_counts[r] = regime_counts.get(r, 0) + 1
        ax3.bar(regime_counts.keys(), regime_counts.values(),
                color=[regime_colors.get(k, "blue") for k in regime_counts.keys()])
        ax3.set_xlabel('Regime')
        ax3.set_ylabel('Count')
        ax3.set_title('Regime Distribution')
        ax3.tick_params(axis='x', rotation=45)

        # 图4: Regime Transition Timeline (最后一个实验)
        ax4 = axes[1, 1]
        if results:
            last_result = results[-1]
            tm = last_result.get("transition_metrics", {})
            if tm.get("regime_timeline"):
                timeline = tm["regime_timeline"]
                colors_seq = [regime_colors.get(r, "blue") for r in timeline]
                ax4.bar(range(len(timeline)), [1]*len(timeline), color=colors_seq, alpha=0.7)
                ax4.set_xlabel('Tick')
                ax4.set_ylabel('Regime')
                ax4.set_title(f'Regime Timeline (rate={last_result["arrival_rate"]:.1f})')
                ax4.set_yticks([])

        fig.suptitle('Phase Transition: Runtime Capacity Boundary', fontsize=14, fontweight='bold')
        plt.tight_layout()
        plt.savefig(output_path, dpi=150, bbox_inches='tight')
        print(f"\n[Phase Transition] 已保存: {output_path}")
        plt.close()

    except ImportError as e:
        print(f"[Phase Transition] matplotlib 未安装: {e}")


def save_results_json(results: List[Dict[str, Any]], output_path: str = "logs/timeline/phase_transition_results.json"):
    """保存结果"""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"\n[Results] 已保存: {output_path}")


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="Phase Transition Experiment")
    parser.add_argument("--rates", "-r", nargs="+", type=float,
                        default=[5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 35.0, 40.0, 45.0, 50.0],
                        help="arrival_rate 值列表")
    parser.add_argument("--cooldown", "-c", type=int, default=5,
                        help="cooldown 值")
    parser.add_argument("--duration", "-d", type=int, default=500,
                        help="实验持续 ticks")
    parser.add_argument("--seed", type=int, default=42,
                        help="随机种子")
    parser.add_argument("--no-plot", action="store_true",
                        help="跳过绘图")

    args = parser.parse_args()

    # 运行实验
    results = run_phase_transition_experiment(
        args.rates,
        args.cooldown,
        args.duration,
        args.seed,
    )

    # 打印结果
    print_results_table(results)

    # 寻找 Capacity Boundary
    boundary = find_capacity_boundary(results)
    print(f"\n[Capacity Boundary]")
    print(f"  Queue 增长临界 rate: {boundary['capacity_boundary_rate']}")
    print(f"  最大 queue 增长率: {boundary['max_queue_growth_rate']:.2f}")
    if boundary['regime_transition_rate']:
        print(f"  Regime 转变点: arrival_rate = {boundary['regime_transition_rate']}")

    # 保存结果
    save_results_json(results)

    # 绘图
    if not args.no_plot:
        plot_phase_transition(results)


if __name__ == '__main__':
    main()
