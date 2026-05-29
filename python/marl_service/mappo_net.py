# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge MARL Service: MAPPO 神经网络
# Path: python/marl_service/mappo_net.py
#
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ⚠️  AI 社会专用模块 ⚠️  与主项目隔离
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#
# 实现 MAPPO (Multi-Agent Proximal Policy Optimization) Actor-Critic 架构
# 用于资源调度决策优化
#
# 状态空间：
#   - global_state: [CPU, Memory, Latency, Token, Agents, Tools, Queue, ErrorRate]
#   - local_obs: [任务负载, 队列深度, 响应时间, 错误率]
#
# 动作空间：
#   - 0: NO_OP (正常运行)
#   - 1: PERFORMANCE_MODE (降级模式，限制资源使用)
#   - 2: CIRCUIT_BREAKER (熔断，暂停非关键任务)
#
# ─────────────────────────────────────────────────────────────────

import sys
import os

# 设置 UTF-8 输出
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import torch
import torch.nn as nn
from typing import Tuple, List, Optional


class MAPPOActorNetwork(nn.Module):
    """
    MAPPO Actor 网络
    输入: 全局状态 + 本地观察
    输出: 动作概率分布
    """

    def __init__(self, global_state_dim: int, local_obs_dim: int, hidden_dim: int = 64, num_actions: int = 3):
        super().__init__()
        self.num_actions = num_actions

        # 共享特征提取层
        self.shared_fc = nn.Sequential(
            nn.Linear(global_state_dim + local_obs_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.ReLU(),
        )

        # Actor 策略头
        self.actor_head = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim // 2),
            nn.ReLU(),
            nn.Linear(hidden_dim // 2, num_actions),
            nn.Softmax(dim=-1)
        )

    def forward(self, global_state: torch.Tensor, local_obs: torch.Tensor) -> torch.Tensor:
        """
        前向传播
        Args:
            global_state: [batch, global_state_dim] 全局状态
            local_obs: [batch, local_obs_dim] 本地观察
        Returns:
            action_probs: [batch, num_actions] 动作概率
        """
        combined = torch.cat([global_state, local_obs], dim=-1)
        features = self.shared_fc(combined)
        action_probs = self.actor_head(features)
        return action_probs

    def get_action(self, global_state: torch.Tensor, local_obs: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        """
        采样动作
        Returns:
            action: 动作索引
            action_prob: 所选动作的概率
        """
        probs = self.forward(global_state, local_obs)
        dist = torch.distributions.Categorical(probs)
        action = dist.sample()
        action_prob = probs.gather(1, action.unsqueeze(1)).squeeze(1)
        return action, action_prob


class MAPPOCriticNetwork(nn.Module):
    """
    MAPPO Critic 网络
    输入: 全局状态
    输出: 状态值函数 V(s)
    """

    def __init__(self, global_state_dim: int, hidden_dim: int = 64):
        super().__init__()

        self.critic = nn.Sequential(
            nn.Linear(global_state_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, 1)
        )

    def forward(self, global_state: torch.Tensor) -> torch.Tensor:
        """
        前向传播
        Args:
            global_state: [batch, global_state_dim] 全局状态
        Returns:
            value: [batch, 1] 状态值
        """
        return self.critic(global_state)


class MAPPOPolicy:
    """
    MAPPO 策略封装
    包含 Actor 和 Critic 网络
    """

    def __init__(
        self,
        global_state_dim: int = 8,
        local_obs_dim: int = 4,
        hidden_dim: int = 64,
        num_actions: int = 3,
        model_path: Optional[str] = None
    ):
        self.device = torch.device('cpu')

        # 初始化网络
        self.actor = MAPPOActorNetwork(global_state_dim, local_obs_dim, hidden_dim, num_actions)
        self.critic = MAPPOCriticNetwork(global_state_dim, hidden_dim)

        self.actor.to(self.device)
        self.critic.to(self.device)

        # 动作名称映射
        self.action_names = ['NO_OP', 'PERFORMANCE_MODE', 'CIRCUIT_BREAKER']

        # 加载预训练权重（如果有）
        if model_path and os.path.exists(model_path):
            self.load_model(model_path)
            print(f"[MAPPO] 加载预训练模型: {model_path}")
        else:
            print("[MAPPO] 使用随机初始化权重（无预训练模型）")

    def load_model(self, model_path: str):
        """加载模型权重"""
        checkpoint = torch.load(model_path, map_location=self.device)
        if 'actor_state_dict' in checkpoint:
            self.actor.load_state_dict(checkpoint['actor_state_dict'])
        if 'critic_state_dict' in checkpoint:
            self.critic.load_state_dict(checkpoint['critic_state_dict'])

    def save_model(self, model_path: str):
        """保存模型权重"""
        os.makedirs(os.path.dirname(model_path), exist_ok=True)
        torch.save({
            'actor_state_dict': self.actor.state_dict(),
            'critic_state_dict': self.critic.state_dict(),
        }, model_path)

    def evaluate(
        self,
        global_state: List[float],
        local_obs: List[float]
    ) -> Tuple[int, float, float]:
        """
        评估状态，做出决策
        Args:
            global_state: 全局状态向量 [CPU, Memory, Latency, Token, Agents, Tools, ...]
            local_obs: 本地观察向量
        Returns:
            action: 动作索引 (0=正常, 1=降级, 2=熔断)
            action_prob: 动作概率
            state_value: 状态值
        """
        self.actor.eval()
        self.critic.eval()

        with torch.no_grad():
            # 转换为张量
            gs = torch.FloatTensor(global_state).unsqueeze(0).to(self.device)
            lo = torch.FloatTensor(local_obs).unsqueeze(0).to(self.device)

            # Actor 前向传播
            action_probs = self.actor(gs, lo)
            action = torch.argmax(action_probs, dim=-1).item()
            action_prob = action_probs[0, action].item()

            # Critic 前向传播
            state_value = self.critic(gs).item()

        return action, action_prob, state_value

    def batch_evaluate(
        self,
        batch_global_state: List[List[float]],
        batch_local_obs: List[List[float]]
    ) -> List[Tuple[int, float, float]]:
        """
        批量评估
        """
        self.actor.eval()
        self.critic.eval()

        results = []
        with torch.no_grad():
            gs = torch.FloatTensor(batch_global_state).to(self.device)
            lo = torch.FloatTensor(batch_local_obs).to(self.device)

            action_probs = self.actor(gs, lo)
            state_values = self.critic(gs).squeeze(-1)

            for i in range(len(batch_global_state)):
                action = torch.argmax(action_probs[i]).item()
                action_prob = action_probs[i, action].item()
                value = state_values[i].item()
                results.append((action, action_prob, value))

        return results


def create_default_policy() -> MAPPOPolicy:
    """
    创建默认策略（用于冷启动）
    """
    return MAPPOPolicy(
        global_state_dim=8,
        local_obs_dim=4,
        hidden_dim=64,
        num_actions=3
    )
