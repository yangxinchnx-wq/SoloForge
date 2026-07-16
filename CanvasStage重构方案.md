# SoloForge CanvasStage 重构方案

> 生成时间: 2026-07-15
> 状态: 初步验证通过，待补充

---

## 一、背景：当前架构问题

### 现有 3D 实现真相

当前画布的 "3D" 实际由四层组成：

| 层 | 技术 | 状态 |
|---|---|---|
| Electron 主进程 | `main.cjs` spawn 子进程 + HWND 嵌入 | ✅ 真实 |
| Flutter `canvas_preview.exe` | HTTP/WebSocket 服务 + UI 渲染容器 | ✅ 真实 |
| 3D 模型渲染 | `InAppWebView` + `<model-viewer>` Web Component | ✅ 真实 WebGL |
| `three_d` Dart 包 | `ThreeDSceneManager` + `DeviceRenderer` | ❌ 纯 Stub 空壳 |

**调用链：**
```
React PreviewPanel.tsx
  ↓ IPC (window.soloforge.canvas.selectDevice)
Electron main.cjs
  ↓ HTTP POST /render
Flutter canvas_preview.exe
  ↓ InAppWebView
<model-viewer> (Three.js)
  ↓ WebGL → GPU
```

### 核心问题

1. **3D 不能做真 RTT 贴图** — 2D UI 只是 `Positioned` 浮在 WebView 上方，旋转模型时 UI 不跟随
2. **WebView 内存开销大** — 每个设备实例一个完整 Chrome 引擎
3. **JS 桥接脆弱** — 模式切换靠 `console.log` 字符串匹配
4. **多设备场景不可能** — WebView 是全屏覆盖
5. **进程管理复杂** — spawn + HWND embed + 崩溃检测 + 看门狗心跳
6. **代码量庞大** — main.dart (~1267行) + platform_renderer.dart (~926行) + main.cjs canvas部分 (~800行) + three_d stub (~570行) = ~3563 行可消除代码

---

## 二、重构目标：一个 React 组件搞定全部

### 新架构（2 层替代 7 层）

```
CanvasStage.tsx (一个 React 组件)
│
├── 模式: 2D (renderMode === '2D')
│   ├── WebAstPreview (代码翻译 → DSL → React DOM)
│   │   └── 节点: container/text/button/input/image/
│   │           icon/divider/spacer/svg/canvas/video/progress/chart
│   ├── DrawingCanvas (HTML5 Canvas 画图)
│   └── VideoPlayer (<video> 标签)
│
├── 模式: 3D (renderMode === '3D')
│   ├── <Canvas> (R3F WebGL)
│   │   ├── <DeviceModel> (useGLTF 加载 .glb)
│   │   ├── <ScreenTexture> (RTT: WebAstPreview → texture → 贴到屏幕 mesh)
│   │   ├── <OrbitControls> (查看模式: 拖拽旋转)
│   │   └── <Lights> (环境光 + 方向光)
│   └── 设备选择器 (复用已有 DEVICES_3D 列表)
│
├── 工具栏 (复用 PreviewPanel 工具栏逻辑)
│   ├── 2D/3D 切换
│   ├── 底色选择器
│   └── 设备下拉框
│
└── 数据流 (无 IPC, 直接读 store)
    ├── previewStreamStore (DSL/AST 数据)
    ├── canvasDeviceStore (设备/尺寸)
    └── IncrementalCanvasPusher (翻译 → store, 去掉 IPC push)
```

### 消除的复杂度

| 消除项 | 代码量 |
|---|---|
| `main.dart` (Flutter 全部) | ~1267 行 |
| `main.cjs` canvas 部分 | ~800 行 |
| `platform_renderer.dart` | ~926 行 |
| `ui_parser.dart` | ~250 行 |
| `three_d/*.dart` (空壳) | ~570 行 |
| IPC 类型定义 + preload | ~50 行 |
| `Canvas3DClient.ts` | ~200 行 |
| **合计消除** | **~4063 行** |

### 新增依赖（版本锁定 — React 19 兼容）

| 包 | 版本 | 用途 | 大小 |
|---|---|---|---|
| `three` | `^0.172` | WebGL 3D 渲染核心 | ~600KB (gzip ~150KB) |
| `@react-three/fiber` | `^9` | React 3D 渲染器（v9+ 才支持 React 19） | ~50KB |
| `@react-three/drei` | `^10` | RenderTexture / OrbitControls / useGLTF / Text | ~80KB |

> ⚠️ 版本约束说明：
> - `fiber@^9`+ 的 `@types/react` 依赖为 `^19.2.7`，向下不兼容 React 18
> - `drei@^10`+ 才有稳定的 `<RenderTexture>` 组件（源码 `src/core/RenderTexture.tsx`，2025-02-19 更新）
> - 低版本会直接 crash，不可降级
> - 实际 bundle 增量约 **1.5-2MB（gzip ~400KB）**，建议动态 import 拆 chunk

---

## 三、功能逐项验证

### ✅ 功能 1：翻译各种代码并显示

**可行性：完全可行，已有 85% 基础**

#### 已有能力

| 能力 | 现状 |
|---|---|
| 翻译器 | **11 种语言**：HTML, React/JSX, Vue, Flutter, SwiftUI, Compose, Android XML, XAML, QML, Python, C |
| 翻译器架构 | `Translator` 接口 + Vite `import.meta.glob` 自动发现，新增语言只需加一个文件 |
| Worker 加速 | `translateCodeAsync` 多线程翻译已就绪 |
| 增量推送 | `IncrementalCanvasPusher` 逐行翻译 + `repairJson` 修复截断 JSON |
| DSL 渲染 | `WebAstPreview.tsx` 已支持 12 种节点类型 |

