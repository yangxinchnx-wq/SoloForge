# SoloForge Desktop 开发指南

## 当前状态

Electron 桌面应用框架已创建完成，包含：
- React 前端 (Vite + React)
- Electron IPC 桥接
- contextBridge API

## 启动开发服务器

```bash
cd apps/desktop
npm install
npm run dev          # 启动 Vite (仅前端)
```

前端将在 http://localhost:5173 运行，可以预览 UI。

## 构建 Electron 应用

```bash
npm run build        # 构建前端
npx tsc -p tsconfig.electron.json  # 编译 Electron
npm run start        # 运行 Electron
```

## 文件结构

```
desktop/
├── src/
│   ├── main.ts         # Electron 主进程
│   ├── preload.ts      # contextBridge API
│   ├── ipc-bridge.ts   # IPC 处理器
│   ├── app.tsx         # React 应用
│   └── components/     # React 组件
├── dist-electron/      # 编译输出
└── dist/               # 前端构建输出
```

## 通信架构

```
React UI (window.soloforge)
       ↓
contextBridge (preload.ts)
       ↓
IPC Main Handlers (ipc-bridge.ts)
       ↓
Runtime Kernel + SurrealDB
```

## 已知问题

1. Electron 在某些环境下启动有问题
2. 需要确保 Vite 服务器在 Electron 之前启动
3. 核心模块需要正确编译才能被 Electron 加载

## 下一步

1. 解决 Electron 启动问题
2. 验证 IPC 通信
3. 测试数据库查询
