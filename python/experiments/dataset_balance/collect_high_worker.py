# -*- coding: utf-8 -*-
"""
Collect high worker count scenarios
"""

import sys
import os
import json
import random
import numpy as np
from collections import Counter
from typing import List, Dict

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.env import RuntimeEnvFactory


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


def run_episode_no_shrink(
    arrival_rate: float,
    burst_prob: float,
    duration: int,
    seed: int = None,
    initial_workers: int = 200,
    target_workers: int = 200,
) -> List[Dict]:
    """运行 episode，保持高 worker count"""
    if seed is not None:
        np.random.seed(seed)
        random.seed(seed)

    env = RuntimeEnvFactory.create(
        arrival_rate=arrival_rate,
        burst_prob=burst_prob,
        duration=duration,
    )

    # 先 reset
    obs, _ = env.reset(seed=seed if seed else None)

    # 设置初始 worker count（在 reset 之后）
    env.simulator.state.worker_count = initial_workers

    timeline = []

    warmup_ticks = 20

    for tick in range(duration):
        state = env.simulator.state
        queue_depth = state.queue_depth
        worker_count = state.worker_count
        cpu_usage = state.cpu_usage

        # 只做 noop
        action = 2  # noop

        next_obs, _, done, _, info = env.step(action)

        # 保持 worker count 在目标范围
        if worker_count < target_workers:
            env.simulator.state.worker_count = target_workers

        if tick >= warmup_ticks:
            zone = get_zone(queue_depth, worker_count)
            bucket = get_worker_bucket(worker_count)

            entry = {
                "tick": tick,
                "queue_depth": queue_depth,
                "worker_count": worker_count,
                "cpu_usage": cpu_usage,
                "action_index": action,
                "action_value": action - 2,  # index to value
                "zone": zone,
                "worker_bucket": bucket,
                "scenario": "high_worker",
            }
            timeline.append(entry)

        obs = next_obs
        if done:
            break

    return timeline


def main():
    """收集高 worker count 数据"""
    print("=" * 60)
    print("Collecting High Worker Count Scenarios")
    print("=" * 60)

    scenarios = [
        # High worker count with low load (no shrink needed)
        {"name": "high_idle_200", "arrival_rate": 5.0, "burst_prob": 0.0, "initial_workers": 200, "target_workers": 200, "episodes": 3},
        {"name": "high_idle_250", "arrival_rate": 5.0, "burst_prob": 0.0, "initial_workers": 250, "target_workers": 250, "episodes": 3},
        {"name": "high_idle_300", "arrival_rate": 5.0, "burst_prob": 0.0, "initial_workers": 300, "target_workers": 300, "episodes": 3},
        {"name": "high_light_200", "arrival_rate": 10.0, "burst_prob": 0.1, "initial_workers": 200, "target_workers": 200, "episodes": 3},
        {"name": "high_light_250", "arrival_rate": 10.0, "burst_prob": 0.1, "initial_workers": 250, "target_workers": 250, "episodes": 3},
        {"name": "high_light_300", "arrival_rate": 10.0, "burst_prob": 0.1, "initial_workers": 300, "target_workers": 300, "episodes": 3},
    ]

    all_entries = []

    for scenario in scenarios:
        print(f"\n[{scenario['name']}] workers={scenario['target_workers']}")

        for ep in range(scenario["episodes"]):
            seed = abs(hash(scenario["name"] + str(ep))) % (2**31)

            timeline = run_episode_no_shrink(
                arrival_rate=scenario["arrival_rate"],
                burst_prob=scenario["burst_prob"],
                duration=2000,
                seed=seed,
                initial_workers=scenario["initial_workers"],
                target_workers=scenario["target_workers"],
            )

            for entry in timeline:
                entry["episode"] = ep
                all_entries.append(entry)

        print(f"  Episodes {scenario['episodes']}: {scenario['episodes'] * 1980} entries")

    # 分析 bucket 分布
    bucket_counter = Counter()
    for entry in all_entries:
        bucket = get_worker_bucket(entry["worker_count"])
        bucket_counter[bucket] += 1

    total = len(all_entries)
    print(f"\n{'='*60}")
    print("Worker Bucket Distribution")
    print("="*60)
    for bucket in ["1-20", "20-50", "50-100", "100-200", "200+"]:
        count = bucket_counter.get(bucket, 0)
        ratio = count / total if total > 0 else 0
        print(f"  {bucket:<8}: {count:,} ({ratio:.1%})")

    # 保存
    output_path = "datasets/timeline_v3_1_high_worker.jsonl"
    with open(output_path, 'w', encoding='utf-8') as f:
        for entry in all_entries:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    print(f"\nSaved {len(all_entries)} entries to: {output_path}")


if __name__ == "__main__":
    main()
