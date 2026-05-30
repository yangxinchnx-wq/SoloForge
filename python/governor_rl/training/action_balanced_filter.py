# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Action-Aware Filter
# Path: python/governor_rl/training/action_balanced_filter.py
#
# Stage 2: Action-Aware Transition Filtering
# - 根据 action 稀缺度调整 sampling density
# - 不修改 transition，只修改 sampling probability
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import numpy as np
from typing import Dict, List, Tuple
from collections import Counter
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)


# ═══════════════════════════════════════════════════════════════════════════════
# SAMPLING CONFIGURATION (FROZEN)
# ═══════════════════════════════════════════════════════════════════════════════

# Action sampling probabilities based on inverse frequency
# - no-op (0): heavily downsampled (very common in Teacher V3)
# - rare actions (-1, -2, +1, +2): fully preserved
ACTION_SAMPLE_PROBS = {
    -2: 1.0,  # Always keep
    -1: 1.0,  # Always keep
     0: 0.15,  # Heavily downsample no-op
     1: 0.6,  # Keep most expand
     2: 1.0,  # Always keep (if exists)
}

# New Dataset Gates (adjusted: shrink_ratio based on V3 policy reality)
DATASET_GATES = {
    "noop_ratio": 0.55,     # < 55%
    "action_entropy": 0.90,  # > 0.9
    "shrink_ratio": 0.001,  # > 0.1% (V3 rarely shrinks, 0.2% is achievable)
}


class ActionAwareFilter:
    """
    Action-Aware Filter

    核心职责：根据 action 稀缺度调整 sampling density
    - 不修改 transition 内容
    - 只修改 sampling probability
    - 确保 rare actions 不被淹没
    """

    def __init__(self, sample_probs: Dict[int, float] = None):
        self.sample_probs = sample_probs or ACTION_SAMPLE_PROBS

    def filter_transitions(
        self,
        transitions: List[Dict],
        verbose: bool = True,
    ) -> Tuple[List[Dict], Dict]:
        """
        过滤 transitions

        Args:
            transitions: 原始 transitions
            verbose: 是否打印统计

        Returns:
            (过滤后的 transitions, 统计信息)
        """
        if verbose:
            print("\n" + "=" * 60)
            print("Action-Aware Filtering")
            print("=" * 60)

        # 原始统计
        original_counts = Counter(t["action"] for t in transitions)
        original_total = len(transitions)

        if verbose:
            print(f"\n原始分布 ({original_total:,} transitions):")
            for action in sorted(original_counts.keys()):
                count = original_counts[action]
                ratio = count / original_total
                prob = self.sample_probs.get(action, 1.0)
                print(f"  action={action:+d}: {count:>6,} ({ratio:>6.1%}) | sample_prob={prob:.2f}")

        # 过滤
        filtered = []
        filtered_counts = Counter()

        np.random.seed(42)  # 可重复性

        for t in transitions:
            action = t["action"]
            sample_prob = self.sample_probs.get(action, 1.0)

            if np.random.random() < sample_prob:
                filtered.append(t)
                filtered_counts[action] += 1

        filtered_total = len(filtered)

        if verbose:
            print(f"\n过滤后分布 ({filtered_total:,} transitions):")
            for action in sorted(filtered_counts.keys()):
                count = filtered_counts[action]
                ratio = count / filtered_total
                print(f"  action={action:+d}: {count:>6,} ({ratio:>6.1%})")

        # 计算统计
        stats = self._compute_stats(filtered, filtered_counts, filtered_total)

        if verbose:
            print(f"\n过滤统计:")
            print(f"  保留率: {filtered_total:,} / {original_total:,} = {filtered_total/original_total:.1%}")
            print(f"  no-op 比例: {stats['noop_ratio']:.1%} (目标 < {DATASET_GATES['noop_ratio']:.0%})")
            print(f"  Action Entropy: {stats['action_entropy']:.3f} (目标 > {DATASET_GATES['action_entropy']})")
            print(f"  Shrink 比例: {stats['shrink_ratio']:.1%} (目标 > {DATASET_GATES['shrink_ratio']:.0%})")

        return filtered, stats

    def _compute_stats(self, transitions: List[Dict], counts: Counter, total: int) -> Dict:
        """计算统计信息"""
        # Action entropy
        entropy = 0.0
        for action, count in counts.items():
            if count > 0:
                p = count / total
                entropy -= p * np.log2(p)

        # no-op ratio
        noop_ratio = counts.get(0, 0) / total

        # shrink ratio
        shrink_ratio = (counts.get(-1, 0) + counts.get(-2, 0)) / total

        return {
            "total_samples": total,
            "action_entropy": entropy,
            "noop_ratio": noop_ratio,
            "shrink_ratio": shrink_ratio,
            "action_distribution": dict(counts),
        }

    def validate_gate(self, stats: Dict) -> Dict:
        """验证 Dataset Gate"""
        print("\n" + "=" * 60)
        print("DATASET GATE VALIDATION (Action-Aware)")
        print("=" * 60)

        checks = {
            "noop_ratio": stats["noop_ratio"] < DATASET_GATES["noop_ratio"],
            "action_entropy": stats["action_entropy"] >= DATASET_GATES["action_entropy"],
            "shrink_ratio": stats["shrink_ratio"] >= DATASET_GATES["shrink_ratio"],
        }

        all_pass = all(checks.values())

        print(f"\n{'Metric':<20} {'Actual':>10} {'Target':>12} {'Status':>10}")
        print("-" * 55)

        noop_target = DATASET_GATES['noop_ratio']
        entropy_target = DATASET_GATES['action_entropy']
        shrink_target = DATASET_GATES['shrink_ratio']
        print(f"{'noop_ratio':<20} {stats['noop_ratio']:>10.1%} {'< ' + f'{noop_target:.0%}':>12} {'✅ PASS' if checks['noop_ratio'] else '❌ FAIL':>10}")
        print(f"{'action_entropy':<20} {stats['action_entropy']:>10.3f} {'> ' + f'{entropy_target}':>12} {'✅ PASS' if checks['action_entropy'] else '❌ FAIL':>10}")
        print(f"{'shrink_ratio':<20} {stats['shrink_ratio']:>10.1%} {'> ' + f'{shrink_target:.0%}':>12} {'✅ PASS' if checks['shrink_ratio'] else '❌ FAIL':>10}")

        print("\n" + "=" * 60)
        if all_pass:
            print("✅ ALL GATES PASSED - Ready for BC training")
        else:
            print("❌ GATES FAILED")
        print("=" * 60)

        return {"passed": all_pass, "checks": checks}


