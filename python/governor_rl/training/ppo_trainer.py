# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: PPO Trainer
# Path: python/governor_rl/training/ppo_trainer.py
#
# Stage 3: PPO Fine-Tuning with GAE
# ─────────────────────────────────────────────────────────────────

import sys
import os
import torch
import torch.nn as nn
import torch.optim as optim
import numpy as np
from dataclasses import dataclass
from typing import Dict, List, Tuple, Optional
from collections import deque

# 设置 UTF-8
sys.stdout.reconfigure(encoding='utf-8')

# 添加路径
script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.models import ActorCritic, PolicyNetwork, ValueNetwork
from governor_rl.env import RuntimeEnvFactory


@dataclass
class PPOConfig:
    """PPO 训练配置"""
    # 模型
    hidden_dim: int = 128
    
    # PPO 超参数
    lr: float = 3e-4
    gamma: float = 0.99  # discount factor
    gae_lambda: float = 0.95  # GAE lambda
    clip_eps: float = 0.2  # PPO clip epsilon
    value_coef: float = 0.5  # value loss coefficient
    entropy_coef: float = 0.01  # entropy bonus coefficient
    
    # 训练
    batch_size: int = 64
    ppo_epochs: int = 10  # 每个 rollout 更新多少次
    max_grad_norm: float = 0.5  # gradient clipping
    
    # Rollout
    rollout_steps: int = 2048  # 每次收集多少步
    num_envs: int = 1  # 并行环境数


