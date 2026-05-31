# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Sprint 5.1 — PPO Baseline
# Path: experiments/ppo/ppo_baseline.py
#
# 验证 PPO 可以从 BC 初始化，并在 epoch 0 达到与 BC 相同的 match rate
# ─────────────────────────────────────────────────────────────────

import sys
import os
import torch
import torch.nn as nn
import numpy as np

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.training.simulator.teacher_v4 import TeacherV4


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
        logits, value = self.forward(x)
        probs = torch.softmax(logits, dim=-1)
        action = torch.argmax(probs, dim=-1) if deterministic else torch.multinomial(probs, 1).squeeze(-1)
        return action, value.squeeze(-1)


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


def load_bc_model(path: str) -> PolicyValueNetwork:
    checkpoint = torch.load(path, map_location='cpu')
    input_dim = checkpoint.get('input_dim', 10)
    net = PolicyValueNetwork(input_dim=input_dim, hidden_dim=128)
    bc_state = checkpoint['policy_state_dict']
    net.load_state_dict({
        'shared.0.weight': bc_state['net.0.weight'],
        'shared.0.bias': bc_state['net.0.bias'],
        'shared.2.weight': bc_state['net.2.weight'],
        'shared.2.bias': bc_state['net.2.bias'],
        'actor.weight': bc_state['net.4.weight'],
        'actor.bias': bc_state['net.4.bias'],
    }, strict=False)
    net.eval()
    return net


def compute_match_rate(model, n_samples: int = 2000, seed: int = 42) -> dict:
    teacher = TeacherV4()
    np.random.seed(seed)
    zones = {0: "A", 1: "B", 2: "C", 3: "D", 4: "E"}
    zone_counts = {z: {"match": 0, "total": 0} for z in "ABCDE"}
    total_match = 0

    for _ in range(n_samples):
        w = np.random.randint(10, 500)
        lr = np.random.uniform(0.0, 20.0)
        q = int(lr * w * 2)
        zone = get_zone_id(q, w)

        teacher_action = teacher.decide(q, w) + 2
        obs = build_features(q, w)
        obs_t = torch.FloatTensor(obs).unsqueeze(0)
        with torch.no_grad():
            model_action = torch.argmax(model(obs_t)[0], dim=-1).item()

        zone_name = zones[zone]
        zone_counts[zone_name]["total"] += 1
        if model_action == teacher_action:
            zone_counts[zone_name]["match"] += 1
            total_match += 1

    overall_rate = total_match / n_samples
    zone_rates = {
        z: zone_counts[z]["match"] / zone_counts[z]["total"]
        if zone_counts[z]["total"] > 0 else 0
        for z in "ABCDE"
    }
    return {"overall": overall_rate, "zones": zone_rates, "total": n_samples}


def run_sprint_51(bc_path: str = "checkpoints/bc_policy_v3_1_clean.pt") -> dict:
    print("=" * 60)
    print("SPRINT 5.1: PPO BASELINE")
    print("=" * 60)
    print(f"BC Model: {bc_path}")

    print("\nLoading BC model...")
    bc_model = load_bc_model(bc_path)
    print("BC loaded.")

    print("\nComputing BC match rate...")
    bc_result = compute_match_rate(bc_model, n_samples=2000)

    print("\nBC Teacher Match Rate:")
    print(f"  Overall: {bc_result['overall']:.2%}")
    for z in "ABCDE":
        print(f"  Zone {z}:  {bc_result['zones'][z]:.2%}")

    # PPO 从 BC 初始化
    ppo_model = PolicyValueNetwork(input_dim=10, hidden_dim=128)
    ppo_model.load_state_dict({
        'shared.0.weight': bc_model.state_dict()['shared.0.weight'],
        'shared.0.bias': bc_model.state_dict()['shared.0.bias'],
        'shared.2.weight': bc_model.state_dict()['shared.2.weight'],
        'shared.2.bias': bc_model.state_dict()['shared.2.bias'],
        'actor.weight': bc_model.state_dict()['actor.weight'],
        'actor.bias': bc_model.state_dict()['actor.bias'],
    }, strict=False)
    ppo_model.eval()

    print("\nComputing PPO (BC-init) match rate (epoch 0)...")
    ppo_result = compute_match_rate(ppo_model, n_samples=2000)

    print("\nPPO Teacher Match Rate (epoch 0):")
    print(f"  Overall: {ppo_result['overall']:.2%}")
    for z in "ABCDE":
        print(f"  Zone {z}:  {ppo_result['zones'][z]:.2%}")

    print("\n" + "=" * 60)
    print("SPRINT 5.1 RESULT")
    print("=" * 60)
    match = abs(bc_result['overall'] - ppo_result['overall']) < 0.01
    print(f"\nBC Match:    {bc_result['overall']:.2%}")
    print(f"PPO Match:   {ppo_result['overall']:.2%}")
    print(f"Match Diff:  {abs(bc_result['overall'] - ppo_result['overall']):.4f}")
    print(f"\n{'PASS' if match else 'FAIL'}: PPO matches BC initialization")

    return {
        "bc_match": bc_result['overall'],
        "ppo_match": ppo_result['overall'],
        "pass": match,
        "bc_zones": bc_result['zones'],
        "ppo_zones": ppo_result['zones'],
    }


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--bc", type=str, default="checkpoints/bc_policy_v3_1_clean.pt")
    args = parser.parse_args()
    result = run_sprint_51(args.bc)
    return result


if __name__ == "__main__":
    main()