#### WebAstPreview vs Flutter PlatformRenderer 差距

| 节点类型 | Flutter | WebAstPreview | 差距 |
|---|---|---|---|
| container/row/column/stack | ✅ | ✅ | 无 |
| text | ✅ | ✅ | 无 |
| button | ✅ | ✅ | 无 |
| input | ✅ | ✅ | 无 |
| image | ✅ | ✅ | 无 |
| icon | ✅ | ❌ 缺 | 加 ~30 行 |
| divider | ✅ | ✅ | 无 |
| spacer | ✅ | ✅ | 无 |
| progress | ✅ | ❌ 缺 | 加 ~20 行 |
| svg | ✅ | ✅ | 无 |
| chart (bar/line/pie) | ✅ CustomPaint | ❌ 缺 | 用已有 `recharts` 库补 ~100 行 |

**关键发现：`package.json` 已有 `recharts`** — chart 类型可以直接用，比 Flutter 的手写 CustomPaint 更强。

**工作量：补 3 个节点类型，约 150 行代码。**

---

### ✅ 功能 2：画画 / 绘图

**可行性：完全可行，比 Flutter 方案更简单**

#### 方案对比

| 方案 | 技术 | 优势 | 适合场景 |
|---|---|---|---|
| **HTML5 Canvas API** | `<canvas>` + 2D context | 原生、零依赖、性能好 | 自由绘画、笔刷 |
| **SVG** | `<svg>` + React | 可缩放、可序列化 | 矢量图、流程图 |
| **Excalidraw** | 开源库 | 手绘风格、完整画板 | 白板/交互式绘图 |

#### 与 DSL 系统集成

LLM 输出 DSL 中的 `canvas` 类型节点（UniversalAST 已有占位，WebAstPreview 已支持），扩展支持绘图指令：

```json
{
  "type": "canvas",
  "props": {
    "draw": [
      {"op": "rect", "x": 10, "y": 10, "w": 100, "h": 80, "fill": "#f00"},
      {"op": "circle", "cx": 200, "cy": 100, "r": 50, "stroke": "#00f"},
      {"op": "line", "from": [10, 10], "to": [300, 200], "width": 2}
    ]
  }
}
```

React 端解析 `draw` 指令数组 → Canvas 2D API 绘制。约 200 行代码。

如果需要用户交互式绘画（手绘），直接嵌入 `<canvas>` + 鼠标事件监听即可。

**工作量：约 200 行代码。**

---

### ✅ 功能 3：视频播放 / HeyGen 代码转视频

**可行性：视频播放 trivial；代码转视频是后端任务**

#### 视频播放

纯前端，一行 HTML：

```tsx
case 'video':
  return <video src={n.src} controls autoPlay loop
    style={{ width: '100%', height: '100%', objectFit: 'contain' }} />;
```

在 DSL 里加一个 `video` 节点类型即可。约 30 行。

#### HeyGen 代码转视频

HeyGen 是 AI 数字人视频生成 API，流程：

```
代码/DSL → LLM 生成解说脚本 → HeyGen API 生成视频 → 返回 video URL → 画布播放
```

画布只需要做一件事：**播放返回的 video URL**。视频生成是后端/Agent 层的事。

#### 替代方案对比

| 方案 | 说明 | 适合场景 |
|---|---|---|
| **HeyGen API** | AI 数字人讲解代码 | 产品演示/教学视频 |
| **Remotion** | React 代码驱动视频生成 | 代码→动画→视频，完全本地 |
| **html2canvas + WebM** | 录制画布操作回放 | 操作教程 |
| **直接 `<video>`** | 播放任意 MP4/WebM | 通用视频显示 |

**Remotion** 比 HeyGen 更贴切——React 生态，可以直接把 DSL/翻译结果渲染成视频帧，不需要外部 API。

**工作量：前端 ~30 行（video 节点）；后端集成另计。**

---

### ✅ 功能 4：3D 模型 + 内容嵌入

**可行性：完全可行，能实现 Flutter 方案做不到的真 RTT 贴图**

> ⚠️ 2026-07-16 修订：原方案的 `useRTT` hook 不存在，且 `WebAstPreview` 是 React DOM 组件不能直接进 R3F portal。
> 以下为基于 drei 真实 API 的可行方案。

#### 依赖（版本锁定 — 必须 React 19 兼容）

```bash
npm install three@^0.172 @react-three/fiber@^9 @react-three/drei@^10
```

> 版本约束说明：
> - `fiber@^9`+ 才支持 React 19（仓库 `@types/react: ^19.2.7`）
> - `drei@^10`+ 才有稳定的 `<RenderTexture>` 组件
> - `three@^0.172`+ 才有新版 `WebGLRenderTarget` API
> - 低版本会直接 crash，不可降级

#### 架构

```tsx
<Canvas>                          // R3F Canvas (WebGL context)
  <ambientLight intensity={0.5} />
  <directionalLight position={[10, 10, 5]} />

  <DeviceModel url="/models/3d/mobile/iphone_15_pro_max.glb" dsl={dsl} />
</Canvas>
```

#### "把画出来的东西放在 3D 模型里面"的实现

| 方式 | 技术 | 效果 |
|---|---|---|
| **A: Html overlay** | `@react-three/drei` 的 `<Html>` 组件 | 2D UI 浮在 3D 模型前方，不跟随旋转（等同 Flutter 旧方案） |
| **B: 真 RTT 贴图** | `@react-three/drei` 的 `<RenderTexture>` + `createPortal` | UI 作为纹理贴到模型屏幕 mesh 上，旋转时完全跟随 |

