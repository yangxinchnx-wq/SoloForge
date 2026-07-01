"""
train_agents.py — 用 MAPPO 训练专业化 Agent

复用现有的:
  - MAPPO 网络 (mappo_net.py)
  - MAPPO 训练器 (trainer.py)
  - GAE + PPO 优化

训练流程:
  1. 创建 AgentTrainingEnv (4 个 Agent 并行)
  2. 用 MAPPO 训练 N 个 epoch
  3. 保存训练好的策略
  4. 导出学到的工具选择偏好给 Node.js

运行:
  cd python/marl_service
  python -m agent_training.train_agents
"""

import os
import sys
import json
import time
import torch
import numpy as np
from pathlib import Path
from typing import Dict, List

# 添加父目录到路径
sys.path.insert(0, str(Path(__file__).parent.parent))

from agent_training.agent_env import AgentTrainingEnv, AgentAction, ACTION_SPACE_SIZE, AgentObservation
from mappo_net import MAPPONetwork


# ─── 训练配置 ─────────────────────────────────────────────────

TRAINING_CONFIG = {
    "num_agents": 4,
    "obs_dim": AgentObservation.dim(),  # 10
    "action_dim": ACTION_SPACE_SIZE,     # 10
    "hidden_dim": 128,
    "lr": 3e-4,
    "gamma": 0.99,
    "gae_lambda": 0.95,
    "clip_coef": 0.2,
    "ent_coef": 0.02,       # 稍高熵系数，鼓励探索
    "vf_coef": 0.5,
    "max_grad_norm": 0.5,
    "ppo_epochs": 4,
    "num_mini_batches": 1,
    "max_steps": 15,
    "num_iterations": 200,   # 训练轮数
    "save_interval": 50,     # 每 50 轮保存一次
    "log_interval": 10,      # 每 10 轮打印一次
}


# ─── Rollout Buffer ───────────────────────────────────────────

class RolloutBuffer:
    """存储一轮 rollout 的数据"""

    def __init__(self, num_steps: int, num_agents: int, obs_dim: int):
        self.observations = np.zeros((num_steps, num_agents, obs_dim), dtype=np.float32)
        self.actions = np.zeros((num_steps, num_agents), dtype=np.int64)
        self.log_probs = np.zeros((num_steps, num_agents), dtype=np.float32)
        self.rewards = np.zeros((num_steps, num_agents), dtype=np.float32)
        self.values = np.zeros((num_steps, num_agents), dtype=np.float32)
        self.dones = np.zeros((num_steps, num_agents), dtype=np.float32)
        self.advantages = np.zeros((num_steps, num_agents), dtype=np.float32)
        self.returns = np.zeros((num_steps, num_agents), dtype=np.float32)
        self.num_steps = num_steps
        self.num_agents = num_agents
        self.step = 0

    def insert(self, obs, actions, log_probs, rewards, values, dones):
        self.observations[self.step] = obs
        self.actions[self.step] = actions
        self.log_probs[self.step] = log_probs
        self.rewards[self.step] = rewards
        self.values[self.step] = values
        self.dones[self.step] = dones
        self.step += 1

    def compute_gae(self, next_value: np.ndarray, gamma: float, gae_lambda: float):
        """计算 GAE (Generalized Advantage Estimation)"""
        last_gae = 0
        for t in reversed(range(self.num_steps)):
            if t == self.num_steps - 1:
                next_non_terminal = 1.0 - self.dones[t]
                next_val = next_value
            else:
                next_non_terminal = 1.0 - self.dones[t]
                next_val = self.values[t + 1]
            delta = self.rewards[t] + gamma * next_val * next_non_terminal - self.values[t]
            last_gae = delta + gamma * gae_lambda * next_non_terminal * last_gae
            self.advantages[t] = last_gae
        self.returns = self.advantages + self.values

    def get_batches(self, num_mini_batches: int):
        """生成 mini-batch"""
        total = self.num_steps * self.num_agents
        indices = np.arange(total)
        np.random.shuffle(indices)
        batch_size = total // num_mini_batches

        obs = self.observations.reshape(total, -1)
        act = self.actions.reshape(total)
        log_p = self.log_probs.reshape(total)
        ret = self.returns.reshape(total)
        adv = self.advantages.reshape(total)

        for start in range(0, total, batch_size):
            end = start + batch_size
            idx = indices[start:end]
            yield (
                torch.FloatTensor(obs[idx]),
                torch.LongTensor(act[idx]),
                torch.FloatTensor(log_p[idx]),
                torch.FloatTensor(ret[idx]),
                torch.FloatTensor(adv[idx]),
            )


