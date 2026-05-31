# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge MAPPO Hyperparameter Drift Experiment Module
# 深度学习自迭代：超参数漂移实验引擎
# Path: python/governor_rl/training/hyperparameter_drift.py
#
# 目标：在 Governance 监管下，让 AI 社会演化出更高阶的博弈范式
# 通过长周期超参数漂移实验，发现超越人工设计的策略配置
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import time
import random
import numpy as np
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Tuple, Optional, Any, Callable
from enum import Enum
from collections import deque
import threading
import copy

# 设置 UTF-8
sys.stdout.reconfigure(encoding='utf-8')

# 添加路径
script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

# 可选导入 torch 相关模块（完全可选，无 torch 时也能运行）
try:
    from governor_rl.models.policy_network import PolicyNetwork, ValueNetwork
    HAS_TORCH = True
except ImportError:
    PolicyNetwork = None
    ValueNetwork = None
    HAS_TORCH = False

# PPOConfig 定义为内联 dataclass（不依赖 torch）
@dataclass
class PPOConfig:
    """PPO 训练配置（内联版本）"""
    hidden_dim: int = 128
    lr: float = 3e-4
    gamma: float = 0.99
    gae_lambda: float = 0.95
    clip_eps: float = 0.2
    value_coef: float = 0.5
    entropy_coef: float = 0.01
    batch_size: int = 64
    ppo_epochs: int = 10
    max_grad_norm: float = 0.5
    rollout_steps: int = 2048
    num_envs: int = 1

# PPOTrainer 和 RolloutBuffer 仅在 torch 可用时导入
PPOTrainer = None
RolloutBuffer = None
HAS_PPO = False

try:
    if HAS_TORCH:
        from governor_rl.training.ppo_trainer import PPOTrainer, RolloutBuffer
        HAS_PPO = True
except ImportError:
    pass


class DriftType(Enum):
    """超参数漂移类型"""
    RANDOM_WALK = "random_walk"           # 随机游走
    TREND = "trend"                       # 趋势漂移
    CYCLIC = "cyclic"                     # 周期震荡
    ADVERSARIAL = "adversarial"          # 对抗性探索
    MOMENTUM = "momentum"                 # 动量漂移
    ADAPTIVE = "adaptive"                 # 自适应漂移（基于性能梯度）


class DriftDirection(Enum):
    """漂移方向"""
    EXPLORATION = "exploration"           # 探索新区域
    EXPLOITATION = "exploitation"        # 收敛到已知最优
    BALANCED = "balanced"                 # 平衡探索与利用


@dataclass
class HyperparameterBounds:
    """超参数边界定义"""
    name: str
    min_val: float
    max_val: float
    default_val: float
    drift_scale: float = 0.1             # 漂移幅度系数
    coupling: List[str] = field(default_factory=list)  # 耦合超参数
    

@dataclass
class HyperparameterState:
    """当前超参数状态"""
    name: str
    current: float
    target: float
    velocity: float = 0.0
    momentum: float = 0.0
    drift_count: int = 0
    last_updated_tick: int = 0


@dataclass
class DriftResult:
    """漂移实验结果"""
    tick: int
    hyperparams: Dict[str, float]
    performance: float
    delta_performance: float
    drift_type: str
    novelty_score: float
    governance_intervention: bool = False
    intervention_reason: str = ""


