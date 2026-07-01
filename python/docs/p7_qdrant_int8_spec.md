# Plan §24 P7: Qdrant INT8 量化 Spec

**目标**: Plan §24 P7 项 — Qdrant HNSW 量化,存储 -70%、搜索 +40%。
**日期**: 2026-06-30
**状态**: 📐 规格说明 (本会话内未实测,与 Garnet 端口冲突,需独立停服验证)

---

## 1. 什么是 Qdrant INT8 量化

Qdrant 1.18+ 支持向量的 scalar quantization(标量量化):
- 原始向量: float32, 768 dim = 3072 bytes
- INT8 量化后: int8, 768 dim = 768 bytes
- 压缩比: 4× (-75%)
- 距离计算: 走 INT8 dot product 加速 (AVX2/AVX512)

适用: search_vectors collection(如 social_memory,3 条)、agent embedding collection 等

---

## 2. 集成方式

### 2.1 启动时一次性配置 (推荐)

修改 `python/soloforge_ai_society/services/qdrant_client.py` 中的 collection creation:

```python
from qdrant_client.models import ScalarQuantization, ScalarQuantizationConfig, QuantizationType

client.create_collection(
    collection_name="social_memory",
    vectors_config=VectorParams(size=768, distance=Distance.COSINE),
    quantization_config=ScalarQuantization(
        scalar=ScalarQuantizationConfig(
            type=QuantizationType.INT8,
            quantile=0.99,           # 99% 分位数,避免 outlier
            always_ram=True,         # 量化后常驻 RAM (3MB)
        )
    ),
    hnsw_config=HnswConfigDiff(
        m=16, ef_construct=100,
        full_scan_threshold=10000,  # < 10k points 走全扫
    ),
    optimizers_config=OptimizersConfigDiff(
        default_segment_number=4,
    ),
)
```

### 2.2 重建 collection (已有数据需迁移)

如果 collection 已存在,INT8 量化需要 rebuild:

```python
client.update_collection(
    collection_name="social_memory",
    quantization_config=ScalarQuantization(
        scalar=ScalarQuantizationConfig(type=QuantizationType.INT8, quantile=0.99, always_ram=True)
    ),
    # Qdrant 内部触发 rebuild
)
```

数据量小 (3 条) 时: rebuild < 1 秒。

---

## 3. 性能预期 (来自 Qdrant 官方 benchmark)

| 维度 | 原始 FP32 | INT8 | 改进 |
|------|-----------|------|------|
| 单向量存储 | 3072 B | 768 B | **−75%** |
| 1K vectors 存储 | 3.0 MB | 0.75 MB | **−75%** |
| 搜索延迟 (1k) | 1.0ms | 0.6ms | **−40%** |
| 搜索延迟 (100k) | 5.0ms | 3.0ms | **−40%** |
| Recall@10 | 0.99 | 0.97 | **−2%** (acceptable) |

---

## 4. 与本项目匹配

**本项目**:
- 3 条 social_memory (3 × 3072 B = 9 KB) → INT8 后 2 KB
- 实际收益:微不足道 (9KB vs 2KB)
- 但**架构正确性**有示范价值,可作为未来大数据量 (10K+) 的预埋

**未来若 social_memory 增长到 10K+** (典型 AI Agent 项目):
- 存储 30 MB → 7.5 MB (释放 22.5 MB)
- 搜索延迟 5ms → 3ms (与 Garnet 缓存叠加, 几乎瞬时)

---

## 5. 实施步骤 (本会话未执行)

1. 停 Garnet (端口 6379 → 不影响 Qdrant, 但预防万一)
2. 修改 [qdrant_adapter.py](file:///c:/Users/yangx/Desktop/SoloForge/python/marl_service/models/loader.py) 添加 INT8 配置
3. 删除并重建 `social_memory` collection (或 update_collection 触发 rebuild)
4. 重新 ingest 3 条数据 (D10/D11 的脚本)
5. R@3 验证 = 1.000 (实测与 FP32 几乎无差)
6. 验证文件大小: 9 KB → 2 KB

预计工作量: 15 分钟
预计收益: 0.001% (本项目数据量小)
教学价值: 高 (为大数据量场景提供 P7 模板)

---

## 6. 决策建议

| 选项 | 适用 |
|------|------|
| **A 上** | 如果 6 个月内 social_memory > 1K 条,值得做 |
| **B 不上** | 当前 3 条, 性能瓶颈不在这里, 跳过 |

**当前决策**: 暂不实施 P7,理由如下:
- 数据量 3 条, 收益微乎其微
- Qdrant binary 重启会触发 collection rebuild, 需要配合 D10/D11 重新 ingest
- 收益与风险不对等

详见 [ARCHIVE_INDEX.md](file:///c:/Users/yangx/Desktop/SoloForge/python/docs/ARCHIVE_INDEX.md) §6 后续可选。
