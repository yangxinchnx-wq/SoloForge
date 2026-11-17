# SoloForge 通信协议清单（阶段 0 交付物 v0.9）

> 目的：重写前的协议地基。记录现有系统**全部**通信路径：谁→谁、载荷、格式、方向。
> 图例: [活跃]=正常运行时在用 [降级]=有 fallback 的可选路径 [孤儿]=注册了但无人调用 [断裂]=消费方读取路径错误
> 状态: ✅ 全部完成（实时通信 / Electron IPC / HTTP REST / 系统消息）

---

## 0. 通信拓扑总览

| 机制 | 传输 | 端口 | 编码 | 状态 |
|---|---|---|---|---|
| AgentEventHub (WS 服务端) | WebSocket | 3001 `/ws/agents` | JSON `{type,payload,ts}` | [活跃] |
| AgentCommBus (FIPA-ACL 中继) | WebSocket 客户端 | 3001 `/ws/agents` | JSON | [降级] |
| SSE 广播 | HTTP SSE | 3001 `/api/events/stream` | JSON | [活跃] |
| DistributedBroker (↔Python MARL) | 裸 TCP, `\n` 分隔 JSON 行 | 8765 | JSON 行 | [活跃可降级] |
| ShadowGovernorClient | 裸 TCP JSON 行 (同端口) | 8765 | JSON 行 + int id 关联 | [活跃可降级] |
| TrainingScheduler | 裸 TCP JSON 行 (同端口) | 8765 | JSON 行 | [活跃可降级] |
| JavaAgentTcpClient | 裸 TCP, `\n` 分隔 JSON 行 | 8771 | JSON 行, messageId 关联 | [活跃] |
| Kafka 审计 sink | kafkajs | 由 env 配置 | JSON value | [条件启用] |
| Garnet Bridge | Redis RESP Streams | 6379 | field-value + JSON | [半成品] |
| CommandBus | 进程内 (Node) | — | JS 对象 `{id?,type,domain,caller,payload}` | [活跃] |
| EventBus | 进程内 EventEmitter | — | JS 对象 + traceId 注入 | [活跃] |
| Raft 共识 | 进程内经 CommandBus (无网络层) | — | RpcResponse | [单节点降级] |
| PS Worker | 子进程 stdin/stdout 管道 | — | `CMD|arg|arg` 行 + `OK/PONG/ERR` ACK | [活跃, 仅 win32] |

### 关键降级路径汇总

| 失败场景 | 降级行为 |
|---|---|
| AgentCommBus WS 连接失败 | 降级纯进程内模式（inbox poll 语义，无跨进程中继） |
| Kafka 发送失败 / 未配置 | 整条链路不启动；失败降级 stdout JSON 行 (`AUDIT_FALLBACK`) |
| DistributedBroker 未连 | 丢帧 + dropped 计数器；10 次重连后发 `Heartbeat{status:'CRITICAL_CLUSTER_BRAIN_SPLIT'}` |
| ShadowGovernor pending>500 或未连 | `fallbackEnabled` 启发式 action |
| POLICY_QUERY 超时(1s) | 回退 action=0 |
| Garnet 未启动 | 直写 SurrealDB；UI garnetClient 30s 内不重试走内存 fallback |
| Raft peers 为空 | 单节点自动晋升 LEADER |
| CommandBus 无 handler | passthrough 返回 `{success:true, mode:'passthrough'}` |

---

## 1. WebSocket — AgentEventHub（服务端, 3001 `/ws/agents`）

帧格式 `{type, payload, ts}`；token 鉴权 `?token=`；UI 侧由 Vite dev server 代理 `/ws*` → `ws://localhost:3001`。

