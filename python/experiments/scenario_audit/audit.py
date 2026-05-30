# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Scenario Audit
# Path: experiments/scenario_audit/audit.py
#
# Sprint 2D: 分析为什么 95.7% 状态落在 Zone E
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import numpy as np
from typing import Dict, List
from collections import Counter

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(os.path.dirname(script_dir)))
sys.path.insert(0, python_dir)

from governor_rl.training.simulator.teacher_v4 import TeacherV4
from governor_rl.env import RuntimeEnvFactory


# Zone 定义
ZONES = {
    "A": (0, 20),      # queue <= 20
    "B": (20, 100),    # 20 < queue <= 100
    "C": (100, 500),   # 100 < queue <= 500
    "D": (500, 2000),  # 500 < queue <= 2000
    "E": (2000, float('inf')),  # queue > 2000
}


def get_zone(queue: int) -> str:
    """获取 queue 所属 Zone"""
    for zone, (low, high) in ZONES.items():
        if low < queue <= high:
            return zone
    if queue <= 0:
        return "A"
    return "E"


def run_scenario(
    name: str,
    arrival_rate: float,
    burst_prob: float,
    duration: int = 5000,
    seed: int = None,
) -> Dict:
    """
    运行单个场景并收集指标

    Returns:
        场景指标
    """
    if seed is not None:
        np.random.seed(seed)

    # 创建环境
    env = RuntimeEnvFactory.create(
        arrival_rate=arrival_rate,
        burst_prob=burst_prob,
        duration=duration,
    )

    teacher = TeacherV4()
    obs, _ = env.reset()

    # 收集数据
    queues = []
    workers = []
    arrivals = []
    actions = []
    zones = []
    load_ratios = []

    for tick in range(duration):
        state = env.simulator.state
        queue = state.queue_depth
        worker = state.worker_count

        # 计算 load ratio
        # effective_processing_rate ≈ worker_count * base_rate
        # 假设 base_rate = 1.0 per worker
        effective_rate = max(worker, 1)
        load_ratio = arrival_rate / effective_rate if effective_rate > 0 else 1.0

        # Teacher V4 决策
        action_value = teacher.decide(queue_depth=queue, worker_count=worker)

        # 转换: action value (-2, -1, 0, +1, +2) -> action index (0-4)
        value_to_index = {-2: 0, -1: 1, 0: 2, +1: 3, +2: 4}
        action_index = value_to_index.get(action_value, 2)

        queues.append(queue)
        workers.append(worker)
        arrivals.append(arrival_rate)
        actions.append(action_index)
        zones.append(get_zone(queue))
        load_ratios.append(load_ratio)

        # 执行: action index -> action value -> env step
        index_to_value = {0: -2, 1: -1, 2: 0, 3: +1, 4: +2}
        env_action = index_to_value.get(action_index, 0)
        next_obs, _, done, _, _ = env.step(env_action)
        obs = next_obs

        if done:
            break

    return {
        "name": name,
        "arrival_rate": arrival_rate,
        "burst_prob": burst_prob,
        "duration": len(queues),
        "queues": queues,
        "workers": workers,
        "arrivals": arrivals,
        "actions": actions,
        "zones": zones,
        "load_ratios": load_ratios,
    }


