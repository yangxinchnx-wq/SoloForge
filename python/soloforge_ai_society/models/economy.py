# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Economy（经济系统）

经济系统控制资源分配和信用分管理。
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional
import uuid


@dataclass
class Economy:
    """
    经济账户

    属性：
        id: 唯一标识符
        agent_id: Agent ID
        credits: 当前信用分
        balance: 余额
        spending: 消费明细
        income: 收入明细
        created_at: 创建时间
        updated_at: 更新时间
    """

    agent_id: str
    credits: float = 1000.0
    balance: float = 0.0
    spending: Dict[str, float] = field(default_factory=dict)
    income: Dict[str, float] = field(default_factory=dict)
    id: str = field(default_factory=lambda: f"econ_{uuid.uuid4().hex[:12]}")
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)

    # 可选元数据
    name: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "agent_id": self.agent_id,
            "credits": self.credits,
            "balance": self.balance,
            "spending": self.spending,
            "income": self.income,
            "name": self.name,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Economy":
        return cls(
            id=data["id"],
            agent_id=data["agent_id"],
            credits=data.get("credits", 1000.0),
            balance=data.get("balance", 0.0),
            spending=data.get("spending", {}),
            income=data.get("income", {}),
            name=data.get("name"),
            created_at=datetime.fromisoformat(data["created_at"]),
            updated_at=datetime.fromisoformat(data["updated_at"]),
        )


@dataclass
class CreditTransaction:
    """
    信用交易记录
    """

    economy_id: str
    amount: float
    transaction_type: str  # "credit" | "debit"
    category: str  # 交易类别
    description: Optional[str] = None
    id: str = field(default_factory=lambda: f"trans_{uuid.uuid4().hex[:12]}")
    created_at: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "economy_id": self.economy_id,
            "amount": self.amount,
            "transaction_type": self.transaction_type,
            "category": self.category,
            "description": self.description,
            "created_at": self.created_at.isoformat(),
        }


@dataclass
class EconomyRecord:
    """
    经济系统日志
    """

    agent_id: str
    event: str
    credits_change: float
    reason: str
    id: str = field(default_factory=lambda: f"econe_{uuid.uuid4().hex[:12]}")
    created_at: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "agent_id": self.agent_id,
            "event": self.event,
            "credits_change": self.credits_change,
            "reason": self.reason,
            "created_at": self.created_at.isoformat(),
        }


# 资源成本定义
RESOURCE_COSTS = {
    "claude_sonnet": 50,      # credits
    "claude_haiku": 10,
    "gpt4o": 40,
    "qwen": 10,
    "deepseek": 5,
    "local_model": 2,
    "complex_task": 30,
    "simple_task": 5,
}

# 收入定义
TASK_REWARDS = {
    "task_completion": 10,
    "help_other_agent": 5,
    "provide_lesson": 3,
    "quality_review": 8,
}
