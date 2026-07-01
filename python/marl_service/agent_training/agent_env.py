"""
agent_env.py — 专业化 Agent 的 MARL 训练环境

将 Agent 执行任务建模为强化学习问题:
  - 观测: 任务特征 + Agent 状态 + 上下文
  - 动作: 选择工具 + 执行策略
  - 奖励: 任务成功率 + 效率 + 质量

复用现有的 MAPPO 基础设施 (mappo_net.py, trainer.py)
"""

import gymnasium as gym
import numpy as np
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple
from enum import IntEnum


# ─── 动作空间: Agent 可以选择的操作 ─────────────────────────────

class AgentAction(IntEnum):
    """Agent 可执行的动作"""
    # 工具调用 (7 个)
    READ_FILE = 0           # 读取文件
    WRITE_FILE = 1          # 写入文件
    EXECUTE_CMD = 2         # 执行命令
    SEARCH_CODE = 3         # 搜索代码
    LIST_FILES = 4          # 列出文件
    ASK_USER = 5            # 询问用户
    FINISH_TASK = 6         # 完成任务

    # 策略调整 (3 个)
    SWITCH_PRECISION = 7    # 切换到精确模式
    SWITCH_CREATIVE = 8     # 切换到创意模式
    SWITCH_DEEP = 9         # 切换到深度分析模式


ACTION_SPACE_SIZE = len(AgentAction)


# ─── 观测空间: Agent 能看到的信息 ─────────────────────────────

@dataclass
class AgentObservation:
    """Agent 的观测"""
    # 任务特征 (4 维)
    task_complexity: float = 0.5        # 任务复杂度 (0-1)
    task_domain_match: float = 0.5      # 任务与 Agent 领域的匹配度 (0-1)
    task_code_lines: float = 0.0        # 预估代码行数 / 1000
    task_requires_tools: float = 0.5    # 是否需要工具 (0-1)

    # Agent 状态 (4 维)
    agent_skill_count: float = 0.0      # 技能库大小 / 100
    agent_success_rate: float = 0.5     # 历史成功率
    agent_current_round: float = 0.0    # 当前轮数 / max_rounds
    agent_tool_error_rate: float = 0.0  # 本轮工具错误率

    # 上下文 (2 维)
    context_has_existing_code: float = 0.0  # 是否有现有代码
    context_file_count: float = 0.0         # 相关文件数 / 100

    def to_array(self) -> np.ndarray:
        return np.array([
            self.task_complexity,
            self.task_domain_match,
            self.task_code_lines,
            self.task_requires_tools,
            self.agent_skill_count,
            self.agent_success_rate,
            self.agent_current_round,
            self.agent_tool_error_rate,
            self.context_has_existing_code,
            self.context_file_count,
        ], dtype=np.float32)

    @staticmethod
    def dim() -> int:
        return 10


# ─── 任务模拟器 ─────────────────────────────────────────────────

@dataclass
class SimulatedTask:
    """模拟的任务"""
    task_id: str
    domain: str
    complexity: float
    optimal_tools: List[str]      # 最优工具序列
    optimal_strategy: str         # 最优策略
    max_rounds: int = 10
    required_file_reads: int = 1  # 需要读几次文件
    required_commands: int = 0    # 需要执行几次命令


