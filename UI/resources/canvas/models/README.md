# 📱 设备模型资源

本目录存放 SoloForge 画布预览面板（PreviewPanel）中设备对应的模型资源，支持 2D（PNG 边框）和 3D（GLB 模型）两种渲染模式。

---

## 📂 目录结构

```
models/
├── README.md                   — 本文档
├── ARCHITECTURE.md             — 架构文档
├── BUILD.md                    — 构建指南
├── device-config.json          — 3D UV 屏幕区域配置
│
├── 2d/                         — 2D PNG 设备边框
│   ├── mobile/                 — 手机边框
│   │   ├── iphone_16.png
│   │   ├── iphone_16_plus.png
│   │   ├── iphone_16_pro.png
│   │   └── iphone_16_pro_max.png
│   ├── tablet/                 — 平板边框
│   │   ├── ipad_a16.png
│   │   └── ipad_a16_landscape.png
│   ├── desktop/                — 桌面显示器边框
│   │   ├── macbook_pro_m5_14.png
│   │   ├── macbook_pro_m5_16.png
│   │   ├── macbook_neo.png
│   │   ├── imac_m4.png
│   │   ├── studio_display.png
│   │   └── apple_tv_4k.png
│   └── watch/                  — 手表边框
│       ├── apple_watch_s11_42.png
│       ├── apple_watch_s11_46.png
│       ├── apple_watch_ultra_2.png
│       └── apple_watch_ultra_3.png
│
├── 3d/                         — 3D GLB 设备模型
│   ├── mobile/
│   │   └── iphone_15_pro_max.glb  ✅ 已下载
│   ├── desktop/               — 待下载
│   ├── tablet/                — 待下载
│   └── watch/                 — 待下载
│
└── hdri/                       — HDR 环境贴图
    └── studio_small_03_1k.hdr
```

---

## 🎯 2D vs 3D 资源说明

| 模式 | 文件格式 | 用途 | 渲染方式 |
|------|---------|------|---------|
| **2D** | `.png` | 设备外观边框，叠加在 DSL 渲染层上方 | `<img>` 绝对定位覆盖 |
| **3D** | `.glb` | 完整 3D 设备模型，DSL 通过 Html transform 嵌入屏幕区域 | React Three Fiber (R3F) |
| **HDR** | `.hdr` | 3D 场景环境光照 | RGBELoader → Environment |

### 2D PNG 边框要求
- 透明背景 PNG
- 设备屏幕区域应为透明（让下方 DSL 渲染层透出）
- 图片尺寸 = 设备原生像素尺寸 × 边框外扩区域
- 文件名与 `DEVICES_2D` 数组中的 `pngFile` 字段对应

### 3D GLB 模型要求

| 项目 | 要求 |
|------|------|
| **格式** | `.glb`（GLTF Binary）优先；`.gltf` 也可 |
| **多边形数** | < 100k（流畅渲染） |
| **屏幕网格** | 屏幕区域可单独命名 'screen' mesh（便于定位），或由 boundingBox 自动计算 |
| **尺寸** | 屏幕原生像素 = `device-config.json` 中的 `nativeSize` |
| **朝向** | 屏幕朝 +Z 方向（面对用户） |
| **坐标系** | Y-up（three.js 标准） |

---

## 🔍 找模型资源（按优先级）

### 1️⃣ 官方资源（优先）

| 平台 | 链接 | 说明 |
|------|------|------|
| **Apple AR Quick Look** | https://developer.apple.com/augmented-reality/quick-look/ | iPhone/iPad/MacBook 官方 USDZ，可转 GLB |
| **Khronos glTF Sample Models** | https://github.com/KhronosGroup/glTF-Sample-Models | 官方样例（验证架构用） |
| **Sketchfab CC0** | https://sketchfab.com/3d-models?features=downloadable&licenses=322a749d32a647f29c8aa0f76d43699c | 筛选 CC0 协议 |
| **Poly Haven** | https://polyhaven.com/models | 全部 CC0 |

