# SoloForge

AI 多智能体自治系统核心框架。基于微内核架构，集成嵌入式数据库、Rust 高性能调度器与 Python 多智能体强化学习（MARL）引擎，构建决策-仲裁-执行-审计完整闭环。

## 架构概览

```
src/
├── index.ts                    # 入口：启动嵌入式数据库 + 生命周期看门狗
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
    ├── surreal_persistence.ts  #   SurrealDB 仓储管理器
    ├── surreal_driver_live.ts  #   数据库实时驱动
    ├── delete_protection.ts    #   数据删除保护
    └── transaction_kernel.ts   #   事务内核
```

## 核心技术栈

| 层 | 技术 | 职责 |
|---|------|------|
| **运行时** | TypeScript + Node.js | 微内核、业务编排、事件总线 |
| **数据库** | SurrealDB（嵌入式） | 决策记录、仲裁卷宗、MARL 遥测、审计日志 |
| **调度器** | Rust | 高性能任务调度 |
| **训练引擎** | Python | MAPPO 多智能体强化学习推理服务 |

## 快速启动

### 环境要求

- Node.js >= 18
- npm

### 安装与运行

```bash
# 安装依赖
npm install

# 启动系统（会自动拉起嵌入式 SurrealDB）
npm start
```

启动后系统会：
1. 检查端口可用性
2. 拉起 SurrealDB 嵌入式数据库（端口 8003）
3. 连接数据库并初始化表结构
4. 装配内核组件（命令总线、事务管理器、调度器等）
5. 启动 2 秒间隔的心跳事件循环

按 `Ctrl+C` 优雅退出。

### 运行测试

```bash
npm test
```

## 数据库

系统使用嵌入式 SurrealDB，数据库文件存储在 `data/soloforge_db/`。

数据表结构：

| 表名 | 用途 |
|------|------|
| `decision` | RACER 引擎流控决策记录 |
| `courtSubmission` | 多智能体仲裁决议卷宗 |
| `marlEpisode` | MAPPO 强化学习遥测特征 |
| `eventLog` | 内核事件审计日志 |

表结构定义文件位于 `infra/schema.surql`，启动时自动执行。

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
├── bin/             # SurrealDB 二进制文件
├── src/             # TypeScript 源代码
├── infra/           # 数据库表结构定义
├── python/          # Python MARL 训练服务
├── rust_core/       # Rust 调度器
├── data/            # 数据库运行时文件（不进入版本控制）
└── package.json     # 项目配置
```

## 许可

MIT