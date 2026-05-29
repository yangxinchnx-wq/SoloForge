# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime Dynamics Dashboard v1
# Path: python/training/simulator/dashboard.py
#
# 核心功能：
# 1. 读取时间线 JSONL 文件
# 2. 共享时间轴可视化所有指标
# 3. 检测因果动力学（queue→worker→cpu 延迟链）
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import argparse
from typing import Dict, Any, List, Optional, Tuple
from dataclasses import dataclass, field, asdict
from collections import defaultdict

# 设置 UTF-8 输出
sys.stdout.reconfigure(encoding='utf-8')

# 添加项目根目录到路径
script_dir = os.path.dirname(os.path.abspath(__file__))
training_dir = os.path.dirname(script_dir)
python_dir = os.path.dirname(training_dir)
sys.path.insert(0, python_dir)

from training.simulator.timeline_recorder import RuntimeTimelineRecorder

# 尝试导入 matplotlib
try:
    import matplotlib
    matplotlib.use('Agg')  # 非交互式后端
    import matplotlib.pyplot as plt
    import matplotlib.gridspec as gridspec
    HAS_MATPLOTLIB = True
except ImportError:
    HAS_MATPLOTLIB = False
    print("[Dashboard] 警告: matplotlib 未安装，将使用文本模式")


@dataclass
class TimelineMetrics:
    """时间线派生指标"""
    ticks: List[int] = field(default_factory=list)

    # 原始状态
    queue_depth: List[int] = field(default_factory=list)
    worker_count: List[int] = field(default_factory=list)
    cpu_usage: List[float] = field(default_factory=list)
    reflection_load: List[float] = field(default_factory=list)

    # 派生指标
    oscillation_score: List[float] = field(default_factory=list)
    worker_churn: List[float] = field(default_factory=list)
    action_frequency: List[float] = field(default_factory=list)

    # 新增指标
    action_latency: List[float] = field(default_factory=list)  # Governor 决策延迟
    control_energy: List[float] = field(default_factory=list)    # 控制能量
    queue_delta: List[int] = field(default_factory=list)        # 队列变化率

    # 动作追踪
    actions: List[str] = field(default_factory=list)
    blocked_actions: List[int] = field(default_factory=list)     # cooldown 阻塞次数

    # 事件
    warnings: List[Dict[str, Any]] = field(default_factory=list)


def load_timeline(filepath: str) -> TimelineMetrics:
    """加载时间线文件并计算所有指标"""
    recorder = RuntimeTimelineRecorder()
    if not recorder.load(filepath):
        return TimelineMetrics()

    metrics = TimelineMetrics()

    prev_worker_count = None
    prev_queue = None
    cooldown_blocked = 0

    for entry in recorder.entries:
        # 基础数据
        metrics.ticks.append(entry.tick)
        metrics.queue_depth.append(entry.state.queue_depth)
        metrics.worker_count.append(entry.state.worker_count)
        metrics.cpu_usage.append(entry.state.cpu_usage)
        metrics.reflection_load.append(entry.state.reflection_load)

        # 派生指标
        metrics.oscillation_score.append(entry.derived_metrics.oscillation_score)
        metrics.worker_churn.append(entry.derived_metrics.worker_churn_rate)
        metrics.action_frequency.append(entry.derived_metrics.action_frequency)

        # Action Latency: worker_count 变化延迟
        if prev_worker_count is not None:
            if entry.state.worker_count != prev_worker_count:
                # Worker 变化发生，记录当前 tick
                metrics.action_latency.append(0.0)  # 简化：0 = 即时响应
            else:
                metrics.action_latency.append(metrics.action_latency[-1] + 1.0 if metrics.action_latency else 1.0)
        else:
            metrics.action_latency.append(0.0)
        prev_worker_count = entry.state.worker_count

        # Control Energy: |worker_delta|
        if len(metrics.worker_count) >= 2:
            delta = abs(metrics.worker_count[-1] - metrics.worker_count[-2])
            prev_energy = metrics.control_energy[-1] if metrics.control_energy else 0
            metrics.control_energy.append(prev_energy + delta)
        else:
            metrics.control_energy.append(0)

        # Queue Delta: 队列变化率
        if prev_queue is not None:
            metrics.queue_delta.append(entry.state.queue_depth - prev_queue)
        else:
            metrics.queue_delta.append(0)
        prev_queue = entry.state.queue_depth

        # 动作追踪
        metrics.actions.append(entry.action.type)
        if entry.action.blocked_by_cooldown:
            cooldown_blocked += 1
        metrics.blocked_actions.append(cooldown_blocked)

        # 事件
        for event in entry.events:
            if event.severity in ['warning', 'critical']:
                metrics.warnings.append({
                    'tick': entry.tick,
                    'type': event.type,
                    'severity': event.severity,
                    'data': event.data
                })

    return metrics


