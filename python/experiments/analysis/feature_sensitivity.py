# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Sprint 6.3 — Feature Sensitivity
# Path: experiments/analysis/feature_sensitivity.py
#
# 目标：验证模型学的是 Zone 还是 queue_depth
# 固定 worker_count=50，扫描 queue_depth → 观察概率变化
# ─────────────────────────────────────────────────────────────────

import sys
import os
import torch
import torch.nn as nn
import numpy as np
import json

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(os.path.dirname(script_dir)))
sys.path.insert(0, python_dir)


def compute_load_ratio(q, w):
    return q / max(w * 2, 1)


def get_zone(q, w):
    lr = compute_load_ratio(q, w)
    if lr < 0.1: return 0
    elif lr < 0.25: return 1
    elif lr < 0.5: return 2
    elif lr < 1.0: return 3
    else: return 4


class BCPolicy(nn.Module):
    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(10, 128), nn.ReLU(),
            nn.Linear(128, 128), nn.ReLU(),
            nn.Linear(128, 5),
        )
    def forward(self, x): return self.net(x)


class PPOActor(nn.Module):
    def __init__(self):
        super().__init__()
        self.shared = nn.Sequential(
            nn.Linear(10, 128), nn.ReLU(),
            nn.Linear(128, 128), nn.ReLU(),
        )
        self.actor = nn.Linear(128, 5)
    def forward(self, x): return self.actor(self.shared(x))


def load_bc_warm_start(ppo, bc_path):
    ckpt = torch.load(bc_path, map_location='cpu', weights_only=False)
    bc_state = ckpt['policy_state_dict']
    key_map = {
        'net.0.weight': 'shared.0.weight', 'net.0.bias': 'shared.0.bias',
        'net.2.weight': 'shared.2.weight', 'net.2.bias': 'shared.2.bias',
        'net.4.weight': 'actor.weight', 'net.4.bias': 'actor.bias',
    }
    loaded = {}
    for bc_key, pv_key in key_map.items():
        if bc_key in bc_state and pv_key in ppo.state_dict():
            loaded[pv_key] = bc_state[bc_key]
    ppo.load_state_dict(loaded, strict=False)
    return ppo


def load_policies(bc_path, ppo_path):
    bc = BCPolicy()
    bc_ckpt = torch.load(bc_path, map_location='cpu', weights_only=False)
    bc.load_state_dict(bc_ckpt['policy_state_dict'])
    bc.eval()

    ppo = PPOActor()
    if os.path.exists(ppo_path):
        try:
            ckpt = torch.load(ppo_path, map_location='cpu', weights_only=False)
            if 'policy_state_dict' in ckpt:
                ppo.load_state_dict(ckpt['policy_state_dict'])
            else:
                ppo.load_state_dict(ckpt)
            ppo_source = "trained"
        except:
            ppo = load_bc_warm_start(ppo, bc_path)
            ppo_source = "bc_warm_start"
    else:
        ppo = load_bc_warm_start(ppo, bc_path)
        ppo_source = "bc_warm_start"
    ppo.eval()
    return bc, ppo, ppo_source


def build_obs(q, w, cpu=0.5):
    lr = compute_load_ratio(q, w)
    max_lr = 21.5
    lr_norm = np.log(1 + lr) / np.log(1 + max_lr)
    return np.array([q/1000., 0., 0., w/200., cpu, 0., 0., 0.,
                     get_zone(q, w)/4., lr_norm], dtype=np.float32)


ACTION_NAMES = ["shrink2", "shrink1", "noop", "expand1", "expand2"]


def scan_queue_depth(bc, ppo, worker_count=50):
    queue_values = [10, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 50000, 100000]
    results = []

    for q in queue_values:
        obs = torch.FloatTensor(build_obs(q, worker_count)).unsqueeze(0)

        with torch.no_grad():
            bc_logits = bc(obs).squeeze(0)
            ppo_logits = ppo(obs).squeeze(0)

        bc_probs = torch.softmax(bc_logits, dim=-1)
        ppo_probs = torch.softmax(ppo_logits, dim=-1)

        zone = get_zone(q, worker_count)
        lr = compute_load_ratio(q, worker_count)
        teacher = zone

        r = {
            "queue": q,
            "workers": worker_count,
            "load_ratio": float(lr),
            "zone": zone,
            "teacher_action": teacher,
            "bc_probs": {ACTION_NAMES[i]: float(bc_probs[i]) for i in range(5)},
            "ppo_probs": {ACTION_NAMES[i]: float(ppo_probs[i]) for i in range(5)},
            "bc_action": int(bc_probs.argmax().item()),
            "ppo_action": int(ppo_probs.argmax().item()),
            "bc_action_name": ACTION_NAMES[bc_probs.argmax().item()],
            "ppo_action_name": ACTION_NAMES[ppo_probs.argmax().item()],
            "bc_expand2": float(bc_probs[4]),
            "ppo_expand2": float(ppo_probs[4]),
            "bc_expand1": float(bc_probs[3]),
            "ppo_expand1": float(ppo_probs[3]),
            "bc_noop": float(bc_probs[2]),
            "ppo_noop": float(ppo_probs[2]),
            "bc_shrink": float(bc_probs[0]) + float(bc_probs[1]),
            "ppo_shrink": float(ppo_probs[0]) + float(ppo_probs[1]),
        }
        results.append(r)

    return results


