# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Sprint 6 — PPO Improvement Audit
# Path: experiments/ppo/ppo_improvement_audit.py
#
# 核心问题：PPO 是否真的优于 BC？
#
# 方法：BC 和 PPO 各自独立跑相同 episodes（相同 seed），记录：
#   - Average Queue
#   - Average Workers
#   - Oscillation count
#   - Total Reward
#   - Survival / Collapse
#
# 关键：每个 episode 内部，两者的状态轨迹不同（因为动作不同）
# 所以不能比较 step-by-step rewards，必须比较 episode-level aggregate
# ─────────────────────────────────────────────────────────────────

import sys
import os
import torch
import torch.nn as nn
import numpy as np
import json
from typing import Dict, List

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
# BC Policy
# ============================================================

class BCPolicy(nn.Module):
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
# PPO Policy
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
# Independent Episode Run
# ============================================================

ACTION_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}


def run_independent_episode(
    policy,
    env_module,
    env_config: dict,
    max_steps: int = 200,
) -> Dict:
    """Run one episode with a given policy, return aggregate stats"""
    env = env_module.RuntimeEnv(**env_config)

    rewards = []
    queues = []
    workers = []
    actions = []
    zones = []
    prev_action = None

    raw_obs, _ = env.reset()

    for _ in range(max_steps):
        state = env.simulator.state
        obs = build_features(
            queue_depth=state.queue_depth,
            worker_count=state.worker_count,
            cpu_usage=state.cpu_usage,
        )
        zone = get_zone_id(state.queue_depth, state.worker_count)
        zones.append(zone)

        with torch.no_grad():
            obs_t = torch.FloatTensor(obs).unsqueeze(0)
            action = policy.act(obs_t).item()

        actions.append(action)
        queues.append(state.queue_depth)
        workers.append(state.worker_count)

        obs_new, reward, terminated, truncated, info = env.step(action)
        rewards.append(reward)

        if terminated or truncated:
            break

    # Oscillation: count consecutive expand→shrink or shrink→expand transitions
    oscillation_count = 0
    for i in range(1, len(actions)):
        prev = actions[i - 1]
        curr = actions[i]
        # expand (3,4) → shrink (0,1) OR shrink → expand
        prev_expanding = prev >= 3
        curr_expanding = curr >= 3
        if prev_expanding != curr_expanding:
            oscillation_count += 1

    steps = len(zones)
    final_state = env.simulator.state

    return {
        "steps": steps,
        "total_reward": float(sum(rewards)),
        "avg_queue": float(np.mean(queues)) if queues else 0.0,
        "max_queue": float(max(queues)) if queues else 0.0,
        "avg_workers": float(np.mean(workers)) if workers else 0.0,
        "final_queue": int(final_state.queue_depth),
        "final_workers": int(final_state.worker_count),
        "oscillation_count": int(oscillation_count),
        "osc_per_step": float(oscillation_count / max(steps, 1)),
        "actions": [ACTION_NAMES[a] for a in actions],
        "collapsed": final_state.queue_depth >= 9000,
    }


# ============================================================
# Sprint 6: PPO Improvement Audit
# ============================================================

