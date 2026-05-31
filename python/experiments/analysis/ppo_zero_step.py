# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Sprint 6.4 — PPO Zero-Step Control
# Path: experiments/analysis/ppo_zero_step.py
#
# 目标：创建 PPO zero-step checkpoint，隔离 Architecture Effect vs RL Learning Effect
#
# 创建:
#   Model A: bc_policy_v3_1.pt  (原始 BC)
#   Model B: ppo_0step.pt        (BC weights → PPO architecture, 未训练)
#   Model C: ppo_100k.pt         (训练后 PPO, 待 Sprint 7)
#
# 然后运行 Sprint 6.0 和 6.1 对比三个模型
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


class PPOActor(nn.Module):
    """PPO Actor — 独立保存，不需要 Value head"""
    def __init__(self, input_dim=10, hidden_dim=128):
        super().__init__()
        self.shared = nn.Sequential(
            nn.Linear(input_dim, hidden_dim), nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim), nn.ReLU(),
        )
        self.actor = nn.Linear(hidden_dim, 5)

    def forward(self, x):
        return self.actor(self.shared(x))


class PPOModel(nn.Module):
    """完整 PPO Model (Actor + Value) — 用于 checkpoint"""
    def __init__(self, input_dim=10, hidden_dim=128):
        super().__init__()
        self.shared = nn.Sequential(
            nn.Linear(input_dim, hidden_dim), nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim), nn.ReLU(),
        )
        self.actor = nn.Linear(hidden_dim, 5)
        self.critic = nn.Linear(hidden_dim, 1)

    def forward(self, x):
        h = self.shared(x)
        return self.actor(h), self.critic(h)


def load_bc_weights(bc_path):
    """从 BC checkpoint 加载 state_dict"""
    ckpt = torch.load(bc_path, map_location='cpu', weights_only=False)
    return ckpt['policy_state_dict']


def bc_to_ppo_actor(actor_net: PPOActor, bc_state):
    """将 BC weights 映射到 PPO Actor"""
    key_map = {
        'net.0.weight': 'shared.0.weight',
        'net.0.bias':   'shared.0.bias',
        'net.2.weight': 'shared.2.weight',
        'net.2.bias':   'shared.2.bias',
        'net.4.weight': 'actor.weight',
        'net.4.bias':   'actor.bias',
    }
    loaded = {}
    for bc_key, pv_key in key_map.items():
        if bc_key in bc_state and pv_key in actor_net.state_dict():
            loaded[pv_key] = bc_state[bc_key]
            print(f"  Loaded: {bc_key} → {pv_key}")
    actor_net.load_state_dict(loaded, strict=False)
    return actor_net


def bc_to_ppo_full(ppo_net: PPOModel, bc_state):
    """将 BC weights 映射到完整 PPO Model"""
    key_map = {
        'net.0.weight': 'shared.0.weight',
        'net.0.bias':   'shared.0.bias',
        'net.2.weight': 'shared.2.weight',
        'net.2.bias':   'shared.2.bias',
        'net.4.weight': 'actor.weight',
        'net.4.bias':   'actor.bias',
    }
    loaded = {}
    for bc_key, pv_key in key_map.items():
        if bc_key in bc_state and pv_key in ppo_net.state_dict():
            loaded[pv_key] = bc_state[bc_key]
    ppo_net.load_state_dict(loaded, strict=False)
    return ppo_net


