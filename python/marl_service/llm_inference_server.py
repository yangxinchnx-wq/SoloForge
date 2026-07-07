"""
LLM 推理 HTTP 服务 (端口 8767)

Phase 5 实时训练增强: 用本地小模型驱动 PromptOptimizer, 摆脱外部 API 依赖。

技术栈:
  - llama-cpp-python (C++ GGUF 推理, 速度快, 内存少)
  - Qwen2.5-0.5B-Instruct GGUF Q4 量化 (约 400MB, 中文友好)

路由:
  - POST /llm/generate   文本生成 (OpenAI chat/completions 兼容格式)
  - GET  /health         健康检查

启动模式: 仿照 reputation_sync_receiver.py
  - http.server.BaseHTTPRequestHandler + ThreadingMixIn + daemon thread
  - 模块级全局单例 _llm_instance

模型下载:
  python tools/download_small_llm.py
  或手动下载到 python/data/models/qwen2.5-0.5b-instruct-q4_k_m.gguf
"""
from __future__ import annotations

import http.server
import json
import os
import socketserver
import threading
from pathlib import Path
from typing import Any, Optional

# ── 全局单例 ──────────────────────────────────────────────────────
_llm_instance: Optional["_LocalLLM"] = None
_llm_http_server: Optional[Any] = None

# 默认模型路径
_DEFAULT_MODEL_DIR = Path(__file__).resolve().parent.parent / "data" / "models"
_DEFAULT_MODEL_FILE = "qwen2.5-0.5b-instruct-q4_k_m.gguf"


class _LocalLLM:
    """本地小模型封装 (llama-cpp-python)"""

    def __init__(self, model_path: str, n_ctx: int = 4096, n_threads: int = 4):
        try:
            from llama_cpp import Llama
        except ImportError as e:
            raise ImportError(
                "llama-cpp-python 未安装。请运行: pip install llama-cpp-python\n"
                "Windows 预编译 wheel: pip install llama-cpp-python --extra-index-url "
                "https://abetlen.github.io/llama-cpp-python/whl/cpu"
            ) from e

        print(f"[LocalLLM] Loading model: {model_path}")
        self.llm = Llama(
            model_path=model_path,
            n_ctx=n_ctx,
            n_threads=n_threads,
            verbose=False,
            n_gpu_layers=0,  # CPU 推理 (兼容性优先)
        )
        print(f"[LocalLLM] Model loaded (ctx={n_ctx}, threads={n_threads})")

    def chat_completion(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.3,
        max_tokens: int = 1024,
        stop: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        """OpenAI 兼容的 chat completion 接口"""
        # llama-cpp-python 的 create_chat_completion 方法
        response = self.llm.create_chat_completion(
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            stop=stop or [],
        )
        return response


class _LLMHTTPServer(http.server.BaseHTTPRequestHandler):
    """HTTP handler: POST /llm/generate 或 /chat/completions → _llm_instance.chat_completion"""

    def do_POST(self):
        # 兼容两种路径: /llm/generate (原生) 和 /chat/completions (OpenAI 兼容)
        if self.path not in ("/llm/generate", "/chat/completions"):
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'{"error":"not found"}')
            return

        if _llm_instance is None:
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":"LLM not loaded","loaded":false}')
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length).decode("utf-8")
            req = json.loads(raw)

            messages = req.get("messages", [])
            temperature = float(req.get("temperature", 0.3))
            max_tokens = int(req.get("max_tokens", 1024))
            stop = req.get("stop")

            response = _llm_instance.chat_completion(
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                stop=stop,
            )

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(response).encode("utf-8"))

        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))

    def do_GET(self):
        if self.path == "/health":
            loaded = _llm_instance is not None
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "status": "ok",
                        "endpoints": ["/llm/generate", "/chat/completions"],
                        "model_loaded": loaded,
                    }
                ).encode("utf-8")
            )
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args):
        pass  # 静默默认 access log


def _find_model() -> Optional[str]:
    """查找 GGUF 模型文件"""
    # 1. 环境变量指定
    env_path = os.environ.get("SOLOFORGE_LOCAL_LLM_PATH")
    if env_path and Path(env_path).exists():
        return env_path

    # 2. 默认路径
    default_path = _DEFAULT_MODEL_DIR / _DEFAULT_MODEL_FILE
    if default_path.exists():
        return str(default_path)

    # 3. data/models/ 下任意 .gguf
    if _DEFAULT_MODEL_DIR.exists():
        gguf_files = list(_DEFAULT_MODEL_DIR.glob("*.gguf"))
        if gguf_files:
            return str(gguf_files[0])

    return None


def start_llm_http_server(
    host: str = "127.0.0.1",
    port: int = 8767,
    model_path: Optional[str] = None,
    n_ctx: int = 4096,
) -> Optional[threading.Thread]:
    """
    启动 LLM 推理 HTTP 服务

    Args:
        host: 监听地址
        port: 监听端口 (默认 8767)
        model_path: GGUF 模型路径 (None 则自动查找)
        n_ctx: 上下文长度

    Returns:
        daemon Thread (启动失败返回 None)
    """
    global _llm_instance, _llm_http_server

    # 查找模型
    resolved_path = model_path or _find_model()
    if not resolved_path:
        print(
            f"⚠️  [LLM] 未找到 GGUF 模型文件。请运行: python tools/download_small_llm.py\n"
            f"    或手动下载到: {_DEFAULT_MODEL_DIR / _DEFAULT_MODEL_FILE}"
        )
        return None

    # 加载模型
    try:
        _llm_instance = _LocalLLM(resolved_path, n_ctx=n_ctx)
    except Exception as e:
        print(f"⚠️  [LLM] 模型加载失败: {e}")
        _llm_instance = None
        return None

    # 启动 HTTP server
    class _ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True
        allow_reuse_address = True

    _llm_http_server = _ThreadingHTTPServer((host, port), _LLMHTTPServer)
    thread = threading.Thread(
        target=_llm_http_server.serve_forever,
        name="local-llm-http",
        daemon=True,
    )
    thread.start()
    print(f"✅ [LLM] Local LLM HTTP server listening on http://{host}:{port}/llm/generate")
    return thread


def stop_llm_http_server() -> None:
    global _llm_http_server, _llm_instance
    if _llm_http_server:
        _llm_http_server.shutdown()
        _llm_http_server.server_close()
        _llm_http_server = None
    _llm_instance = None
