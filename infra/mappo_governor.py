# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Infrastructure: Python MAPPO Resource Governor Daemon
# Path: infra/mappo_governor.py
# ─────────────────────────────────────────────────────────────────

import sys
import json

def main():
    # 强制将标准输出切换为无缓冲（Unbuffered）流
    # 绝杀 Python 原生大块内存 Buffer 带来的跨语言 I/O 挂起死等问题
    sys.stdout.reconfigure(line_buffering=True)
    
    while True:
        try:
            # 阻塞式读取 Node.js 通过 Stdin 砸过来的单行 JSON
            raw_line = sys.stdin.readline()
            if not raw_line:
                break
                
            packet = json.loads(raw_line)
            request_id = packet.get("id")
            global_state = packet.get("globalState", [0.0, 0.0, 0.0])
            
            # 🧠 抽取 Node 遥测送来的物理 CPU 特征负载
            current_cpu_load = global_state[0]
            
            # 🧬 模拟 MAPPO（多智能体近端策略优化）Actor-Critic 神经网络的前向推理逻辑
            # 在真实的生产环境下，这里通过 import torch 加载模型并执行：model(state)
            if current_cpu_load > 0.90:
                inferred_action = 2  # 触发最高级别断路熔断
            elif current_cpu_load > 0.70:
                inferred_action = 1  # 降级流控
            else:
                inferred_action = 0  # 绿色全畅通放行

            # 封装响应报文，以 \n 结尾轰鸣砸回 Stdout
            response = {
                "id": request_id,
                "action": inferred_action
            }
            sys.stdout.write(json.dumps(response) + "\n")
            
        except Exception as e:
            # 异常隔离，防止因为单次脏报文导致 Python 常驻进程垮塌
            continue

if __name__ == "__main__":
    main()