# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Sprint 7 — PPO V2 100k Training
# Path: experiments/ppo/ppo_training_100k.py
#
# 训练 PPO V2 100k steps，自动保存 checkpoint 并在每个节点运行评估
# 追踪 RL Learning Effect 随训练步数的演变
# ─────────────────────────────────────────────────────────────────

import sys
import os
import torch
import torch.nn as nn
import numpy as np
import json
import time
from typing import Dict, List, Tuple

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)


# ============================================================
# Feature Builder
# ============================================================

def compute_load_ratio(q, w):
    return q / max(w * 2, 1)


def get_zone(q, w):
    lr = compute_load_ratio(q, w)
    if lr < 0.1: return 0
    elif lr < 0.25: return 1
    elif lr < 0.5: return 2
    elif lr < 1.0: return 3
    else: return 4


def build_features(q, w, cpu=0.5):
    lr = compute_load_ratio(q, w)
    max_lr = 21.5
    lr_norm = np.log(1 + lr) / np.log(1 + max_lr)
    return np.array([q/1000., 0., 0., w/200., cpu, 0., 0., 0.,
                     get_zone(q, w)/4., lr_norm], dtype=np.float32)


# ============================================================
# Network
# ============================================================

class PPOModel(nn.Module):
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


def load_bc_warm_start(net, bc_path):
    ckpt = torch.load(bc_path, map_location='cpu', weights_only=False)
    bc_state = ckpt['policy_state_dict']
    key_map = {
        'net.0.weight': 'shared.0.weight', 'net.0.bias': 'shared.0.bias',
        'net.2.weight': 'shared.2.weight', 'net.2.bias': 'shared.2.bias',
        'net.4.weight': 'actor.weight', 'net.4.bias': 'actor.bias',
    }
    loaded = {}
    for bc_key, pv_key in key_map.items():
        if bc_key in bc_state and pv_key in net.state_dict():
            loaded[pv_key] = bc_state[bc_key]
    net.load_state_dict(loaded, strict=False)
    return net


# ============================================================
# GAE + PPO Update
# ============================================================

def compute_gae(rewards, values, gamma, gae_lambda):
    advantages, gae = [], 0.0
    values = values + [0.0]
    for t in reversed(range(len(rewards))):
        delta = rewards[t] + gamma * values[t + 1] - values[t]
        gae = delta + gamma * gae_lambda * gae
        advantages.insert(0, gae)
    returns = np.array(advantages) + np.array(values[:-1])
    return np.array(advantages), returns


def ppo_update(net, optimizer, obs_buf, act_buf, log_buf, val_buf,
               ret_buf, adv_buf, config):
    obs_t = torch.FloatTensor(np.array(obs_buf))
    act_t = torch.LongTensor(act_buf)
    old_log_t = torch.FloatTensor(log_buf)
    adv_t = torch.FloatTensor(adv_buf)
    ret_t = torch.FloatTensor(ret_buf)

    adv_t = (adv_t - adv_t.mean()) / (adv_t.std() + 1e-8)

    losses, kls = [], []
    for _ in range(config['ppo_epochs']):
        logits, values = net(obs_t)
        probs = torch.softmax(logits, dim=-1)
        new_log = torch.log(probs.gather(-1, act_t.unsqueeze(-1)).squeeze(-1) + 1e-8)

        kl = (old_log_t - new_log).mean()
        kls.append(kl.item())

        ratios = torch.exp(new_log - old_log_t)
        surr1 = ratios * adv_t
        surr2 = torch.clamp(ratios, 1-config['clip_eps'], 1+config['clip_eps']) * adv_t
        actor_loss = -torch.min(surr1, surr2).mean()
        critic_loss = nn.MSELoss()(values.squeeze(-1), ret_t)
        entropy = -torch.sum(probs * torch.log(probs + 1e-8), dim=-1).mean()

        loss = (actor_loss + config['value_coef'] * critic_loss
                - config['entropy_coef'] * entropy)

        optimizer.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(net.parameters(), config['max_grad_norm'])
        optimizer.step()
        losses.append(loss.item())

    with torch.no_grad():
        logits, _ = net(obs_t)
        final_probs = torch.softmax(logits, dim=-1)
        final_entropy = -torch.sum(final_probs * torch.log(final_probs + 1e-8), dim=-1).mean().item()

    return {
        "loss": float(np.mean(losses)),
        "kl": float(np.mean(kls)),
        "entropy": float(final_entropy),
    }


