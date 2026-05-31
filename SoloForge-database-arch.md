# SoloForge 全数据库架构文档

> 最后更新：2026-05-31
> 适用范围：AI / Agent / LLM 上下文加载用，非人类阅读型文档

---

## 总览

SoloForge 共运行 4 个数据库，分成两个完全隔离的子系统，通过 Node.js ↔ Python IPC（MessagePack，端口 27017）连接：

```
主项目层 (Node.js)              AI 社会层 (Python)
────────────────────────────    ────────────────────────────────
① Garnet   → 热数据/内存缓存    ③ SQLite   → 结构化业务数据
② SurrealDB → 持久化业务数据     ④ LanceDB  → 向量记忆检索
+ JSONL     → 冷数据归档

隔离规则：AI 社会数据库禁止主项目直接访问，仅通过 IPC 通信。
```

---

## ① Garnet（主项目热数据层）

| 字段 | 值 |
|------|----|
| 类型 | Garnet（微软自研，Redis 协议 100% 兼容） |
| 版本 | v1.1.10 |
| 运行方式 | 独立后台进程 |
| 监听端口 | TCP 6379 |
| 可执行文件 | `bin/garnet/portable/net10.0/GarnetServer.exe` |
| 配置文件 | `bin/garnet/portable/net10.0/garnet.conf` |
| 启动命令 | `.\bin\garnet\portable\net10.0\GarnetServer.exe --lua --lua-script-timeout 5000 --port 6379` |
| Node.js 客户端 | `ioredis@5.11.0` (通过 Redis 协议连接) |

**职责：**
- Session Context（会话上下文）
- Task State（任务运行态）
- 消息队列
- 实时状态缓存
- 其他需要高性能读写的热数据

**特点：**
- 内存数据库，关机前需持久化或视为可丢失
- 比 Redis 快 2-10x（微软基准测试）
- 原生支持 Windows

---

## ② SurrealDB（主项目持久数据层）

| 字段 | 值 |
|------|----|
| 类型 | SurrealDB（多模型：文档 + 图 + 关系） |
| JS SDK 版本 | `surrealdb@2.0.3` |
| 嵌入式引擎 | `@surrealdb/node@3.0.3` |
| 运行方式 | 嵌入式（直接 runspace in Node.js 进程，无网络 RPC） |
| 存储引擎 | RocksDB（通过 `rocksdb://` 协议直连本地文件） |
| 连接协议 | `rocksdb://data/soloforge_db` |
| 数据目录 | `data/soloforge_db/`（内含 `.log`、`.sst`、`MANIFEST`、`CURRENT` 等） |
| Namespace | `soloforge_core` |
| Database | `autonomous_network` |
| 迁移脚本目录 | `migrations/`（共 6 个 `.surql` 文件） |
| 迁移命令 | `npm run db:migrate` / `db:status` / `db:rollback` |

**职责：**
- 决策链路（decision）：RACER 引擎输出的决策记录，完整可回放
- 法庭治理（court）：提交裁决、仲裁卷宗、盲审 + LLM 终审
- MARL 遥测：强化学习训练的数据快照
- 事件审计（events）：trace_id 全链路追溯

**迁移版本线：**
```
v1_base_schema   → 基础表结构
v2_decision_chain → 决策链路
v3_court_governance → 法庭治理
v4_governor_marl → MARL 训练策略
v5_event_audit → 事件审计
init_baseline → 202605281200 基线迁移
```

**性能特征：**
- 嵌入式模式比 WebSocket RPC 快 10-50x（项目 README 数据）
- 支持 SurrealQL（类 SQL + 图查询融合语法）
- 事务支持：`BEGIN TRANSACTION` / `COMMIT` / `CANCEL TRANSACTION`

---

## ③ SQLite（AI 社会结构化数据层）

| 字段 | 值 |
|------|----|
| 类型 | SQLite（嵌入式关系型数据库） |
| 版本 | Python 内置 `sqlite3` |
| 数据文件 | `python/data/ai_society/ai_society.db` |
| 连接池 | Python `ConnectionPool`，最多 5 连接，30s 超时 |
| WAL 模式 | 已启用，自动 checkpoint 每 5 分钟 |

