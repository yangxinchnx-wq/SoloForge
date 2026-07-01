# -*- coding: utf-8 -*-
"""
SoloForge BadgerDB HTTP Gateway Python Client
Path: python/soloforge_ai_society/services/badger_grpc_client.py
Date: 2026-06-30
对应 plan: 数据库升级方案.md §9 D5-A11 (Python BadgerDB gRPC client)

虽然文件名沿用 plan 中 "grpc" 命名 (历史约定), 实际 Go gateway
(`bin/badger-gateway/main.go`) 提供的是 **HTTP/JSON** 接口,
不是真 gRPC — 详见 gateway 路由表 (端口 7001, 端点:
/health /stats /put /delete /batch_put /get/{key} /list /echo)。

零破坏: 新文件, 不改任何现有业务代码。

用法:
    from soloforge_ai_society.services.badger_grpc_client import (
        BadgerGatewayClient, BadgerGatewayConfig, BadgerGatewayError,
    )

    cfg = BadgerGatewayConfig(base_url="http://127.0.0.1:7001", timeout_sec=2.0)
    client = BadgerGatewayClient(cfg)

    health = client.health()  # {"status": "ok", "engine": "badger-v3", ...}
    client.put(b"sync:msg:001", b"hello", ttl_seconds=3600)
    resp = client.get("sync:msg:001")
    if resp.found:
        value = resp.value
    client.batch_put([
        (b"k1", b"v1", None),
        (b"k2", b"v2", 60),  # TTL 60s
    ])
    listed = client.list_keys(prefix="sync:msg:", limit=100)
    client.delete("sync:msg:001")
"""

from __future__ import annotations

import base64
import json
import logging
import os
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import requests

logger = logging.getLogger("badger-gateway-client")


class BadgerGatewayError(RuntimeError):
    """BadgerDB gateway 通信错误基类"""

    def __init__(self, message: str, status_code: Optional[int] = None, body: Optional[str] = None):
        super().__init__(message)
        self.status_code = status_code
        self.body = body


@dataclass
class BadgerGatewayConfig:
    """BadgerDB gateway 客户端配置

    默认 base_url 从环境变量 BADGER_GATEWAY_URL 读取 (便于部署切换),
    未设置则用 127.0.0.1:7001 (与 plan §17 端口约定一致)。
    """
    base_url: str = field(
        default_factory=lambda: os.environ.get("BADGER_GATEWAY_URL", "http://127.0.0.1:7001")
    )
    timeout_sec: float = 2.0
    verify_tls: bool = True  # 本地 HTTP 不需要, 远程 HTTPS 应开启
    max_retries: int = 2  # 0 表示不重试
    retry_backoff_sec: float = 0.1

    def __post_init__(self) -> None:
        # 去除尾部 slash, 避免 //health
        self.base_url = self.base_url.rstrip("/")


@dataclass
class GetResult:
    """get() 返回结果"""
    key: str
    value: bytes
    found: bool

    @property
    def value_str(self) -> str:
        """按 UTF-8 解码 (若失败抛 UnicodeDecodeError, 由调用方处理)"""
        return self.value.decode("utf-8")


@dataclass
class ListResult:
    """list_keys() 返回结果"""
    keys: List[str]
    prefix: str
    limit: int
    returned: int
    has_more: bool


