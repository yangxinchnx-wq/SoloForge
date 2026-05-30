# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Dataset Balance Audit
# Path: experiments/dataset_balance/audit.py
#
# Sprint 3.6: Dataset Balance Audit
# 目标: 证明 Timeline V3 数据集均衡性，避免 BC 策略坍塌
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import math
from collections import Counter, defaultdict
from typing import Dict, List, Tuple

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)


# ═══════════════════════════════════════════════════════════════════
# AUDIT THRESHOLDS
# ═══════════════════════════════════════════════════════════════════

MAX_ACTION_RATIO = 0.40          # 任何动作不能超过 40%
MIN_TRANSITION_COUNT = 10        # 至少 10 种状态转移
MIN_RECOVERY_RATIO = 0.10       # 恢复覆盖率 > 10%
MIN_CRISIS_RATIO = 0.05          # 危机覆盖率 > 5%
MIN_WORKER_BUCKET_RATIO = 0.05   # 每个 worker bucket > 5%


# ═══════════════════════════════════════════════════════════════════
# ZONE DEFINITIONS (与 Teacher V4 一致)
# ═══════════════════════════════════════════════════════════════════

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


# ═══════════════════════════════════════════════════════════════════
# AUDIT FUNCTIONS
# ═══════════════════════════════════════════════════════════════════

def load_timeline(timeline_path: str) -> List[Dict]:
    """加载 Timeline"""
    entries = []
    with open(timeline_path, 'r', encoding='utf-8') as f:
        for line in f:
            data = json.loads(line.strip())
            entries.append(data)
    return entries


def audit_action_distribution(entries: List[Dict]) -> Dict:
    """Audit 1: Action Distribution Balance"""
    print("\n" + "=" * 60)
    print("AUDIT 1: Action Distribution Balance")
    print("=" * 60)

    action_counter = Counter()
    for entry in entries:
        action_index = entry.get("action_index", 2)
        action_counter[action_index] += 1

    total = len(entries)
    distribution = {}
    status = {}

    ACTION_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}

    print(f"\n{'Action':<12} {'Count':>10} {'Ratio':>10} {'Max 40%':>12} {'Status':<8}")
    print("-" * 52)

    max_ratio = 0
    for action_id in range(5):
        count = action_counter.get(action_id, 0)
        ratio = count / total if total > 0 else 0
        distribution[ACTION_NAMES[action_id]] = ratio
        max_ratio = max(max_ratio, ratio)
        meets_threshold = ratio <= MAX_ACTION_RATIO
        status[ACTION_NAMES[action_id]] = meets_threshold

        icon = "✅" if meets_threshold else "❌"
        print(f"{ACTION_NAMES[action_id]:<12} {count:>10,} {ratio:>9.1%} {MAX_ACTION_RATIO:>10.1%} {icon}")

    all_pass = all(status.values())
    print(f"\nMax Action Ratio: {max_ratio:.1%}")
    print(f"{'PASS' if max_ratio <= MAX_ACTION_RATIO else 'FAIL'}: Action Distribution Balance")

    return {
        "distribution": distribution,
        "status": status,
        "max_ratio": max_ratio,
        "threshold": MAX_ACTION_RATIO,
        "all_pass": max_ratio <= MAX_ACTION_RATIO,
    }


