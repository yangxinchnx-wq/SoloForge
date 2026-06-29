@echo off
chcp 65001 >nul
REM ─────────────────────────────────────────────────────────────────
REM  SoloForge 一键启动 (Windows 入口)
REM  实际逻辑全部在 start-all.mjs 里
REM  用法:
REM    start-all.bat              全量启动(Garnet + git-service + Core + UI + MARL + 可选 Electron)
REM    start-all.bat --no-electron 不要 Electron 桌面壳
REM    start-all.bat --check      只做自检
REM
REM  启动顺序 (与 start-all.mjs 一致):
REM    1. Garnet (6379)
REM    2. Go git-service (3002)
REM    3. SoloForge Core (3001 / 9090)
REM    4. UI dev server (3000)
REM    5. MARL Python 服务 (8765)     <-- 已纳入
REM    6. Electron 桌面壳 (可选)
REM
REM  兼容说明:
REM    本机 C:\nodejs\node_modules\npm\bin\ 缺失 (npm 绿版被裁剪过),
REM    npx/npm 会 MODULE_NOT_FOUND。start-all.mjs 已直接走
REM    node_modules\.bin\tsx.cmd 跑 tsx,绕开 npm cli。
REM ─────────────────────────────────────────────────────────────────

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 node,请先安装 Node.js
    pause
    exit /b 1
)

REM ── 自检 npm/npx (可选,失败也不阻塞,start-all.mjs 走 tsx.cmd shim 即可) ──
where npx >nul 2>&1
if errorlevel 1 (
    echo [WARN] 未找到 npx;将回退到本地 node_modules\.bin\tsx.cmd / tsx.ps1
)

node start-all.mjs %*
if errorlevel 1 (
    echo.
    echo [退出] start-all.mjs 返回非零码
    pause
)
