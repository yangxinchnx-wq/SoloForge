# -*- coding: utf-8 -*-
"""
Final merge for Timeline V3.1 with recovery focus
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


def merge_with_recovery_focus():
    """合并数据集，增加 recovery 权重"""
    print("=" * 60)
    print("Final Merge with Recovery Focus")
    print("=" * 60)

    # 加载数据集
    print("\nLoading datasets...")
    entries1 = load_entries("datasets/timeline_v3_1.jsonl")
    entries2 = load_entries("datasets/timeline_v3_1_recovery.jsonl")

    print(f"  Main dataset: {len(entries1):,} entries")
    print(f"  Recovery dataset: {len(entries2):,} entries")

    # 分析 recovery 转移
    def count_recovery_transitions(entries):
        transitions = Counter()
        prev_zone = None
        for entry in entries:
            zone = entry.get("zone", get_zone(entry["queue_depth"], entry["worker_count"]))
            if prev_zone is not None:
                key = f"{prev_zone}->{zone}"
                transitions[key] += 1
            prev_zone = zone
        return transitions

    trans1 = count_recovery_transitions(entries1)
    trans2 = count_recovery_transitions(entries2)

    print("\nRecovery transitions in main dataset:")
    recovery_keys = ["E->D", "D->C", "C->B", "B->A"]
    total1 = sum(trans1.values())
    total2 = sum(trans2.values())
    for key in recovery_keys:
        r1 = trans1.get(key, 0) / total1 if total1 > 0 else 0
        r2 = trans2.get(key, 0) / total2 if total2 > 0 else 0
        print(f"  {key}: {trans1.get(key, 0):,} ({r1:.1%}) | recovery: {trans2.get(key, 0):,} ({r2:.1%})")

    # 策略：从 recovery 数据集中提取高 recovery 转移的 entries
    # 只保留包含 recovery 转移的 entries
    recovery_entries = []
    prev_zone = None
    current_recovery_sequence = []

    for entry in entries2:
        zone = entry.get("zone", get_zone(entry["queue_depth"], entry["worker_count"]))

        if prev_zone is not None:
            # 检查是否是 recovery 转移
            if (prev_zone == "E" and zone == "D") or \
               (prev_zone == "D" and zone == "C") or \
               (prev_zone == "C" and zone == "B") or \
               (prev_zone == "B" and zone == "A"):
                current_recovery_sequence.append(entry)

        prev_zone = zone

        # 当 zone 改变时，检查序列
        if zone != prev_zone or len(current_recovery_sequence) > 100:
            if current_recovery_sequence:
                recovery_entries.extend(current_recovery_sequence)
            current_recovery_sequence = []

    # 也添加 zone 下降的序列
    prev_zone = None
    for entry in entries2:
        zone = entry.get("zone", get_zone(entry["queue_depth"], entry["worker_count"]))
        if prev_zone is not None:
            # 如果 zone 下降（从高 zone 到低 zone），添加
            zone_order = {"A": 0, "B": 1, "C": 2, "D": 3, "E": 4}
            if zone_order.get(zone, 0) < zone_order.get(prev_zone, 0):
                recovery_entries.append(entry)
        prev_zone = zone

    # 去重
    seen = set()
    unique_recovery = []
    for entry in recovery_entries:
        key = (entry["tick"], entry["queue_depth"], entry["worker_count"])
        if key not in seen:
            seen.add(key)
            unique_recovery.append(entry)

    print(f"\nExtracted {len(unique_recovery):,} recovery entries")

    # 分析提取的 recovery 数据的转移
    if unique_recovery:
        trans_rec = count_recovery_transitions(unique_recovery)
        total_rec = sum(trans_rec.values())
        print("\nRecovery transitions in extracted data:")
        for key in recovery_keys:
            count = trans_rec.get(key, 0)
            ratio = count / total_rec if total_rec > 0 else 0
            print(f"  {key}: {count:,} ({ratio:.1%})")

    # 合并：原始数据 + 采样的 recovery 数据
    # 目标是增加 recovery 转移 50%
    target_recovery_increase = int(total1 * 0.05)  # 增加 5% 的 recovery 转移

    # 采样 recovery entries
    if unique_recovery:
        sample_size = min(len(unique_recovery), target_recovery_increase)
        sampled_recovery = random.sample(unique_recovery, sample_size) if len(unique_recovery) > sample_size else unique_recovery
    else:
        sampled_recovery = []

    print(f"\nSampling {len(sampled_recovery):,} recovery entries")

    # 合并
    merged = entries1 + sampled_recovery
    random.shuffle(merged)

    # 分析合并后的数据
    trans_merged = count_recovery_transitions(merged)
    total_merged = sum(trans_merged.values())
    recovery_total = sum(trans_merged.get(key, 0) for key in recovery_keys)
    recovery_ratio = recovery_total / total_merged if total_merged > 0 else 0

    print("\nAfter merge:")
    print(f"  Total entries: {len(merged):,}")
    print(f"  Total transitions: {total_merged:,}")
    print("  Recovery transitions:")
    for key in recovery_keys:
        count = trans_merged.get(key, 0)
        ratio = count / total_merged if total_merged > 0 else 0
        print(f"    {key}: {count:,} ({ratio:.1%})")
    print(f"  Total Recovery: {recovery_total:,} ({recovery_ratio:.1%})")

    # Action 分布
    action_counter = Counter(e["action_index"] for e in merged)
    ACTION_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}

    print("\nAction Distribution:")
    max_ratio = 0
    for action_id in range(5):
        count = action_counter.get(action_id, 0)
        ratio = count / len(merged) if len(merged) > 0 else 0
        max_ratio = max(max_ratio, ratio)
        status = "✅" if ratio <= 0.40 else "❌"
        print(f"  {ACTION_NAMES[action_id]:<8}: {count:,} ({ratio:.1%}) {status}")

    # Worker bucket 分布
    bucket_counter = Counter(get_worker_bucket(e["worker_count"]) for e in merged)
    print("\nWorker Bucket Distribution:")
    for bucket in ["1-20", "20-50", "50-100", "100-200", "200+"]:
        count = bucket_counter.get(bucket, 0)
        ratio = count / len(merged) if len(merged) > 0 else 0
        status = "✅" if ratio >= 0.05 else "❌"
        print(f"  {bucket:<8}: {count:,} ({ratio:.1%}) {status}")

    # 保存
    output_path = "datasets/timeline_v3_1.jsonl"
    with open(output_path, 'w', encoding='utf-8') as f:
        for entry in merged:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    print(f"\nSaved {len(merged):,} entries to: {output_path}")

    # 检查是否满足 audit 要求
    print("\n" + "=" * 60)
    print("Audit Summary")
    print("=" * 60)

    checks = {
        "Action Distribution (max < 40%)": max_ratio <= 0.40,
        "Recovery Coverage (> 10%)": recovery_ratio > 0.10,
        "Crisis Coverage (> 5%)": (trans_merged.get("D->E", 0) + trans_merged.get("C->E", 0) + trans_merged.get("B->E", 0) + trans_merged.get("A->E", 0)) / total_merged > 0.05,
    }

    for check, passed in checks.items():
        icon = "✅" if passed else "❌"
        print(f"  {icon} {check}")

    return {
        "total": len(merged),
        "recovery_ratio": recovery_ratio,
        "max_action_ratio": max_ratio,
        "checks": checks,
    }


if __name__ == "__main__":
    result = merge_with_recovery_focus()
