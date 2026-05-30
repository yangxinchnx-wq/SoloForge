# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Teacher Coverage Validation Gate
# Path: experiments/teacher_validation/validate.py
#
# Sprint 3.5: Teacher Coverage Validation (Hard Gate)
# 目标: 证明 Timeline V3 是否真的适合训练 BC
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import math
from collections import Counter
from typing import Dict, List, Tuple

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(os.path.dirname(script_dir)))
sys.path.insert(0, python_dir)


# ═══════════════════════════════════════════════════════════════════
# GATE THRESHOLDS
# ═══════════════════════════════════════════════════════════════════

MIN_ACTION_RATIO = 0.01       # 每个动作最低 1%
ENTROPY_THRESHOLD = 0.8       # 动作熵 > 0.8
MIN_ZONE_RATIO = 0.05          # 每个 Zone 最低 5%
ZONE_ACTION_THRESHOLD = 0.5    # Zone→Action 映射正确性 > 50%


# ═══════════════════════════════════════════════════════════════════
# ACTION/ZONE DEFINITIONS
# ═══════════════════════════════════════════════════════════════════

ACTION_NAMES = {-2: "shrink2", -1: "shrink1", 0: "noop", 1: "expand1", 2: "expand2"}
ACTION_INDEX_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}

# Teacher V4 期望的 Zone→Action 映射
# 与 Teacher V4 load_ratio 策略一致
# Zone 定义基于 load_ratio
EXPECTED_ZONE_ACTION = {
    "A": 0,  # Zone A (load_ratio < 0.1) → shrink2 → action_index=0
    "B": 1,  # Zone B (0.1 <= lr < 0.25) → shrink1 → action_index=1
    "C": 2,  # Zone C (0.25 <= lr < 0.5) → noop → action_index=2
    "D": 3,  # Zone D (0.5 <= lr < 1.0) → expand1 → action_index=3
    "E": 4,  # Zone E (load_ratio >= 1.0) → expand2 → action_index=4
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


def get_zone_from_index(zone_id: float) -> str:
    """从归一化 zone_id 获取 Zone (基于 load_ratio)"""
    # Zone 基于 load_ratio: A<0.1, B<0.25, C<0.5, D<1.0, E>=1.0
    # zone_id 假设是 queue_depth / 1000
    # load_ratio = (queue_depth/1000) / (worker_count * 2 / 1000) = queue_depth / (worker_count * 2)
    # 简化: 假设 worker_count=200, capacity=400
    # load_ratio = zone_id * 1000 / 400 = zone_id * 2.5
    load_ratio = zone_id * 2.5  # 近似值

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


# ═══════════════════════════════════════════════════════════════════
# VALIDATION FUNCTIONS
# ═══════════════════════════════════════════════════════════════════

def load_timeline(timeline_path: str) -> List[Dict]:
    """加载 Timeline"""
    entries = []
    with open(timeline_path, 'r', encoding='utf-8') as f:
        for line in f:
            data = json.loads(line.strip())
            entries.append(data)
    return entries


def check_action_coverage(entries: List[Dict]) -> Dict:
    """检查 Action Coverage"""
    print("\n" + "=" * 60)
    print("PART 1: Action Coverage")
    print("=" * 60)

    # 统计动作分布
    action_counter = Counter()
    for entry in entries:
        action_index = entry.get("action_index", entry.get("action", 2))
        action_counter[action_index] += 1

    total = len(entries)
    distribution = {}
    status = {}

    print(f"\nTotal entries: {total:,}")
    print(f"\n{'Action':<12} {'Count':>10} {'Ratio':>10} {'Required':>10} {'Status':<8}")
    print("-" * 50)

    for action_id in range(5):
        count = action_counter.get(action_id, 0)
        ratio = count / total if total > 0 else 0
        distribution[ACTION_INDEX_NAMES[action_id]] = ratio
        meets_threshold = ratio >= MIN_ACTION_RATIO
        status[ACTION_INDEX_NAMES[action_id]] = meets_threshold

        icon = "✅" if meets_threshold else "❌"
        print(f"{ACTION_INDEX_NAMES[action_id]:<12} {count:>10,} {ratio:>9.1%} {MIN_ACTION_RATIO:>9.1%} {icon}")

    all_pass = all(status.values())
    print(f"\n{'ALL PASS' if all_pass else 'FAILED'}: Action Coverage")

    return {
        "distribution": distribution,
        "status": status,
        "all_pass": all_pass,
    }


def check_action_entropy(distribution: Dict[str, float]) -> Dict:
    """检查 Action Entropy"""
    print("\n" + "=" * 60)
    print("PART 2: Action Entropy")
    print("=" * 60)

    # 计算熵
    entropy = -sum(
        p * math.log(p)
        for p in distribution.values()
        if p > 0
    )

    # 熵的最大值 (均匀分布)
    max_entropy = math.log(5)  # 5 个动作

    # 归一化熵
    normalized_entropy = entropy / max_entropy

    print(f"\nEntropy: {entropy:.4f}")
    print(f"Max Entropy (uniform): {max_entropy:.4f}")
    print(f"Normalized Entropy: {normalized_entropy:.4f}")
    print(f"Required: > {ENTROPY_THRESHOLD:.4f}")

    # 参考分布
    print("\nReference:")
    print(f"  20/20/20/20/20: {math.log(5):.2f}")
    print(f"  97/1/1/1: 0.16")
    print(f"  Current: {entropy:.2f}")

    meets_threshold = entropy >= ENTROPY_THRESHOLD
    icon = "✅" if meets_threshold else "❌"
    print(f"\n{icon} {'PASS' if meets_threshold else 'FAILED'}: Action Entropy")

    return {
        "entropy": entropy,
        "normalized_entropy": normalized_entropy,
        "meets_threshold": meets_threshold,
    }


def check_zone_coverage(entries: List[Dict]) -> Dict:
    """检查 Zone Coverage"""
    print("\n" + "=" * 60)
    print("PART 3: Zone Coverage")
    print("=" * 60)

    # 统计 Zone 分布
    zone_counter = Counter()
    for entry in entries:
        queue_depth = entry.get("queue_depth", 0)
        worker_count = entry.get("worker_count", 200)
        zone = get_zone(queue_depth, worker_count)
        zone_counter[zone] += 1

    total = len(entries)
    distribution = {}
    status = {}

    print(f"\nTotal entries: {total:,}")
    print(f"\n{'Zone':<8} {'Range':<20} {'Count':>10} {'Ratio':>10} {'Required':>10} {'Status':<8}")
    print("-" * 70)

    zone_ranges = {
        "A": "load_ratio < 0.1",
        "B": "0.1 <= lr < 0.25",
        "C": "0.25 <= lr < 0.5",
        "D": "0.5 <= lr < 1.0",
        "E": "load_ratio >= 1.0",
    }

    for zone in ["A", "B", "C", "D", "E"]:
        count = zone_counter.get(zone, 0)
        ratio = count / total if total > 0 else 0
        distribution[zone] = ratio
        meets_threshold = ratio >= MIN_ZONE_RATIO
        status[zone] = meets_threshold

        icon = "✅" if meets_threshold else "❌"
        print(f"{zone:<8} {zone_ranges[zone]:<20} {count:>10,} {ratio:>9.1%} {MIN_ZONE_RATIO:>9.1%} {icon}")

    all_pass = all(status.values())
    print(f"\n{'ALL PASS' if all_pass else 'FAILED'}: Zone Coverage")

    return {
        "distribution": distribution,
        "status": status,
        "all_pass": all_pass,
    }


def check_zone_action_heatmap(entries: List[Dict]) -> Dict:
    """检查 Zone→Action Heatmap"""
    print("\n" + "=" * 60)
    print("PART 4: Zone→Action Heatmap")
    print("=" * 60)

    # 构建热力图
    heatmap = {zone: Counter() for zone in "ABCDE"}

    for entry in entries:
        queue_depth = entry.get("queue_depth", 0)
        worker_count = entry.get("worker_count", 200)
        action_index = entry.get("action_index", entry.get("action", 2))
        zone = get_zone(queue_depth, worker_count)
        heatmap[zone][action_index] += 1

    # 转换为概率分布
    heatmap_probs = {}
    print(f"\n{'Zone':<8}", end="")
    for action_id in range(5):
        print(f"{ACTION_INDEX_NAMES[action_id]:>10}", end="")
    print(f"{'Expected':>12}")
    print("-" * 70)

    drift_detected = {}

    for zone in "ABCDE":
        total = sum(heatmap[zone].values())
        heatmap_probs[zone] = {}

        row = f"{zone:<8}"
        for action_id in range(5):
            count = heatmap[zone].get(action_id, 0)
            prob = count / total if total > 0 else 0
            heatmap_probs[zone][action_id] = prob
            row += f"{prob:>9.1%} "

        # 检查是否漂移
        expected_action = EXPECTED_ZONE_ACTION[zone]
        expected_prob = heatmap_probs[zone].get(expected_action, 0)
        drift_detected[zone] = expected_prob < ZONE_ACTION_THRESHOLD

        expected_name = ACTION_INDEX_NAMES[expected_action]
        icon = "❌" if drift_detected[zone] else "✅"
        print(f"{row}{expected_name:>10} {icon}")

    # 打印热力图矩阵
    print("\nMatrix (normalized):")
    for zone in "ABCDE":
        probs = heatmap_probs[zone]
        expected = EXPECTED_ZONE_ACTION[zone]
        dominant = max(probs.keys(), key=lambda a: probs[a])
        dominant_name = ACTION_INDEX_NAMES[dominant]
        expected_name = ACTION_INDEX_NAMES[expected]
        is_correct = dominant == expected
        icon = "✅" if is_correct else "❌"
        print(f"  {zone}: {dominant_name:<10} (expected {expected_name:<10}) {icon}")

    all_correct = not any(drift_detected.values())
    print(f"\n{'PASS' if all_correct else 'FAILED'}: Zone→Action Drift Check")

    return {
        "heatmap": heatmap_probs,
        "drift_detected": drift_detected,
        "all_correct": all_correct,
    }


def run_validation(timeline_path: str = "datasets/timeline_v2.jsonl") -> Dict:
    """
    运行完整的 Teacher Coverage Validation

    Returns:
        Validation results
    """
    print("=" * 60)
    print("TEACHER COVERAGE VALIDATION GATE")
    print("=" * 60)
    print(f"\nTimeline: {timeline_path}")

    # 加载数据
    print("\n[1/5] Loading Timeline...")
    entries = load_timeline(timeline_path)
    print(f"Loaded {len(entries):,} entries")

    # Part 1: Action Coverage
    action_result = check_action_coverage(entries)

    # Part 2: Action Entropy
    entropy_result = check_action_entropy(action_result["distribution"])

    # Part 3: Zone Coverage
    zone_result = check_zone_coverage(entries)

    # Part 4: Zone→Action Heatmap
    heatmap_result = check_zone_action_heatmap(entries)

    # 汇总
    print("\n" + "=" * 60)
    print("VALIDATION SUMMARY")
    print("=" * 60)

    checks = {
        "Action Coverage": action_result["all_pass"],
        "Action Entropy": entropy_result["meets_threshold"],
        "Zone Coverage": zone_result["all_pass"],
        "Zone→Action Drift": heatmap_result["all_correct"],
    }

    for check, passed in checks.items():
        icon = "✅" if passed else "❌"
        print(f"  {icon} {check}")

    all_pass = all(checks.values())

    print("\n" + "=" * 60)
    if all_pass:
        print("🎉 VALIDATION PASSED - Timeline V3 Certified")
        print("=" * 60)
        print("\nProceed to BC V3 Training...")
    else:
        print("❌ VALIDATION FAILED - Fix Issues Before BC Training")
        print("=" * 60)
        print("\nSuggested fixes:")
        for check, passed in checks.items():
            if not passed:
                print(f"  - {check}: FAILED")
    print()

    return {
        "timeline_path": timeline_path,
        "total_entries": len(entries),
        "checks": checks,
        "action_coverage": action_result,
        "entropy": entropy_result,
        "zone_coverage": zone_result,
        "heatmap": heatmap_result,
        "all_pass": all_pass,
    }


def save_report(result: Dict, output_dir: str = "experiments/teacher_validation"):
    """保存报告"""
    os.makedirs(output_dir, exist_ok=True)

    # 保存 JSON
    json_path = os.path.join(output_dir, "coverage_report.json")
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"JSON saved: {json_path}")

    # 保存 Markdown
    md_path = os.path.join(output_dir, "coverage_dashboard.md")
    with open(md_path, 'w', encoding='utf-8') as f:
        f.write("# Teacher Coverage Validation Report\n\n")
        f.write(f"**Timeline**: {result['timeline_path']}\n\n")
        f.write(f"**Total Entries**: {result['total_entries']:,}\n\n")

        f.write("## Validation Checks\n\n")
        f.write("| Check | Status |\n")
        f.write("|-------|--------|\n")
        for check, passed in result['checks'].items():
            f.write(f"| {check} | {'PASS' if passed else 'FAIL'} |\n")

        f.write("\n## Action Distribution\n\n")
        f.write("| Action | Ratio |\n")
        f.write("|--------|-------|\n")
        for action, ratio in result['action_coverage']['distribution'].items():
            f.write(f"| {action} | {ratio:.2%} |\n")

        f.write("\n## Zone Distribution\n\n")
        f.write("| Zone | Ratio |\n")
        f.write("|------|-------|\n")
        for zone, ratio in result['zone_coverage']['distribution'].items():
            f.write(f"| {zone} | {ratio:.2%} |\n")

        f.write("\n## Zone→Action Heatmap\n\n")
        f.write("| Zone | Expected | Correct |\n")
        f.write("|------|----------|--------|\n")
        for zone, detected in result['heatmap']['drift_detected'].items():
            expected = ACTION_INDEX_NAMES[EXPECTED_ZONE_ACTION[zone]]
            f.write(f"| {zone} | {expected} | {'YES' if not detected else 'NO'} |\n")

        f.write("\n## Conclusion\n\n")
        if result['all_pass']:
            f.write("✅ **Timeline V3 Certified** - Proceed to BC V3 Training\n")
        else:
            f.write("❌ **Validation Failed** - Fix issues before BC Training\n")

    print(f"Markdown saved: {md_path}")


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="Teacher Coverage Validation")
    parser.add_argument("--timeline", type=str, default="datasets/timeline_v2.jsonl")
    parser.add_argument("--output", type=str, default="experiments/teacher_validation")

    args = parser.parse_args()

    result = run_validation(args.timeline)
    save_report(result, args.output)

    # Exit with appropriate code
    sys.exit(0 if result['all_pass'] else 1)


if __name__ == "__main__":
    main()
