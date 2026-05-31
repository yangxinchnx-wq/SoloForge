# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Sprint 6.2 — Logit Analysis
# Path: experiments/analysis/logit_analysis.py
#
# 目标：验证 BC 与 PPO 在何时开始产生分歧
# 固定状态 → 获取 logits → 观察 confidence 变化
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


def teacher_action(q, w):
    return get_zone(q, w)


class BCPolicy(nn.Module):
    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(10, 128), nn.ReLU(),
            nn.Linear(128, 128), nn.ReLU(),
            nn.Linear(128, 5),
        )

    def forward(self, x):
        return self.net(x)


class PPOActor(nn.Module):
    def __init__(self):
        super().__init__()
        self.shared = nn.Sequential(
            nn.Linear(10, 128), nn.ReLU(),
            nn.Linear(128, 128), nn.ReLU(),
        )
        self.actor = nn.Linear(128, 5)

    def forward(self, x):
        h = self.shared(x)
        return self.actor(h)


def build_obs(q, w, cpu=0.5):
    lr = compute_load_ratio(q, w)
    max_lr = 21.5
    lr_norm = np.log(1 + lr) / np.log(1 + max_lr)
    return np.array([q/1000., 0., 0., w/200., cpu, 0., 0., 0.,
                     get_zone(q, w)/4., lr_norm], dtype=np.float32)


ACTION_NAMES = ["shrink2", "shrink1", "noop", "expand1", "expand2"]
ZONE_NAMES = ["A", "B", "C", "D", "E"]


def load_policies(bc_path, ppo_path):
    bc = BCPolicy()
    bc_ckpt = torch.load(bc_path, map_location='cpu', weights_only=False)
    bc.load_state_dict(bc_ckpt['policy_state_dict'])
    bc.eval()

    ppo = PPOActor()
    # Try loading trained PPO first, fall back to BC warm start
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


def analyze_state(bc, ppo, q, w):
    obs = torch.FloatTensor(build_obs(q, w)).unsqueeze(0)

    with torch.no_grad():
        bc_logits = bc(obs).squeeze(0)
        ppo_logits = ppo(obs).squeeze(0)

    bc_probs = torch.softmax(bc_logits, dim=-1)
    ppo_probs = torch.softmax(ppo_logits, dim=-1)

    bc_action = bc_probs.argmax().item()
    ppo_action = ppo_probs.argmax().item()
    teacher_a = teacher_action(q, w)

    return {
        "queue": q,
        "workers": w,
        "load_ratio": float(compute_load_ratio(q, w)),
        "zone": get_zone(q, w),
        "zone_name": ZONE_NAMES[get_zone(q, w)],
        "teacher_action": teacher_a,
        "teacher_action_name": ACTION_NAMES[teacher_a],
        "bc": {
            "logits": [float(x) for x in bc_logits],
            "probs": [float(x) for x in bc_probs],
            "action": bc_action,
            "action_name": ACTION_NAMES[bc_action],
            "confidence": float(bc_probs.max()),
        },
        "ppo": {
            "logits": [float(x) for x in ppo_logits],
            "probs": [float(x) for x in ppo_probs],
            "action": ppo_action,
            "action_name": ACTION_NAMES[ppo_action],
            "confidence": float(ppo_probs.max()),
        },
        "disagree": bc_action != ppo_action,
        "bc_matches_teacher": bc_action == teacher_a,
        "ppo_matches_teacher": ppo_action == teacher_a,
    }


