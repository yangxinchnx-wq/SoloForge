# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Hysteresis Sweep Experiment
# Path: python/training/simulator/hysteresis_sweep.py
#
# 核心实验：二维扫描 expand_threshold 和 shrink_threshold
# 绘制 Runtime Stability Surface
# ─────────────────────────────────────────────────────────────────

import sys
import os
import random
import json
from typing import List, Dict, Any, Tuple

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


def run_hysteresis_experiment(
    expand_threshold: int,
    shrink_threshold: int,
    cooldown: int = 15,
    duration: int = 500,
    seed: int = 42,
    burst_prob: float = 0.15,
    arrival_rate: float = 15.0,
) -> dict:
    """
    运行单个 hysteresis 实验

    Returns:
        实验结果字典
    """
    # 确保 expand > shrink
    if expand_threshold <= shrink_threshold:
        return {
            "error": "expand_threshold must be > shrink_threshold",
            "expand": expand_threshold,
            "shrink": shrink_threshold,
        }

    hysteresis_gap = expand_threshold - shrink_threshold

    print(f"  expand={expand_threshold:3d}, shrink={shrink_threshold:3d}, gap={hysteresis_gap:3d}: ", end="", flush=True)

    # 创建配置
    config = GovernorConfig(
        expand_threshold=expand_threshold,
        shrink_threshold=shrink_threshold,
        cooldown_ticks=cooldown,
        hysteresis_gap=hysteresis_gap,
        cpu_high=0.85,
        cpu_low=0.5,
    )

    # 创建时间线记录器
    recorder = RuntimeTimelineRecorder()
    recorder.set_random_seed(seed)
    recorder.set_workload_config({
        "base_arrival_rate": arrival_rate,
        "burst_probability": burst_prob,
        "burst_multiplier": 5.0,
        "duration": duration,
    })
    recorder.set_governor_config(config.__dict__)

    # 创建 Governor
    governor = DampedGovernor(config, recorder)
    governor.workload.burst_probability = burst_prob
    governor.workload.base_arrival_rate = arrival_rate

    # 设置随机种子
    random.seed(seed)

    # 运行
    governor.run(duration_ticks=duration)

    # 计算结果
    metrics = governor.get_stability_metrics()

    # 计算 Queue Recovery Integral (QRI) - queue 随时间的累积面积
    qri = 0.0
    for queue in [e.state.queue_depth for e in recorder.entries]:
        qri += queue

    # 控制能量
    control_energy = 0
    prev_workers = None
    for entry in recorder.entries:
        if prev_workers is not None:
            control_energy += abs(entry.state.worker_count - prev_workers)
        prev_workers = entry.state.worker_count

    # 分类 Regime
    regime = classify_regime(
        metrics.oscillation_score,
        metrics.queue_depth,
        metrics.worker_churn_rate,
    )

    print(f"osc={metrics.oscillation_score:.3f}, queue={metrics.queue_depth:6d}, workers={metrics.worker_count:2d}, qri={qri/1000:.0f}k, regime={regime}")

    return {
        "expand_threshold": expand_threshold,
        "shrink_threshold": shrink_threshold,
        "hysteresis_gap": hysteresis_gap,
        "cooldown": cooldown,
        "oscillation_score": metrics.oscillation_score,
        "final_queue": metrics.queue_depth,
        "final_workers": metrics.worker_count,
        "final_cpu": metrics.cpu_usage,
        "worker_churn_rate": metrics.worker_churn_rate,
        "action_frequency": metrics.action_frequency,
        "overshoot_ratio": metrics.overshoot_ratio,
        "recovery_half_life": metrics.queue_recovery_half_life,
        "control_energy": control_energy,
        "queue_recovery_integral": qri,  # 新指标
        "expansion_count": governor.expansion_count,
        "contraction_count": governor.contraction_count,
        "regime": regime,
        "timeline_file": f"hyst_exp{expand_threshold}_shr{shrink_threshold}_cd{cooldown}_{recorder.run_id}.jsonl",
        "recorder": recorder,  # 保存 recorder 以便后续保存
    }