| 消息名 | 方向 | 载荷字段 | 用途 | 位置 |
|---|---|---|---|---|
| `ping` | C→S | `{type:'ping'}` | 保活 | src/core/agent/agent-event-hub.ts:94 |
| `pong` | S→C | `{type:'pong', ts}` | 回应 | 同 :95 |
| `agent.snapshot` | S→C | `{agents: AgentSnapshot[], cpuLoad}` | 连接建立即推 agent 池快照 | 同 :156 |
| `agent.task.dispatched` | S→C | RuntimeEvent.AgentTaskDispatched 载荷 | 任务派发广播 | 同 :123 |
| `agent.task.executed` | S→C | 执行结果 | 任务完成广播 | 同 :124 |
| `agent.reputation.updated` | S→C | 信誉变更 | 信誉广播 | 同 :125 |
| `agent.dispute.raised` | S→C | 争议载荷 | 争议广播 | 同 :126 |
| `court:arbitration_decided` | S→C | `{winner}` | 仲裁裁决 | 同 :127 |
| `court:deadlock_detected` | S→C | 死锁上下文 | 法庭死锁 | 同 :128 |
| `court:claim_submitted` | S→C | 申诉载荷 | 申诉提交 | 同 :129 |
| `phase0_subtask` | S→C | `{packetUuid, chatId, subtasks[]}` | 编排器子任务拆分 | 同 :131 |
| `phase0_skip` | S→C | skip 上下文 | 子任务跳过 | 同 :132 |
| `phase1_worker_start` | S→C | `{packetUuid, workerIdx, modelName}` | worker 启动 | 同 :133 |
| `phase1_worker_done` / `phase1_worker_error` | S→C | worker 结果/错误 | worker 完成/失败 | 同 :134-135 |
| `phase2_judge` / `phase2_judge_error` | S→C | judge 结果 | LLM 裁判完成/失败 | 同 :136-137 |
| `phase3_deliver_start` / `phase3_deliver_done` | S→C | 交付载荷 | 交付阶段 | 同 :138-139 |
| `fiaacl.relay` | C→S→其他 C | `{type:'fiaacl.relay', payload: FIPAACLMessage}` | 跨进程 ACL 广播（排除发送者） | 同 :96-99,177-186 |

**FIPAACLMessage**: `{sender, receiver, performative, content, ontology?, protocol?, messageId, replyWith?, timestamp}`
Performative 枚举: `INFORM / REQUEST / PROPOSE / ACCEPT / REJECT / QUERY / DELEGATE / CHALLENGE / GOSSIP`

---

## 2. Kafka 审计链路

- 配置: `SOLOFORGE_KAFKA_BROKERS`（未设则整链路不启动）、`SOLOFORGE_KAFKA_TOPIC`（默认 `soloforge-events`）
- 来源: SurrealDB Change Feed 轮询（1s 间隔 / 200 批 / 60s 回看）→ `AuditChangeFeed`

| 消息 | 方向 | 载荷 | 用途 | 位置 |
|---|---|---|---|---|
| Audit producer message | → Kafka topic | key=`tenantId\|'_default'`, value=`{...AuditEvent, _sink:'kafka'}` | 审计解耦告警 | src/security/auditSinkKafka.ts:113-129 |
| AUDIT_FALLBACK | → stdout | `{tag:'AUDIT_FALLBACK', ...ev, _sink, _fallbackReason}` | 发送失败降级 | 同 :144-155 |

---

## 3. DistributedBroker（8765 裸 TCP, ↔ Python MARL）

帧: `{frameId, type, currentTick, payload, kernelVersionSeal, timestamp}`（JSON 行，`\n` 分界）；keepAlive 1s；断线指数退避重连 ≤10 次，超限发 `Heartbeat{status:'CRITICAL_CLUSTER_BRAIN_SPLIT'}`。

| 帧 type | 方向 | 载荷 | 用途 | 位置 |
|---|---|---|---|---|
| `TELEMETRY_STREAM` | Node→Py | 10 维遥测 `{cpu_usage, memory_pressure, queue_depth, agent_count, token_pressure, projection_lag, scheduler_congestion, attention_collapse, starvation_penalty, pressure_index}` | 每 tick 倾泄遥测 | src/kernel/orchestration/distributed-broker.ts:108-133 |
| `ACTION_DECISION_ACK` | Py→Node | `{traceId, data}`, 含 kernelVersionSeal 版本对齐 | 决策返回；不符计 version_drift_warnings | 同 :153-168 |
| `DRIFT_COMMAND` | Node→Py | `{action, payload:{driftType...}}` | 超参漂移实验 | 同 :86-103 |
| `DRIFT_COMMAND` 响应 | Py→Node | `{traceId, drift_result}` (走 ACTION_DECISION_ACK 壳) | 漂移响应 | 同 :142-151 |
| `AGENT_TRAINING_DATA` | Node→Py | `{frameId:'train-<agentId>-<ts>', agentId, reason, payload:{trainingData}}` | 训练 trace 提交 | src/core/agent/evolution/training-scheduler.ts:257-263 |
| `AGENT_TRAINING_ACK` | Py→Node | `{accepted, trained_this_call, loss, checkpoint_written}` (5s 超时) | 训练 ACK | 同 :267-289 |
| `POLICY_QUERY` | Node→Py | `{frameId:'policy_q_<ts>', payload:{observation:number[10]}}` | 查询策略动作 | 同 :347-352 |
| `POLICY_ANSWER` | Py→Node | `{action, confidence, source, step_counter}` (1s 超时回退 action=0) | 策略答复 | 同 :354-375 |

