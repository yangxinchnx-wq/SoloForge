# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Transaction (transaction model)

Records credit and reputation changes. Forms an append-only ledger
that the system replays to compute balances and reputation scores.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional
import uuid


class TxType(Enum):
    """Transaction type"""
    TASK_REWARD = "task_reward"
    TASK_PENALTY = "task_penalty"
    TRANSFER = "transfer"
    TEACHING_BONUS = "teaching_bonus"
    COORDINATION_REWARD = "coordination_reward"
    REVIEW_BONUS = "review_bonus"
    SYSTEM_GRANT = "system_grant"
    REFUND = "refund"



@dataclass
class Transaction:
    """A single credit/reputation ledger entry."""
    tx_type: TxType
    from_id: Optional[str]
    to_id: str
    credit_delta: float = 0.0
    reputation_delta: float = 0.0
    memo: str = ""
    task_id: Optional[str] = None
    id: str = field(default_factory=lambda: f"tx_{uuid.uuid4().hex[:12]}")
    timestamp: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "tx_type": self.tx_type.value,
            "from_id": self.from_id,
            "to_id": self.to_id,
            "credit_delta": self.credit_delta,
            "reputation_delta": self.reputation_delta,
            "memo": self.memo,
            "task_id": self.task_id,
            "timestamp": self.timestamp.isoformat(),
        }

    @classmethod
    def from_dict(cls, data) -> "Transaction":
        return cls(
            id=data["id"],
            tx_type=TxType(data["tx_type"]),
            from_id=data.get("from_id"),
            to_id=data["to_id"],
            credit_delta=data.get("credit_delta", 0.0),
            reputation_delta=data.get("reputation_delta", 0.0),
            memo=data.get("memo", ""),
            task_id=data.get("task_id"),
            timestamp=datetime.fromisoformat(data["timestamp"]),
        )


__all__ = ["TxType", "Transaction"]
