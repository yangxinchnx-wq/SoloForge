# SoloForge v4 Launch Matrix (LAUNCH_MATRIX)

**目的**: 提供 4 级别压测/验证矩阵, 让工程师在 DP2 (1h/4h/24h) 决策时有可复用入口。
**对应 plan**: §14.2 / §16.2 DP2 / §19.5 里程碑
**日期**: 2026-06-30

---

## 1. 矩阵总览

| 级别 | 时长 | 帧数 | 场景 | 命令 | 验收 SLA | 何时跑 |
|------|------|------|------|------|----------|--------|
| **Smoke** | 30s | ~150K 帧 | 快速冒烟 (sanity) | `python marl_service/stability_test.py --mode canary_100 --duration-sec 30 --sample-every 5 --output <out>` | ✅ errors=0, P99<10ms | **改代码后任何时候** |
| **Limited** | 5 min | ~1.7M 帧 | 短期稳定性 (D16 baseline) | `python marl_service/stability_test.py --mode canary_100 --duration-sec 300 --sample-every 30 --output <out>` | ✅ errors=0, P99<10ms | **每个 release 前** |
| **Medium** | 30 min | ~10M 帧 | DP2 中间折中 (D17) | `python marl_service/stability_test.py --mode canary_100 --duration-sec 1800 --sample-every 30 --output <out>` | ✅ P99<10ms, mem 增长 < 150MB | **v4 上线前** |
| **Full** | 4h (DP2 4h) / 24h (DP2 24h) | ~80M / ~480M 帧 | 生产前最终验证 | `python marl_service/stability_test.py --mode canary_100 --duration-sec 14400 --sample-every 60 --output <out>` | ✅ P99<10ms, errors=0, GC 释放不积压 | **DP2 决策后** |

---

## 2. 每级详细说明

### 2.1 Smoke (30s) — 冒烟测试

```powershell
cd C:\Users\yangx\Desktop\SoloForge\python
..\python.bat marl_service/stability_test.py `
  --mode canary_100 `
  --duration-sec 30 `
  --sample-every 5 `
  --output marl_service/models/_smoke.json
```

**预期输出** (基于 D17 smoke):
- ~150K 推理
- QPS ~5500 (canary_100 torch backend)
- P99 ~0.5ms
- mem +20-30MB / errors=0

**何时跑**: 改了 marl_service/canary.py 或 export_distilled_onnx.py 后,确认基础通路。
**零破坏**: 完全旁挂,不需重启任何服务。

### 2.2 Limited (5min) — 短期稳定性 (D16 已用)

```powershell
..\python.bat marl_service/stability_test.py `
  --mode canary_100 `
  --duration-sec 300 `
  --sample-every 30 `
  --output marl_service/models/_limited.json
```

**预期输出** (基于 D16 d16_canary_5min.json):
- ~1.77M 推理
- QPS ~5900
- P99 ~0.46ms
- mem +140MB / errors=0

**何时跑**: 每次 plan 阶段签名 (如 D15-D16 完工),作为提交证据。
**注意**: mem 增长 100-150MB 是 Python list 沉淀 (见 unstable_gc_analysis.md),非真泄漏。

### 2.3 Medium (30min) — DP2 折中 (D17 已用)

```powershell
..\python.bat marl_service/stability_test.py `
  --mode canary_100 `
  --duration-sec 1800 `
  --sample-every 30 `
  --output marl_service/models/_medium.json
```

**预期输出** (基于 D17 12.5min 实测):
- ~10M 推理
- QPS ~5000-6000 (偶有 GC pause 抖动至 1935)
- P99 0.4-1ms 常态 / 4.3ms 峰值
- mem +300-500MB / errors=0

**何时跑**: v4 模型替换 v3 前的最后一道验证。
**配套报告**: d17_30min_long_run.md 由 Schedule 作业自动生成 (21:30 daily)。

### 2.4 Full (4h/24h) — DP2 决策对应

```powershell
# 4h 版本 (DP2 推荐 B)
..\python.bat marl_service/stability_test.py `
  --mode canary_100 `
  --duration-sec 14400 `
  --sample-every 60 `
  --output marl_service/models/_full_4h.json

# 24h 版本 (DP2 选项 A, 高风险但更稳)
..\python.bat marl_service/stability_test.py `
  --mode canary_100 `
  --duration-sec 86400 `
  --sample-every 300 `
  --output marl_service/models/_full_24h.json
```

**预期输出**:
- 4h: ~80M 推理, mem ~+1.5GB 峰值
- 24h: ~480M 推理, mem ~+5GB 峰值
- 关键 SLA: P99<10ms 全程, errors=0, handles 稳定

**何时跑**:
- 4h: v4 canary 50% / 100% 后第一次灰度
- 24h: 生产 release 前最终验证

**注意**: 24h 测试可能需要 P2 修复 (不在测试前关闭 all_latencies 累积,详见 unstable_gc_analysis.md §5)。

---

## 3. 各场景的 mode 选择

`--mode` 选项:

| 模式 | 推理器 | 何时用 |
|------|--------|--------|
| `v3` | 旧 policy.pt (生产基线) | 与 v4 对比 (历史) |
| `v4_torch` | v4_distilled.pt + torch | 验证蒸馏一致性 |
| `v4_onnx` | v4_distilled.onnx + ORT CPU | 性能基线 (生产推荐) |
| `canary_100` | CanaryRouter 100% v4 | **默认推荐 (生产路径)** |

---

## 4. 验收清单 (Launch Checklist)

跑完每个级别后,查这 5 行:

```python
report = json.load(open(out_path))
assert report["errors"] == 0, f"❌ errors={report['errors']}"
assert report["sla_p99_under_10ms"], f"❌ P99={report['latency_ms']['p99']}"
assert report["sla_no_errors"], f"❌ errors>0"
# mem 阈值: smoke <30MB, limited <150MB, medium <500MB, full <1500MB
assert report["mem_growth_mb"] < expected_threshold, f"❌ mem {report['mem_growth_mb']}"
print("✅ all SLA pass")
```

---

## 5. 与 DP2 决策的对应

| DP2 选项 | 时长 | 用哪个级别 | 何时决 |
|----------|------|-----------|--------|
| A 24h | 86400s | **Full 24h** (§2.4) | v4 上线前最后验证 |
| B 4h (推荐) | 14400s | **Full 4h** (§2.4) | v4 canary 50/100% 后 |
| **中间 30min (D17 已选)** | 1800s | **Medium** (§2.3) | v4 上线前最后一道 |
| C 跳过 | — | Limited (§2.2) 足够 | — |

---

## 6. 后续 P2 改进 (可选)

| 项 | 影响 |
|----|------|
| stability_test.py 不累积 all_latencies | mem 增长减半 (60s 4.7MB vs 24.4MB) |
| 改用 RingBuffer (maxlen=10000) 滑动窗口 | 不再无限增长 |
| 每 sampling 主动 gc.collect() | 让大 GC pause 拆小 |
| 并行多 mode 批量跑 | 节省总耗时 |

详见 [unstable_gc_analysis.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/unstable_gc_analysis.md) §5。