def classify_regime(oscillation: float, queue: int, churn: float) -> str:
    """
    分类 Runtime Regime

    | Regime          | 特征                       |
    | --------------- | -------------------------- |
    | Hyper-Reactive  | 高 churn 高 osc            |
    | Healthy Dynamic | 中等 osc + 低 queue         |
    | Under-Reactive  | 低 osc + queue 增长         |
    | Dead Runtime    | 零 churn + queue collapse  |
    """
    if churn > 0.2 and oscillation > 0.3:
        return "hyper_reactive"  # Mode A
    elif oscillation < 0.1 and queue > 5000:
        return "under_reactive"  # Mode B
    elif churn < 0.01 and oscillation < 0.01:
        return "dead"  # Mode C
    elif oscillation < 0.2 and queue < 1000:
        return "healthy_dynamic"  # 平衡
    else:
        return "mixed"


def run_sweep(
    expand_values: List[int],
    shrink_values: List[int],
    cooldown: int = 15,
    duration: int = 500,
    seed: int = 42,
) -> List[Dict[str, Any]]:
    """
    运行二维 hysteresis 扫描实验
    """
    print("=" * 80)
    print("SoloForge Hysteresis Sweep Experiment")
    print("二维扫描: expand_threshold × shrink_threshold")
    print(f"cooldown = {cooldown}, duration = {duration} ticks")
    print("=" * 80)

    results = []

    # 遍历所有组合
    for expand in expand_values:
        for shrink in shrink_values:
            if expand > shrink:  # 必须 expand > shrink
                result = run_hysteresis_experiment(
                    expand, shrink, cooldown, duration, seed
                )
                results.append(result)
                result["recorder"].save(result["timeline_file"])

    return results