---

## 4. ShadowGovernorClient（8765, JSON 行, int id 关联）

| 消息 | 方向 | 载荷 | 用途 | 位置 |
|---|---|---|---|---|
| ShadowRequest | Node→Py | `{id:number, obs:number[], timestamp, txContext:{txId, traceId, tickId, version}}` | 影子治理策略推理 | src/kernel/shadow-governor-client.ts:15-25 |
| ShadowResponse | Py→Node | `{id, action, action_name, prob, value?, confidence?}` actionLabels: `no_op/spawn_agent/pause_background/switch_small_model/reduce_context/enable_gc` | 推理结果 | 同 :27-35 |

---

## 5. CommandBus（进程内命令路由）

信封: `{id?, type, domain, caller, payload}`；无 handler 时 passthrough 返回 `{success:true, mode:'passthrough', command}`。

| 命令名 | 调用方→执行域 | payload | 用途 | 注册位置 |
|---|---|---|---|---|
| `SYS_HEARTBEAT` | bootstrap→转发 | + timestamp/source | 转发为 RuntimeEvent.Heartbeat | src/bootstrap.ts:133-145 |
| `RECEIVE_APPEND_ENTRIES_RPC` | Raft Leader→节点 | `{term, leaderId, prevLogIndex, prevLogTerm, entries[], leaderCommitIndex}` → RpcResponse | 日志复制/心跳 | src/kernel/consensus/raft-consensus-node.ts:88-91 |
| `RECEIVE_REQUEST_VOTE_RPC` | Raft Candidate→节点 | `{term, candidateId, lastLogIndex, lastLogTerm}` → RpcResponse | 选举投票 | 同 :93-95 |
| `RESOLVE_SUPREME_JUDICIAL_DEADLOCK` | consensagent→LLM 最高法庭 | `{traceId, failedCaseId, suspiciousManifesto}` | 死锁升级仲裁 | src/core/court/llm_escalation.ts:35-37 |
| `EXECUTE_EVIDENTIARY_ARBITRATION` | 外部→ConsensAgent | `{traceId, argumentsList, evidenceSnapshotMap}` | 证据仲裁 | src/core/court/consensagent.ts:52-54 |
| `DISTRIBUTE_ROLE_ALLOCATION_REWARD` | law/coalition/role-evo→Economy | `{traceId, agentId, targetRole, allocationBonusFactor, tickId?}` | 角色报酬分配 | src/core/economy/economy.ts:40-42 |
| `RECORD_VIOLATION_FACT` | →Law | `{traceId, entityId, entityType, lawId, description, evidence}` | 记录违法 | src/core/law/law-engine.ts:90-92 |
| `EXECUTE_VIOLATION_PENALTY` | →Law | `{traceId, violationId, executor}` | 执行处罚 | 同 :94-96 |
| `LODGE_LAW_APPEAL` | →Law | `{traceId, violationId, appellant, reason, supportingEvidence}` | 法律申诉 | 同 :98-100 |
| `CREATE_SOCIETY_INSTITUTION` | →制度 | `{traceId, name, description, rules, scope, enforcement, priority, metadata}` | 创建制度 | src/core/society/institution.ts:51-53 |
| `SOFT_DELETE_INSTITUTION` | →制度 | `{traceId, institutionId}` | 软删制度 | 同 :55-57 |
| `PROPAGATE_LEGAL_MEME` | →文化 | `{traceId, targetClusterId, sourceMemeId, environmentalEntropy}` | 法律模因传播 | src/core/society/culture.ts:37-39 |
| `DRIFT_EXPERIMENT_START` | →漂移 | `{driftType}` | 启动漂移实验 | src/core/society/hyperparameter-drift.service.ts:68-70 |
| `DRIFT_STEP` | →漂移 | `{performance, governanceSignal, driftType?}` | 漂移步进 | 同 :72-74 |
| `DRIFT_GET_SUMMARY` | →漂移 | 查询 | 漂移摘要 | 同 :76-78 |
| `RECORD_SOCIAL_MEMORY` | →社会记忆 | `{traceId, event, impact, severity, participants, lessons, metadata}` | 社会记忆 | src/core/society/social-memory.ts:49-51 |
| `REGISTER_REPUTATION_ENTITY` | →信誉 | `{traceId, entityId, entityType}` | 注册信誉实体 | src/core/society/reputation.ts:70-72 |
| `UPDATE_REPUTATION_SCORE` | →信誉 | `{traceId, entityId, entityType, components, evidence}` | 更新信誉分 | 同 :74-76 |
| `APPLY_REPUTATION_PENALTY` | →信誉 | `{traceId, entityId, entityType, penalty}` | 信誉惩罚 | 同 :78-80 |
| `FORM_COALITION` | →联盟 | `{traceId, coalitionName, initialMembers, initialResources}` | 组建联盟 | src/core/society/coalition.ts:35-37 |
| `ALLOCATE_COALITION_PAYOUT` | →联盟 | `{traceId, coalitionId, totalPayoutPool, reputationSnapshot}` | 联盟分账 | 同 :39-41 |
| `EXECUTE_ROLE_EVOLUTION` | →角色演化 | `{traceId, agentId, currentReputation, previousRole, tickId?}` | 角色演化 | src/core/society/role-evolution.ts:45-47 |
| `ASSESS_GOVERNANCE_TARGET` | cluster-orchestrator→Governance | `{traceId, targetId, targetType, effectiveness, violations, notes}` | 治理评估（每 100 tick） | src/core/society/governance.ts:91-93 |
| `TRIGGER_GOVERNANCE_ACTION` | →Governance | `{traceId, policyId, triggerType, targetId}` | 治理动作 | 同 :95-97 |
| `GOVERNOR_PROCESS_TELEMETRY` | ai-runtime→AI 域 | `{traceId, tickId, telemetry:TelemetryVector}` | 遥测→ShadowRequest | src/kernel/domains/ai-runtime.ts:38 |
| `MIGRATE_SANDBOX_CONTEXT` | watchdog→沙箱 | `{traceId, agentId, targetSlotId, evictionReasonCode}` | V8 超限迁移沙箱 | src/kernel/sandbox/isolation-slot.ts:56-58 |
| `DECISION_COMMIT_REQUEST` | ai-runtime→(无 handler) | `{traceId, tickId, systemCpu, timestamp}` | 竞价决策（passthrough） | src/kernel/domains/ai-runtime.ts:64-70 |

