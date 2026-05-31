# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge MARL Service - 初始化
# Path: python/marl_service/__init__.py
# ─────────────────────────────────────────────────────────────────

# Make torch dependencies optional
try:
    from .mappo_net import DecentralizedActor, CentralizedCritic, MAPPONetwork
    from .trainer import MAPPOTrainer, Experience
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False
    DecentralizedActor = None
    CentralizedCritic = None
    MAPPONetwork = None
    MAPPOTrainer = None
    Experience = None

# Optional server class
try:
    from .server import MARLGovernorService, MarlServiceAsyncServer
except ImportError:
    MARLGovernorService = None
    MarlServiceAsyncServer = None

__all__ = [
    "HAS_TORCH",
    "DecentralizedActor",
    "CentralizedCritic",
    "MAPPONetwork",
    "MAPPOTrainer",
    "Experience",
    "MARLGovernorService",
    "MarlServiceAsyncServer",
]
