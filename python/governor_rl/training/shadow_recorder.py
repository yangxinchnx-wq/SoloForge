# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Shadow Recorder
# Path: python/governor_rl/training/shadow_recorder.py
#
# 积累 Shadow 数据资产：PPO vs BC vs Teacher 三方对比记录
# ─────────────────────────────────────────────────────────────────

import sys
import os
import torch
import numpy as np
import json
from datetime import datetime
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, asdict
from collections import deque

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.models import PolicyNetwork
from governor_rl.env import RuntimeEnvFactory


@dataclass
class ShadowRecord:
    """Shadow 记录"""
    # 观测
    obs: List[float]
    
    # 三方动作
    teacher_action: int
    bc_action: int
    ppo_action: int
    
    # 动作一致性
    teacher_bc_agree: bool
    bc_ppo_agree: bool
    teacher_ppo_agree: bool
    
    # 奖励
    teacher_reward: float
    bc_reward: float
    ppo_reward: float
    
    # 环境状态
    queue_depth: float
    worker_count: float
    oscillation_score: float
    regime: str
    
    # 偏好标签（后续由 Preference Labeler 生成）
    preferred_policy: Optional[str] = None  # "teacher", "bc", "ppo", "tie"
    
    # 元信息
    tick: int = 0
    episode_id: str = ""