方式 B 是 Flutter 方案做不到的。在 R3F 里用 drei 真实 API：

```tsx
// ScreenMesh.tsx —— 真实可用的 RTT 贴图实现
import { useGLTF, RenderTexture, Text, RoundedBox } from '@react-three/drei';

// 核心：DslToR3f 是 WebAstPreview 的 R3F 原生版（DOM 组件不能进 RTT portal）
function DslToR3f({ node }: { node: UniversalNode }) {
  switch (node.type) {
    case 'container':
    case 'column':
      return <group>{node.children?.map((c, i) => <DslToR3f key={i} node={c} />)}</group>;
    case 'text':
      return (
        <Text fontSize={node.style?.fontSize || 16}
              color={node.style?.color || '#000'}
              anchorX="left" anchorY="top">
          {node.content}
        </Text>
      );
    case 'button':
      return (
        <RoundedBox args={[120, 40, 2]} radius={8}>
          <meshBasicMaterial color={node.style?.background || '#007aff'} />
        </RoundedBox>
      );
    // ... 其余 10 种节点类型
  }
}

// 设备模型 + 屏幕区域 RTT 贴图
function DeviceModel({ url, dsl }: { url: string; dsl: UniversalNode }) {
  const { scene } = useGLTF(url);
  const screenMesh = scene.getObjectByName('screen'); // GLB 中预命名的屏幕网格

  return (
    <primitive object={scene}>
      <mesh geometry={screenMesh.geometry} position={screenMesh.position}>
        <meshBasicMaterial toneMapped={false}>
          {/* drei RenderTexture —— children 必须是 R3F 原生组件 */}
          <RenderTexture width={393} height={852} samples={4} frames={Infinity}>
            <color attach="background" args={['#ffffff']} />
            <PerspectiveCamera makeDefault position={[0, 0, 100]} fov={30} />
            <DslToR3f node={dsl} />
          </RenderTexture>
        </meshBasicMaterial>
      </mesh>
    </primitive>
  );
}
```

**工作机制**（drei 源码 `RenderTexture.tsx` 真实实现）：
1. `useFBO` 创建 WebGLRenderTarget（GPU 内部缓冲）
2. `createPortal` 把 children 渲染到虚拟 Scene
3. `useFrame` 每帧切换 `gl.setRenderTarget(fbo)`，把虚拟 Scene 渲染到 FBO
4. `fbo.texture` 作为 `THREE.Texture` 赋给 material.map
5. `frames={Infinity}` 持续渲染 → DSL 变化时纹理实时更新
6. 旋转模型时屏幕 UI 作为纹理完全跟随

> 关键约束：`<RenderTexture>` 的 children 必须是 R3F 原生组件（`<mesh>`/`<group>`/drei `<Text>` 等），
> 不能是 React DOM 组件（`<div>`/`<span>`）。因此 `WebAstPreview` 不能直接复用，必须重写为 `DslToR3f`。

#### 已有 GLB 模型文件（⚠️ 需预处理）

| 模型 | 路径 | 大小 | screen mesh 命名 | RTT 可用 |
|---|---|---|---|---|
| iPhone 15 Pro Max | `models/3d/mobile/iphone_15_pro_max.glb` | 3.3MB | ✅ `screen` | 直接可用 |
| iPhone 11 Pro Max | `models/3d/mobile/iphone_11_pro_max.glb` | 836KB | ❌ 未命名 | 需 Blender 修模 |
| iPhone 14 Pro | `models/3d/mobile/iphone_14_pro.glb` | 120KB | ❌ 未命名（体积异常小，疑似简化模型） | 需 Blender 修模 + 验证完整性 |

**GLB 预处理步骤**（实施前必须完成）：
1. 用 Blender 打开未命名的 GLB
2. 找到屏幕区域 mesh，命名为 `screen`
3. 重新导出 GLB（保留原文件备份）
4. 或：代码中按 boundingBox 估算屏幕位置（容差大，不推荐）

**工作量：~1000-1350 行代码**，拆分如下：
- `DslToR3f.tsx`（R3F 原生版 DSL 渲染器，12 种节点类型）：500-700 行
- flex 布局计算（R3F 无 CSS flex，需自算 position 或引入 yoga-layout-wasm）：200-300 行
- `ScreenMesh.tsx`（drei RenderTexture 集成）：150-200 行
- GLB 屏幕定位 + 错误降级：100-150 行
- GLB 模型 Blender 修模：1-2 小时（非编码工作）

---

## 四、整体可行性总表

| 功能 | 可行性 | 现有基础 | 新增工作量 | 依赖 |
|---|---|---|---|---|
| 代码翻译显示 | ✅ 完全可行 | 11 种翻译器 + WebAstPreview + Worker | ~150 行（补 icon/progress/chart） | 无新增 |
| 画画/绘图 | ✅ 完全可行 | `canvas` 节点已有占位 | ~200 行 | 无新增 |
| 视频播放 | ✅ 完全可行 | 无 | ~30 行 | 无新增 |
| HeyGen 代码转视频 | ✅ 可行（后端任务） | 无 | 后端集成另计 | HeyGen API key |
| 3D 模型显示 | ✅ 完全可行 | 3 个 GLB 文件已有（1 个直接可用，2 个需修模） | ~400 行（场景+GLB 加载+OrbitControls+光照调参） | three + R3F + drei |
| 3D 内嵌 UI（真 RTT） | ✅ 可行（Flutter 做不到） | 无 | ~1000-1350 行（DslToR3f 重写+flex+RTT 集成） | 同上 |

