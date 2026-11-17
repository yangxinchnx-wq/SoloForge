# SoloForge 重写方案（v1）

> 目标：用 Linux 式的纪律重构 SoloForge —— 单一坚固的核心守护进程、
> 状态确定性落盘、组件崩溃自动重启、启动顺序不再靠猜。
> 语言路线：Go 主力 / Rust 保留 / Python 边缘化 / TS 只留 UI / Tauri 壳 /
> **Java Agent Advisor 保留**（作为受监督的可选工作进程）。

---

## 一、六大痛点 → 逐一解决

| # | 现状痛点 | 解决机制 | 验收标准 |
|---|---------|---------|---------|
| 1 | Garnet 没启动 → 整个后端启动失败（强耦合） | **依赖分级**：核心只依赖进程内组件（存储全内存化，用户决策移除 SQLite）；外部组件全部标记为 optional，启动失败只降级不阻塞 | 杀掉任何一个外围进程，核心照常服务，界面显示"XX 组件离线" |
| 2 | 六种运行时，每个都要人肉养 | 运行时收敛：**Go 核心单二进制**（吸收事件总线/命令总线/调度/git-service/存储）+ Java Advisor（受监督）+ Python MARL（受监督，可选）+ Tauri 壳（Rust）。PowerShell 彻底移除 | 生产模式 = 1 个核心进程 + N 个受监督工作进程，全部由 supervisor 拉起 |
| 3 | Kafka + Garnet + SurrealDB + JSONL 四套存储 | **进程内存储**（用户决策移除 SQLite）：事件日志 + KV + 案例状态全在内存，组件零外部依赖；未来需要落盘时在 store 包加 JSONL 追加器，不改任何调用方 | 进程存活期间事件/状态全可用，重启即新会话（确定性清零） |
| 4 | PowerShell worker + FIFO 管窗口 | **Tauri 2 壳**：窗口拖拽/缩放/最大化走 Tauri 原生窗口 API（Rust），删除 PS worker、FIFO、绝对坐标协议 | Windows/Linux/macOS 三平台同一套窗口行为，无外部进程 |
| 5 | Electron 退出后孤儿进程、清理竞态 | **监督者（supervisor）独占子进程所有权**：所有子进程由 supervisor spawn 并登记，supervisor 退出时按树强杀；核心内部组件是 goroutine（进程内），根本没有"孤儿"这回事 | 任务管理器里不存在任何"父进程已死的 SoloForge 残留进程" |
| 6 | 端口冲突、启动顺序靠 sleep 猜 | **配置化端口 + 预检 + 健康探针**：supervisor 启动前逐端口试绑定并报告占用者 PID/进程名；worker 由核心分配端口或从配置读取；就绪判定 = 健康探针通过，而非 sleep N 秒 | 占用端口时启动立即失败并打印"端口 4000 被进程 1234 (chrome.exe) 占用"；一切就绪后 supervisor 才报 READY |

---

## 二、目标架构

```
┌────────────────────────────────────────────────────────────┐
│ soloforge-supervisor (Go)                                  │
│  · 拉起/重启/强杀所有子进程（唯一持有子进程所有权的进程）     │
│  · 端口预检 / 健康探针 / 就绪报告 / 单实例锁                │
│  · 日志落盘 logs/ (按组件分文件)                            │
└──────────────┬─────────────────────────────────────────────┘
               │ spawn + health probe + restart(backoff)
               │
┌──────────────▼─────────────────────────────────────────────┐
│ soloforge-core (Go 单二进制, 唯一必选组件, 监听 7300)        │
│  ├─ HTTP + WebSocket API (外部唯一入口)                     │
│  ├─ 事件总线 + 命令总线 (进程内 channel, WS 桥接给 worker)   │
│  ├─ Agent 运行时 / 命令总线 / 仲裁 court / 决策 decision    │
│  ├─ 调度器 (吸收 rust_core 职责, 内存堆 + aging 队列)        │
│  ├─ git 服务 (原 git-service Go 代码并入, 不再独立进程)      │
│  ├─ 存储: 进程内 (事件日志 + KV, 无外部数据库)               │
│  └─ 内存缓存层 (可选, 从库重建, 挂了直接回源)                │
└──────┬───────────────────────────┬─────────────────────────┘
       │ WebSocket 事件流/命令      │ HTTP 健康探针 (supervisor 探)
┌──────▼──────────────┐   ┌────────▼─────────┐   ┌─────────────────┐
│ agent-advisor (Java) │   │ marl-worker      │   │ llama-server    │
│ Spring Boot, 保留    │   │ (Python, 可选)    │   │ (可选, OpenAI   │
│ 端口 8770 由配置指定  │   │ MAPPO 推理/训练   │   │ 兼容接口)       │
│ /actuator/health 探针│   │ 端口 8780 配置指定│   │ 端口 8790       │
└─────────────────────┘   └──────────────────┘   └─────────────────┘
┌────────────────────────────────────────────────────────────┐
│ soloforge-ui (Tauri 2 + 现有 React 代码)                    │
│  · 生产模式: 静态资源由壳加载, 无 Node/Vite 进程             │
│  · 窗口拖拽/缩放/最大化: Tauri 原生 API (PowerShell 移除)    │
│  · 与 core 通信: ws://127.0.0.1:7300/ws                     │
└────────────────────────────────────────────────────────────┘
```

