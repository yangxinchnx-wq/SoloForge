# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Coalition（联盟机制）

联盟是临时组队完成复杂任务的机制。
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import List, Optional
import uuid


class CoalitionStatus(Enum):
    """联盟状态"""
    FORMING = "forming"   # 组建中
    ACTIVE = "active"    # 活动中
    DISSOLVED = "dissolved"  # 已解散


@dataclass
class CoalitionMember:
    """
    联盟成员
    """

    agent_id: str
    role: str  # leader | member
    joined_at: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> dict:
        return {
            "agent_id": self.agent_id,
            "role": self.role,
            "joined_at": self.joined_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "CoalitionMember":
        return cls(
            agent_id=data["agent_id"],
            role=data["role"],
            joined_at=datetime.fromisoformat(data["joined_at"]),
        )


@dataclass
class Coalition:
    """
    联盟

    属性：
        id: 唯一标识符
        goal: 联盟目标
        members: 成员 Agent ID 列表
        leader: 协调者 ID
        lifetime: 生存周期（秒）
        status: 状态
        created_at: 创建时间
    """

    goal: str
    members: List[CoalitionMember]
    leader: str
    lifetime: int = 3600  # 默认 1 小时
    status: CoalitionStatus = CoalitionStatus.FORMING
    id: str = field(default_factory=lambda: f"coal_{uuid.uuid4().hex[:12]}")
    created_at: datetime = field(default_factory=datetime.now)

    # 可选元数据
    name: Optional[str] = None
    description: Optional[str] = None
    dissolved_reason: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "goal": self.goal,
            "members": [m.to_dict() for m in self.members],
            "leader": self.leader,
            "lifetime": self.lifetime,
            "status": self.status.value,
            "dissolved_reason": self.dissolved_reason,
            "created_at": self.created_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Coalition":
        return cls(
            id=data["id"],
            name=data.get("name"),
            description=data.get("description"),
            goal=data["goal"],
            members=[CoalitionMember.from_dict(m) for m in data["members"]],
            leader=data["leader"],
            lifetime=data.get("lifetime", 3600),
            status=CoalitionStatus(data.get("status", "forming")),
            dissolved_reason=data.get("dissolved_reason"),
            created_at=datetime.fromisoformat(data["created_at"]),
        )

    def is_expired(self) -> bool:
        """检查是否过期"""
        elapsed = (datetime.now() - self.created_at).total_seconds()
        return elapsed > self.lifetime

    def dissolve(self, reason: str = None) -> None:
        """解散联盟"""
        self.status = CoalitionStatus.DISSOLVED
        self.dissolved_reason = reason or "任务完成或超时"

    def add_member(self, agent_id: str, role: str = "member") -> None:
        """添加成员"""
        self.members.append(CoalitionMember(agent_id=agent_id, role=role))

    def remove_member(self, agent_id: str) -> bool:
        """移除成员"""
        for i, m in enumerate(self.members):
            if m.agent_id == agent_id:
                self.members.pop(i)
                return True
        return False
