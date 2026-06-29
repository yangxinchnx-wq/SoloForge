# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Task (task model)

Tasks are the most basic unit of social collaboration.
Agents earn credits and reputation by completing tasks.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import List, Optional
import uuid


class TaskType(Enum):
    """Task type"""
    CHAT = "chat"
    CODE = "code"
    RESEARCH = "research"
    CREATIVE = "creative"
    REVIEW = "review"
    TEACH = "teach"
    COORDINATE = "coordinate"


class TaskStatus(Enum):
    """Task status"""
    PENDING = "pending"
    ASSIGNED = "assigned"
    IN_PROGRESS = "in_progress"
    SUBMITTED = "submitted"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class TaskSubmission:
    """A single submission for a task (multi-version possible)"""
    submitter_id: str
    content: str
    submitted_at: datetime = field(default_factory=datetime.now)
    score: Optional[float] = None
    feedback: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "submitter_id": self.submitter_id,
            "content": self.content,
            "submitted_at": self.submitted_at.isoformat(),
            "score": self.score,
            "feedback": self.feedback,
        }

    @classmethod
    def from_dict(cls, data) -> "TaskSubmission":
        return cls(
            submitter_id=data["submitter_id"],
            content=data["content"],
            submitted_at=datetime.fromisoformat(data["submitted_at"]),
            score=data.get("score"),
            feedback=data.get("feedback"),
        )



@dataclass
class Task:
    """Task"""
    title: str
    description: str
    task_type: TaskType
    difficulty: int = 5
    reward: float = 10.0
    requester_id: Optional[str] = None
    assignee_id: Optional[str] = None
    submissions: List[TaskSubmission] = field(default_factory=list)
    status: TaskStatus = TaskStatus.PENDING
    deadline: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    tags: List[str] = field(default_factory=list)
    id: str = field(default_factory=lambda: f"task_{uuid.uuid4().hex[:12]}")
    created_at: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "task_type": self.task_type.value,
            "difficulty": self.difficulty,
            "reward": self.reward,
            "requester_id": self.requester_id,
            "assignee_id": self.assignee_id,
            "submissions": [s.to_dict() for s in self.submissions],
            "status": self.status.value,
            "deadline": self.deadline.isoformat() if self.deadline else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "tags": self.tags,
            "created_at": self.created_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data) -> "Task":
        return cls(
            id=data["id"],
            title=data["title"],
            description=data["description"],
            task_type=TaskType(data["task_type"]),
            difficulty=data.get("difficulty", 5),
            reward=data.get("reward", 10.0),
            requester_id=data.get("requester_id"),
            assignee_id=data.get("assignee_id"),
            submissions=[TaskSubmission.from_dict(s) for s in data.get("submissions", [])],
            status=TaskStatus(data.get("status", "pending")),
            deadline=datetime.fromisoformat(data["deadline"]) if data.get("deadline") else None,
            completed_at=datetime.fromisoformat(data["completed_at"]) if data.get("completed_at") else None,
            tags=data.get("tags", []),
            created_at=datetime.fromisoformat(data["created_at"]),
        )



    def assign(self, agent_id: str) -> None:
        self.assignee_id = agent_id
        self.status = TaskStatus.ASSIGNED

    def submit(self, submitter_id: str, content: str) -> TaskSubmission:
        sub = TaskSubmission(submitter_id=submitter_id, content=content)
        self.submissions.append(sub)
        self.status = TaskStatus.SUBMITTED
        return sub

    def complete(self, score=None, feedback=None) -> None:
        if self.submissions:
            self.submissions[-1].score = score
            self.submissions[-1].feedback = feedback
        self.status = TaskStatus.COMPLETED
        self.completed_at = datetime.now()

    def fail(self, reason: str = "") -> None:
        self.status = TaskStatus.FAILED
        if reason and self.submissions:
            self.submissions[-1].feedback = reason

    def cancel(self) -> None:
        self.status = TaskStatus.CANCELLED


__all__ = ["TaskType", "TaskStatus", "TaskSubmission", "Task"]
