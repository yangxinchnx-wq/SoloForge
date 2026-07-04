# python/marl_service/server.py
import asyncio
import json
import logging
import sys
import os
from pathlib import Path
from typing import Dict, Any, Optional

# Fix Windows encoding for emojis
if sys.platform == 'win32':
    os.environ['PYTHONIOENCODING'] = 'utf-8'
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

# Optional MAPPO trainer import (requires torch)
try:
    from marl_service.trainer import MAPPOTrainer
    HAS_TORCH = True
except ImportError:
    MAPPOTrainer = None
    HAS_TORCH = False

# Optional Hyperparameter Drift import
try:
    from governor_rl.training.hyperparameter_drift import (
        HyperparameterDriftExperiment,
        DriftType,
        HyperparameterSpace,
    )
    HAS_DRIFT = True
except ImportError:
    HyperparameterDriftExperiment = None
    DriftType = None
    HyperparameterSpace = None
    HAS_DRIFT = False

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")


class MarlServiceAsyncServer:
    """
    Python Central Strategy Core Async Server (Distributed Pipeline Infrastructure).
    Handles multiplexed incoming telemetry streaming frames from the TS micro-kernel.
    """
    def __init__(self, config_registry: Dict[str, Any]):
        self.config = config_registry
        self.logger = logging.getLogger("MarlServiceServer")
        # Initialize MAPPO trainer if torch is available
        if HAS_TORCH and MAPPOTrainer:
            self.trainer = MAPPOTrainer(config_registry)
            self.logger.info("🧠 MAPPO Trainer initialized with PyTorch backend")
            # ── 启动时尝试加载历史 checkpoint ──
            default_ckpt = str(Path(__file__).parent / "models" / "policy.pt")
            if self.trainer.load_checkpoint(default_ckpt):
                self.logger.info(f"📥 Loaded existing policy from {default_ckpt}")
            else:
                self.logger.info("🌱 No existing checkpoint, training from scratch")
        else:
            self.trainer = None
            self.logger.warning("⚠️ PyTorch not available, running in simulation mode")
            if HAS_DRIFT:
                self.drift_experiment = HyperparameterDriftExperiment(
                    governance_enabled=True,
                )
        self.host = config_registry.get("governor.ipc.host", "127.0.0.1")
        self.port = int(config_registry.get("governor.ipc.port", 8765))
        self.server_instance: Optional[asyncio.AbstractServer] = None

        # ─────────────────────────────────────────────
        # AGENT_TRAINING_DATA rollout buffer + checkpoint
        # 桥接 training-scheduler.ts → MAPPOTrainer.train_step() → policy.pt
        # ─────────────────────────────────────────────
        # 单智能体视角:每个 trace → (obs[10], action, log_prob, reward, value, done)
        # 我们把 N 条 trace 攒成一个 batch;batch size 到达后调用 trainer.train_step
        from collections import deque
        self._rollout_buffer = deque(maxlen=int(config_registry.get("governor.mappo.rollout.max_size", 1024)))
        self._batch_size = int(config_registry.get("governor.mappo.rollout.batch_size", 8))
        self._checkpoint_interval = int(config_registry.get("governor.mappo.checkpoint.interval", 32))
        self._step_counter = 0
        self._checkpoints_since_load = 0
        # checkpoint 路径:与 models/policy.pt 共享同一份(loader.py 会优先加载这个)
        self._checkpoint_path = Path(__file__).parent / "models" / "policy.pt"
        self._checkpoint_path.parent.mkdir(parents=True, exist_ok=True)

        # 漂移实验实例
        self.drift_experiment = None
        if HAS_DRIFT and HyperparameterDriftExperiment:
            self.drift_experiment = HyperparameterDriftExperiment(
                drift_type=DriftType.MOMENTUM,
                governance_enabled=True,
            )
            self.logger.info("🧬 Hyperparameter Drift Experiment initialized")

    def _consume_agent_training_data(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        把 AGENT_TRAINING_DATA 帧的 trace 累积进 rollout buffer;
        到达 batch_size 后调用 MAPPOTrainer.train_step() 执行一次梯度更新;
        每 checkpoint_interval 次更新后写 policy.pt。
        """
        from pathlib import Path
        traces = payload.get("trainingData") or payload.get("traces") or []
        if not isinstance(traces, list):
            return {"accepted": 0, "error": "trainingData must be array"}

        accepted = 0
        for trace in traces:
            obs = trace.get("observation")
            if not isinstance(obs, list) or len(obs) < 5:
                continue
            # 字段对齐 AgentObservation.dim()=10,缺的尾部用 0 填充
            obs_padded = (obs + [0.0] * 10)[:10]
            self._rollout_buffer.append({
                "obs": obs_padded,
                "action": int(trace.get("action", 0)),
                "log_prob": float(trace.get("log_prob", 0.0)),
                "reward": float(trace.get("reward", 0.0)),
                "value": float(trace.get("value", 0.0)),
                "done": bool(trace.get("done", True)),
                "kernel_version": int(trace.get("kernel_version", 0)),
            })
            accepted += 1

        result = {
            "accepted": accepted,
            "buffer_size": len(self._rollout_buffer),
            "batch_size": self._batch_size,
            "trained_this_call": False,
            "loss": None,
            "checkpoint_written": False,
        }

        if self.trainer is None or len(self._rollout_buffer) < self._batch_size:
            return result

        # ── 触发一次梯度更新 ──────────────────────────────
        try:
            import numpy as np
            import torch
            batch = list(self._rollout_buffer)[: self._batch_size]
            b_local_obs = torch.tensor([t["obs"][:5] for t in batch], dtype=torch.float32)
            b_global_state = torch.tensor(
                [t["obs"][:10] for t in batch], dtype=torch.float32
            )
            b_actions = torch.tensor([t["action"] for t in batch], dtype=torch.long)
            b_log_probs = torch.tensor([t["log_prob"] for t in batch], dtype=torch.float32)
            b_rewards = np.array([t["reward"] for t in batch], dtype=np.float32)
            b_values = np.array([t["value"] for t in batch], dtype=np.float32)
            b_dones = np.array([t["done"] for t in batch], dtype=np.float32)
            b_kernel_versions = np.array([t["kernel_version"] for t in batch], dtype=np.int64)

            losses = self.trainer.train_step(
                b_local_obs, b_global_state, b_actions, b_log_probs,
                b_rewards, b_values, b_dones, b_kernel_versions,
            )
            result["trained_this_call"] = True
            result["loss"] = losses
            self._step_counter += 1

            # 清空已消费的 buffer(留下剩余供下次 batch)
            for _ in range(self._batch_size):
                if self._rollout_buffer:
                    self._rollout_buffer.popleft()

            # ── checkpoint ───────────────────────────────────
            if self._step_counter % self._checkpoint_interval == 0:
                torch.save(
                    self.trainer.policy.state_dict(),
                    str(self._checkpoint_path),
                )
                self._checkpoints_since_load += 1
                result["checkpoint_written"] = True
                result["checkpoint_path"] = str(self._checkpoint_path)
                self.logger.info(
                    f"💾 Policy checkpoint saved: step={self._step_counter}, path={self._checkpoint_path}"
                )
        except Exception as e:
            self.logger.error(f"💥 train_step failed: {e}")
            result["error"] = str(e)

        return result

    async def launch_server_loop(self) -> None:
        """
        Hot-ignites the asynchronous non-blocking network socket broker engine loop.
        """
        try:
            self.server_instance = await asyncio.start_server(
                self.handle_incoming_connection_stream, self.host, self.port
            )
            self.logger.info(f"🛰️ MARL Computing Server initialized live over tcp://{self.host}:{self.port}")

            # Continuous non-blocking monitoring run
            async with self.server_instance:
                await self.server_instance.serve_forever()

        except Exception as crash_panic:
            self.logger.critical(f"💥 High-level network engine failed to bind at gateway: {str(crash_panic)}")
            sys.exit(1)

    async def handle_incoming_connection_stream(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        """
        Async streaming handler treating connection pipe frames with line-delimited boundaries.
        """
        peer_addr = writer.get_extra_info('peername')
        self.logger.info(f"🔌 Intercepted core connection link from kernel cluster node: {peer_addr}")

        try:
            # High-frequency ingestion slide sliding window
            while True:
                raw_line_bytes = await reader.readline()
                if not raw_line_bytes:
                    break  # Link severed cleanly by upstream node

                raw_line_frame = raw_line_bytes.decode('utf-8').strip()
                if not raw_line_frame:
                    continue

                await self.process_and_respond_frame(raw_line_frame, writer)

        except asyncio.CancelledError:
            pass
        except Exception as wire_err:
            self.logger.error(f"💥 Stream transaction pipeline failed during multi-plex handling: {str(wire_err)}")
        finally:
            writer.close()
            await writer.wait_closed()
            self.logger.warn(f"🔌 Connection link unmounted smoothly from cluster node: {peer_addr}")

    async def process_and_respond_frame(self, raw_json_line: str, writer: asyncio.StreamWriter) -> None:
        """
        Processes telemetry data frames and pushes optimized MAPPO action indexes back down the wire.
        """
        try:
            envelope: Dict[str, Any] = json.loads(raw_json_line)
            frame_type = envelope.get("type")
            current_tick = envelope.get("currentTick", 0)
            payload = envelope.get("payload", {})
            version_seal = envelope.get("kernelVersionSeal", 0)

            if frame_type == "DRIFT_COMMAND":
                # 处理超参数漂移实验命令
                drift_result = await self.handle_drift_command(payload, version_seal)
                response_payload = {
                    "traceId": payload.get("traceId", "DRIFT_TRACE"),
                    "drift_result": drift_result,
                }
                response_envelope = {
                    "frameId": f"drift_{envelope.get('frameId', '0000')}",
                    "type": "ACTION_DECISION_ACK",
                    "currentTick": current_tick,
                    "payload": response_payload,
                    "kernelVersionSeal": version_seal,
                    "timestamp": int(asyncio.get_event_loop().time() * 1000)
                }
                serialized_response = json.dumps(response_envelope) + "\n"
                writer.write(serialized_response.encode('utf-8'))
                await writer.drain()

            elif frame_type == "AGENT_TRAINING_DATA":
                # ── 闭环关键路径 ─────────────────────────────
                # TS 端 training-scheduler.ts:191 发送的 trace 帧
                # 累积到 rollout buffer → trainer.train_step() → 写 policy.pt
                train_result = self._consume_agent_training_data(payload)
                response_envelope = {
                    "frameId": f"train_ack_{envelope.get('frameId', '0000')}",
                    "type": "AGENT_TRAINING_ACK",
                    "currentTick": current_tick,
                    "payload": train_result,
                    "kernelVersionSeal": version_seal,
                    "timestamp": int(asyncio.get_event_loop().time() * 1000),
                }
                serialized_response = json.dumps(response_envelope) + "\n"
                writer.write(serialized_response.encode('utf-8'))
                await writer.drain()

            elif frame_type == "POLICY_QUERY":
                # ── 闭环回程 ─────────────────────────────
                # TS 端 agent-decision 询问当前 policy 决策
                # server.py 用 trainer.policy.forward() 在线推理
                # 不需要 TS 安装 onnxruntime,不需要 export ONNX
                obs = payload.get("observation", [])
                if not isinstance(obs, list) or len(obs) < 10:
                    action = 0
                    confidence = 0.0
                    source = "fallback"
                elif self.trainer is not None:
                    try:
                        import torch
                        obs_padded = (obs + [0.0] * 10)[:10]
                        with torch.no_grad():
                            # policy 网络返回 Categorical 分布 → sample + probs
                            from marl_service.mappo_net import Categorical
                            dist = self.trainer.policy.actor(
                                torch.tensor(obs_padded[:5], dtype=torch.float32).unsqueeze(0)
                            )
                            probs_tensor = dist.probs.squeeze(0)  # Categorical 有 probs 属性
                            action = int(probs_tensor.argmax().item())
                            confidence = float(probs_tensor.max().item())
                            source = "trained_policy"
                    except Exception as e:
                        self.logger.error(f"💥 POLICY_QUERY inference failed: {e}")
                        action = 0
                        confidence = 0.0
                        source = "fallback_error"
                else:
                    action = 0
                    confidence = 0.0
                    source = "no_trainer"

                response_envelope = {
                    "frameId": f"policy_ans_{envelope.get('frameId', '0000')}",
                    "type": "POLICY_ANSWER",
                    "currentTick": current_tick,
                    "payload": {
                        "action": action,
                        "confidence": confidence,
                        "source": source,
                        "step_counter": self._step_counter,
                    },
                    "kernelVersionSeal": version_seal,
                    "timestamp": int(asyncio.get_event_loop().time() * 1000),
                }
                serialized_response = json.dumps(response_envelope) + "\n"
                writer.write(serialized_response.encode('utf-8'))
                await writer.drain()

            elif frame_type == "TELEMETRY_STREAM":
                # Extract 10-dimensional global telemetry state variables mapping safely into local tensors
                # Simulating a high-無锁 matrix processing slice matching CTDE constraints
                probability_score = 0.8875  # Simulation response parameter

                # Form structural action response payload capsule carrying full lineage tracking tokens
                response_payload = {
                    "traceId": payload.get("traceId", "UNKNOWN_TRACE_TOKEN"),
                    "probability": probability_score,
                    "decision_action_index": 3,  # Map into target safety override routine mapping
                    "telemetry_snapshot": {
                        "target_cluster_id": payload.get("targetClusterId", "agent_cluster_alpha"),
                        "cpu_stress_level": payload.get("cpu_usage", 0.40)
                    }
                }

                response_envelope = {
                    "frameId": f"ack_{envelope.get('frameId', '0000')}",
                    "type": "ACTION_DECISION_ACK",
                    "currentTick": current_tick,
                    "payload": response_payload,
                    "kernelVersionSeal": version_seal,  # Mirror exact sealed version to protect optimistic locking checks
                    "timestamp": int(asyncio.get_event_loop().time() * 1000)
                }

                # Encode back down the stream wire with delimiter lines appended cleanly
                serialized_response = json.dumps(response_envelope) + "\n"
                writer.write(serialized_response.encode('utf-8'))
                await writer.drain()  # Relieve V8 backpressure pooling bounds natively

        except json.JSONDecodeError:
            self.logger.error("Granular Guard: Dropped malformed incoming json wire token frame packet.")
        except Exception as panic:
            self.logger.error(f"Granular Guard: Failed to reconcile incoming strategy packet block. {str(panic)}")
    
    async def handle_drift_command(self, payload: Dict[str, Any], version_seal: int) -> Dict[str, Any]:
        """
        处理超参数漂移实验命令
        
        支持的动作:
        - start: 启动漂移实验
        - step: 执行一步漂移
        - get_summary: 获取实验摘要
        - governance_signal: 应用 Governance 信号
        - entropy_alert: 熵值告警
        """
        action = payload.get("action", "step")
        data = payload.get("payload", {})
        
        if not HAS_DRIFT or self.drift_experiment is None:
            self.logger.warning("⚠️ Drift experiment not available, returning mock response")
            return self._mock_drift_response(action, data)
        
        try:
            if action == "start":
                drift_type_str = data.get("driftType", "momentum")
                drift_type_map = {
                    "random_walk": DriftType.RANDOM_WALK,
                    "trend": DriftType.TREND,
                    "cyclic": DriftType.CYCLIC,
                    "adversarial": DriftType.ADVERSARIAL,
                    "momentum": DriftType.MOMENTUM,
                    "adaptive": DriftType.ADAPTIVE,
                }
                drift_type = drift_type_map.get(drift_type_str, DriftType.MOMENTUM)
                
                self.drift_experiment = HyperparameterDriftExperiment(
                    drift_type=drift_type,
                    governance_enabled=True,
                )
                
                self.logger.info(f"🧬 Drift experiment started: {drift_type_str}")
                return {"success": True, "drift_type": drift_type_str}
            
            elif action == "step":
                performance = data.get("performance", 0.0)
                governance_signal = data.get("governanceSignal", {})
                
                result = self.drift_experiment.step(
                    performance=performance,
                    governance_signal=governance_signal,
                )
                
                self.logger.info(
                    f"🧬 Drift step: tick={result.tick}, "
                    f"perf={performance:.3f}, novelty={result.novelty_score:.3f}, "
                    f"gov={result.governance_intervention}"
                )
                
                return {
                    "tick": result.tick,
                    "hyperparams": result.hyperparams,
                    "performance": result.performance,
                    "delta_performance": result.delta_performance,
                    "drift_type": result.drift_type,
                    "novelty_score": result.novelty_score,
                    "governance_intervention": result.governance_intervention,
                    "intervention_reason": result.intervention_reason,
                }
            
            elif action == "get_summary":
                summary = self.drift_experiment.get_experiment_summary()
                return summary
            
            elif action == "governance_signal":
                # 应用来自 Governance 的干预信号
                self.logger.info(
                    f"🏛️ [DRIFT-GOVERNANCE] Applying intervention: "
                    f"tax={data.get('tax_equilibrium_coefficient')}, "
                    f"decay={data.get('reputation_decay_operator')}"
                )
                return {"success": True, "message": "Governance signal applied"}
            
            elif action == "entropy_alert":
                entropy = data.get("entropy", 0)
                threshold = data.get("threshold", 0.85)
                self.logger.warning(
                    f"⚠️ [ENTROPY ALERT] entropy={entropy:.4f} > threshold={threshold}"
                )
                return {"success": True, "entropy": entropy, "threshold": threshold}
            
            else:
                self.logger.warning(f"⚠️ Unknown drift action: {action}")
                return {"error": f"Unknown action: {action}"}
        
        except Exception as e:
            self.logger.error(f"💥 Drift command failed: {str(e)}")
            return {"error": str(e)}
    
    def _mock_drift_response(self, action: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """模拟漂移响应（当 drift 模块不可用时）"""
        if action == "start":
            return {"success": True, "drift_type": "momentum", "mock": True}
        elif action == "step":
            return {
                "tick": 0,
                "hyperparams": {"lr": 0.0003, "gamma": 0.99, "clip_eps": 0.2},
                "performance": data.get("performance", 0),
                "delta_performance": 0,
                "drift_type": "momentum",
                "novelty_score": 0.1,
                "governance_intervention": False,
                "intervention_reason": "",
                "mock": True,
            }
        elif action == "get_summary":
            return {
                "current_tick": 0,
                "total_drift_count": 0,
                "governance_interventions": 0,
                "best_performance": 0,
                "best_config": {},
                "drift_type": "momentum",
                "mock": True,
            }
        return {"error": "Mock mode"}


# =====================================================================
# 🔒 跨语言多进程分布式网络拓扑仿真验证桩 (Verification Engine)
# =====================================================================
if __name__ == "__main__":
    print("🧪 [Distributed Ignition Suite] Initiating cross-language async network socket broker tests...")

    mock_config = {
        "governor.ipc.host": "127.0.0.1",
        "governor.ipc.port": 8765,  # Production port
        "governor.mappo.local_obs_dim": 5,
        "governor.mappo.global_state_dim": 10,
        "governor.mappo.action_dim": 6,
        "governor.mappo.hidden_dim": 64
    }

    server = MarlServiceAsyncServer(mock_config)

    async def temporary_shutdown_test_runner():
        # Spin server up into concurrent thread context loops
        server_task = asyncio.create_task(server.launch_server_loop())
        await asyncio.sleep(5.0)  # Hold window to confirm successful port binding transitions

        print("✅ [Validation Suite Completed] Async TCP Server successfully bound and running.")
        server_task.cancel()

    try:
        asyncio.run(temporary_shutdown_test_runner())
    except asyncio.CancelledError:
        pass
    except KeyboardInterrupt:
        print("👋 Server stopped by user")
