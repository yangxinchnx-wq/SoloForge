# SoloForge D8 / D9 集成联调报告

**日期**: 2026-06-30
**对应 plan 章节**: 数据库升级方案.md §11.2 (D8), §11.3 (D9)
**零破坏**: ✅ 全程未修改任何 .pt / .db / .py 已有业务文件

---

## 1. 阶段 4 总览

| 步骤 | 内容 | 状态 |
|---|---|---|
| C6 | 导出 policy.onnx (Actor 12→64→64→32→3) | ✅ |
| C7 | INT8 量化 policy_int8.onnx | ⚠️ 跳过 (PyTorch 2.12 dynamo 导出器 shape_inference bug, 详见 §4) |
| C8 | 导出 critic_warmed_v2.onnx (5→64→64→1) | ✅ |
| C9 | server_prod.py ONNX runtime 推理路径 | ✅ |
| C10 | MARL_USE_ORT 环境变量 + PyTorch 兜底 | ✅ |
| D8 | full_chain_test.py (6 场景) | ✅ 6/6 PASS |
| D9 | bin/integration-smoke.mjs + --with-smoke | ✅ |

---

## 2. ONNX 导出结果 (C6/C8)

执行: `python tools/export_marl_to_onnx.py`

| 模型 | 源 .pt | 导出 .onnx | 大小 | 验证 (onnxruntime 1.27) |
|---|---|---|---|---|
| Actor (12 → 3) | policy.pt | policy.onnx | 2.4 KB | ✅ out_shape=[1,3], mean=0.043 |
| Critic (5 → 1) | critic_warmed_v2.pt | critic_warmed_v2.onnx | 1.9 KB | ✅ out_shape=[1,1], mean=1.962 |
| Actor INT8 | policy.onnx | policy_int8.onnx | — | ⚠️ 跳过 (见 §4) |
| Critic INT8 | critic_warmed_v2.onnx | critic_int8.onnx | — | ⚠️ 跳过 (见 §4) |

---

## 3. 后端切换验证 (C9/C10)

测试脚本: python/_c9_onnx_backend_test.py (已删除, 数据保留)

| 后端 | backend 字段 | valueEstimate 范围 | 一致性 (vs PyTorch) |
|---|---|---|---|
| PyTorch (默认) | "none" | -0.21 ~ 1.96 | 基准 |
| ONNX (MARL_USE_ORT=1) | "onnx" | -0.21 ~ 1.96 | max diff < 4.7e-7 |

5 个不同 load (0.1, 0.3, 0.5, 0.7, 0.9) 输入下, PyTorch 与 ONNX 输出差异在浮点精度范围内 (1e-7 级), 可视为完全一致。

---

## 4. C7 INT8 量化失败说明

**原因**: PyTorch 2.12.1 配合 dynamo 导出器生成的 ONNX 算子图, onnxruntime.quantization.quantize_dynamic 的 shape_inference 步骤无法正确推导 MatMul/Linear 节点的中间维度, 报:
```
onnx.onnx_cpp2py_export.shape_inference.InferenceError:
[ShapeInferenceError] Inferred shape and existing shape differ in dimension 0: (12) vs (64)
```

**缓解**:
- 模型极小 (2.4 KB / 1.9 KB), INT8 量化收益几乎可忽略
- Float32 .onnx 已满足 ONNX runtime 推理需求, 不阻塞 D8 集成测试
- C7 的实操路径已记入 backlog, 待 PyTorch 官方修复或改用 onnxruntime 的 QuantFormat.QDQ + 手工 CalibrationDataReader

---

## 5. D8 集成联调 (6 场景)

执行: `python tests/integration/full_chain_test.py`
Node 包装: `node bin/integration-smoke.mjs`

| 场景 | 状态 | 关键指标 | 阈值 |
|---|---|---|---|
| S1 JSON RPC 落库 | ✅ PASS | 落库延迟 21ms (首次) / 5ms (warm-up 后) | < 300ms |
| S2 Qdrant 检索 | ✅ PASS | 检索 38ms, hit=3, top_score=0.703 | < 200ms |
| S3 MARL ONNX 推理 | ✅ PASS | 平均 0.11ms, 范围 [-2.22, 0.43] | < 10ms |
| S4 DuckDB 报表 | ✅ PASS | 188ms, 13 张表行数 | < 1500ms |
| S5 MiniLM 跨语种 | ✅ PASS | zh↔en 平均相似度 0.763 | > 0.4 |
| S6 JSON RPC 端到端 | ✅ PASS | 6 消息→5 落库, 1 重复被幂等拦截 | — |

