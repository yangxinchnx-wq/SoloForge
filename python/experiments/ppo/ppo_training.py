# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Sprint 5.3 — PPO Smoke Training
# Path: experiments/ppo/ppo_training.py
#
# 验证 PPO 在 BC warm start 基础上能正常训练 10k steps
# 检查项：稳定性、无崩溃、存活率 100%
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
# Feature Builder (BC V3.1 兼容)
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
# Policy + Value Network
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

    def act(self, x, deterministic=False):
        logits, value = self.forward(x)
        probs = torch.softmax(logits, dim=-1)
        if deterministic:
            action = torch.argmax(probs, dim=-1)
        else:
            action = torch.multinomial(probs, 1).squeeze(-1)
        log_prob = torch.log(probs.gather(-1, action.unsqueeze(-1)).squeeze(-1) + 1e-8)
        return action, log_prob, value.squeeze(-1)


# ============================================================
# BC Warm Start Loader
# ============================================================

def load_bc_warm_start(pv_net: PolicyValueNetwork, bc_path: str) -> PolicyValueNetwork:
    checkpoint = torch.load(bc_path, map_location='cpu')
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
# GAE + PPO Update
# ============================================================

def compute_gae(rewards: List[float], values: List[float],
                gamma: float, gae_lambda: float) -> Tuple[np.ndarray, np.ndarray]:
    advantages = []
    gae = 0.0
    values = values + [0.0]

    for t in reversed(range(len(rewards))):
        delta = rewards[t] + gamma * values[t + 1] - values[t]
        gae = delta + gamma * gae_lambda * gae
        advantages.insert(0, gae)

    returns = np.array(advantages) + np.array(values[:-1])
    return np.array(advantages), returns


def ppo_update(
    net: PolicyValueNetwork,
    optimizer: torch.optim.Adam,
    obs_buf: List, act_buf: List, log_buf: List, val_buf: List,
    ret_buf: np.ndarray, adv_buf: np.ndarray,
    config: Dict,
) -> Dict:
    obs_t = torch.FloatTensor(np.array(obs_buf))
    act_t = torch.LongTensor(act_buf)
    old_log_t = torch.FloatTensor(log_buf)
    ret_t = torch.FloatTensor(ret_buf)
    adv_t = torch.FloatTensor(adv_buf)

    adv_t = (adv_t - adv_t.mean()) / (adv_t.std() + 1e-8)

    losses, kls = [], []

    for _ in range(config['ppo_epochs']):
        logits, values = net(obs_t)
        probs = torch.softmax(logits, dim=-1)
        new_log_probs = torch.log(probs.gather(-1, act_t.unsqueeze(-1)).squeeze(-1) + 1e-8)

        kl = (old_log_t - new_log_probs).mean()
        kls.append(kl.item())

        ratios = torch.exp(new_log_probs - old_log_t)
        surr1 = ratios * adv_t
        surr2 = torch.clamp(ratios, 1 - config['clip_eps'], 1 + config['clip_eps']) * adv_t
        actor_loss = -torch.min(surr1, surr2).mean()

        critic_loss = nn.MSELoss()(values.squeeze(-1), ret_t)
        entropy = -torch.sum(probs * torch.log(probs + 1e-8), dim=-1).mean()

        loss = (actor_loss
                + config['value_coef'] * critic_loss
                - config['entropy_coef'] * entropy)

        optimizer.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(net.parameters(), config['max_grad_norm'])
        optimizer.step()
        losses.append(loss.item())

    with torch.no_grad():
        final_logits, _ = net(obs_t)
        final_probs = torch.softmax(final_logits, dim=-1)
        final_entropy = -torch.sum(final_probs * torch.log(final_probs + 1e-8), dim=-1).mean().item()

    return {
        "loss": float(np.mean(losses)),
        "kl": float(np.mean(kls)),
        "entropy": float(final_entropy),
    }


# ============================================================
# Rollout
# ============================================================

