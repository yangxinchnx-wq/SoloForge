# SoloForge 项目说明

## 项目结构

```
SoloForge/
├── desktop/          # Electron 版本（原始桌面应用）
│   └── ...
│
├── tauri-desktop/   # Tauri 版本（新创建的）
│   ├── src/         # React 前端
│   ├── src-tauri/   # Rust 后端
│   ├── package.json
│   └── README.md     # 详细说明
│
├── python/          # Python 核心逻辑
│   ├── marl_service/# MARL 训练服务
│   ├── governor_rl/  # Governor 强化学习
│   └── ...
│
└── src/             # Node.js 核心（Runtime Kernel）
```

## 如何选择桌面框架

### 使用 Electron（原有）
```bash
cd apps/desktop
npm install
npm run dev
```

### 使用 Tauri（新创建）
```bash
cd apps/tauri-desktop
npm install
npm run tauri:dev
```

## Tauri 版本特点

- ✅ 安装包更小（5-10MB vs 200MB+）
- ✅ 内存占用更低
- ✅ 启动更快
- ⚠️ 需要 Rust 环境
- ⚠️ 部分 Electron API 需要重新实现

## IPC 调用对比

| 功能 | Electron | Tauri |
|------|----------|-------|
| 调用后端 | `ipcRenderer.invoke()` | `invoke()` |
| 系统信息 | `process` 全局对象 | `@tauri-apps/api/os` |
| 窗口控制 | `BrowserWindow` | `@tauri-apps/api/window` |
| 文件系统 | `fs` 模块 | `@tauri-apps/api/fs` |

## 更多信息

参见 `apps/tauri-desktop/README.md`
