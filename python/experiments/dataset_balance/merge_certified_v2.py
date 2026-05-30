# -*- coding: utf-8 -*-
"""
Rebalance dataset for certification
"""

import sys
import os
import json
import random
from collections import Counter

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)


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


def load_entries(path: str) -> list:
    """加载 entries"""
    entries = []
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            entries.append(json.loads(line.strip()))
    return entries


def rebalance():
    """重新平衡数据集"""
    print("=" * 60)
    print("Dataset Rebalance for Certification")
    print("=" * 60)

    # 加载数据集
    print("\nLoading datasets...")
    entries_base = load_entries("datasets/timeline_v3_1.jsonl")
    entries_large = load_entries("datasets/timeline_v3_1_large_cluster.jsonl")
    print(f"  Base: {len(entries_base):,}")
    print(f"  Large cluster: {len(entries_large):,}")

    # 分析当前分布
    ACTION_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}

    zone_base = Counter(get_zone(e["queue_depth"], e["worker_count"]) for e in entries_base)
    action_base = Counter(e["action_index"] for e in entries_base)

    print("\nBase dataset analysis:")
    print("  Zone A:", zone_base.get("A", 0), f"({zone_base.get('A', 0)/len(entries_base):.1%})")
    print("  Zone B:", zone_base.get("B", 0), f"({zone_base.get('B', 0)/len(entries_base):.1%})")
    print("  Zone C:", zone_base.get("C", 0), f"({zone_base.get('C', 0)/len(entries_base):.1%})")
    print("  Zone D:", zone_base.get("D", 0), f"({zone_base.get('D', 0)/len(entries_base):.1%})")
    print("  Zone E:", zone_base.get("E", 0), f"({zone_base.get('E', 0)/len(entries_base):.1%})")

    # 策略：
    # 1. 从基础数据集中采样，减少 Zone A
    # 2. 增加大集群数据集中的比例

    # 目标分布
    target_zones = {"A": 0.15, "B": 0.15, "C": 0.25, "D": 0.25, "E": 0.20}
    target_actions = {"shrink2": 0.25, "shrink1": 0.10, "noop": 0.20, "expand1": 0.20, "expand2": 0.25}

    total_target = 150000

    # 计算每个类别的目标数量
    target_counts = {k: int(total_target * v) for k, v in target_zones.items()}

    # 从大集群数据集中采样（主要包含 Zone D/E）
    large_zone = Counter(get_zone(e["queue_depth"], e["worker_count"]) for e in entries_large)
    print(f"\nLarge cluster Zone D: {large_zone.get('D', 0)}")
    print(f"Large cluster Zone E: {large_zone.get('E', 0)}")

    # 合并策略：
    # - Zone A/B: 主要从基础数据集采样（减少）
    # - Zone C/D/E: 主要从大集群数据集采样

    sampled = []

    # 从基础数据集采样 Zone A/B
    for zone in ["A", "B"]:
        zone_entries = [e for e in entries_base if get_zone(e["queue_depth"], e["worker_count"]) == zone]
        target = int(total_target * target_zones[zone])
        n = min(len(zone_entries), target)
        sampled.extend(random.sample(zone_entries, n))

    # 从大集群数据集采样 Zone C/D/E
    for zone in ["C", "D", "E"]:
        zone_entries = [e for e in entries_large if get_zone(e["queue_depth"], e["worker_count"]) == zone]
        target = int(total_target * target_zones[zone])
        n = min(len(zone_entries), target)
        sampled.extend(random.sample(zone_entries, n))

    random.shuffle(sampled)

    print(f"\nSampled: {len(sampled):,} entries")

    # 分析采样后的分布
    zone_counter = Counter(get_zone(e["queue_depth"], e["worker_count"]) for e in sampled)
    action_counter = Counter(e["action_index"] for e in sampled)

    print("\nAfter rebalance:")
    print("\nZone Distribution:")
    max_zone_gap = 0
    for zone in ["A", "B", "C", "D", "E"]:
        count = zone_counter.get(zone, 0)
        ratio = count / len(sampled)
        target = target_zones[zone]
        gap = abs(ratio - target)
        max_zone_gap = max(max_zone_gap, gap)
        status = "✅" if ratio >= 0.05 else "❌"
        print(f"  Zone {zone}: {count:,} ({ratio:.1%}) target={target:.1%} {status}")

    print("\nAction Distribution:")
    max_action = 0
    for action_id in range(5):
        count = action_counter.get(action_id, 0)
        ratio = count / len(sampled)
        max_action = max(max_action, ratio)
        status = "✅" if ratio <= 0.40 else "❌"
        print(f"  {ACTION_NAMES[action_id]:<8}: {count:,} ({ratio:.1%}) {status}")

    # Worker bucket
    bucket_counter = Counter(get_worker_bucket(e["worker_count"]) for e in sampled)
    print("\nWorker Bucket Distribution:")
    bucket_pass = True
    for bucket in ["1-20", "20-50", "50-100", "100-200", "200+"]:
        count = bucket_counter.get(bucket, 0)
        ratio = count / len(sampled)
        if ratio < 0.05:
            bucket_pass = False
        status = "✅" if ratio >= 0.05 else "❌"
        print(f"  {bucket:<8}: {count:,} ({ratio:.1%}) {status}")

    # 保存
    output_path = "datasets/timeline_v3_1.jsonl"
    with open(output_path, 'w', encoding='utf-8') as f:
        for entry in sampled:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    print(f"\nSaved {len(sampled):,} entries to: {output_path}")

    return {
        "total": len(sampled),
        "max_action_ratio": max_action,
        "bucket_pass": bucket_pass,
    }


if __name__ == "__main__":
    result = rebalance()
