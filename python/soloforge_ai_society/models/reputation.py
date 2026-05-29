# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Reputation（社会信誉）

社会信誉是群体信任体系，记录 Agent/Plugin/Tool/MCP 的信任评分。
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import List, Optional
import uuid


class EntityType(Enum):
    """实体类型"""
    AGENT = "agent"
    PLUGIN = "plugin"
    MCP = "mcp"
    TOOL = "tool"


@dataclass
class Reputation:
    """
    信誉记录

    属性：
        id: 唯一标识符
        entity_id: 实体 ID（Agent/Plugin/Tool/MCP）
        entity_type: 实体类型
        score: 信誉分（0-1）
        evidence: 评分依据
        history: 历史评分序列
        created_at: 创建时间
        updated_at: 更新时间
    """

    entity_id: str
    entity_type: EntityType
    score: float = 1.0
    evidence: List[str] = field(default_factory=list)
    history: List[float] = field(default_factory=list)
    id: str = field(default_factory=lambda: f"rep_{uuid.uuid4().hex[:12]}")
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)

    # 可选元数据
    name: Optional[str] = None
    description: Optional[str] = None

    def to_dict(self) -> dict:
        """转换为字典"""
        return {
            "id": self.id,
            "entity_id": self.entity_id,
            "entity_type": self.entity_type.value,
            "score": self.score,
            "evidence": self.evidence,
            "history": self.history,
            "name": self.name,
            "description": self.description,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Reputation":
        """从字典创建"""
        return cls(
            id=data["id"],
            entity_id=data["entity_id"],
            entity_type=EntityType(data["entity_type"]),
            score=data.get("score", 1.0),
            evidence=data.get("evidence", []),
            history=data.get("history", []),
            name=data.get("name"),
            description=data.get("description"),
            created_at=datetime.fromisoformat(data["created_at"]),
            updated_at=datetime.fromisoformat(data["updated_at"]),
        )

    def calculate_score(
        self,
        task_completion_rate: float,
        error_rate: float,
        collaboration_feedback: float,
        reliability_history: float,
    ) -> float:
        """
        计算信誉分

        公式：信誉分 = 任务完成率×0.4 + (1-错误率)×0.3 + 协作反馈×0.2 + 可靠性历史×0.1
        """
        self.score = (
            task_completion_rate * 0.4
            + (1 - error_rate) * 0.3
            + collaboration_feedback * 0.2
            + reliability_history * 0.1
        )
        # 限制在 0-1 范围
        self.score = max(0.0, min(1.0, self.score))
        self.history.append(self.score)
        self.updated_at = datetime.now()
        return self.score


@dataclass
class ReputationRecord:
    """
    信誉变更记录

    记录每次信誉变更的原因和结果
    """

    reputation_id: str
    delta: float  # 变化量
    reason: str
    source: str  # 来源（如 "task_completion", "violation"）
    id: str = field(default_factory=lambda: f"rprec_{uuid.uuid4().hex[:12]}")
    created_at: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "reputation_id": self.reputation_id,
            "delta": self.delta,
            "reason": self.reason,
            "source": self.source,
            "created_at": self.created_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ReputationRecord":
        return cls(
            id=data["id"],
            reputation_id=data["reputation_id"],
            delta=data["delta"],
            reason=data["reason"],
            source=data["source"],
            created_at=datetime.fromisoformat(data["created_at"]),
        )
