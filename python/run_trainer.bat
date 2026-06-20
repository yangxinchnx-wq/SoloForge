@echo off
REM ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REM SoloForge AI Society - MARL 训练脚本
REM Python: 3.13.14 (python-build-standalone, 3.12 兼容至 2026-Q4)
REM ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REM ⚠️  AI 社会专用训练 ⚠️  与主项目隔离
REM ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set PYTHON_EXE=C:\Users\yangx\Desktop\SoloForge\bin\python-3.13\python.exe

echo ============================================================
echo SoloForge MAPPO 训练器
echo Python: 3.13.14 (standalone)
echo ============================================================
echo.

REM 检查 Python 版本
"%PYTHON_EXE%" --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 Python 3.13.14
    pause
    exit /b 1
)

REM 检查 PyTorch
pip show torch >nul 2>&1
if errorlevel 1 (
    echo [错误] PyTorch 未安装
    echo 请运行: pip install torch --index-url https://download.pytorch.org/whl/cpu
    pause
    exit /b 1
)

echo [1/1] 启动训练...
echo.

REM 启动训练
"%PYTHON_EXE%" -m marl_service.trainer

echo.
echo ============================================================
echo 训练完成！
echo ============================================================

pause