def compute_metrics(scenario: Dict) -> Dict:
    """计算场景指标"""
    queues = np.array(scenario["queues"])
    workers = np.array(scenario["workers"])
    load_ratios = np.array(scenario["load_ratios"])
    zones = scenario["zones"]

    # Queue histogram by zone
    zone_counts = Counter(zones)
    total = len(zones)
    zone_distribution = {
        zone: zone_counts.get(zone, 0) / total
        for zone in ["A", "B", "C", "D", "E"]
    }

    # Queue statistics
    queue_stats = {
        "mean": float(np.mean(queues)),
        "median": float(np.median(queues)),
        "p10": float(np.percentile(queues, 10)),
        "p50": float(np.percentile(queues, 50)),
        "p90": float(np.percentile(queues, 90)),
        "p99": float(np.percentile(queues, 99)),
        "max": float(np.max(queues)),
        "min": float(np.min(queues)),
    }

    # Load ratio statistics
    load_stats = {
        "mean": float(np.mean(load_ratios)),
        "median": float(np.median(load_ratios)),
        "p90": float(np.percentile(load_ratios, 90)),
        "p99": float(np.percentile(load_ratios, 99)),
    }

    # Worker utilization
    # 假设 max_workers ≈ 50, 但我们用实际观察到的情况
    worker_stats = {
        "mean": float(np.mean(workers)),
        "median": float(np.median(workers)),
        "p90": float(np.percentile(workers, 90)),
        "p99": float(np.percentile(workers, 99)),
        "max": float(np.max(workers)),
        "min": float(np.min(workers)),
    }

    # System over-loaded ratio
    overload_ratio = float(np.mean(load_ratios > 1.0))

    return {
        "zone_distribution": zone_distribution,
        "queue_stats": queue_stats,
        "load_stats": load_stats,
        "worker_stats": worker_stats,
        "overload_ratio": overload_ratio,
    }


def print_metrics(scenario_name: str, metrics: Dict):
    """打印指标"""
    print(f"\n{'='*60}")
    print(f"Scenario: {scenario_name}")
    print(f"Arrival Rate: {metrics.get('arrival_rate', 'N/A')}")
    print(f"{'='*60}")

    print("\n[Zone Distribution]")
    for zone in ["A", "B", "C", "D", "E"]:
        ratio = metrics["zone_distribution"].get(zone, 0)
        bar = "█" * int(ratio * 50)
        print(f"  Zone {zone}: {ratio:>6.1%} {bar}")

    print("\n[Queue Stats]")
    stats = metrics["queue_stats"]
    print(f"  Mean:   {stats['mean']:>10.1f}")
    print(f"  Median: {stats['median']:>10.1f}")
    print(f"  P90:    {stats['p90']:>10.1f}")
    print(f"  P99:    {stats['p99']:>10.1f}")
    print(f"  Max:    {stats['max']:>10.1f}")

    print("\n[Load Ratio Stats]")
    load = metrics["load_stats"]
    print(f"  Mean:   {load['mean']:>10.2f}")
    print(f"  P90:    {load['p90']:>10.2f}")
    print(f"  Overload Ratio: {metrics['overload_ratio']:>6.1%}")

    print("\n[Worker Stats]")
    w = metrics["worker_stats"]
    print(f"  Mean: {w['mean']:>8.1f}")
    print(f"  Max:  {w['max']:>8.1f}")


