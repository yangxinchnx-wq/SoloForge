# -*- coding: utf-8 -*-
"""
Rebalance with recovery focus
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
    print("Rebalance with Recovery Focus")
    print("=" * 60)

    # 加载数据集
    print("\nLoading datasets...")
    main_entries = load_entries("datasets/timeline_v3_1.jsonl")
    recovery_entries = load_entries("datasets/timeline_v3_1_fixed_recovery.jsonl")

    print(f"  Main dataset: {len(main_entries):,} entries")
    print(f"  Recovery dataset: {len(recovery_entries):,} entries")

    # 分析当前 recovery 比例
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

    trans_main = count_transitions(main_entries)
    total_main = sum(trans_main.values())
    recovery_keys = ["E->D", "D->C", "C->B", "B->A"]

    current_recovery = sum(trans_main.get(k, 0) for k in recovery_keys) / total_main if total_main > 0 else 0
    print(f"\nCurrent recovery ratio: {current_recovery:.1%}")

    # 简化：直接增加 50% 的 recovery 数据
    extra_recovery = int(len(main_entries) * 0.50)
    sampled_recovery = random.sample(recovery_entries, min(len(recovery_entries), extra_recovery))

    print(f"\nAdding {len(sampled_recovery):,} recovery entries ({len(sampled_recovery)/len(main_entries):.0%} of main)")

    # 合并
    merged = main_entries + sampled_recovery
    random.shuffle(merged)

    # 分析
    trans_merged = count_transitions(merged)
    total_merged = sum(trans_merged.values())
    recovery_total = sum(trans_merged.get(k, 0) for k in recovery_keys)
    recovery_ratio = recovery_total / total_merged if total_merged > 0 else 0

    print(f"\nAfter merge:")
    print(f"  Total: {len(merged):,}")
    print(f"  Recovery ratio: {recovery_ratio:.1%}")

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

    # 保存
    output_path = "datasets/timeline_v3_1.jsonl"
    with open(output_path, 'w', encoding='utf-8') as f:
        for entry in merged:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    print(f"\nSaved {len(merged):,} entries to: {output_path}")

    return {
        "total": len(merged),
        "recovery_ratio": recovery_ratio,
        "max_action_ratio": max_ratio,
    }


if __name__ == "__main__":
    result = rebalance()