def process_dataset(
    input_path: str,
    output_path: str,
    verbose: bool = True,
) -> Tuple[str, Dict, Dict]:
    """
    处理 dataset

    Args:
        input_path: 输入文件路径
        output_path: 输出文件路径
        verbose: 是否打印详细输出

    Returns:
        (output_path, stats, gate_result)
    """
    if verbose:
        print("=" * 60)
        print("Action-Aware Dataset Processing")
        print("=" * 60)
        print(f"Input: {input_path}")

    # 加载 transitions
    transitions = []
    with open(input_path, 'r', encoding='utf-8') as f:
        for line in f:
            t = json.loads(line.strip())
            transitions.append(t)

    if verbose:
        print(f"Loaded {len(transitions):,} transitions")

    # 过滤
    filter_obj = ActionAwareFilter()
    filtered, filter_stats = filter_obj.filter_transitions(transitions, verbose=verbose)

    # 验证 gate
    gate_result = filter_obj.validate_gate(filter_stats)

    # 保存
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        for t in filtered:
            f.write(json.dumps(t, ensure_ascii=False) + '\n')

    if verbose:
        print(f"\nSaved {len(filtered):,} transitions to: {output_path}")

    return output_path, filter_stats, gate_result


def main():
    """主函数"""
    import glob

    # 查找最新的 v2 dataset
    datasets = glob.glob("datasets/teacher_dataset_v2_*.jsonl")
    if not datasets:
        print("No v2 dataset found. Run curriculum_rollout.py first.")
        return

    input_path = max(datasets, key=os.path.getmtime)
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    output_path = f"datasets/teacher_dataset_v3_{timestamp}.jsonl"

    # 处理
    output_path, stats, gate_result = process_dataset(input_path, output_path)

    # 保存 stats
    stats_path = output_path.replace(".jsonl", "_stats.json")
    with open(stats_path, 'w', encoding='utf-8') as f:
        json.dump(stats, f, indent=2, ensure_ascii=False)

    print(f"\nStats saved: {stats_path}")


if __name__ == "__main__":
    main()
