# 构建命令 / Build Guide

## 📋 前置条件

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | >= 18 | 主运行时 |
| Flutter | >= 3.22 | Canvas 端 |
| Garnet | 预编译 | `bin/garnet/portable/net10.0/GarnetServer.exe` |
| Visual Studio | 2022 | Canvas C++ 编译 |
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

### 4. 启动 Canvas (Flutter)

```bash
# 第一次需要构建
cd UI/scripts
./build_canvas.ps1

# 之后 PreviewPanel 点击 "启动画布" 即可
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
4. 拷贝 `resources/canvas/canvas-dist/` → `release/win-unpacked/canvas/`
5. 拷贝 `resources/canvas/models/` → `release/win-unpacked/canvas/models/`

---

## 🧪 测试

### 单元测试 (Flutter)

```bash
cd UI/resources/canvas/canvas_preview
flutter test
```

### 端到端测试

```bash
# 根目录
node test_canvas_e2e.cjs
```

### 手动测试流程

1. 启动 Garnet + SoloForge 后端 + UI
2. 在 PreviewPanel 点击 "启动画布"
3. 画布上拉起 9090 端口的 Flutter 进程
4. 点击 "尺寸" 下拉
5. 选择 "iPhone 14 Pro" (前提: 模型文件存在)
6. 画布上应出现 3D iPhone 模型占位 (BoxGeometry)
7. 用滚轮按下拖动模型
8. 用右键长按拖动旋转模型
9. 点击模型 → 看到渐变流动描边
10. 点击删除按钮 → 弹出确认弹窗
11. 确认 → 模型从画布消失

---

## 🐛 常见问题

### Q: 启动画布失败 `canvas_preview.exe not found`
**A**: 运行 `UI/scripts/build_canvas.ps1` 构建

### Q: Garnet 端口被占用
**A**: 
```bash
netstat -ano | findstr ":6379"
taskkill /PID <pid> /F
```

### Q: 3D 模型显示为 BoxGeometry
**A**: 模型文件不存在，按 `resources/canvas/models/README.md` 下载

### Q: 渐变描边不显示
**A**: 检查浏览器是否支持 `conic-gradient` (Chrome 69+)

### Q: 旋转/移动不响应
**A**: 确认 `contextmenu` 事件被阻止（已在代码中处理）

---

## 📐 性能调优

### Flutter 端
- 减小 RTT 纹理尺寸（默认 512x512）
- 限制同时渲染的 3D 设备数（建议 ≤ 5）
- 使用 `RepaintBoundary` 隔离重绘

### Electron 端
- SessionStore Map 清理（LRU 上限 50 个会话）
- 30s flush 一次（不要实时写 SurrealDB）
- WebSocket 复用（单连接多路复用）

### Garnet 配置
- `--memory` 模式: 纯内存, 速度最快
- `--checkpointdir`: AOF 持久化
- `--logger-folder`: 日志输出
