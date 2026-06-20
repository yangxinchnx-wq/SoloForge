#!/bin/bash
# SoloForge Python MARL Service Launcher
# 使用 Python 3.13.14 (python-build-standalone, 3.12 兼容至 2026-Q4)

cd "$(dirname "$0")/.."
.venv/Scripts/python.exe mar_service/server.py
