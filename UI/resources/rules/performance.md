# 性能模式（半自动）
# 适用场景：开发模式，平衡效率和安全

## 执行权限
- `execute_cmd` 半自动：常见命令（npm, git, mvn, cargo）直接执行
- 系统级危险命令（rm -rf /, format, del /f /s /q C:\*）需确认
- 所有 `write_file` 直接执行

## 文件访问范围
- 工作区限制：允许访问 workspaceFolder 及其子目录
- 敏感路径保护：
  - 禁止访问 `~/.ssh/`、`~/.aws/` 等凭证目录
  - 禁止删除根目录文件（rm -rf / 等）

## 网络策略
- 允许访问公网
- 禁止访问 localhost 以外的内网地址
- 禁止访问 torrent 站点

## 工具限制
- 可用工具：`read_file`, `write_file`, `list_files`, `search_code`, `execute_cmd`
- 远程工具：浏览器工具可用，Windows-MCP 需确认

## 审计级别
- 标准日志：记录工具调用和命令执行
- 保留审计日志 14 天
