# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge MARL Service: MAPPO 训练器
# Path: python/marl_service/trainer.py
#
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ⚠️  AI 社会专用模块 ⚠️  与主项目隔离
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#
# 实现 PPO (Proximal Policy Optimization) 训练逻辑
# 用于持续优化资源调度策略
#
# 训练流程：
#   1. 收集经验数据（使用当前策略）
#   2. 计算 GAE (Generalized Advantage Estimation)
#   3. 执行 PPO 更新（策略 + 价值网络）
#   4. 保存更新后的策略
#
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
from dataclasses import dataclass
from typing import List, Tuple, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset

from marl_service.mappo_net import MAPPOPolicy, create_default_policy


@dataclass
class Experience:
    """经验样本"""
    global_state: List[float]
    local_obs: List[float]
    action: int
    reward: float
    done: bool
    next_global_state: Optional[List[float]]
    next_local_obs: Optional[List[float]]


class MAPPOTrainer:
    """
    MAPPO 训练器

    实现 PPO (Proximal Policy Optimization) 更新逻辑
    """

    def __init__(
        self,
        policy: Optional[MAPPOPolicy] = None,
        lr: float = 3e-4,
        gamma: float = 0.99,
        epsilon: float = 0.2,
        entropy_coef: float = 0.01,
        value_coef: float = 0.5,
    ):
        self.policy = policy or create_default_policy()
        self.gamma = gamma  # 折扣因子
        self.epsilon = epsilon  # PPO 裁剪参数
        self.entropy_coef = entropy_coef
        self.value_coef = value_coef

        # 优化器
        self.actor_optimizer = optim.Adam(self.policy.actor.parameters(), lr=lr)
        self.critic_optimizer = optim.Adam(self.policy.critic.parameters(), lr=lr)

        # 经验缓冲区
        self.buffer: List[Experience] = []

        # 训练统计
        self.total_episodes = 0
        self.total_updates = 0

    def add_experience(self, experience: Experience) -> None:
        """添加经验到缓冲区"""
        self.buffer.append(experience)

    def clear_buffer(self) -> None:
        """清空缓冲区"""
        self.buffer.clear()

    def compute_gae(
        self,
        rewards: List[float],
        values: List[float],
        dones: List[bool],
        next_value: float
    ) -> Tuple[List[float], List[float]]:
        """
        计算 GAE (Generalized Advantage Estimation)

        Returns:
            advantages: 优势函数
            returns: 回报
        """
        advantages = []
        gae = 0

        # 反向计算
        for t in reversed(range(len(rewards))):
            if t == len(rewards) - 1:
                next_val = next_value
            else:
                next_val = values[t + 1]

            delta = rewards[t] + self.gamma * next_val * (1 - dones[t]) - values[t]
            gae = delta + self.gamma * gae * (1 - dones[t])
            advantages.insert(0, gae)

        # 计算回报（优势 + 价值）
        returns = [adv + val for adv, val in zip(advantages, values)]

        # 标准化优势
        advantages = torch.FloatTensor(advantages)
        advantages = (advantages - advantages.mean()) / (advantages.std() + 1e-8)

        return advantages.tolist(), returns

    def update(self, batch_size: int = 64, epochs: int = 4) -> dict:
        """
        执行 PPO 更新

        Args:
            batch_size: 批次大小
            epochs: 更新轮数

        Returns:
            训练统计
        """
        if len(self.buffer) < batch_size:
            return {'skipped': True, 'reason': 'insufficient_data'}

        # 准备数据
        states_g = torch.FloatTensor([e.global_state for e in self.buffer])
        states_l = torch.FloatTensor([e.local_obs for e in self.buffer])
        actions = torch.LongTensor([e.action for e in self.buffer])

        # 计算价值和优势
        with torch.no_grad():
            values = self.policy.critic(states_g).squeeze(-1).tolist()

        advantages, returns = self.compute_gae(
            [e.reward for e in self.buffer],
            values,
            [e.done for e in self.buffer],
            0.0  # terminal state
        )

        advantages_t = torch.FloatTensor(advantages)
        returns_t = torch.FloatTensor(returns)

        # 创建数据集
        dataset = TensorDataset(states_g, states_l, actions, advantages_t, returns_t)
        loader = DataLoader(dataset, batch_size=batch_size, shuffle=True)

        # 训练统计
        actor_losses = []
        critic_losses = []
        entropy_losses = []

        for _ in range(epochs):
            for batch in loader:
                sg, sl, a, adv, ret = batch

                # ========== Actor 更新 ==========
                self.actor_optimizer.zero_grad()

                # 计算新策略概率
                probs = self.policy.actor(sg, sl)
                dist = torch.distributions.Categorical(probs)

                # 计算对数概率
                log_probs = dist.log_prob(a)

                # 简化的 PPO 损失（无旧策略对比）
                actor_loss = -(log_probs * adv).mean()

                # 熵正则化（鼓励探索）
                entropy = dist.entropy().mean()

                actor_total_loss = actor_loss - self.entropy_coef * entropy

                actor_total_loss.backward()
                self.actor_optimizer.step()

                actor_losses.append(actor_loss.item())
                entropy_losses.append(entropy.item())

                # ========== Critic 更新 ==========
                self.critic_optimizer.zero_grad()

                values_pred = self.policy.critic(sg).squeeze(-1)
                critic_loss = nn.MSELoss()(values_pred, ret)

                critic_loss.backward()
                self.critic_optimizer.step()

                critic_losses.append(critic_loss.item())

        # 清空缓冲区
        self.clear_buffer()

        # 更新统计
        self.total_updates += 1

        return {
            'actor_loss': sum(actor_losses) / len(actor_losses),
            'critic_loss': sum(critic_losses) / len(critic_losses),
            'entropy': sum(entropy_losses) / len(entropy_losses),
            'total_updates': self.total_updates,
            'buffer_size': 0,
        }

    def save(self, path: str) -> None:
        """保存模型"""
        self.policy.save_model(path)
        print(f"[Trainer] ✓ 模型已保存: {path}")

    def load(self, path: str) -> None:
        """加载模型"""
        self.policy.load_model(path)
        print(f"[Trainer] ✓ 模型已加载: {path}")


