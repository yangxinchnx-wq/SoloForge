# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Cooldown Sweep Experiment
# Path: python/training/simulator/cooldown_sweep.py
#
# 核心实验：扫描不同 cooldown 值，绘制 Runtime Stability Curve
# 发现临界转变点 (Critical Transition Point)
# ─────────────────────────────────────────────────────────────────

import sys
import os
import random
import json

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


def run_cooldown_experiment(
    cooldown: int,
    duration: int = 500,
    seed: int = 42,
    burst_prob: float = 0.15,
    arrival_rate: float = 15.0,
    expand_threshold: int = 80,
    shrink_threshold: int = 20,
) -> dict:
    """
    运行单个 cooldown 实验

    Returns:
        实验结果字典
    """
    print(f"\n  cooldown={cooldown}: ", end="", flush=True)

    # 创建配置
    config = GovernorConfig(
        expand_threshold=expand_threshold,
        shrink_threshold=shrink_threshold,
        cooldown_ticks=cooldown,
        hysteresis_gap=expand_threshold - shrink_threshold,
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

    # 控制能量（从 timeline 计算）
    control_energy = 0
    prev_workers = None
    for entry in recorder.entries:
        if prev_workers is not None:
            control_energy += abs(entry.state.worker_count - prev_workers)
        prev_workers = entry.state.worker_count

    # 保存时间线
    timeline_filename = f"damped_cd{cooldown}_{recorder.run_id}.jsonl"
    recorder.save(timeline_filename)
    print(f"osc={metrics.oscillation_score:.3f}, queue={metrics.queue_depth}, workers={metrics.worker_count}, churn={metrics.worker_churn_rate:.3f}")

    return {
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
        "expansion_count": governor.expansion_count,
        "contraction_count": governor.contraction_count,
        "timeline_file": timeline_filename,
    }


def run_sweep(
    cooldown_values: list,
    duration: int = 500,
    seed: int = 42,
) -> list:
    """
    运行 cooldown 扫描实验

    Args:
        cooldown_values: cooldown 值列表
        duration: 每次实验持续 ticks
        seed: 随机种子

    Returns:
        实验结果列表
    """
    print("=" * 70)
    print("SoloForge Cooldown Sweep Experiment")
    print("Runtime Stability Curve: 寻找临界转变点")
    print("=" * 70)

    results = []

    for cooldown in cooldown_values:
        result = run_cooldown_experiment(cooldown, duration, seed)
        results.append(result)

    return results


def analyze_transition_point(results: list) -> dict:
    """
    分析临界转变点

    寻找：
    1. oscillation 开始快速下降的 cooldown 值
    2. queue 开始快速上升的 cooldown 值
    """
    if len(results) < 2:
        return {}

    # 按 cooldown 排序
    results.sort(key=lambda x: x['cooldown'])

    oscillations = [r['oscillation_score'] for r in results]
    queues = [r['final_queue'] for r in results]
    cooldowns = [r['cooldown'] for r in results]

    # 找 oscillation 转变点
    osc_transition = None
    for i in range(1, len(oscillations)):
        drop_rate = (oscillations[i-1] - oscillations[i]) / max(0.001, oscillations[i-1])
        if drop_rate > 0.5:  # 下降超过 50%
            osc_transition = cooldowns[i]
            break

    # 找 queue 转变点
    queue_transition = None
    for i in range(1, len(queues)):
        if queues[i] > queues[i-1] * 2:  # 翻倍
            queue_transition = cooldowns[i]
            break

    return {
        "oscillation_transition_cooldown": osc_transition,
        "queue_transition_cooldown": queue_transition,
        "stability_regime": _classify_regime(results),
    }


def _classify_regime(results: list) -> str:
    """
    分类稳定性 regime

    Mode A: Hyper-Reactive (cooldown 太短)
    Mode B: Under-Reactive (cooldown 太长)
    Mode C: Balanced (cooldown 适中)
    """
    avg_osc = sum(r['oscillation_score'] for r in results) / len(results)
    avg_queue = sum(r['final_queue'] for r in results) / len(results)

    if avg_osc > 0.3 and avg_queue < 500:
        return "hyper_reactive"  # Mode A
    elif avg_osc < 0.15 and avg_queue > 3000:
        return "under_reactive"  # Mode B
    elif avg_osc < 0.2 and avg_queue < 2000:
        return "balanced"  # Mode C
    else:
        return "mixed"


def print_results_table(results: list):
    """打印结果表格"""
    print("\n" + "=" * 100)
    print("Cooldown Sweep 实验结果")
    print("=" * 100)
    print(f"{'cd':>4} | {'osc':>8} | {'queue':>8} | {'workers':>8} | {'churn':>8} | {'energy':>10} | {'expand':>7} | {'shrink':>7}")
    print("-" * 100)

    for r in results:
        print(f"{r['cooldown']:>4} | {r['oscillation_score']:>8.3f} | {r['final_queue']:>8} | {r['final_workers']:>8} | {r['worker_churn_rate']:>8.3f} | {r['control_energy']:>10.0f} | {r['expansion_count']:>7} | {r['contraction_count']:>7}")

    print("=" * 100)


def plot_stability_curve(results: list, output_dir: str = "logs/timeline"):
    """
    绘制稳定性曲线（保存为 JSON 供 Dashboard 使用）
    """
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt

        results.sort(key=lambda x: x['cooldown'])

        cooldowns = [r['cooldown'] for r in results]
        oscillations = [r['oscillation_score'] for r in results]
        queues = [r['final_queue'] for r in results]
        churns = [r['worker_churn_rate'] for r in results]
        energies = [r['control_energy'] for r in results]

        fig, axes = plt.subplots(2, 2, figsize=(14, 10))

        # Oscillation vs Cooldown
        axes[0, 0].plot(cooldowns, oscillations, 'o-', color='red', linewidth=2, markersize=8)
        axes[0, 0].set_xlabel('Cooldown (ticks)')
        axes[0, 0].set_ylabel('Oscillation Score')
        axes[0, 0].set_title('Oscillation vs Cooldown')
        axes[0, 0].grid(True, alpha=0.3)
        axes[0, 0].axhline(y=0.15, color='green', linestyle='--', alpha=0.5, label='Stability threshold')
        axes[0, 0].legend()

        # Final Queue vs Cooldown
        axes[0, 1].plot(cooldowns, queues, 'o-', color='blue', linewidth=2, markersize=8)
        axes[0, 1].set_xlabel('Cooldown (ticks)')
        axes[0, 1].set_ylabel('Final Queue')
        axes[0, 1].set_title('Final Queue vs Cooldown (Responsiveness)')
        axes[0, 1].grid(True, alpha=0.3)
        axes[0, 1].axhline(y=2000, color='orange', linestyle='--', alpha=0.5, label='Queue threshold')
        axes[0, 1].legend()

        # Worker Churn vs Cooldown
        axes[1, 0].plot(cooldowns, churns, 'o-', color='purple', linewidth=2, markersize=8)
        axes[1, 0].set_xlabel('Cooldown (ticks)')
        axes[1, 0].set_ylabel('Worker Churn Rate')
        axes[1, 0].set_title('Worker Churn vs Cooldown')
        axes[1, 0].grid(True, alpha=0.3)

        # Control Energy vs Cooldown
        axes[1, 1].plot(cooldowns, energies, 'o-', color='green', linewidth=2, markersize=8)
        axes[1, 1].set_xlabel('Cooldown (ticks)')
        axes[1, 1].set_ylabel('Control Energy')
        axes[1, 1].set_title('Control Effort vs Cooldown')
        axes[1, 1].grid(True, alpha=0.3)

        fig.suptitle('Runtime Stability Curve: Cooldown Sweep', fontsize=14, fontweight='bold')
        plt.tight_layout()

        output_path = os.path.join(output_dir, "stability_curve.png")
        plt.savefig(output_path, dpi=150, bbox_inches='tight')
        print(f"\n[Stability Curve] 已保存: {output_path}")
        plt.close()

    except ImportError:
        print("[Stability Curve] matplotlib 未安装，跳过绘图")


def save_results_json(results: list, output_path: str = "logs/timeline/cooldown_sweep_results.json"):
    """保存结果为 JSON"""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"[Results] 已保存: {output_path}")


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="Cooldown Sweep Experiment")
    parser.add_argument("--cooldowns", "-c", nargs="+", type=int,
                        default=[0, 5, 10, 15, 20, 30, 50, 75, 100],
                        help="cooldown 值列表")
    parser.add_argument("--duration", "-d", type=int, default=500,
                        help="每次实验持续 ticks")
    parser.add_argument("--seed", "-s", type=int, default=42,
                        help="随机种子")
    parser.add_argument("--no-plot", action="store_true",
                        help="跳过绘图")

    args = parser.parse_args()

    # 运行扫描实验
    results = run_sweep(args.cooldowns, args.duration, args.seed)

    # 打印结果表格
    print_results_table(results)

    # 分析临界转变点
    transition = analyze_transition_point(results)
    print(f"\n[临界转变点分析]")
    if transition.get('oscillation_transition_cooldown'):
        print(f"  振荡转变点: cooldown = {transition['oscillation_transition_cooldown']}")
    if transition.get('queue_transition_cooldown'):
        print(f"  队列转变点: cooldown = {transition['queue_transition_cooldown']}")
    print(f"  稳定性 Regime: {transition.get('stability_regime', 'unknown')}")

    # 保存结果
    save_results_json(results)

    # 绘制稳定性曲线
    if not args.no_plot:
        plot_stability_curve(results)


if __name__ == '__main__':
    main()
