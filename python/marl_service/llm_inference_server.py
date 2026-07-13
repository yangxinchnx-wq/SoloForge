"""
LLM 推理 HTTP 服务 (端口 8767)

v2: 支持动态加载/卸载模型、流式输出(SSE)、设备检测、性能指标

路由:
  GET  /health              - 健康检查
  GET  /api/status          - 当前模型状态 + 参数
  GET  /api/device          - 设备信息 (CPU/RAM/GPU) + 推荐参数
  GET  /api/metrics         - 上次推理性能指标
  POST /api/load            - 动态加载模型 { model_path, n_ctx, n_threads, n_gpu_layers }
  POST /api/unload          - 卸载当前模型
  POST /chat/completions    - Chat (OpenAI 兼容, 支持 stream=true)
  POST /llm/generate        - /chat/completions 别名 (向后兼容)
  GET  /v1/models           - OpenAI 兼容模型列表

启动:
  python -m marl_service.llm_inference_server --port 8767
  python marl_service/llm_inference_server.py --port 8767
"""
from __future__ import annotations

import argparse
import ctypes
import gc
import http.server
import json
import os
import socketserver
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Generator, Optional

# ── 全局状态 ──────────────────────────────────────────────────────
_llm_instance: Optional["_LocalLLM"] = None
_llm_lock = threading.Lock()
_llm_http_server: Optional[Any] = None
_last_metrics: dict[str, Any] = {
    "tokens_per_second": 0,
    "time_to_first_token_ms": 0,
    "total_tokens": 0,
    "total_time_ms": 0,
}

# 向后兼容
_DEFAULT_MODEL_DIR = Path(__file__).resolve().parent.parent / "data" / "models"
_DEFAULT_MODEL_FILE = "qwen2.5-0.5b-instruct-q4_k_m.gguf"


# ── 模型封装 ──────────────────────────────────────────────────────


class _LocalLLM:
    """本地模型封装 (llama-cpp-python)"""

    def __init__(
        self,
        model_path: str,
        n_ctx: int = 4096,
        n_threads: int = 4,
        n_gpu_layers: int = 0,
    ):
        try:
            from llama_cpp import Llama
        except ImportError as e:
            raise ImportError(
                "llama-cpp-python 未安装。请运行: pip install llama-cpp-python\n"
                "Windows 预编译 wheel: pip install llama-cpp-python --extra-index-url "
                "https://abetlen.github.io/llama-cpp-python/whl/cpu"
            ) from e

        self.model_path = model_path
        self.model_name = Path(model_path).stem
        self.n_ctx = n_ctx
        self.n_threads = n_threads
        self.n_gpu_layers = n_gpu_layers
        self.file_size_mb = round(Path(model_path).stat().st_size / (1024 * 1024), 1)

        print(
            f"[LocalLLM] Loading: {model_path}"
            f" (ctx={n_ctx}, threads={n_threads}, gpu_layers={n_gpu_layers},"
            f" size={self.file_size_mb}MB)"
        )
        self.llm = Llama(
            model_path=model_path,
            n_ctx=n_ctx,
            n_threads=n_threads,
            n_gpu_layers=n_gpu_layers,
            verbose=False,
        )
        print(f"[LocalLLM] Loaded: {self.model_name}")

    def chat_completion(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.3,
        top_p: float = 1.0,
        max_tokens: int = 1024,
        repeat_penalty: float = 1.1,
        stop: Optional[list[str]] = None,
        stream: bool = False,
    ) -> dict[str, Any] | Generator[dict[str, Any], None, None]:
        if stream:
            return self._chat_stream(
                messages, temperature, top_p, max_tokens, repeat_penalty, stop
            )
        return self._chat_sync(
            messages, temperature, top_p, max_tokens, repeat_penalty, stop
        )

    def _chat_sync(
        self, messages, temperature, top_p, max_tokens, repeat_penalty, stop
    ) -> dict[str, Any]:
        global _last_metrics
        t0 = time.time()

        response = self.llm.create_chat_completion(
            messages=messages,
            temperature=temperature,
            top_p=top_p,
            max_tokens=max_tokens,
            repeat_penalty=repeat_penalty,
            stop=stop or [],
            stream=False,
        )

        elapsed = time.time() - t0
        usage = response.get("usage", {})
        total_tokens = usage.get("completion_tokens", 0)

        _last_metrics = {
            "tokens_per_second": round(total_tokens / elapsed, 2) if elapsed > 0 else 0,
            "time_to_first_token_ms": 0,
            "total_tokens": total_tokens,
            "total_time_ms": round(elapsed * 1000, 2),
        }
        return response

    def _chat_stream(
        self, messages, temperature, top_p, max_tokens, repeat_penalty, stop
    ) -> Generator[dict[str, Any], None, None]:
        global _last_metrics
        t0 = time.time()
        first_token_time: Optional[float] = None
        token_count = 0

        for chunk in self.llm.create_chat_completion(
            messages=messages,
            temperature=temperature,
            top_p=top_p,
            max_tokens=max_tokens,
            repeat_penalty=repeat_penalty,
            stop=stop or [],
            stream=True,
        ):
            if first_token_time is None:
                first_token_time = time.time()
            token_count += 1
            yield chunk

        elapsed = time.time() - t0
        ttft = (first_token_time - t0) * 1000 if first_token_time else 0

        _last_metrics = {
            "tokens_per_second": round(token_count / elapsed, 2) if elapsed > 0 else 0,
            "time_to_first_token_ms": round(ttft, 2),
            "total_tokens": token_count,
            "total_time_ms": round(elapsed * 1000, 2),
        }


