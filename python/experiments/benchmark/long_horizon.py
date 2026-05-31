# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Long Horizon Benchmark
# Path: experiments/benchmark/long_horizon.py
#
# Task 1.3: 长周期稳定性测试（10000 ticks）
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import torch
import torch.nn as nn
import numpy as np
from typing import Dict

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.env.runtime_env import RuntimeEnv
from governor_rl.training.simulator.teacher_v4 import TeacherV4


class PolicyNetworkV2(nn.Module):
    def __init__(self, input_dim: int = 10, hidden_dim: int = 128, num_actions: int = 5):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, num_actions),
        )

    def forward(self, x):
        return self.net(x)


def compute_load_ratio(queue_depth: int, worker_count: int) -> float:
    return queue_depth / max(worker_count * 2, 1)


def get_zone_id(queue_depth: int, worker_count: int) -> int:
    lr = compute_load_ratio(queue_depth, worker_count)
    if lr < 0.1: return 0
    elif lr < 0.25: return 1
    elif lr < 0.5: return 2
    elif lr < 1.0: return 3
    else: return 4


def build_features(queue_depth: int, worker_count: int, cpu_usage: float = 0.5) -> np.ndarray:
    zone_id = get_zone_id(queue_depth, worker_count)
    load_ratio = compute_load_ratio(queue_depth, worker_count)
    max_lr = 21.5
    lr_norm = np.log(1 + load_ratio) / np.log(1 + max_lr)
    obs = np.array([
        queue_depth / 1000.0, 0.0, 0.0,
        worker_count / 200.0, cpu_usage,
        0.0, 0.0, 0.0,
        zone_id / 4.0, lr_norm,
    ], dtype=np.float32)
    return obs


class BCAgent:
    def __init__(self, model_path: str):
        checkpoint = torch.load(model_path, map_location='cpu')
        input_dim = checkpoint.get('input_dim', 10)
        self.model = PolicyNetworkV2(input_dim=input_dim)
        self.model.load_state_dict(checkpoint['policy_state_dict'])
        self.model.eval()

    def act(self, queue_depth: int, worker_count: int) -> int:
        obs = build_features(queue_depth, worker_count)
        obs_tensor = torch.FloatTensor(obs).unsqueeze(0)
        with torch.no_grad():
            return torch.argmax(self.model(obs_tensor), dim=-1).item()


def run_long_horizon(
    bc_model_path: str = "checkpoints/bc_policy_v3_1_clean.pt",
    max_ticks: int = 10000,
    n_episodes: int = 10,
) -> Dict:
    """运行 Long Horizon Benchmark"""
    print("=" * 60)
    print("LONG HORIZON BENCHMARK")
    print("=" * 60)
    print(f"Model: {bc_model_path}")
    print(f"Max ticks per episode: {max_ticks}")
    print(f"Episodes: {n_episodes}")

    bc_agent = BCAgent(bc_model_path)

    collapse_count = 0
    episode_stats = []

    for ep in range(n_episodes):
        env = RuntimeEnv(
            duration=max_ticks,
            arrival_rate=15.0,
            burst_prob=0.15,
            seed=ep,
        )

        obs, _ = env.reset()
        total_reward = 0.0
        q_max = 0
        w_max = 0
        w_min = float('inf')
        teacher_match = 0
        total_steps = 0

        teacher = TeacherV4()

        for tick in range(max_ticks):
            state = env.simulator.state
            q, w = state.queue_depth, state.worker_count

            # BC 决策
            action = bc_agent.act(q, w)

            # Teacher 决策
            action_value = teacher.decide(q, w)
            teacher_action = action_value + 2
            if action == teacher_action:
                teacher_match += 1
            total_steps += 1

            obs, reward, terminated, truncated, info = env.step(action)
            total_reward += reward
            q_max = max(q_max, q)
            w_max = max(w_max, w)
            w_min = min(w_min, w)

            if terminated:
                break

        collapse = state.queue_depth > 50000
        if collapse:
            collapse_count += 1

        stats = {
            "episode": ep,
            "survival": not collapse,
            "total_reward": total_reward,
            "max_queue": q_max,
            "max_workers": w_max,
            "min_workers": w_min,
            "duration": tick + 1,
            "teacher_match_rate": teacher_match / total_steps if total_steps > 0 else 0.0,
        }
        episode_stats.append(stats)

        status = "COLLAPSED" if collapse else "OK"
        print(f"  Ep {ep:2d}: {status}, reward={total_reward:.0f}, "
              f"q_max={q_max:>6}, w=[{w_min:.0f},{w_max:.0f}], "
              f"duration={tick+1:>5}, teacher={stats['teacher_match_rate']:.1%}")

    # 汇总
    avg_reward = np.mean([e["total_reward"] for e in episode_stats])
    avg_q_max = np.mean([e["max_queue"] for e in episode_stats])
    avg_teacher = np.mean([e["teacher_match_rate"] for e in episode_stats])

    summary = {
        "n_episodes": n_episodes,
        "max_ticks": max_ticks,
        "collapse_count": collapse_count,
        "survival_rate": (n_episodes - collapse_count) / n_episodes,
        "avg_total_reward": float(avg_reward),
        "avg_max_queue": float(avg_q_max),
        "avg_teacher_match": float(avg_teacher),
        "episodes": episode_stats,
    }

    print("\n" + "=" * 60)
    print("LONG HORIZON SUMMARY")
    print("=" * 60)
    print(f"Survival Rate:    {summary['survival_rate']:.2%}")
    print(f"Collapse Count:    {collapse_count}/{n_episodes}")
    print(f"Avg Total Reward:  {summary['avg_total_reward']:.2f}")
    print(f"Avg Max Queue:     {summary['avg_max_queue']:.1f}")
    print(f"Avg Teacher Match: {summary['avg_teacher_match']:.2%}")

    if collapse_count == 0:
        print("\nRESULT: PASS — No collapses, ready for PPO")
    else:
        print(f"\nRESULT: FAIL — {collapse_count} collapses detected")

    return summary


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Long Horizon Benchmark")
    parser.add_argument("--model", type=str, default="checkpoints/bc_policy_v3_1_clean.pt")
    parser.add_argument("--ticks", type=int, default=10000)
    parser.add_argument("--episodes", type=int, default=10)
    parser.add_argument("--output", type=str, default="artifacts/long_horizon.json")
    args = parser.parse_args()

    summary = run_long_horizon(
        bc_model_path=args.model,
        max_ticks=args.ticks,
        n_episodes=args.episodes,
    )

    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    print(f"\nSaved to: {args.output}")

    return summary


if __name__ == "__main__":
    main()
