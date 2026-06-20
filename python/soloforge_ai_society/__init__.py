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
__python_version__ = ">=3.13"

from .config import AISocietyConfig, get_config, set_config
from .database.manager import DatabaseManager
from .database.health import HealthChecker, HealthStatus, BackupManager, BackupInfo
from .database.pool import ConnectionPool
from .database.migration import run_migrations, get_migration_status
from .services.memory_service import MemoryService
from .services.reputation_service import ReputationService
from .services.governance_service import GovernanceService
from .services.economy_service import EconomyService
from .services.law_service import LawService
from .services.coalition_service import CoalitionService
from .services.reputation_sync_receiver import ReputationSyncReceiver
from .vector.embedder import TFIDFEmbedder, get_embedder
from .vector.search import VectorSearch

__all__ = [
    # Config
    "AISocietyConfig",
    "get_config",
    "set_config",
    # Database
    "DatabaseManager",
    "ConnectionPool",
    "HealthChecker",
    "HealthStatus",
    "BackupManager",
    "BackupInfo",
    "run_migrations",
    "get_migration_status",
    # Services
    "MemoryService",
    "ReputationService",
    "GovernanceService",
    "EconomyService",
    "LawService",
    "CoalitionService",
    "ReputationSyncReceiver",
    # Vector
    "TFIDFEmbedder",
    "get_embedder",
    "VectorSearch",
]
