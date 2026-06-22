@echo off
chcp 65001 >nul
REM SoloForge Browser-Use Service (Python MCP server)
REM 独立包, 走 Obscura CDP 引擎, 暴露高层 LLM 任务编排
REM Python: 3.11+ (browser-use 要求)

set PYTHON_EXE=C:\Users\yangx\Desktop\SoloForge\bin\python-3.13\python.exe

echo ============================================================
echo SoloForge Browser-Use Service
echo ============================================================
echo.

REM 检查 Python
"%PYTHON_EXE%" --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 Python 3.13 standalone
    pause
    exit /b 1
)

REM 加载 .env (如果存在)
if exist "..\..\.env" (
    for /f "usebackq tokens=1,2 delims==" %%a in ("..\..\.env") do (
        if not "%%a"=="" if not "%%a:~0,1%"=="#" set %%a=%%b
    )
)

REM 检查 browser_use_service 是否已安装
"%PYTHON_EXE%" -c "import browser_use_service" >nul 2>&1
if errorlevel 1 (
    echo [信息] browser_use_service 未安装, 自动 pip install -e ...
    "%PYTHON_EXE%" -m pip install -e "%~dp0."
    if errorlevel 1 (
        echo [错误] pip install 失败
        pause
        exit /b 1
    )
)

REM 启动 MCP stdio server
echo [启动] python -m browser_use_service.server
"%PYTHON_EXE%" -m browser_use_service.server

pause
