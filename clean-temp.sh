#!/bin/bash
# SoloForge 临时文件清理脚本
# 生成日期: 2026-07-09
# 用途: 列出建议删除的临时文件（不自动删除，请手动确认后执行）

echo "=== SoloForge 临时文件清理建议 ==="
echo ""

# 日志文件
echo "## 日志文件 (*.log)"
echo "rm -f add.log"
echo "rm -f astp.log"
echo "rm -f c1.log c2.log c3.log c4.log c5.log c6.log c7.log c8.log c9.log c10.log ca.log"
echo "rm -f chk.log"
echo "rm -f clean-preview.log"
echo "rm -f commit2.log"
echo "rm -f electron-restart.log"
echo "rm -f mock-llm.log"
echo ""

# 临时 Python 脚本
echo "## 临时 Python 脚本 (_*.py)"
echo "rm -f _append.py"
echo "rm -f _diff_ui.py"
echo "rm -f _diff_ui_by_dir.py"
echo "rm -f _gen_msg_part1.py _gen_msg_part2.py"
echo "rm -f _gen_rev_part1.py _gen_rev_part2.py"
echo "rm -f _gen_ta_part1.py _gen_ta_part2.py"
echo "rm -f _gen_task_part1.py _gen_task_part2.py _gen_task_part3.py _gen_task_part4.py"
echo "rm -f _gen_tx_part1.py _gen_tx_part2.py"
echo "rm -f _test_rev.py _test_ta.py _test_task.py _test_tx.py"
echo "rm -f analyze_files.py"
echo ""

# 临时 PowerShell 脚本
echo "## 临时 PowerShell 脚本 (*.ps1)"
echo "rm -f _list_backup.ps1"
echo "rm -f _list_current.ps1"
echo "rm -f check-and-shot.ps1"
echo "rm -f check-hwnd.ps1 check-hwnd2.ps1 check-hwnd3.ps1"
echo "rm -f force-maximize.ps1"
echo "rm -f get-network-speed.ps1"
echo "rm -f get-screen.ps1"
echo "rm -f kill-electron.ps1"
echo "rm -f list-procs.ps1"
echo "rm -f maximize-soloforge.ps1"
echo ""

# 临时文本/数据文件
echo "## 临时文本/数据文件"
echo "rm -f .tmp-inspect.js"
echo "rm -f __e2e_delete.json"
echo "rm -f _e2e.ts"
echo "rm -f _e2e.txt"
echo "rm -f _ui_diff_by_dir.txt"
echo "rm -f _ui_diff_report.txt"
echo "rm -f tmp-gpt.txt"
echo "rm -f tmp-result.txt"
echo "rm -f _test.tsx"
echo ""

echo "=== 清理完成 ==="
echo ""
echo "提示: 请在执行前确认文件不再需要"
echo "执行方式: bash clean-temp.sh"
