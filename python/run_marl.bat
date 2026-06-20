@echo off
chcp 65001 >nul
REM SoloForge MARL Governor 服务启动脚本
REM Python: 项目内嵌 3.13.9 (python-build-standalone)

set PYTHON_EXE=C:\Users\yangx\Desktop\SoloForge\bin\python-3.13\python.exe

echo ============================================================
echo SoloForge MARL Governor 服务
echo Python: 3.13.9 (standalone, 3.12 兼容至 2026-Q4)
echo ============================================================
echo.

REM 检查 Python
"%PYTHON_EXE%" --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 Python 3.13.9
    pause
    exit /b 1
)

REM 启动 MARL 服务
"%PYTHON_EXE%" -m marl_service.server

pause
