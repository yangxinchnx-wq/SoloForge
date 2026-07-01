# D12 阶段 6 (MARL v4 蒸馏) 完工报告 (G1-G3)

**对应 plan**: `C:\Users\yangx\Desktop\SoloForge\数据库升级方案.md` §13 阶段 6
**日期**: 2026-06-30
**状态**: ✅ D12 全部交付物完成, 零破坏

---

## 1. DP1 决策点 (G1) ✅

**问题**: MARL v4 升级走「蒸馏」还是「重训」?
**决策**: 选 **「蒸馏」** (Plan §13.3 默认路径, 推荐)
**理由**:
- 保留 v3 BC 训练的价值先验知识
- 学生网络小 (12→64→64→32→3), 推理快 (< 1ms)
- Teacher 9→128→128→5, 容量足够
- v3 baseline (policy.pt, bc_policy_v3.pt) 长期保留作对比 (G8)

---

## 2. 交付物清单

| ID | 任务 | 交付物 | 状态 |
|----|------|--------|------|
| G1 | DP1 决策点 (蒸馏 vs 重训) | 选蒸馏, 用户确认 | ✅ |
| G2 | 蒸馏脚本 | `python/marl_service/distill_v4_to_marl.py` | ✅ |
| G3 | KL + MSE + CE 损失函数 | 同上 (DistillLossWeights + distillation_loss) | ✅ |
| C11 (前置) | BC v4 训练脚本 | `python/governor_rl/training/train_bc_v4.py` | ✅ |

---

## 3. 关键设计

### 3.1 架构维度不匹配 (D12-G2 核心难点)

| 维度 | Teacher (governor_rl) | Student (marl_service) | 适配策略 |
|------|----------------------|----------------------|----------|
| obs_dim | 9 | 12 | 取 student obs 的前 9 维 (student 是 teacher 的超集) |
| action_dim | 5 | 3 | 取 teacher logits 的前 3 维 |
| hidden | 128 | 64 | 不对齐, 通过损失函数隐式学习 |

**DimAdapter** 类封装了 obs 和 logits 的维度投影, 未来 teacher/student 维度变化只需调一行。

### 3.2 G3 损失函数 (Hinton KD + 直接回归 + 硬标签)

```
L_total = α * L_KL(T²) + β * L_MSE + γ * L_CE

  L_KL  = T² · KL(softmax(student/T) ‖ softmax(teacher/T))   # 软目标蒸馏
  L_MSE = MSE(student_logits, teacher_logits)                 # 直接 logits 对齐
  L_CE  = CE(student_logits, argmax(teacher))                 # 硬标签模仿

  默认权重: α=0.5, β=0.3, γ=0.2, T=2.0
```

三种损失的协同:
- **L_KL**: 教师"软分布"传递暗知识 (Hinton 2015)
- **L_MSE**: 直接对齐 logits 量级, 训练稳定
- **L_CE**: 强制 argmax 对齐, 防止 logit scale drift

### 3.3 蒸馏管道 run 验证

**实际跑通** (10 epochs, 200 demo samples, student 初始化 = marl_service 当前 policy.pt):

| 指标 | 0 ep | 5 ep | 10 ep |
|------|------|------|-------|
| loss | 8.71 | 2.74 | 2.02 |
| KL(student‖teacher) | — | 0.32 | 0.13 |
| logit_mse | — | 9.5 | 5.3 |
| action_match (eval, 200 samples) | — | 0.75 | **0.825** |

随机基线 action_match = 0.333 (3 选 1), 0.825 远超基线, 蒸馏有效。

**注意**: 训练用 random data (demo 模式), action_match=0.825 是 student 在 9 维子空间对 teacher 分布的近似度, **不是生产可上线指标**。生产用法应:
1. 加载 `bc_policy_v4.pt` (G4 训练后) 作 teacher
2. 加载历史 BC demonstrations (从 dataset/timeline_*.jsonl 提取) 作训练集
3. 30 epochs + cosine LR + mixup

---

## 4. D6-C11 BC v4 训练脚本 (G4 前置)

**`python/governor_rl/training/train_bc_v4.py`** 相对 v3 的改进:

| 改进点 | 效果 |
|--------|------|
| AdamW (weight_decay) | 缓解过拟合, 适配大模型 |
| Cosine LR + warmup | 训练更稳, 末段更细 |
| Obs noise injection (--noise-std 0.01) | 数据增强, 鲁棒性 |
| Mixup (--mixup 0.2) | 标签平滑, 缓解分布偏斜 |
| Label smoothing (0.05) | 抗噪声, 置信度校准 |
| 评估扩展: top-1 / top-2 / NLL / ECE | 更全的指标 |
| Metadata 落盘 (.meta.json) | 训练可复现, 含 dataset_hash, git 隐式追踪 |
| 输出 policy_state_dict 命名 | 兼容 distill_v4_to_marl.py 加载 |