---

## 6. EventBus（进程内事件）

自动附加 `{timestamp, traceId: global.__CURRENT_TRACE_ID}`。

- **RuntimeEvent**（25 个）: `kernel.initialized, runtime.mode.changed, runtime.shutdown, runtime.recovery, command.accepted, command.rejected, transaction.committed, transaction.rolledback, sys.heartbeat, sys.tick, system.log, telemetry.marl, ai.runtime.tick, court.phase1.completed, court.phase2.completed, projection.updated, snapshot.created, audit.recorded, span.recorded, governor.reputation.increment.requested, society.agent.role.evolved, agent.task.dispatched, agent.task.executed, agent.dispute.raised, agent.reputation.updated`
- **CourtEvent**（5 个）: `court:claim_submitted, court:evidence_evaluated, court:arbitration_decided, court:deadlock_detected, court:escalation_triggered`
- **DecisionEvent**（6 个）: `decision:route_requested, decision:route_completed, decision:confidence_calculated, decision:vote_triggered, decision:adaptive_penalty_applied, decision:marl_policy_injected`
- **字符串字面量事件**: `phase0_subtask / phase0_skip / phase1_worker_start / phase1_worker_done / phase1_worker_error / phase2_judge / phase2_judge_error / phase3_deliver_start / phase3_deliver_done / worker_started / worker_chunk / worker_done / worker_failed / worker_stopped_by_judge / tool_call / pool_share / dispatch_done / governance.intervention.applied / telemetry.entropy.updated / drift.governance_intervention / shadow.decision.recorded / training_triggered`
- **TransactionCommitted 载荷**: `{domain, txId, version, traceId, data}` — 12 个 consumer 订阅（src/data/consumers/）

---

## 7. Garnet 桥（Redis Streams, 6379）