class HyperparameterSpace:
    """
    MAPPO 超参数空间定义
    
    定义可漂移的超参数及其约束
    """
    
    # 默认超参数空间
    DEFAULT_SPACE = {
        # 学习率参数
        "lr": HyperparameterBounds(
            name="lr",
            min_val=1e-5,
            max_val=1e-2,
            default_val=3e-4,
            drift_scale=0.15,
            coupling=["gamma", "clip_eps"]
        ),
        # 折扣因子
        "gamma": HyperparameterBounds(
            name="gamma",
            min_val=0.9,
            max_val=0.999,
            default_val=0.99,
            drift_scale=0.05,
            coupling=["gae_lambda"]
        ),
        # GAE lambda
        "gae_lambda": HyperparameterBounds(
            name="gae_lambda",
            min_val=0.8,
            max_val=0.99,
            default_val=0.95,
            drift_scale=0.05,
            coupling=["gamma"]
        ),
        # PPO clip epsilon
        "clip_eps": HyperparameterBounds(
            name="clip_eps",
            min_val=0.05,
            max_val=0.4,
            default_val=0.2,
            drift_scale=0.2,
            coupling=["lr"]
        ),
        # Value loss 系数
        "value_coef": HyperparameterBounds(
            name="value_coef",
            min_val=0.1,
            max_val=1.0,
            default_val=0.5,
            drift_scale=0.15
        ),
        # Entropy 系数
        "entropy_coef": HyperparameterBounds(
            name="entropy_coef",
            min_val=0.001,
            max_val=0.1,
            default_val=0.01,
            drift_scale=0.2
        ),
        # Hidden dim
        "hidden_dim": HyperparameterBounds(
            name="hidden_dim",
            min_val=64,
            max_val=512,
            default_val=128,
            drift_scale=0.3
        ),
        # Batch size
        "batch_size": HyperparameterBounds(
            name="batch_size",
            min_val=16,
            max_val=256,
            default_val=64,
            drift_scale=0.2
        ),
        # PPO epochs
        "ppo_epochs": HyperparameterBounds(
            name="ppo_epochs",
            min_val=4,
            max_val=20,
            default_val=10,
            drift_scale=0.15
        ),
        # Max grad norm
        "max_grad_norm": HyperparameterBounds(
            name="max_grad_norm",
            min_val=0.1,
            max_val=1.0,
            default_val=0.5,
            drift_scale=0.2
        ),
    }
    
    def __init__(self, custom_bounds: Dict[str, HyperparameterBounds] = None):
        self.space = copy.deepcopy(self.DEFAULT_SPACE)
        if custom_bounds:
            self.space.update(custom_bounds)
    
    def get_bounds(self, name: str) -> Optional[HyperparameterBounds]:
        return self.space.get(name)
    
    def get_all_names(self) -> List[str]:
        return list(self.space.keys())
    
    def get_default_config(self) -> Dict[str, float]:
        return {name: bounds.default_val for name, bounds in self.space.items()}


