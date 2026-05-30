# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Dataset Rebalancing
# Path: experiments/dataset_balance/rebalance.py
#
# Sprint 3.6: Dataset Rebalancing
# 目标: 根据 Audit 结果重平衡 Timeline V3
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import random
from collections import Counter
from typing import Dict, List, Tuple
import numpy as np

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.training.simulator.teacher_v4 import TeacherV4
from governor_rl.env import RuntimeEnvFactory


# ═══════════════════════════════════════════════════════════════════
# REBALANCING TARGETS
# ═══════════════════════════════════════════════════════════════════

# Action 分布目标: 每个动作不超过 40%
TARGET_ACTION_RATIO = 0.40

# Worker bucket 目标
TARGET_WORKER_BUCKETS = {
    "1-20": 0.15,    # 减少
    "20-50": 0.20,
    "50-100": 0.25,
    "100-200": 0.25,  # 增加
    "200+": 0.15,     # 增加
}

# Zone 分布目标
TARGET_ZONE_RATIO = {
    "A": 0.15,  # 大幅减少
    "B": 0.15,
    "C": 0.25,
    "D": 0.25,
    "E": 0.20,
}


def get_zone(queue_depth: int, worker_count: int = 200) -> str:
    """获取 Zone (基于 load_ratio)"""
    capacity = worker_count * 2
    load_ratio = queue_depth / max(1, capacity)

    if load_ratio < 0.1:
        return "A"
    elif load_ratio < 0.25:
        return "B"
    elif load_ratio < 0.5:
        return "C"
    elif load_ratio < 1.0:
        return "D"
    else:
        return "E"


def get_worker_bucket(worker_count: int) -> str:
    """获取 worker bucket"""
    if worker_count <= 20:
        return "1-20"
    elif worker_count <= 50:
        return "20-50"
    elif worker_count <= 100:
        return "50-100"
    elif worker_count <= 200:
        return "100-200"
    else:
        return "200+"


def load_timeline(timeline_path: str) -> List[Dict]:
    """加载 Timeline"""
    entries = []
    with open(timeline_path, 'r', encoding='utf-8') as f:
        for line in f:
            data = json.loads(line.strip())
            entries.append(data)
    return entries


def analyze_current_distribution(entries: List[Dict]) -> Dict:
    """分析当前分布"""
    action_counter = Counter()
    zone_counter = Counter()
    worker_bucket_counter = Counter()

    for entry in entries:
        # Action
        action_index = entry.get("action_index", 2)
        action_counter[action_index] += 1

        # Zone
        queue_depth = entry.get("queue_depth", 0)
        worker_count = entry.get("worker_count", 200)
        zone = get_zone(queue_depth, worker_count)
        zone_counter[zone] += 1

        # Worker bucket
        bucket = get_worker_bucket(worker_count)
        worker_bucket_counter[bucket] += 1

    total = len(entries)

    return {
        "action_distribution": {k: v / total for k, v in action_counter.items()},
        "zone_distribution": {k: v / total for k, v in zone_counter.items()},
        "worker_distribution": {k: v / total for k, v in worker_bucket_counter.items()},
    }


def sample_entries_by_worker_bucket(
    entries: List[Dict],
    target_ratios: Dict[str, float],
    total_target: int = None
) -> List[Dict]:
    """
    按 worker bucket 重新采样

    Args:
        entries: 原始 entries
        target_ratios: 目标 bucket 分布
        total_target: 目标总数

    Returns:
        重新采样后的 entries
    """
    # 按 bucket 分组
    buckets = {name: [] for name in target_ratios.keys()}
    buckets["other"] = []

    for entry in entries:
        worker_count = entry.get("worker_count", 200)
        bucket = get_worker_bucket(worker_count)

        if bucket in buckets:
            buckets[bucket].append(entry)
        else:
            buckets["other"].append(entry)

    # 计算每个 bucket 的目标数量
    if total_target is None:
        total_target = len(entries)

    target_counts = {
        name: int(total_target * ratio)
        for name, ratio in target_ratios.items()
    }

    # 调整以确保总数正确
    current_total = sum(target_counts.values())
    diff = total_target - current_total
    if diff != 0:
        # 分配给最大的 bucket
        max_bucket = max(target_counts.items(), key=lambda x: x[1])
        target_counts[max_bucket[0]] += diff

    # 采样
    sampled = []
    for bucket_name, target_count in target_counts.items():
        available = buckets.get(bucket_name, [])
        if len(available) >= target_count:
            # 随机采样
            sampled.extend(random.sample(available, target_count))
        else:
            # 不够，随机复制一些
            sampled.extend(available)
            remaining = target_count - len(available)
            if remaining > 0 and available:
                sampled.extend(random.choices(available, k=remaining))

    return sampled


