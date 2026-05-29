# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Timeline Replay: 时间线重放验证
# Path: python/training/simulator/timeline_replay.py
#
# 核心功能：
# 1. 验证时间线可重放性
# 2. 分析时间线统计信息
# 3. 可视化时间线数据
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
from typing import Dict, Any, List, Optional
from dataclasses import asdict

# 设置 UTF-8 输出
sys.stdout.reconfigure(encoding='utf-8')

# 添加项目根目录到路径
script_dir = os.path.dirname(os.path.abspath(__file__))
training_dir = os.path.dirname(script_dir)
python_dir = os.path.dirname(training_dir)
sys.path.insert(0, python_dir)

from training.simulator.timeline_recorder import RuntimeTimelineRecorder


def analyze_timeline(filepath: str) -> Dict[str, Any]:
    """
    分析时间线文件

    Returns:
        分析结果字典
    """
    if not os.path.exists(filepath):
        print(f"[Replay] 文件不存在: {filepath}")
        return {}

    recorder = RuntimeTimelineRecorder()
    if not recorder.load(filepath):
        print(f"[Replay] 加载失败: {filepath}")
        return {}

    # 基础统计
    stats = {
        "filepath": filepath,
        "total_entries": len(recorder.entries),
        "duration_ticks": recorder.entries[-1].tick - recorder.entries[0].tick if recorder.entries else 0,
        "start_tick": recorder.entries[0].tick if recorder.entries else 0,
        "end_tick": recorder.entries[-1].tick if recorder.entries else 0,
        "metadata": recorder.metadata,
    }

    # 动作统计
    action_counts = {}
    intent_counts = {}
    for entry in recorder.entries:
        action_type = entry.action.type
        action_intent = entry.action.intent
        action_counts[action_type] = action_counts.get(action_type, 0) + 1
        intent_counts[action_intent] = intent_counts.get(action_intent, 0) + 1

    stats["action_counts"] = action_counts
    stats["intent_counts"] = intent_counts

    # 事件统计
    event_counts = {}
    for entry in recorder.entries:
        for event in entry.events:
            event_counts[event.type] = event_counts.get(event.type, 0) + 1

    stats["event_counts"] = event_counts

    # 派生指标统计
    if recorder.entries:
        osc_scores = [e.derived_metrics.oscillation_score for e in recorder.entries]
        churn_rates = [e.derived_metrics.worker_churn_rate for e in recorder.entries]
        action_freqs = [e.derived_metrics.action_frequency for e in recorder.entries]

        stats["metrics"] = {
            "oscillation_score": {"avg": sum(osc_scores) / len(osc_scores), "final": osc_scores[-1]},
            "worker_churn_rate": {"avg": sum(churn_rates) / len(churn_rates), "final": churn_rates[-1]},
            "action_frequency": {"avg": sum(action_freqs) / len(action_freqs), "final": action_freqs[-1]},
        }

        # 队列统计
        queues = [e.state.queue_depth for e in recorder.entries]
        workers = [e.state.worker_count for e in recorder.entries]
        stats["queue"] = {"min": min(queues), "max": max(queues), "avg": sum(queues) / len(queues)}
        stats["workers"] = {"min": min(workers), "max": max(workers), "avg": sum(workers) / len(workers)}

    return stats


def verify_determinism(filepath: str) -> bool:
    """
    验证时间线确定性

    检查：
    1. random_seed 是否记录
    2. 每次 tick 的 state 是否可重现
    """
    recorder = RuntimeTimelineRecorder()
    if not recorder.load(filepath):
        return False

    # 检查随机种子
    if recorder.metadata.get("random_seed") is None:
        print("[Determinism] ⚠️  警告: 未记录 random_seed")
        return False

    print(f"[Determinism] ✅ random_seed={recorder.metadata['random_seed']}")

    # 检查配置
    if not recorder.metadata.get("workload_config"):
        print("[Determinism] ⚠️  警告: 未记录 workload_config")
    else:
        print(f"[Determinism] ✅ workload_config 已记录")

    if not recorder.metadata.get("governor_config"):
        print("[Determinism] ⚠️  警告: 未记录 governor_config")
    else:
        print(f"[Determinism] ✅ governor_config 已记录")

    return True


def replay_timeline(filepath: str, max_ticks: int = None) -> List[Dict[str, Any]]:
    """
    重放时间线，返回每一步的状态快照

    Args:
        filepath: 时间线文件路径
        max_ticks: 最大重放步数

    Returns:
        重放状态列表
    """
    recorder = RuntimeTimelineRecorder()
    if not recorder.load(filepath):
        return []

    snapshots = []
    for entry in recorder.replay(end_tick=max_ticks):
        snapshot = {
            "tick": entry.tick,
            "timestamp": entry.timestamp,
            "state": asdict(entry.state),
            "action": asdict(entry.action),
            "derived_metrics": {
                "oscillation_score": entry.derived_metrics.oscillation_score,
                "worker_churn_rate": entry.derived_metrics.worker_churn_rate,
            },
            "events": [asdict(e) for e in entry.events],
        }
        snapshots.append(snapshot)

    return snapshots


