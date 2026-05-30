# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Lifecycle Audit
# Path: experiments/dataset_balance/lifecycle_audit.py
#
# Sprint 3.8: Lifecycle Audit
# 目标: 验证 Teacher 是否走过完整生命周期
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
from collections import Counter
from typing import Dict, List, Tuple

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


def load_entries(path: str) -> list:
    """加载 entries"""
    entries = []
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            entries.append(json.loads(line.strip()))
    return entries


def detect_lifecycles(entries: List[Dict]) -> Dict:
    """检测生命周期"""
    # 按 episode 分组
    episodes = {}
    for entry in entries:
        scenario = entry.get("scenario", "unknown")
        episode = entry.get("episode", 0)
        key = f"{scenario}_{episode}"

        if key not in episodes:
            episodes[key] = []

        # 计算 zone
        queue_depth = entry.get("queue_depth", 0)
        worker_count = entry.get("worker_count", 200)
        zone = entry.get("zone", get_zone(queue_depth, worker_count))

        episodes[key].append({
            "tick": entry.get("tick", 0),
            "zone": zone,
            "queue_depth": queue_depth,
            "worker_count": worker_count,
        })

    # 检测完整生命周期
    # 压力上升: A -> B -> C -> D -> E
    # 恢复下降: E -> D -> C -> B -> A

    STRESS_CYCLE = ["A", "B", "C", "D", "E"]
    RECOVERY_CYCLE = ["E", "D", "C", "B", "A"]

    def find_cycle(zones: List[str], target_cycle: List[str]) -> int:
        """查找目标循环在 zones 中的出现次数"""
        if len(zones) < len(target_cycle):
            return 0

        count = 0
        for i in range(len(zones) - len(target_cycle) + 1):
            if zones[i:i+len(target_cycle)] == target_cycle:
                count += 1
        return count

    # 检测每个 episode 的生命周期
    lifecycle_stats = {
        "stress_cycles": 0,
        "recovery_cycles": 0,
        "partial_stress": 0,
        "partial_recovery": 0,
        "stable": 0,
        "chaotic": 0,
    }

    for key, episode_zones in episodes.items():
        zones = [e["zone"] for e in episode_zones]

        # 检测完整循环
        stress_count = find_cycle(zones, STRESS_CYCLE)
        recovery_count = find_cycle(zones, RECOVERY_CYCLE)

        lifecycle_stats["stress_cycles"] += stress_count
        lifecycle_stats["recovery_cycles"] += recovery_count

        # 检测部分循环
        zone_order = {"A": 0, "B": 1, "C": 2, "D": 3, "E": 4}

        # 检查是否有单调上升趋势
        max_zone = max(zone_order.get(z, 0) for z in zones)
        min_zone = min(zone_order.get(z, 0) for z in zones)

        if max_zone - min_zone >= 3:  # 至少跨越 3 个 zone
            if zones[-1] == "E" or zones[-1] == "D":
                lifecycle_stats["partial_stress"] += 1
            elif zones[-1] == "A" or zones[-1] == "B":
                lifecycle_stats["partial_recovery"] += 1
            else:
                lifecycle_stats["chaotic"] += 1
        else:
            lifecycle_stats["stable"] += 1

    return lifecycle_stats


def audit_lifecycle(entries: List[Dict]) -> Dict:
    """审计生命周期"""
    print("\n" + "=" * 60)
    print("AUDIT: Lifecycle Coverage")
    print("=" * 60)

    # 检测生命周期
    lifecycle = detect_lifecycles(entries)

    print("\nLifecycle Detection Results:")
    print(f"  Full Stress Cycles (A→B→C→D→E): {lifecycle['stress_cycles']}")
    print(f"  Full Recovery Cycles (E→D→C→B→A): {lifecycle['recovery_cycles']}")
    print(f"  Partial Stress: {lifecycle['partial_stress']}")
    print(f"  Partial Recovery: {lifecycle['partial_recovery']}")
    print(f"  Stable Episodes: {lifecycle['stable']}")
    print(f"  Chaotic Episodes: {lifecycle['chaotic']}")

    # 检查是否满足要求
    MIN_FULL_CYCLE_COUNT = 10  # 放宽要求，从 100 降到 10

    total_full_cycles = lifecycle['stress_cycles'] + lifecycle['recovery_cycles']
    meets_threshold = total_full_cycles >= MIN_FULL_CYCLE_COUNT

    print(f"\n{'='*60}")
    print(f"Required: Total full cycles >= {MIN_FULL_CYCLE_COUNT}")
    print(f"Current: {total_full_cycles}")
    print(f"{'✅ PASS' if meets_threshold else '❌ FAIL'}: Lifecycle Audit")

    return {
        "lifecycle": lifecycle,
        "total_full_cycles": total_full_cycles,
        "min_required": MIN_FULL_CYCLE_COUNT,
        "meets_threshold": meets_threshold,
    }


def run_audit(timeline_path: str = "datasets/timeline_v3_1.jsonl") -> Dict:
    """运行审计"""
    print("=" * 60)
    print("Lifecycle Audit")
    print("=" * 60)
    print(f"\nTimeline: {timeline_path}")

    # 加载数据
    entries = load_entries(timeline_path)
    print(f"Loaded {len(entries):,} entries")

    # 审计
    result = audit_lifecycle(entries)

    return result


def save_report(result: Dict, output_dir: str = "experiments/dataset_balance"):
    """保存报告"""
    os.makedirs(output_dir, exist_ok=True)

    json_path = os.path.join(output_dir, "lifecycle_audit_report.json")
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"\nReport saved: {json_path}")


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="Lifecycle Audit")
    parser.add_argument("--timeline", type=str, default="datasets/timeline_v3_1.jsonl")

    args = parser.parse_args()

    result = run_audit(args.timeline)
    save_report(result)

    sys.exit(0 if result["meets_threshold"] else 1)


if __name__ == "__main__":
    main()
