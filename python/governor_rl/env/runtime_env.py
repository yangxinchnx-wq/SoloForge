# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: RuntimeEnv
# Path: python/governor_rl/env/runtime_env.py
#
# Gymnasium-compatible Runtime Environment
# 这是整个系统的核心闭环
# ─────────────────────────────────────────────────────────────────

import sys
import os
import numpy as np
from typing import Optional, Tuple, Dict, Any

# 设置 UTF-8
sys.stdout.reconfigure(encoding='utf-8')

# 添加路径
script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

import gymnasium as gym
from gymnasium import spaces

from governor_rl.env.action_space import ACTION_MAP, ACTION_NAMES, NUM_ACTIONS
from governor_rl.env.observation_builder import ObservationBuilder
from governor_rl.env.reward_engine import compute_reward

from training.simulator import RuntimeSimulator
from training.simulator.runtime_regime_classifier import RuntimeRegimeClassifier, RuntimeRegime
from training.simulator.precursor_observatory import PrecursorDetector


class RuntimeEnv(gym.Env):
    """
    Runtime Environment

    Gymnasium-compatible environment for Runtime Governor RL
    """

    metadata = {"render_modes": []}

    def __init__(
        self,
        simulator: RuntimeSimulator = None,
        duration: int = 500,
        arrival_rate: float = 15.0,
        burst_prob: float = 0.15,
        seed: int = None,
    ):
        super().__init__()

        # Simulator
        self.simulator = simulator or RuntimeSimulator()
        self.duration = duration
        self.arrival_rate = arrival_rate
        self.burst_prob = burst_prob
        self.current_tick = 0

        # 设置工作负载
        self.simulator.workload.base_arrival_rate = arrival_rate
        self.simulator.workload.burst_probability = burst_prob

        # Observation Builder
        self.obs_builder = ObservationBuilder()

        # Precursor Detector
        self.precursor_detector = PrecursorDetector()

        # Regime Classifier
        self.regime_classifier = RuntimeRegimeClassifier()

        # 历史
        self.queue_history = []
        self.prev_queue = 0
        self.oscillation_history = []

        # Space
        self.observation_space = spaces.Box(
            low=-np.inf,
            high=np.inf,
            shape=(self.obs_builder.get_observation_dim(),),
            dtype=np.float32
        )
        self.action_space = spaces.Discrete(NUM_ACTIONS)

        # Reset
        self._current_obs = None
        self._done = False

    def reset(self, seed: int = None, options: dict = None) -> Tuple[np.ndarray, dict]:
        """
        Reset environment
        """
        if seed is not None:
            np.random.seed(seed)

        # 重置 simulator
        self.simulator.reset()

        # 重置历史
        self.obs_builder.reset()
        self.queue_history = []
        self.prev_queue = 0
        self.oscillation_history = []

        # 重置 tick
        self.current_tick = 0
        self._done = False

        # 获取初始 observation
        self._current_obs = self._get_obs()

        return self._current_obs, {}

    def step(self, action: int) -> Tuple[np.ndarray, float, bool, bool, dict]:
        """
        执行一个时间步

        Args:
            action: action id (0-4)

        Returns:
            obs, reward, terminated, truncated, info
        """
        # 解析动作
        worker_delta = ACTION_MAP.get(action, 0)

        # 应用动作到 simulator
        self._apply_action(worker_delta)

        # Simulator tick
        self.simulator.tick()

        # 更新 tick
        self.current_tick += 1

        # 检查是否结束
        self._done = self._is_done()

        # 计算 reward
        reward = self._compute_reward(worker_delta)

        # 获取 observation
        obs = self._get_obs()
        self._current_obs = obs

        # Info
        info = self._get_info()

        # Gymnasium 返回: (obs, reward, terminated, truncated, info)
        return obs, reward, self._done, False, info

    def _apply_action(self, worker_delta: int):
        """应用动作"""
        if worker_delta > 0:
            self.simulator.state.worker_count += worker_delta
        elif worker_delta < 0:
            self.simulator.state.worker_count = max(1, self.simulator.state.worker_count + worker_delta)

    def _get_obs(self) -> np.ndarray:
        """获取当前 observation"""
        state = self.simulator.state

        # 更新 precursor
        precursor = self.precursor_detector.update(
            tick=state.tick,
            queue=state.queue_depth,
            workers=state.worker_count,
        )

        # 更新历史
        self.queue_history.append(state.queue_depth)
        if len(self.queue_history) > 100:
            self.queue_history.pop(0)

        # 振荡分数
        osc = self.simulator.get_oscillation_score()
        self.oscillation_history.append(osc)

        # Regime
        regime = self._classify_regime()

        # 构建 observation
        obs = self.obs_builder.build(
            queue_depth=state.queue_depth,
            worker_count=state.worker_count,
            cpu_usage=state.cpu_usage,
            precursor_score=precursor.precursor_score,
            risk_score=precursor.precursor_score,  # 简化：risk ≈ precursor
            oscillation_score=osc,
            regime=regime,
        )

        return obs

    def _classify_regime(self) -> str:
        """分类当前 regime"""
        osc = self.simulator.get_oscillation_score()
        queue = self.simulator.state.queue_depth
        workers = self.simulator.state.worker_count

        if queue > 10000 or osc > 0.5:
            return "critical"
        elif osc > 0.3:
            return "oscillating"
        elif queue > 5000:
            return "under_responsive"
        elif workers > 200:
            return "over_responsive"
        elif queue < 100 and workers < 100:
            return "healthy"
        else:
            return "balanced"

    def _compute_reward(self, worker_delta: int) -> float:
        """计算 reward (冻结)"""
        state = self.simulator.state
        osc = self.simulator.get_oscillation_score()

        # 临时设置 oscillation_score
        state.oscillation_score = osc

        return compute_reward(state, worker_delta)

    def _is_done(self) -> bool:
        """检查是否结束"""
        # 达到最大 tick
        if self.current_tick >= self.duration:
            return True

        # 队列爆炸（不可恢复）
        if self.simulator.state.queue_depth > 50000:
            return True

        return False

    def _get_info(self) -> dict:
        """获取额外信息"""
        state = self.simulator.state
        osc = self.simulator.get_oscillation_score()

        return {
            "tick": self.current_tick,
            "queue_depth": state.queue_depth,
            "worker_count": state.worker_count,
            "cpu_usage": state.cpu_usage,
            "oscillation_score": osc,
            "action_name": ACTION_NAMES.get(0, "unknown"),  # 需要传入 action
        }

    def render(self, mode: str = "human"):
        """渲染（可选）"""
        pass

    def close(self):
        """关闭环境"""
        pass


