# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Social Memory（社会记忆）

社会记忆是多智能体集体经历的共同记忆，用于防止重复踩坑。
存储在 LanceDB 中，支持向量语义搜索。
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import List, Optional
import uuid


class MemorySeverity(Enum):
    """严重度"""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class MemoryImpact(Enum):
    """影响类型"""
    POSITIVE = "positive"
    NEGATIVE = "negative"
    NEUTRAL = "neutral"


@dataclass
class SocialMemory:
    """
    社会记忆

    属性：
        id: 唯一标识符
        event: 事件描述
        impact: 影响类型
        severity: 严重度
        participants: 参与的 Agent ID 列表
        lessons: 经验教训列表
        created_at: 创建时间
    """

    event: str
    impact: MemoryImpact
    severity: MemorySeverity
    participants: List[str] = field(default_factory=list)
    lessons: List[str] = field(default_factory=list)
    id: str = field(default_factory=lambda: f"mem_{uuid.uuid4().hex[:12]}")
    created_at: datetime = field(default_factory=datetime.now)

    # 可选元数据
    task_id: Optional[str] = None
    domain: Optional[str] = None
    outcome: Optional[str] = None  # 成功/失败/部分成功

    def to_dict(self) -> dict:
        """转换为字典"""
        return {
            "id": self.id,
            "event": self.event,
            "impact": self.impact.value,
            "severity": self.severity.value,
            "participants": self.participants,
            "lessons": self.lessons,
            "task_id": self.task_id,
            "domain": self.domain,
            "outcome": self.outcome,
            "created_at": self.created_at.isoformat(),
        }

    def to_vector_record(self) -> dict:
        """转换为 LanceDB 向量记录"""
        return {
            "id": self.id,
            "event": self.event,
            "impact": self.impact.value,
            "severity": self.severity.value,
            "participants": ",".join(self.participants),
            "lessons": ",".join(self.lessons),
            "task_id": self.task_id or "",
            "domain": self.domain or "",
            "outcome": self.outcome or "",
            "created_at": int(self.created_at.timestamp()),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "SocialMemory":
        """从字典创建"""
        return cls(
            id=data["id"],
            event=data["event"],
            impact=MemoryImpact(data["impact"]),
            severity=MemorySeverity(data["severity"]),
            participants=data.get("participants", []),
            lessons=data.get("lessons", []),
            task_id=data.get("task_id"),
            domain=data.get("domain"),
            outcome=data.get("outcome"),
            created_at=datetime.fromisoformat(data["created_at"]),
        )