def compare_timelines(file1: str, file2: str) -> Dict[str, Any]:
    """
    对比两个时间线

    Returns:
        对比结果
    """
    stats1 = analyze_timeline(file1)
    stats2 = analyze_timeline(file2)

    if not stats1 or not stats2:
        return {"error": "无法加载时间线文件"}

    comparison = {
        "file1": os.path.basename(file1),
        "file2": os.path.basename(file2),
        "duration_ticks": stats1["duration_ticks"] == stats2["duration_ticks"],
        "total_entries_match": stats1["total_entries"] == stats2["total_entries"],
    }

    # 动作对比
    comparison["action_comparison"] = {}
    for action_type in set(list(stats1["action_counts"].keys()) + list(stats2["action_counts"].keys())):
        count1 = stats1["action_counts"].get(action_type, 0)
        count2 = stats2["action_counts"].get(action_type, 0)
        comparison["action_comparison"][action_type] = {"zero": count1, "damped": count2, "diff": count2 - count1}

    # 指标对比
    if "metrics" in stats1 and "metrics" in stats2:
        comparison["metrics_comparison"] = {}
        for metric in ["oscillation_score", "worker_churn_rate", "action_frequency"]:
            if metric in stats1["metrics"] and metric in stats2["metrics"]:
                val1 = stats1["metrics"][metric]["avg"]
                val2 = stats2["metrics"][metric]["avg"]
                improvement = ((val1 - val2) / val1 * 100) if val1 > 0 else 0
                comparison["metrics_comparison"][metric] = {
                    "zero": round(val1, 4),
                    "damped": round(val2, 4),
                    "improvement_pct": round(improvement, 1),
                }

    return comparison


def print_analysis(filepath: str):
    """打印时间线分析结果"""
    print("=" * 60)
    print(f"时间线分析: {os.path.basename(filepath)}")
    print("=" * 60)

    stats = analyze_timeline(filepath)
    if not stats:
        return

    print(f"\n基本信息:")
    print(f"  总条目: {stats['total_entries']}")
    print(f"  持续 ticks: {stats['duration_ticks']}")
    print(f"  起始 tick: {stats['start_tick']}")
    print(f"  结束 tick: {stats['end_tick']}")

    print(f"\n配置:")
    print(f"  random_seed: {stats['metadata'].get('random_seed', 'N/A')}")
    print(f"  arrival_rate: {stats['metadata'].get('workload_config', {}).get('base_arrival_rate', 'N/A')}")

    print(f"\n动作统计:")
    for action, count in stats['action_counts'].items():
        print(f"  {action}: {count}")

    print(f"\n事件统计:")
    for event, count in stats.get('event_counts', {}).items():
        print(f"  {event}: {count}")

    if "metrics" in stats:
        print(f"\n派生指标 (平均值):")
        print(f"  振荡分数: {stats['metrics']['oscillation_score']['avg']:.4f}")
        print(f"  Worker变更率: {stats['metrics']['worker_churn_rate']['avg']:.4f}")
        print(f"  动作频率: {stats['metrics']['action_frequency']['avg']:.4f}")

        print(f"\n队列状态:")
        print(f"  最小: {stats['queue']['min']}")
        print(f"  最大: {stats['queue']['max']}")
        print(f"  平均: {stats['queue']['avg']:.1f}")

        print(f"\nWorker 状态:")
        print(f"  最小: {stats['workers']['min']}")
        print(f"  最大: {stats['workers']['max']}")
        print(f"  平均: {stats['workers']['avg']:.1f}")


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="Timeline Replay 工具")
    parser.add_argument("command", choices=["analyze", "verify", "replay", "compare"],
                        help="命令: analyze(分析), verify(验证), replay(重放), compare(对比)")
    parser.add_argument("files", nargs="+", help="时间线文件路径")
    parser.add_argument("--max-ticks", type=int, default=None, help="最大重放步数")

    args = parser.parse_args()

    if args.command == "analyze":
        for filepath in args.files:
            print_analysis(filepath)
            print()

    elif args.command == "verify":
        for filepath in args.files:
            print(f"\n验证确定性: {filepath}")
            verify_determinism(filepath)

    elif args.command == "replay":
        for filepath in args.files:
            print(f"\n重放时间线: {filepath}")
            snapshots = replay_timeline(filepath, args.max_ticks)
            print(f"  重放 {len(snapshots)} 条记录")
            if snapshots:
                print(f"  第一条: tick={snapshots[0]['tick']}, queue={snapshots[0]['state']['queue_depth']}")
                print(f"  最后条: tick={snapshots[-1]['tick']}, queue={snapshots[-1]['state']['queue_depth']}")

    elif args.command == "compare":
        if len(args.files) != 2:
            print("错误: compare 需要 2 个时间线文件")
            return
        comparison = compare_timelines(args.files[0], args.files[1])
        print("\n对比结果:")
        print(f"  文件1: {comparison['file1']}")
        print(f"  文件2: {comparison['file2']}")
        print(f"  持续时间一致: {comparison['duration_ticks']}")
        print(f"  条目数一致: {comparison['total_entries_match']}")
        if "metrics_comparison" in comparison:
            print("\n指标对比:")
            for metric, data in comparison["metrics_comparison"].items():
                print(f"  {metric}: zero={data['zero']}, damped={data['damped']}, 改善={data['improvement_pct']}%")


if __name__ == '__main__':
    main()
