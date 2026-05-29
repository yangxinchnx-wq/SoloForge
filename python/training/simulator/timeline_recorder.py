# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime Dynamics Laboratory: Timeline Recorder
# Path: python/training/simulator/timeline_recorder.py
#
# 核心原则：
# 1. 偏向"全量记录"，完整可 replay
# 2. Tick 作为统一时间
# 3. 区分 state/action/derived_metrics
# 4. 原始数据优先
# 5. Action 有 intent + magnitude
# 6. 支持 Replay Determinism
# 7. Timeline append-only
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import time
from dataclasses import dataclass, field, asdict
from typing import List, Dict, Any, Optional
from enum import Enum

# 设置 UTF-8 输出
sys.stdout.reconfigure(encoding='utf-8')


class ActionType(Enum):
    """动作类型"""
    NO_OP = "no_op"
    SPAWN_WORKERS = "spawn_workers"
    REDUCE_WORKERS = "reduce_workers"
    ENABLE_REFLECTION = "enable_reflection"
    DISABLE_REFLECTION = "disable_reflection"
    COMPRESS_CONTEXT = "compress_context"
    ENABLE_GC = "enable_gc"
    REDUCE_CONTEXT = "reduce_context"
    PAUSE_BACKGROUND = "pause_background"
    SWITCH_SMALL_MODEL = "switch_small_model"


@dataclass
class RawTelemetry:
    """
    原始遥测数据
    永远比 heuristic metrics 重要
    """
    spawn_count: int = 0
    kill_count: int = 0
    reflection_requests: int = 0
    reflection_suppressed: int = 0
    task_arrivals: int = 0
    task_completions: int = 0
    cpu_samples: List[float] = field(default_factory=list)
    queue_samples: List[int] = field(default_factory=list)


@dataclass
class RuntimeState:
    """运行时状态快照"""
    queue_depth: int = 0
    worker_count: int = 0
    cpu_usage: float = 0.0
    token_pressure: float = 0.0
    reflection_load: float = 0.0
    memory_pressure: float = 0.0
    active_agents: int = 0
    projection_lag: float = 0.0
    scheduler_congestion: float = 0.0
    attention_collapse: float = 0.0
    starvation_penalty_count: int = 0


@dataclass
class Action:
    """
    动作记录
    必须有 intent + magnitude
    """
    type: str = "no_op"
    intent: str = "none"
    delta: int = 0
    reason: str = ""
    blocked_by_cooldown: bool = False


@dataclass
class DerivedMetrics:
    """派生指标（未来可能重新计算）"""
    oscillation_score: float = 0.0
    worker_churn_rate: float = 0.0
    queue_oscillation_amplitude: float = 0.0
    cpu_oscillation_amplitude: float = 0.0
    overshoot_ratio: float = 0.0
    recovery_half_life: float = 0.0
    stabilization_time: int = 0
    action_frequency: float = 0.0


@dataclass
class Event:
    """事件标记"""
    type: str
    severity: str = "info"  # info, warning, critical
    data: Dict[str, Any] = field(default_factory=dict)


@dataclass
class TimelineEntry:
    """
    时间线条目

    结构：tick + state + action + raw_telemetry + derived_metrics + events
    """
    tick: int = 0
    state: RuntimeState = field(default_factory=RuntimeState)
    action: Action = field(default_factory=Action)
    raw_telemetry: RawTelemetry = field(default_factory=RawTelemetry)
    derived_metrics: DerivedMetrics = field(default_factory=DerivedMetrics)
    events: List[Event] = field(default_factory=list)
    timestamp: float = field(default_factory=time.time)


