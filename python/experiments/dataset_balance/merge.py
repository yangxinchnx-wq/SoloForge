# -*- coding: utf-8 -*-
"""
Merge datasets for Timeline V3.1
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


def merge_and_sample():
    """合并数据集"""
    print("=" * 60)
    print("Merging Datasets for Timeline V3.1")
    print("=" * 60)

    # 加载两个数据集
    print("\nLoading datasets...")
    entries1 = load_entries("datasets/timeline_v3_1.jsonl")
    entries2 = load_entries("datasets/timeline_v3_1_high_worker.jsonl")

    print(f"  Timeline V3.1: {len(entries1):,} entries")
    print(f"  High Worker: {len(entries2):,} entries")

    # 分析 bucket 分布
    bucket1 = Counter(get_worker_bucket(e["worker_count"]) for e in entries1)
    bucket2 = Counter(get_worker_bucket(e["worker_count"]) for e in entries2)

    print("\nBefore merge:")
    print("  Timeline V3.1:")
    for bucket in ["1-20", "20-50", "50-100", "100-200", "200+"]:
        print(f"    {bucket}: {bucket1.get(bucket, 0):,}")

    print("  High Worker:")
    for bucket in ["1-20", "20-50", "50-100", "100-200", "200+"]:
        print(f"    {bucket}: {bucket2.get(bucket, 0):,}")

    # 合并
    merged = entries1 + entries2

    # 分析合并后的 bucket 分布
    bucket_merged = Counter(get_worker_bucket(e["worker_count"]) for e in merged)
    total = len(merged)

    print("\nAfter merge:")
    for bucket in ["1-20", "20-50", "50-100", "100-200", "200+"]:
        count = bucket_merged.get(bucket, 0)
        ratio = count / total if total > 0 else 0
        print(f"  {bucket}: {count:,} ({ratio:.1%})")

    # 随机打乱
    random.shuffle(merged)

    # 保存
    output_path = "datasets/timeline_v3_1.jsonl"
    with open(output_path, 'w', encoding='utf-8') as f:
        for entry in merged:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    print(f"\nSaved {len(merged):,} entries to: {output_path}")

    # 分析 action 分布
    action_counter = Counter(e["action_index"] for e in merged)
    ACTION_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}

    print("\nAction Distribution:")
    max_ratio = 0
    for action_id in range(5):
        count = action_counter.get(action_id, 0)
        ratio = count / total if total > 0 else 0
        max_ratio = max(max_ratio, ratio)
        status = "✅" if ratio <= 0.40 else "❌"
        print(f"  {ACTION_NAMES[action_id]:<8}: {count:,} ({ratio:.1%}) {status}")

    print(f"\nMax Action Ratio: {max_ratio:.1%}")
    print(f"Action Balance: {'✅ PASS' if max_ratio <= 0.40 else '❌ FAIL'}")

    return {
        "total": len(merged),
        "max_action_ratio": max_ratio,
    }


if __name__ == "__main__":
    result = merge_and_sample()
