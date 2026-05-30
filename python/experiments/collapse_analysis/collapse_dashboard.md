# Collapse Analysis Dashboard

**Generated**: 2026-05-30 14:40:41

---

## Executive Summary

| Governor | Collapse Type | Pattern |
|----------|--------------|---------|
| BC | POLICY_FREEZE (100%) | 冻结在 no-op (action=2) |
| PPO | MIXED (50% overflow, 25% starve, 25% freeze) | 学会 expand 但不稳定 |

**核心发现**: BC 和 PPO 崩溃模式完全不同

---

## Q1: Collapse Type Distribution

| Type | Count | Rate |
|------|-------|------|
| **POLICY_FREEZE** | 6 | 66.7% |
| QUEUE_OVERFLOW | 2 | 22.2% |
| WORKER_STARVATION | 1 | 11.1% |
| ACTION_OSCILLATION | 0 | 0.0% |
| RESOURCE_EXHAUSTION | 0 | 0.0% |

---

## Q2: Tick-to-Collapse Distribution

| Percentile | Tick | Interpretation |
|------------|------|----------------|
| P50 | 499 | 中位在 episode 末尾才崩溃 |
| P90 | 499 | 90% 在末尾崩溃 |
| Min | 421 | 最早崩溃在 tick 421 |
| Max | 499 | 最大运行完整 500 ticks |

**观察**: 崩溃发生在 episode 后期，说明系统先稳定，然后逐渐失控

---

## Q3: Top Collapse Traces

| Rank | Governor | Type | Max Queue | Final Queue | Switch Rate |
|------|----------|------|-----------|-------------|-------------|
| 1 | BC | POLICY_FREEZE | 50,036 | 50,036 | 0.09 |
| 2 | BC | POLICY_FREEZE | 47,319 | 47,295 | 0.04 |
| 3 | PPO | POLICY_FREEZE | 21,980 | 21,979 | 0.00 |
| 4 | PPO | WORKER_STARVATION | 10,579 | 0 | 0.14 |
| 5 | PPO | QUEUE_OVERFLOW | 9,655 | 0 | 0.11 |

**观察**: BC 产生的 queue 更高，但 PPO 也有部分高 queue

---

## Q4: BC vs PPO Collapse Comparison

| Type | BC | PPO | Analysis |
|------|-----|-----|----------|
| POLICY_FREEZE | **5** | 1 | BC 100% freeze, PPO 25% freeze |
| QUEUE_OVERFLOW | 0 | 2 | BC 无 overflow, PPO 50% overflow |
| WORKER_STARVATION | 0 | 1 | BC 无 starve, PPO 25% starve |

---

## Root Cause Analysis

### Hypothesis 1: BC = Reward Hacking (Freezing)

**现象**: BC 100% 崩溃于 POLICY_FREEZE

**证据**:
- last_actions 全是 action=2 (no-op)
- action_switch_rate < 0.1
- queue 持续增长但从不调整

**假设**:
BC 学到了"不作为 = 短期 loss 低"
- no-op action 在训练数据中占比最高 (57.76%)
- BC 学会了"保持现状"而不是"适应变化"
- Reward 只惩罚当前 queue，不惩罚未来风险

**结论**: BC 陷入局部最优 = no-op

---

### Hypothesis 2: PPO = Over-Responsiveness

**现象**: PPO 75% 崩溃于 QUEUE_OVERFLOW/WORKER_STARVATION

**证据**:
- PPO 学会 expand 但没有学会收回
- 在高负载场景快速扩容，但 queue 仍爆炸
- 偶尔 freeze，说明探索过程中学到了 no-op 的"好处"

**假设**:
PPO 学到了"快速清队列"但没学到"长期稳定"
- PPO 强化 expand 行为以降低 queue
- 但强化 no-op 行为以降低 control cost
- 两者冲突导致震荡或 freeze

**结论**: PPO 学会了 Optimization，没学会 Stability

---

### Hypothesis 3: Common = 训练数据分布偏

**现象**: 训练数据 57.76% 是 no-op

**假设**:
- 57.76% no-op 教会模型"不作为是安全的"
- BC 完全学会了这个
- PPO 部分学会了这个 (体现在 25% freeze)

**结论**: 训练数据的 no-op 偏差是根本原因

---

## 下一步建议

### Phase 2 方向

基于以上分析，Phase 2 应该：

1. **降低 no-op 采样率** (当前 57.76% 太高)
2. **增加 risk_score** 到 reward 中
3. **增加 recovery_bonus** 奖励稳定状态

### 预期效果

| 指标 | 当前 | 目标 |
|------|------|------|
| BC freeze rate | 100% | < 50% |
| PPO overflow rate | 50% | < 20% |
| no-op ratio in training | 57.76% | < 40% |

---

## Report Metadata

- **Total Episodes**: 10 (5 BC + 5 PPO)
- **Collapsed Episodes**: 9 (90%)
- **Test Scenarios**: baseline, high_load, chaotic_spike, worker_failure, long_idle
- **Max Steps**: 500

---

## Files Generated

- `collapse_report.json` - 完整统计数据
- `collapse_examples/` - Top 5 崩溃详细 trace
- `collapse_dashboard.md` - 本报告
