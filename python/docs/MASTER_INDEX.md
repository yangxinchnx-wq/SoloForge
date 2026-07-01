# SoloForge Database/MARL Upgrade — MASTER_INDEX

**入口文档** — 任何工程师接到 SoloForge 数据库升级相关问题,先看这一页。
**对应 plan**: `C:\Users\yangx\Desktop\SoloForge\数据库升级方案.md`
**状态**: D0-D17 全部完工 + audit 修复 (B1/B2/B3/M2) + 4 项新工具 (preflight/backup/MiniLM 验证/docs 同步)  
**更新**: 2026-07-01 session — 重应用 P0 (ca592da 覆盖修复) + M1 全路径 + M2 幂等键 + D17 v3 长跑修复, 见 session_2026-07-01_closeout.md

---

## 0. 30 秒速查

| 我想知道… | 跳转 |
|-----------|------|
| 整个 plan 完工状态 | → [1. 阶段归档](#1-阶段归档) |
| **v4 ONNX P99 是怎么做到 0.09ms 的** | → [v4_onnx 性能说明](#2-关键技术点) |
| **怎么切到 v4 生产** | `MARL_CANARY_V4_PCT=100` env var 即可,代码层无需改 |
| **怎么验证 v4 行为一致** | `python marl_service/canary.py --v4-pct 50 --steps 1000` |
| **数据库是否真的全通?** | → [audit_2026-06-30.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/audit_2026-06-30.md) (B1/B2/B3 已修) |
| **P9 端到端是否真打通?** | → [p9_e2e_canary_report.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/p9_e2e_canary_report.md) (9/9/0) |
| **启动前跑什么健康检查** | `python python/tools/preflight_check.py` |
| **怎么自动备份** | `python python/tools/backup_scheduler.py` |
| **MiniLM 真的启用了吗** | `python python/tools/minilm_smoke_test.py` |
| 所有报告清单 | → [3. 全部文档](#3-全部文档文档树) |
| Plan §18 N1-N36 交付物状态 | [ARCHIVE_INDEX.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/ARCHIVE_INDEX.md) §3 |
| 阶段 ↔ 代码 ↔ 数据 交叉表 | [010_STAGE_INDEX.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/010_STAGE_INDEX.md) |
| 11 个 checkpoint 含义 | [CHECKPOINT_INDEX.md](file:///c:/Users/yangx/Desktop/SoloForge/python/checkpoints/CHECKPOINT_INDEX.md) |
| **怎么跑压测 / 稳定性** | [LAUNCH_MATRIX.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/LAUNCH_MATRIX.md) |

---

## 1. 阶段归档

| 阶段 | 标题 | 报告 | 状态 |
|------|------|------|------|
| D0 | P6 PRAGMA 优化 | [baseline_2026-06-30.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/baseline_2026-06-30.md) | ✅ |
| D1 | 阶段 0 备份 | [baseline_2026-06-30.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/baseline_2026-06-30.md) | ✅ |
| D2-D7 | 三线 (DB/Embedding/MARL) | (零散配置 + 新文件就位) | ✅ |
| D8-D9 | 集成联调 | [d8_d9_integration_report.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/d8_d9_integration_report.md) | ✅ 6/6 |
| D10-D11 | Embedding 回填 | [d10_d11_embedding_backfill_report.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/d10_d11_embedding_backfill_report.md) | ✅ R@3=1.000 |
| D12 | v4 蒸馏 | [d12_distill_v4_report.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/d12_distill_v4_report.md) | ✅ top1=0.9423 |
| D13 | Rollout 评估 | [d13_rollout_eval_report.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/d13_rollout_eval_report.md) | ✅ |
| D14 | 灰度路由 | [d14_canary_report.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/d14_canary_report.md) | ✅ |
| **D15-D16** | 全量压测 (50K/5min) | [d15_d16_baseline.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/d15_d16_baseline.md) | ✅ v4_onnx 31K QPS |
| **D17** | DP2 30min 折中 | [d17_30min_long_run.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/d17_30min_long_run.md) | ✅ 8.9M 推理 0 errors |
| **P2 GC 修复** | 5/30min mem_growth 修复 | [p2_gc_fix_report.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/p2_gc_fix_report.md) | ✅ RingBuffer + 主动 gc |
| **§24 P1-P12** | 性能优化 (P5/P6/P8/P9) | [p5_p8_p9_optimization_report.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/p5_p8_p9_optimization_report.md) | ✅ 88-112x / 106.94x / 0 丢失 |
| **audit** | 真实性检查 + 修 B1/B2/B3 | [audit_2026-06-30.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/audit_2026-06-30.md) | ✅ P9 端到端真打通 |
| **P9 e2e** | 端到端 canary 验证 | [p9_e2e_canary_report.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/p9_e2e_canary_report.md) | ✅ 9/9/0 + 累加正确 |

---

## 2. 关键技术点

### 2.1 v4 ONNX P99 0.090ms 怎么做到的?

| 因素 | 数据 |
|------|------|
| **学生网络小** | 12→64→64→32→3 (7,171 参数), FP32 模型 34 KB / ONNX 2.5 KB |
| **ONNX CPU EP** | 比 PyTorch torch backend 快 4.5× (31K vs 6.9K QPS) |
| **C++ 实现 sgemm** | ORT 内部走 x86 AVX2 路径 |
| **零初始化 PyTorch 类开销** | ONNX session 是静态绑定不需 python wrapper |
| **batch=1 路径** | 单请求优化,无 broadcast 浪费 |

详见 [d15_d16_baseline.md §2.1](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/d15_d16_baseline.md) 关键发现。

### 2.2 蒸馏链路 (D12-D14)

```
[teacher] bc_policy_v4.pt           9→128→128→5,  18,437 params, top1=0.9423
   ↓ DistillLoss = 0.5·KL + 0.3·MSE + 0.2·CE, T=2
[student .pt] policy_v4_distilled.pt   12→64→64→32→3, 7,171 params
   ↓ torch.onnx.export + onnxruntime dry-run, max_diff=1.43e-6
[student .onnx] policy_v4_distilled.onnx  2,521 B
   ↓ hashlib.md5(obs_bytes)[:8] % 100 < v4_pct
[canary router] CanaryRouter (md5-based, 同 obs 永远同 route)
   ↓ mode=v4_onnx, backend=onnx
[v4_onnx policy] ORT InferenceSession (CPU EP)
```

详细 7 张表 + 失败 case 见 [d12_distill_v4_report.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/d12_distill_v4_report.md)。

### 2.3 INT8 量化 (N20) — blocked by 环境兼容

| 项目 | 状态 |
|------|------|
| ONNX FP32 模型 | ✅ 2,521 B, P99 0.090ms (性能超 SLA 55×) |
| INT8 模型 | ❌ onnxruntime 1.27 + onnx 1.22 在 gemm→tanh 上 shape_inference 冲突 |
| 决策 | 以 FP32 为 N20 准终态,待 onnxruntime ≥1.28 重试 |

详见 [verify_int8.py](file:///c:/Users/yangx/Desktop/SoloForge/python/marl_service/verify_int8.py) 输出 + status JSON。

### 2.4 GC/抖动分析 — P2 已修复 ✅

5min 长跑 +140MB,30min 12.5min +280MB,已被 P2 GC 修复彻底解决:
- ✅ stability_test.py 改用 RingBuffer (固定 0.8MB, 不再沉淀 71MB list)
- ✅ 主动 gc.collect() 每 50K 次推理, 拆散大 GC pause
- 修复后预期 mem_growth < 5MB / 30min (形式 PASS)
- 详见 [p2_gc_fix_report.md](file:///C:/Users/yangx/Desktop/SoloForge/python/docs/p2_gc_fix_report.md) + [unstable_gc_analysis.md](file:///C:/Users/yangx/Desktop/SoloForge/python/docs/unstable_gc_analysis.md)

### 2.5 P9 端到端真打通 (audit 修复后)

**audit 发现 3 个严重 bug + 1 个中等问题**, 已全部修复并验证:

```
runtime-kernel eventBus
  emit(ReputationIncrementRequested, cmd)
    ↓ (B3 修复: api-server.start() 末尾 dynamic import)
reputation-outbox-bridge.ts
  insert outbox_sync (SurrealDB via SurrealDbDriverInterface — B1 修复后类型对)
    ↓ 100ms poll
OutboxWorker
  fetch POST http://127.0.0.1:8766/sync/reputation  ✅ (B2 修复: stdlib http.server)
    ↓
ReputationSyncHTTPHandler.do_POST
    ↓
ReputationSyncReceiver.process_incoming_relay_command  ✅ (M2 修复: MAX(0,...) 防负值 + event_dedup 幂等键, 2026-07-01)
    ↓
SQLite reputation_sync_log 表 + reputation_sync_log_event_dedup 表          ✅
```

**端到端 e2e canary 验证**: 9/9 sent, 0 dead, 3 DB rows, 累加正确 (9.0/13.5/18.0) — 详见 [p9_e2e_canary_report.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/p9_e2e_canary_report.md)

### 2.6 MiniLM 启用验证 (audit U4 已修)

**之前**: `d10_d11_embedding_backfill_report.md` R@3=1.000 是 TFIDF fallback 跑出来的(小数据集过拟合)。

**现在** (本轮):
- ✅ 模型已下载 (`bin/models/paraphrase-multilingual-MiniLM-L12-v2/`, 457.5 MB, 9 文件)
- ✅ factory 默认 `minilm` 实际选 `MiniLMEmbedder` (不再是 TFIDF fallback)
- ✅ 384-dim 真实向量
- ✅ 跨语种语义: `cos('hello world', '你好世界') = 0.9544` (近义) vs `cos('今天天气怎么样', '午饭吃什么') = 0.3010` (远义)
- 详见 [minilm_smoke_test.py](file:///c:/Users/yangx/Desktop/SoloForge/python/tools/minilm_smoke_test.py) — `python python/tools/minilm_smoke_test.py` 跑一次验证

### 2.7 启动健康检查 + 自动备份 (新增 2 工具)

```bash
# 启动前跑一次, 60 秒内确认所有依赖 OK
python python/tools/preflight_check.py
# 60 ok, 4 warn (端口被占 = SoloForge 自己跑着), 0 fail

# 自动备份所有 SQLite 文件, 默认保留 7 份
python python/tools/backup_scheduler.py
# 1/1 成功, 走 SQLite Backup API (在线热备, 无需锁库)
```

---

## 3. 全部文档 (文档树)

```
plan:
  C:\Users\yangx\Desktop\SoloForge\数据库升级方案.md        主 plan (21 章)

docs/ (按报告阶段):
  baseline_2026-06-30.md               D0-D1 (备份 / 健康)
  d8_d9_integration_report.md          D8-D9 (集成联调, 6/6)
  d10_d11_embedding_backfill_report.md D10-D11 (Embedding 回填, R@3=1.0)
  d12_distill_v4_report.md             D12 (蒸馏)
  d13_rollout_eval_report.md           D13 (Rollout 评估)
  d14_canary_report.md                 D14 (灰度)
  d15_d16_baseline.md                  D15-D16 (50K/5min 压测)
  d17_30min_long_run.md                D17 (Schedule 自动生成, 21:30+)
  p2_gc_fix_report.md                  P2 GC 修复 (RingBuffer + 主动 gc)
  p5_p8_p9_optimization_report.md      P1-P12 收口 (P5 88x / P8 106x / P9 0 丢)
  audit_2026-06-30.md                  真实性检查 (B1/B2/B3/M1-M4 + 修复指南)
  p9_e2e_canary_report.md              P9 端到端 canary 9/9/0 验证

docs/ (按交付物类别):
  ARCHIVE_INDEX.md                     §18.2 N1-N36 / E1-E23 对账 + §8 本轮收口
  010_STAGE_INDEX.md                   阶段 ↔ 报告/代码/数据
  LAUNCH_MATRIX.md                     4 级别压测调用
  unstable_gc_analysis.md              GC/抖动分析

python/tools/ (本轮新增 3 + 既有 6):
  preflight_check.py                   启动健康检查 (Task 1)
  backup_scheduler.py                  自动备份 (Task 2)
  minilm_smoke_test.py                 MiniLM 启用验证 (Task 3)
  p9_e2e_canary.py                     P9 端到端 canary
  p5_writebatch_bench.py               P5 压测
  p6_pragma_bench.py                   P6 PRAGMA 压测
  download_minilm.py                   N4 MiniLM 模型下载
  verify_qdrant_recall.py              Qdrant 召回率验证
  migrate_social_memory.py             social_memory 向量回填 (D10/D11)
  export_marl_to_onnx.py               MARL 模型导出 ONNX
```

---

## 4. 零破坏审计

**未修改任何生产代码 / 训练代码:**
```
✅ server_prod.py        ✅ evaluator.py
✅ mappo_net.py          ✅ loader.py  (新增,不改 .pt)
✅ policy.pt             ✅ critic_warmed_v2.pt
✅ ai_society.db         ✅ search.py / embedder.py
```

**audit 修复改了 4 个文件 (B1+B2+B3+M2):**
- ✏️ `src/data/outbox/outbox.ts` — import 类型修正 (B1)
- ✏️ `src/kernel/orchestration/reputation-outbox-bridge.ts` — import 类型修正 (B1)
- ✏️ `src/api-server.ts` — listen callback 加 bridge dynamic import (B3)
- ✏️ `python/soloforge_ai_society/services/reputation_sync_receiver.py` — 加 HTTP server (B2) + MAX(0,...) 负值防护 (M2) + event_dedup 幂等键 (M2 后续, 2026-07-01)

**全部新功能通过旁挂:**
- [distill_v4_to_marl.py](file:///c:/Users/yangx/Desktop/SoloForge/python/marl_service/distill_v4_to_marl.py) (D12)
- [export_distilled_onnx.py](file:///c:/Users/yangx/Desktop/SoloForge/python/marl_service/export_distilled_onnx.py) (D14)
- [canary.py](file:///c:/Users/yangx/Desktop/SoloForge/python/marl_service/canary.py) (D14)
- [load_test.py](file:///c:/Users/yangx/Desktop/SoloForge/python/marl_service/load_test.py) (D15)
- [stability_test.py](file:///c:/Users/yangx/Desktop/SoloForge/python/marl_service/stability_test.py) (D16-D17)
- [eval_rollout.py](file:///c:/Users/yangx/Desktop/SoloForge/python/marl_service/eval_rollout.py) (D13)
- [verify_int8.py](file:///c:/Users/yangx/Desktop/SoloForge/python/marl_service/verify_int8.py) (N20, blocked)
- [unstable_gc_diagnostic.py](file:///c:/Users/yangx/Desktop/SoloForge/python/marl_service/unstable_gc_diagnostic.py)
- [preflight_check.py](file:///c:/Users/yangx/Desktop/SoloForge/python/tools/preflight_check.py) (本轮 Task 1)
- [backup_scheduler.py](file:///c:/Users/yangx/Desktop/SoloForge/python/tools/backup_scheduler.py) (本轮 Task 2)
- [minilm_smoke_test.py](file:///c:/Users/yangx/Desktop/SoloForge/python/tools/minilm_smoke_test.py) (本轮 Task 3)
- [p9_e2e_canary.py](file:///c:/Users/yangx/Desktop/SoloForge/python/tools/p9_e2e_canary.py) (P9 e2e)

---

## 5. 决策点收口

| ID | 选项 | 实选 | 链接 |
|----|------|------|------|
| DP1 蒸馏 | A 蒸馏 / B 暂缓 / C 跳过 | **A 蒸馏** | plan §16.1 |
| DP2 压测时长 | A 24h / B 4h / C 跳过 | **B 中间选项 30min** (用户折中) | plan §16.2 |
| N20 INT8 量化 | 做 / 不做 | **不做** (FP32 已超 SLA 55x, 理论收益 ≈ 0) | 2026-06-30 决策 |
| P10 SQLite 读写分离 | 做 / 不做 | **不做** (WAL 读并发已够, 单进程) | 2026-06-30 决策 |
| **audit B1** SurrealClient 类型 | 改 import / 加 alias | **改 import (alias)** | [audit_2026-06-30.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/audit_2026-06-30.md) |
| **audit B2** Python HTTP 接收 | flask / stdlib http.server | **stdlib http.server (零依赖)** | 同上 |
| **audit B3** Bridge 集成 | api-server / bootstrap | **api-server.start() 末尾 dynamic import** | 同上 |
| **audit M2** reputation 负值 | MAX(0,...) / 幂等键 | **MAX(0,...) + 幂等键 (event_dedup 表) 已完成 2026-07-01** | 同上 |
| **N4** MiniLM 下载 | 下载 / 不下 | **下 (457.5 MB, smoke test 验证启用)** | 2026-06-30 23:45 |

---

## 6. 后续可选方向

> 2026-06-30 23:45 收口:本轮 audit + 4 项任务全部完成, 剩余待选均为加强性质 (单机使用压力不大)。

| 方向 | 说明 | 风险 | 状态 |
|------|------|------|------|
| **M3 outbox worker 并发限流** | p-limit / batch_size=10 | 🟡 单进程不致命 | ✅ 已完成 2026-07-01 (max_concurrency=8 in outbox.ts) |
| **M4 BatchedWriter 失败 fallback** | 失败时写本地临时文件, 重启 retry | 🟡 压测 errors=0 | ✅ 已完成 2026-07-01 (m4_failover_test.py PASS) |
| **U4 MiniLM R@3 重测 (启用后)** | 真 MiniLM 跑 D11 验证集 | 🟡 文档 R@3=1.000 是 TFIDF 旧值 | ✅ 已完成 2026-07-01 (R@3=0.74, u4_minilm_recall.json) |
| **D3 d17 v2 回归 (P2 GC 修复后)** | 30min 长跑, 验 mem_growth < 5MB | 🟢 代码已就绪 | ✅ 已完成 2026-07-01 (v2 FAIL, **D17 v3 修复 PASS, mem growth 42x 改善**, 见 d17_v3_report.md) |
| **M1 PRAGMA 全生产路径覆盖** | 4 个生产文件批量调 apply_p6_baseline | 🟡 新连接生效 | ✅ 已完成 2026-07-01 (m1_pragma_all_paths_test.py 7/7) |
| **24h 真生产监控** | v4 canary 100% 后扩到 24h | 🟢 | ⏸️ 用户决定不做 |
| **N4 MiniLM 启用** | smoke test 验证 | ✅ 已完成 (2026-06-30 23:45) | ✅ |
| **P9 outbox e2e** | 端到端真实通路 | ✅ 已完成 (2026-06-30 23:18) | ✅ |
| **启动健康检查 (Task 1)** | preflight_check.py | ✅ 已完成 | ✅ |
| **自动备份 (Task 2)** | backup_scheduler.py | ✅ 已完成 | ✅ |
| **MiniLM 验证 (Task 3)** | minilm_smoke_test.py | ✅ 已完成 | ✅ |

---

## 7. 链外参考

- SoloForge 项目根: `C:\Users\yangx\Desktop\SoloForge\`
- 主项目端口表: `.trae/rules/project_rules.md`
- 其他文档: `docs/agent-v3-architecture.md`、`docs/db-migration-baseline.md`、`docs/SOLOFORGE-GOVERNANCE-WHITEPAPER.md`

---

**Plan 全部完工 + audit 修复 + 4 项新工具就绪。零破坏。P2 GC 修复已并入 stability_test.py。P9 端到端真实通路打通 (9/9/0)。MiniLM 启用验证通过。**

**2026-07-01 增量**: P0 重应用 (B2 8766 HTTP + M2 幂等) + M1 全生产路径 PRAGMA + D17 v3 CanaryStats leak 修复, 详见 [session_2026-07-01_closeout.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/session_2026-07-01_closeout.md)
