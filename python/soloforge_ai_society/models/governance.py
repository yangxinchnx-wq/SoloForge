# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Governance（治理层）

治理是制度的执行与评估，确保制度被遵守并持续优化。
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional
import uuid


@dataclass
class Governance:
    """
    治理记录

    属性：
        id: 唯一标识符
        institution_id: 关联的制度 ID
        owner: 治理者（Agent/User/自动规则）
        effectiveness: 治理效果评分（0-1）
        violations: 违规次数
        last_review: 最近审查时间
        created_at: 创建时间
        updated_at: 更新时间
    """

    institution_id: str
    owner: str
    effectiveness: float = 1.0
    violations: int = 0
    id: str = field(default_factory=lambda: f"gov_{uuid.uuid4().hex[:12]}")
    last_review: datetime = field(default_factory=datetime.now)
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)

    # 可选说明
    description: Optional[str] = None
    notes: Optional[str] = None

    def to_dict(self) -> dict:
        """转换为字典"""
        return {
            "id": self.id,
            "institution_id": self.institution_id,
            "owner": self.owner,
            "effectiveness": self.effectiveness,
            "violations": self.violations,
            "last_review": self.last_review.isoformat(),
            "description": self.description,
            "notes": self.notes,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Governance":
        """从字典创建"""
        return cls(
            id=data["id"],
            institution_id=data["institution_id"],
            owner=data["owner"],
            effectiveness=data.get("effectiveness", 1.0),
            violations=data.get("violations", 0),
            last_review=datetime.fromisoformat(data["last_review"]),
            description=data.get("description"),
            notes=data.get("notes"),
            created_at=datetime.fromisoformat(data["created_at"]),
            updated_at=datetime.fromisoformat(data["updated_at"]),
        )


@dataclass
class GovernanceRecord:
    """
    治理执行记录

    用于记录每次治理检查的结果
    """

    governance_id: str
    agent_id: str
    compliant: bool
    action_taken: Optional[str] = None
    notes: Optional[str] = None
    id: str = field(default_factory=lambda: f"grecord_{uuid.uuid4().hex[:12]}")
    created_at: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "governance_id": self.governance_id,
            "agent_id": self.agent_id,
            "compliant": self.compliant,
            "action_taken": self.action_taken,
            "notes": self.notes,
            "created_at": self.created_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "GovernanceRecord":
        return cls(
            id=data["id"],
            governance_id=data["governance_id"],
            agent_id=data["agent_id"],
            compliant=data["compliant"],
            action_taken=data.get("action_taken"),
            notes=data.get("notes"),
            created_at=datetime.fromisoformat(data["created_at"]),
        )