**最近一次完整 run (2026-06-30 18:02)**:
- 6/6 PASS, 0 SKIP, 0 FAIL
- 总耗时: 89.3s (含 sentence-transformers 冷启动)
- 退出码: 0
- JSON 报告: `bin/logs/integration/smoke-1782813742731.json`

---

## 6. D9 自动化 (CI/手动集成)

### 6.1 Node 入口: `bin/integration-smoke.mjs`

| 命令 | 作用 |
|---|---|
| `node bin/integration-smoke.mjs` | 跑全部 6 场景 |
| `node bin/integration-smoke.mjs --skip-onnx` | 跳过 MARL ONNX 场景 |
| `node bin/integration-smoke.mjs --only S1` | 只跑 S1 |
| `node bin/integration-smoke.mjs --timeout 120` | 超时 120s |
| `node bin/integration-smoke.mjs --report out.json` | JSON 报告指定路径 |

**退出码**:
- 0  全部 PASS / SKIP
- 1  至少一个 FAIL
- 2  超时 / 进程崩溃
- 3  端口未就绪

**特性**:
- 等 Qdrant 6333 端口就绪再跑 (默认 30s 超时)
- 调起 `python.bat full_chain_test.py --json` 子进程
- 解析 `###RESULT### {json}` 锚点行 (避免 stdout 控制字符干扰)
- 报告默认写到 `bin/logs/integration/smoke-{ts}.json`

### 6.2 启动器集成: `start-ai-society-db.mjs start --with-smoke`

```bash
node bin/start-ai-society-db.mjs start --with-smoke
# 启动 BadgerDB + Qdrant + DuckDB
# 跑 full_chain_test.py 6 场景
# 退出码 0 → 集成联调全部 PASS
```

零破坏: 默认 `start` 行为不变, `--with-smoke` 是可选 flag。

---

## 7. 零破坏清单

| 文件 | 操作 | 备注 |
|---|---|---|
| `python/tools/export_marl_to_onnx.py` | **新建** | 导出工具 |
| `python/marl_service/models/policy.onnx` | **新建** | C6 产物 |
| `python/marl_service/models/critic_warmed_v2.onnx` | **新建** | C8 产物 |
| `python/marl_service/server_prod.py` | **追加** | C9/C10 ONNX 路径 + ONNX 可选启用 |
| `python/tests/integration/full_chain_test.py` | **新建 + JSON 输出** | D8 集成脚本 |
| `bin/integration-smoke.mjs` | **新建** | D9 Node 入口 |
| `bin/start-ai-society-db.mjs` | **追加** | `--with-smoke` 选项 |
| `python/marl_service/models/{policy,critic_warmed_v2}.pt` | **未动** | 原始 .pt 保留 |
| `python/data/ai_society/ai_society.db` | **未动** | 15 张业务表 hash 一致 |
| `python/soloforge_ai_society/**/*.py` | **未动** | 业务代码零破坏 |

---

## 8. 后续可选 (D10+)

- D10: Embedding 回填 — 把 social_memory / governance / law_violation 表的 text 字段走 MiniLM → Qdrant
- D11: 启动器接入 git-service + Node API server 全栈 smoke
- D12: MARL v4 蒸馏 (policy.pt 新架构训练 + export, 解决 C7 INT8 兼容)
- C7 重试: 改用 onnxruntime.quantization.quantize_static + 手工 CalibrationDataReader

---

## 9. 复现命令

```bash
# 1. 启 DB (Qdrant 6333)
node bin/start-ai-society-db.mjs start

# 2. 一键跑集成 (约 90 秒)
node bin/integration-smoke.mjs --timeout 180

# 3. 或者启 DB 顺便跑
node bin/start-ai-society-db.mjs start --with-smoke

# 4. 单独跑某个场景
node bin/integration-smoke.mjs --only S3

# 5. JSON 报告
node bin/integration-smoke.mjs --report bin/logs/my-report.json
```