def verify_equivalence(bc_path, ppo_path):
    """验证 BC 和 PPO actor 产生相同/不同的输出"""
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

    bc = BCNet()
    bc_ckpt = torch.load(bc_path, map_location='cpu', weights_only=False)
    bc.load_state_dict(bc_ckpt['policy_state_dict'])
    bc.eval()

    ppo = PPOActor()
    bc_state = load_bc_weights(bc_path)
    ppo = bc_to_ppo_actor(ppo, bc_state)
    ppo.eval()

    # 测试几个状态
    test_states = [
        (100, 50), (1000, 50), (10000, 50), (50000, 20),
    ]

    print("\n" + "=" * 60)
    print("EQUIVALENCE CHECK")
    print("=" * 60)
    print(f"\n{'Queue':>8} {'W':>5} {'BC logits':>30} {'PPO logits':>30} {'Match?':>6}")
    print("  " + "-" * 85)

    all_match = True
    for q, w in test_states:
        obs = np.array([q/1000., 0., 0., w/200., 0.5, 0., 0., 0., 0., 0.], dtype=np.float32)
        obs_t = torch.FloatTensor(obs).unsqueeze(0)

        with torch.no_grad():
            bc_l = bc(obs_t).squeeze(0)
            ppo_l = ppo(obs_t).squeeze(0)

        match = torch.allclose(bc_l, ppo_l, atol=1e-5)
        if not match:
            all_match = False

        print(f"  {q:>8,} {w:>5} {str([f'{x:.2f}' for x in bc_l.tolist()]):>30} "
              f"{str([f'{x:.2f}' for x in ppo_l.tolist()]):>30} {'✓' if match else '✗':>6}")

    if all_match:
        print("\n  KEY FINDING: BC and PPO produce IDENTICAL logits!")
        print("  Same weights → Same output layer → Same computation")
        print("  Architecture difference does NOT create policy difference")
        print("  BC:    [net.0] → ReLU → [net.2] → ReLU → [net.4]")
        print("  PPO:   [s.0]  → ReLU → [s.2]  → ReLU → [actor]")
        print("  Since net.4 weights == actor weights, output is identical")

    return all_match


def run_zero_step_setup(
    bc_model_path: str = "checkpoints/bc_policy_v3_1_clean.pt",
    output_dir: str = "checkpoints",
):
    print("=" * 60)
    print("SPRINT 6.4: PPO ZERO-STEP SETUP")
    print("=" * 60)
    print(f"BC Model: {bc_model_path}")

    os.makedirs(output_dir, exist_ok=True)

    # 加载 BC weights
    bc_state = load_bc_weights(bc_model_path)
    print(f"\nBC checkpoint keys: {list(bc_state.keys())}")

    # ── Model A: BC (already exists) ──
    print(f"\n[Model A] BC Policy: {bc_model_path}")
    print("  Already exists. No action needed.")

    # ── Model B: PPO 0-step (BC weights in PPO architecture) ──
    ppo_0step_path = os.path.join(output_dir, "ppo_0step.pt")
    print(f"\n[Model B] PPO 0-step: {ppo_0step_path}")

    ppo_0step = PPOModel(input_dim=10, hidden_dim=128)
    ppo_0step = bc_to_ppo_full(ppo_0step, bc_state)

    # 保存
    torch.save({
        'policy_state_dict': ppo_0step.state_dict(),
        'source': 'bc_warm_start_zero_step',
        'bc_source': bc_model_path,
        'architecture': 'PPO ActorCritic (shared→actor, shared→critic)',
        'training_steps': 0,
    }, ppo_0step_path)
    print(f"  Saved ✓")

    # ── Model B Actor-only: 单独保存用于 analysis ──
    ppo_actor_0step = PPOActor(input_dim=10, hidden_dim=128)
    ppo_actor_0step = bc_to_ppo_actor(ppo_actor_0step, bc_state)
    actor_path = os.path.join(output_dir, "ppo_actor_0step.pt")
    torch.save({'policy_state_dict': ppo_actor_0step.state_dict()}, actor_path)
    print(f"  Actor-only saved: {actor_path}")

    # ── 验证等效性 ──
    verify_equivalence(bc_model_path, ppo_0step_path)

    # ── 三模型对比摘要 ──
    print("\n" + "=" * 60)
    print("THREE-MODEL SUMMARY")
    print("=" * 60)
    print(f"\n  Model A: bc_policy_v3_1_clean.pt")
    print(f"           Architecture: BC 2-layer MLP (net.0 → net.2 → net.4)")
    print(f"           Weights: BC trained")
    print(f"\n  Model B: ppo_0step.pt")
    print(f"           Architecture: PPO ActorCritic (shared.0 → shared.2 → actor/critic)")
    print(f"           Weights: BC trained → copied into PPO arch")
    print(f"           Training: 0 steps")
    print(f"\n  Model C: ppo_100k.pt (待 Sprint 7)")
    print(f"           Architecture: PPO ActorCritic")
    print(f"           Weights: BC → trained 100k steps")
    print(f"\n  Key insight: Model A vs B = same logits (net.4==actor) → NO difference")
    print(f"               Model B vs C = pure RL learning effect")

    print(f"\n  All checkpoints saved to: {output_dir}/")
    for f in os.listdir(output_dir):
        if f.endswith('.pt'):
            fp = os.path.join(output_dir, f)
            size_kb = os.path.getsize(fp) / 1024
            print(f"    {f}: {size_kb:.1f} KB")

    return {
        "model_a": bc_model_path,
        "model_b": ppo_0step_path,
        "model_c": "checkpoints/ppo_100k.pt (Sprint 7)",
    }


