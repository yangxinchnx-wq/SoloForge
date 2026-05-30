# SoloForge Desktop App

Electron 桌面应用，用于托管 SoloForge 运行时核心。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                      React UI (Renderer)                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────────┐ │
│  │Dashboard │  │ Database │  │Scheduler │  │  Event Monitor  │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────────────┘ │
└────────────────────────┬────────────────────────────────────────┘
                         │ contextBridge (window.soloforge)
┌────────────────────────┴────────────────────────────────────────┐
│                      Electron Main Process                       │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                     IpcBridge                               │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │ │
│  │  │  Kernel  │  │ Database │  │Scheduler │  │   Events   │  │ │
│  │  │ Handlers│  │ Handlers │  │ Handlers │  │ Handlers   │  │ │
│  │  └──────────┘  └──────────┘  └──────────┘  └────────────┘  │ │
│  └─────────────────────────────────────────────────────────────┘ │
└────────────────────────┬────────────────────────────────────────┘
                         │ Dynamic Import
┌────────────────────────┴────────────────────────────────────────┐
│                     Runtime Core (src/)                          │
│  ┌────────────────┐  ┌─────────────────┐  ┌──────────────────┐ │
│  │RuntimeKernel   │  │SurrealPersistence│  │ Rust Scheduler   │ │
│  │ EventBus       │  │  (RocksDB)       │  │ (BinaryHeap)     │ │
│  └────────────────┘  └─────────────────┘  └──────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## IPC 通道

### Kernel Handlers
- `kernel:status` - 获取内核状态
- `kernel:components` - 获取组件列表
- `kernel:health` - 健康检查
- `kernel:events` - 获取事件日志
- `kernel:ownership` - 获取域所有权

### Database Handlers
- `db:query` - 执行 SurrealQL 查询
- `db:schema` - 获取数据库 schema
- `db:tables` - 获取表列表

### Scheduler Handlers
- `scheduler:stats` - 获取调度器统计
- `scheduler:queue` - 获取队列内容

### Event Handlers
- `event:subscribe` - 订阅事件
- `event:unsubscribe` - 取消订阅
- `event:list` - 列出已订阅事件

## 事件流

内核事件通过 EventBus → IpcBridge → IPC 转发到渲染进程:

```typescript
RuntimeEvent.Heartbeat
RuntimeEvent.KernelInitialized
RuntimeEvent.RuntimeModeChanged
RuntimeEvent.RuntimeShutdown
RuntimeEvent.CommandAccepted
RuntimeEvent.CommandRejected
RuntimeEvent.TransactionCommitted
RuntimeEvent.TransactionRolledBack
RuntimeEvent.CourtPhase1Completed
RuntimeEvent.CourtPhase2Completed
RuntimeEvent.SpanRecorded
RuntimeEvent.AuditRecorded
```

## 开发

```bash
cd apps/desktop
npm install
npm run dev          # 开发模式 (Vite + Electron)
npm run electron:dev  # 使用 vite-plugin-electron
```

## 构建

```bash
npm run build         # 构建 Electron 应用
```

## 文件结构

```
desktop/
├── index.html              # HTML 入口
├── package.json           # 依赖配置
├── vite.config.ts         # Vite 配置
├── tsconfig*.json         # TypeScript 配置
├── src/
│   ├── main.ts            # Electron 主进程
│   ├── preload.ts         # contextBridge 暴露 API
│   ├── ipc-bridge.ts      # IPC 桥接器
│   ├── types.ts           # 类型定义
│   ├── app.tsx            # React App 组件
│   ├── index.tsx          # React 入口
│   ├── styles.css         # 全局样式
│   └── components/
│       └── Dashboard.tsx  # Dashboard 组件
└── public/                # 静态资源
```