class DriftDynamics:
    """
    漂移动力学引擎
    
    实现不同类型的超参数演化策略
    """
    
    def __init__(self, space: HyperparameterSpace):
        self.space = space
        self.rng = np.random.RandomState(int(time.time()) % (2**31))
    
    def random_walk(
        self,
        current: float,
        bounds: HyperparameterBounds,
        tick: int,
    ) -> float:
        """
        随机游走漂移
        
        简单的 Gaussian 随机漫步
        """
        scale = bounds.drift_scale * (bounds.max_val - bounds.min_val)
        delta = self.rng.normal(0, scale * 0.1)
        
        new_val = current + delta
        return self._clamp(new_val, bounds)
    
    def trend_drift(
        self,
        current: float,
        bounds: HyperparameterBounds,
        tick: int,
        trend_strength: float = 0.01,
    ) -> float:
        """
        趋势漂移
        
        在给定方向上持续漂移，方向随机切换
        """
        # 随机决定趋势方向（每 100 tick 切换一次）
        if tick % 100 == 0:
            self._trend_direction = self.rng.choice([-1, 1])
        
        scale = bounds.drift_scale * (bounds.max_val - bounds.min_val)
        delta = self._trend_direction * scale * trend_strength * self.rng.uniform(0.8, 1.2)
        
        new_val = current + delta
        return self._clamp(new_val, bounds)
    
    def cyclic_drift(
        self,
        current: float,
        bounds: HyperparameterBounds,
        tick: int,
        period: int = 500,
        amplitude: float = 0.3,
    ) -> float:
        """
        周期震荡漂移
        
        模拟季节性的超参数演化
        """
        mid_point = (bounds.max_val + bounds.min_val) / 2
        range_half = (bounds.max_val - bounds.min_val) / 2
        
        # 正弦震荡
        phase = (tick % period) / period * 2 * np.pi
        oscillation = np.sin(phase) * amplitude * range_half
        
        # 叠加随机噪声
        noise = self.rng.normal(0, range_half * 0.05)
        
        return self._clamp(mid_point + oscillation + noise, bounds)
    
    def momentum_drift(
        self,
        current: float,
        bounds: HyperparameterBounds,
        tick: int,
        state: HyperparameterState,
        friction: float = 0.95,
    ) -> Tuple[float, float, float]:
        """
        动量漂移
        
        带惯性的漂移动力学，类似物理中的动量守恒
        """
        scale = bounds.drift_scale * (bounds.max_val - bounds.min_val)
        
        # 随机力
        force = self.rng.normal(0, scale * 0.05)
        
        # 更新动量
        new_momentum = state.momentum * friction + force
        
        # 更新速度
        new_velocity = state.velocity * 0.9 + new_momentum * 0.1
        
        # 更新值
        new_val = current + new_velocity
        
        return self._clamp(new_val, bounds), new_velocity, new_momentum
    
    def adversarial_drift(
        self,
        current: float,
        bounds: HyperparameterBounds,
        tick: int,
        worst_config: Dict[str, float] = None,
    ) -> float:
        """
        对抗性漂移
        
        主动远离历史最差配置，探索极端区域
        """
        if worst_config is None or bounds.name not in worst_config:
            # 没有最差配置，使用随机漂移
            return self.random_walk(current, bounds, tick)
        
        worst_val = worst_config[bounds.name]
        
        # 计算当前值与最差值的距离
        mid_point = (bounds.max_val + bounds.min_val) / 2
        distance_from_mid = abs(current - mid_point) / ((bounds.max_val - bounds.min_val) / 2)
        distance_from_worst = abs(current - worst_val) / max(abs(worst_val - mid_point), 1e-6)
        
        # 如果接近最差值，施加较大推力远离
        if distance_from_worst < 0.3 and distance_from_mid > 0.2:
            push_force = -0.1 * (bounds.max_val - bounds.min_val)
            new_val = current + push_force * self.rng.uniform(0.5, 1.5)
        else:
            new_val = self.random_walk(current, bounds, tick)
        
        return self._clamp(new_val, bounds)
    
    def adaptive_drift(
        self,
        current: float,
        bounds: HyperparameterBounds,
        tick: int,
        performance_gradient: float,
        learning_rate: float = 0.01,
    ) -> float:
        """
        自适应漂移
        
        基于性能梯度调整超参数
        """
        # 性能梯度指示了优化方向
        scale = bounds.drift_scale * (bounds.max_val - bounds.min_val)
        
        # 使用梯度的符号，但幅度受 scale 限制
        delta = np.sign(performance_gradient) * scale * learning_rate * self.rng.uniform(0.5, 1.5)
        
        # 添加探索噪声
        noise = self.rng.normal(0, scale * 0.02)
        
        new_val = current + delta + noise
        return self._clamp(new_val, bounds)
    
    def _clamp(self, value: float, bounds: HyperparameterBounds) -> float:
        """将值限制在边界内"""
        return max(bounds.min_val, min(bounds.max_val, value))


