"""
下载本地小模型 (Qwen2.5-0.5B-Instruct GGUF Q4 量化)

用法:
    python tools/download_small_llm.py

模型信息:
    - 名称: Qwen2.5-0.5B-Instruct
    - 量化: Q4_K_M (4-bit, 约 400MB)
    - 用途: Phase 5 实时训练的本地 LLM 推理
    - 中文友好, 适合 prompt 优化任务

下载源 (三选一, 自动 fallback):
    1. HuggingFace Hub (需可访问 huggingface.co)
    2. ModelScope (国内镜像, 需可访问 modelscope.cn)
"""
import os
import sys
import urllib.request
from pathlib import Path

# 目标路径
_TARGET_DIR = Path(__file__).resolve().parent.parent / "data" / "models"
_TARGET_FILE = "qwen2.5-0.5b-instruct-q4_k_m.gguf"

# 下载源 (按优先级排列)
_DOWNLOAD_SOURCES = [
    # HuggingFace (需科学上网或国内可直连)
    {
        "name": "HuggingFace",
        "url": "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf",
    },
    # ModelScope (国内镜像, 通常更快)
    {
        "name": "ModelScope",
        "url": "https://modelscope.cn/api/v1/models/Qwen/Qwen2.5-0.5B-Instruct-GGUF/repo?Revision=master&FilePath=qwen2.5-0.5b-instruct-q4_k_m.gguf",
    },
]


def download_with_progress(url: str, target_path: Path) -> bool:
    """带进度条的下载"""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "SoloForge/1.0"})
        with urllib.request.urlopen(req, timeout=60) as response:
            total = int(response.headers.get("Content-Length", 0))
            downloaded = 0
            chunk_size = 1024 * 256  # 256KB

            with open(target_path, "wb") as f:
                while True:
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total > 0:
                        pct = downloaded * 100 / total
                        mb_done = downloaded / (1024 * 1024)
                        mb_total = total / (1024 * 1024)
                        sys.stdout.write(
                            f"\r  下载进度: {pct:.1f}% "
                            f"({mb_done:.1f}MB / {mb_total:.1f}MB)"
                        )
                        sys.stdout.flush()
            sys.stdout.write("\n")
            return True
    except Exception as e:
        print(f"\n  下载失败: {e}")
        return False


def main():
    print("=" * 60)
    print("  SoloForge 本地小模型下载工具")
    print("  模型: Qwen2.5-0.5B-Instruct (GGUF Q4_K_M, ~400MB)")
    print("=" * 60)

    # 创建目标目录
    _TARGET_DIR.mkdir(parents=True, exist_ok=True)
    target_path = _TARGET_DIR / _TARGET_FILE

    # 检查是否已存在
    if target_path.exists():
        size_mb = target_path.stat().st_size / (1024 * 1024)
        print(f"\n✅ 模型已存在: {target_path} ({size_mb:.1f} MB)")
        print("   如需重新下载, 请先删除该文件。")
        return 0

    print(f"\n目标路径: {target_path}")
    print(f"预计大小: ~400 MB\n")

    # 依次尝试下载源
    for source in _DOWNLOAD_SOURCES:
        print(f"--- 尝试从 {source['name']} 下载 ---")
        print(f"URL: {source['url']}")
        if download_with_progress(source["url"], target_path):
            size_mb = target_path.stat().st_size / (1024 * 1024)
            print(f"\n✅ 下载成功! 文件大小: {size_mb:.1f} MB")
            print(f"   路径: {target_path}")
            print("\n下一步: 启动 MARL 服务时会自动加载此模型 (端口 8767)")
            return 0
        else:
            # 删除不完整的下载文件
            if target_path.exists():
                target_path.unlink()
            print(f"从 {source['name']} 下载失败, 尝试下一个源...\n")

    print("❌ 所有下载源均失败。")
    print("\n手动下载方式:")
    print(f"  1. 访问 https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF")
    print(f"  2. 下载 qwen2.5-0.5b-instruct-q4_k_m.gguf")
    print(f"  3. 放置到: {_TARGET_DIR}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
