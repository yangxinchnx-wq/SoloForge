# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Culture（文化规范）

文化是群体习惯形成的规范，与制度不同，文化是自然形成的。
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional
import uuid


@dataclass
class Culture:
    """
    文化规范

    属性：
        id: 唯一标识符
        principle: 原则（如 "Review优先"）
        adoption_rate: 采纳率（0-1）
        evidence: 采纳证据
        created_at: 创建时间
        updated_at: 更新时间
    """

    principle: str
    adoption_rate: float = 0.0
    evidence: List[str] = field(default_factory=list)
    id: str = field(default_factory=lambda: f"cult_{uuid.uuid4().hex[:12]}")
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)

    # 可选元数据
    description: Optional[str] = None
    target_rate: float = 0.9  # 目标采纳率

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "principle": self.principle,
            "adoption_rate": self.adoption_rate,
            "evidence": self.evidence,
            "description": self.description,
            "target_rate": self.target_rate,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Culture":
        return cls(
            id=data["id"],
            principle=data["principle"],
            adoption_rate=data.get("adoption_rate", 0.0),
            evidence=data.get("evidence", []),
            description=data.get("description"),
            target_rate=data.get("target_rate", 0.9),
            created_at=datetime.fromisoformat(data["created_at"]),
            updated_at=datetime.fromisoformat(data["updated_at"]),
        )


@dataclass
class CultureRecord:
    """
    文化采纳记录
    """

    culture_id: str
    agent_id: str
    adopted: bool  # 是否采纳
    context: Optional[str] = None
    id: str = field(default_factory=lambda: f"cultrec_{uuid.uuid4().hex[:12]}")
    created_at: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "culture_id": self.culture_id,
            "agent_id": self.agent_id,
            "adopted": self.adopted,
            "context": self.context,
            "created_at": self.created_at.isoformat(),
        }


# 预置文化原则
PRESET_CULTURES = [
    Culture(
        id="cult_review_priority",
        principle="Review优先",
        description="代码变更需要审查",
        target_rate=0.95,
    ),
    Culture(
        id="cult_evidence_first",
        principle="证据优先",
        description="决策必须有证据链",
        target_rate=0.90,
    ),
    Culture(
        id="cult_dont_guess",
        principle="不要猜",
        description="不确定时停下来问",
        target_rate=0.85,
    ),
    Culture(
        id="cult_recoverable_first",
        principle="可恢复优先",
        description="没有回滚的操作不能做",
        target_rate=0.95,
    ),
]