class RolloutBuffer:
    """
    Rollout Buffer for PPO
    
    存储 trajectory 用于 GAE 计算和策略更新
    """
    
    def __init__(self):
        self.observations = []
        self.actions = []
        self.rewards = []
        self.dones = []
        self.values = []
        self.log_probs = []
        
        self._obs = None
        self._action = None
        self._reward = None
        self._done = None
        self._value = None
        self._log_prob = None
    
    def add(
        self,
        obs: np.ndarray,
        action: int,
        reward: float,
        done: bool,
        value: float,
        log_prob: float,
    ):
        """添加一个 step"""
        self.observations.append(obs)
        self.actions.append(action)
        self.rewards.append(reward)
        self.dones.append(done)
        self.values.append(value)
        self.log_probs.append(log_prob)
    
    def compute_gae(
        self,
        last_value: float,
        gamma: float = 0.99,
        gae_lambda: float = 0.95,
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        计算 GAE (Generalized Advantage Estimation)
        
        Returns:
            advantages, returns
        """
        rewards = np.array(self.rewards, dtype=np.float32)
        dones = np.array(self.dones, dtype=np.float32)
        values = np.array(self.values + [last_value], dtype=np.float32)
        
        advantages = np.zeros_like(rewards)
        gae = 0
        
        # 从后向前计算 GAE
        for t in reversed(range(len(rewards))):
            delta = rewards[t] + gamma * values[t + 1] * (1 - dones[t]) - values[t]
            gae = delta + gamma * gae_lambda * (1 - dones[t]) * gae
            advantages[t] = gae
        
        # Returns = advantages + values
        returns = advantages + np.array(self.values)
        
        return advantages, returns
    
    def get_batches(
        self,
        batch_size: int,
    ) -> List[Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]]:
        """
        生成 mini-batches
        
        Returns:
            list of (obs, actions, old_log_probs, advantages, returns)
        """
        obs = np.array(self.observations, dtype=np.float32)
        actions = np.array(self.actions, dtype=np.int64)
        old_log_probs = np.array(self.log_probs, dtype=np.float32)
        advantages, returns = self.compute_gae(0.0)  # 简化，最后 value 设为 0
        
        # Normalize advantages
        advantages = (advantages - advantages.mean()) / (advantages.std() + 1e-8)
        
        # 随机打乱索引
        indices = np.arange(len(obs))
        np.random.shuffle(indices)
        
        batches = []
        for start in range(0, len(obs), batch_size):
            end = min(start + batch_size, len(obs))
            batch_idx = indices[start:end]
            
            batches.append((
                obs[batch_idx],
                actions[batch_idx],
                old_log_probs[batch_idx],
                advantages[batch_idx],
                returns[batch_idx],
            ))
        
        return batches
    
    def clear(self):
        """清空 buffer"""
        self.observations = []
        self.actions = []
        self.rewards = []
        self.dones = []
        self.values = []
        self.log_probs = []


class PPOTrainer:
    """
    PPO Trainer
    
    使用 PPO 算法微调 Policy Network
    """
    
    def __init__(
        self,
        policy: PolicyNetwork,
        value_net: ValueNetwork = None,
        config: PPOConfig = None,
    ):
        self.config = config or PPOConfig()
        self.policy = policy
        self.value_net = value_net or ValueNetwork(self.config.hidden_dim)
        
        # Optimizers
        self.policy_optimizer = optim.Adam(
            self.policy.parameters(),
            lr=self.config.lr,
        )
        self.value_optimizer = optim.Adam(
            self.value_net.parameters(),
            lr=self.config.lr,
        )
        
        # Rollout buffer
        self.buffer = RolloutBuffer()
        
        # Training stats
        self.policy_loss_history = []
        self.value_loss_history = []
        self.entropy_history = []
        self.clip_fraction_history = []
    
    def collect_rollout(
        self,
        env_config: Dict = None,
        max_steps: int = None,
    ) -> Dict[str, float]:
        """
        收集一个 rollout
        
        Args:
            env_config: 环境配置
            max_steps: 最大步数
            
        Returns:
            episode stats
        """
        max_steps = max_steps or self.config.rollout_steps
        
        env = RuntimeEnvFactory.create(
            arrival_rate=env_config.get("arrival_rate", 15.0) if env_config else 15.0,
            burst_prob=env_config.get("burst_prob", 0.15) if env_config else 0.15,
            duration=max_steps,
        )
        
        obs, _ = env.reset()
        self.buffer.clear()
        
        episode_reward = 0.0
        episode_length = 0
        
        for step in range(max_steps):
            # 获取动作和 value
            with torch.no_grad():
                obs_tensor = torch.FloatTensor(obs).unsqueeze(0)
                
                # Policy forward
                logits = self.policy(obs_tensor)
                probs = torch.softmax(logits, dim=-1)
                
                # 采样动作
                dist = torch.distributions.Categorical(probs)
                action = dist.sample().item()
                log_prob = dist.log_prob(torch.tensor(action)).item()
                
                # Value
                value = self.value_net(obs_tensor).item()
            
            # 执行动作
            next_obs, reward, done, _, info = env.step(action)
            
            # 存储
            self.buffer.add(
                obs=obs,
                action=action,
                reward=reward,
                done=done,
                value=value,
                log_prob=log_prob,
            )
            
            episode_reward += reward
            episode_length += 1
            obs = next_obs
            
            if done:
                break
        
        # 计算最后一个 value
        with torch.no_grad():
            last_value = self.value_net(torch.FloatTensor(obs).unsqueeze(0)).item()
        
        return {
            "episode_reward": episode_reward,
            "episode_length": episode_length,
            "last_value": last_value,
        }
    
    def update(self) -> Dict[str, float]:
        """
        执行一次 PPO 更新
        
        Returns:
            training stats
        """
        # 计算 GAE
        advantages, returns = self.buffer.compute_gae(
            last_value=0.0,  # 不用于 bootstrap
            gamma=self.config.gamma,
            gae_lambda=self.config.gae_lambda,
        )
        
        # 归一化 advantages
        advantages = (advantages - advantages.mean()) / (advantages.std() + 1e-8)
        
        # 获取 batches
        batches = self.buffer.get_batches(self.config.batch_size)
        
        # 准备数据
        obs = np.array(self.buffer.observations, dtype=np.float32)
        actions = np.array(self.buffer.actions, dtype=np.int64)
        old_log_probs = np.array(self.buffer.log_probs, dtype=np.float32)
        
        policy_losses = []
        value_losses = []
        entropies = []
        clip_fractions = []
        
        for _ in range(self.config.ppo_epochs):
            for obs_batch, action_batch, old_log_prob_batch, adv_batch, ret_batch in batches:
                obs_t = torch.FloatTensor(obs_batch)
                action_t = torch.LongTensor(action_batch)
                old_log_prob_t = torch.FloatTensor(old_log_prob_batch)
                adv_t = torch.FloatTensor(adv_batch)
                ret_t = torch.FloatTensor(ret_batch)
                
                # Policy forward
                logits = self.policy(obs_t)
                probs = torch.softmax(logits, dim=-1)
                dist = torch.distributions.Categorical(probs)
                
                # 新 log probs
                new_log_probs = dist.log_prob(action_t)
                
                # Ratio
                ratio = torch.exp(new_log_probs - old_log_prob_t)
                
                # Clipped objective
                surr1 = ratio * adv_t
                surr2 = torch.clamp(
                    ratio,
                    1 - self.config.clip_eps,
                    1 + self.config.clip_eps,
                ) * adv_t
                
                # Policy loss
                policy_loss = -torch.min(surr1, surr2).mean()
                
                # Value loss
                values = self.value_net(obs_t).squeeze(-1)
                value_loss = nn.functional.mse_loss(values, ret_t)
                
                # Entropy bonus
                entropy = dist.entropy().mean()
                
                # Total loss
                total_loss = (
                    policy_loss
                    + self.config.value_coef * value_loss
                    - self.config.entropy_coef * entropy
                )
                
                # Update
                self.policy_optimizer.zero_grad()
                self.value_optimizer.zero_grad()
                total_loss.backward()
                
                # Gradient clipping
                nn.utils.clip_grad_norm_(
                    self.policy.parameters(),
                    self.config.max_grad_norm,
                )
                nn.utils.clip_grad_norm_(
                    self.value_net.parameters(),
                    self.config.max_grad_norm,
                )
                
                self.policy_optimizer.step()
                self.value_optimizer.step()
                
                # Stats
                policy_losses.append(policy_loss.item())
                value_losses.append(value_loss.item())
                entropies.append(entropy.item())
                
                # Clip fraction
                clip_frac = ((ratio - 1.0).abs() > self.config.clip_eps).float().mean().item()
                clip_fractions.append(clip_frac)
        
        # 记录历史
        self.policy_loss_history.append(np.mean(policy_losses))
        self.value_loss_history.append(np.mean(value_losses))
        self.entropy_history.append(np.mean(entropies))
        self.clip_fraction_history.append(np.mean(clip_fractions))
        
        return {
            "policy_loss": np.mean(policy_losses),
            "value_loss": np.mean(value_losses),
            "entropy": np.mean(entropies),
            "clip_fraction": np.mean(clip_fractions),
        }
    
    def train(
        self,
        env_config: Dict = None,
        total_timesteps: int = 100000,
        eval_interval: int = 10000,
    ) -> Dict[str, List[float]]:
        """
        完整训练流程
        
        Args:
            env_config: 环境配置
            total_timesteps: 总训练步数
            eval_interval: 评估间隔
            
        Returns:
            training history
        """
        print("\n" + "=" * 60)
        print("PPO Training Started")
        print("=" * 60)
        print(f"Total Timesteps: {total_timesteps:,}")
        print(f"Rollout Steps: {self.config.rollout_steps}")
        print(f"PPO Epochs: {self.config.ppo_epochs}")
        print(f"Batch Size: {self.config.batch_size}")
        
        history = {
            "policy_loss": [],
            "value_loss": [],
            "entropy": [],
            "clip_fraction": [],
            "episode_reward": [],
        }
        
        timesteps = 0
        iteration = 0
        
        while timesteps < total_timesteps:
            # Collect rollout
            stats = self.collect_rollout(env_config, self.config.rollout_steps)
            timesteps += stats["episode_length"]
            
            # Update
            update_stats = self.update()
            
            # Record
            history["policy_loss"].append(update_stats["policy_loss"])
            history["value_loss"].append(update_stats["value_loss"])
            history["entropy"].append(update_stats["entropy"])
            history["clip_fraction"].append(update_stats["clip_fraction"])
            history["episode_reward"].append(stats["episode_reward"])
            
            iteration += 1
            
            # Logging
            if iteration % 10 == 0:
                print(f"\nIter {iteration} | Steps {timesteps:,}")
                print(f"  Policy Loss: {update_stats['policy_loss']:.4f}")
                print(f"  Value Loss: {update_stats['value_loss']:.4f}")
                print(f"  Entropy: {update_stats['entropy']:.4f}")
                print(f"  Clip Frac: {update_stats['clip_fraction']:.2%}")
                print(f"  Episode Reward: {stats['episode_reward']:.2f}")
        
        print("\n" + "=" * 60)
        print("PPO Training Completed")
        print("=" * 60)
        
        return history
    
    def save(self, path: str):
        """保存模型"""
        os.makedirs(os.path.dirname(path), exist_ok=True)
        torch.save({
            "policy_state_dict": self.policy.state_dict(),
            "value_state_dict": self.value_net.state_dict(),
            "policy_optimizer_state_dict": self.policy_optimizer.state_dict(),
            "value_optimizer_state_dict": self.value_optimizer.state_dict(),
            "config": self.config,
            "history": {
                "policy_loss": self.policy_loss_history,
                "value_loss": self.value_loss_history,
                "entropy": self.entropy_history,
                "clip_fraction": self.clip_fraction_history,
            },
        }, path)
        print(f"[PPOTrainer] 模型已保存: {path}")
    
    def load(self, path: str):
        """加载模型"""
        checkpoint = torch.load(path)
        self.policy.load_state_dict(checkpoint["policy_state_dict"])
        self.value_net.load_state_dict(checkpoint["value_state_dict"])
        self.policy_optimizer.load_state_dict(checkpoint["policy_optimizer_state_dict"])
        self.value_optimizer.load_state_dict(checkpoint["value_optimizer_state_dict"])
        print(f"[PPOTrainer] 模型已加载: {path}")


def warm_start_from_bc(
    bc_checkpoint: str,
    ppo_config: PPOConfig = None,
) -> PPOTrainer:
    """
    从 Behavioral Cloning checkpoint 加载 warm-start PPO trainer
    
    Args:
        bc_checkpoint: BC 模型路径
        ppo_config: PPO 配置
        
    Returns:
        PPOTrainer
    """
    config = ppo_config or PPOConfig()
    
    # 创建网络
    policy = PolicyNetwork(config.hidden_dim)
    value_net = ValueNetwork(config.hidden_dim)
    
    # 加载 BC 权重
    checkpoint = torch.load(bc_checkpoint)
    policy.load_state_dict(checkpoint["policy_state_dict"])
    
    # 创建 trainer
    trainer = PPOTrainer(policy, value_net, config)
    
    print(f"[PPOTrainer] Warm-start from BC: {bc_checkpoint}")
    return trainer


def main():
    """主函数：演示 PPO Training"""
    print("=" * 60)
    print("PPO Trainer Demo")
    print("=" * 60)

    # Warm-start from BC (prefer v3)
    bc_paths = ["checkpoints/bc_policy_v3.pt", "checkpoints/bc_policy_v2.pt", "checkpoints/bc_policy.pt"]
    bc_path = None
    for path in bc_paths:
        if os.path.exists(path):
            bc_path = path
            break

    if bc_path:
        print(f"\n[1] Warm-start from BC: {bc_path}")
        trainer = warm_start_from_bc(bc_path)
    else:
        print("\n[1] 没有找到 BC 模型，创建随机初始化网络")
        trainer = PPOTrainer(PolicyNetwork(), ValueNetwork())
    
    # 快速训练演示
    print("\n[2] 开始训练演示...")
    history = trainer.train(
        env_config={"arrival_rate": 15.0, "burst_prob": 0.15},
        total_timesteps=100000,  # 增加到 100k
    )
    
    # 保存
    print("\n[3] 保存模型...")
    os.makedirs("checkpoints", exist_ok=True)
    trainer.save("checkpoints/ppo_policy.pt")
    
    print("\n[PPO Training] 完成!")


if __name__ == "__main__":
    main()