| 项 | 内容 | 位置 |
|---|---|---|
| 监听事件（7 个） | `sys.heartbeat, governor.reputation.increment.requested, society.agent.role.evolved, transaction.committed, audit.recorded, system.log, ai.runtime.tick` | src/data/garnet/garnet-bridge.ts:16-24 |
| 写入 | `stream:events` XADD `event=<名>`, `data=JSON{eventName, payload, bridgedAt}` | 同 :27,47-51 |
| 预留未用 | `stream:gov_decisions`, `stream:reputation`（只有常量无写入） | 同 :28-29 |
| 队列 | `stream:tasks`（group task-processors）、`stream:events`（group event-consumers, XREAD BLOCK 5000） | src/data/garnet/queue.ts:10-15 |
| UI 侧 | garnetClient RESP3 over `ws://127.0.0.1:6380`（port+1 代理），失败走内存 fallback | UI/src/services/canvas/garnetClient.ts:70-74 |

---

## 8. Java Agent TCP（8771, JSON 行, messageId 关联 30s 超时）

| 消息 type | 方向 | 载荷 | 用途 | 位置 |
|---|---|---|---|---|
| `ping` / `pong` | Node↔Java | — | 心跳 | src/core/agent/tcp-integration.ts:41 |
| `dispatch` | N→J | `{type, dispatchId, chatId, prompt, workers[], settings, tools[], permissionMode}` | 派发多 worker 任务 | 同 :145-157 |
| `worker_started` | J→N | `{dispatchId, workerIdx, agentId}` | worker 启动 | tcp-client.ts:133 |
| `worker_chunk` | J→N | `{dispatchId, workerIdx, content, agentId}` | 流式增量（600 字符阈值裁判） | 同 :136 |
| `worker_done` | J→N | `{dispatchId, workerIdx, output}` | worker 完成 | 同 :139 |
| `worker_failed` | J→N | `{dispatchId, workerIdx, error}` | worker 失败 | 同 :142 |
| `tool_call` | J→N | `{dispatchId, workerIdx, tool, args}` | 工具调用 → ToolResultRelay (bu_*/browser_*/powershell/win_reg_read/console/network/dom_inspect...) | tcp-integration.ts:95-102 |
| `tool_result` | N→J | `{type, dispatchId, workerIdx, tool, args, result}` | 工具结果回传 | 同 :175-185 |
| `evaluate`(action=STOP) | N→J | `{type:'evaluate', dispatchId, action:'STOP', workerIdx?}` | 裁判喊停 | 同 :207-214 |
| `pool_share` | J→N | `{dispatchId, entries[]}` | 共享池同步 | tcp-client.ts:148 |
| `dispatch_done` | J→N | `{dispatchId}` | 派发结束清理 | 同 :151 |

---

## 9. PS Worker（Electron ↔ PowerShell, 管道行协议）

命令 `CMD|arg|arg`；ACK: `OK` / `PONG ...` / `ERR msg`；启动先 `READY`；FIFO 单命令在飞。

| 命令 | 参数 | 作用 | main.cjs 位置 |
|---|---|---|---|
| `PING` | `hwnd` | GetWindowRect 探活 | :908-914 |
| `SUBCLASS` | `hwnd` | WndProc hook 拦截 WM_NCHITTEST→HTCLIENT | :915-921 |
| `MOVE` | `hwnd,x,y` | SetWindowPos 0x0415 | :922-936 |
| `RESIZE` | `hwnd,x,y,w,h` | SetWindowPos 0x0414 | :937-942 |
| `SYSMAX` | `hwnd` | WM_SYSCOMMAND+SC_MAXIMIZE | :943-948 |
| `SYSREST` | `hwnd` | SC_RESTORE | :949-954 |
| `DRAG_START` | `hwnd,winX,winY,mouseX,mouseY` | 8ms 线程跟随拖拽 | :955-984 |
| `DRAG_STOP` | — | 停拖拽线程 | :985-991 |
| `QUIT` | — | 退出 | :901 |

---

## 10. Raft 共识（进程内经 CommandBus）

节点 id `node_alpha_master`；peers 默认空 → 单节点自动晋升 LEADER（无网络传输层）。

| 消息 | 方向 | 载荷 | 用途 |
|---|---|---|---|
| `RECEIVE_REQUEST_VOTE_RPC` | Candidate→peer | `{term, candidateId, lastLogIndex, lastLogTerm}` → `{term, success, responderId}` | 选举（5s 超时+抖动） |
| `RECEIVE_APPEND_ENTRIES_RPC` | Leader→peer | `{term, leaderId, prevLogIndex, prevLogTerm, entries[], leaderCommitIndex}` → 含 matchIndex | 日志复制+1.5s 心跳 |
| `RaftLogEntry` | 日志 | `{term, index, command:{type,payload}, causalityChecksum:sha256(payload+index)}` | 因果校验 |
| `submitCommand` | 外部→共识层 | 任意命令 | 单节点直接提交 → TransactionCommitted |