# ============================================================
# Rollout
# ============================================================

def run_rollout(net, env_module, env_config, n_steps, deterministic=False):
    env = env_module.RuntimeEnv(**env_config)
    obs_buf, act_buf, rew_buf, log_buf, val_buf = [], [], [], [], []
    total_reward = 0.0
    env.reset()

    for _ in range(n_steps):
        state = env.simulator.state
        obs = build_features(state.queue_depth, state.worker_count, state.cpu_usage)
        obs_t = torch.FloatTensor(obs).unsqueeze(0)

        with torch.no_grad():
            logits, value = net(obs_t)
            probs = torch.softmax(logits, dim=-1)
            value = value.item()

        if deterministic:
            action = probs.argmax().item()
        else:
            action = torch.multinomial(probs, 1).item()

        log_prob = torch.log(probs[0, action] + 1e-8).item()

        _, reward, terminated, truncated, _ = env.step(action)
        done = terminated or truncated

        obs_buf.append(obs)
        act_buf.append(action)
        rew_buf.append(reward)
        log_buf.append(log_prob)
        val_buf.append(value)
        total_reward += reward

        if done:
            env.reset()

    return obs_buf, act_buf, rew_buf, log_buf, val_buf, total_reward


# ============================================================
# Evaluator
# ============================================================

def evaluate(net, env_module, n_episodes=50, max_steps=200):
    """Run evaluation episodes, return metrics"""
    rewards, queues, osc_count = [], [], []

    for ep in range(n_episodes):
        env_config = {"duration": max_steps, "arrival_rate": 15.0, "burst_prob": 0.15, "seed": 1000 + ep}
        env = env_module.RuntimeEnv(**env_config)
        env.reset()

        ep_rewards, ep_queues = [], []
        prev_action = None
        ep_osc = 0

        for step in range(max_steps):
            state = env.simulator.state
            obs = build_features(state.queue_depth, state.worker_count, state.cpu_usage)
            obs_t = torch.FloatTensor(obs).unsqueeze(0)

            with torch.no_grad():
                logits, _ = net(obs_t)
                probs = torch.softmax(logits, dim=-1)
                action = probs.argmax().item()

            if prev_action is not None:
                prev_exp = prev_action >= 3
                curr_exp = action >= 3
                if prev_exp != curr_exp:
                    ep_osc += 1
            prev_action = action

            _, reward, terminated, truncated, _ = env.step(action)
            ep_rewards.append(reward)
            ep_queues.append(state.queue_depth)

            if terminated or truncated:
                break

        rewards.append(sum(ep_rewards))
        queues.append(np.mean(ep_queues))
        osc_count.append(ep_osc)

    return {
        "avg_reward": float(np.mean(rewards)),
        "std_reward": float(np.std(rewards)),
        "avg_queue": float(np.mean(queues)),
        "avg_oscillation": float(np.mean(osc_count)),
        "n_episodes": n_episodes,
    }


def evaluate_ood(net, env_module):
    """Quick OOD evaluation: high arrival + recovery scenarios"""
    results = {}

    # High arrival stress
    for name, ar, bp in [("arr25", 25.0, 0.30), ("arr30", 30.0, 0.35)]:
        env_config = {"duration": 200, "arrival_rate": ar, "burst_prob": bp, "seed": 42}
        env = env_module.RuntimeEnv(**env_config)
        env.reset()
        queues = []
        for _ in range(200):
            state = env.simulator.state
            obs = build_features(state.queue_depth, state.worker_count, state.cpu_usage)
            obs_t = torch.FloatTensor(obs).unsqueeze(0)
            with torch.no_grad():
                probs = torch.softmax(net(obs_t)[0], dim=-1)
                action = probs.argmax().item()
            _, _, terminated, truncated, _ = env.step(action)
            queues.append(state.queue_depth)
            if terminated or truncated:
                break
        results[f"ood_{name}_avg_queue"] = float(np.mean(queues))
        results[f"ood_{name}_max_queue"] = float(max(queues))

    # Recovery from extreme
    env = env_module.RuntimeEnv(duration=250, arrival_rate=15.0, burst_prob=0.15, seed=99)
    env.reset()
    env.simulator.state.queue_depth = 50000
    env.simulator.state.worker_count = 20
    lr_init = 50000 / 40
    final_q_list = []
    for step in range(250):
        state = env.simulator.state
        obs = build_features(state.queue_depth, state.worker_count, state.cpu_usage)
        obs_t = torch.FloatTensor(obs).unsqueeze(0)
        with torch.no_grad():
            probs = torch.softmax(net(obs_t)[0], dim=-1)
            action = probs.argmax().item()
        _, _, terminated, truncated, _ = env.step(action)
        final_q_list.append(state.queue_depth)
        if terminated or truncated:
            break
    final_lr = final_q_list[-1] / 40 if final_q_list else 0
    results["ood_recovery_lr_pct"] = float((lr_init - final_lr) / lr_init * 100)

    return results


