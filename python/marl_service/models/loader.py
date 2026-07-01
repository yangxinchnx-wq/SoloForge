# -*- coding: utf-8 -*-
"""
SoloForge MARL 模型统一加载器
Path: python/marl_service/models/loader.py
Date: 2026-06-30

5 级 fallback 链（按优先级自动选择首个可用的格式）：
  1. ONNX  (.onnx)            - 最快，跨平台，CPU/GPU 通用
  2. OpenVINO IR (.xml+.bin)  - Intel CPU 优化，量化版本 113MB
  3. SentenceTransformers (.safetensors)  - PyTorch 主模型，离线推理
  4. PyTorch  (.pt)           - 项目现有训练产物，零迁移成本
  5. Heuristic (内存规则)      - 终极 fallback，永远可用

零破坏：
  - 现有的 policy.pt / critic_warmed_v2.pt 不动
  - 现有调用方使用 torch.load() 不动
  - loader.py 是新文件，只在 D5+ 阶段被新代码调用
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 路径常量（避免硬编码，便于测试和重构）
# ---------------------------------------------------------------------------

MODELS_DIR = Path(__file__).resolve().parent          # python/marl_service/models/
PROJECT_ROOT = MODELS_DIR.parent.parent.parent        # SoloForge/
BIN_MODELS_DIR = PROJECT_ROOT / "bin" / "models"      # SoloForge/bin/models/

# 生产基线（现有 .pt）
PRODUCTION_POLICY = MODELS_DIR / "policy.pt"
PRODUCTION_CRITIC_V2 = MODELS_DIR / "critic_warmed_v2.pt"
PRODUCTION_CRITIC_V1 = MODELS_DIR / "critic_warmed.pt"

# OpenVINO IR（已下载）
OPENVINO_INT8_XML = BIN_MODELS_DIR / "paraphrase-multilingual-MiniLM-L12-v2" / "openvino" / "openvino_model_qint8_quantized.xml"
OPENVINO_INT8_BIN = BIN_MODELS_DIR / "paraphrase-multilingual-MiniLM-L12-v2" / "openvino" / "openvino_model_qint8_quantized.bin"
OPENVINO_FP32_XML = BIN_MODELS_DIR / "paraphrase-multilingual-MiniLM-L12-v2" / "openvino" / "openvino_model.xml"
OPENVINO_FP32_BIN = BIN_MODELS_DIR / "paraphrase-multilingual-MiniLM-L12-v2" / "openvino" / "openvino_model.bin"

# MiniLM PyTorch 主模型（待用户下载）
MINILM_PYTORCH_DIR = BIN_MODELS_DIR / "paraphrase-multilingual-MiniLM-L12-v2"
MINILM_SAFETENSORS = MINILM_PYTORCH_DIR / "model.safetensors"


# ---------------------------------------------------------------------------
# 数据类型
# ---------------------------------------------------------------------------

@dataclass
class ModelLoadResult:
    """统一加载结果"""
    backend: str                           # "onnx" / "openvino" / "sentence_transformers" / "pytorch" / "heuristic"
    model: Any                             # 实际模型对象
    load_time_seconds: float
    file_path: Optional[str] = None        # 加载自哪个文件（heuristic 为 None）
    metadata: Dict[str, Any] = field(default_factory=dict)
    warning: Optional[str] = None


# ---------------------------------------------------------------------------
# Fallback 实现
# ---------------------------------------------------------------------------

def _load_onnx() -> Optional[ModelLoadResult]:
    """1. ONNX - 跨平台最优"""
    onnx_path = MODELS_DIR / "policy.onnx"
    if not onnx_path.exists():
        return None
    try:
        import onnxruntime as ort  # type: ignore
        t = time.time()
        sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
        return ModelLoadResult(
            backend="onnx",
            model=sess,
            load_time_seconds=time.time() - t,
            file_path=str(onnx_path),
            metadata={"input_names": [i.name for i in sess.get_inputs()],
                      "output_names": [o.name for o in sess.get_outputs()]},
        )
    except Exception as e:
        logger.warning("[loader] ONNX load failed: %s", e)
        return None


def _load_openvino() -> Optional[ModelLoadResult]:
    """2. OpenVINO IR - Intel CPU 优化（量化后 113MB）"""
    if not (OPENVINO_INT8_XML.exists() and OPENVINO_INT8_BIN.exists()):
        return None
    try:
        from openvino.runtime import Core  # type: ignore
        t = time.time()
        ie = Core()
        model = ie.read_model(model=str(OPENVINO_INT8_XML), weights=str(OPENVINO_INT8_BIN))
        compiled = ie.compile_model(model=model, device_name="CPU")
        return ModelLoadResult(
            backend="openvino",
            model=compiled,
            load_time_seconds=time.time() - t,
            file_path=str(OPENVINO_INT8_XML),
            metadata={"quantization": "INT8", "size_mb": 113},
        )
    except ImportError:
        logger.info("[loader] openvino package not installed, skip (D5+ will install)")
        return None
    except Exception as e:
        logger.warning("[loader] OpenVINO load failed: %s", e)
        return None


def _load_sentence_transformers() -> Optional[ModelLoadResult]:
    """3. SentenceTransformers - PyTorch 主模型（需 model.safetensors）"""
    if not MINILM_SAFETENSORS.exists():
        return None
    try:
        from sentence_transformers import SentenceTransformer  # type: ignore
        t = time.time()
        m = SentenceTransformer(str(MINILM_PYTORCH_DIR), device="cpu")
        return ModelLoadResult(
            backend="sentence_transformers",
            model=m,
            load_time_seconds=time.time() - t,
            file_path=str(MINILM_PYTORCH_DIR),
            metadata={"dim": m.get_sentence_embedding_dimension(),
                      "max_seq": m.max_seq_length},
        )
    except ImportError:
        logger.info("[loader] sentence_transformers not installed, skip")
        return None
    except Exception as e:
        logger.warning("[loader] SentenceTransformers load failed: %s", e)
        return None


def _load_pytorch() -> Optional[ModelLoadResult]:
    """4. PyTorch .pt - 项目现有训练产物"""
    if not PRODUCTION_POLICY.exists():
        return None
    try:
        import torch  # type: ignore
        t = time.time()
        # 项目现有 .pt 是 state_dict（不是 torch.save(model)），加载后用 mappo_net 重建
        state_dict = torch.load(str(PRODUCTION_POLICY), map_location="cpu", weights_only=False)
        return ModelLoadResult(
            backend="pytorch",
            model=state_dict,
            load_time_seconds=time.time() - t,
            file_path=str(PRODUCTION_POLICY),
            metadata={"format": "state_dict", "size_kb": PRODUCTION_POLICY.stat().st_size // 1024},
            warning="pytorch backend returns raw state_dict; caller should wrap with mappo_net",
        )
    except Exception as e:
        logger.warning("[loader] PyTorch load failed: %s", e)
        return None


def _load_heuristic() -> ModelLoadResult:
    """5. Heuristic - 内存规则，永远可用（终极 fallback）"""
    class HeuristicModel:
        """无外部依赖的 8 维简单规则模型"""
        def predict(self, global_state: List[float], local_obs: List[float]) -> Tuple[int, float, float]:
            load = float(global_state[0]) if len(global_state) > 0 else 0.5
            err_rate = float(global_state[1]) if len(global_state) > 1 else 0.0
            if err_rate > 0.9:
                return 2, 0.9, 0.5   # CIRCUIT_BREAKER
            elif load > 0.8:
                return 1, 0.7, 0.4   # PERFORMANCE_MODE
            else:
                return 0, 0.6, 0.3   # NO_OP
    return ModelLoadResult(
        backend="heuristic",
        model=HeuristicModel(),
        load_time_seconds=0.0,
        file_path=None,
        metadata={"type": "rule_based", "actions": ["NO_OP", "PERFORMANCE_MODE", "CIRCUIT_BREAKER"]},
        warning="heuristic fallback active; accuracy lower than learned model",
    )


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------

_BACKENDS: List[Callable[[], Optional[ModelLoadResult]]] = [
    _load_onnx,
    _load_openvino,
    _load_sentence_transformers,
    _load_pytorch,
    _load_heuristic,
]


def load_model(prefer: Optional[str] = None) -> ModelLoadResult:
    """
    加载模型，按 5 级 fallback 自动选择。

    Args:
        prefer: 强制指定 backend（"onnx" / "openvino" / ...）。None = 自动选首个可用。

    Returns:
        ModelLoadResult - 永远不返回 None（heuristic 保证 100% 可用）
    """
    if prefer:
        for fn in _BACKENDS:
            r = fn()
            if r and r.backend == prefer:
                logger.info("[loader] forced backend=%s, time=%.3fs", r.backend, r.load_time_seconds)
                return r
        logger.warning("[loader] preferred backend=%s not available, falling back to chain", prefer)

    for fn in _BACKENDS:
        r = fn()
        if r is not None:
            logger.info("[loader] selected backend=%s, file=%s, time=%.3fs",
                        r.backend, r.file_path, r.load_time_seconds)
            if r.warning:
                logger.warning("[loader] warning: %s", r.warning)
            return r

    # 理论上不可能到这里（heuristic 永远成功），但保持安全
    raise RuntimeError("[loader] all backends failed including heuristic (this should be unreachable)")


def list_available_backends() -> Dict[str, Dict[str, Any]]:
    """列出所有 backend 的可用性（用于诊断和测试）"""
    out: Dict[str, Dict[str, Any]] = {}
    test_cases = [
        ("onnx", _load_onnx),
        ("openvino", _load_openvino),
        ("sentence_transformers", _load_sentence_transformers),
        ("pytorch", _load_pytorch),
        ("heuristic", lambda: _load_heuristic()),
    ]
    for name, fn in test_cases:
        r = fn()
        out[name] = {
            "available": r is not None,
            "file_path": r.file_path if r else None,
            "warning": r.warning if r else "unavailable",
        }
    return out


if __name__ == "__main__":
    # 自我诊断：列出所有 backend
    print("=== SoloForge MARL Model Loader Diagnostics ===")
    print(f"MODELS_DIR         = {MODELS_DIR}")
    print(f"BIN_MODELS_DIR     = {BIN_MODELS_DIR}")
    print()
    print("Available backends:")
    for name, info in list_available_backends().items():
        status = "OK" if info["available"] else "N/A"
        print(f"  [{status}] {name:<25} {info['file_path'] or '(no file)'}")
        if info["warning"]:
            print(f"         -> {info['warning']}")
    print()
    print("Loading model (auto)...")
    r = load_model()
    print(f"Selected backend  : {r.backend}")
    print(f"File path         : {r.file_path}")
    print(f"Load time         : {r.load_time_seconds:.3f}s")
    print(f"Metadata          : {r.metadata}")
    if r.warning:
        print(f"Warning           : {r.warning}")