**职责：** AI 社会所有结构化业务数据

**表结构：**

| 表名 | AI 社会层级 | 主键 | 关键字段 |
|------|------------|------|---------|
| `institution` | 制度系统 | `id TEXT` | `name`, `rules`, `scope`(global/agent/task/domain), `enforcement`(hard/soft/advisory), `priority` |
| `governance` | 治理层 | `id TEXT` | `institution_id` → FK, `owner`, `effectiveness` (0-1), `violations`, `last_review` |
| `reputation` | 社会信誉 | `id TEXT` | `entity_id`, `entity_type`(agent/plugin/mcp/tool), `score` (0-1), `evidence`, `history` |
| `culture` | 文化规范 | `id TEXT` | `principle`(唯一), `adoption_rate` (0-1), `target_rate`, `evidence` |
| `economy` | 经济系统 | `id TEXT` | `agent_id`(唯一), `credits`, `balance`, `spending`, `income` |
| `law` | 法律/规则 | `id TEXT` | 法条定义、违规判定规则 |
| `coalition` | 联盟/角色进化 | `id TEXT` | Agent 联盟、角色进化记录 |

**Preset 表初始化：**
- 预置制度：`CodeInstitution`、`ResearchInstitution`、`SecurityInstitution`
- 预置文化：`Review 优先`(95%)、`证据优先`(90%)、`不要猜`(85%)、`可恢复优先`(95%)

---

## ④ LanceDB（AI 社会向量记忆层）

| 字段 | 值 |
|------|----|
| 类型 | LanceDB（嵌入式列式向量数据库） |
| Python SDK 版本 | `lancedb>=0.12.0` |
| 底层依赖 | `pyarrow>=14.0.0` |
| 数据文件 | `python/data/ai_society/social_memory.lance/` |
| 向量化方式 | TF-IDF Embedder，维度 128 |
| 检索方式 | 向量余弦相似度语义搜索 |

**职责：** 存储和检索 Social Memory（社会记忆），支持语义相似度搜索

**`social_memory` 表 schema：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | STRING | 记忆 ID，如 `mem_001` |
| `event` | STRING | 事件描述文本 |
| `vector` | FLOAT32[128] | TF-IDF 向量化结果（维度 128） |
| `impact` | STRING | `positive` / `negative` / `neutral` |
| `severity` | STRING | `low` / `medium` / `high` / `critical` |
| `lessons` | STRING | 经验教训（逗号分隔） |
| `created_at` | INT64 | 毫秒时间戳 |

**过滤支持：** `severity_filter`（如 `["critical"]`）

---

## ⑤ JSONL（主项目冷数据归档）

| 字段 | 值 |
|------|----|
| 格式 | JSONL（每行一个 JSON 对象） |
| 数据目录 | `data/jsonl/` |

**职责：**
- 事件归档（已落盘的审计日志）
- 历史留存，不参与实时查询

---

## 文件路径索引