class ShadowRecorder:
    """
    Shadow Recorder
    
    记录 PPO/BC/Teacher 三方在同一环境的决策和奖励
    这是整个系统的数据资产
    """
    
    def __init__(
        self,
        bc_policy_path: str = "checkpoints/bc_policy.pt",
        ppo_policy_path: str = "checkpoints/ppo_policy.pt",
        buffer_size: int = 10000,
        output_dir: str = "shadow_data",
    ):
        # 加载策略
        self.bc_policy = PolicyNetwork()
        self.ppo_policy = PolicyNetwork()
        
        if os.path.exists(bc_policy_path):
            ckpt = torch.load(bc_policy_path, weights_only=False)
            self.bc_policy.load_state_dict(ckpt["policy_state_dict"])
            self.bc_policy.eval()
        
        if os.path.exists(ppo_policy_path):
            ckpt = torch.load(ppo_policy_path, weights_only=False)
            self.ppo_policy.load_state_dict(ckpt["policy_state_dict"])
            self.ppo_policy.eval()
        
        self.buffer_size = buffer_size
        self.output_dir = output_dir
        self.current_buffer: deque = deque(maxlen=buffer_size)
        
        # 统计
        self.episode_count = 0
        self.total_steps = 0
        
        os.makedirs(output_dir, exist_ok=True)
    
    def run_episode(
        self,
        env_config: Dict,
        max_steps: int = 500,
        deterministic: bool = True,
        episode_id: str = None,
    ) -> List[ShadowRecord]:
        """
        运行一个 episode，记录所有三方的决策
        
        Args:
            env_config: 环境配置
            max_steps: 最大步数
            deterministic: 确定性动作
            episode_id: Episode ID
            
        Returns:
            记录的列表
        """
        episode_id = episode_id or f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{self.episode_count}"
        
        # 创建环境
        env = RuntimeEnvFactory.create(
            arrival_rate=env_config.get("arrival_rate", 15.0),
            burst_prob=env_config.get("burst_prob", 0.15),
            duration=max_steps,
        )
        
        obs, _ = env.reset()
        records = []
        
        for step in range(max_steps):
            # Teacher 动作（使用规则）
            teacher_action = self._teacher_decide(obs)
            
            # BC 动作
            with torch.no_grad():
                bc_action, _ = self.bc_policy.get_action(obs, deterministic=deterministic)
            
            # PPO 动作
            with torch.no_grad():
                ppo_action, _ = self.ppo_policy.get_action(obs, deterministic=deterministic)
            
            # 执行 BC 动作（作为实际环境动作）
            next_obs, ppo_reward, done, _, info = env.step(bc_action)
            
            # 计算各方奖励
            bc_reward = ppo_reward  # BC 执行获得的奖励
            teacher_reward = self._compute_reward(teacher_action, info)
            ppo_reward = self._compute_reward(ppo_action, info)
            
            # 记录
            record = ShadowRecord(
                obs=obs.tolist(),
                teacher_action=teacher_action,
                bc_action=bc_action,
                ppo_action=ppo_action,
                teacher_bc_agree=teacher_action == bc_action,
                bc_ppo_agree=bc_action == ppo_action,
                teacher_ppo_agree=teacher_action == ppo_action,
                teacher_reward=teacher_reward,
                bc_reward=bc_reward,
                ppo_reward=ppo_reward,
                queue_depth=info.get("queue_depth", 0),
                worker_count=info.get("worker_count", 0),
                oscillation_score=info.get("oscillation_score", 0.0),
                regime=info.get("regime", "unknown"),
                tick=step,
                episode_id=episode_id,
            )
            
            records.append(record)
            self.current_buffer.append(record)
            
            obs = next_obs
            
            if done:
                break
        
        self.episode_count += 1
        self.total_steps += len(records)
        
        return records
    
    def _teacher_decide(self, obs: np.ndarray) -> int:
        """Teacher (规则) 决策"""
        queue = obs[0] * 1000.0  # 反归一化
        workers = obs[3] * 200.0
        oscillation = obs[7]
        
        # 简化的 Teacher 规则
        if queue > 300:
            return 3 if workers < 80 else 4  # spawn
        elif queue < 50:
            return 1 if workers > 20 else 0  # shrink
        elif oscillation > 0.3:
            return 2  # no-op
        else:
            return 2
    
    def _compute_reward(self, action: int, info: Dict) -> float:
        """计算指定动作的奖励"""
        queue = info.get("queue_depth", 0)
        osc = info.get("oscillation_score", 0.0)
        action_map = {0: -2, 1: -1, 2: 0, 3: 1, 4: 2}
        worker_delta = action_map.get(action, 0)
        
        reward = (
            -queue * 0.01
            -osc * 0.1
            -abs(worker_delta) * 0.02
        )
        return reward
    
    def label_preferences(self, records: List[ShadowRecord] = None):
        """
        为记录标注偏好
        
        根据奖励和稳定性标注哪个策略更优
        """
        records = records or list(self.current_buffer)
        
        for record in records:
            rewards = {
                "teacher": record.teacher_reward,
                "bc": record.bc_reward,
                "ppo": record.ppo_reward,
            }
            
            best = max(rewards, key=rewards.get)
            best_reward = rewards[best]
            
            # 如果最高奖励相近（0.01 以内），标记为 tie
            if all(abs(r - best_reward) < 0.01 for r in rewards.values()):
                record.preferred_policy = "tie"
            else:
                record.preferred_policy = best
        
        return records
    
    def run_collection_session(
        self,
        num_episodes: int = 20,
        diverse_configs: bool = True,
    ) -> Dict:
        """
        运行一轮数据采集
        
        Args:
            num_episodes: 采集多少个 episode
            diverse_configs: 是否使用多样化配置
            
        Returns:
            采集统计
        """
        print("=" * 60)
        print("Shadow Data Collection Session")
        print("=" * 60)
        
        if diverse_configs:
            configs = [
                {"arrival_rate": r, "burst_prob": b}
                for r, b in [
                    (10.0, 0.10), (15.0, 0.15), (20.0, 0.20),
                    (12.0, 0.05), (25.0, 0.25), (8.0, 0.02),
                    (18.0, 0.30), (22.0, 0.08), (30.0, 0.15),
                    (14.0, 0.40),
                ]
            ]
        else:
            configs = [{"arrival_rate": 15.0, "burst_prob": 0.15}]
        
        for i in range(num_episodes):
            config = configs[i % len(configs)]
            records = self.run_episode(
                env_config=config,
                episode_id=f"ep_{i:03d}",
            )
            
            # 标注偏好
            self.label_preferences(records)
            
            print(f"  Episode {i+1}/{num_episodes}: {len(records)} steps, "
                  f"buffer: {len(self.current_buffer)}")
        
        return self._compute_statistics()
    
    def _compute_statistics(self) -> Dict:
        """计算统计信息"""
        records = list(self.current_buffer)
        
        if not records:
            return {}
        
        # 动作一致性
        teacher_bc_agree = sum(1 for r in records if r.teacher_bc_agree) / len(records)
        bc_ppo_agree = sum(1 for r in records if r.bc_ppo_agree) / len(records)
        teacher_ppo_agree = sum(1 for r in records if r.teacher_ppo_agree) / len(records)
        
        # 偏好分布
        pref_counts = {"teacher": 0, "bc": 0, "ppo": 0, "tie": 0}
        for r in records:
            if r.preferred_policy:
                pref_counts[r.preferred_policy] = pref_counts.get(r.preferred_policy, 0) + 1
        
        return {
            "total_episodes": self.episode_count,
            "total_steps": self.total_steps,
            "buffer_size": len(self.current_buffer),
            "agreement_rates": {
                "teacher_bc": teacher_bc_agree,
                "bc_ppo": bc_ppo_agree,
                "teacher_ppo": teacher_ppo_agree,
            },
            "preference_distribution": {
                k: v / len(records) for k, v in pref_counts.items()
            },
        }
    
    def print_statistics(self):
        """打印统计"""
        stats = self._compute_statistics()
        
        print("\n" + "=" * 60)
        print("Shadow Recording Statistics")
        print("=" * 60)
        print(f"Episodes: {stats.get('total_episodes', 0)}")
        print(f"Total Steps: {stats.get('total_steps', 0)}")
        print(f"Buffer Size: {stats.get('buffer_size', 0)}")
        
        agree = stats.get("agreement_rates", {})
        print(f"\nAgreement Rates:")
        print(f"  Teacher-BC: {agree.get('teacher_bc', 0):.1%}")
        print(f"  BC-PPO: {agree.get('bc_ppo', 0):.1%}")
        print(f"  Teacher-PPO: {agree.get('teacher_ppo', 0):.1%}")
        
        pref = stats.get("preference_distribution", {})
        print(f"\nPreference Distribution:")
        for k, v in pref.items():
            print(f"  {k}: {v:.1%}")
    
    def save_buffer(self, filename: str = None):
        """保存 buffer 到文件"""
        filename = filename or f"shadow_{datetime.now().strftime('%Y%m%d_%H%M%S')}.jsonl"
        filepath = os.path.join(self.output_dir, filename)
        
        with open(filepath, 'w', encoding='utf-8') as f:
            for record in self.current_buffer:
                f.write(json.dumps(asdict(record), ensure_ascii=False) + '\n')
        
        print(f"[ShadowRecorder] 保存了 {len(self.current_buffer)} 条记录到 {filepath}")
        return filepath
    
    def load_buffer(self, filepath: str):
        """从文件加载 buffer"""
        records = []
        with open(filepath, 'r', encoding='utf-8') as f:
            for line in f:
                data = json.loads(line.strip())
                records.append(ShadowRecord(**data))
        
        self.current_buffer = deque(records, maxlen=self.buffer_size)
        print(f"[ShadowRecorder] 加载了 {len(records)} 条记录")


def main():
    """主函数"""
    print("=" * 60)
    print("Shadow Recorder Demo")
    print("=" * 60)
    
    recorder = ShadowRecorder()
    
    # 采集 10 个 episode
    recorder.run_collection_session(num_episodes=10, diverse_configs=True)
    
    # 打印统计
    recorder.print_statistics()
    
    # 保存数据
    recorder.save_buffer()


if __name__ == "__main__":
    main()