def compute_cross_correlation(x: List[float], y: List[float], max_lag: int = 50) -> Tuple[List[int], List[float]]:
    """
    计算互相关（检测因果延迟）

    Returns:
        (lags, correlations)
    """
    if len(x) < max_lag * 2 or len(y) < max_lag * 2:
        return [], []

    correlations = []
    lags = range(-max_lag, max_lag + 1)

    for lag in lags:
        if lag < 0:
            x_shifted = x[:lag]
            y_shifted = y[-lag:]
        elif lag > 0:
            x_shifted = x[lag:]
            y_shifted = y[:-lag]
        else:
            x_shifted = x
            y_shifted = y

        if len(x_shifted) < 10:
            correlations.append(0)
            continue

        # Pearson 相关
        n = len(x_shifted)
        mean_x = sum(x_shifted) / n
        mean_y = sum(y_shifted) / n
        cov = sum((x_shifted[i] - mean_x) * (y_shifted[i] - mean_y) for i in range(n))
        std_x = (sum((v - mean_x) ** 2 for v in x_shifted) / n) ** 0.5
        std_y = (sum((v - mean_y) ** 2 for v in y_shifted) / n) ** 0.5

        if std_x > 0 and std_y > 0:
            correlations.append(cov / (n * std_x * std_y))
        else:
            correlations.append(0)

    return list(lags), correlations


def detect_causal_chain(metrics: TimelineMetrics) -> Dict[str, Any]:
    """
    检测因果动力学链

    分析：
    1. queue 上升 → worker 扩容延迟
    2. worker 扩容 → cpu 上升延迟
    3. cooldown 阻塞效果
    """
    results = {
        'queue_to_worker_lag': None,
        'worker_to_cpu_lag': None,
        'cooldown_effectiveness': None,
        'stability_regime': 'unknown',
    }

    # 找到 queue 峰值和 worker 峰值
    if len(metrics.queue_depth) > 10:
        queue_peak_idx = metrics.queue_depth.index(max(metrics.queue_depth))
        worker_peak_idx = metrics.worker_count.index(max(metrics.worker_count))

        if queue_peak_idx < worker_peak_idx:
            results['queue_to_worker_lag'] = worker_peak_idx - queue_peak_idx
        else:
            results['queue_to_worker_lag'] = -(queue_peak_idx - worker_peak_idx)

    # Cooldown 阻塞率
    total_actions = len(metrics.actions)
    blocked = metrics.blocked_actions[-1] if metrics.blocked_actions else 0
    if total_actions > 0:
        results['cooldown_effectiveness'] = blocked / total_actions

    # 稳定性 regime 判断
    avg_osc = sum(metrics.oscillation_score) / len(metrics.oscillation_score) if metrics.oscillation_score else 0
    final_queue = metrics.queue_depth[-1] if metrics.queue_depth else 0
    final_workers = metrics.worker_count[-1] if metrics.worker_count else 0

    if avg_osc > 0.3 and final_queue < 100:
        results['stability_regime'] = 'hyper_reactive'  # Mode A
    elif avg_osc < 0.1 and final_queue > 5000:
        results['stability_regime'] = 'under_reactive'  # Mode B
    elif avg_osc < 0.15 and 100 < final_queue < 2000:
        results['stability_regime'] = 'balanced'
    else:
        results['stability_regime'] = 'mixed'

    return results


