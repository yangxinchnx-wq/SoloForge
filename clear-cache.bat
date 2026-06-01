@echo off
echo ========================================
echo SoloForge 缓存清理脚本
echo ========================================
echo.

echo [1/4] 检查并停止相关进程...
taskkill /F /IM node.exe 2>nul
taskkill /F /IM electron.exe 2>nul
echo 进程清理完成
echo.

echo [2/4] 清除 Vite 缓存...
if exist "node_modules\.vite" (
    rmdir /s /q "node_modules\.vite"
    echo 已删除: node_modules\.vite
) else (
    echo 未找到: node_modules\.vite
)

if exist "apps\desktop\node_modules\.vite" (
    rmdir /s /q "apps\desktop\node_modules\.vite"
    echo 已删除: apps\desktop\node_modules\.vite
) else (
    echo 未找到: apps\desktop\node_modules\.vite
)
echo.

echo [3/4] 清除构建缓存...
if exist "apps\desktop\dist" (
    rmdir /s /q "apps\desktop\dist"
    echo 已删除: apps\desktop\dist
) else (
    echo 未找到: apps\desktop\dist
)

if exist "apps\desktop\dist-electron" (
    rmdir /s /q "apps\desktop\dist-electron"
    echo 已删除: apps\desktop\dist-electron
) else (
    echo 未找到: apps\desktop\dist-electron
)
echo.

echo [4/4] 清除临时文件...
if exist ".tmp.driveupload" (
    rmdir /s /q ".tmp.driveupload"
    echo 已删除: .tmp.driveupload
) else (
    echo 未找到: .tmp.driveupload
)

if exist ".pytest_cache" (
    rmdir /s /q ".pytest_cache"
    echo 已删除: .pytest_cache
) else (
    echo 未找到: .pytest_cache
)
echo.

echo ========================================
echo 缓存清理完成！
echo ========================================
echo.
echo 注意: 以下文件/目录未被删除:
echo   - node_modules (依赖包)
echo   - src (源代码)
echo   - UI (界面文件)
echo   - python (Python代码)
echo   - rust_core (Rust代码)
echo   - .git (版本控制)
echo   - 所有配置文件
echo   - 所有文档文件
echo.
pause