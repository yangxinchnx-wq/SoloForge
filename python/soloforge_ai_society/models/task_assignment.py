# -*- coding: utf-8 -*-
"""
SoloForge AI Society - TaskAssignment

Represents a task assignment event from a Coordinator/Manager agent
to a Worker agent. Includes the assignment logic outcome (which
candidate was picked and why).
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import List, Optional, Dict, Any
import uuid


class AssignmentStrategy(Enum):
    """How a task was assigned"""
    MANUAL = "manual"
    AUTO_BEST_FIT = "auto_best_fit"
    AUTO_ROTATION = "auto_rotation"
    AUCTION = "auction"
    VOLUNTEER = "volunteer"


class AssignmentStatus(Enum):
    """Lifecycle of an assignment"""
    PROPOSED = "proposed"
    ACCEPTED = "accepted"
    DECLINED = "declined"
    REVOKED = "revoked"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class CandidateScore:
    """Score for one candidate during assignment"""
    agent_id: str
    skill_match: float = 0.0
    availability: float = 0.0
    reputation: float = 0.0
    cost: float = 0.0
    total_score: float = 0.0
    notes: str = ""

    def to_dict(self) -> dict:
        return {
            "agent_id": self.agent_id,
            "skill_match": self.skill_match,
            "availability": self.availability,
            "reputation": self.reputation,
            "cost": self.cost,
            "total_score": self.total_score,
            "notes": self.notes,
        }

    @classmethod
    def from_dict(cls, data) -> "CandidateScore":
        return cls(**data)



@dataclass
class TaskAssignment:
    """A task assignment event"""
    task_id: str
    coordinator_id: str
    candidates: List[CandidateScore] = field(default_factory=list)
    chosen_agent_id: Optional[str] = None
    strategy: AssignmentStrategy = AssignmentStrategy.AUTO_BEST_FIT
    status: AssignmentStatus = AssignmentStatus.PROPOSED
    rationale: str = ""
    created_at: datetime = field(default_factory=datetime.now)
    accepted_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    id: str = field(default_factory=lambda: f"asgn_{uuid.uuid4().hex[:12]}")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "task_id": self.task_id,
            "coordinator_id": self.coordinator_id,
            "candidates": [c.to_dict() for c in self.candidates],
            "chosen_agent_id": self.chosen_agent_id,
            "strategy": self.strategy.value,
            "status": self.status.value,
            "rationale": self.rationale,
            "created_at": self.created_at.isoformat(),
            "accepted_at": self.accepted_at.isoformat() if self.accepted_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
        }

    @classmethod
    def from_dict(cls, data) -> "TaskAssignment":
        return cls(
            id=data["id"],
            task_id=data["task_id"],
            coordinator_id=data["coordinator_id"],
            candidates=[CandidateScore.from_dict(c) for c in data.get("candidates", [])],
            chosen_agent_id=data.get("chosen_agent_id"),
            strategy=AssignmentStrategy(data.get("strategy", "auto_best_fit")),
            status=AssignmentStatus(data.get("status", "proposed")),
            rationale=data.get("rationale", ""),
            created_at=datetime.fromisoformat(data["created_at"]),
            accepted_at=datetime.fromisoformat(data["accepted_at"]) if data.get("accepted_at") else None,
            completed_at=datetime.fromisoformat(data["completed_at"]) if data.get("completed_at") else None,
        )


__all__ = ["AssignmentStrategy", "AssignmentStatus", "CandidateScore", "TaskAssignment"]
