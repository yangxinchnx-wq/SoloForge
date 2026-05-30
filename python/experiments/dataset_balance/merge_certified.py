# -*- coding: utf-8 -*-
"""
Merge datasets for Timeline V3.1 certification
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


def merge_for_certification():
    """合并数据集以满足认证要求"""
    print("=" * 60)
    print("Dataset Merge for Certification")
    print("=" * 60)

    # 加载数据集
    print("\nLoading datasets...")

    # 1. 基础数据集（Teacher V4 生成）
    entries_base = load_entries("datasets/timeline_v3_1.jsonl")
    print(f"  Base dataset: {len(entries_base):,} entries")

    # 2. 大集群数据集
    entries_large = load_entries("datasets/timeline_v3_1_large_cluster.jsonl")
    print(f"  Large cluster: {len(entries_large):,} entries")

    # 目标比例
    # - 基础数据: 70%
    # - 大集群数据: 30%

    target_base_ratio = 0.70
    target_large_ratio = 0.30

    # 计算采样数量
    total_target = 150000  # 目标总数
    target_base = int(total_target * target_base_ratio)
    target_large = int(total_target * target_large_ratio)

    # 采样
    print(f"\nSampling...")
    print(f"  Target base: {target_base:,}")
    print(f"  Target large: {target_large:,}")

    sampled_base = random.sample(entries_base, min(len(entries_base), target_base))
    sampled_large = random.sample(entries_large, min(len(entries_large), target_large))

    # 合并
    merged = sampled_base + sampled_large
    random.shuffle(merged)

    print(f"\nMerged: {len(merged):,} entries")

    # 分析
    ACTION_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}

    # Action 分布
    action_counter = Counter(e["action_index"] for e in merged)
    print("\nAction Distribution:")
    max_action = 0
    for action_id in range(5):
        count = action_counter.get(action_id, 0)
        ratio = count / len(merged)
        max_action = max(max_action, ratio)
        status = "✅" if ratio <= 0.40 else "❌"
        print(f"  {ACTION_NAMES[action_id]:<8}: {count:,} ({ratio:.1%}) {status}")

    # Zone 分布
    zone_counter = Counter(get_zone(e["queue_depth"], e["worker_count"]) for e in merged)
    print("\nZone Distribution:")
    for zone in ["A", "B", "C", "D", "E"]:
        count = zone_counter.get(zone, 0)
        ratio = count / len(merged)
        status = "✅" if ratio >= 0.05 else "❌"
        print(f"  Zone {zone}: {count:,} ({ratio:.1%}) {status}")

    # Worker bucket 分布
    bucket_counter = Counter(get_worker_bucket(e["worker_count"]) for e in merged)
    print("\nWorker Bucket Distribution:")
    bucket_pass = True
    for bucket in ["1-20", "20-50", "50-100", "100-200", "200+"]:
        count = bucket_counter.get(bucket, 0)
        ratio = count / len(merged)
        status = "✅" if ratio >= 0.05 else "❌"
        if ratio < 0.05:
            bucket_pass = False
        print(f"  {bucket:<8}: {count:,} ({ratio:.1%}) {status}")

    # 保存
    output_path = "datasets/timeline_v3_1.jsonl"
    with open(output_path, 'w', encoding='utf-8') as f:
        for entry in merged:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    print(f"\nSaved {len(merged):,} entries to: {output_path}")

    # 汇总
    print("\n" + "=" * 60)
    print("Certification Status")
    print("=" * 60)

    checks = {
        "Action Distribution (max < 40%)": max_action <= 0.40,
        "Worker Bucket Coverage (each > 5%)": bucket_pass,
    }

    for check, passed in checks.items():
        icon = "✅" if passed else "❌"
        print(f"  {icon} {check}")

    all_pass = all(checks.values())
    print(f"\n{'🎉 READY FOR CERTIFICATION' if all_pass else '❌ NEEDS MORE WORK'}")

    return {
        "total": len(merged),
        "max_action_ratio": max_action,
        "checks": checks,
        "all_pass": all_pass,
    }


if __name__ == "__main__":
    result = merge_for_certification()
