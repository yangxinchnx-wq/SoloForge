# -*- coding: utf-8 -*-
"""
SoloForge AI Society - 数据模型

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  AI 社会专用数据结构 ⚠️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

本模块定义的所有数据模型仅供 AI 社会模块使用，
存储在 SQLite 数据库中，与主项目 SurrealDB 隔离。

数据存储对应：
- Institution/Governance     → SQLite: institution, governance 表
- Reputation                 → SQLite: reputation 表
- Culture                    → SQLite: culture 表
- Economy                    → SQLite: economy 表
- Law                        → SQLite: law, law_violation 表
- Coalition                  → SQLite: coalition 表
- Social Memory              → SQLite + LanceDB（向量）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

from .institution import Institution, InstitutionScope, EnforcementType
from .governance import Governance, GovernanceRecord
from .social_memory import SocialMemory, MemorySeverity, MemoryImpact
from .reputation import Reputation, ReputationRecord, EntityType
from .culture import Culture, CultureRecord
from .economy import Economy, EconomyRecord, CreditTransaction
from .law import Law, LawViolation, LawSeverity
from .coalition import Coalition, CoalitionStatus, CoalitionMember

__all__ = [
    "Institution",
    "InstitutionScope",
    "EnforcementType",
    "Governance",
    "GovernanceRecord",
    "SocialMemory",
    "MemorySeverity",
    "MemoryImpact",
    "Reputation",
    "ReputationRecord",
    "EntityType",
    "Culture",
    "CultureRecord",
    "Economy",
    "EconomyRecord",
    "CreditTransaction",
    "Law",
    "LawViolation",
    "LawSeverity",
    "Coalition",
    "CoalitionStatus",
    "CoalitionMember",
]