# ─── 训练器 ─────────────────────────────────────────────────

class AgentTrainer:
    """MAPPO Agent 训练器"""

    def __init__(self, config: Dict = None):
        self.config = config or TRAINING_CONFIG
        self.device = torch.device("cpu")

        # 创建环境
        self.env = AgentTrainingEnv(
            num_agents=self.config["num_agents"],
            max_steps=self.config["max_steps"],
        )

        # 创建 MAPPO 网络 (复用现有)
        self.network = MAPPONetwork(
            local_obs_dim=self.config["obs_dim"],
            global_state_dim=self.config["obs_dim"] * self.config["num_agents"],
            action_dim=self.config["action_dim"],
            hidden_dim=self.config["hidden_dim"],
        ).to(self.device)

        self.optimizer = torch.optim.Adam(self.network.parameters(), lr=self.config["lr"])

        # 统计
        self.episode_rewards: List[float] = []
        self.episode_lengths: List[int] = []
        self.action_counts = np.zeros(ACTION_SPACE_SIZE)

    def collect_rollout(self) -> RolloutBuffer:
        """收集一轮 rollout"""
        buffer = RolloutBuffer(
            num_steps=self.config["max_steps"],
            num_agents=self.config["num_agents"],
            obs_dim=self.config["obs_dim"],
        )

        obs, _ = self.env.reset()
        done = False

        for step in range(self.config["max_steps"]):
            # 构建输入
            local_obs = torch.FloatTensor(obs)
            global_state = torch.FloatTensor(obs.reshape(1, -1)).repeat(
                self.config["num_agents"], 1
            )

            # 前向传播
            with torch.no_grad():
                action, log_prob, entropy, value = self.network.get_action_and_value(
                    local_obs, global_state
                )

            action_np = action.cpu().numpy()
            log_prob_np = log_prob.cpu().numpy()
            value_np = value.cpu().numpy()

            # 执行动作
            next_obs, rewards, terminated, truncated, infos = self.env.step(action_np)
            done = terminated or truncated

            # 记录
            buffer.insert(obs, action_np, log_prob_np, rewards, value_np,
                         np.array([float(done)] * self.config["num_agents"]))

            # 统计动作分布
            for a in action_np:
                self.action_counts[int(a)] += 1

            obs = next_obs
            if done:
                break

        # 计算 GAE
        with torch.no_grad():
            next_local = torch.FloatTensor(obs)
            next_global = torch.FloatTensor(obs.reshape(1, -1)).repeat(
                self.config["num_agents"], 1
            )
            _, _, _, next_value = self.network.get_action_and_value(
                next_local, next_global
            )
        buffer.compute_gae(
            next_value.cpu().numpy(),
            self.config["gamma"],
            self.config["gae_lambda"],
        )

        return buffer

    def update(self, buffer: RolloutBuffer):
        """PPO 更新"""
        total_loss = 0
        total_policy_loss = 0
        total_value_loss = 0
        total_entropy = 0
        update_count = 0

        for epoch in range(self.config["ppo_epochs"]):
            for obs, actions, old_log_probs, returns, advantages in buffer.get_batches(
                self.config["num_mini_batches"]
            ):
                # 前向传播
                global_state = obs.repeat(1, 1)  # 简化
                new_log_probs, entropy, values = self.network.evaluate_actions(
                    obs, global_state, actions
                )

                # 策略损失 (PPO clip)
                ratio = torch.exp(new_log_probs - old_log_probs)
                surr1 = ratio * advantages
                surr2 = torch.clamp(ratio, 1 - self.config["clip_coef"],
                                   1 + self.config["clip_coef"]) * advantages
                policy_loss = -torch.min(surr1, surr2).mean()

                # 价值损失
                value_loss = 0.5 * ((returns - values) ** 2).mean()

                # 熵奖励
                entropy_loss = -entropy.mean()

                # 总损失
                loss = (policy_loss
                       + self.config["vf_coef"] * value_loss
                       + self.config["ent_coef"] * entropy_loss)

                # 反向传播
                self.optimizer.zero_grad()
                loss.backward()
                torch.nn.utils.clip_grad_norm_(
                    self.network.parameters(), self.config["max_grad_norm"]
                )
                self.optimizer.step()

                total_loss += loss.item()
                total_policy_loss += policy_loss.item()
                total_value_loss += value_loss.item()
                total_entropy += -entropy_loss.item()
                update_count += 1

        return {
            "loss": total_loss / update_count,
            "policy_loss": total_policy_loss / update_count,
            "value_loss": total_value_loss / update_count,
            "entropy": total_entropy / update_count,
        }

    def train(self):
        """主训练循环"""
        print("=" * 60)
        print("  SoloForge Agent MARL Training")
        print("=" * 60)
        print(f"\nConfig:")
        for k, v in self.config.items():
            print(f"  {k}: {v}")
        print()

        save_dir = Path(__file__).parent / "checkpoints"
        save_dir.mkdir(exist_ok=True)

        start_time = time.time()

        for iteration in range(1, self.config["num_iterations"] + 1):
            # 收集 rollout
            buffer = self.collect_rollout()

            # 计算本轮统计
            total_reward = buffer.rewards.sum(axis=0).mean()
            avg_length = buffer.step

            self.episode_rewards.append(total_reward)
            self.episode_lengths.append(avg_length)

            # PPO 更新
            stats = self.update(buffer)

            # 日志
            if iteration % self.config["log_interval"] == 0:
                elapsed = time.time() - start_time
                recent_rewards = self.episode_rewards[-self.config["log_interval"]:]
                avg_reward = np.mean(recent_rewards)

                print(f"[{iteration:4d}/{self.config['num_iterations']}] "
                      f"reward={avg_reward:+.3f} "
                      f"loss={stats['loss']:.4f} "
                      f"pi={stats['policy_loss']:.4f} "
                      f"v={stats['value_loss']:.4f} "
                      f"H={stats['entropy']:.3f} "
                      f"t={elapsed:.0f}s")

            # 保存检查点
            if iteration % self.config["save_interval"] == 0:
                checkpoint_path = save_dir / f"agent_mappo_iter{iteration}.pt"
                torch.save({
                    "iteration": iteration,
                    "network_state": self.network.state_dict(),
                    "optimizer_state": self.optimizer.state_dict(),
                    "config": self.config,
                    "episode_rewards": self.episode_rewards,
                }, checkpoint_path)
                print(f"  → Saved checkpoint: {checkpoint_path}")

        # 保存最终模型
        final_path = save_dir / "agent_mappo_final.pt"
        torch.save({
            "iteration": self.config["num_iterations"],
            "network_state": self.network.state_dict(),
            "optimizer_state": self.optimizer.state_dict(),
            "config": self.config,
            "episode_rewards": self.episode_rewards,
        }, final_path)

        # 导出策略给 Node.js
        self._export_policy(save_dir)

        print(f"\nTraining complete. Total time: {time.time() - start_time:.0f}s")
        print(f"Final model: {final_path}")

    def _export_policy(self, save_dir: Path):
        """导出学到的策略为 JSON，供 Node.js 使用"""
        # 分析动作分布
        total = self.action_counts.sum()
        action_probs = self.action_counts / total if total > 0 else self.action_counts

        policy = {
            "version": 1,
            "trained_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "action_distribution": {
                AgentAction(i).name: float(action_probs[i])
                for i in range(ACTION_SPACE_SIZE)
            },
            "learned_preferences": {
                "preferred_tools": [],
                "preferred_strategies": {},
            },
        }

        # 推荐工具 (使用率 > 10%)
        for i in range(ACTION_SPACE_SIZE):
            if action_probs[i] > 0.1 and i < 7:  # 工具动作
                policy["learned_preferences"]["preferred_tools"].append(
                    AgentAction(i).name.lower()
                )

        # 推荐策略
        strategy_map = {
            AgentAction.SWITCH_PRECISION: "precision",
            AgentAction.SWITCH_CREATIVE: "creative",
            AgentAction.SWITCH_DEEP: "deep-analysis",
        }
        for action, strategy in strategy_map.items():
            if action_probs[action] > 0.05:
                policy["learned_preferences"]["preferred_strategies"][strategy] = float(
                    action_probs[action]
                )

        policy_path = save_dir / "learned_policy.json"
        with open(policy_path, "w") as f:
            json.dump(policy, f, indent=2)
        print(f"  → Exported policy: {policy_path}")


# ─── 入口 ─────────────────────────────────────────────────

if __name__ == "__main__":
    trainer = AgentTrainer()
    trainer.train()