class RuntimeEnvFactory:
    """
    RuntimeEnv 工厂

    方便创建不同配置的 environment
    """

    @staticmethod
    def create(
        arrival_rate: float = 15.0,
        burst_prob: float = 0.15,
        duration: int = 500,
        seed: int = None,
    ) -> RuntimeEnv:
        """
        创建 RuntimeEnv
        """
        env = RuntimeEnv(
            arrival_rate=arrival_rate,
            burst_prob=burst_prob,
            duration=duration,
        )

        if seed is not None:
            env.reset(seed=seed)

        return env

    @staticmethod
    def create_train_env(
        arrival_rate: float = 15.0,
        burst_prob: float = 0.15,
        duration: int = 500,
        seed: int = None,
    ) -> RuntimeEnv:
        """创建训练环境"""
        return RuntimeEnvFactory.create(
            arrival_rate=arrival_rate,
            burst_prob=burst_prob,
            duration=duration,
            seed=seed,
        )

    @staticmethod
    def create_eval_env(
        arrival_rate: float = 30.0,
        burst_prob: float = 0.20,
        duration: int = 500,
        seed: int = None,
    ) -> RuntimeEnv:
        """创建评估环境（更高负载）"""
        return RuntimeEnvFactory.create(
            arrival_rate=arrival_rate,
            burst_prob=burst_prob,
            duration=duration,
            seed=seed,
        )