def run_episode(
    arrival_rate: float,
    burst_prob: float,
    duration: int,
    seed: int = None,
    initial_workers: int = 200,
) -> List[Dict]:
    """运行单个 episode"""
    if seed is not None:
        np.random.seed(seed)
        random.seed(seed)

    # 创建环境
    env = RuntimeEnvFactory.create(
        arrival_rate=arrival_rate,
        burst_prob=burst_prob,
        duration=duration,
    )

    # 设置初始 worker count
    env.simulator.state.worker_count = initial_workers

    # 创建 Teacher V4
    teacher = TeacherV4()

    obs, _ = env.reset(seed=seed if seed else None)
    timeline = []

    # 跳过 warmup
    warmup_ticks = 20

    for tick in range(duration):
        # 获取当前状态
        state = env.simulator.state
        queue_depth = state.queue_depth
        worker_count = state.worker_count
        cpu_usage = state.cpu_usage

        # Teacher V4 决策
        action_value = teacher.decide(
            queue_depth=queue_depth,
            worker_count=worker_count,
        )

        # 转换为 action_index
        ACTION_VALUE_TO_INDEX = {-2: 0, -1: 1, 0: 2, 1: 3, 2: 4}
        action_index = ACTION_VALUE_TO_INDEX[action_value]

        # 执行动作
        next_obs, _, done, _, info = env.step(action_index)

        # 跳过 warmup
        if tick >= warmup_ticks:
            zone = get_zone(queue_depth, worker_count)
            bucket = get_worker_bucket(worker_count)

            entry = {
                "tick": tick,
                "queue_depth": queue_depth,
                "worker_count": worker_count,
                "cpu_usage": cpu_usage,
                "action_index": action_index,
                "action_value": action_value,
                "zone": zone,
                "worker_bucket": bucket,
            }
            timeline.append(entry)

        obs = next_obs
        if done:
            break

    return timeline


