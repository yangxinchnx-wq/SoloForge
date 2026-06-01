@echo off
REM SoloForge Admin UI 启动脚本
REM 打开后端管理系统界面

echo Starting SoloForge Admin Dashboard...
echo.

REM 检查端口 3001 是否可用
netstat -ano | findstr ":3001" > nul
if %errorlevel% neq 0 (
    echo Starting backend server...
    start cmd /k "npm start"
    timeout /t 3 /nobreak > nul
)

REM 打开浏览器
echo Opening browser at http://localhost:3001/admin
start http://localhost:3001/admin

echo.
echo Admin Dashboard is ready!
pause
