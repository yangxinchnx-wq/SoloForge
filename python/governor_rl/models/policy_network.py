# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Policy Network
# Path: python/governor_rl/models/policy_network.py
# ─────────────────────────────────────────────────────────────────

import torch
import torch.nn as nn
import numpy as np
from typing import Tuple

# Observation 维度
OBS_DIM = 9
# Action 数量: 5 个动作
ACTION_DIM = 5


class PolicyNetwork(nn.Module):
    """
    Policy Network

    输入: observation (9,)
    输出: action logits (5,)
    """

    def __init__(self, hidden_dim: int = 128):
        super().__init__()

        self.net = nn.Sequential(
            nn.Linear(OBS_DIM, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, ACTION_DIM),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        Forward pass

        Args:
            x: observation, shape (batch, 9) or (9,)

        Returns:
            action logits, shape (batch, 5) or (5,)
        """
        return self.net(x)

    def get_action(self, obs: np.ndarray, deterministic: bool = False) -> Tuple[int, np.ndarray]:
        """
        从 observation 获取动作

        Args:
            obs: observation, shape (9,)
            deterministic: 是否使用确定性策略

        Returns:
            action_idx (0, 1, 2), action_probs
        """
        obs_tensor = torch.FloatTensor(obs).unsqueeze(0)  # (1, 9)

        with torch.no_grad():
            logits = self.forward(obs_tensor)  # (1, 3)
            probs = torch.softmax(logits, dim=-1)  # (1, 3)

        probs = probs.squeeze(0).numpy()  # (3,)

        if deterministic:
            action_idx = int(np.argmax(probs))
        else:
            action_idx = int(np.random.choice(ACTION_DIM, p=probs))

        return action_idx, probs


class ValueNetwork(nn.Module):
    """
    Value Network

    输入: observation (9,)
    输出: state value
    """

    def __init__(self, hidden_dim: int = 128):
        super().__init__()

        self.net = nn.Sequential(
            nn.Linear(OBS_DIM, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        Forward pass

        Args:
            x: observation, shape (batch, 9) or (9,)

        Returns:
            state value, shape (batch, 1) or (1,)
        """
        return self.net(x)


class ActorCritic(nn.Module):
    """
    Actor-Critic Network

    同时输出 policy 和 value
    """

    def __init__(self, hidden_dim: int = 128):
        super().__init__()

        # 共享特征提取
        self.features = nn.Sequential(
            nn.Linear(OBS_DIM, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.ReLU(),
        )

        # Policy head
        self.policy_head = nn.Linear(hidden_dim, ACTION_DIM)

        # Value head
        self.value_head = nn.Linear(hidden_dim, 1)

    def forward(self, x: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        """
        Forward pass

        Args:
            x: observation

        Returns:
            action_logits, state_value
        """
        features = self.features(x)
        logits = self.policy_head(features)
        value = self.value_head(features)
        return logits, value
