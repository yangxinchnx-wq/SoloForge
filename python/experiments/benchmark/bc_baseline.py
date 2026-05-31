# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: BC Baseline Benchmark
# Path: experiments/benchmark/bc_baseline.py
#
# Task 1.1: 建立 PPO 对照组
# 运行 BC policy 在 RuntimeEnv 上，收集 baseline 指标
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import torch
import torch.nn as nn
import numpy as np
from typing import Dict, List

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.env.runtime_env import RuntimeEnv
from governor_rl.training.simulator.teacher_v4 import TeacherV4


# ============================================================
# Policy Network V2 (与 BC V3.1 一致)
# ============================================================

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

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


# ============================================================
# Feature Builder (与 sprint45b_stress_cert_v2.py 一致)
# ============================================================

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
        queue_depth / 1000.0,
        0.0,
        0.0,
        worker_count / 200.0,
        cpu_usage,
        0.0,
        0.0,
        0.0,
        zone_id / 4.0,
        lr_norm,
    ], dtype=np.float32)
    return obs


# ============================================================
# BC Decision
# ============================================================

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


class TeacherAgent:
    """Teacher V4 作为对照"""
    def __init__(self):
        self.teacher = TeacherV4()

    def act(self, queue_depth: int, worker_count: int) -> int:
        action_value = self.teacher.decide(queue_depth, worker_count)
        return action_value + 2  # -2,-1,0,1,2 -> 0,1,2,3,4


# ============================================================
# Episode Runner
# ============================================================

ACTION_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}


def run_episode(agent, env: RuntimeEnv, max_ticks: int, verbose: bool = False) -> Dict:
    """运行一个 episode"""
    obs, _ = env.reset()
    total_reward = 0.0
    queue_samples = []
    worker_samples = []
    reward_samples = []
    zone_samples = []
    action_samples = []
    teacher_match = 0
    total_steps = 0

    teacher = TeacherAgent()

    for tick in range(max_ticks):
        # 获取当前状态
        state = env.simulator.state
        q, w = state.queue_depth, state.worker_count

        # Agent 决策
        action = agent.act(q, w)

        # Teacher 决策
        teacher_action = teacher.act(q, w)
        if action == teacher_action:
            teacher_match += 1
        total_steps += 1

        # 执行
        obs, reward, terminated, truncated, info = env.step(action)

        # 记录
        total_reward += reward
        queue_samples.append(q)
        worker_samples.append(w)
        reward_samples.append(reward)
        zone_samples.append(get_zone_id(q, w))
        action_samples.append(action)

        if terminated:
            break

    # 统计
    n = len(queue_samples)
    queue_arr = np.array(queue_samples)
    worker_arr = np.array(worker_samples)

    # Collapse 检测
    collapse = state.queue_depth > 50000

    return {
        "survival": not collapse,
        "total_reward": total_reward,
        "avg_reward": total_reward / n if n > 0 else 0.0,
        "avg_queue": np.mean(queue_arr),
        "avg_workers": np.mean(worker_arr),
        "p50_queue": float(np.percentile(queue_arr, 50)),
        "p95_queue": float(np.percentile(queue_arr, 95)),
        "p99_queue": float(np.percentile(queue_arr, 99)),
        "max_queue": float(np.max(queue_arr)),
        "max_workers": float(np.max(worker_arr)),
        "min_workers": float(np.min(worker_arr)),
        "final_queue": float(queue_samples[-1]) if queue_samples else 0,
        "final_workers": float(worker_samples[-1]) if worker_samples else 0,
        "duration": n,
        "teacher_match_rate": teacher_match / total_steps if total_steps > 0 else 0.0,
        "collapse": collapse,
        "zone_distribution": {
            "A": zone_samples.count(0),
            "B": zone_samples.count(1),
            "C": zone_samples.count(2),
            "D": zone_samples.count(3),
            "E": zone_samples.count(4),
        },
    }


