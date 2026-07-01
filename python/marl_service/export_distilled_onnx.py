# -*- coding: utf-8 -*-
"""
SoloForge v4 蒸馏模型 ONNX 导出 (D14 G6 前置)
Path: python/marl_service/export_distilled_onnx.py
Date: 2026-06-30

用途: 把 marl_service/models/policy_v4_distilled.pt 转成 ONNX
      供 G6 灰度路由 / 跨平台部署使用

零破坏: 新文件, 不动 .pt 文件 / 加载逻辑

用法:
  cd python
  python marl_service/export_distilled_onnx.py
  python marl_service/export_distilled_onnx.py --pt path/to/distilled.pt --out path/to/model.onnx
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import torch
import torch.nn as nn

SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(PYTHON_DIR))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("export_distilled_onnx")


class StudentActor(nn.Module):
    """marl_service student 12→64→64→32→3"""
    def __init__(self, obs_dim: int = 12, hidden: int = 64, action_dim: int = 3):
        super().__init__()
        self.shared_fc = nn.Sequential(
            nn.Linear(obs_dim, hidden), nn.Tanh(),
            nn.Linear(hidden, hidden), nn.Tanh(),
        )
        self.actor_head = nn.Sequential(
            nn.Linear(hidden, 32), nn.Tanh(),
            nn.Linear(32, action_dim),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.actor_head(self.shared_fc(x))


def export_onnx(
    pt_path: Path,
    onnx_path: Path,
    opset: int = 17,
    dynamic_batch: bool = True,
) -> Dict[str, Any]:
    """导出 student .pt → .onnx, 含 dry-run 验证"""
    obj = torch.load(str(pt_path), map_location="cpu", weights_only=False)
    if isinstance(obj, dict) and "actor_state_dict" in obj:
        sd = obj["actor_state_dict"]
    elif isinstance(obj, dict) and all(isinstance(v, torch.Tensor) for v in obj.values()):
        sd = obj
    else:
        raise ValueError(f"Unrecognized .pt format: {pt_path}")

    model = StudentActor()
    model.load_state_dict(sd, strict=False)
    model.eval()

    n_params = sum(p.numel() for p in model.parameters())
    onnx_path.parent.mkdir(parents=True, exist_ok=True)

    dynamic_axes = (
        {"obs": {0: "batch"}, "logits": {0: "batch"}}
        if dynamic_batch
        else None
    )
    torch.onnx.export(
        model,
        torch.randn(1, 12),
        str(onnx_path),
        input_names=["obs"],
        output_names=["logits"],
        opset_version=opset,
        dynamic_axes=dynamic_axes,
        do_constant_folding=True,
    )

    # Dry-run 验证
    import numpy as np
    try:
        import onnxruntime as ort
        sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
        test_inp = np.random.randn(2, 12).astype(np.float32)
        out = sess.run(None, {"obs": test_inp})[0]
        # 对比 PyTorch 输出
        with torch.no_grad():
            torch_out = model(torch.FloatTensor(test_inp)).numpy()
        max_diff = float(np.abs(out - torch_out).max())
    except ImportError:
        max_diff = None
        logger.warning("onnxruntime 未安装, 跳过数值对比")

    return {
        "pt_path": str(pt_path),
        "onnx_path": str(onnx_path),
        "onnx_size_bytes": onnx_path.stat().st_size,
        "n_params": n_params,
        "opset": opset,
        "dynamic_batch": dynamic_batch,
        "max_onnx_vs_torch_diff": max_diff,
    }


def main() -> int:
    p = argparse.ArgumentParser(description="SoloForge v4 distilled ONNX export")
    p.add_argument("--pt", default="marl_service/models/policy_v4_distilled.pt")
    p.add_argument("--out", default="marl_service/models/policy_v4_distilled.onnx")
    p.add_argument("--opset", type=int, default=17)
    p.add_argument("--no-dynamic-batch", action="store_true")
    p.add_argument("--json", action="store_true", help="JSON 输出")
    args = p.parse_args()

    info = export_onnx(
        Path(args.pt),
        Path(args.out),
        opset=args.opset,
        dynamic_batch=not args.no_dynamic_batch,
    )
    print("\n" + "=" * 60)
    print("v4 蒸馏 ONNX 导出完工")
    print("=" * 60)
    print(f"  pt  →  {info['pt_path']}")
    print(f"  onnx → {info['onnx_path']} ({info['onnx_size_bytes']} bytes)")
    print(f"  n_params: {info['n_params']:,}")
    print(f"  opset:    {info['opset']}  dynamic_batch: {info['dynamic_batch']}")
    if info["max_onnx_vs_torch_diff"] is not None:
        print(f"  max_onnx_vs_torch_diff: {info['max_onnx_vs_torch_diff']:.2e}")
        if info["max_onnx_vs_torch_diff"] < 1e-4:
            print("  ✅ ONNX 与 PyTorch 输出一致")
        else:
            print(f"  ⚠️ 数值差异 {info['max_onnx_vs_torch_diff']:.2e} (建议检查)")
    if args.json:
        import json
        print(json.dumps(info, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