---

## 11. Electron IPC（main ↔ renderer, contextBridge `window.soloforge`）

共 **46 个唯一通道**：41 个 handle（main.cjs 19 + local-llm-manager.cjs 22）+ 5 个 main→renderer 推送。全部 invoke 请求-响应模式，渲染层零直接 ipcRenderer 引用。

### 11.1 window 组（12 handle + 2 推送）
| 通道 | 载荷 → 返回 | 用途 | 状态 |
|---|---|---|---|
| `window:minimize` | — → void | 最小化 | [活跃] |
| `window:toggle-maximize` | — → bool | 最大化/还原切换（原生路径） | [活跃] |
| `window:restore` | — → void | 还原 | [孤儿] 无调用 |
| `window:close` | — → void | 关闭窗口 | [活跃] |
| `window:is-maximized` | — → bool | 查询最大化状态 | [活跃] |
| `window:maximize-state` | — → 触发推送 | 订阅回推触发器 | [活跃] |
| `window:move-to` | `{x,y}` → bool | 绝对坐标移动（保留 fallback） | [孤儿] |
| `window:resize-to` | `{x,y,w,h}`(min 1024×640) → bool | 绝对坐标缩放（PS Worker RESIZE） | [断裂] preload 暴露为顶层 `soloforge.resizeWindow`，消费方曾读错路径 |
| `window:get-bounds` | — → bounds | 查询窗口边界 | [孤儿] |
| `window:drag-start` | — → bool | 启动拖拽跟随（PS Worker DRAG_START） | [孤儿] Header 改用 CSS drag |
| `window:drag-stop` | — → bool | 停止拖拽 | [孤儿] 同上 |
| `titlebar:overlay` | `{color,symbolColor}` → bool | 主题切换同步原生按钮区颜色 | [活跃] |
| `window:maximize-state-changed` 推送 | bool | 最大化状态变化 | [活跃] |
| `drag-state` 推送 | bool | 拖拽中（禁用 backdrop-filter） | [孤儿] 触发源无调用 |

### 11.2 app / dialog / fs 组（3）
| 通道 | 载荷 → 返回 | 用途 | 状态 |
|---|---|---|---|
| `app:reload` | — → `{ok}` | 清缓存完整重载 | [孤儿] 渲染层用 location.reload |
| `dialog:select-folder` | — → `{path,name}\|null` | 工作区文件夹选择 | [活跃] |
| `fs:read-dir-tree` | `{dirPath,maxDepth?}` → `{tree}` | 递归目录树 | [活跃] |

### 11.3 proxy 组（4）
| 通道 | 载荷 → 返回 | 用途 | 状态 |
|---|---|---|---|
| `proxy:get-config` | — → ProxyConfig | 读代理配置（system/direct/manual/pac） | [活跃] |
| `proxy:apply` | ProxyConfig → `{ok}` | 应用代理（Chromium session + Node env + 持久化） | [活跃] |
| `proxy:test` | — → `{ok,ip?,latency?}` | 连通测试（httpbin/ipify/ipinfo 三端点容灾） | [活跃] |
| `proxy:system-info` | — → 系统代理信息 | 读 OS 系统代理（注册表） | [活跃] |

### 11.4 localLLM 组（22 handle + 3 推送, node-llama-cpp v2）
`list / add{path} / remove{path} / delete{path} / browse / load{path,params} / unload / status / device(硬件检测+推荐参数) / start-server / stop-server / server-running / chat{text,streamId} / chat-abort{streamId} / chat-reset / get-infer-params / set-infer-params / reset-infer-params / metrics / http-server-info / start-http-server{host,port} / stop-http-server` — 全部 [活跃]。
推送: `local-llm:token:${streamId}` / `local-llm:done:${streamId}` / `local-llm:error:${streamId}` — 全部 [活跃]。

### 11.5 备注
- canvas 组（20+ 通道）全部注释（画布重构中），通道名已预留
- 孤儿通道 7 个：restore / move-to / get-bounds / drag-start / drag-stop / drag-state(推) / app:reload
- 断裂通道 1 个：resize-to（已修复消费方读取路径）
- proxy-service.cjs / settingsStorage.cjs 无 IPC（纯服务类）

