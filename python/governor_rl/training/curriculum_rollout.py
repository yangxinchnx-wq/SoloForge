# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Curriculum Rollout
# Path: python/governor_rl/training/curriculum_rollout.py
#
# Stage 1: Timeline 收集
# 使用 AdaptiveGovernorV3 作为 Teacher
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import numpy as np
from typing import List, Dict
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.scenarios.scenario_spec import get_all_scenarios, get_scenario
from governor_rl.scenarios.scenario_runner import ScenarioRunner
from governor_rl.training.dataset_sampler import sample_transitions


# 所有场景
ALL_SCENARIOS = [
    "steady_low",
    "steady_medium",
    "steady_high",
    "burst_traffic",
    "long_idle",
    "cpu_spike",
    "worker_failure",
    "queue_flood",
    "precursor_trigger",
    "oscillation_trigger",
    "saturation_trigger",
    "recovery_trigger",
    "worker_crash_recovery",
    "gradual_relief",
    "oscillation_decay",
]


def run_teacher_rollout(
    governor: str = "AdaptiveGovernorV3",
    ticks: int = 5000,
    scenario_name: str = None,
    seed: int = None,
) -> List[Dict]:
    """
    运行 Teacher Rollout

    Args:
        governor: Governor 类型
        ticks: 运行 tick 数
        scenario_name: 场景名称
        seed: 随机种子

    Returns:
        List[Dict]: timeline entries
    """
    # 创建 Teacher
    if governor == "AdaptiveGovernorV3":
        from training.simulator.adaptive_governor import AdaptiveGovernorV3
        teacher = AdaptiveGovernorV3()

    # 创建场景运行器
    runner = ScenarioRunner()

    # 获取场景
    if scenario_name:
        scenario = get_scenario(scenario_name)
    else:
        # 默认中等负载场景
        scenario = get_scenario("steady_medium")

    # 运行
    timeline = runner.run_scenario(
        scenario=scenario,
        teacher=teacher,
        seed=seed,
        verbose=False,
    )

    return timeline


def collect_rollouts(
    output_path: str = "datasets/dataset_v1/train.jsonl",
    ticks_per_scenario: int = 5000,
) -> Dict:
    """
    收集所有场景的 rollouts

    Args:
        output_path: 输出路径
        ticks_per_scenario: 每个场景的 tick 数
        output_path: 输出路径

    Returns:
        Dict: 统计信息
    """
    print("=" * 60)
    print("Timeline Collection")
    print("=" * 60)
    print(f"Scenarios: {len(ALL_SCENARIOS)}")
    print(f"Ticks per scenario: {ticks_per_scenario}")

    all_timelines = []
    stats = {
        "total_entries": 0,
        "phase_distribution": {},
        "action_distribution": {},
    }

    for i, scenario_name in enumerate(ALL_SCENARIOS):
        print(f"[{i+1}/{len(ALL_SCENARIOS)}] {scenario_name}...", end=" ")

        timeline = run_teacher_rollout(
            governor="AdaptiveGovernorV3",
            ticks=ticks_per_scenario,
            scenario_name=scenario_name,
            seed=i * 100,
        )

        # 转换 timeline 为 transition 格式
        for entry in timeline:
            transition = {
                "obs": _entry_to_obs(entry),
                "action": _action_to_index(entry.action_type),
                "reward": 0.0,  # reward 由环境计算
                "phase": _infer_phase(entry),
                "queue_depth": entry.queue_depth,
                "worker_count": entry.worker_count,
            }
            all_timelines.append(transition)

        print(f"{len(timeline)} entries")

    # 统计
    print("\n" + "=" * 60)
    print("Collection Stats")
    print("=" * 60)
    print(f"Total entries: {len(all_timelines)}")

    # 保存
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        for t in all_timelines:
            f.write(json.dumps(t, ensure_ascii=False) + '\n')

    print(f"Saved to: {output_path}")

    return stats


def _entry_to_obs(entry) -> List[float]:
    """从 TimelineEntry 构建 obs"""
    # 从 regime 字符串推断 regime_id
    regime_map = {
        "healthy": 0.0,
        "balanced": 0.2,
        "oscillating": 0.4,
        "over_responsive": 0.6,
        "under_responsive": 0.8,
        "critical": 1.0,
    }
    regime_id = regime_map.get(entry.regime, 0.5)

    return [
        entry.queue_depth / 1000.0,
        0.0,  # velocity (简化)
        0.0,  # acceleration (简化)
        entry.worker_count / 200.0,
        entry.cpu_usage,
        entry.precursor_score,
        0.0,  # risk_score (简化)
        entry.oscillation_score,
        regime_id,
    ]


def _action_to_index(action_type: str) -> int:
    """将 action_type 转换为 index"""
    mapping = {
        "spawn_worker": 3,
        "spawn_workers": 4,
        "reduce_workers": 1,
        "reduce_workers_batch": 0,
        "enable_reflection": 2,
        "disable_reflection": 2,
        "no_op": 2,
    }
    return mapping.get(action_type, 2)


def _infer_phase(entry) -> str:
    """从 TimelineEntry 推断 phase"""
    # 基于 queue_depth 和 regime 推断 phase
    queue = entry.queue_depth
    regime = entry.regime.lower()

    if "oscillat" in regime or entry.oscillation_score > 0.3:
        return "oscillating"
    elif queue > 2000:
        return "precursor"
    elif queue > 500:
        return "saturated"
    elif regime in ["healthy", "balanced"]:
        return "stable"
    else:
        return "unknown"


def main():
    """主函数"""
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    output_path = f"datasets/dataset_v1/train_{timestamp}.jsonl"

    collect_rollouts(output_path=output_path)


if __name__ == "__main__":
    main()
