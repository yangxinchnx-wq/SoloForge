# 3D 设备预览系统 - 架构文档

> 最后更新: 2026-06-23

## 🎯 核心定位

在 SoloForge 画布预览面板（PreviewPanel）中，将 **22 个设备尺寸预设** 升级为 **3D 设备模型预览**。

当用户选中 iPhone 14 Pro 时：
- 画布上显示 iPhone 14 Pro 的 3D 模型
- 模型的屏幕区域 = 画布内容（RTT 贴图）
- 旋转模型 → 屏幕内容一起旋转
- 移动模型 → 跟随鼠标
- 选中 → 渐变流动描边

---

## 🏗️ 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                  SoloForge Electron 主进程                  │
│                                                             │
│  ┌──────────────────────────────────────────────────┐      │
│  │  electron/main.cjs                                │      │
│  │  - canvasSessions (LRU Map)                       │      │
│  │  - resolveModelsDir() / readDeviceConfig()        │      │
│  │  - IPC: canvas:start/stop/push/transform         │      │
│  │         canvas:get-device-config / list-models    │      │
│  └──────────────────────────────────────────────────┘      │
│                          ↓ IPC                              │
│  ┌──────────────────────────────────────────────────┐      │
│  │  React 渲染层 (UI/src)                            │      │
│  │  ├─ PreviewPanel.tsx (22 设备预设)                │      │
│  │  ├─ Model3DOverlay.tsx (3D 交互层)                │      │
│  │  │   - 选中/移动/旋转/删除                       │      │
│  │  │   - 渐变流动描边 (conic-gradient + rotate)     │      │
│  │  └─ DeleteConfirmModal.tsx (删除确认)             │      │
│  │      - 4 角触控把手 / 拖动 / ESC 关闭             │      │
│  │                                                   │      │
│  │  ├─ services/session/SessionStore.ts             │      │
│  │  │   - 多会话状态管理 (内存 Map)                 │      │
│  │  │   - 切换会话 = 切换渲染目标, 不销毁           │      │
│  │  │   - 50~200ms 切换速度                         │      │
│  │  │                                               │      │
│  │  ├─ services/persistence/GarnetStore.ts 🔥       │      │
│  │  │   - ioredis 客户端 (Garnet = Redis 兼容)      │      │
│  │  │   - 24h TTL                                   │      │
│  │  │   - Key: hot:sf:session:{id}:state            │      │
│  │  │                                               │      │
│  │  └─ services/persistence/SurrealStore.ts 🌡️     │      │
│  │      - @surrealdb/node (rocksdb://)              │      │
│  │      - 30 秒 flush 一次 (热→温)                  │      │
│  │      - 跨重启恢复                                │      │
│  └──────────────────────────────────────────────────┘      │
│                          ↓ spawn()                          │
│  ┌──────────────────────────────────────────────────┐      │
│  │  canvas_preview.exe (Flutter, 端口 9090+)        │      │
│  │  ├─ lib/main.dart (WebSocket/HTTP 服务)          │      │
│  │  ├─ lib/services/three_d/device_renderer.dart    │      │
│  │  │   - three_d 纯 Dart 渲染 (方案 A)             │      │
│  │  │   - GLTFLoader 加载 .glb                      │      │
│  │  │   - BoxGeometry 占位 (模型缺失时)              │      │
│  │  ├─ lib/services/three_d/device_config_loader.dart│     │
│  │  │   - 加载 device-config.json                  │      │
│  │  └─ lib/platform_renderer.dart (集成)            │      │
│  │      - _buildDeviceFrame() / _buildModel3D()     │      │
│  └──────────────────────────────────────────────────┘      │
│                          ↓                                  │
│  ┌──────────────────────────────────────────────────┐      │
│  │  3D 模型资源 (resources/canvas/models/)           │      │
│  │  ├─ device-config.json (UV 配置, 22 设备)        │      │
│  │  ├─ mobile/   (7 个 .glb)                        │      │
│  │  ├─ tablet/   (5 个 .glb)                        │      │
│  │  ├─ desktop/  (6 个 .glb)                        │      │
│  │  └─ watch/    (4 个 .glb)                        │      │
│  └──────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

---

## 💾 持久化三层架构

### 🔥 热存储 (Garnet)
- **技术**: Microsoft Garnet (Redis 兼容, .NET 10 编写)
- **客户端**: `ioredis`
- **端口**: 6379
- **启动**: `start-garnet.bat`
- **Key 规范**: `hot:sf:session:{id}:state`
- **TTL**: 86400s (24h)
- **用途**: 当前活跃会话的实时状态

### 🌡️ 温存储 (SurrealDB)
- **技术**: SurrealDB (rocksdb:// 嵌入式)
- **客户端**: `@surrealdb/node`
- **数据目录**: `data/soloforge_db/`
- **Namespace**: `soloforge_core`
- **Database**: `canvas_state`
- **Flush 频率**: 30 秒定时
- **用途**: 跨重启恢复

### ❄️ 冷存储 (文件系统)
- **位置**: `resources/canvas/models/*.glb`
- **备份**: `bin/garnet/data/`
- **用途**: 模型文件 + 长期归档

### 写入流程
```
React 状态变化
  ↓ 立即
Garnet (热, ms级)
  ↓ 30s 后
SurrealDB (温, s级)
  ↓ 每日
文件系统 (冷, m级)
```

---

## 🎮 交互规范

### 鼠标操作映射

| 操作 | 触发 | 效果 |
|------|------|------|
| 选中 | 左键点击 | 显示流动描边 + 删除按钮 |
| 移动 | 滚轮**按下** + 拖动 | 模型跟随，限制画布内 |
| 旋转 | 右键**长按** + 拖动 | X/Y 方向直映射 |
| 删除 | Delete 键 或 删除按钮 | 弹窗确认 |

### 键盘操作映射

| 键位 | 动作 |
|------|------|
| `Delete` | 删除选中设备（需确认） |
| `Ctrl+C` | 复制选中设备 |
| `Ctrl+V` | 粘贴（4 象限智能避让） |
| `ESC` | 取消选择 / 关闭弹窗 |

### 选中描边 (渐变流动)
```css
background: conic-gradient(from 0deg, transparent, color, transparent, color-tint, transparent);
WebKitMask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
WebKitMaskComposite: xor;
animation: rotate 2s linear infinite;
```
- 颜色: 8 种随机 (`#FF6B6B`, `#4ECDC4`, `#45B7D1`, ...)
- 线宽: 2px
- 周期: 2 秒

---

## 📂 22 个设备清单

| Group | 设备 | 原生尺寸 (px) | UV 区域 |
|-------|------|--------------|---------|
| 桌面 | Full HD | 1920×1080 | 0.05~0.95 |
| 桌面 | MacBook | 1440×900 | 0.04~0.96 |
| 桌面 | 标准笔记本 | 1366×768 | 0.05~0.95 |
| 桌面 | HD | 1280×720 | 0.05~0.95 |
| 桌面 | XGA | 1024×768 | 0.05~0.95 |
| 桌面 | 2K | 2560×1440 | 0.04~0.96 |
| 手机 | iPhone 14 Pro | 393×852 | 0.06~0.94 |
| 手机 | iPhone 14 | 390×844 | 0.06~0.94 |
| 手机 | iPhone 14 Pro Max | 430×932 | 0.06~0.94 |
| 手机 | iPhone SE | 375×667 | 0.07~0.93 |
| 手机 | Galaxy S23 | 360×780 | 0.06~0.94 |
| 手机 | Pixel 7 | 412×915 | 0.06~0.94 |
| 手机 | Xiaomi 13 | 393×873 | 0.06~0.94 |
| 平板 | iPad Pro 12.9" | 1024×1366 | 0.04~0.96 |
| 平板 | iPad Air | 820×1180 | 0.05~0.95 |
| 平板 | iPad Mini | 768×1024 | 0.06~0.94 |
| 平板 | Surface Pro | 912×1368 | 0.05~0.95 |
| 平板 | Galaxy Tab S8 | 800×1280 | 0.05~0.95 |
| 手表 | Apple Watch 41mm | 176×176 | 0.12~0.88 |
| 手表 | Apple Watch 45mm | 198×198 | 0.10~0.90 |
| 手表 | Apple Watch Ultra 49mm | 205×251 | 0.08~0.92 |
| 手表 | Galaxy Watch 6 | 240×240 | 0.10~0.90 |

---

## 🚧 当前状态

### ✅ 已完成
- 模型文件夹结构（22 个位置）
- `device-config.json` UV 配置
- Flutter 端 3D 渲染基础
- Electron 端 IPC + SessionStore
- 持久化三层架构
- 选中/移动/旋转/删除 UI

### ⏳ 待完成
- 真实 22 个 `.glb` 模型文件
- UV 标定（每个模型的具体屏幕区域）
- RTT 贴图真实实现（用 `RepaintBoundary` + `toImage`）
- three_d 渲染管线接通（目前是占位实现）
- 复制粘贴 4 象限避让算法
- 性能优化（多设备并发）

---

## 🐛 已知问题

1. **three_d RTT 未完整实现** - `device_renderer.dart` 中 `_BlankCanvas` 是占位
2. **模型文件未下载** - `iphone_14_pro.glb` 是 Duck 模型作为占位
3. **删除按钮位置** - 当前在右上角，可考虑改为悬停时显示
4. **复制粘贴未实现** - `Ctrl+C/V` 暂未绑定

---

## 📚 相关文件

### Flutter
- `lib/ui_parser.dart` (UI 节点类型)
- `lib/services/three_d/device_renderer.dart` (3D 渲染)
- `lib/services/three_d/device_config_loader.dart` (配置加载)
- `lib/main.dart` (HTTP/WS 协议)

### Electron
- `electron/main.cjs` (主进程 + IPC)
- `UI/src/services/canvas/types.ts` (类型)
- `UI/src/services/canvas/Canvas3DClient.ts` (客户端)
- `UI/src/services/session/SessionStore.ts` (多会话)
- `UI/src/services/persistence/GarnetStore.ts` (热存储)
- `UI/src/services/persistence/SurrealStore.ts` (温存储)
- `UI/src/components/PreviewPanel.tsx` (主面板)
- `UI/src/components/Model3DOverlay.tsx` (3D 交互层)
- `UI/src/components/DeleteConfirmModal.tsx` (删除确认)

### 资源
- `resources/canvas/models/device-config.json` (UV 配置)
- `resources/canvas/models/README.md` (找模型指南)
- `resources/canvas/models/{mobile,tablet,desktop,watch}/` (模型文件)