def audit_transition_diversity(entries: List[Dict]) -> Dict:
    """Audit 2: Transition Diversity"""
    print("\n" + "=" * 60)
    print("AUDIT 2: Transition Diversity")
    print("=" * 60)

    # 构建转移矩阵
    transitions = defaultdict(int)

    prev_zone = None
    for entry in entries:
        queue_depth = entry.get("queue_depth", 0)
        worker_count = entry.get("worker_count", 200)
        zone = get_zone(queue_depth, worker_count)

        if prev_zone is not None:
            key = f"{prev_zone}->{zone}"
            transitions[key] += 1

        prev_zone = zone

    # 统计
    total_transitions = sum(transitions.values())
    transition_count = len(transitions)

    print(f"\nTotal Transitions: {total_transitions:,}")
    print(f"Unique Transitions: {transition_count}")
    print(f"Required: >= {MIN_TRANSITION_COUNT}")
    print()

    # 打印前 20 个最常见的转移
    print("Top 20 Transitions:")
    print(f"{'Transition':<15} {'Count':>10} {'Ratio':>10}")
    print("-" * 35)

    sorted_transitions = sorted(transitions.items(), key=lambda x: -x[1])
    for trans, count in sorted_transitions[:20]:
        ratio = count / total_transitions if total_transitions > 0 else 0
        print(f"{trans:<15} {count:>10,} {ratio:>9.1%}")

    # 恢复转移统计
    recovery_transitions = sum(v for k, v in transitions.items() if k in ["E->D", "D->C", "C->B", "B->A"])
    recovery_ratio = recovery_transitions / total_transitions if total_transitions > 0 else 0

    # 危机转移统计
    crisis_transitions = sum(v for k, v in transitions.items() if k in ["D->E", "C->E", "B->E", "A->E"])
    crisis_ratio = crisis_transitions / total_transitions if total_transitions > 0 else 0

    meets_threshold = transition_count >= MIN_TRANSITION_COUNT
    icon = "✅" if meets_threshold else "❌"
    print(f"\n{icon} {'PASS' if meets_threshold else 'FAIL'}: Transition Diversity ({transition_count} >= {MIN_TRANSITION_COUNT})")

    return {
        "transition_count": transition_count,
        "transitions": dict(transitions),
        "recovery_ratio": recovery_ratio,
        "crisis_ratio": crisis_ratio,
        "threshold": MIN_TRANSITION_COUNT,
        "all_pass": meets_threshold,
    }


def audit_recovery_coverage(entries: List[Dict]) -> Dict:
    """Audit 3: Recovery Coverage"""
    print("\n" + "=" * 60)
    print("AUDIT 3: Recovery Coverage")
    print("=" * 60)

    # 统计恢复转移
    transitions = defaultdict(int)
    prev_zone = None

    for entry in entries:
        queue_depth = entry.get("queue_depth", 0)
        worker_count = entry.get("worker_count", 200)
        zone = get_zone(queue_depth, worker_count)

        if prev_zone is not None:
            key = f"{prev_zone}->{zone}"
            transitions[key] += 1

        prev_zone = zone

    total_transitions = sum(transitions.values())

    # 恢复转移: E->D, D->C, C->B, B->A
    recovery_transitions = ["E->D", "D->C", "C->B", "B->A"]

    print(f"\n{'Recovery Transition':<20} {'Count':>10} {'Ratio':>10}")
    print("-" * 40)

    recovery_count = 0
    recovery_detail = {}
    for trans in recovery_transitions:
        count = transitions.get(trans, 0)
        ratio = count / total_transitions if total_transitions > 0 else 0
        recovery_count += count
        recovery_detail[trans] = ratio
        print(f"{trans:<20} {count:>10,} {ratio:>9.1%}")

    recovery_ratio = recovery_count / total_transitions if total_transitions > 0 else 0

    print(f"\nTotal Recovery: {recovery_count:,} ({recovery_ratio:.1%})")
    print(f"Required: > {MIN_RECOVERY_RATIO:.1%}")

    meets_threshold = recovery_ratio > MIN_RECOVERY_RATIO
    icon = "✅" if meets_threshold else "❌"
    print(f"\n{icon} {'PASS' if meets_threshold else 'FAIL'}: Recovery Coverage")

    return {
        "recovery_ratio": recovery_ratio,
        "recovery_detail": recovery_detail,
        "threshold": MIN_RECOVERY_RATIO,
        "all_pass": meets_threshold,
    }