class HyperparameterDriftExperiment:
    """
    超参数漂移实验管理器
    
    管理长周期的超参数演化实验
    """
    
    def __init__(
        self,
        space: HyperparameterSpace = None,
        drift_type: DriftType = DriftType.RANDOM_WALK,
        governance_enabled: bool = True,
    ):
        self.space = space or HyperparameterSpace()
        self.drift_type = drift_type
        self.governance_enabled = governance_enabled
        
        # 状态
        self.current_tick = 0
        self.states: Dict[str, HyperparameterState] = {}
        self.history: List[DriftResult] = []
        self.performance_history: deque = deque(maxlen=50)
        
        # 性能跟踪
        self.best_performance = float('-inf')
        self.best_config: Dict[str, float] = {}
        self.worst_performance = float('inf')
        self.worst_config: Dict[str, float] = {}
        
        # 漂移动力学
        self.dynamics = DriftDynamics(self.space)
        
        # 线程锁（必须在 _initialize_states 之前初始化）
        self._lock = threading.Lock()
        
        # 初始化状态
        self._initialize_states()
        
        # 事件回调
        self.on_drift: Optional[Callable[[Dict[str, float], DriftResult], None]] = None
        self.on_governance_intervention: Optional[Callable[[str, str, Dict], None]] = None
        
        # 实验统计
        self.total_drift_count = 0
        self.governance_interventions = 0
        
        print(f"\n{'='*60}")
        print(f"🧬 [HYPERPARAMETER DRIFT EXPERIMENT INITIALIZED]")
        print(f"{'='*60}")
        print(f"Drift Type: {self.drift_type.value}")
        print(f"Governance: {'ENABLED' if self.governance_enabled else 'DISABLED'}")
        print(f"Hyperparameters: {len(self.space.get_all_names())}")
        print(f"{'='*60}\n")
    
    def _initialize_states(self):
        """初始化超参数状态"""
        defaults = self.space.get_default_config()
        for name, value in defaults.items():
            self.states[name] = HyperparameterState(
                name=name,
                current=value,
                target=value,
                velocity=0.0,
                momentum=0.0,
                drift_count=0,
                last_updated_tick=0,
            )
    
    def get_current_config(self) -> Dict[str, float]:
        """获取当前超参数配置（注意：调用方必须持有锁或在单线程环境中）"""
        return {name: state.current for name, state in self.states.items()}
    
    def get_current_config_as_ppo(self) -> PPOConfig:
        """获取当前配置为 PPOConfig 对象"""
        config_dict = self.get_current_config()
        
        # 映射到 PPOConfig 字段
        ppo_config = PPOConfig()
        if "lr" in config_dict:
            ppo_config.lr = config_dict["lr"]
        if "gamma" in config_dict:
            ppo_config.gamma = config_dict["gamma"]
        if "gae_lambda" in config_dict:
            ppo_config.gae_lambda = config_dict["gae_lambda"]
        if "clip_eps" in config_dict:
            ppo_config.clip_eps = config_dict["clip_eps"]
        if "value_coef" in config_dict:
            ppo_config.value_coef = config_dict["value_coef"]
        if "entropy_coef" in config_dict:
            ppo_config.entropy_coef = config_dict["entropy_coef"]
        if "hidden_dim" in config_dict:
            ppo_config.hidden_dim = int(config_dict["hidden_dim"])
        if "batch_size" in config_dict:
            ppo_config.batch_size = int(config_dict["batch_size"])
        if "ppo_epochs" in config_dict:
            ppo_config.ppo_epochs = int(config_dict["ppo_epochs"])
        if "max_grad_norm" in config_dict:
            ppo_config.max_grad_norm = config_dict["max_grad_norm"]
        
        return ppo_config
    
    def step(
        self,
        performance: float,
        governance_signal: Dict[str, Any] = None,
    ) -> DriftResult:
        """
        执行一步漂移
        
        Args:
            performance: 当前性能指标
            governance_signal: 来自 Governance 的干预信号
            
        Returns:
            DriftResult: 漂移结果
        """
        with self._lock:
            self.current_tick += 1
            
            # 记录性能
            delta_perf = performance - (self.performance_history[-1] if self.performance_history else 0)
            self.performance_history.append(performance)
            
            # 更新最优/最差
            if performance > self.best_performance:
                self.best_performance = performance
                self.best_config = self.get_current_config()
            
            if performance < self.worst_performance:
                self.worst_performance = performance
                self.worst_config = self.get_current_config()
            
            # 计算性能梯度（用于自适应漂移）
            perf_gradient = self._calculate_performance_gradient()
            
            # 检查 Governance 干预
            intervention = False
            intervention_reason = ""
            
            if self.governance_enabled and governance_signal:
                intervention, intervention_reason = self._check_governance_intervention(
                    governance_signal
                )
            
            # 执行漂移
            new_config = {}
            novelty_score = 0.0
            
            for name, state in self.states.items():
                bounds = self.space.get_bounds(name)
                if bounds is None:
                    continue
                
                # 根据漂移类型选择方法
                if self.drift_type == DriftType.RANDOM_WALK:
                    new_val = self.dynamics.random_walk(
                        state.current, bounds, self.current_tick
                    )
                elif self.drift_type == DriftType.TREND:
                    new_val = self.dynamics.trend_drift(
                        state.current, bounds, self.current_tick
                    )
                elif self.drift_type == DriftType.CYCLIC:
                    new_val = self.dynamics.cyclic_drift(
                        state.current, bounds, self.current_tick
                    )
                elif self.drift_type == DriftType.MOMENTUM:
                    new_val, velocity, momentum = self.dynamics.momentum_drift(
                        state.current, bounds, self.current_tick, state
                    )
                    state.velocity = velocity
                    state.momentum = momentum
                elif self.drift_type == DriftType.ADVERSARIAL:
                    new_val = self.dynamics.adversarial_drift(
                        state.current, bounds, self.current_tick, self.worst_config
                    )
                elif self.drift_type == DriftType.ADAPTIVE:
                    new_val = self.dynamics.adaptive_drift(
                        state.current, bounds, self.current_tick, perf_gradient
                    )
                else:
                    new_val = self.dynamics.random_walk(
                        state.current, bounds, self.current_tick
                    )
                
                # 应用 Governance 干预
                if intervention and self.governance_enabled:
                    new_val = self._apply_governance_intervention(
                        new_val, bounds, governance_signal, name
                    )
                
                # 计算新颖性分数
                default = bounds.default_val
                novelty = abs(new_val - default) / (bounds.max_val - bounds.min_val)
                novelty_score = max(novelty_score, novelty)
                
                # 更新状态
                state.current = new_val
                state.target = new_val
                state.drift_count += 1
                state.last_updated_tick = self.current_tick
                
                new_config[name] = new_val
            
            # 创建结果
            result = DriftResult(
                tick=self.current_tick,
                hyperparams=new_config,
                performance=performance,
                delta_performance=delta_perf,
                drift_type=self.drift_type.value,
                novelty_score=novelty_score,
                governance_intervention=intervention,
                intervention_reason=intervention_reason,
            )
            
            self.history.append(result)
            self.total_drift_count += 1
            
            if intervention:
                self.governance_interventions += 1
            
            # 触发回调
            if self.on_drift:
                self.on_drift(new_config, result)
            
            if intervention and self.on_governance_intervention:
                self.on_governance_intervention(
                    intervention_reason, self.drift_type.value, new_config
                )
            
            return result
    
    def _calculate_performance_gradient(self) -> float:
        """计算性能梯度"""
        if len(self.performance_history) < 5:
            return 0.0
        
        recent = list(self.performance_history)[-10:]
        if len(recent) < 2:
            return 0.0
        
        # 简单线性回归斜率
        x = np.arange(len(recent))
        coeffs = np.polyfit(x, recent, 1)
        return coeffs[0]
    
    def _check_governance_intervention(
        self,
        signal: Dict[str, Any],
    ) -> Tuple[bool, str]:
        """
        检查是否需要 Governance 干预
        
        基于 Government Intervention 策略参数
        """
        intervention = False
        reason = ""
        
        # 检查特权代理尝试次数
        suspicious_agents = signal.get("suspicious_agents", [])
        privileged_threshold = signal.get("privileged_threshold", 20)
        
        for agent in suspicious_agents:
            attempts = agent.get("attempts", 0)
            if attempts >= privileged_threshold:
                intervention = True
                reason = f"PRIVILEGE_BYPASS: Agent {agent['id']} attempts={attempts}"
                break
        
        # 检查熵
        entropy = signal.get("system_entropy", 0)
        entropy_threshold = signal.get("entropy_threshold", 0.85)
        
        if entropy > entropy_threshold:
            intervention = True
            reason = f"HIGH_ENTROPY: system_entropy={entropy:.4f} > {entropy_threshold}"
        
        # 检查性能崩溃
        if len(self.performance_history) >= 10:
            recent = list(self.performance_history)[-10:]
            if all(recent[i] > recent[i+1] for i in range(len(recent)-1)):
                intervention = True
                reason = "PERFORMANCE_COLLAPSE: 10 consecutive drops"
        
        return intervention, reason
    
    def _apply_governance_intervention(
        self,
        current: float,
        bounds: HyperparameterBounds,
        signal: Dict[str, Any],
        param_name: str,
    ) -> float:
        """
        应用 Governance 干预
        
        使用税收均衡系数和声望衰减算子
        """
        tax_coeff = signal.get("tax_equilibrium_coefficient", 0.15)
        decay_op = signal.get("reputation_decay_operator", 0.05)
        
        # 计算干预强度
        intervention_strength = tax_coeff + decay_op
        
        # 向默认值方向收敛
        default = bounds.default_val
        mid_point = (bounds.max_val + bounds.min_val) / 2
        
        # 计算当前值与中点的距离
        distance_from_mid = current - mid_point
        
        # 应用衰减
        pulled_value = current - distance_from_mid * intervention_strength * 0.1
        
        # 限制漂移幅度
        max_deviation = (bounds.max_val - bounds.min_val) * 0.3
        if abs(pulled_value - default) > max_deviation:
            pulled_value = default + np.sign(pulled_value - default) * max_deviation
        
        return self.dynamics._clamp(pulled_value, bounds)
    
    def get_experiment_summary(self) -> Dict[str, Any]:
        """获取实验摘要"""
        return {
            "current_tick": self.current_tick,
            "total_drift_count": self.total_drift_count,
            "governance_interventions": self.governance_interventions,
            "best_performance": self.best_performance,
            "best_config": self.best_config,
            "worst_performance": self.worst_performance,
            "worst_config": self.worst_config,
            "current_config": self.get_current_config(),
            "drift_type": self.drift_type.value,
            "performance_trend": self._calculate_performance_gradient(),
        }
    
    def save_state(self, path: str):
        """保存实验状态"""
        state = {
            "current_tick": self.current_tick,
            "states": {name: asdict(s) for name, s in self.states.items()},
            "best_performance": self.best_performance,
            "best_config": self.best_config,
            "worst_performance": self.worst_performance,
            "worst_config": self.worst_config,
            "total_drift_count": self.total_drift_count,
            "governance_interventions": self.governance_interventions,
            "drift_type": self.drift_type.value,
            "performance_history": list(self.performance_history),
        }
        
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(state, f, indent=2, ensure_ascii=False)
        
        print(f"[HyperparameterDrift] 实验状态已保存: {path}")
    
    def load_state(self, path: str):
        """加载实验状态"""
        with open(path, 'r', encoding='utf-8') as f:
            state = json.load(f)
        
        self.current_tick = state["current_tick"]
        self.best_performance = state["best_performance"]
        self.best_config = state["best_config"]
        self.worst_performance = state["worst_performance"]
        self.worst_config = state["worst_config"]
        self.total_drift_count = state["total_drift_count"]
        self.governance_interventions = state["governance_interventions"]
        
        for name, s_dict in state["states"].items():
            self.states[name] = HyperparameterState(**s_dict)
        
        self.performance_history = deque(
            state["performance_history"], maxlen=50
        )
        
        print(f"[HyperparameterDrift] 实验状态已加载: {path}")


