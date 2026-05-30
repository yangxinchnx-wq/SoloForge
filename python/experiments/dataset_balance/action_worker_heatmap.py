# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Action×Worker Heatmap Audit
# Path: experiments/dataset_balance/action_worker_heatmap.py
#
# Sprint 3.7C: Action×Worker Heatmap Audit
# 目标: 确保每个 worker bucket 至少有 3 种动作
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
from collections import Counter, defaultdict
from typing import Dict, List

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


def audit_action_worker_heatmap(entries: List[Dict]) -> Dict:
    """审计 Action×Worker Heatmap"""
    print("\n" + "=" * 60)
    print("AUDIT: Action×Worker Heatmap")
    print("=" * 60)

    ACTION_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}
    BUCKETS = ["1-20", "20-50", "50-100", "100-200", "200+"]

    # 构建 heatmap: bucket -> action -> count
    heatmap = defaultdict(lambda: defaultdict(int))

    for entry in entries:
        worker_count = entry.get("worker_count", 200)
        action_index = entry.get("action_index", 2)

        bucket = get_worker_bucket(worker_count)
        heatmap[bucket][action_index] += 1

    # 打印 heatmap
    print(f"\n{'Bucket':<12}", end="")
    for action_id in range(5):
        print(f"{ACTION_NAMES[action_id]:>10}", end="")
    print(f"{'Actions':>10}")
    print("-" * 62)

    bucket_action_counts = {}
    all_pass = True

    for bucket in BUCKETS:
        row = f"{bucket:<12}"
        total = sum(heatmap[bucket].values())
        action_count = 0

        for action_id in range(5):
            count = heatmap[bucket].get(action_id, 0)
            prob = count / total if total > 0 else 0
            row += f"{prob:>9.1%} "

            if count > 0:
                action_count += 1

        bucket_action_counts[bucket] = action_count

        # 检查是否至少 3 种动作
        meets_threshold = action_count >= 3
        if not meets_threshold:
            all_pass = False

        status = "✅" if meets_threshold else "❌"
        row += f"{action_count:>10} {status}"
        print(row)

    # 汇总
    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)

    print(f"\n{'Bucket':<12} {'Action Count':>15} {'Status':<10}")
    print("-" * 40)

    for bucket in BUCKETS:
        action_count = bucket_action_counts.get(bucket, 0)
        meets_threshold = action_count >= 3
        status = "✅ PASS" if meets_threshold else "❌ FAIL"
        print(f"{bucket:<12} {action_count:>15} {status:<10}")

    print(f"\n{'ALL PASS' if all_pass else 'FAILED'}: Action×Worker Heatmap")
    print(f"Required: Each bucket >= 3 unique actions")

    return {
        "heatmap": {k: dict(v) for k, v in heatmap.items()},
        "bucket_action_counts": bucket_action_counts,
        "all_pass": all_pass,
        "min_actions_per_bucket": min(bucket_action_counts.values()) if bucket_action_counts else 0,
    }


def run_audit(timeline_path: str = "datasets/timeline_v3_1.jsonl") -> Dict:
    """运行审计"""
    print("=" * 60)
    print("Action×Worker Heatmap Audit")
    print("=" * 60)
    print(f"\nTimeline: {timeline_path}")

    # 加载数据
    entries = load_entries(timeline_path)
    print(f"Loaded {len(entries):,} entries")

    # 审计
    result = audit_action_worker_heatmap(entries)

    return result


def save_report(result: Dict, output_dir: str = "experiments/dataset_balance"):
    """保存报告"""
    os.makedirs(output_dir, exist_ok=True)

    json_path = os.path.join(output_dir, "action_worker_heatmap_report.json")
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"\nReport saved: {json_path}")


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="Action×Worker Heatmap Audit")
    parser.add_argument("--timeline", type=str, default="datasets/timeline_v3_1.jsonl")

    args = parser.parse_args()

    result = run_audit(args.timeline)
    save_report(result)

    sys.exit(0 if result["all_pass"] else 1)


if __name__ == "__main__":
    main()
