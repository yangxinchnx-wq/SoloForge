# python/marl_service/mappo_net.py
import torch
import torch.nn as nn
from torch.distributions import Categorical
from typing import Tuple

class DecentralizedActor(nn.Module):
    """
    分布式演员网络 (Decentralized Actor) - 运行于各分布式智能体局部网关
    输入：5 维智能体局部观察特征 (Local Observation)
    输出：离散动作空间概率分布
    """
    def __init__(self, local_obs_dim: int, action_dim: int, hidden_dim: int):
        super(DecentralizedActor, self).__init__()
        self.network = nn.Sequential(
            nn.Linear(local_obs_dim, hidden_dim),
            nn.Tanh(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.Tanh(),
            nn.Linear(hidden_dim, action_dim)
        )
        
    def forward(self, local_obs: torch.Tensor) -> Categorical:
        action_logits = self.network(local_obs)
        return Categorical(logits=action_logits)


class CentralizedCritic(nn.Module):
    """
    集中式评论员网络 (Centralized Critic) - 仅在训练阶段感知全局真相宇宙
    输入：10 维全局微内核 Telemetry 状态矩阵 (Global State)
    输出：当前系统状态的确定性 V(s) 价值估计
    """
    def __init__(self, global_state_dim: int, hidden_dim: int):
        super(CentralizedCritic, self).__init__()
        self.network = nn.Sequential(
            nn.Linear(global_state_dim, hidden_dim),
            nn.Tanh(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.Tanh(),
            nn.Linear(hidden_dim, 1)
        )
        
    def forward(self, global_state: torch.Tensor) -> torch.Tensor:
        return self.network(global_state)


class MAPPONetwork(nn.Module):
    """
    真·MAPPO 集中式训练与分布式执行网络总枢
    死守 SoloForge 算法隔离边界，消除跨智能体决策时的隐式特征越权污染
    """
    def __init__(self, local_obs_dim: int, global_state_dim: int, action_dim: int, hidden_dim: int):
        super(MAPPONetwork, self).__init__()
        # 🔒 严格隔离：Actor 决不允许触碰 global_state_dim，坚守零知识去中心化执行规范
        self.actor = DecentralizedActor(local_obs_dim, action_dim, hidden_dim)
        self.critic = CentralizedCritic(global_state_dim, hidden_dim)

    def get_action_and_value(self, local_obs: torch.Tensor, global_state: torch.Tensor, action: torch.Tensor = None) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        dist = self.actor(local_obs)
        if action is None:
            action = dist.sample()
        
        log_prob = dist.log_prob(action)
        entropy = dist.entropy()
        value = self.critic(global_state)
        
        return action, log_prob, entropy, value.squeeze(-1)
