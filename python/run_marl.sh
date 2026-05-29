#!/bin/bash
# SoloForge Python MARL Service Launcher
# 使用 Python 3.12.10

cd "$(dirname "$0")/.."
.venv/Scripts/python.exe mar_service/server.py