### 11.1 window 组（12）
| 通道 | 载荷 → 返回 | 用途 |
|---|---|---|
| `window:minimize` | — → void | 最小化 |
| `window:toggle-maximize` | — → bool | 最大化/还原切换（原生路径） |
| `window:restore` | — → void | 还原 |
| `window:close` | — → void | 关闭窗口 |
| `window:is-maximized` | — → bool | 查询最大化状态 |
| `window:maximize-state` | — → 推送 bool | 请求推送状态 |
| `window:move-to` | `{x,y}` → void | 绝对坐标移动窗口（PS Worker MOVE） |
| `window:resize-to` | `{x,y,width,height}` → bool | 绝对坐标缩放（PS Worker RESIZE, 最小 1024×640） |
| `window:get-bounds` | — → bounds | 查询窗口边界 |
| `window:drag-start` | — → void | 启动 PS Worker 拖拽跟随（DRAG_START） |
| `window:drag-stop` | — → void | 停止拖拽（DRAG_STOP） |
| `titlebar:overlay` | `{color,symbolColor}` → bool | 主题切换时同步原生按钮区颜色 |

推送通道: `window:maximize-state-changed`(main→renderer, bool)。

### 11.2 app / dialog / fs 组（3）
| 通道 | 载荷 → 返回 | 用途 |
|---|---|---|
| `app:reload` | — → void | 渲染层触发完整重载 |
| `dialog:select-folder` | — → path\|null | 工作区文件夹选择 |
| `fs:read-dir-tree` | `{dirPath}` → 目录树 | 工作区文件树恢复 |

### 11.3 proxy 组（4）
| 通道 | 载荷 → 返回 | 用途 |
|---|---|---|
| `proxy:get-config` | — → 配置 | 读代理配置（system/direct/manual/pac 四模式） |
| `proxy:apply` | 配置 → 结果 | 应用代理 |
| `proxy:test` | — → 测试结果 | 连接测试 |
| `proxy:system-info` | — → 系统代理信息 | 读系统代理 |

### 11.4 localLLM 组（22, node-llama-cpp v2）
`list / add{path} / remove{path} / delete{path} / browse / load{path,params} / unload / status / device / start-server / stop-server / server-running / chat / chat-abort / chat-reset / get-infer-params / set-infer-params / reset-infer-params / metrics / http-server-info / start-http-server / stop-http-server`
——本地模型库管理、推理控制、内置 OpenAI 兼容 HTTP 服务器托管。

推送通道: `drag-state`(main→renderer, bool, 拖拽时禁用 backdrop-filter)。

---

## 12. HTTP REST

### 12.1 RACER Core API（3001, Express）

**routes-agent（6）**
| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/agents/snapshot` | agent 池快照 |
| POST | `/api/agents/dispatch` | 派发任务（多 worker） |
| POST | `/api/agents/bindSubTask` | 绑定子任务 |
| POST | `/api/agents/dispute` | 提交争议 |
| GET | `/api/test/reputation-bridge-status` | 信誉桥测试 |
| POST | `/api/test/reputation-enqueue` | 信誉入队测试 |

**routes-canvas（6）**
| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/canvas/relay/ports` | 查询 Flutter 渲染端口表 |
| POST | `/api/canvas/relay/register-port` | 注册渲染端口 |
| POST | `/api/canvas/relay/unregister-port` | 注销 |
| POST | `/api/canvas/relay/push-ui` | UI 推送 → 转发 Flutter `/render` |