### 2️⃣ 社区资源（备选）

| 平台 | 链接 | 备注 |
|------|------|------|
| **Sketchfab（搜索）** | https://sketchfab.com/search?q=iphone+14+pro+free | 注意 License：CC0 / CC-BY |
| **CGTrader Free** | https://www.cgtrader.com/free-3d-models | 部分免费 |
| **Free3D** | https://free3d.com/3d-models | 老牌资源站 |
| **Thangs** | https://thangs.com/ | 3D 搜索引擎 |
| **Thingiverse** | https://www.thingiverse.com/ | 偏实物 |

---

## 📥 推荐下载流程

### Apple 设备（iPhone/iPad/MacBook）
1. 访问 https://developer.apple.com/augmented-reality/quick-look/
2. 下载 `.usdz` 官方模型
3. **转换为 `.glb`**：
   ```bash
   # 使用 usd2gltf 工具
   pip install usd2gltf
   usd2gltf -i iphone_15_pro_max.usdz -o iphone_15_pro_max.glb

   # 或在线转换：https://www.duckduckgo.com/?q=usdz+to+glb
   ```

### 其他设备
1. Sketchfab 搜索 `设备名 + free` 或 `设备名 + cc0`
2. 下载 `.glb` 或 `.gltf`
3. 放入对应分类目录（`3d/{mobile,tablet,desktop,watch}/`）

---

## 🔧 UV 屏幕区域配置说明

`device-config.json` 中每个 3D 模型的 `screenUV` 字段定义了屏幕上**四个角点**的 UV 坐标：

```json
"screenUV": {
  "bl": [0.06, 0.04],  // Bottom-Left  (屏幕左下角)
  "br": [0.94, 0.04],  // Bottom-Right (屏幕右下角)
  "tr": [0.94, 0.96],  // Top-Right    (屏幕右上角)
  "tl": [0.06, 0.96]   // Top-Left     (屏幕左上角)
}
```

**含义**：UV 取值 0~1，左下角为原点 (0,0)。这四个角点对应模型纹理贴图中"应该被画布内容覆盖的区域"。

### 如何标定 UV

1. 用 **Blender** 打开模型
2. 切换到 UV Editing 工作区
3. 选中"屏幕"那个 Mesh
4. 在 UV 网格中找到"屏幕"对应的方块
5. 读取方块的 4 个角点坐标，填入 `device-config.json`

### 如果模型作者没分离"屏幕"网格

- 在 Blender 手动给"屏幕"区域做 UV（可以加一个小 Plane 在屏幕位置）
- 或用纹理遮罩（Mask）做屏幕区域识别

---

## 📐 2D PNG 边框制作说明

2D 边框为透明背景 PNG，叠加在 DSL 渲染层上方：

1. 截取设备正面高清图
2. 用图像编辑工具（Photoshop / GIMP）扣除屏幕区域（设为透明）
3. 保留设备外框（边框、刘海、圆角等）
4. 导出为 PNG，文件名与 `DEVICES_2D` 中 `pngFile` 字段一致
5. 放入 `2d/{group}/` 目录

---

## ⚙️ 当前状态

| 资源类型 | 已有 | 待补充 |
|---------|------|--------|
| 2D PNG 边框 | 6 个（覆盖 mobile/tablet/desktop/watch） | 更多设备型号 |
| 3D GLB 模型 | 1 个（`iphone_15_pro_max.glb`） | desktop/tablet/watch 全部 |
| HDR 环境贴图 | 1 个（`studio_small_03_1k.hdr`） | 可选更多场景 |
| UV 配置 | `device-config.json` 已写 | 新模型需标定 |

---

## 📚 参考资料

- three.js glTF Loader: https://threejs.org/docs/#examples/en/loaders/GLTFLoader
- React Three Fiber: https://docs.pmnd.rs/react-three-fiber
- @react-three/drei useGLTF: https://drei.docs.pmnd.rs/loaders/useGLTF
- Blender UV 编辑: https://docs.blender.org/manual/en/latest/editors/uv/index.html