# ── 设备检测 ──────────────────────────────────────────────────────


def _get_device_info() -> dict[str, Any]:
    """获取设备信息 (CPU/RAM/GPU + llama-cpp-python CUDA 能力)"""
    cpu_cores = os.cpu_count() or 4

    # RAM
    ram_gb = 0.0
    try:
        if os.name == "nt":
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(stat)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
            ram_gb = round(stat.ullTotalPhys / (1024**3), 1)
        else:
            with open("/proc/meminfo", "r") as f:
                for line in f:
                    if line.startswith("MemTotal:"):
                        ram_gb = round(int(line.split()[1]) * 1024 / (1024**3), 1)
                        break
    except Exception:
        pass

    # GPU (nvidia-smi)
    gpu = None
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            gpu = result.stdout.strip().split("\n")[0]
    except Exception:
        pass

    # 检测 llama-cpp-python 是否支持 CUDA
    cuda_supported = False
    try:
        import llama_cpp
        # llama-cpp-python 暴露 llama_supports_gpu_offload()
        if hasattr(llama_cpp, "llama_supports_gpu_offload"):
            cuda_supported = bool(llama_cpp.llama_supports_gpu_offload())
        elif hasattr(llama_cpp, "llama_max_devices"):
            # fallback: 检查是否有 CUDA 相关属性
            cuda_supported = getattr(llama_cpp, "LLAMA_SUPPORTS_GPU_OFFLOAD", False)
    except Exception:
        pass

    return {
        "cpu_cores": cpu_cores,
        "ram_gb": ram_gb,
        "gpu": gpu,
        "cuda_supported": cuda_supported,
    }


def _suggest_params(device_info: dict[str, Any]) -> dict[str, int]:
    """根据设备信息推荐参数"""
    cpu = device_info["cpu_cores"]
    ram = device_info["ram_gb"]
    gpu = device_info["gpu"]
    cuda_supported = device_info.get("cuda_supported", False)

    n_threads = min(max(cpu - 2, 1), 8)

    if ram >= 32:
        n_ctx = 16384
    elif ram >= 16:
        n_ctx = 8192
    elif ram >= 8:
        n_ctx = 4096
    else:
        n_ctx = 2048

    # 只有 GPU 存在 且 llama-cpp-python 支持 CUDA 时才推荐 GPU offload
    n_gpu_layers = -1 if (gpu and cuda_supported) else 0

    return {"n_ctx": n_ctx, "n_threads": n_threads, "n_gpu_layers": n_gpu_layers}


# ── HTTP Handler ──────────────────────────────────────────────────