class MAPPOEvolutionaryTrainer:
    """
    MAPPO 进化训练器
    
    将超参数漂移与 PPO 训练深度集成
    """
    
    def __init__(
        self,
        policy: PolicyNetwork,
        value_net: ValueNetwork,
        drift_experiment: HyperparameterDriftExperiment = None,
    ):
        self.policy = policy
        self.value_net = value_net
        
        # 默认 PPO trainer
        self.default_ppo_config = PPOConfig()
        
        # 漂移实验
        self.drift_experiment = drift_experiment or HyperparameterDriftExperiment()
        
        # 训练历史
        self.training_log: List[Dict] = []
        
        # 当前 PPO trainer（会根据漂移后的超参数重新创建）
        self.current_trainer: Optional[PPOTrainer] = None
        
        # 统计
        self.total_iterations = 0
        self.generation = 0
        
    def evolve_generation(
        self,
        env_config: Dict = None,
        iterations_per_generation: int = 10,
        evaluation_episodes: int = 5,
    ) -> Dict[str, Any]:
        """
        进化一代
        
        在当前超参数下训练若干迭代，然后执行漂移
        
        Args:
            env_config: 环境配置
            iterations_per_generation: 每代训练迭代数
            evaluation_episodes: 评估 episodes 数
            
        Returns:
            进化结果统计
        """
        print(f"\n{'='*60}")
        print(f"🧬 [GENERATION {self.generation}] Starting Evolution")
        print(f"{'='*60}")
        
        # 获取当前超参数配置
        ppo_config = self.drift_experiment.get_current_config_as_ppo()
        
        # 创建 PPO Trainer
        self.current_trainer = PPOTrainer(
            policy=self.policy,
            value_net=self.value_net,
            config=ppo_config,
        )
        
        # 训练
        generation_rewards = []
        
        for i in range(iterations_per_generation):
            # 收集 rollout
            stats = self.current_trainer.collect_rollout(env_config)
            
            # 更新
            update_stats = self.current_trainer.update()
            
            generation_rewards.append(stats["episode_reward"])
            
            self.total_iterations += 1
            
            if i % 5 == 0:
                print(f"  Iter {i}/{iterations_per_generation}: "
                      f"Reward={stats['episode_reward']:.2f}, "
                      f"Policy Loss={update_stats['policy_loss']:.4f}")
        
        # 评估性能
        avg_reward = np.mean(generation_rewards[-5:])
        
        # 执行漂移
        governance_signal = self._prepare_governance_signal()
        
        drift_result = self.drift_experiment.step(
            performance=avg_reward,
            governance_signal=governance_signal,
        )
        
        # 记录
        self.training_log.append({
            "generation": self.generation,
            "avg_reward": avg_reward,
            "hyperparams": drift_result.hyperparams,
            "novelty_score": drift_result.novelty_score,
            "governance_intervention": drift_result.governance_intervention,
            "delta_performance": drift_result.delta_performance,
        })
        
        self.generation += 1
        
        print(f"\n{'='*60}")
        print(f"📊 [GENERATION {self.generation - 1}] Summary")
        print(f"  Average Reward: {avg_reward:.2f}")
        print(f"  Novelty Score: {drift_result.novelty_score:.4f}")
        print(f"  Governance Intervention: {drift_result.governance_intervention}")
        print(f"{'='*60}\n")
        
        return {
            "generation": self.generation - 1,
            "avg_reward": avg_reward,
            "drift_result": drift_result,
            "hyperparams": drift_result.hyperparams,
        }
    
    def _prepare_governance_signal(self) -> Dict[str, Any]:
        """准备 Governance 信号"""
        # 计算系统熵
        if len(self.training_log) < 10:
            entropy = 0.5
        else:
            recent_rewards = [log["avg_reward"] for log in self.training_log[-10:]]
            entropy = np.std(recent_rewards) / (np.mean(recent_rewards) + 1e-6)
        
        return {
            "system_entropy": entropy,
            "entropy_threshold": 0.85,
            "privileged_threshold": 20,
            "suspicious_agents": [],
            "tax_equilibrium_coefficient": 0.15,
            "reputation_decay_operator": 0.05,
        }
    
    def run_evolution(
        self,
        env_config: Dict = None,
        total_generations: int = 50,
        iterations_per_generation: int = 10,
    ) -> Dict[str, Any]:
        """
        运行完整进化过程
        
        Args:
            env_config: 环境配置
            total_generations: 总代数
            iterations_per_generation: 每代迭代数
            
        Returns:
            进化最终结果
        """
        print(f"\n{'='*60}")
        print(f"🚀 [EVOLUTION START] MAPPO Hyperparameter Drift Experiment")
        print(f"{'='*60}")
        print(f"Total Generations: {total_generations}")
        print(f"Generations per Iteration: {iterations_per_generation}")
        print(f"Governance: {'ENABLED' if self.drift_experiment.governance_enabled else 'DISABLED'}")
        print(f"{'='*60}\n")
        
        start_time = time.time()
        
        for gen in range(total_generations):
            result = self.evolve_generation(
                env_config=env_config,
                iterations_per_generation=iterations_per_generation,
            )
            
            # 每 10 代保存一次
            if (gen + 1) % 10 == 0:
                self.save_checkpoint(f"checkpoints/drift_gen_{gen+1}.json")
        
        elapsed = time.time() - start_time
        
        # 最终摘要
        summary = self.drift_experiment.get_experiment_summary()
        summary["total_generations"] = total_generations
        summary["elapsed_time_seconds"] = elapsed
        summary["final_reward": np.mean([log["avg_reward"] for log in self.training_log[-10:]])]
        
        print(f"\n{'='*60}")
        print(f"🏁 [EVOLUTION COMPLETE]")
        print(f"{'='*60}")
        print(f"Total Generations: {total_generations}")
        print(f"Elapsed Time: {elapsed:.2f}s")
        print(f"Best Performance: {summary['best_performance']:.2f}")
        print(f"Best Config: {summary['best_config']}")
        print(f"Governance Interventions: {summary['governance_interventions']}")
        print(f"{'='*60}\n")
        
        return summary
    
    def save_checkpoint(self, path: str):
        """保存检查点"""
        checkpoint = {
            "policy_state_dict": self.policy.state_dict(),
            "value_state_dict": self.value_net.state_dict(),
            "training_log": self.training_log,
            "generation": self.generation,
            "total_iterations": self.total_iterations,
            "drift_summary": self.drift_experiment.get_experiment_summary(),
        }
        
        # 保存 PyTorch 模型
        model_path = path.replace('.json', '_policy.pt')
        import torch
        torch.save({
            "policy_state_dict": self.policy.state_dict(),
            "value_state_dict": self.value_net.state_dict(),
        }, model_path)
        
        # 保存漂移状态
        drift_path = path.replace('.json', '_drift.json')
        self.drift_experiment.save_state(drift_path)
        
        print(f"[MAPPOEvolutionaryTrainer] Checkpoint saved: {path}")
    
    def load_checkpoint(self, path: str):
        """加载检查点"""
        import torch
        
        # 加载模型
        model_path = path.replace('.json', '_policy.pt')
        if os.path.exists(model_path):
            checkpoint = torch.load(model_path)
            self.policy.load_state_dict(checkpoint["policy_state_dict"])
            self.value_net.load_state_dict(checkpoint["value_state_dict"])
            print(f"[MAPPOEvolutionaryTrainer] Model loaded: {model_path}")
        
        # 加载漂移状态
        drift_path = path.replace('.json', '_drift.json')
        if os.path.exists(drift_path):
            self.drift_experiment.load_state(drift_path)


