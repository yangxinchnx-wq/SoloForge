# SoloForge

AI 多智能体自治系统核心框架。基于微内核架构，集成嵌入式数据库、Rust 高性能调度器与 Python 多智能体强化学习（MARL）引擎，构建决策-仲裁-执行-审计完整闭环。

## 架构概览

```
src/
├── index.ts                    # 入口：启动 SurrealDB 直接嵌入式 + 生命周期看门狗
├── bootstrap.ts                # 总装工厂：纯连线装配，零业务逻辑
├── kernel/                     # 微内核层
│   ├── runtime-kernel.ts       #   统一真相内核（事件总线 / 运行模式 / 状态所有权）
│   ├── command-bus.ts          #   命令总线
│   ├── transaction-manager.ts  #   事务管理器（原子性保证）
│   ├── state-ownership.ts      #   状态所有权注册表
│   ├── scheduler-client.ts     #   Rust 调度器客户端
│   └── domains/ai-runtime.ts   #   AI 运行时可插拔模块
├── core/                       # 业务领域层
│   ├── agent/                  #   自主智能体
│   ├── court/                  #   司法仲裁（盲审 + LLM 终审升级）
│   ├── decision/               #   RACER 决策引擎（流控竞价）
│   ├── governor/               #   MAPPO 强化学习客户端
│   ├── events/                 #   事件系统
│   └── logger/                 #   日志模块
└── data/                       # 数据持久层
    ├── repositories/           #   Repository 层（屏蔽 SurrealQL）
    ├── surreal_persistence.ts  #   SurrealDB 仓储管理器
    ├── surreal_driver_live.ts  #   数据库实时驱动
    ├── delete_protection.ts    #   数据删除保护
    └── transaction_kernel.ts   #   事务内核
```

## 核心技术栈

| 层 | 技术 | 职责 |
|---|------|------|
| **运行时** | TypeScript + Node.js | 微内核、业务编排、事件总线 |
| **数据库** | SurrealDB（直接嵌入式） | 决策记录、仲裁卷宗、MARL 遥测、审计日志 |
| **调度器** | Rust | 高性能任务调度 |
| **训练引擎** | Python | MAPPO 多智能体强化学习推理服务 |

## 数据库方案

### 存储架构

| 层级 | 数据库 | 用途 |
|------|--------|------|
| 热数据 | **Garnet** | 运行态缓存、队列、Session Context、Task State |
| 温数据 | **SurrealDB** | 持久化数据、决策记录、AI 数据 |
| 冷数据 | **JSONL** | 事件归档、审计日志 |

### Garnet（热数据层）

Garnet 是微软研究院开发的高性能内存数据库，原生支持 Windows，比 Redis 快 2-10 倍。

#### 位置与版本

| 项目 | 说明 |
|------|------|
| **版本** | v1.1.10 |
| **路径** | `bin/garnet/portable/net10.0/` |
| **可执行文件** | `GarnetServer.exe` |

#### 启动 Garnet

```powershell
# 进入目录
cd bin/garnet/portable/net10.0

# 启动服务器（启用 Lua 脚本 + 5秒超时保护）
.\GarnetServer.exe --lua --lua-script-timeout 5000 --port 6379
```

#### 下载与安装（新版本）

如需更新 Garnet 到最新版本：

1. 下载：https://github.com/microsoft/garnet/releases
2. 选择：`win-x64-based-readytorun.zip` 或 `portable.7z`
3. 解压到 `bin/garnet/portable/` 目录

### 连接方式

| 项目 | 说明 |
|------|------|
| **模式** | SurrealDB 直接嵌入式（无子进程） |
| **协议** | rocksdb://（高性能持久化存储） |
| **数据路径** | data/soloforge_db/ |
| **性能** | 比 WebSocket RPC 快 10-50 倍 |

### 数据库配置

```typescript
import { Surreal, createRemoteEngines } from 'surrealdb';
import { createNodeEngines } from '@surrealdb/node';

const db = new Surreal({
  engines: {
    ...createRemoteEngines(),
    ...createNodeEngines()
  }
});

// 直接嵌入式连接（使用 rocksdb:// 协议）
await db.connect('rocksdb://data/soloforge_db');
await db.use({ namespace: 'soloforge_core', database: 'autonomous_network' });
```

### 支持的模式

| 模式 | 用途 | 性能 |
|------|------|------|
| `rocksdb://path` | RocksDB 持久化存储 | 高 |
| `surrealkv://path` | SurrealKV 持久化存储 | 高 |
| `mem://` | 内存模式（仅测试） | 最高 |

## 快速启动

### 环境要求

- Node.js >= 18
- npm

### 安装与运行

```bash
# 安装依赖
npm install

# 启动系统（使用 SurrealDB 直接嵌入式）
npm start
```

启动后系统会：
1. 连接 SurrealDB 嵌入式数据库（file:// 协议，无子进程）
2. 初始化数据库 Schema
3. 装配内核组件（命令总线、事务管理器、调度器等）
4. 启动 2 秒间隔的心跳事件循环

按 `Ctrl+C` 优雅退出。

### 运行测试

```bash
npm test
```

### 数据库迁移

```bash
# 执行所有待应用迁移
npm run db:migrate

# 回滚最近一个迁移
npm run db:rollback

# 查看迁移状态
npm run db:status
```

## 数据库 Schema

### 迁移版本

| 版本 | 表数量 | 说明 |
|------|--------|------|
| v1_base | 2 | 迁移历史、系统配置 |
| v2_decision | 3 | 决策、候选、策略 |
| v3_court | 4 | 证据、提交、裁决、陪审团 |
| v4_governor | 4 | MARL 遥测、策略快照、调度状态 |
| v5_events | 5 | 事件日志、链路追踪、回放会话 |

### 数据表

| 表名 | 用途 |
|------|------|
| `decision` | RACER 引擎流控决策记录 |
| `courtSubmission` | 多智能体仲裁决议卷宗 |
| `courtVerdict` | 法庭裁决记录 |
| `marlEpisode` | MAPPO 强化学习遥测特征 |
| `eventLog` | 内核事件审计日志 |
| `traceLinkage` | 全链路追踪记录 |
| `migration_history` | 迁移历史 |

### Schema 位置

- `migrations/` - 迁移脚本（推荐）
- `infra/schema.surql` - 遗留 schema（向后兼容）

## 运行模式

内核支持多种运行模式，通过 `RuntimeMode` 枚举控制：

| 模式 | 说明 |
|------|------|
| `NORMAL` | 正常运行 |
| `REPLAY` | 事件回放（按时间排序重放历史事件） |
| `FORK` | 分支模式 |
| `SANDBOX` | 沙盒隔离 |
| `RECOVERY` | 故障恢复（心跳异常时自动进入） |
| `SHUTDOWN` | 安全关闭 |

## 智能体协作流程

```
自主智能体发起决策
    → RACER 引擎流控竞价（预算 / 置信度 / 策略聚合）
    → 多智能体盲审仲裁
    → 争议升级 → LLM 终审裁决
    → MAPPO 强化学习持续优化策略
    → 全链路审计日志持久化
```

## 项目结构

```
SoloForge/
├── src/              # TypeScript 源代码
│   └── data/
│       └── repositories/  # Repository 层
├── migrations/       # 数据库迁移脚本
├── infra/            # Schema 定义（已废弃）
├── python/          # Python MARL 训练服务
├── rust_core/       # Rust 调度器
├── data/            # 数据库运行时文件（不进入版本控制）
│   └── soloforge_db/  # SurrealDB RocksDB 数据
├── scripts/         # 数据库迁移脚本
└── package.json     # 项目配置
```

## 许可

MIT