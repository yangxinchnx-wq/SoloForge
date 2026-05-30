# python/governor_rl/test_replay_alignment.py
import json
from governor_rl.lineage_tracer import GranularLineageTracer

if __name__ == "__main__":
    print("🧪 [Testing Replay] Initiating E2E multi-宇宙 historical replay sequence verification tracking...")

    mock_config = {
        "governor.audit.entropy_tolerance": 0.05,
        "governor.scale.queue_depth": 300.0,
        "governor.scale.starvation_penalty": 15.0
    }

    tracer = GranularLineageTracer(mock_config)

    # 模态 1：历史事实真相完全重合场景 (Historical Exact Match)
    perfect_record = {
        "traceId": "trace_assert_seq_8831",
        "telemetry_snapshot": {"cpu_usage": 0.45, "memory_pressure": 0.35, "queue_depth": 60, "starvation_penalty": 0.0}
    }
    # Optimized Python observation tensor mapping
    current_tensor_match = [0.45, 0.35, 0.20, 0.0] # 60 / 300 = 0.20
    matched, info_match = tracer.audit_replayed_trajectory_slice(json.dumps(perfect_record), current_tensor_match)
    print(f"... [Scenario 1 - Perfect Match ]: Aligned: {matched} | Trace Token: {info_match['audit.lineage.trace_token']}")
    assert matched is True, "Exact match tracking assertion error"

    # 模态 2：黄金区运行态边界抖动场景 (Golden Zone Border Jitter - Mild Delta Handling)
    jitter_record = {
        "traceId": "trace_assert_seq_8832",
        "telemetry_snapshot": {"cpu_usage": 0.48, "memory_pressure": 0.35, "queue_depth": 60, "starvation_penalty": 0.0}
    }
    # Slightly minor drifted tensor simulation inside bounded limits
    current_tensor_jitter = [0.46, 0.35, 0.20, 0.0] # CPU delta = 0.02 <= 0.05 tolerance
    jittered, info_jitter = tracer.audit_replayed_trajectory_slice(json.dumps(jitter_record), current_tensor_jitter)
    print(f"... [Scenario 2 - Border Jitter  ]: Aligned: {jittered} | CPU Delta: {info_jitter.get('audit.drift.cpu_range_delta', info_jitter.get('audit.drift.cpu_delta')):.4f}")
    assert jittered is True, "System must tolerate minor variance within entropy bounds"

    # 模态 3：轻度过载橙色异常偏差漂移场景 (Mild Overload State Drift Error)
    drift_record = {
        "traceId": "trace_assert_seq_8833",
        "telemetry_snapshot": {"cpu_usage": 0.72, "memory_pressure": 0.65, "queue_depth": 180, "starvation_penalty": 2.0}
    }
    # Significant matrix mismatch anomaly simulation
    current_tensor_drift = [0.55, 0.65, 0.60, 2.0] # CPU delta = 0.17 > 0.05 tolerance limit
    diverged, info_drift = tracer.audit_replayed_trajectory_slice(json.dumps(drift_record), current_tensor_drift)
    print(f"... [Scenario 3 - Matrix Drift   ]: Aligned: {diverged} | System Flag Status: Anomaly Caught Intercepted")
    assert diverged is False, "Safety barrier circuit breaker failed to intercept structural misalignment"

    # 模态 4：畸形语法半包日志流防御场景 (Malformed Split Packet Crash Test)
    broken_payload = "{truncated_json_chunk: true,"
    crashed, info_crash = tracer.audit_replayed_trajectory_slice(broken_payload, current_tensor_match)
    print(f"... [Scenario 4 - Syntax Defense ]: Handled: {not crashed} | Error Identifier Token: {info_crash['error']}")
    assert crashed is False and info_crash['error'] == "MALFORMED_JSON_SYNTAX", "Granular shield naming mismatch"

    print("\n✅ [Causal Lineage Verification Completed] Replay indexing guidance engines achieved 100% frozen specification.")