def run_ppo_improvement_audit(
    bc_model_path: str = "checkpoints/bc_policy_v3_1_clean.pt",
    ppo_model_path: str = "checkpoints/ppo_policy.pt",
    n_episodes: int = 500,
    max_steps: int = 200,
    output_path: str = "artifacts/ppo_improvement_audit.json",
) -> Dict:
    print("=" * 60)
    print("SPRINT 6.0: PPO IMPROVEMENT AUDIT")
    print("=" * 60)
    print(f"BC Model: {bc_model_path}")
    print(f"PPO Model: {ppo_model_path}")
    print(f"Episodes: {n_episodes}, Steps: {max_steps}")

    # Load BC
    bc_policy = BCPolicy()
    bc_ckpt = torch.load(bc_model_path, map_location='cpu', weights_only=False)
    bc_policy.load_state_dict(bc_ckpt['policy_state_dict'])
    bc_policy.eval()
    print("BC policy loaded.")

    # Load PPO
    ppo_net = PolicyValueNetwork(input_dim=10, hidden_dim=128)
    env_module = __import__('governor_rl.env.runtime_env', fromlist=['RuntimeEnv'])
    if os.path.exists(ppo_model_path):
        try:
            ppo_ckpt = torch.load(ppo_model_path, map_location='cpu', weights_only=False)
            if 'policy_state_dict' in ppo_ckpt:
                ppo_net.load_state_dict(ppo_ckpt['policy_state_dict'])
            else:
                ppo_net.load_state_dict(ppo_ckpt)
            print("PPO trained checkpoint loaded.")
        except Exception as e:
            print(f"PPO load failed ({e}), using BC warm start.")
            ppo_net = load_bc_warm_start(ppo_net, bc_model_path)
            print("PPO: using BC warm start.")
    else:
        ppo_net = load_bc_warm_start(ppo_net, bc_model_path)
        print("PPO: using BC warm start.")
    ppo_net.eval()

    # Common env config
    base_config = {"duration": max_steps, "arrival_rate": 15.0, "burst_prob": 0.15}

    # Run BC episodes
    print(f"\nRunning BC episodes...")
    bc_results = []
    for ep in range(n_episodes):
        env_config = {**base_config, "seed": ep}
        result = run_independent_episode(bc_policy, env_module, env_config, max_steps)
        bc_results.append(result)
        if ep % 100 == 0:
            print(f"  BC: {ep}/{n_episodes}")

    # Run PPO episodes (same seeds)
    print(f"Running PPO episodes...")
    ppo_results = []
    for ep in range(n_episodes):
        env_config = {**base_config, "seed": ep}
        result = run_independent_episode(ppo_net, env_module, env_config, max_steps)
        ppo_results.append(result)
        if ep % 100 == 0:
            print(f"  PPO: {ep}/{n_episodes}")

    # Aggregate
    def aggregate(results: List[Dict]) -> Dict:
        rewards = [r["total_reward"] for r in results]
        avg_q = [r["avg_queue"] for r in results]
        max_q = [r["max_queue"] for r in results]
        avg_w = [r["avg_workers"] for r in results]
        osc = [r["oscillation_count"] for r in results]
        osc_step = [r["osc_per_step"] for r in results]
        collapsed = sum(1 for r in results if r["collapsed"])
        survival = (len(results) - collapsed) / len(results) * 100
        return {
            "avg_reward": float(np.mean(rewards)),
            "std_reward": float(np.std(rewards)),
            "avg_queue": float(np.mean(avg_q)),
            "std_queue": float(np.std(avg_q)),
            "max_queue_avg": float(np.mean(max_q)),
            "avg_workers": float(np.mean(avg_w)),
            "std_workers": float(np.std(avg_w)),
            "avg_oscillation": float(np.mean(osc)),
            "std_oscillation": float(np.std(osc)),
            "osc_per_step": float(np.mean(osc_step)),
            "survival_rate": float(survival),
            "collapse_count": int(collapsed),
            "n": len(results),
        }

    bc_agg = aggregate(bc_results)
    ppo_agg = aggregate(ppo_results)

    print("\n" + "=" * 60)
    print("SPRINT 6.0: PPO vs BC — COMPARISON")
    print("=" * 60)

    print(f"\n  {'Metric':<20} {'BC':>12} {'PPO':>12} {'Winner':>8} {'Delta':>10}")
    print("  " + "-" * 66)

    rows = []

    # Survival
    bc_surv = bc_agg["survival_rate"]
    ppo_surv = ppo_agg["survival_rate"]
    winner_surv = "BC" if bc_surv > ppo_surv else ("PPO" if ppo_surv > bc_surv else "TIE")
    delta_surv = ppo_surv - bc_surv
    print(f"  {'Survival Rate':<20} {bc_surv:>11.1f}% {ppo_surv:>11.1f}% {winner_surv:>8} {delta_surv:>+9.1f}%")
    rows.append(("Survival Rate", bc_surv, ppo_surv, winner_surv, delta_surv, "%"))

    # Collapse
    bc_col = bc_agg["collapse_count"]
    ppo_col = ppo_agg["collapse_count"]
    winner_col = "BC" if bc_col < ppo_col else ("PPO" if ppo_col < bc_col else "TIE")
    delta_col = ppo_col - bc_col
    print(f"  {'Collapse Count':<20} {bc_col:>12d} {ppo_col:>12d} {winner_col:>8} {delta_col:>+10d}")
    rows.append(("Collapse Count", bc_col, ppo_col, winner_col, delta_col, "count"))

    # Avg Queue
    bc_aq = bc_agg["avg_queue"]
    ppo_aq = ppo_agg["avg_queue"]
    winner_aq = "BC" if bc_aq < ppo_aq else ("PPO" if ppo_aq < bc_aq else "TIE")
    delta_aq = ppo_aq - bc_aq
    pct_aq = (ppo_aq - bc_aq) / max(bc_aq, 1) * 100
    print(f"  {'Avg Queue':<20} {bc_aq:>12.1f} {ppo_aq:>12.1f} {winner_aq:>8} {delta_aq:>+9.1f} ({pct_aq:+.1f}%)")
    rows.append(("Avg Queue", bc_aq, ppo_aq, winner_aq, delta_aq, "queue"))

    # Max Queue Avg
    bc_mq = bc_agg["max_queue_avg"]
    ppo_mq = ppo_agg["max_queue_avg"]
    winner_mq = "BC" if bc_mq < ppo_mq else ("PPO" if ppo_mq < bc_mq else "TIE")
    delta_mq = ppo_mq - bc_mq
    print(f"  {'Max Queue (avg)':<20} {bc_mq:>12.1f} {ppo_mq:>12.1f} {winner_mq:>8} {delta_mq:>+9.1f}")
    rows.append(("Max Queue (avg)", bc_mq, ppo_mq, winner_mq, delta_mq, "queue"))

    # Avg Workers
    bc_aw = bc_agg["avg_workers"]
    ppo_aw = ppo_agg["avg_workers"]
    winner_aw = "BC" if bc_aw > ppo_aw else ("PPO" if ppo_aw > bc_aw else "TIE")
    delta_aw = ppo_aw - bc_aw
    print(f"  {'Avg Workers':<20} {bc_aw:>12.1f} {ppo_aw:>12.1f} {winner_aw:>8} {delta_aw:>+9.1f}")
    rows.append(("Avg Workers", bc_aw, ppo_aw, winner_aw, delta_aw, "workers"))

    # Oscillation
    bc_osc = bc_agg["avg_oscillation"]
    ppo_osc = ppo_agg["avg_oscillation"]
    winner_osc = "BC" if bc_osc < ppo_osc else ("PPO" if ppo_osc < bc_osc else "TIE")
    delta_osc = ppo_osc - bc_osc
    print(f"  {'Avg Oscillation':<20} {bc_osc:>12.2f} {ppo_osc:>12.2f} {winner_osc:>8} {delta_osc:>+9.2f}")
    rows.append(("Avg Oscillation", bc_osc, ppo_osc, winner_osc, delta_osc, "count"))

    # Osc per step
    bc_ops = bc_agg["osc_per_step"]
    ppo_ops = ppo_agg["osc_per_step"]
    winner_ops = "BC" if bc_ops < ppo_ops else ("PPO" if ppo_ops < bc_ops else "TIE")
    delta_ops = ppo_ops - bc_ops
    print(f"  {'Osc/Step':<20} {bc_ops:>12.4f} {ppo_ops:>12.4f} {winner_ops:>8} {delta_ops:>+9.4f}")
    rows.append(("Osc/Step", bc_ops, ppo_ops, winner_ops, delta_ops, "ratio"))

    # Total Reward
    bc_rw = bc_agg["avg_reward"]
    ppo_rw = ppo_agg["avg_reward"]
    winner_rw = "BC" if bc_rw > ppo_rw else ("PPO" if ppo_rw > bc_rw else "TIE")
    delta_rw = ppo_rw - bc_rw
    print(f"  {'Avg Total Reward':<20} {bc_rw:>12.1f} {ppo_rw:>12.1f} {winner_rw:>8} {delta_rw:>+9.1f}")
    rows.append(("Avg Total Reward", bc_rw, ppo_rw, winner_rw, delta_rw, "reward"))

    # Std Reward
    bc_std = bc_agg["std_reward"]
    ppo_std = ppo_agg["std_reward"]
    print(f"  {'Std Reward':<20} {bc_std:>12.1f} {ppo_std:>12.1f}")
    rows.append(("Std Reward", bc_std, ppo_std, "N/A", 0, "std"))

    print("\n" + "=" * 60)
    print("INTERPRETATION")
    print("=" * 60)

    # Score
    bc_wins = sum(1 for r in rows if r[3] == "BC")
    ppo_wins = sum(1 for r in rows if r[3] == "PPO")
    print(f"\n  BC wins: {bc_wins} metrics")
    print(f"  PPO wins: {ppo_wins} metrics")

    # Key judgments
    print(f"\n  Key comparisons:")
    print(f"    Queue:       {'PPO' if ppo_aq < bc_aq else 'BC'} has lower avg queue ({min(ppo_aq, bc_aq):.1f} vs {max(ppo_aq, bc_aq):.1f})")
    print(f"    Oscillation: {'PPO' if ppo_osc < bc_osc else 'BC'} has fewer oscillations ({min(ppo_osc, bc_osc):.2f} vs {max(ppo_osc, bc_osc):.2f})")
    print(f"    Reward:      {'PPO' if ppo_rw > bc_rw else 'BC'} has higher reward ({max(ppo_rw, bc_rw):.1f} vs {min(ppo_rw, bc_rw):.1f})")
    print(f"    Survival:    {'PPO' if ppo_surv > bc_surv else 'BC'} has better survival ({max(ppo_surv, bc_surv):.1f}% vs {min(ppo_surv, bc_surv):.1f}%)")

    # Verdict
    improvement = (ppo_rw - bc_rw) / abs(bc_rw) * 100 if bc_rw != 0 else 0
    print(f"\n  Reward improvement: {improvement:+.1f}%")

    if ppo_rw > bc_rw and ppo_aq < bc_aq:
        verdict = "PPO GENUINELY BETTER"
        verdict_detail = "Lower queue + Higher reward"
    elif ppo_rw > bc_rw * 1.05:
        verdict = "PPO MARGINALLY BETTER"
        verdict_detail = "Higher reward but similar/increased queue"
    elif abs(ppo_rw - bc_rw) < abs(bc_rw) * 0.05:
        verdict = "PPO ≈ BC"
        verdict_detail = "No meaningful difference"
    elif ppo_rw < bc_rw:
        verdict = "PPO WORSE THAN BC"
        verdict_detail = "BC warm start not improved by PPO training"
    else:
        verdict = "INCONCLUSIVE"
        verdict_detail = "Mixed results"

    print(f"\n  Verdict: {verdict}")
    print(f"  Detail:  {verdict_detail}")

    print("\n" + "=" * 60)
    print("SPRINT 6.0 SUMMARY")
    print("=" * 60)

    result = {
        "bc": bc_agg,
        "ppo": ppo_agg,
        "comparison": {
            "bc_wins": bc_wins,
            "ppo_wins": ppo_wins,
            "reward_improvement_pct": float(improvement),
            "verdict": verdict,
            "verdict_detail": verdict_detail,
        },
        "passed": bool(ppo_wins > bc_wins),
    }

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"\nSaved to: {output_path}")

    return result


def main():
    import argparse
    parser = argparse.ArgumentParser(description="PPO Improvement Audit")
    parser.add_argument("--bc", type=str, default="checkpoints/bc_policy_v3_1_clean.pt")
    parser.add_argument("--ppo", type=str, default="checkpoints/ppo_policy.pt")
    parser.add_argument("--episodes", type=int, default=500)
    parser.add_argument("--steps", type=int, default=200)
    parser.add_argument("--output", type=str, default="artifacts/ppo_improvement_audit.json")
    args = parser.parse_args()

    run_ppo_improvement_audit(
        bc_model_path=args.bc,
        ppo_model_path=args.ppo,
        n_episodes=args.episodes,
        max_steps=args.steps,
        output_path=args.output,
    )


if __name__ == "__main__":
    main()