class RuntimeTimelineRecorder:
    """
    Runtime 时间线记录器

    核心职责：
    1. 记录每个 tick 的完整状态
    2. 区分 state/action/derived_metrics
    3. 优先记录原始遥测数据
    4. 支持 Replay Determinism
    5. Append-only
    """

    def __init__(self, output_dir: str = "logs/timeline"):
        self.output_dir = output_dir
        self.entries: List[TimelineEntry] = []
        self.run_id = self._generate_run_id()

        # 实验元数据
        self.metadata = {
            "run_id": self.run_id,
            "experiment": "runtime_dynamics",
            "start_time": time.time(),
            "random_seed": None,
            "workload_config": {},
            "governor_config": {}
        }

        # 确保输出目录存在
        os.makedirs(output_dir, exist_ok=True)

    def _generate_run_id(self) -> str:
        """生成唯一运行 ID"""
        return f"run_{int(time.time() * 1000)}"

    def set_metadata(self, **kwargs):
        """设置实验元数据"""
        self.metadata.update(kwargs)

    def set_random_seed(self, seed: int):
        """记录随机种子（用于 replay determinism）"""
        self.metadata["random_seed"] = seed

    def set_workload_config(self, config: Dict[str, Any]):
        """记录工作负载配置"""
        self.metadata["workload_config"] = config

    def set_governor_config(self, config: Dict[str, Any]):
        """记录 Governor 配置"""
        self.metadata["governor_config"] = config

    def record(
        self,
        tick: int,
        state: RuntimeState,
        action: Action,
        raw_telemetry: RawTelemetry,
        derived_metrics: DerivedMetrics,
        events: List[Event] = None
    ) -> TimelineEntry:
        """
        记录一个时间步

        Args:
            tick: 当前 tick
            state: 运行时状态
            action: Governor 动作
            raw_telemetry: 原始遥测数据
            derived_metrics: 派生指标
            events: 事件列表

        Returns:
            TimelineEntry
        """
        entry = TimelineEntry(
            tick=tick,
            state=state,
            action=action,
            raw_telemetry=raw_telemetry,
            derived_metrics=derived_metrics,
            events=events or [],
            timestamp=time.time()
        )

        self.entries.append(entry)
        return entry

    def to_dict(self, entry: TimelineEntry) -> Dict[str, Any]:
        """
        将条目转换为可序列化的字典

        原始数据优先，派生指标次之
        """
        return {
            "tick": entry.tick,
            "timestamp": entry.timestamp,

            # 核心状态（最重要）
            "state": asdict(entry.state),

            # 动作（包含 intent）
            "action": asdict(entry.action),

            # 原始遥测（永远保留）
            "raw_telemetry": asdict(entry.raw_telemetry),

            # 派生指标（未来可重新计算）
            "derived_metrics": asdict(entry.derived_metrics),

            # 事件标记
            "events": [asdict(e) for e in entry.events]
        }

    def save(self, filename: Optional[str] = None) -> str:
        """
        保存时间线到文件

        Args:
            filename: 文件名，默认使用 run_id

        Returns:
            保存的文件路径
        """
        if filename is None:
            filename = f"{self.run_id}.jsonl"

        filepath = os.path.join(self.output_dir, filename)

        with open(filepath, 'w', encoding='utf-8') as f:
            # 先写元数据
            f.write(json.dumps({"type": "metadata", "data": self.metadata}) + "\n")

            # 再写每个条目
            for entry in self.entries:
                f.write(json.dumps(self.to_dict(entry), ensure_ascii=False) + "\n")

        print(f"[TimelineRecorder] 保存时间线: {filepath}")
        print(f"[TimelineRecorder] 总条目: {len(self.entries)}")

        return filepath

    def load(self, filepath: str) -> bool:
        """
        从文件加载时间线（用于 replay）

        Args:
            filepath: 时间线文件路径

        Returns:
            是否成功
        """
        if not os.path.exists(filepath):
            print(f"[TimelineRecorder] 文件不存在: {filepath}")
            return False

        self.entries.clear()
        self.metadata = {}

        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                for line in f:
                    obj = json.loads(line.strip())

                    if obj.get("type") == "metadata":
                        self.metadata = obj.get("data", {})
                        self.run_id = self.metadata.get("run_id", "unknown")
                    else:
                        entry = self._dict_to_entry(obj)
                        self.entries.append(entry)

            print(f"[TimelineRecorder] 加载时间线: {filepath}")
            print(f"[TimelineRecorder] 加载条目: {len(self.entries)}")
            return True

        except Exception as e:
            print(f"[TimelineRecorder] 加载失败: {e}")
            return False

    def _dict_to_entry(self, d: Dict[str, Any]) -> TimelineEntry:
        """将字典转换回 TimelineEntry"""
        return TimelineEntry(
            tick=d.get("tick", 0),
            timestamp=d.get("timestamp", time.time()),
            state=RuntimeState(**d.get("state", {})),
            action=Action(**d.get("action", {})),
            raw_telemetry=RawTelemetry(**d.get("raw_telemetry", {})),
            derived_metrics=DerivedMetrics(**d.get("derived_metrics", {})),
            events=[Event(**e) for e in d.get("events", [])]
        )

    def get_timeline(self) -> List[TimelineEntry]:
        """获取完整时间线"""
        return self.entries

    def get_state_timeline(self) -> List[Dict[str, Any]]:
        """获取状态时间线（简化版）"""
        return [{"tick": e.tick, **asdict(e.state)} for e in self.entries]

    def get_action_timeline(self) -> List[Dict[str, Any]]:
        """获取动作时间线（简化版）"""
        return [{"tick": e.tick, **asdict(e.action)} for e in self.entries]

    def replay(self, start_tick: int = 0, end_tick: Optional[int] = None):
        """
        遍历时间线（用于 replay）

        Args:
            start_tick: 起始 tick
            end_tick: 结束 tick
        """
        for entry in self.entries:
            if entry.tick < start_tick:
                continue
            if end_tick is not None and entry.tick > end_tick:
                break
            yield entry

    def get_events_by_type(self, event_type: str) -> List[TimelineEntry]:
        """获取包含特定事件类型的条目"""
        return [
            entry for entry in self.entries
            if any(e.type == event_type for e in entry.events)
        ]

    def find_incident(self, tick: int, window: int = 10) -> List[TimelineEntry]:
        """
        查找某个 tick 附近的事件

        Args:
            tick: 目标 tick
            window: 前后窗口大小

        Returns:
            相关时间线条目
        """
        return [
            entry for entry in self.entries
            if abs(entry.tick - tick) <= window
        ]

    def summary(self) -> Dict[str, Any]:
        """获取时间线摘要"""
        if not self.entries:
            return {"total_entries": 0}

        return {
            "run_id": self.run_id,
            "total_entries": len(self.entries),
            "duration_ticks": self.entries[-1].tick - self.entries[0].tick,
            "start_tick": self.entries[0].tick,
            "end_tick": self.entries[-1].tick,
            "metadata": self.metadata,
            "event_counts": self._count_events(),
            "action_counts": self._count_actions()
        }

    def _count_events(self) -> Dict[str, int]:
        """统计事件类型"""
        counts = {}
        for entry in self.entries:
            for event in entry.events:
                counts[event.type] = counts.get(event.type, 0) + 1
        return counts

    def _count_actions(self) -> Dict[str, int]:
        """统计动作类型"""
        counts = {}
        for entry in self.entries:
            action_type = entry.action.type
            counts[action_type] = counts.get(action_type, 0) + 1
        return counts

    def reset(self):
        """重置记录器"""
        self.entries.clear()
        self.run_id = self._generate_run_id()
        self.metadata = {
            "run_id": self.run_id,
            "experiment": "runtime_dynamics",
            "start_time": time.time()
        }
