# soloforge-next — Go 核心骨架 (阶段 1)

> 重写方案见 `docs/rewrite-plan.md`，协议清单见 `docs/protocol.md`。
> 本目录是新架构的 Go 实现：单一核心守护进程 + 生命周期管理器。

## 构建

```bash
# 使用项目内便携 Go (或任意 Go >= 1.27)
export PATH="/d/D/SoloForge/bin/go/bin:$PATH"
export GOPROXY="https://goproxy.cn,direct"   # 国内镜像

cd next
go build -o bin/soloforge-core.exe ./cmd/core
go build -o bin/soloforge-supervisor.exe ./cmd/supervisor
```

## 运行

```bash
cp config.example.toml config.toml   # 按需修改
./bin/soloforge-supervisor.exe -config config.toml
# supervisor: 端口预检 → 拉起 core → 健康探针 → 崩溃退避重启
```

## API 骨架（端口 7300）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康探针（supervisor READY 判定） |
| GET | `/api/kernel/status` | 内核状态（uptime/事件数/订阅者/丢帧） |
| GET | `/api/events/list?after=N&limit=M` | 事件重放（游标 + 上限） |
| POST | `/api/commands` | 命令派发 `{type, payload, source}` |
| GET | `/metrics` | 文本指标（events/ws_clients/dropped/uptime） |
| WS | `/ws` | 事件下行流 + 命令上行（`{type:"ping"\|"command"}`） |
| GET | `/api/agents/snapshot` | Agent 池快照 |
| POST | `/api/agents/dispatch` | 多 worker 决策管线（phase0~3 全事件） |
| POST | `/api/court/arbitrate` / `GET /api/court/cases` | 共识仲裁 |
| GET | `/api/git/*` | git 服务（已并入核心，3002 已移除） |
| GET | `/api/law/violations` + CommandBus 的 law 命令 | 法律级联 |

内置命令: `echo` / `kv.set` / `kv.get` / `events.count` / `EXECUTE_EVIDENTIARY_ARBITRATION` /
`RECORD_VIOLATION_FACT` / `EXECUTE_VIOLATION_PENALTY` / `LODGE_LAW_APPEAL`
（无 handler 的命令自动 passthrough，对齐旧 CommandBus 语义）

**存储说明**: 进程内实现（用户决策移除 SQLite），重启清零；未来需要落盘时在 store 包加 JSONL 追加器。

## 冒烟测试（已验证 ✅）

```bash
# 1. 基础功能
curl -s http://127.0.0.1:7300/health
curl -s -X POST http://127.0.0.1:7300/api/commands -d '{"type":"echo","payload":{"a":1}}'

# 2. Agent 编排管线 (phase0~3 全事件落日志)
curl -s -X POST http://127.0.0.1:7300/api/agents/dispatch -d '{"chatId":"c1","prompt":"测试"}'

# 3. 法庭仲裁 (分差 > 0.1 → DECIDED_LEGITIMATE; 分差小 → 死锁)
curl -s -X POST http://127.0.0.1:7300/api/court/arbitrate -d '{"claim":"测试","arguments":[...]}'
```

## 结构

```
cmd/core/           核心入口 (存储/总线/API 接线, 优雅关机)
cmd/supervisor/     管理器入口 (预检/拉起/探活/退避重启/树杀)
internal/store/     进程内事件日志 + KV (先写后发, 重启清零)
internal/bus/       事件总线 + 命令总线 (passthrough 兼容语义)
internal/api/       HTTP+WS 处理器
config.example.toml 配置模板
```