class BadgerGatewayClient:
    """BadgerDB HTTP Gateway 客户端 (Python 端)

    端点对应 (与 bin/badger-gateway/main.go 路由表保持一致):
        GET  /health     -> dict (含 status/engine/version/num_keys 等)
        GET  /stats      -> dict
        POST /put        -> 单条写入 (key/ttl 可控)
        POST /delete     -> 删除
        POST /batch_put  -> 批量写入
        GET  /get/{key}  -> GetResult
        GET  /list       -> ListResult (query: prefix, limit)

    所有接口在 gateway 不可达时抛 BadgerGatewayError。
    value 在 client 侧以 bytes 传入, 内部转 base64 (gateway 要求)。
    """

    def __init__(self, config: Optional[BadgerGatewayConfig] = None) -> None:
        self.config = config or BadgerGatewayConfig()
        self._session = requests.Session()
        # 避免 urllib3 的 InsecureRequestWarning 噪音
        if not self.config.verify_tls:
            import urllib3
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    # ── 健康/统计 ────────────────────────────────────────────────────

    def health(self) -> Dict[str, Any]:
        """GET /health — 探活 + 拿 gateway 元信息"""
        return self._request("GET", "/health")

    def stats(self) -> Dict[str, Any]:
        """GET /stats — 拿 LSM 大小 / value log 大小 / uptime"""
        return self._request("GET", "/stats")

    def is_alive(self) -> bool:
        """快速探活, 不抛异常"""
        try:
            r = self._session.get(
                f"{self.config.base_url}/health",
                timeout=self.config.timeout_sec,
            )
            return r.status_code == 200 and r.json().get("status") == "ok"
        except Exception:
            return False

    # ── 单条读写 ────────────────────────────────────────────────────

    def put(
        self,
        key: Union[bytes, str],
        value: Union[bytes, str],
        ttl_seconds: Optional[int] = None,
    ) -> None:
        """POST /put — 单条写入

        Args:
            key: bytes 或 str (str 自动转 utf-8 bytes)
            value: bytes 或 str
            ttl_seconds: 可选 TTL (秒), None = 永不过期
        """
        key_str = key if isinstance(key, str) else key.decode("utf-8")
        val_bytes = value.encode("utf-8") if isinstance(value, str) else value
        body = {
            "key": key_str,
            "value": base64.b64encode(val_bytes).decode("ascii"),
        }
        if ttl_seconds is not None and ttl_seconds > 0:
            body["ttl_seconds"] = ttl_seconds
        self._request("POST", "/put", json=body, expect_status=204)

    def get(self, key: Union[bytes, str]) -> GetResult:
        """GET /get/{key} — 单条读取

        未找到时返回 GetResult(key, b'', found=False), 不抛异常。
        其他错误抛 BadgerGatewayError。
        """
        key_str = key if isinstance(key, str) else key.decode("utf-8")
        try:
            data = self._request("GET", f"/get/{key_str}")
        except BadgerGatewayError as e:
            if e.status_code == 404:
                return GetResult(key=key_str, value=b"", found=False)
            raise
        if not data.get("found", False):
            return GetResult(key=key_str, value=b"", found=False)
        raw = base64.b64decode(data["value"]) if data.get("value") else b""
        return GetResult(key=key_str, value=raw, found=True)

    def delete(self, key: Union[bytes, str]) -> None:
        """POST /delete — 删除单条"""
        key_str = key if isinstance(key, str) else key.decode("utf-8")
        self._request("POST", "/delete", json={"key": key_str}, expect_status=204)

    # ── 批量写入 ───────────────────────────────────────────────────

    def batch_put(self, items: List[Tuple[Union[bytes, str], Union[bytes, str], Optional[int]]]) -> int:
        """POST /batch_put — 批量写入

        Args:
            items: [(key, value, ttl_seconds), ...] 列表
                   ttl_seconds 为 None 表示永不过期

        Returns:
            实际写入条数 (成功时 == len(items))
        """
        body_items = []
        for key, value, ttl in items:
            key_str = key if isinstance(key, str) else key.decode("utf-8")
            val_bytes = value.encode("utf-8") if isinstance(value, str) else value
            item = {
                "key": key_str,
                "value": base64.b64encode(val_bytes).decode("ascii"),
            }
            if ttl is not None and ttl > 0:
                item["ttl_seconds"] = ttl
            body_items.append(item)
        self._request("POST", "/batch_put", json={"items": body_items}, expect_status=204)
        return len(body_items)

    # ── 列表 ────────────────────────────────────────────────────────

    def list_keys(self, prefix: str = "", limit: int = 1000) -> ListResult:
        """GET /list?prefix=&limit= — 列出匹配前缀的 keys

        注意: gateway 限制 limit ∈ [1, 10000], 越界自动回退到 1000。
        """
        params: Dict[str, str] = {"limit": str(limit)}
        if prefix:
            params["prefix"] = prefix
        data = self._request("GET", "/list", params=params)
        return ListResult(
            keys=data.get("keys", []),
            prefix=data.get("prefix", prefix),
            limit=data.get("limit", limit),
            returned=data.get("returned", 0),
            has_more=data.get("has_more", False),
        )

    # ── 内部 HTTP 封装 ─────────────────────────────────────────────

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, str]] = None,
        expect_status: Optional[int] = None,
    ) -> Dict[str, Any]:
        """统一 HTTP 请求封装, 含重试 + 错误归一化"""
        url = f"{self.config.base_url}{path}"
        last_exc: Optional[Exception] = None
        attempts = max(1, self.config.max_retries + 1)
        for attempt in range(1, attempts + 1):
            t0 = time.time()
            try:
                resp = self._session.request(
                    method=method,
                    url=url,
                    json=json,
                    params=params,
                    timeout=self.config.timeout_sec,
                    verify=self.config.verify_tls,
                )
                elapsed_ms = (time.time() - t0) * 1000
                if expect_status is not None and resp.status_code != expect_status:
                    raise BadgerGatewayError(
                        f"{method} {path} returned {resp.status_code} (expected {expect_status})",
                        status_code=resp.status_code,
                        body=resp.text[:500],
                    )
                # 204 No Content
                if resp.status_code == 204 or not resp.content:
                    logger.debug(f"{method} {path} -> {resp.status_code} ({elapsed_ms:.1f}ms)")
                    return {}
                # 200 JSON
                try:
                    data = resp.json()
                except ValueError as e:
                    raise BadgerGatewayError(
                        f"{method} {path} returned non-JSON: {resp.text[:200]}",
                        status_code=resp.status_code,
                        body=resp.text[:500],
                    ) from e
                logger.debug(f"{method} {path} -> {resp.status_code} ({elapsed_ms:.1f}ms)")
                return data
            except (requests.ConnectionError, requests.Timeout) as e:
                last_exc = e
                if attempt < attempts:
                    time.sleep(self.config.retry_backoff_sec * attempt)
                    continue
                raise BadgerGatewayError(
                    f"{method} {path} 不可达 ({self.config.base_url}): {e}"
                ) from e
            except BadgerGatewayError:
                raise
            except Exception as e:
                raise BadgerGatewayError(f"{method} {path} 异常: {e}") from e
        # 不应到达这里, 兜底
        raise BadgerGatewayError(f"{method} {path} failed: {last_exc}")


