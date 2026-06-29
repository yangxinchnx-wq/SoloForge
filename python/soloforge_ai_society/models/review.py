# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Review

A peer or coordinator review of a task submission. Reviews feed
the reputation system and can trigger escalation.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import List, Optional
import uuid


class ReviewDecision(Enum):
    """Review verdict"""
    APPROVE = "approve"
    REQUEST_CHANGES = "request_changes"
    REJECT = "reject"
    ESCALATE = "escalate"


class ReviewSeverity(Enum):
    """Severity of issues identified"""
    NONE = "none"
    MINOR = "minor"
    MAJOR = "major"
    BLOCKER = "blocker"


@dataclass
class ReviewIssue:
    """A single issue raised in a review"""
    description: str
    severity: ReviewSeverity = ReviewSeverity.MINOR
    suggestion: str = ""

    def to_dict(self) -> dict:
        return {
            "description": self.description,
            "severity": self.severity.value,
            "suggestion": self.suggestion,
        }

    @classmethod
    def from_dict(cls, data) -> "ReviewIssue":
        return cls(
            description=data["description"],
            severity=ReviewSeverity(data.get("severity", "minor")),
            suggestion=data.get("suggestion", ""),
        )



@dataclass
class Review:
    """A peer/coordinator review of a submission"""
    submission_id: str
    task_id: str
    reviewer_id: str
    reviewee_id: str
    decision: ReviewDecision = ReviewDecision.APPROVE
    score: float = 1.0
    issues: List[ReviewIssue] = field(default_factory=list)
    comment: str = ""
    created_at: datetime = field(default_factory=datetime.now)
    id: str = field(default_factory=lambda: f"rev_{uuid.uuid4().hex[:12]}")

    def has_blockers(self) -> bool:
        return any(i.severity == ReviewSeverity.BLOCKER for i in self.issues)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "submission_id": self.submission_id,
            "task_id": self.task_id,
            "reviewer_id": self.reviewer_id,
            "reviewee_id": self.reviewee_id,
            "decision": self.decision.value,
            "score": self.score,
            "issues": [i.to_dict() for i in self.issues],
            "comment": self.comment,
            "created_at": self.created_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data) -> "Review":
        return cls(
            id=data["id"],
            submission_id=data["submission_id"],
            task_id=data["task_id"],
            reviewer_id=data["reviewer_id"],
            reviewee_id=data["reviewee_id"],
            decision=ReviewDecision(data.get("decision", "approve")),
            score=data.get("score", 1.0),
            issues=[ReviewIssue.from_dict(i) for i in data.get("issues", [])],
            comment=data.get("comment", ""),
            created_at=datetime.fromisoformat(data["created_at"]),
        )


__all__ = [
    "ReviewDecision",
    "ReviewSeverity",
    "ReviewIssue",
    "Review",
]