def collect_balanced_timeline(
    output_path: str = "datasets/timeline_v3_1.jsonl",
    target_entries: int = 120000,
) -> Dict:
    """
    收集平衡的 Timeline

    策略:
    1. 使用新的场景配置，针对性地覆盖薄弱区域
    2. 采样时按 worker bucket 重新分配
    """
    print("=" * 60)
    print("Collecting Balanced Timeline V3.1")
    print("=" * 60)

    # 新场景配置：增加 high worker count 场景
    scenarios = [
        # Zone E 场景 (高负载) - 使用高初始 worker count
        {"name": "zone_e_crisis_1", "arrival_rate": 30.0, "burst_prob": 0.6, "initial_workers": 200, "episodes": 5},
        {"name": "zone_e_crisis_2", "arrival_rate": 35.0, "burst_prob": 0.7, "initial_workers": 200, "episodes": 5},
        {"name": "zone_e_overload", "arrival_rate": 40.0, "burst_prob": 0.7, "initial_workers": 250, "episodes": 5},

        # Zone D 场景 (中负载)
        {"name": "zone_d_heavy_1", "arrival_rate": 15.0, "burst_prob": 0.3, "initial_workers": 150, "episodes": 5},
        {"name": "zone_d_heavy_2", "arrival_rate": 20.0, "burst_prob": 0.4, "initial_workers": 150, "episodes": 5},
        {"name": "zone_d_stress", "arrival_rate": 25.0, "burst_prob": 0.5, "initial_workers": 180, "episodes": 5},

        # Zone C 场景 (稳定)
        {"name": "zone_c_balanced_1", "arrival_rate": 8.0, "burst_prob": 0.2, "initial_workers": 100, "episodes": 4},
        {"name": "zone_c_balanced_2", "arrival_rate": 10.0, "burst_prob": 0.25, "initial_workers": 120, "episodes": 4},

        # Zone B 场景 (低负载)
        {"name": "zone_b_light_1", "arrival_rate": 3.0, "burst_prob": 0.1, "initial_workers": 50, "episodes": 3},
        {"name": "zone_b_light_2", "arrival_rate": 4.0, "burst_prob": 0.15, "initial_workers": 60, "episodes": 3},

        # Zone A 场景 (空闲) - 减少
        {"name": "zone_a_idle_1", "arrival_rate": 0.5, "burst_prob": 0.0, "initial_workers": 30, "episodes": 2},
        {"name": "zone_a_idle_2", "arrival_rate": 1.0, "burst_prob": 0.05, "initial_workers": 40, "episodes": 2},

        # Recovery 场景
        {"name": "recovery_e_to_d", "arrival_rate": 15.0, "burst_prob": 0.5, "initial_workers": 200, "episodes": 4},
        {"name": "recovery_d_to_c", "arrival_rate": 8.0, "burst_prob": 0.3, "initial_workers": 150, "episodes": 4},
        {"name": "recovery_c_to_b", "arrival_rate": 4.0, "burst_prob": 0.2, "initial_workers": 100, "episodes": 3},
    ]

    all_entries = []

    for scenario in scenarios:
        print(f"\n[{scenario['name']}] arrival={scenario['arrival_rate']}, burst={scenario['burst_prob']}, workers={scenario['initial_workers']}")

        for ep in range(scenario["episodes"]):
            seed = abs(hash(scenario["name"] + str(ep))) % (2**31)

            timeline = run_episode(
                arrival_rate=scenario["arrival_rate"],
                burst_prob=scenario["burst_prob"],
                duration=2000,
                seed=seed,
                initial_workers=scenario["initial_workers"],
            )

            for entry in timeline:
                entry["scenario"] = scenario["name"]
                entry["episode"] = ep
                all_entries.append(entry)

        print(f"  Episodes {scenario['episodes']}: {scenario['episodes'] * 1980} entries")

    # 分析原始分布
    original_dist = analyze_current_distribution(all_entries)

    print(f"\n{'='*60}")
    print("Original Distribution (before rebalancing)")
    print("="*60)

    print("\nAction Distribution:")
    ACTION_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}
    for action_id in range(5):
        ratio = original_dist["action_distribution"].get(action_id, 0)
        status = "❌" if ratio > TARGET_ACTION_RATIO else "✅"
        print(f"  {ACTION_NAMES[action_id]:<8}: {ratio:.1%} {status}")

    print("\nWorker Bucket Distribution:")
    for bucket in ["1-20", "20-50", "50-100", "100-200", "200+"]:
        ratio = original_dist["worker_distribution"].get(bucket, 0)
        target = TARGET_WORKER_BUCKETS[bucket]
        status = "✅" if ratio >= target * 0.8 else "⚠️"
        print(f"  {bucket:<8}: {ratio:.1%} (target: {target:.1%}) {status}")

    # 重新采样以达到目标分布
    print(f"\n{'='*60}")
    print("Rebalancing...")
    print("="*60)

    sampled = sample_entries_by_worker_bucket(
        all_entries,
        TARGET_WORKER_BUCKETS,
        total_target=min(target_entries, len(all_entries))
    )

    # 分析重采样后的分布
    after_dist = analyze_current_distribution(sampled)

    print("\nAfter Rebalancing:")
    print("\nAction Distribution:")
    max_action_ratio = 0
    for action_id in range(5):
        ratio = after_dist["action_distribution"].get(action_id, 0)
        max_action_ratio = max(max_action_ratio, ratio)
        status = "❌" if ratio > TARGET_ACTION_RATIO else "✅"
        print(f"  {ACTION_NAMES[action_id]:<8}: {ratio:.1%} {status}")

    print(f"\nMax Action Ratio: {max_action_ratio:.1%}")

    print("\nWorker Bucket Distribution:")
    for bucket in ["1-20", "20-50", "50-100", "100-200", "200+"]:
        ratio = after_dist["worker_distribution"].get(bucket, 0)
        target = TARGET_WORKER_BUCKETS[bucket]
        status = "✅" if ratio >= target * 0.8 else "❌"
        print(f"  {bucket:<8}: {ratio:.1%} (target: {target:.1%}) {status}")

    # 保存
    output_dir = os.path.dirname(output_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    with open(output_path, 'w', encoding='utf-8') as f:
        for entry in sampled:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    print(f"\nSaved {len(sampled)} entries to: {output_path}")

    return {
        "original_entries": len(all_entries),
        "sampled_entries": len(sampled),
        "original_distribution": original_dist,
        "after_distribution": after_dist,
        "max_action_ratio": max_action_ratio,
        "pass": max_action_ratio <= TARGET_ACTION_RATIO,
    }


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="Dataset Rebalancing")
    parser.add_argument("--input", type=str, default="datasets/timeline_v3.jsonl")
    parser.add_argument("--output", type=str, default="datasets/timeline_v3_1.jsonl")
    parser.add_argument("--target", type=int, default=120000)

    args = parser.parse_args()

    result = collect_balanced_timeline(
        output_path=args.output,
        target_entries=args.target,
    )

    print("\n" + "=" * 60)
    if result["pass"]:
        print("🎉 Rebalancing Complete - Timeline V3.1 Ready")
    else:
        print("⚠️ Rebalancing Complete - Max Action Ratio Still High")
    print("=" * 60)


if __name__ == "__main__":
    main()
