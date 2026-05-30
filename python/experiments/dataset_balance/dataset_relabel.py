# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Dataset Relabeling
# Path: experiments/dataset_balance/dataset_relabel.py
#
# 使用 Teacher V4 重新标注数据集
# 修复 6.2% 的标签噪声
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
from collections import Counter

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.training.simulator.teacher_v4 import TeacherV4


def compute_load_ratio(queue_depth: int, worker_count: int) -> float:
    """计算 load_ratio"""
    return queue_depth / max(worker_count * 2, 1)


def get_zone_id(queue_depth: int, worker_count: int) -> int:
    """获取 Zone ID (与 Teacher V4 一致)"""
    load_ratio = compute_load_ratio(queue_depth, worker_count)
    if load_ratio < 0.1:
        return 0
    elif load_ratio < 0.25:
        return 1
    elif load_ratio < 0.5:
        return 2
    elif load_ratio < 1.0:
        return 3
    else:
        return 4


def teacher_decide(queue_depth: int, worker_count: int) -> int:
    """Teacher V4 决策，返回 action_index (0-4)"""
    teacher = TeacherV4()
    action_value = teacher.decide(queue_depth, worker_count)
    # action_value: -2, -1, 0, 1, 2
    # action_index: 0, 1, 2, 3, 4
    action_index = action_value + 2
    return action_index


def relabel_dataset(
    input_path: str,
    output_path: str,
) -> dict:
    """重新标注数据集"""
    print("=" * 60)
    print("DATASET RELABELING")
    print("=" * 60)
    print(f"Input: {input_path}")
    print(f"Output: {output_path}")

    # 统计
    stats = {
        "total": 0,
        "original_labels": Counter(),
        "new_labels": Counter(),
        "changes": Counter(),
        "zone_distribution": Counter(),
    }

    # 读取并重新标注
    entries = []
    changes = 0

    with open(input_path, 'r', encoding='utf-8') as f:
        for line in f:
            entry = json.loads(line.strip())
            stats["total"] += 1

            queue_depth = entry.get("queue_depth", 0)
            worker_count = entry.get("worker_count", 200)
            original_action = entry.get("action_index", 2)

            # 使用 Teacher V4 重新计算动作
            new_action = teacher_decide(queue_depth, worker_count)
            new_zone = get_zone_id(queue_depth, worker_count)

            # 记录统计
            stats["original_labels"][original_action] += 1
            stats["new_labels"][new_action] += 1
            stats["zone_distribution"][new_zone] += 1

            if original_action != new_action:
                changes += 1
                key = f"{original_action}->{new_action}"
                stats["changes"][key] += 1

            # 更新 entry
            entry["action_index"] = new_action
            entry["action_value"] = new_action - 2  # action_value
            entry["zone"] = chr(ord('A') + new_zone)  # A, B, C, D, E

            entries.append(entry)

            if stats["total"] % 20000 == 0:
                print(f"  Processed {stats['total']:,} entries...")

    # 保存重新标注的数据集
    print(f"\nSaving {len(entries):,} entries...")
    with open(output_path, 'w', encoding='utf-8') as f:
        for entry in entries:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    # 打印报告
    print("\n" + "=" * 60)
    print("RELABELING REPORT")
    print("=" * 60)

    print(f"\nTotal entries: {stats['total']:,}")
    print(f"Changed labels: {changes:,} ({changes/stats['total']*100:.1f}%)")
    print(f"Preserved labels: {stats['total'] - changes:,} ({(stats['total']-changes)/stats['total']*100:.1f}%)")

    ACTION_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}

    print("\nLabel Changes:")
    print("-" * 40)
    for change, count in stats["changes"].most_common():
        old, new = change.split("->")
        print(f"  {ACTION_NAMES[int(old)]:>8} -> {ACTION_NAMES[int(new)]:<8}: {count:,} ({count/stats['total']*100:.1f}%)")

    print("\nZone Distribution (after relabeling):")
    print("-" * 40)
    for zone in "ABCDE":
        count = stats["zone_distribution"][ord(zone) - ord('A')]
        pct = count / stats["total"] * 100
        print(f"  Zone {zone}: {count:,} ({pct:.1f}%)")

    print("\nAction Distribution:")
    print("-" * 40)
    print(f"  {'Action':<12} {'Before':>10} {'After':>10} {'Change':>10}")
    print("  " + "-" * 45)
    for aid in range(5):
        before = stats["original_labels"].get(aid, 0)
        after = stats["new_labels"].get(aid, 0)
        change = after - before
        print(f"  {ACTION_NAMES[aid]:<12} {before:>10,} {after:>10,} {change:>+10,}")

    print("\n" + "=" * 60)
    print(f"Saved to: {output_path}")
    print("=" * 60)

    return stats


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="Dataset Relabeling")
    parser.add_argument("--input", type=str, default="datasets/timeline_v3_1.jsonl")
    parser.add_argument("--output", type=str, default="datasets/timeline_v3_1_clean.jsonl")

    args = parser.parse_args()

    stats = relabel_dataset(
        input_path=args.input,
        output_path=args.output,
    )

    return stats


if __name__ == "__main__":
    main()