**总新增代码量：~1800-2150 行**（原估算 ~1080 行，RTT 部分低估 5-7 倍）
**新增依赖：3 个包（three.js 生态，版本锁定见上）**
**消除代码：~4063 行**

---

## 五、画布与后端接口全清单

> 重构前必须理清当前画布涉及的**全部**接口，区分"保留"和"消除"

### A. 后端 Server HTTP API（全部保留）

> 路由文件: `UI/src/server/routes/canvasSession.ts` + `canvasTools.ts`
> 前端客户端: `UI/src/services/canvas/sessionApi.ts`

#### 画布会话管理

| # | 方法 | 路径 | 用途 | 前端函数 |
|---|---|---|---|---|
| 1 | POST | `/api/canvas/sessions` | 创建画布（自动分配序号 1~10） | `createCanvas()` |
| 2 | GET | `/api/canvas/sessions` | 列出所有画布会话 | `listSessions()` |
| 3 | GET | `/api/canvas/sessions/:id` | 获取画布完整 SessionState | `fetchSession()` / `fetchCanvas()` |
| 4 | PATCH | `/api/canvas/sessions/:id` | 改画布名/描述 | `renameSession()` / `updateCanvasDescription()` |
| 5 | DELETE | `/api/canvas/sessions/:id` | 删除画布（序号可复用） | `deleteSession()` / `deleteCanvas()` |
| 6 | POST | `/api/canvas/sessions/:id/flush` | 强制 flush 到 Garnet + SurrealDB | `flushSession()` |

#### 画布资源池 + ACL

| # | 方法 | 路径 | 用途 | 前端函数 |
|---|---|---|---|---|
| 7 | GET | `/api/canvas/resources` | 列出当前 chat 可访问的所有画布（带 owner 标记） | `listCanvasResources()` / `fetchLastAccessedCanvas()` |
| 8 | GET | `/api/canvas/notifications` | 拉取并 ack 画布修改通知（3s 轮询） | `drainCanvasNotifications()` |
| 9 | POST | `/api/canvas/notifications/peek` | 仅 peek 不消费（调试用） | `peekCanvasNotifications()` |

#### 设备管理

| # | 方法 | 路径 | 用途 | 前端函数 |
|---|---|---|---|---|
| 10 | PUT | `/api/canvas/sessions/:id/select-model` | 选中设备模型（切换画布模式） | `selectModel()` |
| 11 | PUT | `/api/canvas/sessions/:id/devices/selected` | 设置选中设备 ID（高亮） | `setSelectedDevice()` |
| 12 | PUT | `/api/canvas/sessions/:id/devices/selected-many` | 多选设备 | `setSelectedDevices()` |
| 13 | POST | `/api/canvas/sessions/:id/devices/transform-group` | 群组增量变换 | `transformGroup()` |
| 14 | POST | `/api/canvas/sessions/:id/devices` | 添加设备实例 | `addDevice()` |
| 15 | DELETE | `/api/canvas/sessions/:id/devices/:deviceId` | 删除设备 | `removeDevice()` |
| 16 | PUT | `/api/canvas/sessions/:id/devices/:deviceId/transform` | 更新设备 transform | `updateDeviceTransform()` |
| 17 | PUT | `/api/canvas/sessions/:id/devices/:deviceId/ui-session` | 设置设备独立 UI session | `setDeviceUiSession()` |

#### DSL 热数据存储

| # | 方法 | 路径 | 用途 | 存储层 |
|---|---|---|---|---|
| 18 | GET | `/api/canvas/sessions/:id/dsl` | 读取最后保存的 DSL/AST | GarnetStore (Redis, 24h TTL) |
| 19 | PUT | `/api/canvas/sessions/:id/dsl` | 写入 LLM 生成的 DSL/AST | GarnetStore |

#### 持久化

| # | 方法 | 路径 | 用途 | 前端函数 |
|---|---|---|---|---|
| 20 | GET | `/api/canvas/persistence/status` | 持久化诊断（flush 次数/耗时） | `getPersistenceStatus()` |
| 21 | POST | `/api/canvas/persistence/force-flush` | 强制 flush（F5 前调用） | `forceFlush()` |
| 22 | POST | `/api/canvas/persistence/restore-all` | 冷启动恢复（SurrealDB → 内存） | `restoreAllFromSurreal()` |
| 23 | POST | `/api/canvas/persistence/clear-all` | 清空所有持久化数据 | — |

#### MCP 工具（LLM 调用）

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| 24 | GET | `/api/canvas/tools` | 返回 MCP 工具 schema 列表 |
| 25 | POST | `/api/canvas/tools/invoke` | 执行指定工具（canvas_push_ui / list_files / read_file 等） |

#### 静态文件服务（画布资源）

| # | 方法 | 路径 | 用途 | 重构后 |
|---|---|---|---|---|
| 26 | GET | `/canvas/models/2d/**` | 2D PNG 设备边框图片 | **保留**（React `<img>` 直接引用） |
| 27 | GET | `/canvas/models/3d/**` | 3D GLB 模型文件 | **保留**（R3F `useGLTF` 直接引用） |

---

### B. Electron IPC 接口（全部消除）

> 路由文件: `UI/electron/preload.cjs` → `main.cjs`
> 前端调用: `window.soloforge.canvas.*`
> 类型定义: `UI/src/global.d.ts` → `CanvasApi` 接口

