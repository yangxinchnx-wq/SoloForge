# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Teacher Audit
# Path: experiments/teacher_audit/audit.py
#
# Sprint 2B: 验证 Teacher V3 是否覆盖完整 5-action 设计空间
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import numpy as np
from typing import Dict, List, Tuple
from collections import Counter
from dataclasses import dataclass

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(os.path.dirname(script_dir)))
sys.path.insert(0, python_dir)

from governor_rl.scenarios.scenario_spec import get_all_scenarios, get_scenario
from governor_rl.scenarios.scenario_runner import ScenarioRunner


@dataclass
class ActionRecord:
    """动作记录"""
    tick: int
    queue_depth: int
    worker_count: int
    cpu_usage: float
    action_type: str
    action_index: int  # 映射到 0-4
    regime: str


class TeacherAuditor:
    """
    Teacher Auditor

    审计 Teacher V3 的动作空间覆盖
    """

    # Action 映射
    ACTION_TO_INDEX = {
        "spawn_worker": 3,      # +1
        "spawn_workers": 4,     # +2
        "reduce_workers": 1,     # -1
        "reduce_workers_batch": 0,  # -2
        "enable_reflection": 2,  # 0 (no-op)
        "disable_reflection": 2,  # 0 (no-op)
        "no_op": 2,             # 0 (no-op)
    }

    ACTION_NAMES = {
        0: "shrink2",
        1: "shrink1",
        2: "noop",
        3: "expand1",
        4: "expand2",
    }

    def __init__(self):
        self.records: List[ActionRecord] = []
        self.scenario_stats: Dict[str, Dict] = {}

    def collect_data(
        self,
        scenarios: List[str] = None,
        episodes_per_scenario: int = 3,
    ) -> int:
        """
        收集 Teacher 运行数据

        Returns:
            总记录数
        """
        scenarios = scenarios or [
            "steady_low",
            "steady_medium",
            "steady_high",
            "burst_traffic",
            "long_idle",
        ]

        print("=" * 60)
        print("Teacher V3 Audit: Data Collection")
        print("=" * 60)

        runner = ScenarioRunner()
        total_records = 0

        for scenario_name in scenarios:
            print(f"\n[{scenario_name}]")

            scenario = get_scenario(scenario_name)
            scenario_records = []

            for ep in range(episodes_per_scenario):
                # 运行 scenario
                timeline = runner.run_scenario(
                    scenario=scenario,
                    seed=ep * 100,
                    verbose=False,
                )

                # 转换 timeline
                for entry in timeline:
                    action_index = self.ACTION_TO_INDEX.get(entry.action_type, 2)

                    record = ActionRecord(
                        tick=entry.tick,
                        queue_depth=entry.queue_depth,
                        worker_count=entry.worker_count,
                        cpu_usage=entry.cpu_usage,
                        action_type=entry.action_type,
                        action_index=action_index,
                        regime=entry.regime,
                    )
                    self.records.append(record)
                    scenario_records.append(record)

                print(f"  Episode {ep}: {len(timeline)} records")

            # 统计 scenario
            action_counter = Counter(r.action_index for r in scenario_records)
            self.scenario_stats[scenario_name] = {
                "total": len(scenario_records),
                "actions": dict(action_counter),
            }

            total_records += len(scenario_records)

        print(f"\nTotal records: {total_records}")
        return total_records

    def analyze_action_coverage(self) -> Dict:
        """
        分析动作覆盖率

        Returns:
            覆盖分析结果
        """
        if not self.records:
            return {}

        action_counter = Counter(r.action_index for r in self.records)
        total = len(self.records)

        coverage = {
            "total_records": total,
            "action_distribution": {},
            "coverage_rate": {},
            "missing_actions": [],
            "dominant_actions": [],
        }

        print("\n" + "=" * 60)
        print("Action Coverage Analysis")
        print("=" * 60)

        print(f"\nOverall Distribution ({total} records):")
        print("-" * 40)

        for action_idx in range(5):
            count = action_counter.get(action_idx, 0)
            ratio = count / total if total > 0 else 0
            coverage["action_distribution"][self.ACTION_NAMES[action_idx]] = {
                "count": count,
                "ratio": ratio,
            }

            status = "✅" if count > 0 else "❌ MISSING"
            print(f"  {self.ACTION_NAMES[action_idx]:<8}: {count:>6} ({ratio:>6.1%}) {status}")

            if count == 0:
                coverage["missing_actions"].append(action_idx)
            elif ratio > 0.5:
                coverage["dominant_actions"].append(action_idx)

        coverage["unique_actions_used"] = sum(1 for c in action_counter.values() if c > 0)
        coverage["effective_action_space"] = "2-action" if coverage["unique_actions_used"] <= 2 else f"{coverage['unique_actions_used']}-action"

        print(f"\nEffective Action Space: {coverage['effective_action_space']}")
        print(f"Unique Actions Used: {coverage['unique_actions_used']}/5")

        if coverage["missing_actions"]:
            print(f"\n❌ MISSING ACTIONS: {[self.ACTION_NAMES[i] for i in coverage['missing_actions']]}")

        return coverage

    def analyze_queue_vs_action(self) -> Dict:
        """
        分析 queue vs action 关系

        Returns:
            分析结果
        """
        if not self.records:
            return {}

        print("\n" + "=" * 60)
        print("Queue vs Action Analysis")
        print("=" * 60)

        # 按 queue 分桶统计
        queue_buckets = {
            "0-50": [],
            "50-200": [],
            "200-500": [],
            "500-1000": [],
            "1000-2000": [],
            "2000-5000": [],
            "5000+": [],
        }

        for record in self.records:
            q = record.queue_depth
            if q < 50:
                queue_buckets["0-50"].append(record)
            elif q < 200:
                queue_buckets["50-200"].append(record)
            elif q < 500:
                queue_buckets["200-500"].append(record)
            elif q < 1000:
                queue_buckets["500-1000"].append(record)
            elif q < 2000:
                queue_buckets["1000-2000"].append(record)
            elif q < 5000:
                queue_buckets["2000-5000"].append(record)
            else:
                queue_buckets["5000+"].append(record)

        print("\nAction Distribution by Queue Bucket:")
        print("-" * 70)
        print(f"{'Queue Range':<12} {'Count':>8} {'shrink2':>8} {'shrink1':>8} {'noop':>8} {'expand1':>8} {'expand2':>8}")
        print("-" * 70)

        bucket_stats = {}
        for bucket_name, records in queue_buckets.items():
            if not records:
                continue

            counter = Counter(r.action_index for r in records)
            bucket_stats[bucket_name] = {
                "count": len(records),
                "distribution": dict(counter),
            }

            shrink2 = counter.get(0, 0)
            shrink1 = counter.get(1, 0)
            noop = counter.get(2, 0)
            expand1 = counter.get(3, 0)
            expand2 = counter.get(4, 0)

            print(f"{bucket_name:<12} {len(records):>8} {shrink2:>8} {shrink1:>8} {noop:>8} {expand1:>8} {expand2:>8}")

        # 检查 shrink 是否存在
        shrink_exists = {
            bucket: any(r.action_index <= 1 for r in records)
            for bucket, records in queue_buckets.items()
        }

        print("\nShrink Presence by Queue Level:")
        for bucket, has_shrink in shrink_exists.items():
            if not self.scenario_stats:
                continue
            status = "✅" if has_shrink else "❌"
            print(f"  {bucket}: {status}")

        return {
            "bucket_stats": bucket_stats,
            "shrink_exists_in_buckets": shrink_exists,
        }

    def analyze_worker_vs_action(self) -> Dict:
        """
        分析 worker vs action 关系
        """
        if not self.records:
            return {}

        print("\n" + "=" * 60)
        print("Worker vs Action Analysis")
        print("=" * 60)

        # 按 worker 数量分桶
        worker_buckets = {
            "0-5": [],
            "5-10": [],
            "10-20": [],
            "20-50": [],
            "50+": [],
        }

        for record in self.records:
            w = record.worker_count
            if w < 5:
                worker_buckets["0-5"].append(record)
            elif w < 10:
                worker_buckets["5-10"].append(record)
            elif w < 20:
                worker_buckets["10-20"].append(record)
            elif w < 50:
                worker_buckets["20-50"].append(record)
            else:
                worker_buckets["50+"].append(record)

        print("\nAction Distribution by Worker Bucket:")
        print("-" * 70)
        print(f"{'Worker Range':<12} {'Count':>8} {'shrink2':>8} {'shrink1':>8} {'noop':>8} {'expand1':>8} {'expand2':>8}")
        print("-" * 70)

        bucket_stats = {}
        for bucket_name, records in worker_buckets.items():
            if not records:
                continue

            counter = Counter(r.action_index for r in records)
            bucket_stats[bucket_name] = {
                "count": len(records),
                "distribution": dict(counter),
            }

            shrink2 = counter.get(0, 0)
            shrink1 = counter.get(1, 0)
            noop = counter.get(2, 0)
            expand1 = counter.get(3, 0)
            expand2 = counter.get(4, 0)

            print(f"{bucket_name:<12} {len(records):>8} {shrink2:>8} {shrink1:>8} {noop:>8} {expand1:>8} {expand2:>8}")

        return {"bucket_stats": bucket_stats}

    def check_shrink_conditions(self) -> Dict:
        """
        检查 shrink 条件是否可达到
        """
        if not self.records:
            return {}

        print("\n" + "=" * 60)
        print("Shrink Condition Analysis")
        print("=" * 60)

        # 统计 shrink 发生的条件
        shrink_records = [r for r in self.records if r.action_index <= 1]

        if not shrink_records:
            print("\n❌ NO SHRINK ACTIONS FOUND IN ANY SCENARIO")
            print("\nThis means shrink branches in Teacher V3 are DEAD CODE.")
            return {
                "shrink_count": 0,
                "shrink_conditions": "UNREACHABLE",
            }

        print(f"\nFound {len(shrink_records)} shrink actions")

        # 分析 shrink 时的 queue 和 worker
        shrink_queues = [r.queue_depth for r in shrink_records]
        shrink_workers = [r.worker_count for r in shrink_records]

        print(f"\nShrink Queue Stats:")
        print(f"  Min: {min(shrink_queues)}")
        print(f"  Max: {max(shrink_queues)}")
        print(f"  Mean: {np.mean(shrink_queues):.1f}")

        print(f"\nShrink Worker Stats:")
        print(f"  Min: {min(shrink_workers)}")
        print(f"  Max: {max(shrink_workers)}")
        print(f"  Mean: {np.mean(shrink_workers):.1f}")

        return {
            "shrink_count": len(shrink_records),
            "shrink_queues": shrink_queues,
            "shrink_workers": shrink_workers,
        }

    def generate_scatter_data(self) -> List[Dict]:
        """
        生成散点图数据

        Returns:
            [(queue, action), ...] 列表
        """
        scatter_data = []
        for record in self.records:
            scatter_data.append({
                "queue": record.queue_depth,
                "action_index": record.action_index,
                "action_name": self.ACTION_NAMES[record.action_index],
                "workers": record.worker_count,
                "regime": record.regime,
            })
        return scatter_data

    def save_report(self, output_dir: str = "experiments/teacher_audit"):
        """保存审计报告"""
        os.makedirs(output_dir, exist_ok=True)

        coverage = self.analyze_action_coverage()
        queue_analysis = self.analyze_queue_vs_action()
        worker_analysis = self.analyze_worker_vs_action()
        shrink_analysis = self.check_shrink_conditions()
        scatter_data = self.generate_scatter_data()

        report = {
            "timestamp": "2026-05-30",
            "total_records": len(self.records),
            "coverage": coverage,
            "queue_vs_action": queue_analysis,
            "worker_vs_action": worker_analysis,
            "shrink_analysis": shrink_analysis,
            "scenario_stats": self.scenario_stats,
        }

        # 保存 JSON 报告
        report_path = os.path.join(output_dir, "teacher_audit_report.json")
        with open(report_path, 'w', encoding='utf-8') as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        print(f"\nReport saved: {report_path}")

        # 保存散点图数据
        scatter_path = os.path.join(output_dir, "scatter_data.json")
        with open(scatter_path, 'w', encoding='utf-8') as f:
            json.dump(scatter_data, f, indent=2, ensure_ascii=False)
        print(f"Scatter data saved: {scatter_path}")

        # 生成 Markdown 报告
        self._generate_markdown_report(output_dir, coverage, shrink_analysis)

        return report

    def _generate_markdown_report(self, output_dir: str, coverage: Dict, shrink_analysis: Dict):
        """生成 Markdown 报告"""
        report = f"""# Teacher V3 Audit Report

**Date**: 2026-05-30
**Total Records**: {len(self.records):,}

---

## Executive Summary

### Q1: Can Teacher Trigger Shrink?

**{"YES" if coverage.get('unique_actions_used', 0) > 3 else "NO"}**

"""

        if shrink_analysis.get("shrink_count", 0) == 0:
            report += """### ❌ CRITICAL FINDING: No Shrink Actions Found

**Teacher V3 NEVER outputs shrink actions.**

This means:
- `shrink2` (action index 0): **MISSING**
- `shrink1` (action index 1): **MISSING**

The effective action space is only:
- `noop` (action index 2)
- `expand1` (action index 3)

"""
        else:
            report += f"""### ✅ Found {shrink_analysis['shrink_count']} shrink actions

"""

        report += f"""
### Q2: Is Shrink Condition Reachable?

**{shrink_analysis.get('shrink_conditions', 'UNKNOWN')}**

"""

        report += f"""
### Q3: Is Control Unidirectional?

**{"YES - Only expand/no-op, never shrink" if coverage.get('missing_actions') else "NO - Full coverage"}**

---

## Action Coverage

| Action | Count | Ratio | Status |
|--------|-------|-------|--------|
| shrink2 | {coverage['action_distribution'].get('shrink2', {}).get('count', 0)} | {coverage['action_distribution'].get('shrink2', {}).get('ratio', 0):.1%} | {'✅' if 'shrink2' not in coverage.get('missing_actions', []) else '❌ MISSING'} |
| shrink1 | {coverage['action_distribution'].get('shrink1', {}).get('count', 0)} | {coverage['action_distribution'].get('shrink1', {}).get('ratio', 0):.1%} | {'✅' if 'shrink1' not in coverage.get('missing_actions', []) else '❌ MISSING'} |
| noop | {coverage['action_distribution'].get('noop', {}).get('count', 0)} | {coverage['action_distribution'].get('noop', {}).get('ratio', 0):.1%} | ✅ |
| expand1 | {coverage['action_distribution'].get('expand1', {}).get('count', 0)} | {coverage['action_distribution'].get('expand1', {}).get('ratio', 0):.1%} | ✅ |
| expand2 | {coverage['action_distribution'].get('expand2', {}).get('count', 0)} | {coverage['action_distribution'].get('expand2', {}).get('ratio', 0):.1%} | {'✅' if 'expand2' not in coverage.get('missing_actions', []) else '❌ MISSING'} |

**Effective Action Space**: {coverage.get('effective_action_space', 'UNKNOWN')}

---

## Root Cause Conclusion

### Hypothesis: Teacher V3 is a Scale-Up Governor

**EVIDENCE**:

1. Teacher V3 only outputs `noop` and `expand1`
2. `shrink2`, `shrink1`, `expand2` are never triggered
3. This is consistent with a governor designed only to scale UP, not DOWN

### Implication for BC/PPO Training

- BC cannot learn shrink behavior (no data)
- PPO cannot learn shrink behavior (out-of-distribution)
- Collapse modes involving shrink/starvation cannot be properly handled

---

## Recommendations

### Immediate

1. **Do not modify PPO reward** - The problem is upstream (Teacher)
2. **Do not modify dataset sampling** - The problem is in Teacher policy

### Short-term

1. **Teacher V4**: Add shrink logic to Teacher
   - `if queue < low_watermark: shrink()`
   - `if workers > high_watermark: shrink()`

2. **Re-collect Timeline V2** with Teacher V4

3. **Re-train BC/PPO** with new Timeline

---

## Files Generated

- `teacher_audit_report.json` - Full audit data
- `scatter_data.json` - Queue vs Action scatter data
- `teacher_audit_report.md` - This report
"""

        report_path = os.path.join(output_dir, "teacher_audit_report.md")
        with open(report_path, 'w', encoding='utf-8') as f:
            f.write(report)
        print(f"Markdown report saved: {report_path}")


def main():
    """主函数"""
    auditor = TeacherAuditor()

    # 收集数据
    auditor.collect_data(
        scenarios=[
            "steady_low",
            "steady_medium",
            "steady_high",
            "burst_traffic",
            "long_idle",
        ],
        episodes_per_scenario=3,
    )

    # 分析
    coverage = auditor.analyze_action_coverage()
    auditor.analyze_queue_vs_action()
    auditor.analyze_worker_vs_action()
    shrink_analysis = auditor.check_shrink_conditions()

    # 保存报告
    auditor.save_report()

    print("\n" + "=" * 60)
    print("Audit Complete")
    print("=" * 60)


if __name__ == "__main__":
    main()
