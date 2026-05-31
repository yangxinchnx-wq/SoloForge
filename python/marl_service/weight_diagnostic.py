# -*- coding: utf-8 -*-
# 权重注入可行性诊断
# 检查 governor_rl BC 和 marl_service Actor 的维度兼容性

import sys, os
sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import torch
import torch.nn as nn

# Governor RL BC Network
class BCNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(10, 128), nn.ReLU(),
            nn.Linear(128, 128), nn.ReLU(),
            nn.Linear(128, 5),
        )
    def forward(self, x): return self.net(x)

# MARL Service MAPPO Actor
class DecentralizedActor(nn.Module):
    def __init__(self, local_obs_dim=5, action_dim=6, hidden_dim=64):
        super().__init__()
        self.network = nn.Sequential(
            nn.Linear(local_obs_dim, hidden_dim), nn.Tanh(),
            nn.Linear(hidden_dim, hidden_dim), nn.Tanh(),
            nn.Linear(hidden_dim, action_dim)
        )

print("=" * 60)
print("WEIGHT INJECTION FEASIBILITY DIAGNOSTIC")
print("=" * 60)
print()

bc = BCNet()
actor = DecentralizedActor(5, 6, 64)

print("=== Architecture Dimension Comparison ===")
print()
print("governor_rl BC:")
print(f"  Input:  {list(bc.net[0].weight.shape)}   (10-dim state: queue, workers, zone, lr, etc.)")
print(f"  Hidden: {list(bc.net[2].weight.shape)}   (128 units)")
print(f"  Output: {list(bc.net[4].weight.shape)}   (5 actions)")
print()
print("marl_service Actor:")
print(f"  Input:  {list(actor.network[0].weight.shape)}   (5-dim local obs)")
print(f"  Hidden: {list(actor.network[2].weight.shape)}   (64 units)")
print(f"  Output: {list(actor.network[4].weight.shape)}   (6 actions)")
print()
print("=== Dimension Conflicts ===")
print(f"  Input:  10 vs 5      -> Direct injection NOT possible")
print(f"  Output: 5 vs 6       -> Action space incompatible")
print(f"  Hidden: 128 vs 64    -> Capacity mismatch")
print()

# Load BC checkpoint and inspect
bc_path = "checkpoints/bc_policy_v3_1_clean.pt"
if os.path.exists(bc_path):
    ckpt = torch.load(bc_path, map_location='cpu', weights_only=False)
    bc_state = ckpt['policy_state_dict']
    print("=== BC Checkpoint Analysis ===")
    for k, v in bc_state.items():
        print(f"  {k}: {v.shape}")
    print()

    # Check: what does BC's first-layer activation look like?
    print("=== BC Feature Importance (first-layer mean abs weights) ===")
    layer0 = bc_state['net.0.weight']  # 128 x 10
    importance = layer0.abs().mean(dim=0)  # 10 features
    feature_names = [
        "queue_depth", "cpu_usage_1", "cpu_usage_2",
        "worker_count", "cpu_usage_cur",
        "reserved_1", "reserved_2", "reserved_3",
        "zone", "lr_norm"
    ]
    for name, imp in zip(feature_names, importance.tolist()):
        bar = "=" * int(imp * 20)
        print(f"  {name:15s}: {imp:.4f} {bar}")
    print()
else:
    print("BC checkpoint not found at:", bc_path)

print("=" * 60)
print("FEASIBILITY VERDICT")
print("=" * 60)
print()
print("Direct weight injection: IMPOSSIBLE (dimension mismatch)")
print()
print("Viable path: Feature Mapping + Layer Projection")
print("  Step 1: Map BC's 10 features -> 5 local obs dimensions")
print("  Step 2: Project 128-dim hidden -> 64-dim")
print("  Step 3: Map 5 BC actions -> 6 MARL actions")
print()
print("Best mapping candidates from BC features:")
print("  MARL local_obs[0] <- BC queue_depth/1000")
print("  MARL local_obs[1] <- BC cpu_usage (avg)")
print("  MARL local_obs[2] <- BC worker_count/200")
print("  MARL local_obs[3] <- BC zone/4 (normalized)")
print("  MARL local_obs[4] <- BC lr_norm")
print()
print("Action mapping (BC -> MARL):")
print("  BC[0] noop        <- MARL[0] NO_OP")
print("  BC[1] expand1     <- MARL[1] PERFORMANCE_MODE")
print("  BC[2] expand2     <- MARL[2] CIRCUIT_BREAKER")
print("  BC[3] shrink1     <- MARL[3] EXPAND")
print("  BC[4] shrink2     <- MARL[4] SHRINK")
print("  MARL[5] HOLD      <- new action (not in BC)")
print("=" * 60)