def demo_drift_experiment():
    """演示超参数漂移实验"""
    print("\n" + "=" * 60)
    print("🧬 MAPPO Hyperparameter Drift Experiment Demo")
    print("=" * 60 + "\n")
    
    # 创建超参数空间
    space = HyperparameterSpace()
    
    # 创建漂移实验（启用 Governance）
    experiment = HyperparameterDriftExperiment(
        space=space,
        drift_type=DriftType.MOMENTUM,
        governance_enabled=True,
    )
    
    # 模拟性能波动
    simulated_performance = 0.0
    
    print("Running 100 drift steps...\n")
    
    for step in range(100):
        # 模拟性能（带有随机波动）
        performance = simulated_performance + np.random.normal(0, 0.1)
        simulated_performance = performance
        
        # 模拟 Governance 信号（每 20 步一次干预）
        governance_signal = None
        if step % 20 == 10:
            governance_signal = {
                "system_entropy": 0.7,
                "entropy_threshold": 0.85,
                "privileged_threshold": 20,
                "suspicious_agents": [{"id": "agent_alpha", "attempts": 25}],
                "tax_equilibrium_coefficient": 0.15,
                "reputation_decay_operator": 0.05,
            }
        
        # 执行漂移
        result = experiment.step(performance, governance_signal)
        
        if step % 10 == 0:
            print(f"Step {step:3d}: perf={performance:7.3f}, "
                  f"lr={result.hyperparams['lr']:.6f}, "
                  f"gamma={result.hyperparams['gamma']:.4f}, "
                  f"novelty={result.novelty_score:.3f}, "
                  f"gov={result.governance_intervention}")
    
    # 输出摘要
    summary = experiment.get_experiment_summary()
    print(f"\n{'='*60}")
    print("📊 Experiment Summary")
    print(f"{'='*60}")
    print(f"Total Steps: {summary['current_tick']}")
    print(f"Best Performance: {summary['best_performance']:.4f}")
    print(f"Governance Interventions: {summary['governance_interventions']}")
    print(f"Performance Trend: {summary['performance_trend']:.6f}")
    print(f"\nBest Config:")
    for k, v in summary['best_config'].items():
        print(f"  {k}: {v:.6f}")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    demo_drift_experiment()