| # | IPC Channel | 前端调用 | 用途 | 重构后 |
|---|---|---|---|---|
| 1 | `canvas:start` | `canvas.start(sessionId, w, h)` | spawn Flutter 进程 + HWND 嵌入 | ❌ 消除（无需子进程） |
| 2 | `canvas:resize` | `canvas.resize(sessionId, w, h)` | 调整 Flutter HWND 尺寸 | ❌ 消除（CSS 响应式） |
| 3 | `canvas:stop` | `canvas.stop(sessionId)` | kill Flutter 进程 | ❌ 消除 |
| 4 | `canvas:push` | `canvas.push(sessionId, dsl)` | HTTP POST /render 到 Flutter | ❌ 消除（直接写 store） |
| 5 | `canvas:status` | `canvas.status(sessionId)` | 检查 Flutter 进程健康 | ❌ 消除 |
| 6 | `canvas:report-bounds` | `canvas.reportBounds(bounds)` | 上报画布区域 bounds | ❌ 消除 |
| 7 | `canvas:host-info` | `canvas.hostInfo()` | 获取宿主窗口信息 | ❌ 消除 |
| 8 | `canvas:ensure-host` | `canvas.ensureHost()` | 确保宿主窗口存在 | ❌ 消除 |
| 9 | `canvas:push-ui` | `canvas.pushUI(sessionId, dsl, deviceId)` | HTTP POST /push-ui 到 Flutter | ❌ 消除 |
| 10 | `canvas:select-device` | `canvas.selectDevice(sessionId, key, file, size)` | HTTP POST /render action:selectDevice | ❌ 消除（直接写 store） |
| 11 | `canvas:open-device-popup` | `canvas.openDevicePopup(payload)` | 创建 BrowserWindow 设备选择浮窗 | ❌ 消除（React Popover） |
| 12 | `canvas:close-device-popup` | `canvas.closeDevicePopup()` | 关闭 BrowserWindow 浮窗 | ❌ 消除 |
| 13 | `canvas:device-popup-select` | `canvas.devicePopupSelect(key)` | 从浮窗发送选择 | ❌ 消除 |
| 14 | `canvas:device-popup-close` | `canvas.devicePopupClose()` | 从 React 关闭浮窗 | ❌ 消除 |
| 15 | `canvas:device-selected` | `canvas.onDeviceSelected(cb)` | 监听设备选择事件 | ❌ 消除（React 回调） |
| 16 | `canvas:transform-device` | `canvas.transformDevice(sessionId, devId, transform)` | HTTP POST /transform 到 Flutter | ❌ 消除 |
| 17 | `canvas:clear-devices` | `canvas.clearDevices(sessionId)` | HTTP POST /clear-devices 到 Flutter | ❌ 消除 |
| 18 | `canvas:set-background` | `canvas.setBackground(sessionId, color)` | HTTP POST /render action:setBackground | ❌ 消除（直接写 store） |
| 19 | `canvas:screenshot` | `canvas.screenshot(sessionId)` | 截图画布 | ❌ 改用 html2canvas |
| 20 | `canvas:get-device-config` | `canvas.getDeviceConfig()` | 读取 device-config.json | ❌ 改用 React 常量 |
| 21 | `canvas:list-models` | `canvas.listModels()` | 列出可用模型 | ❌ 改用 React 常量 |
| 22 | `canvas:embed-status` | `canvas.embedStatus(sessionId)` | 检查 HWND 嵌入状态 | ❌ 消除 |
| 23 | `canvas:exited` | `canvas.onExited(cb)` | 监听画布崩溃/退出 | ❌ 消除（无子进程） |

---

### C. Flutter canvas_preview.exe HTTP API（全部消除）

> 进程: `canvas_preview.exe`（spawn 子进程，端口 9090+）
> 前端客户端: `UI/src/services/canvas/Canvas3DClient.ts`

| # | 方法 | 路径 | 用途 | 重构后 |
|---|---|---|---|---|
| 1 | POST | `/render` | 渲染 UI DSL / selectDevice / setBackground | ❌ 消除 |
| 2 | POST | `/push-ui` | 推送 UI 内容 / feedASTChunk / flushAST | ❌ 消除 |
| 3 | POST | `/transform` | 更新设备 transform | ❌ 消除 |
| 4 | POST | `/clear-devices` | 清除所有设备 | ❌ 消除 |
| 5 | GET | `/health` | 健康检查（看门狗心跳） | ❌ 消除 |
| 6 | WS | `/ws` 或 `/` | WebSocket 升级 | ❌ 消除 |
| 7 | GET | `/models/*` | 静态 GLB 文件服务 | ❌ 消除（改用 Express 静态服务） |
| 8 | GET | `/assets/*` | model-viewer.min.js 服务 | ❌ 消除 |
| 9 | GET | `/api/canvas/devices/validation` | 设备配置校验 | ❌ 消除 |
| 10 | POST | `/api/canvas/devices/reload` | 重载设备配置 | ❌ 消除 |
| 11 | GET | `/api/canvas/rtt/devices` | 列出 RTT 设备 | ❌ 消除 |
| 12 | POST | `/api/canvas/rtt/texture` | 推送 RTT 纹理 | ❌ 消除（R3F 内部处理） |
| 13 | GET | `/api/canvas/rtt/texture/:sid/:did` | 查询 RTT 纹理 | ❌ 消除 |
| 14 | POST | `/api/canvas/rtt/input` | 推送屏内输入事件 | ❌ 消除 |
| 15 | GET | `/api/canvas/rtt/input` | 拉取输入事件队列 | ❌ 消除 |

---

### D. 前端 Store 和 Service（保留 / 修改）

