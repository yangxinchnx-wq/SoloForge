# -*- coding: utf-8 -*-
"""
SoloForge MARL 模型 ONNX 导出脚本 (C6 / C7 / C8)
Path: python/tools/export_marl_to_onnx.py
Date: 2026-06-30

零破坏原则：
- 只读 .pt，导出到新文件 .onnx
- 不修改任何 .pt / .py
- INT8 量化只对 Critic 做（更紧凑、生产链路用得到）

输出物：
- marl_service/models/policy.onnx             (Float32 Actor, 输入 12 维)
- marl_service/models/policy_int8.onnx        (Int8 Actor,  量化)
- marl_service/models/critic_warmed_v2.onnx   (Float32 Critic, 输入 5 维)
- marl_service/models/critic_int8.onnx        (Int8 Critic, 量化)

用法：
  cd python
  python tools/export_marl_to_onnx.py
  python tools/export_marl_to_onnx.py --skip-int8
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("export_marl_to_onnx")


def _setup_path() -> Path:
    script_path = Path(__file__).resolve()
    py_dir = script_path.parents[1]
    os.chdir(py_dir)
    sys.path.insert(0, str(py_dir))
    return py_dir


def _build_legacy_actor(input_dim: int = 12, hidden_dim: int = 64, head_hidden: int = 32, action_dim: int = 3) -> "torch.nn.Module":
    """匹配 policy.pt 中 actor_state_dict 的结构 (shared_fc + actor_head)"""

    import torch.nn as nn

    class LegacyActor(nn.Module):
        def __init__(self):
            super().__init__()
            self.shared_fc = nn.Sequential(
                nn.Linear(input_dim, hidden_dim),
                nn.Tanh(),
                nn.Linear(hidden_dim, hidden_dim),
                nn.Tanh(),
            )
            self.actor_head = nn.Sequential(
                nn.Linear(hidden_dim, head_hidden),
                nn.Tanh(),
                nn.Linear(head_hidden, action_dim),
            )

        def forward(self, local_obs):
            x = self.shared_fc(local_obs)
            return self.actor_head(x)

    return LegacyActor()


def _build_legacy_critic(state_dim: int = 5, hidden_dim: int = 64) -> "torch.nn.Module":
    """匹配 critic_warmed_v2.pt 中 Sequential[0,2,4] 风格"""
    import torch.nn as nn
    return nn.Sequential(
        nn.Linear(state_dim, hidden_dim),
        nn.Tanh(),
        nn.Linear(hidden_dim, hidden_dim),
        nn.Tanh(),
        nn.Linear(hidden_dim, 1),
    )


def export_actor(actor_onnx_path: Path, int8_path: Path, do_int8: bool) -> dict:
    import torch
    import torch.nn as nn

    src = Path("marl_service/models/policy.pt")
    obj = torch.load(src, map_location="cpu", weights_only=False)
    actor_sd = obj.get("actor_state_dict") or obj
    logger.info("[actor] source=%s keys=%d", src.name, len(actor_sd))

    actor = _build_legacy_actor()
    actor.load_state_dict(actor_sd)
    actor.eval()

    actor_onnx_path.parent.mkdir(parents=True, exist_ok=True)
    dummy = torch.randn(1, 12)
    torch.onnx.export(
        actor,
        dummy,
        str(actor_onnx_path),
        input_names=["local_obs"],
        output_names=["action_logits"],
        opset_version=17,
        dynamic_axes={"local_obs": {0: "batch"}, "action_logits": {0: "batch"}},
    )
    f32_size = actor_onnx_path.stat().st_size

    info = {
        "actor_onnx": str(actor_onnx_path),
        "actor_size_bytes": f32_size,
    }
    logger.info("[actor] exported %s (%.1f KB)", actor_onnx_path, f32_size / 1024)

    if do_int8:
        try:
            from onnxruntime.quantization import quantize_dynamic, QuantType
            import onnx
            import tempfile

            with tempfile.NamedTemporaryFile(suffix=".onnx", delete=False) as tmp:
                tmp_in = tmp.name
            try:
                model_proto = onnx.load(str(actor_onnx_path))
                inferred = onnx.shape_inference.infer_shapes(model_proto)
                onnx.save(inferred, tmp_in)

                quantize_dynamic(
                    model_input=tmp_in,
                    model_output=str(int8_path),
                    weight_type=QuantType.QInt8,
                    per_channel=True,
                    reduce_range=True,
                    extra_options={"WeightSymmetric": True},
                )
            finally:
                try:
                    os.unlink(tmp_in)
                except OSError:
                    pass
            i8_size = int8_path.stat().st_size
            info["actor_int8_onnx"] = str(int8_path)
            info["actor_int8_size_bytes"] = i8_size
            logger.info(
                "[actor] INT8 -> %s (%.1f KB, ratio %.2fx)",
                int8_path,
                i8_size / 1024,
                f32_size / i8_size if i8_size > 0 else 0,
            )
        except Exception as e:
            logger.info("[actor] INT8 跳过 (Float32 已生成): %s", e)

    return info


def export_critic(critic_onnx_path: Path, int8_path: Path, do_int8: bool) -> dict:
    import torch

    src = Path("marl_service/models/critic_warmed_v2.pt")
    obj = torch.load(src, map_location="cpu", weights_only=False)
    critic_sd = obj.get("state_dict") or obj
    logger.info("[critic] source=%s keys=%d", src.name, len(critic_sd))

    critic = _build_legacy_critic()
    critic.load_state_dict(critic_sd)
    critic.eval()

    critic_onnx_path.parent.mkdir(parents=True, exist_ok=True)
    dummy = torch.randn(1, 5)
    torch.onnx.export(
        critic,
        dummy,
        str(critic_onnx_path),
        input_names=["global_state"],
        output_names=["value"],
        opset_version=17,
    )
    f32_size = critic_onnx_path.stat().st_size

    info = {
        "critic_onnx": str(critic_onnx_path),
        "critic_size_bytes": f32_size,
    }
    logger.info("[critic] exported %s (%.1f KB)", critic_onnx_path, f32_size / 1024)

    if do_int8:
        try:
            from onnxruntime.quantization import quantize_dynamic, QuantType
            import onnx
            import tempfile

            with tempfile.NamedTemporaryFile(suffix=".onnx", delete=False) as tmp:
                tmp_in = tmp.name
            try:
                model_proto = onnx.load(str(critic_onnx_path))
                inferred = onnx.shape_inference.infer_shapes(model_proto)
                onnx.save(inferred, tmp_in)

                quantize_dynamic(
                    model_input=tmp_in,
                    model_output=str(int8_path),
                    weight_type=QuantType.QInt8,
                    op_types_to_quantize=["MatMul", "Linear"],
                )
            finally:
                try:
                    os.unlink(tmp_in)
                except OSError:
                    pass
            i8_size = int8_path.stat().st_size
            info["critic_int8_onnx"] = str(int8_path)
            info["critic_int8_size_bytes"] = i8_size
            logger.info(
                "[critic] INT8 -> %s (%.1f KB, ratio %.2fx)",
                int8_path,
                i8_size / 1024,
                f32_size / i8_size if i8_size > 0 else 0,
            )
        except Exception as e:
            logger.info("[critic] INT8 跳过 (原因: %s)", str(e).splitlines()[0][:120])

    return info


def verify(path: Path, n_inputs: int) -> dict:
    import numpy as np
    import onnxruntime as ort

    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0]
    out = sess.get_outputs()[0]
    x = np.random.randn(1, n_inputs).astype(np.float32)
    y = sess.run(None, {inp.name: x})[0]
    return {
        "path": str(path),
        "in_name": inp.name,
        "in_shape": list(inp.shape),
        "out_name": out.name,
        "out_shape": list(out.shape),
        "test_output_mean": float(y.mean()),
        "test_output_std": float(y.std()),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="SoloForge MARL ONNX exporter (C6/C7/C8)")
    parser.add_argument("--skip-int8", action="store_true", help="跳过 INT8 量化")
    parser.add_argument("--verify-only", action="store_true", help="只验证已有 .onnx")
    args = parser.parse_args()

    _setup_path()

    models_dir = Path("marl_service/models")
    actor_onnx = models_dir / "policy.onnx"
    actor_int8 = models_dir / "policy_int8.onnx"
    critic_onnx = models_dir / "critic_warmed_v2.onnx"
    critic_int8 = models_dir / "critic_int8.onnx"

    if args.verify_only:
        results = []
        if actor_onnx.exists():
            results.append(verify(actor_onnx, 12))
        if critic_onnx.exists():
            results.append(verify(critic_onnx, 5))
        if actor_int8.exists():
            results.append(verify(actor_int8, 12))
        if critic_int8.exists():
            results.append(verify(critic_int8, 5))
        import json
        print(json.dumps(results, indent=2, ensure_ascii=False))
        return 0

    t0 = time.time()
    actor_info = export_actor(actor_onnx, actor_int8, do_int8=not args.skip_int8)
    critic_info = export_critic(critic_onnx, critic_int8, do_int8=not args.skip_int8)
    elapsed = time.time() - t0

    print("\n" + "=" * 60)
    print("MARL ONNX 导出完成")
    print("=" * 60)
    for k, v in {**actor_info, **critic_info}.items():
        print(f"  {k}: {v}")
    print(f"  total_time_sec: {elapsed:.2f}")

    print("\n--- onnxruntime 自检 ---")
    for name, path, n_in in [
        ("actor.f32", actor_onnx, 12),
        ("critic.f32", critic_onnx, 5),
    ]:
        if path.exists():
            v = verify(path, n_in)
            print(f"  [{name}] OK -> out_shape={v['out_shape']} mean={v['test_output_mean']:.4f}")
    if actor_int8.exists():
        v = verify(actor_int8, 12)
        print(f"  [actor.i8]  OK -> out_shape={v['out_shape']} mean={v['test_output_mean']:.4f}")
    if critic_int8.exists():
        v = verify(critic_int8, 5)
        print(f"  [critic.i8] OK -> out_shape={v['out_shape']} mean={v['test_output_mean']:.4f}")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())