def audit_scenarios(
    scenarios: List[Dict] = None,
    episodes_per_scenario: int = 3,
) -> Dict:
    """
    审计所有场景

    Returns:
        审计报告
    """
    if scenarios is None:
        # Sprint 2E: Zone-Coverage Scenarios (Reduced burst for stability)
        scenarios = [
            # Zone A (queue <= 20) - 极低负载
            {"name": "zone_a_under_utilized", "arrival_rate": 3.0, "burst_prob": 0.05},
            {"name": "zone_a_light", "arrival_rate": 5.0, "burst_prob": 0.05},
            # Zone B (20 < queue <= 100) - 低负载
            {"name": "zone_b_light", "arrival_rate": 15.0, "burst_prob": 0.05},
            {"name": "zone_b_oscillating", "arrival_rate": 20.0, "burst_prob": 0.10},
            # Zone C (100 < queue <= 500) - 中等负载
            {"name": "zone_c_balanced", "arrival_rate": 35.0, "burst_prob": 0.05},
            {"name": "zone_c_stressed", "arrival_rate": 45.0, "burst_prob": 0.05},
            # Zone D (500 < queue <= 2000) - 高负载
            {"name": "zone_d_heavy", "arrival_rate": 60.0, "burst_prob": 0.05},
            {"name": "zone_d_burst", "arrival_rate": 55.0, "burst_prob": 0.10},
            # Zone E (queue > 2000) - 危机负载
            {"name": "zone_e_crisis", "arrival_rate": 80.0, "burst_prob": 0.10},
            {"name": "zone_e_saturation", "arrival_rate": 70.0, "burst_prob": 0.15},
        ]

    print("=" * 60)
    print("Scenario Audit")
    print("=" * 60)

    all_results = []
    aggregated_zones = Counter()
    total_ticks = 0

    for scenario in scenarios:
        print(f"\n[{scenario['name']}] arrival_rate={scenario['arrival_rate']}, burst_prob={scenario['burst_prob']}")

        scenario_metrics_list = []

        for ep in range(episodes_per_scenario):
            result = run_scenario(
                name=scenario["name"],
                arrival_rate=scenario["arrival_rate"],
                burst_prob=scenario["burst_prob"],
                duration=5000,
                seed=int(scenario["arrival_rate"] * 1000 + ep * 100),
            )

            metrics = compute_metrics(result)
            metrics["arrival_rate"] = scenario["arrival_rate"]
            metrics["burst_prob"] = scenario["burst_prob"]

            scenario_metrics_list.append(metrics)
            total_ticks += len(result["queues"])

            print(f"  Episode {ep}: {len(result['queues'])} ticks")

        # 聚合场景指标
        avg_zone_dist = {}
        for zone in ["A", "B", "C", "D", "E"]:
            avg_zone_dist[zone] = np.mean([m["zone_distribution"].get(zone, 0) for m in scenario_metrics_list])

        for zone, ratio in avg_zone_dist.items():
            aggregated_zones[zone] += ratio * scenario_metrics_list[0]["queue_stats"]["mean"]  # 加权

        all_results.append({
            "scenario": scenario["name"],
            "metrics": scenario_metrics_list,
            "avg_zone_distribution": avg_zone_dist,
        })

    # 归一化聚合 Zone 分布
    total_weight = sum(aggregated_zones.values())
    normalized_zones = {
        zone: count / total_weight if total_weight > 0 else 0
        for zone, count in aggregated_zones.items()
    }

    return {
        "scenarios": all_results,
        "aggregated_zone_distribution": normalized_zones,
        "total_ticks": total_ticks,
    }


def print_aggregated_report(report: Dict):
    """打印聚合报告"""
    print("\n" + "=" * 60)
    print("AGGREGATED REPORT")
    print("=" * 60)

    print("\n[Overall Zone Distribution]")
    zones = report["aggregated_zone_distribution"]
    for zone in ["A", "B", "C", "D", "E"]:
        ratio = zones.get(zone, 0)
        bar = "█" * int(ratio * 50)
        print(f"  Zone {zone}: {ratio:>6.1%} {bar}")

    print("\n[Per-Scenario Zone Distribution]")
    print("-" * 70)
    print(f"{'Scenario':<20} {'A':>8} {'B':>8} {'C':>8} {'D':>8} {'E':>8}")
    print("-" * 70)

    for result in report["scenarios"]:
        avg_dist = result["avg_zone_distribution"]
        a = avg_dist.get("A", 0)
        b = avg_dist.get("B", 0)
        c = avg_dist.get("C", 0)
        d = avg_dist.get("D", 0)
        e = avg_dist.get("E", 0)
        print(f"{result['scenario']:<20} {a:>7.1%} {b:>7.1%} {c:>7.1%} {d:>7.1%} {e:>7.1%}")


