# -*- coding: utf-8 -*-
import socket, json, sys, time
sys.stdout.reconfigure(encoding='utf-8')

sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.settimeout(3)
sock.connect(('127.0.0.1', 8765))

frame = {
    "frameId": "stats_query",
    "type": "TELEMETRY_STREAM",
    "currentTick": 99999,
    "payload": {
        "traceId": "stats",
        "queue_depth": 1500,
        "cpu_usage": 0.55,
        "worker_count": 80,
        "cpu_variance": 0.15,
        "load_pressure": 0.35,
    },
    "kernelVersionSeal": 1,
    "timestamp": int(time.time() * 1000)
}
sock.sendall((json.dumps(frame) + "\n").encode('utf-8'))
resp = json.loads(sock.recv(8192).decode('utf-8').strip())
sock.close()

p = resp['payload']
print("=" * 50)
print("MARL SERVICE LIVE STATISTICS")
print("=" * 50)
print(f"Critic Warmed:     {p.get('critic_warmed')}")
print(f"Critic Variance:  {p.get('critic_variance'):.6f}")
print(f"Frames Received:   {p.get('stats', {}).get('frames_received', 'N/A')}")
print(f"Uptime:           {p.get('stats', {}).get('uptime_seconds', 'N/A')}s")
print(f"Value Mean:       {p.get('stats', {}).get('value_mean', 'N/A'):.4f}")
print(f"Value Std:        {p.get('stats', {}).get('value_std', 'N/A'):.4f}")
print(f"Last Value Est:   {p.get('valueEstimate', 'N/A'):.4f}")
print(f"Last Reward:      {p.get('rewardSignal', 'N/A'):.4f}")
action_names = ['NO_OP', 'PERF_MODE', 'CIRCUIT_BRKR', 'EXPAND', 'SHRINK', 'HOLD']
action = p.get('decision_action_index', -1)
action_name = action_names[action] if 0 <= action < 6 else 'UNKNOWN'
print(f"Last Action:       {action} ({action_name})")
state = p.get('telemetry_snapshot', {}).get('global_state', [])
print(f"Global State:     {state}")
print("=" * 50)