# ============================================================
# Main Training Loop
# ============================================================

def run_ppo_100k_training(
    bc_model_path: str = "checkpoints/bc_policy_v3_1_clean.pt",
    output_dir: str = "checkpoints",
    checkpoint_dir: str = "checkpoints/ppo_checkpoints",
    total_steps: int = 102400,
    rollout_steps: int = 2048,
    n_eval_episodes: int = 50,
    eval_interval: int = 10240,
    n_eval_ood: int = 5,
):
    print("=" * 60)
    print("SPRINT 7: PPO V2 100K TRAINING")
    print("=" * 60)

    os.makedirs(checkpoint_dir, exist_ok=True)

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
    net = PPOModel(input_dim=10, hidden_dim=128)
    net = load_bc_warm_start(net, bc_model_path)
    optimizer = torch.optim.Adam(net.parameters(), lr=config['lr'])

    env_module = __import__('governor_rl.env.runtime_env', fromlist=['RuntimeEnv'])

    n_updates = total_steps // rollout_steps
    checkpoint_steps = [0, 5120, 10240, 20480, 30720, 40960, 51200, 61440, 71680, 81920, 92160, 102400]

    all_stats = []
    start_time = time.time()

    print(f"\nConfig:")
    for k, v in config.items():
        print(f"  {k}: {v}")
    print(f"  total_steps: {total_steps}")
    print(f"  rollout_steps: {rollout_steps}")
    print(f"  n_updates: {n_updates}")
    print(f"  eval_interval: every {eval_interval} steps")
    print(f"  bc_model: {bc_model_path}")

    print("\nTraining...")
    global_step = 0

    for iteration in range(n_updates):
        # Rollout
        env_config = {
            "duration": 200,
            "arrival_rate": 15.0,
            "burst_prob": 0.15,
            "seed": iteration
        }
        obs_buf, act_buf, rew_buf, log_buf, val_buf, total_reward = run_rollout(
            net, env_module, env_config, rollout_steps
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

        global_step += rollout_steps

        stats = {
            "iteration": iteration,
            "global_step": global_step,
            "total_reward": float(total_reward),
            "loss": update_stats["loss"],
            "kl": update_stats["kl"],
            "entropy": update_stats["entropy"],
        }

        # Periodic evaluation
        eval_result = None
        ood_result = None
        if global_step >= checkpoint_steps[0] and all(global_step >= s for s in checkpoint_steps[:1]):
            # Check if this is a checkpoint step
            if global_step in checkpoint_steps:
                print(f"\n  [{global_step//1000}k] Eval + Save checkpoint...")
                net.eval()
                eval_result = evaluate(net, env_module, n_episodes=n_eval_episodes)
                ood_result = evaluate_ood(net, env_module)
                net.train()

                # Save checkpoint
                ckpt_path = os.path.join(checkpoint_dir, f"ppo_{global_step}.pt")
                torch.save({
                    'policy_state_dict': net.state_dict(),
                    'global_step': global_step,
                    'iteration': iteration,
                    'eval': eval_result,
                    'ood': ood_result,
                    'config': config,
                }, ckpt_path)
                print(f"  Saved: {ckpt_path}")

        stats["eval"] = eval_result
        stats["ood"] = ood_result
        all_stats.append(stats)

        # Print every 10 iterations
        if iteration % 10 == 0 or iteration == n_updates - 1:
            eval_str = ""
            if eval_result:
                eval_str = f" | eval_reward={eval_result['avg_reward']:.1f} eval_queue={eval_result['avg_queue']:.1f}"
            print(f"  Iter {iteration:4d} | step={global_step:6d} | "
                  f"reward={total_reward:>8.1f} | loss={update_stats['loss']:>8.3f} | "
                  f"kl={update_stats['kl']:>8.4f} | ent={update_stats['entropy']:>6.3f}{eval_str}")

    elapsed = time.time() - start_time

    # Final save
    final_path = os.path.join(output_dir, "ppo_100k.pt")
    torch.save({
        'policy_state_dict': net.state_dict(),
        'global_step': global_step,
        'config': config,
    }, final_path)
    print(f"\nFinal model saved: {final_path}")

    # Print progress summary
    print("\n" + "=" * 60)
    print("TRAINING PROGRESS SUMMARY")
    print("=" * 60)

    checkpoints_found = [s for s in all_stats if s.get("eval") is not None]
    if checkpoints_found:
        print(f"\n{'Step':>8} {'Eval Reward':>12} {'Eval Queue':>12} {'Osc':>8} "
              f"{'Recovery':>10} {'Arr30 Q':>10}")
        print("  " + "-" * 68)
        for s in checkpoints_found:
            ev = s.get("eval") or {}
            oo = s.get("ood") or {}
            print(f"  {s['global_step']:>8,} {ev.get('avg_reward', 0):>12.1f} "
                  f"{ev.get('avg_queue', 0):>12.1f} "
                  f"{ev.get('avg_oscillation', 0):>8.1f} "
                  f"{oo.get('ood_recovery_lr_pct', 0):>10.1f}% "
                  f"{oo.get('ood_arr30_avg_queue', 0):>10.1f}")

        # Trend analysis
        eval_rewards = [s['eval']['avg_reward'] for s in checkpoints_found]
        eval_queues = [s['eval']['avg_queue'] for s in checkpoints_found]

        if len(eval_rewards) >= 2:
            reward_trend = "↑ improving" if eval_rewards[-1] > eval_rewards[0] else "↓ degrading" if eval_rewards[-1] < eval_rewards[0] else "→ stable"
            queue_trend = "↓ improving" if eval_queues[-1] < eval_queues[0] else "↑ degrading" if eval_queues[-1] > eval_queues[0] else "→ stable"
            print(f"\n  Reward trend:   {reward_trend}")
            print(f"  Queue trend:     {queue_trend}")
        if len(eval_rewards) >= 3:
            first_half_r = np.mean(eval_rewards[:len(eval_rewards)//2])
            second_half_r = np.mean(eval_rewards[len(eval_rewards)//2:])
            print(f"  First half avg reward:  {first_half_r:.1f}")
            print(f"  Second half avg reward: {second_half_r:.1f}")

    print(f"\n  Training time: {elapsed:.1f}s ({elapsed/60:.1f} min)")
    print(f"  Total steps:  {global_step}")

    # Save training log
    log_path = os.path.join(checkpoint_dir, "training_log.json")
    with open(log_path, 'w', encoding='utf-8') as f:
        json.dump({
            "config": config,
            "total_steps": total_steps,
            "rollout_steps": rollout_steps,
            "elapsed_seconds": elapsed,
            "stats": [{
                "iteration": s["iteration"],
                "global_step": s["global_step"],
                "total_reward": s["total_reward"],
                "loss": s["loss"],
                "kl": s["kl"],
                "entropy": s["entropy"],
                "eval": s.get("eval"),
                "ood": s.get("ood"),
            } for s in all_stats]
        }, f, indent=2, ensure_ascii=False)
    print(f"  Training log: {log_path}")

    print("\n" + "=" * 60)
    print("SPRINT 7 COMPLETE")
    print("=" * 60)

    return all_stats


def main():
    import argparse
    parser = argparse.ArgumentParser(description="PPO V2 100k Training")
    parser.add_argument("--bc", default="checkpoints/bc_policy_v3_1_clean.pt")
    parser.add_argument("--output-dir", default="checkpoints")
    parser.add_argument("--checkpoint-dir", default="checkpoints/ppo_checkpoints")
    parser.add_argument("--steps", type=int, default=102400)
    parser.add_argument("--rollout", type=int, default=2048)
    parser.add_argument("--eval-episodes", type=int, default=50)
    parser.add_argument("--eval-interval", type=int, default=10240)
    args = parser.parse_args()

    run_ppo_100k_training(
        bc_model_path=args.bc,
        output_dir=args.output_dir,
        checkpoint_dir=args.checkpoint_dir,
        total_steps=args.steps,
        rollout_steps=args.rollout,
        n_eval_episodes=args.eval_episodes,
        eval_interval=args.eval_interval,
    )


if __name__ == "__main__":
    main()