def simulate_reward(global_state: List[float], action: int) -> float:
    """
    模拟环境奖励

    Args:
        global_state: 全局状态 [cpu, memory, latency, ...]
        action: 动作 (0=正常, 1=降级, 2=熔断)

    Returns:
        reward: 即时奖励
    """
    cpu = global_state[0] if global_state else 0.5

    if action == 0:  # 正常
        if cpu < 0.8:
            return 1.0  # 好，保持正常
        else:
            return -0.5  # 差，应该降级

    elif action == 1:  # 降级
        if 0.7 < cpu < 0.9:
            return 1.0  # 好，降级适当
        elif cpu >= 0.9:
            return 0.5  # 一般，应该更强硬
        else:
            return -0.3  # 差，不需要降级

    else:  # 熔断
        if cpu > 0.95:
            return 2.0  # 非常好，正确熔断
        elif cpu > 0.9:
            return 1.0  # 好，提前熔断
        else:
            return -1.0  # 差，过度反应


def collect_demonstrations(
    trainer: MAPPOTrainer,
    num_episodes: int = 100
) -> None:
    """
    收集演示数据（离线演示）

    使用当前策略收集经验样本
    """
    print(f"[Trainer] 收集 {num_episodes} 个演示 episodes...")

    policy = trainer.policy

    for ep in range(num_episodes):
        # 随机初始化状态
        global_state = [
            torch.rand(1).item() * 0.5 + 0.4,  # CPU: 0.4-0.9
            torch.rand(1).item() * 0.3 + 0.5,  # Memory: 0.5-0.8
            torch.rand(1).item() * 300 + 50,    # Latency: 50-350
            torch.rand(1).item() * 5000 + 5000, # Tokens: 5000-10000
            torch.rand(1).item() * 30 + 10,     # Agents: 10-40
            torch.rand(1).item() * 50 + 20,     # Tools: 20-70
            torch.rand(1).item() * 0.5,         # Queue: 0-0.5
            torch.rand(1).item() * 0.5,         # ErrorRate: 0-0.5
        ]

        local_obs = [
            torch.rand(1).item(),
            torch.rand(1).item(),
            torch.rand(1).item(),
            torch.rand(1).item(),
        ]

        # 使用策略选择动作
        action, prob, value = policy.evaluate(global_state, local_obs)

        # 计算奖励
        reward = simulate_reward(global_state, action)

        # 添加经验
        trainer.add_experience(Experience(
            global_state=global_state,
            local_obs=local_obs,
            action=action,
            reward=reward,
            done=False,
            next_global_state=None,
            next_local_obs=None,
        ))

        if (ep + 1) % 20 == 0:
            print(f"  Episode {ep + 1}/{num_episodes}")

    print(f"[Trainer] ✓ 收集完成，缓冲区大小: {len(trainer.buffer)}")


def main():
    """训练主循环"""
    print("=" * 60)
    print("SoloForge MAPPO 训练器")
    print("=" * 60)

    # 初始化
    trainer = MAPPOTrainer(lr=3e-4, gamma=0.99)

    # 加载现有模型（如果有）
    model_path = os.path.join(
        os.path.dirname(__file__),
        'models',
        'policy.pt'
    )

    if os.path.exists(model_path):
        trainer.load(model_path)
        print(f"[Trainer] 继续训练已有模型")

    # 训练循环
    num_iterations = 10
    episodes_per_iteration = 100
    batch_size = 64
    update_epochs = 4

    print(f"\n训练配置:")
    print(f"  迭代次数: {num_iterations}")
    print(f"  每迭代 episodes: {episodes_per_iteration}")
    print(f"  批次大小: {batch_size}")
    print(f"  更新轮数: {update_epochs}")
    print()

    for iteration in range(num_iterations):
        print(f"=== 迭代 {iteration + 1}/{num_iterations} ===")

        # 1. 收集演示数据
        collect_demonstrations(trainer, episodes_per_iteration)

        # 2. 执行更新
        stats = trainer.update(batch_size=batch_size, epochs=update_epochs)

        print(f"  Actor Loss: {stats['actor_loss']:.4f}")
        print(f"  Critic Loss: {stats['critic_loss']:.4f}")
        print(f"  Entropy: {stats['entropy']:.4f}")
        print()

        # 3. 定期保存
        if (iteration + 1) % 5 == 0:
            trainer.save(model_path)

    # 最终保存
    trainer.save(model_path)
    print("\n✅ 训练完成！")


if __name__ == '__main__':
    main()