def run_logit_analysis(
    bc_model_path: str = "checkpoints/bc_policy_v3_1_clean.pt",
    ppo_model_path: str = "checkpoints/ppo_policy.pt",
    output_path: str = "artifacts/logit_analysis.json",
):
    print("=" * 60)
    print("SPRINT 6.2: LOGIT ANALYSIS")
    print("=" * 60)

    bc, ppo, ppo_source = load_policies(bc_model_path, ppo_model_path)
    print(f"PPO source: {ppo_source}")

    # Test cases: (queue, workers)
    test_cases = [
        (100, 50),
        (500, 50),
        (1000, 50),
        (5000, 50),
        (10000, 50),
        (20000, 50),
        (50000, 20),
        (100000, 20),
    ]

    results = []
    print(f"\n{'Queue':>8} {'W':>5} {'Zone':>5} {'Teacher':>8} "
          f"{'BC Action':>10} {'BC Conf':>8} "
          f"{'PPO Action':>10} {'PPO Conf':>8} "
          f"{'Agree?':>6}")
    print("  " + "-" * 85)

    for q, w in test_cases:
        r = analyze_state(bc, ppo, q, w)
        results.append(r)

        agree = "✓" if not r["disagree"] else "✗"
        print(f"  {q:>8,} {w:>5} {r['zone_name']:>5} {r['teacher_action_name']:>8} "
              f"{r['bc']['action_name']:>10} {r['bc']['confidence']:>8.2f} "
              f"{r['ppo']['action_name']:>10} {r['ppo']['confidence']:>8.2f} "
              f"{agree:>6}")

    # Analysis: OOD severity vs confidence
    print("\n" + "=" * 60)
    print("CONFIDENCE ANALYSIS")
    print("=" * 60)

    print(f"\n{'Zone':>5} {'LR':>8} {'BC Conf':>8} {'PPO Conf':>8} {'ΔConf':>8}")
    print("  " + "-" * 42)
    for r in results:
        delta = r['ppo']['confidence'] - r['bc']['confidence']
        print(f"  {r['zone_name']:>5} {r['load_ratio']:>8.1f} "
              f"{r['bc']['confidence']:>8.2f} {r['ppo']['confidence']:>8.2f} {delta:>+8.2f}")

    # Summary
    bc_conf_trend = [r['bc']['confidence'] for r in results]
    ppo_conf_trend = [r['ppo']['confidence'] for r in results]

    bc_drops = sum(1 for i in range(1, len(bc_conf_trend))
                   if bc_conf_trend[i] < bc_conf_trend[i-1] - 0.05)
    ppo_drops = sum(1 for i in range(1, len(ppo_conf_trend))
                    if ppo_conf_trend[i] < ppo_conf_trend[i-1] - 0.05)

    disagreements = [r for r in results if r['disagree']]
    bc_teacher_mismatches = [r for r in results if not r['bc_matches_teacher']]
    ppo_teacher_mismatches = [r for r in results if not r['ppo_matches_teacher']]

    print(f"\n  BC confidence drops (OOD):  {bc_drops}")
    print(f"  PPO confidence drops (OOD): {ppo_drops}")
    print(f"  BC-PPO disagreements:        {len(disagreements)}")
    print(f"  BC mismatches Teacher:      {len(bc_teacher_mismatches)}")
    print(f"  PPO mismatches Teacher:     {len(ppo_teacher_mismatches)}")

    if disagreements:
        print(f"\n  Disagreements:")
        for r in disagreements:
            print(f"    Zone {r['zone_name']} (LR={r['load_ratio']:.1f}): "
                  f"BC={r['bc']['action_name']} vs PPO={r['ppo']['action_name']}")

    # Verdict
    bc_conf_degraded = any(r['bc']['confidence'] < 0.5 for r in results[-3:])
    ppo_conf_degraded = any(r['ppo']['confidence'] < 0.5 for r in results[-3:])

    verdict = "PPO more robust in OOD" if ppo_conf_degraded and not bc_conf_degraded else \
              "BC more robust in OOD" if bc_conf_degraded and not ppo_conf_degraded else \
              "Both robust" if not bc_conf_degraded and not ppo_conf_degraded else \
              "Both degrade in OOD"

    print(f"\n  Verdict: {verdict}")
    print(f"  BC  OOD confidence: {'DEGRADED' if bc_conf_degraded else 'STABLE'}")
    print(f"  PPO OOD confidence: {'DEGRADED' if ppo_conf_degraded else 'STABLE'}")

    result = {
        "ppo_source": ppo_source,
        "test_cases": results,
        "summary": {
            "bc_conf_degraded": bc_conf_degraded,
            "ppo_conf_degraded": ppo_conf_degraded,
            "disagreements": len(disagreements),
            "bc_mismatches": len(bc_teacher_mismatches),
            "ppo_mismatches": len(ppo_teacher_mismatches),
            "verdict": verdict,
        }
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
    parser.add_argument("--output", default="artifacts/logit_analysis.json")
    args = parser.parse_args()
    run_logit_analysis(args.bc, args.ppo, args.output)


if __name__ == "__main__":
    main()
