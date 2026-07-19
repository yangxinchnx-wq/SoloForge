# 画布预览系统 — 架构文档

> 最后更新: 2026-07-19

## 🎯 核心定位

在 SoloForge 画布预览面板（PreviewPanel）中，将 LLM 生成的 **UniversalNode DSL** 渲染为可视化预览。

支持两种渲染模式：
- **2D 模式**：`WebAstPreview` 将 DSL 渲染为 HTML/CSS DOM，可选叠加 PNG 设备边框
- **3D 模式**：`CanvasStage3D` 用 React Three Fiber（R3F）渲染 GLB 设备模型，DSL 作为 RTT 贴图映射到屏幕区域

用户可随时切换 2D/3D 模式，选择不同设备尺寸。

---

## 🏗️ 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                  SoloForge Electron 主进程                  │
│                                                             │
│  ┌──────────────────────────────────────────────────┐      │
│  │  electron/main.cjs                                │      │
│  │  - 进程管理 (spawnedChildren / killProcessTree)  │      │
│  │  - resolveModelsDir() / listAvailableModels()     │      │
│  │  - 设备下拉窗口                                    │      │
│  └──────────────────────────────────────────────────┘      │
│                          ↓ HTTP (Express)                   │
│  ┌──────────────────────────────────────────────────┐      │
│  │  server.ts — 静态资源服务                          │      │
│  │  /canvas/models/* → resources/canvas/models/*     │      │
│  │  (express.static, 设置 GLB/HDR MIME)              │      │
│  └──────────────────────────────────────────────────┘      │
│                          ↓                                  │
│  ┌──────────────────────────────────────────────────┐      │
│  │  React 渲染层 (UI/src)                            │      │
│  │                                                   │      │
│  │  ┌─ PreviewPanel.tsx (主面板)                    │      │
│  │  │  - 设备选择下拉 (DeviceDropdown)              │      │
│  │  │  - 2D/3D 切换 (IosToggle)                     │      │
│  │  │  - 底色选择 (BG_PRESETS)                      │      │
│  │  │  - 3D 右键主题菜单 (ThemeContextMenu)         │      │
│  │  │                                               │      │
│  │  ├─ CanvasStage.tsx (渲染分发)                   │      │
│  │  │  - 根据 renderMode + device.glbFile 判断       │      │
│  │  │  - 3D 无设备时自动降级为 2D                    │      │
│  │  │  - anime.js 模式切换淡入过渡                   │      │
│  │  │                                               │      │
│  │  │  ┌─ Stage2D (2D 模式)                        │      │
│  │  │  │  - WebAstPreview: DSL → HTML/CSS DOM      │      │
│  │  │  │  - PNG 设备边框 <img> 叠加                 │      │
│  │  │  │  - CSS transform: scale 自适应容器         │      │
│  │  │  │  - ResizeObserver 动态缩放                 │      │
│  │  │  │  - anime.js 设备切换弹跳 + DSL FLIP 过渡   │      │
│  │  │  │                                            │      │
│  │  │  └─ Stage3D (3D 模式, React.lazy 按需加载)    │      │
│  │  │     - CanvasStage3D: R3F Canvas 场景          │      │
│  │  │     - useGLTF 加载 .glb 模型                  │      │
│  │  │     - Html transform: DOM 嵌入 3D 场景        │      │
│  │  │     - ScreenMesh: 屏幕区域定位算法             │      │
│  │  │     - HDR 环境光照                            │      │
│  │  │     - 主题/材质切换 (modelThemes.ts)          │      │
│  │  │     - anime.js stagger 入场动画               │      │
│  │  │                                               │      │
│  │  ├─ CanvasResourceBar.tsx (画布资源栏)           │      │
│  │  └─ DeleteConfirmModal.tsx (删除确认弹窗)        │      │
│  │                                                   │      │
│  │  ┌─ State (Zustand)                              │      │
│  │  │  - canvasDeviceStore.ts (设备/renderMode/主题) │      │
│  │  │  - previewStreamStore.ts (DSL 流 + ast 缓存)  │      │
│  │  │  - appStore.ts (全局状态)                     │      │
│  │  │                                               │      │
│  │  ├─ Services                                     │      │
│  │  │  - canvas/UniversalAST.ts (UniversalNode 类型)│      │
│  │  │  - canvas/modelThemes.ts (3D 主题/材质)       │      │
│  │  │  - canvas/canvasAnimations.ts (anime.js 动画) │      │
│  │  │  - canvas/sessionApi.ts (画布会话 API)        │      │
│  │  │  - canvas/types.ts (类型定义)                 │      │
│  │  │                                               │      │
│  │  └─ Server-side (UI/src/server/)                 │      │
│  │     - services/session/SessionStore.ts (多会话)  │      │
│  │     - services/persistence/GarnetStore.ts (热)   │      │
│  │     - services/persistence/SurrealStore.ts (温)  │      │
│  │     - services/canvas/validators.ts (类型校验)   │      │
│  └──────────────────────────────────────────────────┘      │
│                          ↓                                  │
│  ┌──────────────────────────────────────────────────┐      │
│  │  设备模型资源 (resources/canvas/models/)           │      │
│  │  ├─ 2d/  (PNG 设备边框)                          │      │
│  │  │  ├─ mobile/   (iPhone 16 系列等)              │      │
│  │  │  ├─ tablet/   (iPad A16 等)                   │      │
│  │  │  ├─ desktop/  (MacBook / iMac / Studio Disp)  │      │
│  │  │  └─ watch/    (Apple Watch S11 / Ultra)       │      │
│  │  ├─ 3d/  (GLB 3D 模型)                           │      │
│  │  │  └─ mobile/iphone_15_pro_max.glb (唯一可用)   │      │
│  │  ├─ hdri/ (HDR 环境贴图)                         │      │
│  │  │  └─ studio_small_03_1k.hdr                    │      │
│  │  └─ device-config.json (3D UV 屏幕区域配置)      │      │
│  └──────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

---

## 🎨 渲染模式详解

### 2D 模式 (Stage2D)

| 组件 | 职责 |
|------|------|
| `WebAstPreview.tsx` | 将 UniversalNode 树渲染为 HTML/CSS DOM，支持 16 种节点类型 |
| PNG `<img>` 叠加 | 设备边框图片绝对定位覆盖，`pointerEvents: none` 不挡交互 |
| CSS `transform: scale` | 按设备原生像素尺寸渲染，再缩放适配容器（不放大只缩小） |
| `ResizeObserver` | 监听容器尺寸变化，动态重算缩放比例 |
| `borderRadius: 32px` | DSL 渲染层圆角裁切，模拟设备屏幕弧度 |

**WebAstPreview 支持的节点类型**: `container` / `row` / `column` / `stack` / `text` / `button` / `input` / `image` / `divider` / `spacer` / `svg` / `canvas`（HTML5 Canvas 2D draw 指令）/ `icon` / `progress` / `chart`（recharts）/ `video`

**格式兼容**: 同时支持 UniversalNode 格式（`{type, style, children}`）和旧 DSL 格式（`{type, props, children}`），通过 `normalizeNode()` 归一化。

### 3D 模式 (Stage3D)

| 组件 | 职责 |
|------|------|
| `CanvasStage3D.tsx` | R3F `<Canvas>` 场景容器，灯光/相机/环境贴图 |
| `useGLTF` (drei) | 异步加载 `.glb` 模型，Suspense 回退 |
| `Html` (drei) | `transform` 模式，把 WebAstPreview DOM 嵌入 3D 场景，跟随模型旋转 |
| `ScreenMesh.tsx` | 屏幕区域定位算法（boundingBox 自动计算屏幕位置/朝向/尺寸） |
| `modelThemes.ts` | 8 种颜色主题 + 5 种材质工艺（右键菜单切换） |

**降级逻辑**: `renderMode='3D'` 但 `device` 为 null 或 `device.glbFile` 不存在时，自动降级为 2D 模式。

**3D 按需加载**: `CanvasStage3D` 通过 `React.lazy(() => import(...))` 懒加载，避免首屏加载 three.js 全量 bundle。

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
- **位置**: `resources/canvas/models/` (2d PNG + 3d GLB + hdri)
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

### 3D 模式鼠标操作

| 操作 | 触发 | 效果 |
|------|------|------|
| 旋转模型 | 左键拖动 | OrbitControls X/Y 方向旋转 |
| 缩放 | 滚轮 | 相机距离拉近/拉远 |
| 平移 | 右键拖动 | 相机平面平移 |
| 主题菜单 | 右键点击画布 | 弹出颜色主题 + 材质工艺选择菜单 |

### 2D 模式

2D 模式为纯展示模式，无 3D 交互。DSL 更新时自动播放 FLIP 布局过渡动画。

### 键盘操作

| 键位 | 动作 |
|------|------|
| `ESC` | 关闭弹窗 / 取消选择 |

---

## 📂 设备清单

### 2D 设备 (DEVICES_2D — PNG 边框)

| Group | 设备 | 原生尺寸 (px) | PNG 文件 |
|-------|------|--------------|----------|
| 手机 | iPhone 16 Pro Max | 430×932 | `mobile/iphone_16_pro_max.png` |
| 手机 | iPhone 16 Pro | 402×874 | `mobile/iphone_16_pro.png` |
| 手机 | iPhone 16 | 390×844 | `mobile/iphone_16.png` |
| 平板 | iPad A16 | 820×1180 | `tablet/ipad_a16.png` |
| 桌面 | MacBook Pro 14" | 1512×982 | `desktop/macbook_pro_m5_14.png` |
| 手表 | Apple Watch Ultra | 502×410 | `watch/apple_watch_ultra_2.png` |

### 3D 设备 (DEVICES_3D — GLB 模型)

| Group | 设备 | 原生尺寸 (px) | GLB 文件 |
|-------|------|--------------|----------|
| 手机 | iPhone 15 Pro Max | 430×932 | `mobile/iphone_15_pro_max.glb` |

> 3D 设备目前仅有 1 个可用 GLB 模型。其余设备的 GLB 文件待下载，放入 `3d/{group}/` 目录后在 `DEVICES_3D` 数组中注册即可启用。

---

## 🚧 当前状态

### ✅ 已完成
- 2D 渲染：WebAstPreview + PNG 设备边框（6 个设备预设）
- 3D 渲染：CanvasStage3D + R3F + GLB + RTT 贴图
- 2D/3D 模式切换 + 设备选择 + 底色选择
- 3D 主题/材质右键菜单（8 色 + 5 工艺）
- anime.js 动画系统（模式切换 / 设备切换 / DSL FLIP / stagger 入场）
- 持久化三层架构（Garnet / SurrealDB / 文件系统）
- 静态资源服务（express.static, GLB/HDR MIME 设置）
- 设备有效性校验（已删除设备自动回退）

### ⏳ 待完成
- 更多 3D GLB 模型文件下载与 UV 标定
- 2D PNG 边框扩充（更多设备型号）

---

## 📚 相关文件

### 前端组件 (UI/src/components/)
- `PreviewPanel.tsx` — 画布预览主面板
- `CanvasStage.tsx` — 渲染模式分发（2D/3D）
- `WebAstPreview.tsx` — 2D DSL → HTML/CSS 渲染器
- `CanvasStage3D.tsx` — 3D R3F 场景
- `ScreenMesh.tsx` — 3D 屏幕区域定位工具
- `CanvasResourceBar.tsx` — 画布资源栏
- `DeleteConfirmModal.tsx` — 删除确认弹窗

### 前端服务 (UI/src/services/canvas/)
- `UniversalAST.ts` — UniversalNode 类型定义
- `modelThemes.ts` — 3D 颜色主题 + 材质工艺
- `canvasAnimations.ts` — anime.js 动画工具
- `sessionApi.ts` — 画布会话 API
- `types.ts` — 类型定义

### 前端状态 (UI/src/state/)
- `canvasDeviceStore.ts` — 设备/renderMode/主题状态
- `previewStreamStore.ts` — DSL 流 + AST 缓存
- `appStore.ts` — 全局状态

### 服务端 (UI/src/server/)
- `services/session/SessionStore.ts` — 多会话状态管理
- `services/persistence/GarnetStore.ts` — 热存储 (Garnet/Redis)
- `services/persistence/SurrealStore.ts` — 温存储 (SurrealDB)
- `services/canvas/validators.ts` — 运行时类型校验
- `routes/canvasSession.ts` — 画布会话 HTTP 路由

### Electron
- `electron/main.cjs` — 主进程（进程管理 + 设备窗口）
- `server.ts` — Express 服务（静态资源 + API 代理）

### 资源
- `resources/canvas/models/2d/` — PNG 设备边框
- `resources/canvas/models/3d/` — GLB 3D 模型
- `resources/canvas/models/hdri/` — HDR 环境贴图
- `resources/canvas/models/device-config.json` — 3D UV 屏幕区域配置