class _LLMHTTPServer(http.server.BaseHTTPRequestHandler):
    """HTTP handler for LLM inference service"""

    def _send_json(self, code: int, data: dict):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_cors(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_OPTIONS(self):
        self._send_cors()

    # ── POST 路由 ──

    def do_POST(self):
        if self.path == "/api/load":
            self._handle_load()
            return
        if self.path == "/api/unload":
            self._handle_unload()
            return
        if self.path in ("/chat/completions", "/llm/generate", "/v1/chat/completions"):
            self._handle_chat()
            return
        self._send_json(404, {"error": "not found"})

    # ── GET 路由 ──

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {
                "status": "ok",
                "model_loaded": _llm_instance is not None,
                "endpoints": [
                    "/api/load", "/api/unload", "/api/status",
                    "/api/device", "/api/metrics", "/chat/completions",
                ],
            })
            return

        if self.path == "/api/status":
            with _llm_lock:
                if _llm_instance:
                    self._send_json(200, {
                        "loaded": True,
                        "model_path": _llm_instance.model_path,
                        "model_name": _llm_instance.model_name,
                        "file_size_mb": _llm_instance.file_size_mb,
                        "params": {
                            "n_ctx": _llm_instance.n_ctx,
                            "n_threads": _llm_instance.n_threads,
                            "n_gpu_layers": _llm_instance.n_gpu_layers,
                        },
                    })
                else:
                    self._send_json(200, {"loaded": False})
            return

        if self.path == "/api/device":
            info = _get_device_info()
            info["suggested"] = _suggest_params(info)
            self._send_json(200, info)
            return

        if self.path == "/api/metrics":
            self._send_json(200, _last_metrics)
            return

        if self.path == "/v1/models":
            with _llm_lock:
                if _llm_instance:
                    self._send_json(200, {
                        "object": "list",
                        "data": [{
                            "id": _llm_instance.model_name,
                            "object": "model",
                            "owned_by": "local",
                        }],
                    })
                else:
                    self._send_json(200, {"object": "list", "data": []})
            return

        self._send_json(404, {"error": "not found"})

    # ── 处理函数 ──

    def _handle_load(self):
        global _llm_instance
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length).decode("utf-8")
            req = json.loads(raw)

            model_path = req.get("model_path", "")
            if not model_path or not Path(model_path).exists():
                self._send_json(400, {"ok": False, "error": f"File not found: {model_path}"})
                return

            n_ctx = int(req.get("n_ctx", 4096))
            n_threads = int(req.get("n_threads", 4))
            n_gpu_layers = int(req.get("n_gpu_layers", 0))

            with _llm_lock:
                # 先卸载
                if _llm_instance:
                    _llm_instance = None
                    gc.collect()

                # 加载新模型
                try:
                    _llm_instance = _LocalLLM(
                        model_path=model_path,
                        n_ctx=n_ctx,
                        n_threads=n_threads,
                        n_gpu_layers=n_gpu_layers,
                    )
                except Exception as e:
                    _llm_instance = None
                    self._send_json(500, {"ok": False, "error": str(e)})
                    return

            self._send_json(200, {
                "ok": True,
                "model_name": _llm_instance.model_name,
                "model_path": _llm_instance.model_path,
                "file_size_mb": _llm_instance.file_size_mb,
                "params": {"n_ctx": n_ctx, "n_threads": n_threads, "n_gpu_layers": n_gpu_layers},
            })
        except Exception as e:
            self._send_json(500, {"ok": False, "error": str(e)})

    def _handle_unload(self):
        global _llm_instance
        with _llm_lock:
            _llm_instance = None
            gc.collect()
        self._send_json(200, {"ok": True})

    def _handle_chat(self):
        with _llm_lock:
            llm = _llm_instance
        if llm is None:
            self._send_json(503, {"error": "No model loaded", "loaded": False})
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length).decode("utf-8")
            req = json.loads(raw)

            messages = req.get("messages", [])
            temperature = float(req.get("temperature", 0.3))
            top_p = float(req.get("top_p", 1.0))
            max_tokens = int(req.get("max_tokens", 1024))
            repeat_penalty = float(req.get("repeat_penalty", 1.1))
            stop = req.get("stop")
            stream = bool(req.get("stream", False))

            if stream:
                self._handle_chat_stream(
                    llm, messages, temperature, top_p, max_tokens, repeat_penalty, stop
                )
            else:
                response = llm.chat_completion(
                    messages=messages,
                    temperature=temperature,
                    top_p=top_p,
                    max_tokens=max_tokens,
                    repeat_penalty=repeat_penalty,
                    stop=stop,
                    stream=False,
                )
                self._send_json(200, response)
        except Exception as e:
            self._send_json(500, {"error": str(e)})

    def _handle_chat_stream(self, llm, messages, temperature, top_p, max_tokens, repeat_penalty, stop):
        """SSE 流式输出"""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        try:
            for chunk in llm.chat_completion(
                messages=messages,
                temperature=temperature,
                top_p=top_p,
                max_tokens=max_tokens,
                repeat_penalty=repeat_penalty,
                stop=stop,
                stream=True,
            ):
                data = json.dumps(chunk)
                self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
                self.wfile.flush()

            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except Exception as e:
            error_data = json.dumps({"error": str(e)})
            self.wfile.write(f"data: {error_data}\n\n".encode("utf-8"))
            self.wfile.flush()

    def log_message(self, format, *args):
        pass