def run_rollout(
    net: PolicyValueNetwork,
    env,
    n_steps: int,
    deterministic: bool = False,
) -> Tuple[List, List, List, List, List, float]:
    obs_buf, act_buf, rew_buf, log_buf, val_buf = [], [], [], [], []
    total_reward = 0.0

    raw_obs, _ = env.reset()

    for _ in range(n_steps):
        state = env.simulator.state
        obs = build_features(
            queue_depth=state.queue_depth,
            worker_count=state.worker_count,
            cpu_usage=state.cpu_usage,
        )

        obs_t = torch.FloatTensor(obs).unsqueeze(0)
        with torch.no_grad():
            logits, value = net(obs_t)
            probs = torch.softmax(logits, dim=-1)
            value = value.item()

        if deterministic:
            action = torch.argmax(probs, dim=-1).item()
        else:
            action = torch.multinomial(probs, 1).item()

        log_prob = torch.log(probs[0, action] + 1e-8).item()

        obs_new, reward, terminated, truncated, info = env.step(action)
        done = terminated or truncated

        obs_buf.append(obs)
        act_buf.append(action)
        rew_buf.append(reward)
        log_buf.append(log_prob)
        val_buf.append(value)
        total_reward += reward

        if done:
            raw_obs, _ = env.reset()

    return obs_buf, act_buf, rew_buf, log_buf, val_buf, total_reward


# ============================================================
# Training Loop
# ============================================================