# ── 便利函数 (模块级) ───────────────────────────────────────────────

_default_client: Optional[BadgerGatewayClient] = None


def get_default_client() -> BadgerGatewayClient:
    """获取模块默认单例 client (lazy init)

    适合不需要自定义配置的场景:
        from soloforge_ai_society.services.badger_grpc_client import get_default_client
        client = get_default_client()
        client.put(b"foo", b"bar")
    """
    global _default_client
    if _default_client is None:
        _default_client = BadgerGatewayClient()
    return _default_client


# ── 自动批聚合写 (P5 WriteBatch 触发器) ──────────────────────────

@dataclass
class BatchedWriterConfig:
    """BatchedWriter 配置

    Plan §24 P5: BadgerDB 批量提交, 满 size_threshold **或** flush_interval_ms
    哪个先到就触发一次 batch_put, 一次 fsync。
    """
    size_threshold: int = 1000            # 满 N 条 flush
    flush_interval_ms: float = 50.0       # 或每 50ms 强制 flush
    max_queue_size: int = 100_000         # 队列上限, 防止内存爆炸
    drop_on_overflow: bool = True         # 溢出策略: True=丢老, False=阻塞


class BatchedWriter:
    """自动批聚合写入器 (write-behind queue)

    把多次 put() 调用攒到 size_threshold 条 / flush_interval_ms,
    调一次 batch_put 走 gateway WriteBatch (一次 fsync)。

    Plan §24 P5 实测 10x QPS (单条 5K → 批量 50K)。

    用法:
        from soloforge_ai_society.services.badger_grpc_client import (
            BatchedWriter, BatchedWriterConfig, get_default_client
        )
        writer = BatchedWriter(get_default_client())
        writer.start()
        writer.put(b"k1", b"v1")
        writer.put(b"k2", b"v2", ttl_seconds=60)
        ...
        writer.flush()   # 强制 flush 一次
        writer.stop()    # 关闭 (会自动 flush 剩余)

    零破坏: 新类, 不改任何现有调用。
    """

    def __init__(
        self,
        client: BadgerGatewayClient,
        config: Optional[BatchedWriterConfig] = None,
    ) -> None:
        self.client = client
        self.config = config or BatchedWriterConfig()
        self._queue: List[Tuple[bytes, bytes, Optional[int]]] = []
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._stopped = False
        self._thread: Optional[threading.Thread] = None
        # 指标
        self.total_enqueued: int = 0
        self.total_flushed: int = 0
        self.total_batches: int = 0
        self.total_errors: int = 0
        self.total_failover_writes: int = 0
        self.total_failover_recovered: int = 0
        self.last_flush_at: Optional[float] = None
        self.last_batch_size: int = 0
        self.peak_queue_size: int = 0
        # M4 修复: 失败 fallback 目录 (gateway 挂时, batch 不丢)
        self._failover_dir = Path(
            os.environ.get(
                "SOLOFORGE_BADGER_FAILOVER_DIR",
                str(Path(tempfile.gettempdir()) / "soloforge_badger_failover"),
            )
        )
        self._failover_dir.mkdir(parents=True, exist_ok=True)

    def start(self) -> None:
        """启动后台 flush 线程 (幂等) + 启动时回收上次失败的 batch (M4)"""
        if self._thread is not None and self._thread.is_alive():
            return
        # M4: 启动时回收 failover 文件
        try:
            recovered = self.retry_pending()
            if recovered > 0:
                logger.info(
                    f"BatchedWriter start: recovered {recovered} items from prior failed flushes"
                )
        except Exception as e:
            logger.error(f"BatchedWriter start: retry_pending failed: {e}")
        self._stopped = False
        self._thread = threading.Thread(
            target=self._run, name="BatchedWriter-flush", daemon=True
        )
        self._thread.start()

    def stop(self, drain: bool = True) -> None:
        """停止后台线程, 可选 drain 剩余"""
        with self._cond:
            self._stopped = True
            self._cond.notify_all()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        if drain:
            self.flush()

    def put(
        self,
        key: Union[bytes, str],
        value: Union[bytes, str],
        ttl_seconds: Optional[int] = None,
    ) -> bool:
        """入队一条写, 立即返回 (非阻塞)。

        Returns:
            True 入队成功, False 队列满被丢弃 (drop_on_overflow=True 时)
        """
        key_b = key.encode("utf-8") if isinstance(key, str) else key
        val_b = value.encode("utf-8") if isinstance(value, str) else value
        with self._cond:
            if len(self._queue) >= self.config.max_queue_size:
                if self.config.drop_on_overflow:
                    return False
                while len(self._queue) >= self.config.max_queue_size and not self._stopped:
                    self._cond.wait(timeout=0.1)
                if self._stopped:
                    return False
            self._queue.append((key_b, val_b, ttl_seconds))
            self.total_enqueued += 1
            if len(self._queue) > self.peak_queue_size:
                self.peak_queue_size = len(self._queue)
            if len(self._queue) >= self.config.size_threshold:
                self._cond.notify_all()
            return True

    def flush(self) -> int:
        """强制 flush 一次, 返回本批条数"""
        with self._cond:
            if not self._queue:
                return 0
            batch = self._queue
            self._queue = []
        return self._do_flush(batch)

    def _run(self) -> None:
        """后台线程: 每 flush_interval_ms 检查一次, 满 size 也立即 flush"""
        interval = self.config.flush_interval_ms / 1000.0
        while True:
            with self._cond:
                if self._stopped:
                    return
                if len(self._queue) >= self.config.size_threshold:
                    batch = self._queue
                    self._queue = []
                else:
                    self._cond.wait(timeout=interval)
                    if self._stopped:
                        batch = self._queue
                        self._queue = []
                    elif len(self._queue) >= self.config.size_threshold:
                        batch = self._queue
                        self._queue = []
                    else:
                        if not self._queue:
                            continue
                        batch = self._queue
                        self._queue = []
            if batch:
                self._do_flush(batch)

    def _do_flush(self, batch: List[Tuple[bytes, bytes, Optional[int]]]) -> int:
        """执行一次 batch_put, 更新指标。
        M4 修复: gateway 失败时, batch 落盘到 _failover_dir, 不丢。
        """
        try:
            self.client.batch_put(batch)
            self.total_flushed += len(batch)
            self.total_batches += 1
            self.last_flush_at = time.time()
            self.last_batch_size = len(batch)
            logger.debug(
                f"BatchedWriter flush: {len(batch)} items "
                f"(total {self.total_flushed}, batches {self.total_batches})"
            )
            return len(batch)
        except BadgerGatewayError as e:
            self.total_errors += 1
            try:
                self._write_failover(batch, str(e))
                self.total_failover_writes += len(batch)
                logger.warning(
                    f"BatchedWriter flush failed ({e}); "
                    f"persisted {len(batch)} items to failover dir "
                    f"{self._failover_dir} (will retry on next start())"
                )
            except Exception as fe:
                logger.error(
                    f"BatchedWriter flush failed ({e}) AND failover write failed ({fe}); "
                    f"DROPPING {len(batch)} items (this is the original M4 bug)"
                )
            return 0

    def _write_failover(self, batch: List[Tuple[bytes, bytes, Optional[int]]], reason: str) -> None:
        """把失败的 batch 写到本地 jsonl 文件, 启动时 replay"""
        ts = time.strftime("%Y%m%d_%H%M%S")
        pid = os.getpid()
        fpath = self._failover_dir / f"failover_{ts}_{pid}_{threading.get_ident()}.jsonl"
        with open(fpath, "w", encoding="utf-8") as f:
            meta = {"ts": ts, "reason": reason, "items": len(batch)}
            f.write(json.dumps({"_meta": meta}) + "\n")
            for k, v, ttl in batch:
                f.write(
                    json.dumps(
                        {
                            "k": base64.b64encode(k).decode("ascii"),
                            "v": base64.b64encode(v).decode("ascii"),
                            "ttl": ttl,
                        }
                    )
                    + "\n"
                )

    def retry_pending(self) -> int:
        """启动时调用一次, 把上次没发出去的 batch 重发。
        Returns: 成功回收的条数。
        """
        recovered = 0
        if not self._failover_dir.exists():
            return 0
        for fp in sorted(self._failover_dir.glob("failover_*.jsonl")):
            try:
                batch: List[Tuple[bytes, bytes, Optional[int]]] = []
                with open(fp, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        obj = json.loads(line)
                        if "_meta" in obj:
                            continue
                        k = base64.b64decode(obj["k"])
                        v = base64.b64decode(obj["v"])
                        ttl = obj.get("ttl")
                        batch.append((k, v, ttl))
                if not batch:
                    fp.unlink(missing_ok=True)
                    continue
                try:
                    self.client.batch_put(batch)
                    recovered += len(batch)
                    self.total_failover_recovered += len(batch)
                    fp.unlink(missing_ok=True)
                    logger.info(
                        f"BatchedWriter.retry_pending: recovered {len(batch)} items from {fp.name}"
                    )
                except BadgerGatewayError as e:
                    logger.warning(
                        f"BatchedWriter.retry_pending: gateway still down ({e}), "
                        f"keep {fp.name} for next retry"
                    )
                    # 还在, 下次再试
            except Exception as e:
                logger.error(f"BatchedWriter.retry_pending: {fp.name} corrupted: {e}")
                fp.unlink(missing_ok=True)  # 损坏的丢掉, 避免循环卡住
        return recovered

    def stats(self) -> Dict[str, Any]:
        """返回当前指标快照"""
        with self._cond:
            current_queue_size = len(self._queue)
        avg_batch = (
            self.total_flushed / self.total_batches if self.total_batches > 0 else 0.0
        )
        return {
            "current_queue_size": current_queue_size,
            "peak_queue_size": self.peak_queue_size,
            "total_enqueued": self.total_enqueued,
            "total_flushed": self.total_flushed,
            "total_batches": self.total_batches,
            "total_errors": self.total_errors,
            "total_failover_writes": self.total_failover_writes,
            "total_failover_recovered": self.total_failover_recovered,
            "failover_dir": str(self._failover_dir),
            "avg_batch_size": round(avg_batch, 2),
            "last_batch_size": self.last_batch_size,
            "last_flush_at": self.last_flush_at,
            "config": {
                "size_threshold": self.config.size_threshold,
                "flush_interval_ms": self.config.flush_interval_ms,
                "max_queue_size": self.config.max_queue_size,
            },
        }