| 文件 | 用途 | 重构后 |
|---|---|---|
| `sessionApi.ts` | 后端 HTTP API 客户端（25 个端点） | **保留不变** |
| `garnetClient.ts` | Garnet/Redis 客户端（DSL 热存储） | **保留不变** |
| `IncrementalCanvasPusher` | 逐行翻译 + 推送 | **修改：去掉 `ensureCanvasAndPush`（IPC），改为直接写 `previewStreamStore`** |
| `previewStreamStore` | 流式预览状态 | **保留不变** |
| `canvasDeviceStore` | 设备尺寸/渲染模式/帧尺寸 | **保留 + 扩展 `renderMode` 字段** |
| `scaleDsl.ts` | DSL 等比例缩放 | **保留不变** |
| `Canvas3DClient.ts` | Flutter HTTP 客户端 | **删除** |
| `CanvasResourceBar.tsx` | 画布选项卡 chip 栏 | **保留不变** |

---

### E. 持久化三层架构（全部保留）

| 层 | 技术 | 用途 | 重构后 |
|---|---|---|---|
| 热存储 | Garnet (Redis 兼容) | 当前活跃会话实时状态 + DSL 热数据 | **保留**（sessionApi.ts 调用） |
| 温存储 | SurrealDB (rocksdb://) | 跨重启恢复（30s flush） | **保留** |
| 冷存储 | 文件系统 | GLB 模型 + PNG 边框 | **保留** |

---

## 六、一步到位实施方案

> 不分阶段，一次性完成全部功能

### 第 1 步：安装依赖（版本锁定 React 19 兼容）

```bash
cd UI
npm install three@^0.172 @react-three/fiber@^9 @react-three/drei@^10
```

> 不可降级：`fiber@^9`+ 才支持 React 19，`drei@^10`+ 才有稳定 `<RenderTexture>`

### 第 2 步：GLB 模型预处理（RTT 必需）

3 个 GLB 中只有 `iphone_15_pro_max.glb` 有命名规范的 `screen` mesh，其余 2 个需修模：

1. 用 Blender 打开 `iphone_11_pro_max.glb` 和 `iphone_14_pro.glb`
2. 找到屏幕区域 mesh，命名为 `screen`
3. 重新导出 GLB（保留原文件备份）
4. 验证 `iphone_14_pro.glb`（120KB 异常小，确认是否简化模型）
5. 代码兜底：若 `getObjectByName('screen')` 返回 null，按 boundingBox 估算屏幕位置

### 第 3 步：扩展 UniversalAST + WebAstPreview

1. `UniversalAST.ts`：联合类型新增 `video`、扩展 `canvas` 支持 `draw` 指令、可选 `3d-scene`
2. `WebAstPreview.tsx`：新增 `icon`（Heroicons）、`progress`、`chart`（recharts bar/line/pie）、`video` 节点
3. `canvas` 节点扩展 `draw` 指令解析 → HTML5 Canvas 2D API

### 第 4 步：新建 CanvasStage.tsx

一个组件整合全部：

```
CanvasStage.tsx
├── 顶部: CanvasResourceBar（保留，画布选项卡）
├── 工具栏: 启停/底色/2D-3D切换/设备下拉框
│   └── 设备下拉框: React Popover（替代 BrowserWindow）
├── 2D 模式:
│   ├── WebAstPreview（DSL → React DOM）
│   ├── DrawingCanvas（HTML5 Canvas 绘图）
│   ├── VideoPlayer（<video> 标签）
│   └── PNG 设备边框 overlay
├── 3D 模式:
│   ├── R3F <Canvas>（WebGL）
│   │   ├── <DeviceModel>（useGLTF 加载 GLB）
│   │   ├── <ScreenTexture>（RTT: WebAstPreview → texture）
│   │   ├── <OrbitControls>（查看模式拖拽旋转）
│   │   └── <Lights>
│   └── 设计/查看模式切换
└── 数据流: 直接读 previewStreamStore + canvasDeviceStore（零 IPC）
```

### 第 5 步：新建 DslToR3f.tsx + ScreenMesh.tsx（RTT 核心）

- `DslToR3f.tsx`：把 12 种 UniversalNode 重写为 R3F 原生组件（500-700 行）
  - text → drei `<Text>` (troika-three-text)
  - container/row/column → `<group>` + 自实现 flex 计算
  - button/image → `<RoundedBox>` / `<mesh>` + texture
- `ScreenMesh.tsx`：用 drei `<RenderTexture>` 集成 DslToR3f（150-200 行）
  - `useGLTF` 加载模型，`getObjectByName('screen')` 定位屏幕 mesh
  - `<RenderTexture frames={Infinity}>` 持续渲染 DSL 到 FBO 纹理
  - 降级：GLB 加载失败 → 用 drei `<Html>` overlay 做 2D UI 浮层

### 第 6 步：改 IncrementalCanvasPusher

- 去掉 `ensureCanvasAndPush`（IPC 调用）
- 翻译结果直接写 `previewStreamStore`
- `previewStreamStore` 变化 → `CanvasStage` 自动 re-render

### 第 7 步：改 PreviewPanel.tsx

- 去掉所有 `window.soloforge.canvas.*` 调用
- 渲染 `<CanvasStage>` 替代 IPC 调用
- 保留 DSL 恢复链路（GarnetStore → 聊天历史）
- 保留 `CanvasResourceBar` 调用链路

### 第 8 步：清理旧代码

| 删除项 | 文件 |
|---|---|
| Flutter 项目 | `resources/canvas/canvas_preview/` 整个目录 |
| Flutter 构建产物 | `resources/canvas/canvas-dist/` 整个目录 |
| main.cjs canvas 部分 | `main.cjs` 中 `canvasSessions`、spawn、IPC handler、HWND embed、BrowserWindow 设备弹窗（~800 行） |
| preload canvas bridge | `preload.cjs` 中 `canvas: {...}` 对象 |
| 类型定义 | `global.d.ts` 中 `CanvasApi` + `CanvasExitedInfo` 接口 |
| Flutter HTTP 客户端 | `Canvas3DClient.ts` |
| three_d stub | `canvas_preview/lib/services/three_d/` |
| model-viewer.min.js | `canvas_preview/assets/model-viewer.min.js` |
| extraResources | `package.json` 中 `extraResources[0]`（canvas-dist） |

---

## 七、现有资源清单（可复用）

### 翻译器（11 种，全部保留）

| 文件 | 语言 |
|---|---|
| `htmlTranslator.ts` | HTML |
| `reactTranslator.ts` | React/JSX/TSX |
| `vueTranslator.ts` | Vue SFC |
| `flutterTranslator.ts` | Flutter Dart |
| `swiftuiTranslator.ts` | SwiftUI |
| `composeTranslator.ts` | Jetpack Compose |
| `androidXmlTranslator.ts` | Android XML |
| `xamlTranslator.ts` | XAML |
| `qmlTranslator.ts` | QML |
| `pythonTranslator.ts` | Python (Tkinter/PyQt/Kivy) |
| `cTranslator.ts` | C (Win32/GTK/LVGL) |

### Store（全部保留）

| Store | 用途 |
|---|---|
| `previewStreamStore` | 流式预览状态（DSL/AST 数据） |
| `canvasDeviceStore` | 设备尺寸/渲染模式/帧尺寸 |

### 组件（保留 + 扩展）

| 组件 | 状态 |
|---|---|
| `WebAstPreview.tsx` | 保留，扩展节点类型 |
| `IncrementalCanvasPusher` | 保留，去掉 IPC push |
| `PreviewPanel.tsx` | 保留工具栏逻辑，替换渲染层 |
| `CanvasResourceBar` | 保留（画布池 chip 栏） |
| `scaleDsl.ts` | 保留（等比例缩放） |
| **画布浏览器选项卡** | **保留** — 用户明确要求保留。当前对应 `CanvasResourceBar`（画布 1~10 的 tab 切换栏），在重构后继续作为画布顶部的选项卡使用，支持多画布切换、新建、重命名、删除。重构后的 `CanvasStage` 需内嵌此组件，确保选项卡 ↔ 画布内容的联动不变。 |

### 模型文件（保留，部分需预处理）

| 文件 | 路径 | screen mesh 命名 | RTT 可用 |
|---|---|---|---|
| iPhone 15 Pro Max | `models/3d/mobile/iphone_15_pro_max.glb` | ✅ `screen` | 直接可用 |
| iPhone 11 Pro Max | `models/3d/mobile/iphone_11_pro_max.glb` | ❌ 未命名 | 需 Blender 修模 |
| iPhone 14 Pro | `models/3d/mobile/iphone_14_pro.glb` | ❌ 未命名（120KB 异常小） | 需修模 + 验证完整性 |
| 2D PNG 边框 (17 种) | `models/2d/**/*.png` | — | 2D 模式保留 |
| model-viewer.min.js | `canvas_preview/assets/` | — | 可删除（R3F 替代） |

---

## 八、保留项明确清单

> 以下功能在重构中必须保留，不删除、不弱化

| 保留项 | 当前实现 | 重构后 |
|---|---|---|
| **画布浏览器选项卡** | `CanvasResourceBar` 组件（画布 1~10 的 chip 栏） | 继续作为 `CanvasStage` 顶部选项卡，多画布切换/新建/重命名/删除功能不变 |
| **画布资源池 API** | `sessionApi.ts`（创建/删除/重命名画布的后端接口） | 保留，`CanvasResourceBar` 继续调用 |
| **DSL 恢复链路** | GarnetStore 热存储 → 聊天历史降级 | 保留，重构后仍走 `previewStreamStore` |
| **增量翻译推送** | `IncrementalCanvasPusher` 逐行翻译 + Worker | 保留翻译逻辑，去掉 IPC push，直接写 store |
| **底色选择器** | 6 种预设 + 自定义颜色 | 保留，UI 不变 |
| **2D PNG 设备边框** | 16 种设备 PNG 边框 overlay | 保留，2D 模式下继续使用 |
| **画布缩放** | `scaleDsl.ts` 等比例缩放 + ResizeObserver | 保留，改用 CSS transform 或 React 响应式 |

---

## 九、待讨论 / 补充项（已给出建议）

> 以下问题需要进一步交流确认

### ✅ 1. HeyGen vs Remotion → 建议：先用 `<video>` 节点，后续按需接入

**推荐：先不做代码转视频，先支持视频播放节点。**

理由：
- 代码转视频是一个完整的后端 pipeline（LLM 生成脚本 → 视频生成 API → 视频 URL），跟画布渲染层无关
- 画布只需做一件事：拿到 video URL → `<video>` 播放。这部分 30 行代码搞定
- HeyGen 和 Remotion 的选择取决于你的产品定位：
  - **HeyGen**：AI 数字人讲解，适合"代码讲解视频"，但依赖外部 API + 付费
  - **Remotion**：纯本地 React 代码驱动视频，适合"UI 动画录制"，但不做数字人
- 两者不冲突，可以都支持——画布只管播放 URL，后端用谁都行
- **结论：一步到位加 `video` 节点（播放任意 URL），代码转视频 pipeline 等产品需求明确后再接**

---

### ✅ 2. 绘画功能定位 → 建议：两者都做，有优先级

**推荐：优先做 LLM 生成绘图指令，后续做用户手绘白板。**

理由：
- LLM 生成绘图指令和你的 DSL 系统天然契合——LLM 输出 `{type: 'canvas', props: {draw: [...]}}`，React 端解析绘制。这是翻译器的延伸，~200 行代码
- 用户手绘白板是独立的交互功能，需要鼠标事件、笔刷工具栏、撤销/重做、序列化。复杂度是 LLM 绘图的 3-4 倍
- LLM 绘图先做有即时价值：用户说"画一个流程图" → LLM 输出绘图指令 → 画布显示
- 手绘白板可以后续做，甚至可以考虑直接集成 Excalidraw 组件（开源、手绘风格、完整画板），比自己写省 2000+ 行
- **结论：优先做 LLM 绘图指令（canvas 节点扩展 draw 属性），后续评估是否集成 Excalidraw**

---

### ✅ 3. 3D 设备扩展计划 → 建议：2D PNG 为主，3D 只保留 3 个

**推荐：不追加新 GLB 模型，2D PNG 边框覆盖主力场景。**

理由：
- 当前 16 种 2D PNG 边框已经覆盖了 iPhone/iPad/MacBook/iMac/Apple TV/Watch 全线产品
- 3 个 GLB 模型（iPhone 14 Pro/15 Pro Max/11 Pro Max）足够验证 3D 功能和 RTT 贴图
- 制作高质量 GLB 模型需要 3D 建模，成本高、周期长
- 3D 模型的核心价值不是"展示设备外观"，而是"在设备屏幕上贴 UI 内容"——3 个模型够验证这个能力
- 如果用户需要更多设备的 3D 视图，可以后续按需添加，不影响架构
- **结论：3D 保留 3 个 GLB，2D 保留 16 个 PNG，不追加新模型。架构上预留扩展能力**

---

### ✅ 4. 旧 Flutter 进程保留时机 → 建议：一步到位重构后直接删除

**推荐：不保留 Flutter 进程做 A/B 对比，重构完成并验证后直接删除。**

理由：
- A/B 对比的前提是两套系统并行运行，但 `PreviewPanel.tsx` 同一时刻只能渲染一套渲染层（要么 IPC 调 Flutter，要么直接渲染 React），无法真正并行对比
- 保留 Flutter 进程意味着 `main.cjs` 的 spawn/IPC/HWND 逻辑不能删，代码膨胀且维护负担重
- 一步到位重构完成后，Flutter 的 2D + 3D 功能都被完全替代 → Flutter 进程零用途 → 直接删
- **结论：重构验证通过后，清理旧代码时一次性删除 Flutter 项目 + IPC + preload**

---

### ✅ 5. 性能要求 → 建议：30fps 足够，不支持多设备同时显示

**推荐：3D 单设备 + RTT 贴图 30fps 即可，不做多设备并发。**

理由：
- SoloForge 的画布是"单设备预览"，不是"多设备展厅"。一次只看一个设备
- RTT 贴图每帧需要：React 组件渲染到 OffscreenCanvas → 转 WebGL Texture → 贴到 mesh。30fps 意味着每帧 ~33ms，React 渲染 + WebGL 上传纹理合计可控制在 15-20ms
- 60fps 对 RTT 贴图压力较大（每帧 16ms），且人眼对 UI 预览场景 30fps 完全够
- 多设备同时显示 = 多个 GLB + 多个 RTT 纹理，GPU 显存和 CPU 都会翻倍，不划算
- 如果未来需要多设备对比，可以截图当前画布 → 作为静态纹理贴到第二个模型上（不需要实时 RTT）
- **结论：单设备 30fps，RTT 贴图在 1024×1920 分辨率以内。多设备用静态截图方案**

---

### ✅ 6. DSL 格式演进 → 建议：新增 3 个节点类型到 UniversalAST

**推荐：新增 `video`、`canvas-draw` 扩展、`3d-scene` 到类型定义。**

具体方案：

| 新增节点 | DSL 格式 | 用途 |
|---|---|---|
| `video` | `{type:'video', src:'https://...', poster:'...', autoplay:true, loop:true}` | 视频播放 |
| `canvas` 扩展 | `{type:'canvas', draw:[{op:'rect',...}, {op:'circle',...}]}` | 绘图指令（扩展现有 canvas 节点） |
| `3d-scene` | `{type:'3d-scene', model:'iphone_14_pro', children:[...]}` | 3D 场景内嵌 UI（LLM 可指定设备模型 + 屏幕内容） |

理由：
- `video` 和 `canvas-draw` 必须加到 `UniversalAST.ts` 类型定义里，翻译器才能输出这些节点
- `3d-scene` 可选——如果 LLM 需要主动触发 3D 模式（而不是用户手动切 2D/3D），就需要这个节点
- 不加到 UniversalAST 的风险：LLM 输出的 JSON DSL 走 `normalizeDsl` 时，未知类型会被 `default` 分支处理，可能丢失数据
- **结论：在 `UniversalAST.ts` 的联合类型中新增 `video` 和扩展 `canvas`。`3d-scene` 作为可选节点，先加类型定义，渲染逻辑后续实现**

---

### ✅ 7. 画布浏览器选项卡 → 已确认

选项卡 = `CanvasResourceBar`，用于多画布切换（画布 1~10）。不是内嵌浏览器。重构后继续保留此组件，作为 `CanvasStage` 顶部的画布切换选项卡。
