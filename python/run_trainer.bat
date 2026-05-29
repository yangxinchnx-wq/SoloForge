@echo off
REM ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REM SoloForge AI Society - MARL 训练脚本
REM Python: 3.12.10
REM ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REM ⚠️  AI 社会专用训练 ⚠️  与主项目隔离
REM ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo ============================================================
echo SoloForge MAPPO 训练器
echo ============================================================
echo.

REM 检查 Python 版本
python --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 Python，请安装 Python 3.12.10
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
python -m marl_service.trainer

echo.
echo ============================================================
echo 训练完成！
echo ============================================================

pause