依赖规则（写进代码评审清单）：
1. core **不依赖**任何外围进程的存在性——外围全挂，core 必须仍能提供 API
2. 外围 worker **只主动连接 core**（客户端角色），不要求 core 反向探测它们的端口
3. 任何"可选组件"的启动失败 = 状态降级 + 日志 WARN，绝不是 exit(1)

---

## 三、存储设计（三套收敛为一套 + 归档）

| 旧 | 新 | 说明 |
|---|---|---|
| Garnet (6379) | 进程内 `sync.Map` / 分片 map 缓存 | 挂了 = 直接读内存存储，功能无损 |
| SurrealDB (8400) | **进程内事件日志 + 状态 map**（store 包） | 事件序 + KV + 案例/违法状态机；重启清零，需要落盘时加 JSONL 追加器 |
| Kafka (8765) | events 表 + 进程内总线 + WS 桥 | 事件先落库再广播；重放 = SELECT ... WHERE seq > n |
| JSONL 归档 | 保留（归档任务定期从 events 表转 JSONL.gz） | Unix 传统，便宜且够用 |
| Qdrant | 可选: sqlite-vec 扩展（同库内向量检索） | 又少一个进程；需要规模化时再换回 |

崩溃恢复流程（确定性）：
```
启动 → 内存存储就绪 → 校验事件序 → 总线恢复 → 对外报告 READY（supervisor 探针确认）

     → 重放 events 表中 status=pending 的事务 → 总线恢复到最新状态
     → 对外报告 READY（此时 supervisor 才认为 core 健康）
```

---

## 四、通信设计

- **进程内**：Go channel 总线（命令总线 + 事件总线分离，保留现有语义）
- **core → UI**：WebSocket `/ws`（JSON 事件流 + 命令上行），替代现有 SSE/WS 混用
- **worker → core**：worker 作为 WebSocket 客户端接入（advisor/marl 主动上报+订阅）
- **协议**：一份 JSON Schema 定义所有事件与命令（`docs/protocol.md`，阶段 0 交付物），
  任何语言的 worker 照 schema 实现即可，这就是"语言随便换"的底气
- **不再有**：Kafka 客户端、自定义 TCP FIFO、msgpack 双序列化路径、SSE/WS 并存

---

## 五、Agent Advisor（Java）保留方案

1. **保留形态**：Spring Boot 应用原样保留，`mvn package` 产出 jar
2. **接入方式**：supervisor 以子进程拉起 `java -jar agent-advisor.jar --server.port=8770`，
   端口从 `config.toml` 读取；JDK 用项目内 `bin/jdk-23-mini`（免安装）
3. **健康探针**：supervisor 每 5s GET `/actuator/health`；失败按 1s→2s→4s→…→60s 退避重启
4. **分级标记**：advisor = OPTIONAL。离线时 core 正常服务，依赖 advisor 的功能返回
   `advisor_offline` 错误码（UI 显示灰点）；绝不阻塞启动
5. **通信改造**（阶段 2）：原裸 TCP 8771 替换为 WebSocket 客户端接入 core 总线，
   Java 侧用 Spring WebSocket 客户端，协议走 `docs/protocol.md`
6. **优雅关机**：Spring 加 SIGTERM hook，supervisor 停止时先 SIGTERM 再 5s 超时 SIGKILL