def run_feature_sensitivity(
    bc_model_path: str = "checkpoints/bc_policy_v3_1_clean.pt",
    ppo_model_path: str = "checkpoints/ppo_policy.pt",
    output_path: str = "artifacts/feature_sensitivity.json",
):
    print("=" * 60)
    print("SPRINT 6.3: FEATURE SENSITIVITY")
    print("=" * 60)

    bc, ppo, ppo_source = load_policies(bc_model_path, ppo_model_path)
    print(f"PPO source: {ppo_source}")

    results = scan_queue_depth(bc, ppo, worker_count=50)

    print(f"\n{'Queue':>8} {'LR':>8} {'Zone':>5} "
          f"{'BC Expand2':>10} {'PPO Expand2':>10} "
          f"{'BC Noop':>10} {'PPO Noop':>10} "
          f"{'BC Action':>10} {'PPO Action':>10}")
    print("  " + "-" * 100)

    for r in results:
        print(f"  {r['queue']:>8,} {r['load_ratio']:>8.2f} {r['zone']:>5} "
              f"{r['bc_expand2']:>10.2f} {r['ppo_expand2']:>10.2f} "
              f"{r['bc_noop']:>10.2f} {r['ppo_noop']:>10.2f} "
              f"{r['bc_action_name']:>10} {r['ppo_action_name']:>10}")

    # Key analysis: is prob monotonic across zones?
    print("\n" + "=" * 60)
    print("ZONE TRANSITION ANALYSIS")
    print("=" * 60)

    zone_transitions = {}
    for r in results:
        z = r['zone']
        if z not in zone_transitions:
            zone_transitions[z] = {"bc_expand2": [], "ppo_expand2": [], "bc_noop": [], "ppo_noop": []}
        zone_transitions[z]["bc_expand2"].append(r["bc_expand2"])
        zone_transitions[z]["ppo_expand2"].append(r["ppo_expand2"])
        zone_transitions[z]["bc_noop"].append(r["bc_noop"])
        zone_transitions[z]["ppo_noop"].append(r["ppo_noop"])

    print(f"\n{'Zone':>5} {'BC Expand2':>12} {'PPO Expand2':>12} "
          f"{'BC Noop':>12} {'PPO Noop':>12}")
    print("  " + "-" * 60)
    ZONE_NAMES = ["A", "B", "C", "D", "E"]
    for z in range(5):
        if z in zone_transitions:
            vals = zone_transitions[z]
            print(f"  {ZONE_NAMES[z]:>5} "
                  f"{np.mean(vals['bc_expand2']):>12.2f} {np.mean(vals['ppo_expand2']):>12.2f} "
                  f"{np.mean(vals['bc_noop']):>12.2f} {np.mean(vals['ppo_noop']):>12.2f}")

    # Detect non-monotonic behavior (sign of model confusion)
    bc_exp2 = [r['bc_expand2'] for r in results]
    ppo_exp2 = [r['ppo_expand2'] for r in results]

    # In Zone E (last 3 points), expand2 should be monotonically increasing
    zone_e = [r for r in results if r['zone'] == 4]
    bc_exp2_ood = [r['bc_expand2'] for r in zone_e]
    ppo_exp2_ood = [r['ppo_expand2'] for r in zone_e]

    print(f"\n  Zone E (lr >= 1.0) expand2 probability:")
    for r in zone_e:
        print(f"    q={r['queue']:>7,} lr={r['load_ratio']:>7.1f} "
              f"BC={r['bc_expand2']:.3f} PPO={r['ppo_expand2']:.3f}")

    # Check for collapse in Zone E
    bc_e_min = min(bc_exp2_ood) if bc_exp2_ood else 1.0
    ppo_e_min = min(ppo_exp2_ood) if ppo_exp2_ood else 1.0
    bc_ood_collapse = any(r['bc_expand2'] < 0.3 for r in zone_e)
    ppo_ood_collapse = any(r['ppo_expand2'] < 0.3 for r in zone_e)

    print(f"\n  Zone E expand2 min:  BC={bc_e_min:.3f}  PPO={ppo_e_min:.3f}")
    print(f"  Zone E collapse:     BC={'YES ⚠' if bc_ood_collapse else 'NO ✓'}  PPO={'YES ⚠' if ppo_ood_collapse else 'NO ✓'}")

    # Verdict
    if bc_ood_collapse and not ppo_ood_collapse:
        verdict = "PPO more robust — BC collapses in Zone E OOD"
    elif ppo_ood_collapse and not bc_ood_collapse:
        verdict = "BC more robust — PPO collapses in Zone E OOD"
    elif bc_ood_collapse and ppo_ood_collapse:
        verdict = "Both collapse in Zone E OOD"
    else:
        verdict = "Both stable in Zone E OOD"

    print(f"\n  Verdict: {verdict}")

    result = {
        "ppo_source": ppo_source,
        "worker_count": 50,
        "scan_results": results,
        "zone_e_analysis": {
            "bc_expand2_values": bc_exp2_ood,
            "ppo_expand2_values": ppo_exp2_ood,
            "bc_ood_collapse": bc_ood_collapse,
            "ppo_ood_collapse": ppo_ood_collapse,
        },
        "verdict": verdict,
    }

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"\nSaved to: {output_path}")

    return result


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--bc", default="checkpoints/bc_policy_v3_1_clean.pt")
    parser.add_argument("--ppo", default="checkpoints/ppo_policy.pt")
    parser.add_argument("--output", default="artifacts/feature_sensitivity.json")
    args = parser.parse_args()
    run_feature_sensitivity(args.bc, args.ppo, args.output)


if __name__ == "__main__":
    main()
