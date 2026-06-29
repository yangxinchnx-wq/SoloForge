# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Message

Inter-agent communication envelope. Messages are stored in a
message bus / log; they drive async coordination between agents.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional, Dict, Any
import uuid


class MessageType(Enum):
    """Message category"""
    REQUEST = "request"
    RESPONSE = "response"
    NOTIFICATION = "notification"
    BROADCAST = "broadcast"
    TASK_ASSIGNED = "task_assigned"
    TASK_SUBMITTED = "task_submitted"
    TASK_COMPLETED = "task_completed"
    REVIEW_REQUESTED = "review_requested"
    REVIEW_SUBMITTED = "review_submitted"
    HELP_REQUEST = "help_request"
    HELP_OFFER = "help_offer"
    ESCALATION = "escalation"


class MessagePriority(Enum):
    """Priority / urgency"""
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    URGENT = "urgent"


@dataclass
class Message:
    """An inter-agent message."""
    from_id: str
    to_id: str
    content: str
    msg_type: MessageType = MessageType.NOTIFICATION
    priority: MessagePriority = MessagePriority.NORMAL
    topic: str = ""
    task_id: Optional[str] = None
    correlation_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    id: str = field(default_factory=lambda: f"msg_{uuid.uuid4().hex[:12]}")
    timestamp: datetime = field(default_factory=datetime.now)
    read: bool = False

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "from_id": self.from_id,
            "to_id": self.to_id,
            "content": self.content,
            "msg_type": self.msg_type.value,
            "priority": self.priority.value,
            "topic": self.topic,
            "task_id": self.task_id,
            "correlation_id": self.correlation_id,
            "metadata": dict(self.metadata) if self.metadata else {},
            "timestamp": self.timestamp.isoformat(),
            "read": self.read,
        }

    @classmethod
    def from_dict(cls, data) -> "Message":
        return cls(
            id=data["id"],
            from_id=data["from_id"],
            to_id=data["to_id"],
            content=data["content"],
            msg_type=MessageType(data.get("msg_type", "notification")),
            priority=MessagePriority(data.get("priority", "normal")),
            topic=data.get("topic", ""),
            task_id=data.get("task_id"),
            correlation_id=data.get("correlation_id"),
            metadata=data.get("metadata", {}) or {},
            timestamp=datetime.fromisoformat(data["timestamp"]),
            read=data.get("read", False),
        )


__all__ = ["MessageType", "MessagePriority", "Message"]
