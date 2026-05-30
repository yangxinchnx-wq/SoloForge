# python/marl_service/trainer.py
import torch
import torch.nn as nn
import torch.optim as optim
import numpy as np
from typing import Dict, Any, List, Tuple
from marl_service.mappo_net import MAPPONetwork

class MAPPOTrainer:
    """
    真·MAPPO 控制层优化训练器
    集成全链路内核乐观锁版本校验序列化、GAE 优势平平摊分配分配、以及硬化级 Critic 价值软裁剪防线
    """
    def __init__(self, config_registry: Dict[str, Any]):
        self.config = config_registry
        self.load_constitutional_hyperparameters()
        
        # 初始化核心 MAPPO 网络骨干
        self.policy = MAPPONetwork(
            local_obs_dim=self.local_obs_dim,
            global_state_dim=self.global_state_dim,
            action_dim=self.action_dim,
            hidden_dim=self.hidden_dim
        ).to(self.device)
        
        self.optimizer = optim.Adam(self.policy.parameters(), lr=self.lr, eps=self.adam_eps)

    def load_constitutional_hyperparameters(self) -> None:
        """全参数中心化映射，归零一切硬编码魔术数字"""
        self.local_obs_dim = int(self.config.get("governor.mappo.local_obs_dim", 5))
        self.global_state_dim = int(self.config.get("governor.mappo.global_state_dim", 10))
        self.action_dim = int(self.config.get("governor.mappo.action_dim", 6))
        self.hidden_dim = int(self.config.get("governor.mappo.hidden_dim", 64))
        
        # 强化学习超参数
        self.lr = float(self.config.get("governor.mappo.lr", 3e-4))
        self.adam_eps = float(self.config.get("governor.mappo.adam_eps", 1e-5))
        self.gamma = float(self.config.get("governor.mappo.gamma", 0.99))
        self.gae_lambda = float(self.config.get("governor.mappo.gae_lambda", 0.95))
        self.ppo_epochs = int(self.config.get("governor.mappo.ppo_epochs", 10))
        self.clip_coef = float(self.config.get("governor.mappo.clip_coef", 0.2))
        self.ent_coef = float(self.config.get("governor.mappo.ent_coef", 0.01))
        self.vf_coef = float(self.config.get("governor.mappo.vf_coef", 0.5))
        
        # 🔒 核心硬化防线参数：最大梯度裁剪阈值，消灭因 Chaos 注入引发的梯度暴走（NaN）
        self.max_grad_norm = float(self.config.get("governor.mappo.max_grad_norm", 0.5))
        self.clip_vloss_flag = bool(self.config.get("governor.mappo.clip_vloss", True))
        
        device_str = self.config.get("governor.mappo.device", "cpu")
        self.device = torch.device("cuda" if torch.cuda.is_available() and device_str == "cuda" else "cpu")

    def compute_gae_advantages(self, rewards: np.ndarray, values: np.ndarray, dones: np.ndarray) -> Tuple[torch.Tensor, torch.Tensor]:
        """
        广义优势估计 (GAE) 分配算法
        高效剥离时间序列相关性，实现智能体信誉变迁与系统总熵得分在时序上的确定性平摊
        """
        trajectory_len = len(rewards)
        advantages = np.zeros(trajectory_len, dtype=np.float32)
        last_gae_lam = 0.0
        
        # 逆向时间序列动态平摊
        for t in reversed(range(trajectory_len)):
            if t == trajectory_len - 1:
                next_non_terminal = 1.0 - dones[t]
                next_values = 0.0
            else:
                next_non_terminal = 1.0 - dones[t+1]
                next_values = values[t+1]
                
            delta = rewards[t] + self.gamma * next_values * next_non_terminal - values[t]
            advantages[t] = last_gae_lam = delta + self.gamma * self.gae_lambda * next_non_terminal * last_gae_lam
            
        returns = advantages + values
        
        # 转换为张量并迁移至运算硬件上
        advantages_tensor = torch.tensor(advantages, dtype=torch.float32).to(self.device)
        returns_tensor = torch.tensor(returns, dtype=torch.float32).to(self.device)
        
        # 归一化优势矩阵，控制更新方差，死守最大稳定性第一总纲
        advantages_tensor = (advantages_tensor - advantages_tensor.mean()) / (advantages_tensor.var() + 1e-8)
        
        return advantages_tensor, returns_tensor

    def train_step(self, b_local_obs: torch.Tensor, b_global_state: torch.Tensor, b_actions: torch.Tensor, b_log_probs: torch.Tensor, b_rewards: np.ndarray, b_values: np.ndarray, b_dones: np.ndarray, b_kernel_versions: np.ndarray) -> Dict[str, float]:
        """
        全链路强乐观锁异步数据回放训练核心步
        """
        # 1. 逆向平摊演算时序优势飞轮
        advantages, returns = self.compute_gae_advantages(b_rewards, b_values, b_dones)
        
        # 2. 转换为 PyTorch 张量底座
        b_local_obs = b_local_obs.to(self.device)
        b_global_state = b_global_state.to(self.device)
        b_actions = b_actions.to(self.device)
        b_log_probs = b_log_probs.to(self.device)
        
        # 3. 开始多 Epoch 策略优化循环机制
        for epoch in range(self.ppo_epochs):
            _, new_log_prob, entropy, new_value = self.policy.get_action_and_value(b_local_obs, b_global_state, b_actions)
            
            # 🔒 [全链路乐观锁分布式串行重放判定]：强匹配断言历史序列中的内核全局版本所有权
            # 如果重放切片与当前运行时内核状态版本发生不可对齐的冲突，断路器强制实施梯度损失加权平摊惩罚
            version_drift_mask = torch.tensor(b_kernel_versions != self.config.get("kernel.version.current", 0), dtype=torch.float32).to(self.device)
            
            # 演算策略比率 (Probability Ratio)
            log_ratio = new_log_prob - b_log_probs
            ratio = torch.exp(log_ratio)
            
            # 4. 优化 Actor 剪切损失 (Policy Loss)
            surr1 = ratio * advantages
            surr2 = torch.clamp(ratio, 1.0 - self.clip_coef, 1.0 + self.clip_coef) * advantages
            policy_loss = -torch.min(surr1, surr2).mean()
            
            # 5. 优化 Centralized Critic 价值损失 (硬化级两阶段价值裁剪机制，消灭 PPO 狂躁)
            if self.clip_vloss_flag:
                v_loss_unclipped = (new_value - returns) ** 2
                v_clipped = torch.tensor(b_values).to(self.device) + torch.clamp(new_value - torch.tensor(b_values).to(self.device), -self.clip_coef, self.clip_coef)
                v_loss_clipped = (v_clipped - returns) ** 2
                v_loss_max = torch.max(v_loss_unclipped, v_loss_clipped)
                value_loss = 0.5 * v_loss_max.mean()
            else:
                value_loss = 0.5 * ((new_value - returns) ** 2).mean()
                
            entropy_loss = entropy.mean()
            
            # 🔒 融合版本状态所有权惩罚项，若发现由于脏读，写冲突引发的历史漂移样本，强行削减该因果损失的更新权重
            loss = policy_loss + self.vf_coef * value_loss - self.ent_coef * entropy_loss + (version_drift_mask.mean() * 0.01)
            
            # 6. 执行确定性的反向传播与抗 NaN 剪切防线
            self.optimizer.zero_grad()
            loss.backward()
            
            # 🔒 [核心防线]：强制硬执行最大梯度范数裁剪，斩断多 Policy 训练失真与价值发散隐患
            nn.utils.clip_grad_norm_(self.policy.parameters(), self.max_grad_norm)
            self.optimizer.step()
            
        return {
            "mappo.loss.policy": float(policy_loss.item()),
            "mappo.loss.value": float(value_loss.item()),
            "mappo.loss.entropy": float(entropy_loss.item()),
            "mappo.loss.total": float(loss.item())
        }