```
SoloForge/
├── bin/garnet/portable/net10.0/        ← ① Garnet 程序本体
│   ├── GarnetServer.exe
│   └── garnet.conf
│
├── data/
│   ├── soloforge_db/                   ← ② SurrealDB 数据文件（RocksDB）
│   │   ├── *.log
│   │   ├── *.sst
│   │   └── MANIFEST, CURRENT, LOCK, ...
│   │
│   └── jsonl/                          ← ⑤ JSONL 归档
│
├── migrations/                         ← SurrealDB 迁移脚本
│   ├── v1_base_schema_migrations.surql
│   ├── v2_decision_chain.surql
│   ├── v3_court_governance.surql
│   ├── v4_governor_marl.surql
│   ├── v5_event_audit.surql
│   └── 202605281200__init_baseline.surql
│
├── scripts/
│   ├── db-common.ts                    ← SurrealDB 嵌入式连接 + 迁移公共模块
│   ├── db-migrate.ts                   ← 迁移执行器（幂等，支持回滚）
│   ├── db-status.ts                    ← 迁移状态查看
│   └── db-rollback.ts                  ← 迁移回滚
│
├── src/data/
│   ├── surreal_persistence.ts          ← SurrealDB Repository 层
│   ├── surreal_driver_live.ts          ← 数据库实时驱动
│   ├── delete_protection.ts            ← 数据删除保护
│   └── transaction_kernel.ts           ← 事务内核
│
└── python/
    ├── data/ai_society/                ← ③④ AI 社会数据目录
    │   ├── ai_society.db               ← ③ SQLite 数据文件
    │   └── social_memory.lance/        ← ④ LanceDB 向量数据
    │
    └── soloforge_ai_society/
        ├── config.py                   ← 数据目录/向量维度/阈值配置
        ├── database/
        │   ├── manager.py              ← 统一管理器（SQLite + LanceDB）
        │   ├── pool.py                 ← SQLite 连接池（ThreadLocal，5连接，30s超时）
        │   ├── migration.py            ← SQLite Schema 版本管理
        │   └── health.py              ← 健康检查 & 自动备份
        └── vector/
            ├── embedder.py             ← TF-IDF 向量化（dim=128）
            └── search.py               ← LanceDB 语义搜索封装
```

---

## IPC 通信协议

主项目（Node.js）与 AI 社会（Python）之间不直接访问对方数据库，而是通过 IPC 通信：

| 字段 | 值 |
|------|----|
| 协议 | MessagePack RPC |
| 客户端库 | `@msgpack/msgpack@3.1.3`（Node端）/ `msgpack>=1.0.0`（Python端） |
| 默认端口 | 27017（待确认，依据 IPC server 配置） |
| Python 服务入口 | `python/marl_service/server_prod.py` |
| 测试连接脚本 | `python/test_ipc_connection.py` |

**IPC 连接详情：**
- Node 端：`src/core/governor/ipc/base.ts`，TCP Socket 端口 `18765`（跨平台，Windows 用 Named Pipe `\\.\pipe\soloforge_mappo`）
- Python 端：`python/marl_service/server_prod.py`，MAPPO Critic 网络推理服务
- 通信协议：MessagePack 二进制序列化

**数据流向：**
```
主项目 Node.js  ──── TCP IPC (MessagePack) ────  Python MARL/AI社会服务
  端口: 18765                                          端口: --port 参数
     ↕                                                    ↕
  Garnet (热) :6379                                  SQLite + LanceDB
  SurrealDB (温) rocksdb://
  JSONL (冷)
```

---

## 回收站 Trash 记录

SurrealDB `trash` 表用于持久化软删除数据，支持恢复和过期自动清理。

| 属性 | 值 |
|------|----|
| 表名 | `trash` |
| Schema 文件 | `migrations/20240101050000__v6_persistent_trash.surql` |
| 代码实现 | `src/data/delete_protection.ts` (DeleteProtection + TrashDatabase) |
| 保留策略 | 30 天后自动清理 |
| 过期清理 | `startAutoPurge()` 默认每小时检查一次 |

**trash 表字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `originalId` | string | 被删除资源的原始 ID |
| `contentType` | string | 资源类型 |
| `deletedBy` | string | 执行删除的 Agent/User ID |
| `deletedAt` | datetime | 删除时间 |
| `purgesAt` | datetime | 过期时间（deletedAt + 30天） |
| `payload` | string | 被删除内容的 JSON 序列化 |
| `reason` | string (optional) | 删除原因 |
| `restored` | bool | 是否已恢复（默认 false） |
| `restoredAt` | datetime (optional) | 恢复时间 |
| `restoredBy` | string (optional) | 执行恢复的 Agent/User ID |

**索引：**
- `trash_originalId_idx` → 按 originalId 加速恢复查询
- `trash_purgesAt_idx` → 按 purgesAt 加速过期清理
- `trash_contentType_idx` → 按 contentType 分类查询
- `trash_restored_idx` → 按 restored 筛选未恢复记录

---

*文档生成时间：2026-05-31 | 基于 SoloForge 源码分析*