# ── 向后兼容函数 ──────────────────────────────────────────────────


def _find_model() -> Optional[str]:
    """查找 GGUF 模型文件 (向后兼容)"""
    env_path = os.environ.get("SOLOFORGE_LOCAL_LLM_PATH")
    if env_path and Path(env_path).exists():
        return env_path

    default_path = _DEFAULT_MODEL_DIR / _DEFAULT_MODEL_FILE
    if default_path.exists():
        return str(default_path)

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
    skip_model_load: bool = False,
) -> Optional[threading.Thread]:
    """
    启动 LLM 推理 HTTP 服务

    Args:
        host: 监听地址
        port: 监听端口
        model_path: GGUF 模型路径 (None 则自动查找, skip_model_load=True 则不加载)
        n_ctx: 上下文长度
        skip_model_load: True = 只启动 HTTP 服务, 不加载模型 (v2 动态加载模式)

    Returns:
        daemon Thread (启动失败返回 None)
    """
    global _llm_instance, _llm_http_server

    # 加载模型 (除非 skip_model_load)
    if not skip_model_load:
        resolved_path = model_path or _find_model()
        if resolved_path:
            try:
                _llm_instance = _LocalLLM(resolved_path, n_ctx=n_ctx)
            except Exception as e:
                print(f"[LLM] Model load failed: {e}")
                _llm_instance = None
        else:
            print("[LLM] No model found, starting server in no-model mode")

    # 启动 HTTP server
    class _ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True
        allow_reuse_address = True

    try:
        _llm_http_server = _ThreadingHTTPServer((host, port), _LLMHTTPServer)
    except OSError as e:
        print(f"[LLM] Failed to bind {host}:{port}: {e}")
        print(f"[LLM] Port may be in use. Try a different port: --port {port + 1}")
        return None

    thread = threading.Thread(
        target=_llm_http_server.serve_forever,
        name="local-llm-http",
        daemon=True,
    )
    thread.start()
    print(f"[LLM] HTTP server listening on http://{host}:{port}")
    return thread


def stop_llm_http_server() -> None:
    global _llm_http_server, _llm_instance
    if _llm_http_server:
        _llm_http_server.shutdown()
        _llm_http_server.server_close()
        _llm_http_server = None
    _llm_instance = None


# ── CLI 入口 ──────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="SoloForge Local LLM Inference Server")
    parser.add_argument("--host", default="127.0.0.1", help="Listen address")
    parser.add_argument("--port", type=int, default=8767, help="Listen port")
    parser.add_argument("--model", default=None, help="GGUF model path (optional, can load dynamically)")
    parser.add_argument("--n-ctx", type=int, default=4096, help="Context length")
    parser.add_argument("--n-threads", type=int, default=4, help="CPU threads")
    parser.add_argument("--n-gpu-layers", type=int, default=0, help="GPU layers (-1 = all)")
    args = parser.parse_args()

    print("=" * 60)
    print("SoloForge Local LLM Inference Server")
    print(f"  Host: {args.host}:{args.port}")
    print(f"  Model: {args.model or 'none (dynamic load via /api/load)'}")
    print("=" * 60)

    skip = args.model is None
    thread = start_llm_http_server(
        host=args.host,
        port=args.port,
        model_path=args.model,
        n_ctx=args.n_ctx,
        skip_model_load=skip,
    )

    if thread is None:
        print("Failed to start server")
        return

    print(f"\nServer running on http://{args.host}:{args.port}")
    print("Press Ctrl+C to stop.\n")

    try:
        thread.join()
    except KeyboardInterrupt:
        print("\nShutting down...")
        stop_llm_http_server()


if __name__ == "__main__":
    main()