def run_baseline(
    bc_model_path: str = "checkpoints/bc_policy_v3_1_clean.pt",
    n_episodes: int = 1000,
    max_ticks: int = 1000,
) -> Dict:
    """运行 BC Baseline Benchmark"""
    print("=" * 60)
    print("BC BASELINE BENCHMARK")
    print("=" * 60)
    print(f"Model: {bc_model_path}")
    print(f"Episodes: {n_episodes}")
    print(f"Max ticks: {max_ticks}")

    # 加载模型
    print("\nLoading BC model...")
    bc_agent = BCAgent(bc_model_path)
    print("Model loaded.")

    # 运行环境配置
    env_config = {
        "duration": max_ticks,
        "arrival_rate": 15.0,
        "burst_prob": 0.15,
    }

    results = []

    print(f"\nRunning {n_episodes} episodes...")
    for i in range(n_episodes):
        env = RuntimeEnv(
            duration=max_ticks,
            arrival_rate=15.0,
            burst_prob=0.15,
            seed=i,
        )
        episode_result = run_episode(bc_agent, env, max_ticks)
        results.append(episode_result)

        if (i + 1) % 100 == 0:
            print(f"  Progress: {i+1}/{n_episodes} episodes")

    # 汇总
    print("\nComputing statistics...")
    survivals = [r["survival"] for r in results]
    rewards = [r["total_reward"] for r in results]
    avg_rewards = [r["avg_reward"] for r in results]
    avg_queues = [r["avg_queue"] for r in results]
    p95_queues = [r["p95_queue"] for r in results]
    p99_queues = [r["p99_queue"] for r in results]
    max_queues = [r["max_queue"] for r in results]
    teacher_match_rates = [r["teacher_match_rate"] for r in results]
    collapses = sum(1 for r in results if r["collapse"])

    # Zone 分布
    zone_total = {z: 0 for z in "ABCDE"}
    for r in results:
        for z, count in r["zone_distribution"].items():
            zone_total[z] += count

    summary = {
        "config": env_config,
        "n_episodes": n_episodes,
        "max_ticks": max_ticks,
        "survival_rate": sum(survivals) / len(survivals),
        "collapse_count": collapses,
        "avg_total_reward": float(np.mean(rewards)),
        "std_total_reward": float(np.std(rewards)),
        "avg_episode_reward": float(np.mean(avg_rewards)),
        "avg_queue": float(np.mean(avg_queues)),
        "avg_teacher_match": float(np.mean(teacher_match_rates)),
        "p95_queue": float(np.percentile(p95_queues, 50)),
        "p99_queue": float(np.percentile(p99_queues, 50)),
        "max_queue_avg": float(np.mean(max_queues)),
        "zone_distribution": {z: v / len(results) for z, v in zone_total.items()},
    }

    # 打印摘要
    print("\n" + "=" * 60)
    print("BC BASELINE SUMMARY")
    print("=" * 60)
    print(f"\nSurvival Rate:    {summary['survival_rate']:.2%}")
    print(f"Collapse Count:    {summary['collapse_count']}/{n_episodes}")
    print(f"Avg Total Reward:  {summary['avg_total_reward']:.2f}")
    print(f"Std Total Reward:  {summary['std_total_reward']:.2f}")
    print(f"Avg Queue:        {summary['avg_queue']:.1f}")
    print(f"P95 Queue:        {summary['p95_queue']:.1f}")
    print(f"P99 Queue:        {summary['p99_queue']:.1f}")
    print(f"Teacher Match:    {summary['avg_teacher_match']:.2%}")
    print(f"\nZone Distribution (avg per episode):")
    for z in "ABCDE":
        print(f"  Zone {z}: {summary['zone_distribution'][z]:.0f} steps")

    return summary


def main():
    import argparse
    parser = argparse.ArgumentParser(description="BC Baseline Benchmark")
    parser.add_argument("--model", type=str, default="checkpoints/bc_policy_v3_1_clean.pt")
    parser.add_argument("--episodes", type=int, default=1000)
    parser.add_argument("--ticks", type=int, default=1000)
    parser.add_argument("--output", type=str, default="artifacts/bc_baseline.json")
    args = parser.parse_args()

    summary = run_baseline(
        bc_model_path=args.model,
        n_episodes=args.episodes,
        max_ticks=args.ticks,
    )

    # 保存结果
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    print(f"\nSaved to: {args.output}")

    return summary


if __name__ == "__main__":
    main()
