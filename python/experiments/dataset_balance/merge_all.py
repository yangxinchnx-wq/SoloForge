# -*- coding: utf-8 -*-
"""
Final merge of all datasets
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


def merge_all():
    """合并所有数据集"""
    print("=" * 60)
    print("Final Merge: All Datasets")
    print("=" * 60)

    # 加载数据集
    print("\nLoading datasets...")
    entries1 = load_entries("datasets/timeline_v3_1.jsonl")  # 主数据集
    entries2 = load_entries("datasets/timeline_v3_1_fixed_recovery.jsonl")  # Recovery 数据

    print(f"  Main dataset: {len(entries1):,} entries")
    print(f"  Recovery dataset: {len(entries2):,} entries")

    # 分析转移
    def count_transitions(entries):
        transitions = Counter()
        prev_zone = None
        for entry in entries:
            zone = entry.get("zone", get_zone(entry["queue_depth"], entry["worker_count"]))
            if prev_zone is not None:
                key = f"{prev_zone}->{zone}"
                transitions[key] += 1
            prev_zone = zone
        return transitions

    trans1 = count_transitions(entries1)
    trans2 = count_transitions(entries2)

    total1 = sum(trans1.values())
    total2 = sum(trans2.values())

    recovery_keys = ["E->D", "D->C", "C->B", "B->A"]
    crisis_keys = ["D->E", "C->E", "B->E", "A->E"]

    print("\nBefore merge:")
    print("  Main recovery: {:.1%}".format(sum(trans1.get(k, 0) for k in recovery_keys) / total1 if total1 > 0 else 0))
    print("  Recovery recovery: {:.1%}".format(sum(trans2.get(k, 0) for k in recovery_keys) / total2 if total2 > 0 else 0))

    # 合并
    merged = entries1 + entries2
    random.shuffle(merged)

    # 分析合并后的数据
    trans_merged = count_transitions(merged)
    total_merged = sum(trans_merged.values())
    recovery_total = sum(trans_merged.get(k, 0) for k in recovery_keys)
    crisis_total = sum(trans_merged.get(k, 0) for k in crisis_keys)

    print(f"\nAfter merge:")
    print(f"  Total entries: {len(merged):,}")
    print(f"  Total transitions: {total_merged:,}")

    print("\n  Recovery transitions:")
    for key in recovery_keys:
        count = trans_merged.get(key, 0)
        ratio = count / total_merged if total_merged > 0 else 0
        print(f"    {key}: {count:,} ({ratio:.1%})")
    print(f"    Total: {recovery_total:,} ({recovery_total/total_merged:.1%})")

    print("\n  Crisis transitions:")
    for key in crisis_keys:
        count = trans_merged.get(key, 0)
        ratio = count / total_merged if total_merged > 0 else 0
        print(f"    {key}: {count:,} ({ratio:.1%})")
    print(f"    Total: {crisis_total:,} ({crisis_total/total_merged:.1%})")

    # Action 分布
    action_counter = Counter(e["action_index"] for e in merged)
    ACTION_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}

    print("\n  Action Distribution:")
    max_ratio = 0
    for action_id in range(5):
        count = action_counter.get(action_id, 0)
        ratio = count / len(merged) if len(merged) > 0 else 0
        max_ratio = max(max_ratio, ratio)
        status = "✅" if ratio <= 0.40 else "❌"
        print(f"    {ACTION_NAMES[action_id]:<8}: {count:,} ({ratio:.1%}) {status}")

    # Worker bucket 分布
    bucket_counter = Counter(get_worker_bucket(e["worker_count"]) for e in merged)
    print("\n  Worker Bucket Distribution:")
    for bucket in ["1-20", "20-50", "50-100", "100-200", "200+"]:
        count = bucket_counter.get(bucket, 0)
        ratio = count / len(merged) if len(merged) > 0 else 0
        status = "✅" if ratio >= 0.05 else "❌"
        print(f"    {bucket:<8}: {count:,} ({ratio:.1%}) {status}")

    # 保存
    output_path = "datasets/timeline_v3_1.jsonl"
    with open(output_path, 'w', encoding='utf-8') as f:
        for entry in merged:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    print(f"\nSaved {len(merged):,} entries to: {output_path}")

    # Audit 汇总
    print("\n" + "=" * 60)
    print("Audit Summary")
    print("=" * 60)

    recovery_ratio = recovery_total / total_merged if total_merged > 0 else 0
    crisis_ratio = crisis_total / total_merged if total_merged > 0 else 0

    checks = {
        "Action Distribution (max < 40%)": max_ratio <= 0.40,
        "Transition Diversity (>= 10)": len(trans_merged) >= 10,
        "Recovery Coverage (> 10%)": recovery_ratio > 0.10,
        "Crisis Coverage (> 5%)": crisis_ratio > 0.05,
    }

    # Worker Distribution
    worker_pass = all(
        bucket_counter.get(b, 0) / len(merged) >= 0.05
        for b in ["1-20", "20-50", "50-100", "100-200", "200+"]
    )
    checks["Worker Distribution (each > 5%)"] = worker_pass

    for check, passed in checks.items():
        icon = "✅" if passed else "❌"
        print(f"  {icon} {check}")

    all_pass = all(checks.values())
    print(f"\n{'🎉 ALL PASS' if all_pass else '❌ SOME FAILED'}")

    return {
        "total": len(merged),
        "recovery_ratio": recovery_ratio,
        "crisis_ratio": crisis_ratio,
        "max_action_ratio": max_ratio,
        "checks": checks,
        "all_pass": all_pass,
    }


if __name__ == "__main__":
    result = merge_all()
