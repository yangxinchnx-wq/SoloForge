# SoloForge 当前文件夹查看

## 任务概述
查看 `c:\Users\yangx\Desktop\SoloForge` 目录结构,梳理项目模块组织,产出一份可读性强的文件夹速览报告。

## 当前状态分析

### 项目身份
- **项目名**: SoloForge(版本 1.0.0)
- **定位**: AI 多智能体自治系统核心框架
- **架构**: 微内核 + 嵌入式数据库 + Rust 调度器 + Python MARL 引擎
- **核心技术栈**:
  - TypeScript + Node.js(运行时)
  - SurrealDB(直接嵌入式,温数据)
  - Garnet(微软内存数据库,热数据)
  - Rust(高性能调度器)
  - Python(MAPPO 多智能体强化学习)
  - React 19 + Vite + Tailwind 4(UI)
  - Electron(桌面端壳)

### 顶层目录清单

| 目录 | 用途 | 关键文件 |
|------|------|----------|
| `src/` | TypeScript 主后端源代码(微内核、业务领域、数据层) | `index.ts`、`bootstrap.ts`、`kernel/`、`core/` |
| `UI/` | React + Electron 前端(IDE 风格三栏界面) | `server.ts`、`electron/main.cjs`、`src/components/` |
| `python/` | Python MARL 训练服务、AI 社会模型 | `marl_service/`、`governor_rl/`、`soloforge_ai_society/` |
| `rust_core/` | Rust 高性能任务调度器 | `src/scheduler/`、`Cargo.toml` |
| `migrations/` | SurrealDB 数据库迁移脚本(v1–v6) | `20240101000000__v1_base_schema_migrations.surql` |
| `scripts/` | 运维脚本(迁移、重置、监控、启动) | `db-migrate.ts`、`start-archiver.ts` |
| `tests/` | Vitest 单元/集成测试 | `integration/`、`unit/` |
| `docs/` | 治理白皮书、迁移基线 | `SOLOFORGE-GOVERNANCE-WHITEPAPER.md` |
| `infra/` | 早期 schema、Governor 入口 | `schema.surql`、`mappo_governor.py` |
| `reports/` | 观察周期报告(JSON) | `observation/cycle-1-report.json` |
| `logs/` | 运行时审计日志 | `term-audit.log` |
| `patches/` | Garnet 集成补丁 | `apply-garnet-integration.txt` |
| `UI/electron/` | Electron 主进程 | `main.cjs`、`preload.cjs`、`launch.cjs` |

### 关键文件识别

- [README.md](file:///c:/Users/yangx/Desktop/SoloForge/README.md) — 项目主文档(架构、数据库、启动)
- [系统规格说明.md](file:///c:/Users/yangx/Desktop/SoloForge/系统规格说明.md) — 系统规格(22 章 + 4.1–4.196 表结构)
- [任务进度.md](file:///c:/Users/yangx/Desktop/SoloForge/任务进度.md) — 数据库三层架构迁移记录
- [package.json](file:///c:/Users/yangx/Desktop/SoloForge/package.json) — 主后端依赖与脚本
- [UI/package.json](file:///c:/Users/yangx/Desktop/SoloForge/UI/package.json) — 前端依赖与构建脚本
- [UI/AGENTS.md](file:///c:/Users/yangx/Desktop/SoloForge/UI/AGENTS.md) — AI 编码规范(Hashline 编辑 + 浮动面板标准)

### 后端架构(`src/`)
```
src/
├── kernel/         # 微内核:runtime-kernel、command-bus、transaction-manager
├── core/           # 业务:agent、court(仲裁)、decision(RACER)、governor(MARL)
├── hashline/       # 高精度编辑协议
├── compose/        # 复合解析器/观察器
├── ws/             # WebSocket:聊天、模型、心跳、状态
├── runtime/        # 运行时状态机
├── society/        # 智能体社会协作
├── observability/  # 治理白皮书导出
└── index.ts        # 入口
```

### 前端架构(`UI/src/`)
```
UI/src/
├── components/     # 20+ React 组件(ActivityBar、ChatPanel、FileExplorer、GitPanel 等)
├── context/        # ThemeContext
├── data/           # knowledge / skills / tools manifests + 存储工具
├── assets/         # 图标(13+ LLM 厂商)+ 资源
├── App.tsx
├── main.tsx
├── types.ts
└── index.css
```

### Python 训练栈(`python/`)
```
python/
├── marl_service/         # MAPPO IPC 服务、critic/policy 模型
├── governor_rl/          # 强化学习核心:env、scenarios、training
├── soloforge_ai_society/ # AI 社会模型:coalition、economy、governance、law
├── experiments/          # 实验脚本(PPO、BC、奖励审计、场景审计)
├── training/simulator/   # 治理器对比、稳定性指标、时间线
├── tests/                # pytest
└── reports/              # 实验报告(Markdown + JSON)
```

### 数据库迁移
- 6 个迁移版本:v1_base → v2_decision → v3_court → v4_governor → v5_events → v6_persistent_trash
- 每个版本都有 `down/` 目录下的回滚脚本
- 入口: `migrations/202605281200__init_baseline.surql`

### 启动方式(端口)
- `npm run garnet:dev` → Garnet @ 6379
- `npm run ui:dev` → UI Vite @ 3000
- `npm run backend:dev` → 后端 @ 3001
- `npm run dev:all` → 一键并发启动
- `npm run electron:dev` → 启动 Electron 壳(连接 3000 + 3001)

## 输出交付

向用户呈现:
1. 项目身份与定位
2. 顶层目录结构表(目录 → 用途 → 关键文件)
3. 关键文件清单(README、规格、任务进度、配置)
4. 后端/前端/Python 三大子系统的内部结构树
5. 数据库迁移版本
6. 启动方式速查

## 验证步骤
- 已用 `LS` 工具列出根目录全部子目录与文件
- 已读取 `README.md` 主文档
- 已读取 `系统规格说明.md` 目录
- 已读取 `任务进度.md` 历史
- 已读取 `package.json` + `UI/package.json` 确认依赖
- 已读取 `UI/AGENTS.md` 确认前端编码规范

## 假设与决策
- 用户希望"查看当前文件夹"理解为:**输出一份结构化的目录速览报告**,而非调用 shell `ls` 或修改任何文件
- 输出语言使用中文(匹配用户提问语言)
- 报告聚焦"项目组织结构",不展开代码细节
- 不修改任何文件、不执行任何命令
