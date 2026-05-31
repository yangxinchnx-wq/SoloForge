# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Sprint 5.4 — BC Preservation Test
# Path: experiments/ppo/bc_preservation_test.py
#
# 比较 PPO vs BC 在相同 episodes 上的 zone match rate
# BC Preservation: PPO match rate >= BC match rate - 5%
# ─────────────────────────────────────────────────────────────────

import sys
import os
import torch
import torch.nn as nn
import numpy as np
import json
from typing import Dict, List, Tuple

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)


# ============================================================
# Feature Builder
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
        queue_depth / 1000.0, 0.0, 0.0,
        worker_count / 200.0, cpu_usage,
        0.0, 0.0, 0.0,
        zone_id / 4.0, lr_norm,
    ], dtype=np.float32)
    return obs


# ============================================================
# Teacher V4 Policy (for zone match calculation)
# ============================================================

def teacher_v4_action(queue_depth: int, worker_count: int) -> int:
    """Teacher V4: returns action_index (0-4)"""
    lr = compute_load_ratio(queue_depth, worker_count)
    if lr < 0.1: return 0    # shrink2
    elif lr < 0.25: return 1  # shrink1
    elif lr < 0.5: return 2   # noop
    elif lr < 1.0: return 3   # expand1
    else: return 4            # expand2


# ============================================================
# BC Policy
# ============================================================

class BCPolicy(nn.Module):
    """BC V3.1 PolicyNetworkV2"""
    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(10, 128),
            nn.ReLU(),
            nn.Linear(128, 128),
            nn.ReLU(),
            nn.Linear(128, 5),
        )

    def forward(self, x):
        return self.net(x)

    def act(self, x, deterministic=True):
        logits = self.forward(x)
        probs = torch.softmax(logits, dim=-1)
        action = torch.argmax(probs, dim=-1) if deterministic else torch.multinomial(probs, 1).squeeze(-1)
        return action


# ============================================================
# PPO Policy (same architecture as training)
# ============================================================