# 预定义任务模板
TASK_TEMPLATES = [
    SimulatedTask(
        task_id="simple_api",
        domain="backend",
        complexity=0.3,
        optimal_tools=["list_files", "read_file", "write_file"],
        optimal_strategy="fast-iterate",
        max_rounds=5,
    ),
    SimulatedTask(
        task_id="complex_api",
        domain="backend",
        complexity=0.7,
        optimal_tools=["list_files", "read_file", "search_code", "write_file", "execute_cmd"],
        optimal_strategy="deep-analysis",
        max_rounds=10,
        required_commands=2,
    ),
    SimulatedTask(
        task_id="ui_component",
        domain="ui-design",
        complexity=0.5,
        optimal_tools=["list_files", "read_file", "write_file"],
        optimal_strategy="creative",
        max_rounds=7,
    ),
    SimulatedTask(
        task_id="security_audit",
        domain="security",
        complexity=0.8,
        optimal_tools=["list_files", "search_code", "read_file", "read_file", "write_file"],
        optimal_strategy="precision",
        max_rounds=12,
        required_file_reads=3,
    ),
    SimulatedTask(
        task_id="database_schema",
        domain="database",
        complexity=0.6,
        optimal_tools=["list_files", "search_code", "write_file"],
        optimal_strategy="precision",
        max_rounds=8,
    ),
    SimulatedTask(
        task_id="unit_test",
        domain="testing",
        complexity=0.4,
        optimal_tools=["read_file", "write_file", "execute_cmd"],
        optimal_strategy="precision",
        max_rounds=6,
        required_commands=1,
    ),
]


# ─── 训练环境 ─────────────────────────────────────────────────