**routes-system（约 25）**
| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/status` | 系统状态仪表盘 |
| GET | `/api/health` | 健康探针 |
| GET | `/api/agents` | agent 列表 |
| GET | `/api/kernel/status` / `/api/kernel/health` / `/api/kernel/events` | 内核状态/健康/事件 |
| GET | `/api/database/stats` / `/api/db/schema` | 数据库统计/schema |
| GET | `/metrics` | Prometheus 指标 |
| GET | `/api/events/list` | 事件列表 |
| GET | `/api/scheduler/stats` / `/api/scheduler/queue` | 调度器统计/队列 |
| GET/POST | `/api/observation/data` / `start` / `stop` / `clear` | 观测子系统 |
| GET/POST | `/api/archiver/stats` / `check` / `start` / `stop` | 归档器 |
| POST | `/api/terminal/run` | 执行 shell 命令 |
| POST | `/api/names/update` | 自定义命名 |
| GET | `/api/llm/config` / `/api/llm/health` | LLM 配置/健康 |
| POST | `/api/chat/execute` | 启动 Java dispatch（非阻塞） |
| GET | `/` `/admin` `/ui` `/ui/*` `/test-nav` | 管理 UI 静态资源 |
| * | `/api/java-agent/*` | Java agent 代理 |

**routes-tool-execute（1）**
| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `tool_execute` | Java Agent 工具调用入口 → 按 tool 名路由 Obscura / Browser-Use / Windows-MCP，回传原始结果 |

**routes-vault + audit + auth（15）**
| 方法 | 路径 | 用途 |
|---|---|---|
| GET/POST/PUT/DELETE | `/api/vault/keys` `/api/vault/keys/:id` `/api/vault/keys/:id/reveal` `/api/vault/keys/:id/verify` | 密钥库 CRUD/揭示/校验 |
| POST | `/api/vault/export` `/api/vault/import` `/api/vault/verify-passphrase` | 密钥库导入导出 |
| GET | `/api/auth/bootstrap` | 认证引导 |
| GET/POST | `/api/audit/list` `/api/audit/stats` `/api/audit/sinks` `/api/audit/sinks/config` | 审计查询/sink 配置 |

**SSE**: `GET /api/events/stream`（3001, Server-Sent Events 审计/事件流）。
**WS**: `/ws/agents`（见 §1）。

### 12.2 UI 本地 API（4000, UI/server.ts）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET/POST | `/api/providers/config` `/api/providers/test` `/api/providers/test-batch` `/api/providers/model-probe` `/api/providers/model-detail` `/api/providers/scan-models` `/api/providers/refresh-model-db` `/api/providers/model-db-status` `/api/providers/probe-cache/:providerId` | 模型供应商管理/探测（10 条） |
| GET/POST | `/api/custom-rules` | 自定义规则 |
| GET | `/api/events/stream` | SSE 事件流（代理 3001） |
| GET | `/api/skills/content` | 技能内容 |
| GET/POST | `/api/resources/active` `/api/resources/:type/manifest` | 资源清单 |
| GET | `/api/system-metrics` | 系统指标 |
| GET/POST | `/api/tools/schemas` `/api/tools/invoke` | 工具 schema/调用 |
| GET | `/api/auth/startup-token` | 启动 token 引导 |
| POST | `/api/channels/test` `/api/debug-log` | 渠道测试/调试日志 |
| GET | `/ws` `/ws/*` | WS 代理 → 3001 |
| GET | `*` | 静态资源/SPA fallback |

### 12.3 git-service（3002, Go）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/git/health` | 健康探针 |
| GET/POST | `/api/git/status` `/api/git/init` `/api/git/config` | 仓库状态/初始化/配置 |
| POST | `/api/git/add` `/api/git/commit` `/api/git/push` | 暂存/提交/推送 |
| GET | `/api/git/branches` `/api/git/diff` `/api/git/file-diff` | 分支/差异 |
| POST | `/api/git/checkout` `/api/git/resolve-conflict` | 切换/解决冲突 |

### 12.4 Agent Advisor（8770, Java Spring）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` `/status` | 健康探针/状态 |
| GET/POST/DELETE | `/api/agents` `/api/agents/{id}` | Agent CRUD |
| GET | `/tasks` `/status/{agentId}` `/history/{agentId}` | 任务/状态/历史 |
| GET/POST | `/cases` `/cases/{id}` `/cases/{id}/included` | 案例 |
| POST | `/optimize` `/result` `/stream`(SSE) | 优化/结果/流式 |


---

## 13. 重写目标映射（新架构中每条协议的去向）

| 现有机制 | 新架构去向 |
|---|---|
| CommandBus 命令 | Go core 进程内总线（签名按 protocol.md 收敛） |
| EventBus 事件 | events 表 + WS 桥（events 表即审计即重放源） |
| AgentEventHub WS | core WS `/ws` 单一通道（合并 event/agent/court 流） |
| Garnet 桥/队列 | 进程内缓存 + events 表（Garnet 移除） |
| Kafka 审计 | events 表即审计（Kafka 移除） |
| DistributedBroker/ShadowGovernor/Training TCP | marl-worker WS 客户端接 core 总线（保留消息语义） |
| Java TCP 8771 | advisor WS 客户端接 core 总线（保留 dispatch/chunk/tool 语义） |
| PS Worker | Tauri 原生窗口 API（全部移除） |
| Raft（单节点） | Go core 内简化共识（单机场景可退化为事件序） |