---

## 六、生命周期设计（supervisor）

```
启动流程:
  1. 读 config.toml (端口/组件开关/路径)
  2. 端口预检: 对每个将监听的端口试 bind → 失败则列出占用 PID+进程名并退出
  3. 单实例锁: core 端口 + lockfile 双保险
  4. 拉起 core → 探活 GET /health (200=READY) → 失败退避重启
  5. 按配置拉起各 optional worker → 各自探活
  6. 全部就绪后输出 READY 报告 (哪些在线/哪些离线/各端口)

停止流程:
  SIGTERM → 逆序 SIGTERM 所有子进程 → 5s 超时 SIGKILL → 等待端口释放确认
  → 不再有孤儿进程

崩溃策略:
  core 崩溃 → supervisor 指数退避重启 (1s..30s 封顶) → 连续 5 次失败
  → 停止并写 panic 报告 (不无限循环刷屏)
```

---

## 七、目录结构（新仓库布局）

```
soloforge/
├── cmd/
│   ├── core/main.go            # 核心守护进程入口
│   └── supervisor/main.go      # 生命周期管理器入口
├── internal/
│   ├── bus/                    # 事件总线 + 命令总线 (channel) + WS 桥
│   ├── store/                  # 进程内事件日志 + KV (用户决策: 无持久化)
│   ├── agents/                 # Agent 运行时 (自 TS src/core/agents 移植)
│   ├── court/                  # 仲裁
│   ├── decision/               # RACER 决策
│   ├── scheduler/              # 调度器
│   └── gitsvc/                 # 原 git-service 并入
├── workers/
│   ├── advisor/                # Java Agent Advisor (受监督, 保留)
│   └── marl/                   # Python MAPPO worker (受监督, 可选)
├── ui/                         # 现有 React 代码 + Tauri 2 壳 (Rust)
│   ├── src/                    # 原样迁移
│   └── src-tauri/              # Tauri 壳
├── config.toml                 # 端口/组件开关/路径
└── docs/
    ├── protocol.md             # 事件/命令 JSON Schema (阶段 0 交付)
    └── rewrite-plan.md         # 本文档
```

---

## 八、迁移路线图

| 阶段 | 内容 | 退出标准 | 预估 |
|------|------|---------|------|
| **0 协议** | 梳理现有全部通信路径，产出 `docs/protocol.md`（事件/命令/字段/方向） | 新旧两端都能按 schema 编解码 | 1-2 周 |
| **1 Go 核心** | core 二进制：HTTP+WS API、总线、进程内存储、health（已完成 ✅） | 全组件经单一端口 7300 可访问；TS 端零改动可用 | 3-4 周 |
| **2 组件迁入** | agents/court/decision/git 移植为 Go 包；删 Kafka/Garnet/SurrealDB 依赖 | 生产模式无 Node 后端进程 | 4-8 周 |
| **3 Tauri 壳** | UI 迁入 Tauri；删 Electron/PS worker/窗口 FIFO | 生产模式无 Node 进程；三平台窗口行为一致 | 2-3 周 |
| **4 worker 收编** | advisor 接入 WS 协议 + supervisor 探针；marl 降级为可选 worker | supervisor 一键拉起全栈，各进程崩溃自动恢复 | 2 周 |
| **5 清理** | 删旧 Electron 工程/PS 脚本/多余依赖 | 仓库里只剩新架构代码 | 1 周 |

> 关键纪律：**每个阶段结束时系统必须可运行、可回退**。禁止"新旧并行大重写后一次性切换"。

---

## 九、风险与对策

| 风险 | 对策 |
|------|------|
| Go 重写丢失 TS 端隐藏行为 | 阶段 1 先双跑（TS 为主、Go 影子记录事件流做 diff 对账） |
| 进程内存储无持久化 | 用户决策；未来需要时在 store 包加 JSONL 追加器，不改调用方 |
| Tauri WebView 兼容性 (Windows WebView2) | 阶段 3 先做壳 + 冒烟测试再迁功能；Electron 工程保留到阶段 5 |
| Java worker 内存/JDK 路径问题 | supervisor 探活失败时自动降级，advisor 离线不影响主链路 |
| 重写期间旧需求插队 | 绞杀者模式：旧系统继续服务，新组件逐个替换，永远有可用版本 |