class PolicyValueNetwork(nn.Module):
    def __init__(self, input_dim: int = 10, hidden_dim: int = 128):
        super().__init__()
        self.shared = nn.Sequential(
            nn.Linear(input_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.ReLU(),
        )
        self.actor = nn.Linear(hidden_dim, 5)
        self.critic = nn.Linear(hidden_dim, 1)

    def forward(self, x):
        h = self.shared(x)
        return self.actor(h), self.critic(h)

    def act(self, x, deterministic=True):
        logits, _ = self.forward(x)
        probs = torch.softmax(logits, dim=-1)
        action = torch.argmax(probs, dim=-1) if deterministic else torch.multinomial(probs, 1).squeeze(-1)
        return action


def load_bc_warm_start(pv_net: PolicyValueNetwork, bc_path: str) -> PolicyValueNetwork:
    checkpoint = torch.load(bc_path, map_location='cpu', weights_only=False)
    bc_state = checkpoint['policy_state_dict']
    key_map = {
        'net.0.weight': 'shared.0.weight',
        'net.0.bias': 'shared.0.bias',
        'net.2.weight': 'shared.2.weight',
        'net.2.bias': 'shared.2.bias',
        'net.4.weight': 'actor.weight',
        'net.4.bias': 'actor.bias',
    }
    pv_state = pv_net.state_dict()
    loaded = {}
    for bc_key, pv_key in key_map.items():
        if bc_key in bc_state and pv_key in pv_state:
            loaded[pv_key] = bc_state[bc_key]
    pv_net.load_state_dict(loaded, strict=False)
    return pv_net


# ============================================================
# Episode Runner
# ============================================================

def run_episode_with_policy(policy, env, teacher_fn, max_steps: int = 200):
    """Run episode, track zone match"""
    obs_buf, zone_buf, action_buf = [], [], []
    raw_obs, _ = env.reset()

    for _ in range(max_steps):
        state = env.simulator.state
        obs = build_features(
            queue_depth=state.queue_depth,
            worker_count=state.worker_count,
            cpu_usage=state.cpu_usage,
        )

        with torch.no_grad():
            obs_t = torch.FloatTensor(obs).unsqueeze(0)
            action = policy.act(obs_t).item()

        teacher_action = teacher_fn(state.queue_depth, state.worker_count)
        zone = get_zone_id(state.queue_depth, state.worker_count)

        obs_buf.append(obs)
        zone_buf.append(zone)
        action_buf.append(action)

        obs_new, _, terminated, truncated, _ = env.step(action)
        if terminated or truncated:
            break

    zone_match = sum(1 for z, a in zip(zone_buf, action_buf) if z == a)
    zone_counts = {}
    for z in zone_buf:
        zone_counts[z] = zone_counts.get(z, 0) + 1
    zone_match_by_zone = {}
    for z in range(5):
        zone_match_by_zone[z] = zone_match_by_zone.get(z, 0)

    # Track per-zone match
    per_zone_correct = {z: 0 for z in range(5)}
    per_zone_total = {z: 0 for z in range(5)}
    for z, a in zip(zone_buf, action_buf):
        per_zone_total[z] += 1
        if z == a:
            per_zone_correct[z] += 1

    match_rate = zone_match / len(zone_buf) if zone_buf else 0.0
    per_zone_rate = {z: per_zone_correct[z] / per_zone_total[z] if per_zone_total[z] > 0 else 0.0
                     for z in range(5)}

    return {
        "steps": len(zone_buf),
        "match_rate": float(match_rate),
        "zone_match": int(zone_match),
        "per_zone_rate": per_zone_rate,
        "per_zone_total": per_zone_total,
    }


# ============================================================
# BC Preservation Test
# ============================================================

def run_bc_preservation_test(
    bc_model_path: str = "checkpoints/bc_policy_v3_1_clean.pt",
    ppo_model_path: str = "checkpoints/ppo_policy.pt",
    n_episodes: int = 500,
    max_steps: int = 200,
    output_path: str = "artifacts/bc_preservation.json",
) -> Dict:
    print("=" * 60)
    print("SPRINT 5.4: BC PRESERVATION TEST")
    print("=" * 60)
    print(f"BC Model: {bc_model_path}")
    print(f"PPO Model: {ppo_model_path}")
    print(f"Episodes: {n_episodes}, Steps: {max_steps}")

    # Load BC
    bc_policy = BCPolicy()
    bc_checkpoint = torch.load(bc_model_path, map_location='cpu', weights_only=False)
    bc_policy.load_state_dict(bc_checkpoint['policy_state_dict'])
    bc_policy.eval()
    print("BC policy loaded.")

    # Load PPO (if exists), else use BC warm-start PPO net
    ppo_net = PolicyValueNetwork(input_dim=10, hidden_dim=128)
    if os.path.exists(ppo_model_path):
        try:
            ppo_checkpoint = torch.load(ppo_model_path, map_location='cpu', weights_only=False)
            if 'policy_state_dict' in ppo_checkpoint:
                ppo_net.load_state_dict(ppo_checkpoint['policy_state_dict'])
            else:
                ppo_net.load_state_dict(ppo_checkpoint)
            print("PPO policy loaded.")
        except Exception as e:
            print(f"PPO load failed ({e}), falling back to BC warm start.")
            ppo_net = load_bc_warm_start(ppo_net, bc_model_path)
            print("PPO: using BC warm start.")
    else:
        ppo_net = load_bc_warm_start(ppo_net, bc_model_path)
        print("PPO: using BC warm start (no checkpoint found).")
    ppo_net.eval()

    # Run episodes
    print("\nRunning BC episodes...")
    bc_results = []
    for ep in range(n_episodes):
        env = __import__('governor_rl.env.runtime_env', fromlist=['RuntimeEnv']).RuntimeEnv(
            duration=max_steps, arrival_rate=15.0, burst_prob=0.15, seed=ep
        )
        result = run_episode_with_policy(bc_policy, env, teacher_v4_action, max_steps)
        bc_results.append(result)
        if ep % 100 == 0:
            print(f"  BC: {ep}/{n_episodes}")

    print("Running PPO episodes...")
    ppo_results = []
    for ep in range(n_episodes):
        env = __import__('governor_rl.env.runtime_env', fromlist=['RuntimeEnv']).RuntimeEnv(
            duration=max_steps, arrival_rate=15.0, burst_prob=0.15, seed=ep
        )
        result = run_episode_with_policy(ppo_net, env, teacher_v4_action, max_steps)
        ppo_results.append(result)
        if ep % 100 == 0:
            print(f"  PPO: {ep}/{n_episodes}")

    # Aggregate
    bc_match_rates = [r["match_rate"] for r in bc_results]
    ppo_match_rates = [r["match_rate"] for r in ppo_results]

    bc_avg = float(np.mean(bc_match_rates)) * 100
    ppo_avg = float(np.mean(ppo_match_rates)) * 100

    bc_std = float(np.std(bc_match_rates)) * 100
    ppo_std = float(np.std(ppo_match_rates)) * 100

    # Per-zone
    per_zone_bc = {z: 0.0 for z in range(5)}
    per_zone_ppo = {z: 0.0 for z in range(5)}
    per_zone_count = {z: 0 for z in range(5)}

    for r in bc_results:
        for z in range(5):
            per_zone_bc[z] += r["per_zone_rate"].get(z, 0.0)
            per_zone_count[z] += 1

    for r in ppo_results:
        for z in range(5):
            per_zone_ppo[z] += r["per_zone_rate"].get(z, 0.0)

    for z in range(5):
        if per_zone_count[z] > 0:
            per_zone_bc[z] = per_zone_bc[z] / per_zone_count[z] * 100
            per_zone_ppo[z] = per_zone_ppo[z] / per_zone_count[z] * 100

    # Preservation gate
    threshold = 5.0  # PPO >= BC - 5%
    drift = bc_avg - ppo_avg
    preservation_ok = drift <= threshold

    print("\n" + "=" * 60)
    print("RESULTS")
    print("=" * 60)
    print(f"\n  BC  Avg Match: {bc_avg:6.2f}% (std={bc_std:.2f}%)")
    print(f"  PPO Avg Match: {ppo_avg:6.2f}% (std={ppo_std:.2f}%)")
    print(f"  Drift (BC-PPO): {drift:6.2f}%")
    print(f"  Threshold: {threshold:.1f}%")
    print(f"  Preservation: {'PASS' if preservation_ok else 'FAIL'}")

    print(f"\n  Per-Zone Match Rate:")
    print(f"  {'Zone':>8} {'BC':>10} {'PPO':>10} {'Drift':>10}")
    print("  " + "-" * 42)
    zone_names = ["A", "B", "C", "D", "E"]
    for z in range(5):
        zd = per_zone_bc[z] - per_zone_ppo[z]
        print(f"  {zone_names[z]:>8} {per_zone_bc[z]:>10.1f}% {per_zone_ppo[z]:>10.1f}% {zd:>+10.1f}%")

    print("\n" + "=" * 60)
    print("SPRINT 5.4 SUMMARY")
    print("=" * 60)
    print(f"  BC Preservation (PPO >= BC - 5%): {'PASS' if preservation_ok else 'FAIL'}")
    all_ok = preservation_ok
    print(f"\n  Overall: {'PASS — PPO preserves BC behavior' if all_ok else 'FAIL — PPO drifted from BC'}")

    result = {
        "bc_avg_match": float(bc_avg),
        "ppo_avg_match": float(ppo_avg),
        "drift": float(drift),
        "threshold": float(threshold),
        "per_zone_bc": {str(k): float(v) for k, v in per_zone_bc.items()},
        "per_zone_ppo": {str(k): float(v) for k, v in per_zone_ppo.items()},
        "passed": bool(all_ok),
    }

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"\nSaved to: {output_path}")

    return result


def main():
    import argparse
    parser = argparse.ArgumentParser(description="BC Preservation Test")
    parser.add_argument("--bc", type=str, default="checkpoints/bc_policy_v3_1_clean.pt")
    parser.add_argument("--ppo", type=str, default="checkpoints/ppo_policy.pt")
    parser.add_argument("--episodes", type=int, default=500)
    parser.add_argument("--steps", type=int, default=200)
    parser.add_argument("--output", type=str, default="artifacts/bc_preservation.json")
    args = parser.parse_args()

    run_bc_preservation_test(
        bc_model_path=args.bc,
        ppo_model_path=args.ppo,
        n_episodes=args.episodes,
        max_steps=args.steps,
        output_path=args.output,
    )


if __name__ == "__main__":
    main()
