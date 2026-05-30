# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: High Worker Coverage Collection
# Path: experiments/dataset_balance/collect_high_worker_v2.py
#
# Sprint 3.7A: High Worker Coverage
# 目标: 收集 worker_count > 200 的数据
# ─────────────────────────────────────────────────────────────────

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

from governor_rl.training.simulator.teacher_v4 import TeacherV4
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


# Action mapping
ACTION_VALUE_TO_INDEX = {-2: 0, -1: 1, 0: 2, 1: 3, 2: 4}


def run_large_cluster_episode(
    initial_workers: int,
    initial_queue: int,
    arrival_rate: float,
    burst_prob: float,
    duration: int,
    seed: int = None,
) -> List[Dict]:
    """运行大集群 episode"""
    if seed is not None:
        np.random.seed(seed)
        random.seed(seed)

    env = RuntimeEnvFactory.create(
        arrival_rate=arrival_rate,
        burst_prob=burst_prob,
        duration=duration,
    )

    # 直接设置状态（绕过 reset）
    env.simulator.state.worker_count = initial_workers
    env.simulator.state.queue_depth = initial_queue
    env.simulator._tick_count = 0

    # 创建 Teacher V4
    teacher = TeacherV4()

    timeline = []
    warmup_ticks = 5

    for tick in range(duration):
        state = env.simulator.state
        queue_depth = state.queue_depth
        worker_count = state.worker_count
        cpu_usage = state.cpu_usage

        # Teacher V4 决策
        action_value = teacher.decide(
            queue_depth=queue_depth,
            worker_count=worker_count,
        )
        action_index = ACTION_VALUE_TO_INDEX[action_value]

        # 执行动作
        next_obs, _, done, _, info = env.step(action_index)

        if tick >= warmup_ticks:
            zone = get_zone(queue_depth, worker_count)
            bucket = get_worker_bucket(worker_count)

            entry = {
                "tick": tick,
                "queue_depth": queue_depth,
                "worker_count": worker_count,
                "cpu_usage": cpu_usage,
                "action_index": action_index,
                "action_value": action_value,
                "zone": zone,
                "worker_bucket": bucket,
            }
            timeline.append(entry)

        # 如果 worker_count 降到 200 以下，重置
        if worker_count < 200 and tick > 100:
            env.simulator.state.worker_count = initial_workers
            env.simulator.state.queue_depth = initial_queue

        if done:
            break

    return timeline


def main():
    """收集高 worker count 数据"""
    print("=" * 60)
    print("Sprint 3.7A: High Worker Coverage")
    print("=" * 60)

    scenarios = [
        # Large cluster scenarios (初始 worker_count >= 200)
        {"name": "large_200", "workers": 200, "queue": 100, "arrival": 5.0, "burst": 0.0, "episodes": 10},
        {"name": "large_200_stress", "workers": 200, "queue": 300, "arrival": 10.0, "burst": 0.2, "episodes": 10},
        {"name": "large_250", "workers": 250, "queue": 200, "arrival": 5.0, "burst": 0.0, "episodes": 10},
        {"name": "large_250_stress", "workers": 250, "queue": 400, "arrival": 15.0, "burst": 0.3, "episodes": 10},
        {"name": "large_300", "workers": 300, "queue": 300, "arrival": 5.0, "burst": 0.0, "episodes": 10},
        {"name": "large_300_stress", "workers": 300, "queue": 500, "arrival": 20.0, "burst": 0.3, "episodes": 10},
        {"name": "large_350", "workers": 350, "queue": 400, "arrival": 8.0, "burst": 0.1, "episodes": 10},
        {"name": "large_400", "workers": 400, "queue": 500, "arrival": 10.0, "burst": 0.1, "episodes": 10},
    ]

    all_entries = []

    for scenario in scenarios:
        print(f"\n[{scenario['name']}] workers={scenario['workers']}, queue={scenario['queue']}")

        for ep in range(scenario["episodes"]):
            seed = abs(hash(scenario["name"] + str(ep))) % (2**31)

            timeline = run_large_cluster_episode(
                initial_workers=scenario["workers"],
                initial_queue=scenario["queue"],
                arrival_rate=scenario["arrival"],
                burst_prob=scenario["burst"],
                duration=3000,
                seed=seed,
            )

            for entry in timeline:
                entry["scenario"] = scenario["name"]
                entry["episode"] = ep
                all_entries.append(entry)

        print(f"  Episodes {scenario['episodes']}: {scenario['episodes'] * 2995} entries")

    # 分析
    bucket_counter = Counter(e["worker_bucket"] for e in all_entries)
    worker_stats = [e["worker_count"] for e in all_entries]

    print(f"\n{'='*60}")
    print("Worker Bucket Distribution")
    print("="*60)

    for bucket in ["1-20", "20-50", "50-100", "100-200", "200+"]:
        count = bucket_counter.get(bucket, 0)
        ratio = count / len(all_entries) if all_entries else 0
        status = "✅" if ratio >= 0.05 else "❌"
        print(f"  {bucket:<8}: {count:,} ({ratio:.1%}) {status}")

    if worker_stats:
        print(f"\nWorker Count Stats:")
        print(f"  Min: {min(worker_stats)}")
        print(f"  Max: {max(worker_stats)}")
        print(f"  Mean: {np.mean(worker_stats):.1f}")

    # 保存
    output_path = "datasets/timeline_v3_1_large_cluster.jsonl"
    with open(output_path, 'w', encoding='utf-8') as f:
        for entry in all_entries:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    print(f"\nSaved {len(all_entries):,} entries to: {output_path}")

    return {
        "total": len(all_entries),
        "bucket_distribution": dict(bucket_counter),
        "worker_stats": {
            "min": min(worker_stats) if worker_stats else 0,
            "max": max(worker_stats) if worker_stats else 0,
            "mean": np.mean(worker_stats) if worker_stats else 0,
        },
    }


if __name__ == "__main__":
    result = main()