def audit_crisis_coverage(entries: List[Dict]) -> Dict:
    """Audit 4: Crisis Coverage"""
    print("\n" + "=" * 60)
    print("AUDIT 4: Crisis Coverage")
    print("=" * 60)

    # 统计危机转移
    transitions = defaultdict(int)
    prev_zone = None

    for entry in entries:
        queue_depth = entry.get("queue_depth", 0)
        worker_count = entry.get("worker_count", 200)
        zone = get_zone(queue_depth, worker_count)

        if prev_zone is not None:
            key = f"{prev_zone}->{zone}"
            transitions[key] += 1

        prev_zone = zone

    total_transitions = sum(transitions.values())

    # 危机转移: D->E, C->E, B->E, A->E
    crisis_transitions = ["D->E", "C->E", "B->E", "A->E"]

    print(f"\n{'Crisis Transition':<20} {'Count':>10} {'Ratio':>10}")
    print("-" * 40)

    crisis_count = 0
    crisis_detail = {}
    for trans in crisis_transitions:
        count = transitions.get(trans, 0)
        ratio = count / total_transitions if total_transitions > 0 else 0
        crisis_count += count
        crisis_detail[trans] = ratio
        print(f"{trans:<20} {count:>10,} {ratio:>9.1%}")

    crisis_ratio = crisis_count / total_transitions if total_transitions > 0 else 0

    print(f"\nTotal Crisis: {crisis_count:,} ({crisis_ratio:.1%})")
    print(f"Required: > {MIN_CRISIS_RATIO:.1%}")

    meets_threshold = crisis_ratio > MIN_CRISIS_RATIO
    icon = "✅" if meets_threshold else "❌"
    print(f"\n{icon} {'PASS' if meets_threshold else 'FAIL'}: Crisis Coverage")

    return {
        "crisis_ratio": crisis_ratio,
        "crisis_detail": crisis_detail,
        "threshold": MIN_CRISIS_RATIO,
        "all_pass": meets_threshold,
    }


def audit_worker_distribution(entries: List[Dict]) -> Dict:
    """Audit 5: Worker Distribution"""
    print("\n" + "=" * 60)
    print("AUDIT 5: Worker Distribution")
    print("=" * 60)

    # 定义 bucket
    buckets = [
        ("1-20", 1, 20),
        ("20-50", 20, 50),
        ("50-100", 50, 100),
        ("100-200", 100, 200),
        ("200+", 200, float('inf')),
    ]

    bucket_counter = Counter()
    for entry in entries:
        worker_count = entry.get("worker_count", 200)

        for name, low, high in buckets:
            if low <= worker_count < high:
                bucket_counter[name] += 1
                break

    total = len(entries)
    distribution = {}
    status = {}

    print(f"\n{'Bucket':<12} {'Range':<15} {'Count':>10} {'Ratio':>10} {'Min 5%':>10} {'Status':<8}")
    print("-" * 65)

    for name, low, high in buckets:
        count = bucket_counter.get(name, 0)
        ratio = count / total if total > 0 else 0
        distribution[name] = ratio
        meets_threshold = ratio >= MIN_WORKER_BUCKET_RATIO
        status[name] = meets_threshold

        range_str = f"{low}-{int(high) if high != float('inf') else '∞'}"
        icon = "✅" if meets_threshold else "❌"
        print(f"{name:<12} {range_str:<15} {count:>10,} {ratio:>9.1%} {MIN_WORKER_BUCKET_RATIO:>9.1%} {icon}")

    all_pass = all(status.values())
    print(f"\n{'PASS' if all_pass else 'FAIL'}: Worker Distribution")

    return {
        "distribution": distribution,
        "status": status,
        "threshold": MIN_WORKER_BUCKET_RATIO,
        "all_pass": all_pass,
    }


