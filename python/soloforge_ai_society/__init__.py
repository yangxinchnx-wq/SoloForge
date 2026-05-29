# -*- coding: utf-8 -*-
"""
SoloForge AI Society - AI 社会核心模块

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  AI 社会专用模块 ⚠️  与主项目数据库完全隔离
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

提供多智能体社会体系的核心功能：
- Institution（制度系统）
- Governance（治理层）
- Social Memory（社会记忆 - 向量搜索）
- Reputation（社会信誉）
- Culture（文化规范）
- Economy（经济系统）
- Law（法律引擎）
- Coalition（联盟机制）

┌─────────────────────────────────────────────────────────────────────────────┐
│  数据隔离架构（与主项目 SurrealDB 完全分开）                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   主项目（TypeScript/Node.js）                                              │
│   ├── SurrealDB (surrealkv://)  ← 决策、仲裁、审计、事件日志             │
│   │                                                                          │
│   └── AI 社会（Python）        ← 本模块                                     │
│       ├── SQLite (ai_society.db)     ← 制度/信誉/经济/法律/联盟            │
│       └── LanceDB (social_memory)    ← 社会记忆向量搜索                    │
│                                                                             │
│   通信方式：Node.js ↔ Python IPC（Stdin/Stdout 或 HTTP）                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

技术选型：
- SQLite：嵌入式 OLTP，零配置，高可靠
- LanceDB：嵌入式向量数据库，语义搜索
- Python：3.12.10

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

__version__ = "1.0.0"
__python_version__ = ">=3.12"

from .database.manager import DatabaseManager
from .services.memory_service import MemoryService
from .services.reputation_service import ReputationService
from .services.governance_service import GovernanceService
from .services.economy_service import EconomyService
from .services.law_service import LawService
from .services.coalition_service import CoalitionService

__all__ = [
    "DatabaseManager",
    "MemoryService",
    "ReputationService",
    "GovernanceService",
    "EconomyService",
    "LawService",
    "CoalitionService",
]
