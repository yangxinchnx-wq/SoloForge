# -*- coding: utf-8 -*-
# Sprint 7 Final: BC vs PPO-0 vs PPO-100k comparison

import sys, os
import torch
import torch.nn as nn
import numpy as np
import json

sys.stdout.reconfigure(encoding='utf-8')
python_dir = r"C:\Users\yangx\Desktop\SoloForge\python"
sys.path.insert(0, python_dir)

import torch.nn.functional as F

class BCNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(10, 128), nn.ReLU(),
            nn.Linear(128, 128), nn.ReLU(),
            nn.Linear(128, 5),
        )
    def forward(self, x): return self.net(x)

class PPOModel(nn.Module):
    def __init__(self):
        super().__init__()
        self.shared = nn.Sequential(
            nn.Linear(10, 128), nn.ReLU(),
            nn.Linear(128, 128), nn.ReLU(),
        )
        self.actor = nn.Linear(128, 5)
        self.critic = nn.Linear(128, 1)
    def forward(self, x):
        h = self.shared(x)
        return self.actor(h), self.critic(h)

def compute_lr(q, w): return q / max(w * 2, 1)
def get_zone(q, w):
    lr = compute_lr(q, w)
    if lr < 0.1: return 0
    elif lr < 0.25: return 1
    elif lr < 0.5: return 2
    elif lr < 1.0: return 3
    else: return 4
def build_obs(q, w):
    lr = compute_lr(q, w)
    max_lr = 21.5
    lr_norm = np.log(1 + lr) / np.log(1 + max_lr)
    return np.array([q/1000.,0.,0.,w/200.,0.5,0.,0.,0.,get_zone(q,w)/4.,lr_norm], dtype=np.float32)

env_module = __import__('governor_rl.env.runtime_env', fromlist=['RuntimeEnv'])

# Load models
bc = BCNet()
bc.load_state_dict(torch.load("checkpoints/bc_policy_v3_1_clean.pt", map_location='cpu', weights_only=False)['policy_state_dict'])
bc.eval()

ppo_0 = PPOModel()
ppo_0.load_state_dict(torch.load("checkpoints/ppo_0step.pt", map_location='cpu', weights_only=False)['policy_state_dict'])
ppo_0.eval()

ppo_100k = PPOModel()
ppo_100k.load_state_dict(torch.load("checkpoints/ppo_100k.pt", map_location='cpu', weights_only=False)['policy_state_dict'])
ppo_100k.eval()

def get_logits(net, obs):
    if isinstance(net, BCNet):
        return net(obs)
    else:
        logits, _ = net(obs)
        return logits

def run_ep(net, seed, max_steps=200):
    env = env_module.RuntimeEnv(duration=max_steps, arrival_rate=15.0, burst_prob=0.15, seed=seed)
    env.reset()
    queues, rewards, osc = [], [], 0
    prev_a = None
    for s in range(max_steps):
        st = env.simulator.state
        obs = torch.FloatTensor(build_obs(st.queue_depth, st.worker_count)).unsqueeze(0)
        with torch.no_grad():
            logits = get_logits(net, obs)
            a = F.softmax(logits, dim=-1).argmax().item()
        if prev_a is not None and (prev_a >= 3) != (a >= 3): osc += 1
        prev_a = a
        _, r, t, tr, _ = env.step(a)
        rewards.append(r); queues.append(st.queue_depth)
        if t or tr: break
    return sum(rewards), np.mean(queues), max(queues) if queues else 0, osc

def eval_model(net, n=200):
    rs, qs, ms, oscs = [], [], [], []
    for ep in range(n):
        r, q, mq, osc = run_ep(net, ep)
        rs.append(r); qs.append(q); ms.append(mq); oscs.append(osc)
    return np.mean(rs), np.mean(qs), np.mean(ms), np.mean(oscs)

def eval_ood(net, ar, bp):
    ro = []
    for seed in range(5):
        env = env_module.RuntimeEnv(duration=200, arrival_rate=ar, burst_prob=bp, seed=seed+1000)
        env.reset()
        qs = []
        for s in range(200):
            st = env.simulator.state
            obs = torch.FloatTensor(build_obs(st.queue_depth, st.worker_count)).unsqueeze(0)
            with torch.no_grad():
                logits = get_logits(net, obs)
                a = F.softmax(logits, dim=-1).argmax().item()
            _, _, t, tr, _ = env.step(a)
            qs.append(st.queue_depth)
            if t or tr: break
        ro.append(np.mean(qs))
    return np.mean(ro)

