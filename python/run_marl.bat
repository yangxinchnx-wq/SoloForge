@echo off
REM ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REM SoloForge MARL Governor 服务启动脚本
REM Python: 3.12.10
REM ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REM 职责：MAPPO 强化学习推理与训练服务
REM 通信：只通过 STDIN/STDOUT 与主进程通信，不接触任何数据库
REM ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo ============================================================
echo SoloForge MARL Governor 服务
echo ============================================================
echo.

REM 检查 Python 版本
python --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 Python，请安装 Python 3.12.10
    pause
    exit /b 1
)

REM 检查依赖
echo [1/3] 检查依赖...

pip show torch >nul 2>&1
if errorlevel 1 (
    echo [警告] PyTorch 未安装，正在安装...
    pip install torch --index-url https://download.pytorch.org/whl/cpu
)

pip show numpy >nul 2>&1
if errorlevel 1 (
    echo [警告] NumPy 未安装，正在安装...
    pip install numpy
)

echo [2/3] 检查模型...
if not exist "marl_service\models\policy.pt" (
    echo [警告] 模型文件不存在，正在初始化...
    python -m marl_service.init_model
)

echo [3/3] 启动服务...
echo.
echo ============================================================
echo 服务运行中，等待 Node.js 连接...
echo 按 Ctrl+C 停止服务
echo ============================================================
echo.

REM 启动 MARL 服务
python -m marl_service.server

pause
