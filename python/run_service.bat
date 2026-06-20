@echo off
chcp 65001 >nul
REM SoloForge Python 服务运行脚本
REM Python: 项目内嵌 3.13.9 (python-build-standalone, 3.12 兼容至 2026-Q4)

set PYTHON_EXE=C:\Users\yangx\Desktop\SoloForge\bin\python-3.13\python.exe

echo ============================================================
echo SoloForge Python 服务
echo Python: 3.13.9 (standalone)
echo ============================================================
echo.

REM 检查 Python
"%PYTHON_EXE%" --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 Python 3.13.9
    pause
    exit /b 1
)

if "%~1"=="" (
    echo 用法: run_service.bat ^<module^>
    echo 例如: run_service.bat soloforge_ai_society.services.reputation_sync_receiver
    pause
    exit /b 1
)

"%PYTHON_EXE%" -m %*

pause