def eval_recovery(net):
    env = env_module.RuntimeEnv(duration=250, arrival_rate=15.0, burst_prob=0.15, seed=999)
    env.reset()
    env.simulator.state.queue_depth = 50000
    env.simulator.state.worker_count = 20
    lr0 = 50000 / 40
    final_q = []
    for s in range(250):
        st = env.simulator.state
        obs = torch.FloatTensor(build_obs(st.queue_depth, st.worker_count)).unsqueeze(0)
        with torch.no_grad():
            logits = get_logits(net, obs)
            a = F.softmax(logits, dim=-1).argmax().item()
        _, _, t, tr, _ = env.step(a)
        final_q.append(st.queue_depth)
        if t or tr: break
    f_lr = final_q[-1] / 40 if final_q else 0
    return (lr0 - f_lr) / lr0 * 100

print("=" * 60)
print("SPRINT 7 FINAL: BC vs PPO-0 vs PPO-100k")
print("=" * 60)

models = [
    ("A: BC (Original)", bc),
    ("B: PPO-0 (BC Warm Start)", ppo_0),
    ("C: PPO-100k (Trained)", ppo_100k),
]

results = {}
for name, model in models:
    print(f"\nEvaluating {name}...")
    r, q, mq, osc = eval_model(model, 200)
    ood_25 = eval_ood(model, 25.0, 0.30)
    ood_30 = eval_ood(model, 30.0, 0.35)
    rec = eval_recovery(model)
    results[name] = {"reward": r, "queue": q, "max_queue": mq, "osc": osc,
                     "ood_25": ood_25, "ood_30": ood_30, "recovery": rec}
    print(f"  Reward={r:.1f} Queue={q:.1f} MaxQ={mq:.1f} Osc={osc:.1f}")
    print(f"  OOD-25={ood_25:.1f} OOD-30={ood_30:.1f} Recovery={rec:.1f}%")

print("\n" + "=" * 60)
print("THREE-MODEL COMPARISON TABLE")
print("=" * 60)
print(f"\n{'Metric':<22} {'A: BC':>14} {'B: PPO-0':>14} {'C: PPO-100k':>14} {'Best':>8}")
print("  " + "-" * 76)

rows = [
    ("Avg Reward", "reward", True),
    ("Avg Queue", "queue", False),
    ("Avg Max Queue", "max_queue", False),
    ("Avg Oscillation", "osc", False),
    ("OOD-25 Avg Queue", "ood_25", False),
    ("OOD-30 Avg Queue", "ood_30", False),
    ("Recovery LR%", "recovery", True),
]

for name, key, higher_better in rows:
    vals = [results[m[0]][key] for m in models]
    best = max(vals) if higher_better else min(vals)
    winners = [m[0].split(":")[0] for m in models if results[m[0]][key] == best]
    print(f"  {name:<20} {vals[0]:>14.1f} {vals[1]:>14.1f} {vals[2]:>14.1f} {','.join(winners):>8}")

# Interpretation
print("\n" + "=" * 60)
print("INTERPRETATION")
print("=" * 60)

a = results["A: BC (Original)"]
b = results["B: PPO-0 (BC Warm Start)"]
c = results["C: PPO-100k (Trained)"]

arch_delta_q = b["queue"] - a["queue"]
rl_delta_q = c["queue"] - b["queue"]
total_delta_q = c["queue"] - a["queue"]

arch_delta_r = b["reward"] - a["reward"]
rl_delta_r = c["reward"] - b["reward"]

print(f"\n  Architecture Effect (A → B):")
print(f"    Queue Δ = {arch_delta_q:+.1f} ({'PPO arch better' if arch_delta_q < 0 else 'BC arch better'})")
print(f"    Reward Δ = {arch_delta_r:+.1f}")

print(f"\n  RL Learning Effect (B → C):")
print(f"    Queue Δ = {rl_delta_q:+.1f} ({'PPO-100k better' if rl_delta_q < 0 else 'PPO-100k worse'})")
print(f"    Reward Δ = {rl_delta_r:+.1f}")

print(f"\n  Total (A → C):")
print(f"    Queue Δ = {total_delta_q:+.1f}")
print(f"    Reward Δ = {c['reward'] - a['reward']:+.1f}")

print(f"\n  Verdict:")
if rl_delta_q < -2 and rl_delta_r > 5:
    print(f"    → RL training genuinely helps: lower queue + higher reward")
elif abs(rl_delta_q) < 2 and abs(rl_delta_r) < 5:
    print(f"    → RL training has minimal effect: PPO ≈ BC warm start")
elif rl_delta_q > 2 or rl_delta_r < -5:
    print(f"    → RL training degraded performance")
else:
    print(f"    → Mixed results (within noise)")

print("\n  Architecture vs RL contribution:")
if abs(arch_delta_q) > abs(rl_delta_q):
    print(f"    → Architecture effect larger than RL effect")
else:
    print(f"    → RL training effect larger than (or comparable to) architecture")

print("\n" + "=" * 60)

# Save
with open("artifacts/sprint7_final_comparison.json", 'w', encoding='utf-8') as f:
    json.dump({k: {kk: float(vv) for kk, vv in v.items()} for k, v in results.items()}, f, indent=2, ensure_ascii=False)
print("Saved to: artifacts/sprint7_final_comparison.json")
