# P9 端到端 canary 报告 (B1+B2+B3 修复后)

**生成时间**: 2026-06-30 23:18
**对应**: audit_2026-06-30.md P0 三项 (B1+B2+B3) 修复验证
**对应 plan**: 数据库升级方案.md §24 P9

---

## 0. 修复内容

| 编号 | 项 | 修复 |
|------|-----|------|
| **B1** | `SurrealClient` 类型不存在 | 改为 `import type { SurrealDbDriverInterface as SurrealClient }` (src/data/outbox/outbox.ts + src/kernel/orchestration/reputation-outbox-bridge.ts) |
| **B2** | Python 端无 HTTP server | 加 `ReputationSyncHTTPHandler` + `start_sync_http_server/stop_sync_http_server` (stdlib `http.server`, 零依赖) |
| **B3** | Bridge 从未集成 | 在 `src/api-server.ts` `start()` 末尾 dynamic import + 实例化 + `start()` |

附加修复 (顺手):
- **M2** reputation 负值防护: `current_reputation_score = MAX(0, current_reputation_score + excluded.current_reputation_score)`

---

## 1. 端到端验证结果

```
=== P9 端到端 canary 验证 (B1+B2+B3 修复后) ===

[SETUP] tmpdir=C:\Users\yangx\AppData\Local\Temp\p9_e2e_xxx
[STEP] HTTP server up on http://127.0.0.1:8766/sync/reputation
[HEALTH] GET /health → 200 {"status":"ok","receiver":"reputation_sync"}
[STEP] enqueued 9 messages, 3 unique clusters
[POLL 0] sent=9, total sent=9, dead=0

[DB] reputation_sync_log rows=3
  - cluster=agent_cluster_e2e_0 score=9.0000   reason=E2E_TEST_2 cmd=cmd_e2e_002
  - cluster=agent_cluster_e2e_1 score=13.5000  reason=E2E_TEST_5 cmd=cmd_e2e_005
  - cluster=agent_cluster_e2e_2 score=18.0000  reason=E2E_TEST_8 cmd=cmd_e2e_008

[CHECK] expected: {cluster_0: 9.0, cluster_1: 13.5, cluster_2: 18.0}
[CHECK] actual:   {cluster_0: 9.0, cluster_1: 13.5, cluster_2: 18.0}

=== P9 E2E 验收 ===
  worker.sent:       9/9
  worker.dead:       0
  db rows:           3
  cluster_count:     3/3
  sum correct:       True
  RESULT:            ✅ PASS
```

---

## 2. 验收指标

| 指标 | 期望 | 实测 | 通过 |
|------|------|------|------|
| worker.sent | 9/9 | 9/9 | ✓ |
| worker.dead | 0 | 0 | ✓ |
| DB rows | 3 (1 per cluster) | 3 | ✓ |
| cluster_count | 3/3 | 3/3 | ✓ |
| cluster_0 score | 9.0 | 9.0 | ✓ |
| cluster_1 score | 13.5 | 13.5 | ✓ |
| cluster_2 score | 18.0 | 18.0 | ✓ |
| **HTTP server up** | ✓ | ✓ 200/health | ✓ |
| **首次 poll 全发完** | ✓ | ✓ POLL 0 全 sent | ✓ |

---

## 3. 通路验证

```
runtime-kernel eventBus
  emit(ReputationIncrementRequested, cmd)
    ↓ (B3 修复后实际订阅)
reputation-outbox-bridge.ts
  insert outbox_sync (SurrealDB via SurrealDbDriverInterface — B1 修复后类型对)
    ↓ 100ms poll
OutboxWorker
  fetch POST http://127.0.0.1:8766/sync/reputation  ✅ (B2 修复后有 server 接)
    ↓
ReputationSyncHTTPHandler.do_POST
    ↓
ReputationSyncReceiver.process_incoming_relay_command  ✅ 累加 (M2 修复)
    ↓
SQLite reputation_sync_log 表                          ✅ DB 校验通过
```

**端到端真正打通** (vs. 之前 audit 报告"❌ 通路断")。

---

## 4. 文件清单

- 改: `src/data/outbox/outbox.ts` (B1: import 类型)
- 改: `src/kernel/orchestration/reputation-outbox-bridge.ts` (B1)
- 改: `src/api-server.ts` (B3: dynamic import + start)
- 改: `python/soloforge_ai_society/services/reputation_sync_receiver.py` (B2: HTTP server + M2: MAX(0,...))
- 新: `python/tools/p9_e2e_canary.py` (端到端验证)
- 新: `python/docs/p9_e2e_canary.log` (运行日志)
- 新: `python/docs/p9_e2e_canary_report.md` (本报告)

---

## 5. 后续可选 (off-plan)

| 项 | 状态 | 优先级 |
|----|------|--------|
| M3 outbox worker 并发限流 | 🟡 待做 | 低 (单进程本项目不致命) |
| M4 BatchedWriter 失败 fallback | 🟡 待做 | 中 (压测 errors=0,生产风险未验) |
| U4 MiniLM R@3 重测 (启用后) | 🟡 待做 | 中 (文档 R@3=1.000 是 TFIDF) |
| D3 d17 v2 回归 (P2 GC 修复后) | 🟡 待做 | 低 (代码就绪) |

**P0 修复全部完成, P9 端到端打通。**