def generate_dashboard(report: Dict) -> str:
    """生成 Markdown Dashboard"""
    dashboard = """# Scenario Audit Report

**Date**: 2026-05-30
**Total Ticks**: {total_ticks:,}

---

## Question

**Why is 95.7% of Timeline V2 in Zone E?**

---

## Answer: System Overloading

### Zone Distribution (Aggregated)

| Zone | Range | Distribution | Status |
|------|-------|--------------|--------|
| A | queue <= 20 | {zone_A:.1%} | {status_A} |
| B | 20 < q <= 100 | {zone_B:.1%} | {status_B} |
| C | 100 < q <= 500 | {zone_C:.1%} | {status_C} |
| D | 500 < q <= 2000 | {zone_D:.1%} | {status_D} |
| E | q > 2000 | {zone_E:.1%} | {status_E} |

---

## Root Cause

### Load Imbalance

Current scenarios use:
- arrival_rate: 5.0 - 30.0
- service_rate: ~10.0 (workers)

**Result**: mean(load_ratio) > 1.0

This means the system is **naturally overloaded**, causing:
- Queue continuously grows
- Teacher V4 correctly responds with expand2
- 95.7% time in Zone E

---

## Solution: Scenario Rebalancing

Design scenarios to cover all zones:

| Zone | Target | Scenario |
|------|--------|----------|
| A (0-20) | 10-15% | Low load (arrival=5, service=10) |
| B (20-100) | 10-20% | Light load (arrival=8, service=10) |
| C (100-500) | 20-40% | Balanced (arrival=10, service=10) |
| D (500-2000) | 10-20% | Stressed (arrival=15, service=10) |
| E (>2000) | 10-15% | Crisis (arrival=30, service=10) |

---

## Recommendations

1. **Rebalance Scenario Weights**
   - Reduce high-load scenario frequency
   - Increase low/balanced scenario frequency

2. **Recalibrate arrival_rate**
   - Match to service capacity
   - Target load_ratio ≈ 0.8-1.2

3. **Recollect Timeline V3**
   - With balanced scenarios
   - Target balanced action distribution

---

## Per-Scenario Breakdown

| Scenario | Zone A | Zone B | Zone C | Zone D | Zone E |
|----------|--------|--------|--------|--------|--------|
""".format(
        total_ticks=report["total_ticks"],
        zone_A=report["aggregated_zone_distribution"].get("A", 0),
        zone_B=report["aggregated_zone_distribution"].get("B", 0),
        zone_C=report["aggregated_zone_distribution"].get("C", 0),
        zone_D=report["aggregated_zone_distribution"].get("D", 0),
        zone_E=report["aggregated_zone_distribution"].get("E", 0),
        status_A="⚠️ Low" if report["aggregated_zone_distribution"].get("A", 0) < 0.05 else "✅",
        status_B="⚠️ Low" if report["aggregated_zone_distribution"].get("B", 0) < 0.05 else "✅",
        status_C="⚠️ Low" if report["aggregated_zone_distribution"].get("C", 0) < 0.05 else "✅",
        status_D="⚠️ Low" if report["aggregated_zone_distribution"].get("D", 0) < 0.05 else "✅",
        status_E="❌ Overloaded" if report["aggregated_zone_distribution"].get("E", 0) > 0.8 else "⚠️ High",
    )

    for result in report["scenarios"]:
        avg = result["avg_zone_distribution"]
        dashboard += f"| {result['scenario']} | {avg.get('A', 0):.1%} | {avg.get('B', 0):.1%} | {avg.get('C', 0):.1%} | {avg.get('D', 0):.1%} | {avg.get('E', 0):.1%} |\n"

    dashboard += """
---

## Next Step: Sprint 2E

**Scenario Rebalancing**

Design 5 scenario categories to match zone distribution targets.
"""

    return dashboard


def main():
    """主函数"""
    # 运行审计
    report = audit_scenarios()

    # 打印聚合报告
    print_aggregated_report(report)

    # 生成 Dashboard
    dashboard = generate_dashboard(report)

    # 保存
    output_dir = "experiments/scenario_audit"
    os.makedirs(output_dir, exist_ok=True)

    dashboard_path = os.path.join(output_dir, "scenario_audit_dashboard.md")
    with open(dashboard_path, 'w', encoding='utf-8') as f:
        f.write(dashboard)
    print(f"\nDashboard saved: {dashboard_path}")

    # 保存 JSON
    # 移除大量数据以保持文件小
    json_report = {
        "aggregated_zone_distribution": report["aggregated_zone_distribution"],
        "total_ticks": report["total_ticks"],
    }
    json_path = os.path.join(output_dir, "scenario_audit_report.json")
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(json_report, f, indent=2)
    print(f"JSON saved: {json_path}")


if __name__ == "__main__":
    main()
