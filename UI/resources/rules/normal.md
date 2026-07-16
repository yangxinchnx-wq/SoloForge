# 普通模式（安全常态）
# 适用场景：日常对话，安全优先

## 执行权限
- 所有 `execute_cmd` 命令需用户确认，阻止危险命令
- `write_file` 需确认，防止误修改重要文件
- `read_file`, `list_files`, `search_code` 直接执行

## 文件访问范围
- 工作区限制：仅允许访问 workspaceFolder 及其子目录
- 敏感路径保护：
  - 禁止访问 `/etc/passwd`、`C:\Windows\System32` 等系统目录
  - 禁止访问 `~/.ssh/`、`~/.aws/` 等凭证目录
  - 禁止删除文件，仅允许创建/修改

## 网络策略
- 仅允许访问 whitelist 中的域名
- 禁止访问 localhost 以外的内网地址
- 禁止访问 torrent 站点、暗网等

## 工具限制
- 可用工具：`read_file`, `list_files`, `search_code`
- 需确认工具：`write_file`, `execute_cmd`
- 禁用工具：无远程工具

## 审计级别
- 详细日志：记录所有工具调用、文件读写、命令执行
- 保留审计日志 30 天
