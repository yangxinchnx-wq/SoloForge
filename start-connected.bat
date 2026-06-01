@echo off
REM ─────────────────────────────────────────────────────────────────
REM SoloForge 前后端连接启动脚本
REM 启动后端 API 服务器 + 前端开发服务器
REM ─────────────────────────────────────────────────────────────────

echo.
echo  ╔══════════════════════════════════════════════════════════╗
echo  ║           SoloForge 前后端连接启动器                      ║
echo  ╚══════════════════════════════════════════════════════════╝
echo.

REM 检查 node_modules
if not exist "node_modules" (
    echo [!] 正在安装依赖...
    call npm install
)

echo [1/2] 启动后端 API 服务器 (端口 3001)...
start "SoloForge Backend" cmd /c "npx tsx src/index.ts"

REM 等待后端启动
echo [*] 等待后端启动 (5秒)...
timeout /t 5 /nobreak >nul

echo [2/2] 启动前端开发服务器 (端口 5188)...
start "SoloForge Frontend" cmd /c "cd apps\desktop && npx vite --config vite.config.web.ts"

echo.
echo  ═══════════════════════════════════════════════════════════
echo   后端 API:  http://localhost:3001
echo   前端 UI:   http://localhost:5188
echo   Prometheus: http://localhost:3001/metrics
echo   SSE 事件流: http://localhost:3001/api/events/stream
echo  ═══════════════════════════════════════════════════════════
echo.
echo  按任意键关闭此窗口（后台服务继续运行）...
pause >nul
