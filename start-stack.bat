@echo off
rem 启动 SoloForge 全栈, 后台运行, 日志写到 stack.log
cd /d C:\Users\yangx\Desktop\SoloForge
node start-all.mjs --no-electron > stack.log 2>&1
