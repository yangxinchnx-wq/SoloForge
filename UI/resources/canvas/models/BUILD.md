# 构建命令 / Build Guide

## 📋 前置条件

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | >= 18 | 主运行时 |
| Garnet | 预编译 | `bin/garnet/portable/net10.0/GarnetServer.exe` |
| PowerShell | 5.1+ | Win32 API 调用 |

---

## 🔨 开发模式启动

### 1. 启动 Garnet (热存储)

```bash
# 在项目根目录
start-garnet.bat
```

输出:
```
[1/2] 检查端口 6379 占用情况...
[2/2] 启动 Garnet 服务...
       端口: 6379
       数据: bin/garnet/data/
```

### 2. 启动 SurrealDB (温存储)

```bash
# 项目根目录的 src/index.ts 中已配置 rocksdb://
# 启动 SoloForge 主后端即可
npm run dev
```

### 3. 启动 UI (Electron + Vite)

```bash
cd UI
npm install
npm run dev
```

---

## 📦 生产模式构建

```bash
cd UI
npm run package
```

输出: `UI/release/SoloForge-Setup-1.0.0.exe`

构建过程会:
1. `vite build` → 打包 React 前端
2. `esbuild` → 编译 server.ts
3. `electron-builder` → 打包 Electron
4. 拷贝 `resources/canvas/models/` → `release/win-unpacked/canvas/models/`

---

## 🧪 测试

### 端到端测试

```bash
# 根目录
node test_canvas_e2e.cjs
```

### 手动测试流程

1. 启动 Garnet + SoloForge 后端 + UI
2. 在 PreviewPanel 中切换 2D/3D 模式
3. 选择设备（如 iPhone 16 Pro Max）
4. 2D 模式：画布显示 DSL 渲染结果 + PNG 设备边框
5. 3D 模式：画布显示 3D 设备模型 + RTT 贴图（需要 GLB 文件存在）
6. 3D 模式右键画布 → 弹出主题/材质选择菜单
7. 切换底色 → 画布背景色实时更新

---

## 🐛 常见问题

### Q: 3D 模式不显示模型
**A**: 检查 `resources/canvas/models/3d/{group}/` 下是否有对应 `.glb` 文件。无 GLB 文件时自动降级为 2D 模式。

### Q: 2D 设备边框不显示
**A**: 检查 `resources/canvas/models/2d/{group}/` 下是否有对应 `.png` 文件。PNG 加载失败时边框层自动隐藏，DSL 渲染层仍正常显示。

### Q: Garnet 端口被占用
**A**: 
```bash
netstat -ano | findstr ":6379"
taskkill /PID <pid> /F
```

### Q: 静态资源 404
**A**: `server.ts` 中通过 `express.static` 挂载 `/canvas/models/*` → `resources/canvas/models/*`。确认目录存在且 server.ts 启动时控制台输出 `[canvas-models] 静态资源服务已挂载`。

### Q: 3D 模型加载报错（useGLTF 解析失败）
**A**: 确认 server.ts 对 `.glb` 文件设置了 `Content-Type: model/gltf-binary`。如仍失败，检查 GLB 文件是否损坏。

---

## 📐 性能调优

### 前端渲染
- 3D 组件 `CanvasStage3D` 通过 `React.lazy` 按需加载，避免首屏加载 three.js
- 2D 模式用 `ResizeObserver` 动态缩放，避免重排
- DSL 更新使用 FLIP 布局过渡，避免视觉跳跃
- anime.js 动画通过 `cancelAllCanvasAnimations` 统一清理

### Electron 端
- SessionStore Map 清理（LRU 上限 50 个会话）
- 30s flush 一次（不要实时写 SurrealDB）

### Garnet 配置
- `--memory` 模式: 纯内存, 速度最快
- `--checkpointdir`: AOF 持久化
- `--logger-folder`: 日志输出
