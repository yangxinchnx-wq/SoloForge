# -*- coding: utf-8 -*-
"""SoloForge AI Society - Agent Identity"""
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional
import uuid


class AgentStatus(Enum):
    ACTIVE = "active"
    PAUSED = "paused"
    DEPRECATED = "deprecated"


class AgentRole(Enum):
    PLANNER = "planner"
    EXECUTOR = "executor"
    REVIEWER = "reviewer"
    REFLECTOR = "reflector"
    GOVERNOR = "governor"
    CUSTOM = "custom"


@dataclass
class AgentIdentity:
    """Agent identity snapshot - one row per agent"""
    id: str
    role: str
    model_binding: str
    system_prompt: str = ""
    system_prompt_version: int = 0
    current_checkpoint_path: Optional[str] = None
    checkpoint_version: int = 0
    task_count: int = 0
    reputation_id: Optional[str] = None
    status: AgentStatus = AgentStatus.ACTIVE
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "role": self.role,
            "model_binding": self.model_binding,
            "system_prompt": self.system_prompt,
            "system_prompt_version": self.system_prompt_version,
            "current_checkpoint_path": self.current_checkpoint_path,
            "checkpoint_version": self.checkpoint_version,
            "task_count": self.task_count,
            "reputation_id": self.reputation_id,
            "status": self.status.value,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data): return cls(id=data["id"],
            role=data["role"],
            model_binding=data["model_binding"],
            system_prompt=data.get("system_prompt", ""),
            system_prompt_version=data.get("system_prompt_version", 0),
            current_checkpoint_path=data.get("current_checkpoint_path"),
            checkpoint_version=data.get("checkpoint_version", 0),
            task_count=data.get("task_count", 0),
            reputation_id=data.get("reputation_id"),
            status=AgentStatus(data.get("status", "active")),
            created_at=datetime.fromisoformat(data["created_at"]),
            updated_at=datetime.fromisoformat(data["updated_at"]),
        )


@dataclass
class AgentTrainingHistory:
    """Append-only training history per agent"""
    agent_id: str
    trained_at: datetime
    trigger_reason: str
    sample_count: Optional[int] = None
    reward_before: Optional[float] = None
    reward_after: Optional[float] = None
    prompt_version_before: Optional[int] = None
    prompt_version_after: Optional[int] = None
    checkpoint_path: Optional[str] = None
    notes: Optional[str] = None
    id: str = field(default_factory=lambda: f"hist_{uuid.uuid4().hex[:12]}")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "agent_id": self.agent_id,
            "trained_at": self.trained_at.isoformat(),
            "trigger_reason": self.trigger_reason,
            "sample_count": self.sample_count,
            "reward_before": self.reward_before,
            "reward_after": self.reward_after,
            "prompt_version_before": self.prompt_version_before,
            "prompt_version_after": self.prompt_version_after,
            "checkpoint_path": self.checkpoint_path,
            "notes": self.notes,
        }

    @classmethod
    def from_dict(cls, data):
        return cls(
            id=data["id"],
            agent_id=data["agent_id"],
            trained_at=datetime.fromisoformat(data["trained_at"]),
            trigger_reason=data["trigger_reason"],
            sample_count=data.get("sample_count"),
            reward_before=data.get("reward_before"),
            reward_after=data.get("reward_after"),
            prompt_version_before=data.get("prompt_version_before"),
            prompt_version_after=data.get("prompt_version_after"),
            checkpoint_path=data.get("checkpoint_path"),
            notes=data.get("notes"),
        )


__all__ = [
    "AgentIdentity",
    "AgentTrainingHistory",
    "AgentStatus",
    "AgentRole",
]