def find_stable_islands(results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    寻找"稳定岛"

    稳定岛定义：
    - oscillation_score < 0.2
    - final_queue < 1000
    - worker_churn_rate < 0.1
    """
    stable_islands = []

    for r in results:
        if "error" in r:
            continue

        if (r["oscillation_score"] < 0.2 and
            r["final_queue"] < 1000 and
            r["worker_churn_rate"] < 0.1):
            stable_islands.append({
                "expand_threshold": r["expand_threshold"],
                "shrink_threshold": r["shrink_threshold"],
                "hysteresis_gap": r["hysteresis_gap"],
                "oscillation_score": r["oscillation_score"],
                "final_queue": r["final_queue"],
                "worker_churn_rate": r["worker_churn_rate"],
                "queue_recovery_integral": r["queue_recovery_integral"],
            })

    return stable_islands


def find_critical_boundary(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    寻找临界边界

    边界定义：
    - 从 healthy_dynamic 变为 under_reactive 的点
    """
    healthy = [r for r in results if r.get("regime") == "healthy_dynamic"]
    under_reactive = [r for r in results if r.get("regime") == "under_reactive"]

    boundary = {
        "healthy_count": len(healthy),
        "under_reactive_count": len(under_reactive),
        "healthy_hysteresis_gaps": [r["hysteresis_gap"] for r in healthy] if healthy else [],
        "under_reactive_hysteresis_gaps": [r["hysteresis_gap"] for r in under_reactive] if under_reactive else [],
    }

    # 找最大 gap 的 healthy 和最小 gap 的 under_reactive
    if healthy:
        boundary["max_healthy_gap"] = max(b["hysteresis_gap"] for b in healthy)
    if under_reactive:
        boundary["min_under_reactive_gap"] = min(b["hysteresis_gap"] for b in under_reactive)

    return boundary


def print_results_grid(results: List[Dict[str, Any]]):
    """打印结果网格"""
    # 收集所有唯一值
    expands = sorted(set(r["expand_threshold"] for r in results if "error" not in r))
    shrinks = sorted(set(r["shrink_threshold"] for r in results if "error" not in r))

    print("\n" + "=" * 80)
    print("Hysteresis Sweep 结果网格")
    print("=" * 80)

    # 打印表头
    print(f"\n{'':>8}", end="")
    for shrink in shrinks:
        print(f" | shrink={shrink:3d}", end="")
    print()

    # 打印每一行
    for expand in expands:
        print(f"\nexpand={expand:3d}", end="")
        for shrink in shrinks:
            # 找对应结果
            result = None
            for r in results:
                if r.get("expand_threshold") == expand and r.get("shrink_threshold") == shrink:
                    result = r
                    break

            if result:
                osc = result.get("oscillation_score", 0)
                queue = result.get("final_queue", 0)
                regime = result.get("regime", "?")[0]  # 取首字母
                print(f" | {osc:.2f}/{queue//1000}k/{regime}", end="")
            else:
                print(f" |    -    ", end="")
        print()


def print_stable_islands(stable_islands: List[Dict[str, Any]]):
    """打印稳定岛"""
    print("\n" + "=" * 80)
    print("🎯 稳定岛 (Stable Islands)")
    print("条件: osc < 0.2, queue < 1000, churn < 0.1")
    print("=" * 80)

    if not stable_islands:
        print("  未找到稳定岛")
        return

    for island in stable_islands:
        print(f"  expand={island['expand_threshold']:3d}, shrink={island['shrink_threshold']:3d}, "
              f"gap={island['hysteresis_gap']:3d}")
        print(f"    osc={island['oscillation_score']:.3f}, queue={island['final_queue']:5d}, "
              f"churn={island['worker_churn_rate']:.3f}")
        print(f"    QRI={island['queue_recovery_integral']/1000:.0f}k")
    print()


def save_results_json(results: List[Dict[str, Any]], output_path: str = "logs/timeline/hysteresis_sweep_results.json"):
    """保存结果为 JSON"""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    # 移除不可序列化的对象
    serializable_results = []
    for r in results:
        clean_r = {k: v for k, v in r.items() if k != 'recorder'}
        serializable_results.append(clean_r)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(serializable_results, f, indent=2, ensure_ascii=False)
    print(f"\n[Results] 已保存: {output_path}")


def plot_stability_surface(results: List[Dict[str, Any]], output_path: str = "logs/timeline/stability_surface.png"):
    """
    绘制稳定性曲面（需要 matplotlib）
    """
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        from mpl_toolkits.mplot3d import Axes3D
        import numpy as np

        # 过滤有效结果
        valid_results = [r for r in results if "error" not in r]
        if not valid_results:
            print("[Stability Surface] 无有效数据")
            return

        # 提取数据
        expands = [r["expand_threshold"] for r in valid_results]
        shrinks = [r["shrink_threshold"] for r in valid_results]
        gaps = [r["hysteresis_gap"] for r in valid_results]
        oscillations = [r["oscillation_score"] for r in valid_results]
        queues = [r["final_queue"] for r in valid_results]
        regimes = [r["regime"] for r in valid_results]

        fig = plt.figure(figsize=(18, 12))

        # 图1: Oscillation vs Hysteresis Gap
        ax1 = fig.add_subplot(2, 2, 1)
        colors = {'hyper_reactive': 'red', 'healthy_dynamic': 'green', 'under_reactive': 'orange', 'dead': 'gray', 'mixed': 'purple'}
        regime_colors = [colors.get(r, 'blue') for r in regimes]
        ax1.scatter(gaps, oscillations, c=regime_colors, s=50, alpha=0.7)
        ax1.set_xlabel('Hysteresis Gap')
        ax1.set_ylabel('Oscillation Score')
        ax1.set_title('Oscillation vs Hysteresis Gap')
        ax1.grid(True, alpha=0.3)
        ax1.axhline(y=0.2, color='green', linestyle='--', alpha=0.5, label='Stable threshold')
        ax1.legend()

        # 图2: Final Queue vs Hysteresis Gap
        ax2 = fig.add_subplot(2, 2, 2)
        ax2.scatter(gaps, [q/1000 for q in queues], c=regime_colors, s=50, alpha=0.7)
        ax2.set_xlabel('Hysteresis Gap')
        ax2.set_ylabel('Final Queue (×1000)')
        ax2.set_title('Queue vs Hysteresis Gap')
        ax2.grid(True, alpha=0.3)
        ax2.axhline(y=1, color='orange', linestyle='--', alpha=0.5, label='Queue threshold')
        ax2.legend()

        # 图3: Regime Distribution
        ax3 = fig.add_subplot(2, 2, 3)
        regime_counts = {}
        for r in regimes:
            regime_counts[r] = regime_counts.get(r, 0) + 1
        ax3.bar(regime_counts.keys(), regime_counts.values(), color=[colors.get(k, 'blue') for k in regime_counts.keys()])
        ax3.set_xlabel('Regime')
        ax3.set_ylabel('Count')
        ax3.set_title('Regime Distribution')
        ax3.tick_params(axis='x', rotation=45)

        # 图4: 2D Heatmap - Oscillation
        ax4 = fig.add_subplot(2, 2, 4)

        # 创建网格
        unique_expands = sorted(set(expands))
        unique_shrinks = sorted(set(shrinks))

        # 过滤有效组合
        valid_pairs = [(e, s) for e in unique_expands for s in unique_shrinks if e > s]
        valid_expands = sorted(set(e for e, s in valid_pairs))
        valid_shrinks = sorted(set(s for e, s in valid_pairs))

        # 创建矩阵
        osc_matrix = np.full((len(valid_shrinks), len(valid_expands)), np.nan)
        for r in valid_results:
            try:
                ei = valid_expands.index(r["expand_threshold"])
                si = valid_shrinks.index(r["shrink_threshold"])
                osc_matrix[si, ei] = r["oscillation_score"]
            except ValueError:
                continue

        im = ax4.imshow(osc_matrix, cmap='RdYlGn_r', aspect='auto', origin='lower')
        ax4.set_xlabel('expand_threshold')
        ax4.set_ylabel('shrink_threshold')
        ax4.set_title('Oscillation Heatmap')
        ax4.set_xticks(range(len(valid_expands)))
        ax4.set_xticklabels(valid_expands)
        ax4.set_yticks(range(len(valid_shrinks)))
        ax4.set_yticklabels(valid_shrinks)
        plt.colorbar(im, ax=ax4, label='Oscillation')

        fig.suptitle('Runtime Stability Surface: Hysteresis Sweep', fontsize=14, fontweight='bold')
        plt.tight_layout()
        plt.savefig(output_path, dpi=150, bbox_inches='tight')
        print(f"\n[Stability Surface] 已保存: {output_path}")
        plt.close()

    except ImportError as e:
        print(f"[Stability Surface] matplotlib 未安装: {e}")


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="Hysteresis Sweep Experiment")
    parser.add_argument("--expands", "-e", nargs="+", type=int,
                        default=[50, 80, 100, 120, 150, 200],
                        help="expand_threshold 值列表")
    parser.add_argument("--shrinks", "-s", nargs="+", type=int,
                        default=[20, 30, 40, 50, 60, 70],
                        help="shrink_threshold 值列表")
    parser.add_argument("--cooldown", "-c", type=int, default=15,
                        help="cooldown 值")
    parser.add_argument("--duration", "-d", type=int, default=500,
                        help="每次实验持续 ticks")
    parser.add_argument("--seed", type=int, default=42,
                        help="随机种子")
    parser.add_argument("--no-plot", action="store_true",
                        help="跳过绘图")

    args = parser.parse_args()

    # 运行扫描实验
    results = run_sweep(
        args.expands,
        args.shrinks,
        args.cooldown,
        args.duration,
        args.seed,
    )

    # 打印结果网格
    print_results_grid(results)

    # 寻找稳定岛
    stable_islands = find_stable_islands(results)
    print_stable_islands(stable_islands)

    # 寻找临界边界
    boundary = find_critical_boundary(results)
    print("\n" + "=" * 80)
    print("🎯 临界边界分析")
    print("=" * 80)
    print(f"  Healthy Dynamic: {boundary['healthy_count']} 个配置")
    print(f"  Under-Reactive: {boundary['under_reactive_count']} 个配置")
    if boundary.get("max_healthy_gap"):
        print(f"  最大 Healthy Gap: {boundary['max_healthy_gap']}")
    if boundary.get("min_under_reactive_gap"):
        print(f"  最小 Under-Reactive Gap: {boundary['min_under_reactive_gap']}")

    # 保存结果
    save_results_json(results)

    # 绘制稳定性曲面
    if not args.no_plot:
        plot_stability_surface(results)


if __name__ == '__main__':
    main()
