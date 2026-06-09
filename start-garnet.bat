@echo off
REM ─────────────────────────────────────────────────────────────────
REM SoloForge Garnet 缓存服务启动脚本
REM - 启动 Microsoft Garnet (Redis-compatible) 服务
REM - 默认端口 6379
REM - 数据目录: bin/garnet/data/
REM 用法: 直接双击或在项目根目录运行
REM ─────────────────────────────────────────────────────────────────

cd /d "%~dp0"

set GARNET_EXE=bin\garnet\portable\net10.0\GarnetServer.exe
set GARNET_PORT=6379
set GARNET_DATA=bin\garnet\data

if not exist "%GARNET_EXE%" (
    echo [ERROR] Garnet 二进制不存在: %GARNET_EXE%
    echo         请确认 bin/garnet/ 目录完整
    exit /b 1
)

if not exist "%GARNET_DATA%" (
    mkdir "%GARNET_DATA%"
    echo [INFO] 已创建数据目录: %GARNET_DATA%
)

echo [1/2] 检查端口 %GARNET_PORT% 占用情况...
netstat -ano | findstr ":%GARNET_PORT% " >nul
if %errorlevel%==0 (
    echo [WARN] 端口 %GARNET_PORT% 已被占用,Garnet 可能已在运行
    echo        如需重启,请先结束占用进程
    pause
    exit /b 0
)

echo [2/2] 启动 Garnet 服务...
echo        端口: %GARNET_PORT%
echo        数据: %GARNET_DATA%
echo.

"%GARNET_EXE%" --port %GARNET_PORT% --logger-folder "%GARNET_DATA%\logs" --checkpointdir "%GARNET_DATA%\checkpoint"

echo.
echo Garnet 服务已停止
pause