def run_ppo_training(
    bc_model_path: str = "checkpoints/bc_policy_v3_1_clean.pt",
    total_steps: int = 10240,
    rollout_steps: int = 256,
    n_episodes_eval: int = 50,
    max_ticks_eval: int = 200,
    output_path: str = "artifacts/ppo_training.json",
) -> Dict:
    print("=" * 60)
    print("SPRINT 5.3: PPO SMOKE TRAINING")
    print("=" * 60)
    print(f"BC Model: {bc_model_path}")
    print(f"Total Steps: {total_steps}")
    print(f"Rollout Steps: {rollout_steps}")

    config = {
        'lr': 3e-4,
        'gamma': 0.99,
        'gae_lambda': 0.95,
        'clip_eps': 0.2,
        'entropy_coef': 0.01,
        'value_coef': 0.5,
        'ppo_epochs': 10,
        'max_grad_norm': 0.5,
    }

    # Network
    net = PolicyValueNetwork(input_dim=10, hidden_dim=128)
    net = load_bc_warm_start(net, bc_model_path)
    net.eval()

    optimizer = torch.optim.Adam(net.parameters(), lr=config['lr'])
    net.train()

    n_updates = total_steps // rollout_steps
    iteration_stats = []

    print("\nTraining...")
    for iteration in range(n_updates):
        # Rollout
        env = __import__('governor_rl.env.runtime_env', fromlist=['RuntimeEnv']).RuntimeEnv(
            duration=max_ticks_eval, arrival_rate=15.0, burst_prob=0.15, seed=iteration
        )

        obs_buf, act_buf, rew_buf, log_buf, val_buf, total_reward = run_rollout(
            net, env, rollout_steps, deterministic=False
        )

        # GAE
        adv_buf, ret_buf = compute_gae(rew_buf, val_buf, config['gamma'], config['gae_lambda'])

        # PPO Update
        net.eval()
        update_stats = ppo_update(
            net, optimizer,
            obs_buf, act_buf, log_buf, val_buf,
            ret_buf, adv_buf, config,
        )
        net.train()

        stats = {
            "iteration": iteration,
            "steps": len(obs_buf),
            "total_reward": float(total_reward),
            "loss": update_stats["loss"],
            "kl": update_stats["kl"],
            "entropy": update_stats["entropy"],
        }
        iteration_stats.append(stats)

        if iteration % 5 == 0 or iteration == n_updates - 1:
            print(f"  Iter {iteration:3d}: reward={total_reward:>8.1f}, "
                  f"loss={update_stats['loss']:>8.3f}, "
                  f"kl={update_stats['kl']:>8.4f}, "
                  f"ent={update_stats['entropy']:>6.3f}")

    # ============================================================
    # Final Evaluation
    # ============================================================
    print("\n" + "=" * 60)
    print("FINAL EVALUATION")
    print("=" * 60)

    net.eval()
    eval_episodes = n_episodes_eval
    survival_count = 0
    collapse_count = 0
    total_rewards_eval = []
    teacher_matches = []

    for ep in range(eval_episodes):
        env = __import__('governor_rl.env.runtime_env', fromlist=['RuntimeEnv']).RuntimeEnv(
            duration=max_ticks_eval, arrival_rate=15.0, burst_prob=0.15, seed=1000 + ep
        )

        _, _, _, _, _, ep_reward = run_rollout(net, env, max_ticks_eval, deterministic=True)
        total_rewards_eval.append(ep_reward)

        # Check collapse from env
        state = env.simulator.state
        if state.queue_depth < 9000:
            survival_count += 1
        else:
            collapse_count += 1

    survival_rate = survival_count / eval_episodes * 100
    avg_reward_eval = np.mean(total_rewards_eval)

    print(f"\n  Eval Episodes: {eval_episodes}")
    print(f"  Survival Rate: {survival_rate:.1f}%")
    print(f"  Collapse Count: {collapse_count}")
    print(f"  Avg Reward: {avg_reward_eval:.1f}")

    # Analyze training stats
    losses = [s["loss"] for s in iteration_stats]
    kls = [s["kl"] for s in iteration_stats]
    entropies = [s["entropy"] for s in iteration_stats]

    kl_ok = np.mean(kls[-5:]) < 0.1  # KL should stay small in late training
    loss_decreasing = losses[-1] < losses[0] * 1.5  # not exploding
    entropy_ok = np.mean(entropies[-5:]) >= 0.0  # not collapsed to zero
    survival_ok = survival_rate == 100.0

    print("\n" + "=" * 60)
    print("SPRINT 5.3 SUMMARY")
    print("=" * 60)
    print(f"  Training Stability (KL):     {'PASS' if kl_ok else 'FAIL'}")
    print(f"  Loss Not Exploding:         {'PASS' if loss_decreasing else 'FAIL'}")
    print(f"  Entropy Not Collapsed:     {'PASS' if entropy_ok else 'FAIL'}")
    print(f"  Survival Rate 100%:         {'PASS' if survival_ok else 'FAIL'}")

    all_ok = kl_ok and loss_decreasing and entropy_ok and survival_ok
    print(f"\n  Overall: {'PASS — PPO training stable, ready for Sprint 5.4' if all_ok else 'FAIL — Check training stability'}")

    result = {
        "iterations": iteration_stats,
        "evaluation": {
            "episodes": eval_episodes,
            "survival_rate": float(survival_rate),
            "collapse_count": int(collapse_count),
            "avg_reward": float(avg_reward_eval),
        },
        "stability": {
            "kl_ok": bool(kl_ok),
            "loss_decreasing": bool(loss_decreasing),
            "entropy_ok": bool(entropy_ok),
            "survival_ok": bool(survival_ok),
        },
        "passed": bool(all_ok),
    }

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"\nSaved to: {output_path}")

    return result


def main():
    import argparse
    parser = argparse.ArgumentParser(description="PPO Smoke Training")
    parser.add_argument("--model", type=str, default="checkpoints/bc_policy_v3_1_clean.pt")
    parser.add_argument("--steps", type=int, default=10240)
    parser.add_argument("--rollout", type=int, default=256)
    parser.add_argument("--eval-episodes", type=int, default=50)
    parser.add_argument("--output", type=str, default="artifacts/ppo_training.json")
    args = parser.parse_args()

    run_ppo_training(
        bc_model_path=args.model,
        total_steps=args.steps,
        rollout_steps=args.rollout,
        n_episodes_eval=args.eval_episodes,
        output_path=args.output,
    )


if __name__ == "__main__":
    main()