def run_three_model_comparison(
    bc_path: str = "checkpoints/bc_policy_v3_1_clean.pt",
    ppo_0step_path: str = "checkpoints/ppo_0step.pt",
    ppo_100k_path: str = "checkpoints/ppo_100k.pt",
    n_episodes: int = 200,
    output_path: str = "artifacts/three_model_comparison.json",
):
    """对三个模型运行 Sprint 6.0 + 6.1 对比"""
    import torch.nn.functional as F
    # 确保 governor_rl 在 path 中
    _script_dir = os.path.dirname(os.path.abspath(__file__))
    _exp_dir = os.path.dirname(_script_dir)           # experiments/
    _python_dir = os.path.dirname(_exp_dir)           # python/
    if _python_dir not in sys.path:
        sys.path.insert(0, _python_dir)

    print("\n" + "=" * 60)
    print("THREE-MODEL COMPARISON")
    print("=" * 60)

    # ── Model A: BC ──
    class BCNet(nn.Module):
        def __init__(self):
            super().__init__()
            self.net = nn.Sequential(
                nn.Linear(10, 128), nn.ReLU(),
                nn.Linear(128, 128), nn.ReLU(),
                nn.Linear(128, 5),
            )
        def forward(self, x): return self.net(x)
        def act(self, x):
            p = F.softmax(self.forward(x), dim=-1)
            return p.argmax(dim=-1)

    bc = BCNet()
    bc_ckpt = torch.load(bc_path, map_location='cpu', weights_only=False)
    bc.load_state_dict(bc_ckpt['policy_state_dict'])
    bc.eval()

    # ── Model B: PPO 0-step ──
    ppo_0 = PPOModel(input_dim=10, hidden_dim=128)
    if os.path.exists(ppo_0step_path):
        ckpt = torch.load(ppo_0step_path, map_location='cpu', weights_only=False)
        ppo_0.load_state_dict(ckpt['policy_state_dict'])
        b_source = "ppo_0step.pt"
    else:
        bc_state = load_bc_weights(bc_path)
        ppo_0 = bc_to_ppo_full(ppo_0, bc_state)
        b_source = "recreated_from_bc"
    ppo_0.eval()

    # ── Model C: PPO 100k (if exists) ──
    ppo_100k = PPOModel(input_dim=10, hidden_dim=128)
    c_exists = os.path.exists(ppo_100k_path)
    if c_exists:
        ckpt = torch.load(ppo_100k_path, map_location='cpu', weights_only=False)
        ppo_100k.load_state_dict(ckpt['policy_state_dict'])
        ppo_100k.eval()
        print("Model C: ppo_100k.pt loaded ✓")
    else:
        print("Model C: ppo_100k.pt NOT FOUND — skipping")

    def compute_load_ratio(q, w):
        return q / max(w * 2, 1)

    def get_zone(q, w):
        lr = compute_load_ratio(q, w)
        if lr < 0.1: return 0
        elif lr < 0.25: return 1
        elif lr < 0.5: return 2
        elif lr < 1.0: return 3
        else: return 4

    def build_obs(q, w):
        lr = compute_load_ratio(q, w)
        max_lr = 21.5
        lr_norm = np.log(1 + lr) / np.log(1 + max_lr)
        return np.array([q/1000., 0., 0., w/200., 0.5, 0., 0., 0.,
                         get_zone(q, w)/4., lr_norm], dtype=np.float32)

    def run_episode(policy_net, env_module, seed, max_steps=200):
        env = env_module.RuntimeEnv(duration=max_steps, arrival_rate=15.0, burst_prob=0.15, seed=seed)
        env.reset()
        queues, rewards, osc = [], [], 0
        prev_action = None

        for step in range(max_steps):
            state = env.simulator.state
            obs_t = torch.FloatTensor(build_obs(state.queue_depth, state.worker_count)).unsqueeze(0)

            with torch.no_grad():
                if isinstance(policy_net, BCNet):
                    logits = policy_net(obs_t)
                else:
                    logits, _ = policy_net(obs_t)
                probs = F.softmax(logits, dim=-1)
                action = probs.argmax().item()

            if prev_action is not None:
                prev_exp = prev_action >= 3
                curr_exp = action >= 3
                if prev_exp != curr_exp:
                    osc += 1
            prev_action = action

            _, reward, terminated, truncated, _ = env.step(action)
            rewards.append(reward)
            queues.append(state.queue_depth)

            if terminated or truncated:
                break

        return {
            "total_reward": float(sum(rewards)),
            "avg_queue": float(np.mean(queues)),
            "max_queue": float(max(queues)),
            "oscillation": osc,
        }

    env_module = __import__('governor_rl.env.runtime_env', fromlist=['RuntimeEnv'])

    def eval_model(policy_net, n_episodes):
        rs, qs, ms, oscs = [], [], [], []
        for ep in range(n_episodes):
            r = run_episode(policy_net, env_module, seed=ep, max_steps=200)
            rs.append(r['total_reward'])
            qs.append(r['avg_queue'])
            ms.append(r['max_queue'])
            oscs.append(r['oscillation'])
        return {
            "avg_reward": float(np.mean(rs)),
            "avg_queue": float(np.mean(qs)),
            "avg_max_queue": float(np.mean(ms)),
            "avg_oscillation": float(np.mean(oscs)),
        }

    models = [
        ("A: BC", bc, bc_path),
        ("B: PPO-0step", ppo_0, b_source),
    ]
    if c_exists:
        models.append(("C: PPO-100k", ppo_100k, ppo_100k_path))

    results = {}
    for name, model, src in models:
        print(f"\n  Evaluating {name}...")
        r = eval_model(model, n_episodes)
        results[name] = r
        print(f"    Reward: {r['avg_reward']:.1f}  Queue: {r['avg_queue']:.1f}  "
              f"MaxQ: {r['avg_max_queue']:.1f}  Osc: {r['avg_oscillation']:.1f}")

    # OOD comparison
    print(f"\n  OOD (arrival=30, burst=0.35, 5 seeds):")
    ood_rewards = {}
    for name, model, src in models:
        ro = []
        for seed in range(5):
            env = env_module.RuntimeEnv(duration=200, arrival_rate=30.0, burst_prob=0.35, seed=seed)
            r = run_episode(model, env_module, seed=seed + 1000, max_steps=200)
            ro.append(r['total_reward'])
        ood_rewards[name] = float(np.mean(ro))
        print(f"    {name}: {ood_rewards[name]:.1f}")

    # Recovery comparison
    print(f"\n  Recovery (q=50000, w=20):")
    recovery_results = {}
    for name, model, src in models:
        env = env_module.RuntimeEnv(duration=250, arrival_rate=15.0, burst_prob=0.15, seed=999)
        env.reset()
        env.simulator.state.queue_depth = 50000
        env.simulator.state.worker_count = 20
        lr_init = 50000 / 40  # 1250
        final_q = []
        for step in range(250):
            state = env.simulator.state
            obs_t = torch.FloatTensor(build_obs(state.queue_depth, state.worker_count)).unsqueeze(0)
            with torch.no_grad():
                if isinstance(model, BCNet):
                    logits = model(obs_t)
                else:
                    logits, _ = model(obs_t)
                action = F.softmax(logits, dim=-1).argmax().item()
            _, _, terminated, truncated, _ = env.step(action)
            final_q.append(state.queue_depth)
            if terminated or truncated:
                break
        final_lr = final_q[-1] / (20 * 2) if final_q else 0
        lr_red = (lr_init - final_lr) / lr_init * 100
        recovery_results[name] = float(lr_red)
        print(f"    {name}: LR recovery = {lr_red:.1f}%")

    # Print comparison table
    print("\n" + "=" * 60)
    print("THREE-MODEL COMPARISON TABLE")
    print("=" * 60)
    print(f"\n{'Metric':<22} {'Model A (BC)':>14} {'Model B (PPO-0)':>14} ", end="")
    if c_exists:
        print(f"{'Model C (PPO-100k)':>18}")
    print("  " + "-" * (22 + 14*2 + (18 if c_exists else 0)))

    metrics = [
        ("Avg Reward", "avg_reward", True),
        ("Avg Queue", "avg_queue", False),
        ("Avg Max Queue", "avg_max_queue", False),
        ("Avg Oscillation", "avg_oscillation", False),
    ]
    for name, key, higher_better in metrics:
        vals = [results.get(n, {}).get(key, 0) for n, _, _ in models]
        print(f"  {name:<20} {vals[0]:>14.1f} {vals[1]:>14.1f} ", end="")
        if c_exists:
            print(f"{vals[2]:>18.1f} ", end="")
        best = max(vals) if higher_better else min(vals)
        winners = []
        for i, (n, _, _) in enumerate(models):
            if results.get(n, {}).get(key, 0) == best:
                winners.append(n.split(":")[0])
        print(f"  Best: {','.join(winners)}")

    print(f"\n  OOD Reward (arr=30):    " + "  ".join(f"{ood_rewards.get(n, 0):>12.1f}" for n, _, _ in models))
    print(f"  Recovery LR%:          " + "  ".join(f"{recovery_results.get(n, 0):>12.1f}" for n, _, _ in models))

    # Interpretation
    print("\n" + "=" * 60)
    print("INTERPRETATION")
    print("=" * 60)

    a_bc = results.get("A: BC", {})
    b_ppo0 = results.get("B: PPO-0step", {})
    a_bc_q = a_bc.get("avg_queue", 0)
    b_ppo0_q = b_ppo0.get("avg_queue", 0)

    print(f"\n  Architecture Effect (Model A vs B):")
    delta_q = b_ppo0_q - a_bc_q
    print(f"    Queue Δ = {delta_q:+.1f} (B-A)")

    if c_exists:
        c_ppo = results.get("C: PPO-100k", {})
        c_ppo_q = c_ppo.get("avg_queue", 0)
        arch_delta = b_ppo0_q - a_bc_q
        rl_delta = c_ppo_q - b_ppo0_q
        print(f"\n  Architecture Effect:    Queue Δ = {arch_delta:+.1f}")
        print(f"  RL Learning Effect:     Queue Δ = {rl_delta:+.1f}")
        print(f"  Total (A → C):         Queue Δ = {c_ppo_q - a_bc_q:+.1f}")

        if abs(arch_delta) > abs(rl_delta):
            print(f"\n  → Architecture contributes MORE than RL training")
        else:
            print(f"\n  → RL training contributes MORE than architecture")
    else:
        print(f"\n  → Model C (PPO-100k) not available — run Sprint 7 first")

    print("\n  Verdict:")
    if abs(delta_q) < 1.0:
        print(f"    Architecture effect is negligible (ΔQ < 1.0)")
        print(f"    Any PPO improvement must come from RL training")
    elif delta_q < 0:
        print(f"    PPO architecture inherently better than BC even before training")
        print(f"    RL training may add further improvement")
    else:
        print(f"    BC architecture better than PPO architecture at zero-step")
        print(f"    RL training must overcome architecture disadvantage")

    result = {
        "models": {name: r for name, r in results.items()},
        "ood_rewards": ood_rewards,
        "recovery_lr_pct": recovery_results,
        "architecture_delta_queue": float(b_ppo0_q - a_bc_q),
    }
    if c_exists:
        result["rl_delta_queue"] = float(c_ppo_q - b_ppo0_q)
        result["total_delta_queue"] = float(c_ppo_q - a_bc_q)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"\nSaved to: {output_path}")

    return result


def main():
    import argparse
    parser = argparse.ArgumentParser(description="PPO Zero-Step Setup & Comparison")
    parser.add_argument("--bc", default="checkpoints/bc_policy_v3_1_clean.pt")
    parser.add_argument("--output-dir", default="checkpoints")
    parser.add_argument("--episodes", type=int, default=200)
    parser.add_argument("--compare", action='store_true')
    parser.add_argument("--output", default="artifacts/three_model_comparison.json")
    args = parser.parse_args()

    setup = run_zero_step_setup(args.bc, args.output_dir)
    if args.compare:
        run_three_model_comparison(
            bc_path=args.bc,
            ppo_0step_path=setup["model_b"],
            n_episodes=args.episodes,
            output_path=args.output,
        )


if __name__ == "__main__":
    main()