def plot_dashboard(metrics: TimelineMetrics, output_path: str, title: str = "Runtime Dynamics Dashboard"):
    """绘制 Dashboard"""
    if not HAS_MATPLOTLIB:
        print("[Dashboard] matplotlib 未安装，跳过绘图")
        return

    # 设置中文字体
    plt.rcParams['font.sans-serif'] = ['Microsoft YaHei', 'SimHei', 'Arial Unicode MS']
    plt.rcParams['axes.unicode_minus'] = False

    # 创建图表
    fig = plt.figure(figsize=(16, 12))
    gs = gridspec.GridSpec(4, 1, height_ratios=[1, 1, 1, 1], hspace=0.3)

    # 颜色方案
    colors = {
        'queue': '#2E86AB',      # 蓝色
        'workers': '#A23B72',    # 紫色
        'cpu': '#F18F01',        # 橙色
        'oscillation': '#C73E1D', # 红色
        'churn': '#3B1F2B',      # 深色
        'control_energy': '#44AF69', # 绿色
    }

    # 共享时间轴
    ticks = metrics.ticks

    # === 图1: Queue & Workers (同轴) ===
    ax1 = fig.add_subplot(gs[0])
    ax1_twin = ax1.twinx()

    line1, = ax1.plot(ticks, metrics.queue_depth, color=colors['queue'], linewidth=1.5, label='Queue Depth')
    line2, = ax1_twin.plot(ticks, metrics.worker_count, color=colors['workers'], linewidth=1.5, label='Worker Count')

    ax1.set_ylabel('Queue Depth', color=colors['queue'])
    ax1_twin.set_ylabel('Worker Count', color=colors['workers'])
    ax1.tick_params(axis='y', labelcolor=colors['queue'])
    ax1_twin.tick_params(axis='y', labelcolor=colors['workers'])
    ax1.set_title('Queue Depth & Worker Count (Shared Time Axis)')
    ax1.legend([line1, line2], ['Queue Depth', 'Worker Count'], loc='upper left')
    ax1.grid(True, alpha=0.3)

    # 标记事件
    for warning in metrics.warnings[:5]:  # 只显示前5个
        if 'queue' in warning['type']:
            ax1.axvline(x=warning['tick'], color='red', alpha=0.3, linestyle='--')

    # === 图2: CPU & Oscillation ===
    ax2 = fig.add_subplot(gs[1])
    ax2_twin = ax2.twinx()

    line3, = ax2.plot(ticks, metrics.cpu_usage, color=colors['cpu'], linewidth=1.5, label='CPU Usage')
    line4, = ax2_twin.plot(ticks, metrics.oscillation_score, color=colors['oscillation'], linewidth=1.5, label='Oscillation')

    ax2.set_ylabel('CPU Usage', color=colors['cpu'])
    ax2_twin.set_ylabel('Oscillation Score', color=colors['oscillation'])
    ax2.tick_params(axis='y', labelcolor=colors['cpu'])
    ax2_twin.tick_params(axis='y', labelcolor=colors['oscillation'])
    ax2.set_title('CPU Usage & Oscillation Score')
    ax2.legend([line3, line4], ['CPU Usage', 'Oscillation'], loc='upper left')
    ax2.grid(True, alpha=0.3)
    ax2.set_ylim(0, 1.1)

    # === 图3: Worker Churn & Control Energy ===
    ax3 = fig.add_subplot(gs[2])
    ax3_twin = ax3.twinx()

    line5, = ax3.plot(ticks, metrics.worker_churn, color=colors['churn'], linewidth=1.5, label='Worker Churn Rate')
    line6, = ax3_twin.plot(ticks, metrics.control_energy, color=colors['control_energy'], linewidth=1.5, label='Control Energy')

    ax3.set_ylabel('Worker Churn Rate', color=colors['churn'])
    ax3_twin.set_ylabel('Control Energy', color=colors['control_energy'])
    ax3.tick_params(axis='y', labelcolor=colors['churn'])
    ax3_twin.tick_params(axis='y', labelcolor=colors['control_energy'])
    ax3.set_title('Worker Churn & Control Energy')
    ax3.legend([line5, line6], ['Worker Churn', 'Control Energy'], loc='upper left')
    ax3.grid(True, alpha=0.3)

    # === 图4: Action Timeline ===
    ax4 = fig.add_subplot(gs[3])

    # 创建动作颜色映射
    action_map = {'spawn_worker': 1, 'reduce_workers': -1, 'no_op': 0, 'enable_reflection': 0.5, 'disable_reflection': -0.5}
    action_values = [action_map.get(a, 0) for a in metrics.actions]

    ax4.bar(ticks, action_values, width=1, color=['green' if v > 0 else 'red' if v < 0 else 'gray' for v in action_values], alpha=0.6)
    ax4.set_ylabel('Action')
    ax4.set_xlabel('Tick')
    ax4.set_title('Governor Actions (Green=Spawn, Red=Reduce, Gray=NoOp)')
    ax4.set_yticks([-1, 0, 1])
    ax4.set_yticklabels(['Reduce', 'NoOp', 'Spawn'])
    ax4.grid(True, alpha=0.3, axis='x')

    # 标记 Cooldown 阻塞区域
    if metrics.blocked_actions and max(metrics.blocked_actions) > 0:
        ax4_twin = ax4.twinx()
        ax4_twin.plot(ticks, metrics.blocked_actions, color='purple', linewidth=1, alpha=0.5, label='Cooldown Blocked (Cumulative)')
        ax4_twin.set_ylabel('Cooldown Blocked (Cumulative)', color='purple')

    # 总标题
    fig.suptitle(title, fontsize=16, fontweight='bold')

    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    print(f"[Dashboard] 图表已保存: {output_path}")
    plt.close()


