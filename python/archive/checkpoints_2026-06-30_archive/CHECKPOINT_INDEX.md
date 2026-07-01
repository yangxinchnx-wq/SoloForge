# SoloForge MARL Checkpoint 归档索引

**归档日期**: 2026-06-30
**归档源**: `python/checkpoints/` (生产目录)
**归档目标**: `python/archive/checkpoints_2026-06-30_archive/` (本目录)
**归档方式**: **完全复制，不删任何原始文件**（零破坏原则）
**原始文件状态**: `python/checkpoints/` 21 个文件**全部保留**未动

---

## 1. 总览

- **总文件数**: 21（20 个 .pt + 1 个 JSON）
- **总大小**: 2.17 MB
- **归档大小**: 2.17 MB（与原始一致）

---

## 2. 文件清单（按原始 checkpoints/ 相对路径）

### 顶层 10 个 .pt

| 文件 | 大小 | 修改日期 | 备注 |
| --- | --- | --- | --- |
| `bc_policy.pt` | 224 KB | 2026/5/30 02:23 | BC 初始策略（最早版本） |
| `bc_policy_v2.pt` | 75 KB | 2026/5/30 14:48 | BC v2（结构变薄） |
| `bc_policy_v3.pt` | 224 KB | 2026/5/30 16:06 | BC v3（恢复） |
| `bc_policy_v3_1.pt` | 77 KB | 2026/5/30 18:37 | BC v3.1（结构变薄） |
| `bc_policy_v3_1_clean.pt` | 77 KB | 2026/5/30 19:00 | **生产引用**: `marl_service/weight_diagnostic.py` |
| `bc_policy_v3_sprint4.pt` | 77 KB | 2026/5/30 18:07 | BC Sprint4 中间产物 |
| `ppo_0step.pt` | 77 KB | 2026/5/31 03:15 | PPO 0 步基线 |
| `ppo_100k.pt` | 77 KB | 2026/5/31 03:23 | **生产引用**: 多个 gate5 脚本 |
| `ppo_actor_0step.pt` | 76 KB | 2026/5/31 03:15 | PPO actor 初始状态 |
| `ppo_policy.pt` | 449 KB | 2026/5/30 02:25 | PPO 早期完整 checkpoint |

### ppo_checkpoints/ 子目录（10 个 step + 1 log）

| 文件 | 大小 | 修改日期 | 备注 |
| --- | --- | --- | --- |
| `ppo_checkpoints/ppo_10240.pt` | 77 KB | 2026/5/31 03:22 | PPO step 10240 |
| `ppo_checkpoints/ppo_20480.pt` | 77 KB | 2026/5/31 03:22 | PPO step 20480 |
| `ppo_checkpoints/ppo_30720.pt` | 77 KB | 2026/5/31 03:22 | PPO step 30720 |
| `ppo_checkpoints/ppo_40960.pt` | 77 KB | 2026/5/31 03:22 | PPO step 40960 |
| `ppo_checkpoints/ppo_51200.pt` | 77 KB | 2026/5/31 03:22 | PPO step 51200 |
| `ppo_checkpoints/ppo_61440.pt` | 77 KB | 2026/5/31 03:22 | PPO step 61440 |
| `ppo_checkpoints/ppo_71680.pt` | 77 KB | 2026/5/31 03:22 | PPO step 71680 |
| `ppo_checkpoints/ppo_81920.pt` | 77 KB | 2026/5/31 03:22 | PPO step 81920 |
| `ppo_checkpoints/ppo_92160.pt` | 77 KB | 2026/5/31 03:22 | PPO step 92160 |
| `ppo_checkpoints/ppo_102400.pt` | 77 KB | 2026/5/31 03:23 | PPO step 102400（最终） |
| `ppo_checkpoints/training_log.json` | 17 KB | 2026/5/31 03:23 | PPO 训练日志 |

---

## 3. 生产环境必读文件（**不要清理**）

通过 grep 检索项目代码（marl_service/、experiments/、governor_rl/），以下文件在生产路径中被引用：

| 文件 | 引用位置 |
| --- | --- |
| `checkpoints/ppo_100k.pt` | `experiments/ppo/gate5_final_closure.py`, `experiments/ppo/ppo_final_comparison.py` |
| `checkpoints/bc_policy_v3_1_clean.pt` | `marl_service/weight_diagnostic.py` |
| `marl_service/models/policy.pt` | `marl_service/evaluator.py`, `marl_service/init_model.py`（**非 checkpoints 目录，独立生产基线**） |
| `marl_service/models/critic_warmed_v2.pt` | `marl_service/server_prod.py` 第 173 行（生产 critic） |
| `marl_service/models/critic_warmed.pt` | `marl_service/evaluator_warmed.py`（中间基线） |

**生产基线 3 个**（models/ 目录）：
- `policy.pt` (主策略网络, 51 KB)
- `critic_warmed.pt` (BC 后 critic, 21 KB)
- `critic_warmed_v2.pt` (生产 critic, 21 KB, 2026/5/31)

---

## 4. 后续处理建议（D5-D6 阶段）

1. **D5**: 导出 policy.pt → ONNX + INT8 量化（不删原 .pt）
2. **D5**: 改 `marl_service/server_prod.py` 优先加载 ONNX，回退 .pt
3. **D5 完成后**: 训练日志和中间 step checkpoint 可考虑压缩归档（**仍不删原文件**）

---

## 5. 归档操作回滚说明

如果未来确认所有中间 checkpoint 不需要，可执行：

```powershell
# 列出归档内容
Get-ChildItem -Recurse .\archive\checkpoints_2026-06-30_archive\

# 删除归档（**不删原始**）
Remove-Item -Recurse -Force .\archive\checkpoints_2026-06-30_archive\
```

**绝不可执行的命令**（零破坏原则）：
- ❌ `Remove-Item .\checkpoints\*` — 会破坏生产引用
- ❌ 任何覆盖原始 .pt 的命令
- ❌ 修改原始 .pt 的元数据 / 移动原始文件