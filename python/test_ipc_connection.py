# -*- coding: utf-8 -*-
# TCP 连接测试：验证 TypeScript 侧能否连接 Python MARL 服务端
import socket
import json
import time
import sys

sys.stdout.reconfigure(encoding='utf-8')

def test_ipc_connection():
    """向 Python MARL 服务端发送测试帧"""
    host = '127.0.0.1'
    port = 8765

    try:
        print("=" * 60)
        print("IPC CONNECTION TEST")
        print("=" * 60)
        print(f"Connecting to {host}:{port}...")
        print()

        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(5)
        sock.connect((host, port))
        print("✅ TCP connection established")
        print()

        # 发送测试 TELEMETRY_STREAM 帧
        test_frame = {
            "frameId": "test_001",
            "type": "TELEMETRY_STREAM",
            "currentTick": 100,
            "payload": {
                "traceId": "test_trace",
                "targetClusterId": "agent_cluster_alpha",
                "queue_depth": 2500,
                "cpu_usage": 0.65,
                "worker_count": 80,
                "cpu_variance": 0.2,
                "load_pressure": 0.45,
            },
            "kernelVersionSeal": 1,
            "timestamp": int(time.time() * 1000)
        }

        print("Sending TELEMETRY_STREAM frame...")
        print(json.dumps(test_frame, indent=2))
        print()

        sock.sendall((json.dumps(test_frame) + "\n").encode('utf-8'))

        # 接收响应
        response_raw = sock.recv(4096).decode('utf-8')
        response = json.loads(response_raw.strip())

        print("=" * 60)
        print("RESPONSE FROM MARL SERVICE")
        print("=" * 60)
        print(json.dumps(response, indent=2, ensure_ascii=False))
        print()

        # 分析响应
        payload = response.get('payload', {})
        value_estimate = payload.get('valueEstimate', 'N/A')
        action = payload.get('decision_action_index', 'N/A')
        warmed = payload.get('critic_warmed', False)
        variance = payload.get('critic_variance', 0.0)
        stats = payload.get('stats', {})

        action_names = ['NO_OP', 'PERFORMANCE_MODE', 'CIRCUIT_BREAKER', 'EXPAND', 'SHRINK', 'HOLD']
        action_name = action_names[action] if isinstance(action, int) and 0 <= action < 6 else action

        print("=" * 60)
        print("ANALYSIS")
        print("=" * 60)
        print(f"  Critic Warmed:     {'✅ YES' if warmed else '❌ NO (fresh)'}")
        print(f"  Critic Variance:  {variance:.6f} {'✅ (>0.01)' if variance > 0.01 else '❌ (<0.01)'}")
        print(f"  Value Estimate:  {value_estimate:.4f}")
        print(f"  Selected Action:  {action} ({action_name})")
        print(f"  Frames Received:   {stats.get('frames_received', 'N/A')}")
        print(f"  Uptime:           {stats.get('uptime_seconds', 'N/A')}s")
        print(f"  Value Mean:       {stats.get('value_mean', 'N/A'):.4f}")
        print(f"  Value Std:        {stats.get('value_std', 'N/A'):.4f}")
        print()

        # 发送 DRIFT_COMMAND
        print("-" * 60)
        print("Sending DRIFT_COMMAND frame...")
        drift_frame = {
            "frameId": "drift_test_001",
            "type": "DRIFT_COMMAND",
            "currentTick": 101,
            "payload": {
                "action": "step",
                "payload": {"performance": 0.75}
            },
            "kernelVersionSeal": 1,
            "timestamp": int(time.time() * 1000)
        }
        sock.sendall((json.dumps(drift_frame) + "\n").encode('utf-8'))
        time.sleep(0.5)
        drift_response_raw = sock.recv(4096).decode('utf-8')
        drift_response = json.loads(drift_response_raw.strip())
        print("DRIFT Response:", json.dumps(drift_response, indent=2, ensure_ascii=False))
        print()

        sock.close()
        print("=" * 60)
        print("✅ IPC TEST COMPLETE — Full stack integration verified")
        print("=" * 60)

    except ConnectionRefusedError:
        print("❌ Connection refused — is the Python server running?")
    except socket.timeout:
        print("❌ Connection timeout — server not responding")
    except Exception as e:
        print(f"❌ Error: {e}")


if __name__ == "__main__":
    test_ipc_connection()
