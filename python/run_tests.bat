@echo off
chcp 65001 >nul
REM SoloForge Python 测试脚本
REM Python: 项目内嵌 3.13.14 (python-build-standalone, 3.12 兼容至 2026-Q4)

set PYTHON_EXE=C:\Users\yangx\Desktop\SoloForge\bin\python-3.13\python.exe

echo ============================================================
echo SoloForge AI Society 测试
echo Python: 3.13.14 (standalone)
echo ============================================================
echo.

"%PYTHON_EXE%" -m pytest tests/ -v

echo.
echo ============================================================
echo 测试完成
echo ============================================================
pause