def plot_stability_curve(experiments: List[Dict[str, Any]], output_path: str):
    """
    绘制稳定性曲线

    X轴: cooldown_ticks
    Y轴: oscillation_score, final_queue, recovery_half_life, control_energy
    """
    if not HAS_MATPLOTLIB:
        print("[Dashboard] matplotlib 未安装，跳过绘图")
        return

    if not experiments:
        print("[Dashboard] 无实验数据")
        return

    plt.rcParams['font.sans-serif'] = ['Microsoft YaHei', 'SimHei', 'Arial Unicode MS']
    plt.rcParams['axes.unicode_minus'] = False

    fig, axes = plt.subplots(2, 2, figsize=(14, 10))

    # 提取数据
    cooldowns = [e['cooldown'] for e in experiments]
    oscillations = [e['oscillation_score'] for e in experiments]
    final_queues = [e['final_queue'] for e in experiments]
    recovery_times = [e['recovery_half_life'] for e in experiments]
    control_energies = [e['control_energy'] for e in experiments]

    # 图1: Oscillation Score
    axes[0, 0].plot(cooldowns, oscillations, 'o-', color='#C73E1D', linewidth=2, markersize=8)
    axes[0, 0].set_xlabel('Cooldown Ticks')
    axes[0, 0].set_ylabel('Oscillation Score')
    axes[0, 0].set_title('Stability: Oscillation vs Cooldown')
    axes[0, 0].grid(True, alpha=0.3)
    axes[0, 0].set_ylim(0, max(oscillations) * 1.1 if oscillations else 1)

    # 图2: Final Queue
    axes[0, 1].plot(cooldowns, final_queues, 'o-', color='#2E86AB', linewidth=2, markersize=8)
    axes[0, 1].set_xlabel('Cooldown Ticks')
    axes[0, 1].set_ylabel('Final Queue')
    axes[0, 1].set_title('Responsiveness: Final Queue vs Cooldown')
    axes[0, 1].grid(True, alpha=0.3)

    # 图3: Recovery Half-Life
    axes[1, 0].plot(cooldowns, recovery_times, 'o-', color='#F18F01', linewidth=2, markersize=8)
    axes[1, 0].set_xlabel('Cooldown Ticks')
    axes[1, 0].set_ylabel('Recovery Half-Life (ticks)')
    axes[1, 0].set_title('Recovery Dynamics: Half-Life vs Cooldown')
    axes[1, 0].grid(True, alpha=0.3)

    # 图4: Control Energy
    axes[1, 1].plot(cooldowns, control_energies, 'o-', color='#44AF69', linewidth=2, markersize=8)
    axes[1, 1].set_xlabel('Cooldown Ticks')
    axes[1, 1].set_ylabel('Control Energy')
    axes[1, 1].set_title('Control Effort: Energy vs Cooldown')
    axes[1, 1].grid(True, alpha=0.3)

    # 标记临界点
    # 找到 oscillation 开始快速下降的点
    if len(oscillations) > 2:
        for i in range(1, len(oscillations) - 1):
            if oscillations[i] < oscillations[i-1] * 0.5 and oscillations[i] < oscillations[i+1]:
                axes[0, 0].axvline(x=cooldowns[i], color='red', linestyle='--', alpha=0.5)
                axes[0, 1].axvline(x=cooldowns[i], color='red', linestyle='--', alpha=0.5)
                break

    fig.suptitle('Runtime Stability Curve: Cooldown Sweep Experiment', fontsize=14, fontweight='bold')
    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    print(f"[Dashboard] 稳定性曲线已保存: {output_path}")
    plt.close()


