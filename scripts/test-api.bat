@echo off
REM SoloForge API 测试脚本
REM 测试管理后台 API 是否正常工作

echo ========================================
echo SoloForge API 测试
echo ========================================
echo.

set API_BASE=http://localhost:3001

echo [1] 测试健康检查...
curl -s "%API_BASE%/api/health" || echo 失败
echo.

echo [2] 测试系统状态...
curl -s "%API_BASE%/api/status" || echo 失败
echo.

echo [3] 测试数据库统计...
curl -s "%API_BASE%/api/database/stats" || echo 失败
echo.

echo [4] 测试智能体列表...
curl -s "%API_BASE%/api/agents" || echo 失败
echo.

echo [5] 测试内核状态...
curl -s "%API_BASE%/api/kernel/status" || echo 失败
echo.

echo [6] 测试管理界面...
curl -s "%API_BASE%/admin" -o nul && echo 成功 (200) || echo 失败
echo.

echo ========================================
echo 测试完成
echo.
pause