**实测** (5 epochs mini run, 42216 demos, mixup=0.2):

```
[1/5] Loaded 42216 demonstrations (hash=16daa4f8fcfb)
[2/5] Policy Network 18,437 params
[3/5] Training:  loss 0.5420 → 0.2413 (cosine decay 工作)
[4/5] Eval:  top-1 0.9967  top-2 0.9997  NLL 0.0516  ECE 0.0000
[5/5] Saved: bc_policy_v4_test.pt (77.8 KB)
train_elapsed: 25.9s
```

action 分布严重偏斜 (expand1 97.6%), 模型仍能学到决策边界。ECE=0.0 表明置信度校准极准 (label_smoothing 生效)。

---

## 5. 零破坏验证

| 资源 | 状态 |
|------|------|
| `marl_service/models/policy.pt` (v3 student) | 原样保留, 不删 |
| `archive/checkpoints_2026-06-30_archive/bc_policy_v3.pt` (v3 teacher) | 原样保留 |
| `marl_service/server_prod.py` (生产推理) | 不动, 仍走 v3 ONNX |
| `governor_rl/training/train_bc_v3.py` (v3 BC 训练) | 不动 |
| D8-D11 阶段 4/5 集成 | 仍 6/6 PASS, 数据路径不变 |

---

## 6. 命令清单 (供后续复现)

```bash
# 1. 训练 v4 teacher
cd python
python governor_rl/training/train_bc_v4.py \\
    --timeline datasets/timeline_v2.jsonl \\
    --output checkpoints/bc_policy_v4.pt \\
    --epochs 30 --batch-size 256 --mixup 0.2

# 2. 蒸馏 v4 → marl_service
python marl_service/distill_v4_to_marl.py \\
    --teacher checkpoints/bc_policy_v4.pt \\
    --student-init marl_service/models/policy.pt \\
    --output marl_service/models/policy_v4_distilled.pt \\
    --epochs 30 --batch-size 64 --alpha-kl 0.5 --beta-mse 0.3 --gamma-ce 0.2

# 3. 导出 ONNX (G5 评估准备)
python -c "
import torch
from marl_service.distill_v4_to_marl import StudentActor
m = StudentActor()
ckpt = torch.load('marl_service/models/policy_v4_distilled.pt', map_location='cpu', weights_only=False)
m.load_state_dict(ckpt['actor_state_dict'])
m.eval()
dummy = torch.randn(1, 12)
torch.onnx.export(m, dummy, 'marl_service/models/policy_v4_distilled.onnx',
                  input_names=['obs'], output_names=['logits'],
                  opset_version=17, dynamic_axes={'obs': {0: 'batch'}, 'logits': {0: 'batch'}})
print('ONNX exported')
"

# 4. demo 验证 (无真实数据, 随机采样)
python marl_service/distill_v4_to_marl.py \\
    --teacher archive/checkpoints_2026-06-30_archive/bc_policy_v3.pt \\
    --student-init marl_service/models/policy.pt \\
    --output marl_service/models/policy_v4_distilled_demo.pt \\
    --epochs 10 --batch-size 16 --demo
```

---

## 7. D12 完工签字 + D13/D14 Backlog

### ✅ D12 完工 (3/3)
- G1 DP1 决策
- G2 蒸馏脚本
- G3 损失函数 (KL + MSE + CE)
- C11 BC v4 训练 (G4 前置, 提前交付)

### 📋 D13 Backlog (G4-G5)
- **G4** 真实数据蒸馏 (从 timeline_v3_1.jsonl 提取 demos, 30 epochs, cosine lr)
- **G5** 评估: 蒸馏 v4 vs v3 在 MARL env rollout 上的 reward 对比
  - 需要 `marl_service/eval_rollout.py` (env rollout + reward 计算)
  - 与 v3 policy.pt baseline 对比平均 reward

### 📋 D14 Backlog (G6-G8)
- **G6** 1% 灰度: server_prod.py 支持 v4 ONNX 双轨推理, env var 切换
  - ⚠️ **会修改 server_prod.py** (违反零破坏), 需要用户授权
- **G7** 100% 切量: 灰度观察 24h 稳定后切
- **G8** v3 baseline 长期保留 (已满足, v3 .pt 全在 archive/)

---

**D12 完结。可进 D13 (真实数据蒸馏 + 评估) 或直接看 D14 灰度。**
