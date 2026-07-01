# SoloForge AI Society - Python Module

## ⚠️ AI 社会专用模块 - 与主项目数据库隔离 ⚠️

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SoloForge 数据隔离架构                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   主项目（TypeScript/Node.js）                                              │
│   ├── SurrealDB (surrealkv://)  ← 决策、仲裁、审计、事件日志             │
│   │                                                                          │
│   └── AI 社会（Python）        ← 本模块                                     │
│       ├── SQLite (ai_society.db)     ← 制度/信誉/经济/法律/联盟            │
│       └── LanceDB (social_memory)    ← 社会记忆向量搜索                    │
│                                                                             │
│   隔离原则：                                                                 │
│   • AI 社会数据库禁止被主项目直接访问                                       │
│   • 主项目通过 IPC 通信获取数据                                             │
│   • 数据存储路径独立：data/ai_society/                                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 技术栈

| 组件 | 版本 | 说明 |
|------|------|------|
| Python | **3.13.14** | AI 工具链、向量处理 |
| SQLite | 内置 | 结构化数据存储 |
| LanceDB | >= 0.10.0 | 向量数据库 |
| NumPy | >= 1.26.0 | 数值计算 |

## 目录结构

```
python/
├── soloforge_ai_society/      # AI 社会核心包
│   ├── __init__.py
│   ├── config.py              # 配置管理
│   ├── database/              # 数据库管理
│   │   └── manager.py         # SQLite + LanceDB 管理
│   ├── models/                # 数据模型
│   │   ├── institution.py     # 制度系统
│   │   ├── governance.py      # 治理层
│   │   ├── social_memory.py   # 社会记忆
│   │   ├── reputation.py      # 社会信誉
│   │   ├── culture.py         # 文化规范
│   │   ├── economy.py         # 经济系统
│   │   ├── law.py             # 法律引擎
│   │   └── coalition.py       # 联盟机制
│   ├── services/              # 业务服务
│   │   ├── memory_service.py  # 社会记忆服务
│   │   ├── reputation_service.py
│   │   ├── governance_service.py
│   │   ├── economy_service.py
│   │   ├── law_service.py
│   │   └── coalition_service.py
│   └── vector/                # 向量处理
│       ├── embedder.py        # TF-IDF 向量生成
│       └── search.py          # 向量搜索
├── tests/                     # 测试
├── pyproject.toml            # 项目配置
└── requirements.txt          # 依赖
```

## 安装

```bash
# 创建虚拟环境（Python 3.13.14）
python3.13 -m venv venv
source venv/bin/activate  # Linux/Mac
# 或
.\venv\Scripts\activate  # Windows

# 安装依赖
pip install -r requirements.txt
```

## 使用示例

```python
from soloforge_ai_society.config import AISocietyConfig
from soloforge_ai_society.database.manager import DatabaseManager
from soloforge_ai_society.services.memory_service import MemoryService
from soloforge_ai_society.services.reputation_service import ReputationService
from soloforge_ai_society.vector.factory import get_embedder

# 配置
config = AISocietyConfig(data_dir="./data/ai_society")

# 初始化数据库
db = DatabaseManager(config)
db.initialize()

# 初始化服务 (工厂默认 MiniLM 384-dim, fallback Heuristic)
embedder = get_embedder()

memory_service = MemoryService(db, embedder)
reputation_service = ReputationService(db)

# 创建社会记忆
memory = memory_service.create(
    event="文件删除导致数据丢失",
    impact="negative",
    severity="critical",
    participants=["Agent1", "Agent2"],
    lessons=["删除前检查两次", "启用沙箱"],
)

# 搜索相似记忆
results = memory_service.search("文件问题", top_k=5)

# 创建信誉记录
rep = reputation_service.create(
    entity_id="test_agent",
    entity_type="agent",
    name="测试 Agent",
)

# 更新信誉分
reputation_service.update_score(
    entity_id="test_agent",
    entity_type="agent",
    delta=-0.1,
    reason="任务失败",
    source="task_completion",
)

# 关闭
db.close()
```

## AI 社会模块

### 1. Institution（制度系统）
定义 AI 社会的规则体系，包括代码审查、安全策略等。

### 2. Governance（治理层）
制度的执行与评估，确保制度被遵守。

### 3. Social Memory（社会记忆）
多智能体集体经历的记忆，支持向量语义搜索。

### 4. Reputation（社会信誉）
Agent/Plugin/Tool 的信任评分体系。

### 5. Culture（文化规范）
群体习惯形成的文化规范。

### 6. Economy（经济系统）
信用分和资源配额管理。

### 7. Law（法律引擎）
违规检测和处罚执行。

### 8. Coalition（联盟机制）
临时组队协作完成复杂任务。

## 运行测试

```bash
pytest tests/ -v
```

## 数据存储

- **SQLite**: Institution/Governance/Reputation/Culture/Economy/Law/Coalition
- **LanceDB**: Social Memory 向量数据

> 注意：AI 社会数据库与主项目 SurrealDB 完全分离，仅供 AI 社会模块使用。

## DuckDB OLAP 分析层 (2026-07-02)

AI Society 5 层数据栈中的 L5（OLAP）—— 训练数据准备 + 离线聚合查询。

```
L1 OLTP   → SQLite  (P6 WAL+mmap, 200KB)   ← 写入主库
L2 向量   → Qdrant 6333 (MiniLM 384d)      ← 语义检索
L3 缓存   → Garnet 6379                    ← 读加速 106x
L4 冷数据 → JSONL                          ← 不可变审计
L5 OLAP   → DuckDB  (本节)                 ← 训练数据准备 + 聚合
```

**走嵌入式二进制**（`bin/duckdb/duckdb.exe` v1.5.4），不依赖 `pip install duckdb`。

### 快速使用

```python
from soloforge_ai_society.services.analytics import AnalyticsService

svc = AnalyticsService()

# 1) 跑内置聚合查询（直接 ATTACH SQLite，无副本）
print(svc.run_analytics("memory_table_counts"))  # 13 张表行数
print(svc.run_analytics("top_institutions"))     # Top 机构 by 信誉

# 2) 抽 SQLite 业务表 → 独立 .duckdb 文件（训练数据准备）
r = svc.export_snapshot("data/ai_society/analytics/canary.duckdb")
# r = {"out_path": "...", "tables_exported": [...], "total_rows": 20, "elapsed_s": 4.11}

# 3) 导出 Parquet 给训练脚本 (pandas/polars 直接读)
r = svc.export_to_parquet("data/ai_society/analytics/canary_parquet")
# r = {"out_dir": "...", "files": [{"table": "culture", "path": ".../culture.parquet", "size_bytes": 1757}, ...]}
```

### 训练脚本侧（pandas 读 Parquet）

```python
import pandas as pd
events = pd.read_parquet("data/ai_society/analytics/canary_parquet/event.parquet")
memory = pd.read_parquet("data/ai_society/analytics/canary_parquet/social_memory.parquet")
# 直接喂给 RL trainer，不需要 DuckDB Python 库
```

### 内置查询模板

| 名称 | 用途 |
|------|------|
| `memory_table_counts` | 13 张业务表行数概览 |
| `governance_summary` | 治理记录按 action_taken 聚合 |
| `top_institutions` | Top 机构 by 信誉分 |
| `law_violation_by_type` | 法律违规按 status 聚合 |

### 端到端测试

```bash
python -m pytest tests/test_analytics.py -v
# 15 passed in ~12s
```