def print_dashboard_text(metrics: TimelineMetrics, title: str = "Runtime Dynamics Dashboard"):
    """文本模式 Dashboard（无 matplotlib）"""
    print("=" * 70)
    print(f"{title}")
    print("=" * 70)

    if not metrics.ticks:
        print("无数据")
        return

    print(f"\n[基本信息]")
    print(f"  总 ticks: {len(metrics.ticks)}")
    print(f"  时间范围: tick {metrics.ticks[0]} ~ {metrics.ticks[-1]}")

    print(f"\n[队列统计]")
    print(f"  最小: {min(metrics.queue_depth)}")
    print(f"  最大: {max(metrics.queue_depth)}")
    print(f"  最终: {metrics.queue_depth[-1]}")
    print(f"  平均: {sum(metrics.queue_depth) / len(metrics.queue_depth):.1f}")

    print(f"\n[Worker 统计]")
    print(f"  最小: {min(metrics.worker_count)}")
    print(f"  最大: {max(metrics.worker_count)}")
    print(f"  最终: {metrics.worker_count[-1]}")
    print(f"  平均: {sum(metrics.worker_count) / len(metrics.worker_count):.1f}")

    print(f"\n[振荡指标]")
    avg_osc = sum(metrics.oscillation_score) / len(metrics.oscillation_score)
    print(f"  平均振荡分数: {avg_osc:.4f}")
    print(f"  最终振荡分数: {metrics.oscillation_score[-1]:.4f}")

    print(f"\n[控制能量]")
    print(f"  最终控制能量: {metrics.control_energy[-1]:.0f}")

    print(f"\n[动作统计]")
    action_counts = {}
    for action in metrics.actions:
        action_counts[action] = action_counts.get(action, 0) + 1
    for action, count in sorted(action_counts.items()):
        print(f"  {action}: {count}")

    print(f"\n[Cooldown 阻塞]")
    print(f"  累计阻塞次数: {metrics.blocked_actions[-1] if metrics.blocked_actions else 0}")

    print(f"\n[警告事件]")
    print(f"  总数: {len(metrics.warnings)}")
    for w in metrics.warnings[:5]:
        print(f"    tick={w['tick']}: {w['type']} ({w['severity']})")

    # 因果分析
    causal = detect_causal_chain(metrics)
    print(f"\n[因果动力学分析]")
    print(f"  稳定性 Regime: {causal['stability_regime']}")
    if causal['queue_to_worker_lag'] is not None:
        print(f"  Queue→Worker 延迟: {causal['queue_to_worker_lag']} ticks")
    if causal['cooldown_effectiveness'] is not None:
        print(f"  Cooldown 阻塞率: {causal['cooldown_effectiveness']*100:.1f}%")


def main():
    """主函数"""
    parser = argparse.ArgumentParser(description="Runtime Dynamics Dashboard")
    parser.add_argument("command", choices=["visualize", "analyze", "stability-curve"],
                        help="命令: visualize(可视化), analyze(分析), stability-curve(稳定性曲线)")
    parser.add_argument("files", nargs="+", help="时间线文件路径")
    parser.add_argument("--output", "-o", default="dashboard.png", help="输出文件路径")
    parser.add_argument("--title", "-t", default="Runtime Dynamics Dashboard", help="图表标题")

    args = parser.parse_args()

    if args.command == "visualize" or args.command == "analyze":
        for filepath in args.files:
            if not os.path.exists(filepath):
                print(f"[Dashboard] 文件不存在: {filepath}")
                continue

            print(f"\n处理: {filepath}")
            metrics = load_timeline(filepath)

            if args.command == "visualize":
                if HAS_MATPLOTLIB:
                    output = args.output if len(args.files) == 1 else f"{os.path.splitext(os.path.basename(filepath))[0]}_dashboard.png"
                    plot_dashboard(metrics, output, args.title)
                else:
                    print_dashboard_text(metrics, f"Dashboard: {os.path.basename(filepath)}")
            else:
                print_dashboard_text(metrics, f"Dashboard: {os.path.basename(filepath)}")

            # 因果分析
            causal = detect_causal_chain(metrics)
            print(f"\n[因果动力学分析]")
            for key, value in causal.items():
                print(f"  {key}: {value}")

    elif args.command == "stability-curve":
        # 从多个实验结果绘制稳定性曲线
        experiments = []
        for filepath in args.files:
            # 从文件名解析 cooldown 值
            # 例如: damped_cd20_run123.jsonl
            cooldown = 15  # 默认值
            import re
            match = re.search(r'cd(\d+)', filepath)
            if match:
                cooldown = int(match.group(1))

            metrics = load_timeline(filepath)
            if metrics.ticks:
                experiments.append({
                    'cooldown': cooldown,
                    'oscillation_score': sum(metrics.oscillation_score) / len(metrics.oscillation_score),
                    'final_queue': metrics.queue_depth[-1] if metrics.queue_depth else 0,
                    'recovery_half_life': 0,  # 需要从 stability_metrics 获取
                    'control_energy': metrics.control_energy[-1] if metrics.control_energy else 0,
                })

        # 按 cooldown 排序
        experiments.sort(key=lambda x: x['cooldown'])

        if HAS_MATPLOTLIB:
            plot_stability_curve(experiments, args.output)
        else:
            print("[Dashboard] 需要 matplotlib 绘制稳定性曲线")
            print("\n实验结果汇总:")
            for exp in experiments:
                print(f"  cooldown={exp['cooldown']}: osc={exp['oscillation_score']:.3f}, queue={exp['final_queue']}")


if __name__ == '__main__':
    main()