class AgentTrainingEnv(gym.Env):
    """
    专业化 Agent 的 MARL 训练环境

    多个 Agent 同时训练，每个 Agent 学习:
      1. 什么时候该用什么工具
      2. 什么任务该用什么策略
      3. 如何高效完成任务（最少轮数）
    """

    metadata = {"render_modes": ["human"]}

    def __init__(
        self,
        num_agents: int = 4,
        max_steps: int = 15,
        task_pool: Optional[List[SimulatedTask]] = None,
    ):
        super().__init__()
        self.num_agents = num_agents
        self.max_steps = max_steps
        self.task_pool = task_pool or TASK_TEMPLATES

        # 观测空间: 每个 Agent 一个观测
        self.observation_space = gym.spaces.Box(
            low=0.0, high=1.0,
            shape=(AgentObservation.dim(),),
            dtype=np.float32,
        )

        # 动作空间: 每个 Agent 选择一个动作
        self.action_space = gym.spaces.Discrete(ACTION_SPACE_SIZE)

        # 状态
        self.current_task: Optional[SimulatedTask] = None
        self.current_step = 0
        self.agent_observations: List[AgentObservation] = []
        self.tools_used: List[List[str]] = []
        self.strategy_used: List[str] = []

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        self.current_step = 0

        # 随机选择一个任务
        self.current_task = self.np_random.choice(self.task_pool)

        # 初始化每个 Agent 的观测
        self.agent_observations = []
        self.tools_used = [[] for _ in range(self.num_agents)]
        self.strategy_used = ["fast-iterate"] * self.num_agents

        for i in range(self.num_agents):
            obs = AgentObservation(
                task_complexity=self.current_task.complexity,
                task_domain_match=1.0 if i == 0 else 0.3,  # 第一个 Agent 是最匹配的
                task_code_lines=self.current_task.complexity * 2,
                task_requires_tools=0.8,
                agent_skill_count=0.1,
                agent_success_rate=0.5,
                agent_current_round=0.0,
                agent_tool_error_rate=0.0,
                context_has_existing_code=0.5,
                context_file_count=0.2,
            )
            self.agent_observations.append(obs)

        # 返回所有 Agent 的观测 (MAPPO 需要)
        observations = np.array([obs.to_array() for obs in self.agent_observations])
        return observations, {}

    def step(self, actions: np.ndarray):
        self.current_step += 1
        rewards = np.zeros(self.num_agents)
        infos = [{} for _ in range(self.num_agents)]

        for i, action in enumerate(actions):
            action_enum = AgentAction(int(action))
            obs = self.agent_observations[i]

            # 计算奖励
            reward = self._compute_reward(i, action_enum, obs)
            rewards[i] = reward

            # 更新观测
            self._update_observation(i, action_enum, obs)

            # 记录
            infos[i] = {
                "agent_id": i,
                "action": action_enum.name,
                "tool": self._action_to_tool(action_enum),
                "strategy": self._action_to_strategy(action_enum),
            }

        # 检查是否结束
        terminated = self.current_step >= self.max_steps
        truncated = False

        # 如果有 Agent 选择了 FINISH_TASK，也可以结束
        if any(AgentAction(int(a)) == AgentAction.FINISH_TASK for a in actions):
            terminated = True

        observations = np.array([obs.to_array() for obs in self.agent_observations])
        return observations, rewards, terminated, truncated, infos

    def _compute_reward(self, agent_idx: int, action: AgentAction, obs: AgentObservation) -> float:
        """计算奖励"""
        reward = 0.0
        task = self.current_task

        # 1. 工具选择奖励
        tool_name = self._action_to_tool(action)
        if tool_name:
            self.tools_used[agent_idx].append(tool_name)
            # 使用了正确的工具 → +0.3
            if tool_name in task.optimal_tools:
                reward += 0.3
            # 使用了错误的工具 → -0.1
            else:
                reward -= 0.1

        # 2. 策略选择奖励
        strategy = self._action_to_strategy(action)
        if strategy:
            self.strategy_used[agent_idx] = strategy
            if strategy == task.optimal_strategy:
                reward += 0.2
            else:
                reward -= 0.05

        # 3. 效率奖励 (轮数越少越好)
        if action == AgentAction.FINISH_TASK:
            # 检查是否完成了必要的步骤
            tools = self.tools_used[agent_idx]
            completeness = self._check_completeness(tools, task)
            reward += completeness * 2.0  # 完成度奖励

            # 效率奖励 (提前完成)
            efficiency = 1.0 - (self.current_step / self.max_steps)
            reward += efficiency * 0.5

        # 4. 领域匹配奖励
        if agent_idx == 0:  # 匹配的 Agent
            reward += 0.1
        else:  # 不匹配的 Agent
            reward -= 0.05

        # 5. 工具错误惩罚
        if obs.agent_tool_error_rate > 0.3:
            reward -= 0.2

        return reward

    def _update_observation(self, agent_idx: int, action: AgentAction, obs: AgentObservation):
        """更新 Agent 观测"""
        obs.agent_current_round = self.current_step / self.max_steps

        # 模拟工具执行结果
        tool_name = self._action_to_tool(action)
        if tool_name:
            # 模拟 10% 的工具错误率
            if self.np_random.random() < 0.1:
                obs.agent_tool_error_rate = min(1.0, obs.agent_tool_error_rate + 0.1)

        # 模拟读取文件后上下文变化
        if action == AgentAction.READ_FILE:
            obs.context_has_existing_code = 1.0
        if action == AgentAction.LIST_FILES:
            obs.context_file_count = min(1.0, obs.context_file_count + 0.3)

    def _check_completeness(self, tools_used: List[str], task: SimulatedTask) -> float:
        """检查任务完成度"""
        if not tools_used:
            return 0.0

        # 必须有 write_file
        if "write_file" not in tools_used:
            return 0.3

        # 有 write_file + read_file
        if "read_file" not in tools_used:
            return 0.5

        # 完整流程
        return 1.0

    def _action_to_tool(self, action: AgentAction) -> Optional[str]:
        """动作 → 工具名"""
        mapping = {
            AgentAction.READ_FILE: "read_file",
            AgentAction.WRITE_FILE: "write_file",
            AgentAction.EXECUTE_CMD: "execute_cmd",
            AgentAction.SEARCH_CODE: "search_code",
            AgentAction.LIST_FILES: "list_files",
            AgentAction.ASK_USER: "ask_user",
        }
        return mapping.get(action)

    def _action_to_strategy(self, action: AgentAction) -> Optional[str]:
        """动作 → 策略名"""
        mapping = {
            AgentAction.SWITCH_PRECISION: "precision",
            AgentAction.SWITCH_CREATIVE: "creative",
            AgentAction.SWITCH_DEEP: "deep-analysis",
        }
        return mapping.get(action)
