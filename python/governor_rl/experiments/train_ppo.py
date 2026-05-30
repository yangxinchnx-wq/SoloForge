# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Train PPO
# Path: python/governor_rl/experiments/train_ppo.py
#
# Stage 2: PPO Fine-tuning with BC Warm Start
# ─────────────────────────────────────────────────────────────────

import sys
import os

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(os.path.dirname(script_dir)))
sys.path.insert(0, python_dir)

from governor_rl.models import PolicyNetwork, ValueNetwork
from governor_rl.training.ppo_trainer import PPOTrainer, PPOConfig


def main():
    print("=" * 60)
    print("PPO Training")
    print("=" * 60)

    # BC checkpoint 路径
    bc_path = "checkpoints/bc_policy.pt"

    # PPO 配置
    config = PPOConfig()

    # 创建网络
    print("\n[1] Creating networks")
    policy = PolicyNetwork(hidden_dim=config.hidden_dim)
    value_net = ValueNetwork(hidden_dim=config.hidden_dim)

    # Warm Start from BC
    if os.path.exists(bc_path):
        print(f"\n[2] Warm-start from BC: {bc_path}")
        import torch
        checkpoint = torch.load(bc_path, weights_only=False)
        policy.load_state_dict(checkpoint["policy_state_dict"])
        print("    BC weights loaded")
    else:
        print(f"\n[2] No BC checkpoint found, starting from scratch")

    # 创建 Trainer
    print("\n[3] Creating PPO Trainer")
    trainer = PPOTrainer(policy, value_net, config)

    # 训练
    print("\n[4] Training PPO")
    history = trainer.train(
        env_config={"arrival_rate": 15.0, "burst_prob": 0.15},
        total_timesteps=50000,
    )

    # 保存
    print("\n[5] Saving model")
    trainer.save("checkpoints/ppo_policy.pt")

    print("\n✅ PPO Training Complete")
    print(f"    Model: checkpoints/ppo_policy.pt")


if __name__ == "__main__":
    main()
