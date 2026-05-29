# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Law（法律引擎）

法律引擎定义违规条件和处罚措施。
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional
import uuid


class LawSeverity(Enum):
    """违规严重度"""
    MINOR = "minor"       # 轻微
    MODERATE = "moderate" # 中等
    SEVERE = "severe"     # 严重


@dataclass
class Law:
    """
    法律定义

    属性：
        id: 唯一标识符
        condition: 违规条件（表达式）
        consequence: 处罚措施
        severity: 严重度
        appeals: 是否允许申诉
        created_at: 创建时间
        updated_at: 更新时间
    """

    condition: str  # 违规条件表达式
    consequence: str  # 处罚措施
    severity: LawSeverity = LawSeverity.MODERATE
    appeals: bool = True
    id: str = field(default_factory=lambda: f"law_{uuid.uuid4().hex[:12]}")
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)

    # 可选元数据
    name: Optional[str] = None
    description: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "condition": self.condition,
            "consequence": self.consequence,
            "severity": self.severity.value,
            "appeals": self.appeals,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Law":
        return cls(
            id=data["id"],
            name=data.get("name"),
            description=data.get("description"),
            condition=data["condition"],
            consequence=data["consequence"],
            severity=LawSeverity(data["severity"]),
            appeals=data.get("appeals", True),
            created_at=datetime.fromisoformat(data["created_at"]),
            updated_at=datetime.fromisoformat(data["updated_at"]),
        )


@dataclass
class LawViolation:
    """
    违规记录

    记录每次违规的发生和处理结果
    """

    law_id: str
    agent_id: str
    violation_context: str  # 违规上下文
    consequence_applied: str
    status: str = "active"  # active | appealed | resolved
    id: str = field(default_factory=lambda: f"viol_{uuid.uuid4().hex[:12]}")
    created_at: datetime = field(default_factory=datetime.now)
    resolved_at: Optional[datetime] = None

    # 申诉信息
    appeal_reason: Optional[str] = None
    appeal_result: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "law_id": self.law_id,
            "agent_id": self.agent_id,
            "violation_context": self.violation_context,
            "consequence_applied": self.consequence_applied,
            "status": self.status,
            "appeal_reason": self.appeal_reason,
            "appeal_result": self.appeal_result,
            "created_at": self.created_at.isoformat(),
            "resolved_at": self.resolved_at.isoformat() if self.resolved_at else None,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "LawViolation":
        violation = cls(
            id=data["id"],
            law_id=data["law_id"],
            agent_id=data["agent_id"],
            violation_context=data["violation_context"],
            consequence_applied=data["consequence_applied"],
            status=data.get("status", "active"),
            created_at=datetime.fromisoformat(data["created_at"]),
            resolved_at=datetime.fromisoformat(data["resolved_at"]) if data.get("resolved_at") else None,
            appeal_reason=data.get("appeal_reason"),
            appeal_result=data.get("appeal_result"),
        )
        return violation


# 预置法律
PRESET_LAWS = [
    Law(
        id="law_delete_without_confirm",
        name="未经确认删除文件",
        condition='action == "delete" AND confirmation == false',
        consequence="隔离 24h",
        severity=LawSeverity.SEVERE,
        appeals=True,
    ),
    Law(
        id="law_call_disabled_component",
        name="调用被禁用组件",
        condition='component.status == "disabled"',
        consequence="隔离 1h",
        severity=LawSeverity.MODERATE,
        appeals=True,
    ),
    Law(
        id="law_budget_exceeded",
        name="超过预算",
        condition='credits_spent > budget * 1.2',
        consequence="降级到 economy 模式",
        severity=LawSeverity.MINOR,
        appeals=False,
    ),
    Law(
        id="law_repeated_failure",
        name="重复失败",
        condition='failure_count > 5',
        consequence="完全隔离直到审查",
        severity=LawSeverity.SEVERE,
        appeals=True,
    ),
]