def run_audit(timeline_path: str = "datasets/timeline_v3.jsonl") -> Dict:
    """
    运行完整的 Dataset Balance Audit

    Returns:
        Audit results
    """
    print("=" * 60)
    print("DATASET BALANCE AUDIT")
    print("=" * 60)
    print(f"\nTimeline: {timeline_path}")

    # 加载数据
    print("\n[1/6] Loading Timeline...")
    entries = load_timeline(timeline_path)
    print(f"Loaded {len(entries):,} entries")

    # Audit 1: Action Distribution
    action_result = audit_action_distribution(entries)

    # Audit 2: Transition Diversity
    transition_result = audit_transition_diversity(entries)

    # Audit 3: Recovery Coverage
    recovery_result = audit_recovery_coverage(entries)

    # Audit 4: Crisis Coverage
    crisis_result = audit_crisis_coverage(entries)

    # Audit 5: Worker Distribution
    worker_result = audit_worker_distribution(entries)

    # 汇总
    print("\n" + "=" * 60)
    print("AUDIT SUMMARY")
    print("=" * 60)

    checks = {
        "Action Distribution (max < 40%)": action_result["all_pass"],
        "Transition Diversity (>= 10)": transition_result["all_pass"],
        "Recovery Coverage (> 10%)": recovery_result["all_pass"],
        "Crisis Coverage (> 5%)": crisis_result["all_pass"],
        "Worker Distribution (each > 5%)": worker_result["all_pass"],
    }

    for check, passed in checks.items():
        icon = "✅" if passed else "❌"
        print(f"  {icon} {check}")

    all_pass = all(checks.values())

    print("\n" + "=" * 60)
    if all_pass:
        print("🎉 AUDIT PASSED - Timeline V3.1 Certified")
        print("=" * 60)
        print("\nProceed to BC V3 Training...")
    else:
        print("❌ AUDIT FAILED - Dataset Needs Rebalancing")
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
        "action_distribution": action_result,
        "transition_diversity": transition_result,
        "recovery_coverage": recovery_result,
        "crisis_coverage": crisis_result,
        "worker_distribution": worker_result,
        "all_pass": all_pass,
    }


def save_report(result: Dict, output_dir: str = "experiments/dataset_balance"):
    """保存报告"""
    os.makedirs(output_dir, exist_ok=True)

    # 保存 JSON
    json_path = os.path.join(output_dir, "balance_report.json")
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"JSON saved: {json_path}")

    # 保存 Markdown
    md_path = os.path.join(output_dir, "balance_dashboard.md")
    with open(md_path, 'w', encoding='utf-8') as f:
        f.write("# Dataset Balance Audit Report\n\n")
        f.write(f"**Timeline**: {result['timeline_path']}\n\n")
        f.write(f"**Total Entries**: {result['total_entries']:,}\n\n")

        f.write("## Audit Checks\n\n")
        f.write("| Check | Status |\n")
        f.write("|-------|--------|\n")
        for check, passed in result['checks'].items():
            f.write(f"| {check} | {'PASS' if passed else 'FAIL'} |\n")

        f.write("\n## Action Distribution\n\n")
        f.write("| Action | Ratio | Threshold |\n")
        f.write("|--------|-------|----------|\n")
        for action, ratio in result['action_distribution']['distribution'].items():
            status = "PASS" if ratio <= result['action_distribution']['threshold'] else "FAIL"
            f.write(f"| {action} | {ratio:.1%} | {status} |\n")

        f.write("\n## Transition Diversity\n\n")
        f.write(f"- Unique Transitions: {result['transition_diversity']['transition_count']}\n")
        f.write(f"- Recovery Ratio: {result['transition_diversity']['recovery_ratio']:.1%}\n")
        f.write(f"- Crisis Ratio: {result['transition_diversity']['crisis_ratio']:.1%}\n")

        f.write("\n## Conclusion\n\n")
        if result['all_pass']:
            f.write("✅ **Timeline V3.1 Certified** - Proceed to BC V3 Training\n")
        else:
            f.write("❌ **Audit Failed** - Dataset needs rebalancing\n")

    print(f"Markdown saved: {md_path}")


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="Dataset Balance Audit")
    parser.add_argument("--timeline", type=str, default="datasets/timeline_v3.jsonl")
    parser.add_argument("--output", type=str, default="experiments/dataset_balance")

    args = parser.parse_args()

    result = run_audit(args.timeline)
    save_report(result, args.output)

    # Exit with appropriate code
    sys.exit(0 if result['all_pass'] else 1)


if __name__ == "__main__":
    main()
