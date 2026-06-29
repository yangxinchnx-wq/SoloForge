# 📱 3D 设备模型资源

本目录存�?SoloForge 画布预览面板（PreviewPanel）中 22 个设备尺寸对应的 3D 设备模型�?
---

## 📂 目录结构

```
models/
├── README.md                   �?本文�?├── device-config.json          �?UV 屏幕区域配置（必需�?├── mobile/                     �?手机模型�? 个）
�?  ├── iphone_14_pro.glb       (待下�?
�?  ├── iphone_14.glb           (待下�?
�?  ├── iphone_14_pro_max.glb   (待下�?
�?  ├── iphone_se.glb           (待下�?
�?  ├── galaxy_s23.glb          (待下�?
�?  ├── pixel_7.glb             (待下�?
�?  └── xiaomi_13.glb           (待下�?
├── tablet/                     �?平板模型�? 个）
�?  ├── ipad_pro_129.glb        (待下�?
�?  ├── ipad_air.glb            (待下�?
�?  ├── ipad_mini.glb           (待下�?
�?  ├── surface_pro.glb         (待下�?
�?  └── galaxy_tab_s8.glb       (待下�?
├── desktop/                    �?桌面显示器模型（6 个）
�?  ├── full_hd_monitor.glb     (待下�?
�?  ├── macbook.glb             (待下�?
�?  ├── standard_laptop.glb     (待下�?
�?  ├── hd_monitor.glb          (待下�?
�?  ├── xga_monitor.glb         (待下�?
�?  └── 2k_monitor.glb          (待下�?
└── watch/                      �?手表模型�? 个）
    ├── apple_watch_41mm.glb    (待下�?
    ├── apple_watch_45mm.glb    (待下�?
    ├── apple_watch_ultra_49mm.glb (待下�?
    └── galaxy_watch_6.glb      (待下�?
```

---

## 🎯 模型要求

| 项目 | 要求 |
|------|------|
| **格式** | `.glb`（GLTF Binary，二进制）优先；`.gltf` 也可 |
| **多边形数** | < 100k（流畅渲染） |
| **贴图** | 屏幕区域需要单独的 UV 映射（不是必备，但要可控�?|
| **尺寸** | 屏幕原生像素 = `device-config.json` 中的 `nativeSize` |
| **朝向** | 屏幕�?+Z 方向（即面对用户�?|
| **坐标�?* | Y-up（three.js 标准�?|

---

## 🔍 找模型资源（按优先级�?
### 1️⃣ 官方资源（优先）

| 平台 | 链接 | 说明 |
|------|------|------|
| **Apple AR Quick Look** | https://developer.apple.com/augmented-reality/quick-look/ | iPhone/iPad/MacBook 官方 USDZ，可�?GLB |
| **Khronos glTF Sample Models** | https://github.com/KhronosGroup/glTF-Sample-Models | 官方样例（验证架构用�?|
| **Sketchfab CC0** | https://sketchfab.com/3d-models?features=downloadable&licenses=322a749d32a647f29c8aa0f76d43699c | 筛�?CC0 协议 |
| **Poly Haven** | https://polyhaven.com/models | �?CC0 |

### 2️⃣ 社区资源（备选）

| 平台 | 链接 | 备注 |
|------|------|------|
| **Sketchfab（搜索）** | https://sketchfab.com/search?q=iphone+14+pro+free | 注意 License：CC0 / CC-BY |
| **CGTrader Free** | https://www.cgtrader.com/free-3d-models | 部分免费 |
| **Free3D** | https://free3d.com/3d-models | 老牌资源�?|
| **Thangs** | https://thangs.com/ | 3D 搜索引擎 |
| **Thingiverse** | https://www.thingiverse.com/ | 偏实�?|

---

## 📥 推荐下载流程

### Apple 设备（iPhone/iPad/MacBook�?
1. 访问 https://developer.apple.com/augmented-reality/quick-look/
2. 下载 `.usdz` 官方模型
3. **转换�?`.glb`**�?   ```bash
   # 使用 usd2gltf 工具
   pip install usd2gltf
   usd2gltf -i iphone_14_pro.usdz -o iphone_14_pro.glb
   
   # 或在线转换：https://www.duckduckgo.com/?q=usdz+to+glb
   ```

### 其他设备

1. Sketchfab 搜索 `设备�?+ free` �?`设备�?+ cc0`
2. 下载 `.glb` �?`.gltf`
3. 放入对应分类目录

---

## 🔧 UV 屏幕区域配置说明

`device-config.json` 中每个模型的 `screenUV` 字段定义了屏幕上**四个角点**�?UV 坐标�?
```json
"screenUV": {
  "bl": [0.06, 0.04],  // Bottom-Left  (屏幕左下�?
  "br": [0.94, 0.04],  // Bottom-Right (屏幕右下�?
  "tr": [0.94, 0.96],  // Top-Right    (屏幕右上�?
  "tl": [0.06, 0.96]   // Top-Left     (屏幕左上�?
}
```

**含义**：UV 取�?0~1，左下角为原�?(0,0)。这四个角点对应模型纹理贴图�?应该被画布内容覆盖的区域"�?
### 如何标定 UV

1. �?**Blender** 打开模型
2. 切换�?UV Editing 工作�?3. 选中"屏幕"那个 Mesh
4. �?UV 网格�?屏幕"对应的方�?5. 读取方块�?4 个角点坐标，填入 `device-config.json`

### 如果模型作者没分离"屏幕"网格

- �?Blender 手动�?屏幕"区域�?UV（可以加一个小 Plane 在屏幕位置）
- 或用纹理遮罩（Mask）做屏幕区域识别

---

## ⚙️ 当前状态（开发中�?
| 状�?| 设备�?|
|------|--------|
| �?文件夹已创建 | 22/22 |
| �?UV 配置已写 | 22/22 |
| �?模型待下�?| 22/22 |
| �?UV 待标�?| 22/22 |

---

## 🚧 临时占位机制

如果某个模型文件不存在，Flutter 端会�?1. 自动 fallback 到一�?*程序化生成的占位模型**（纯�?BoxGeometry�?2. 屏幕区域显示 "⚠️ 模型未加�? 模型�?
3. 用户仍可在占位模型上交互（移�?旋转/删除�?
---

## 📚 参考资�?
- three.js glTF Loader: https://threejs.org/docs/#examples/en/loaders/GLTFLoader
- three_d (Dart): https://pub.dev/packages/three_d
- Blender UV 编辑: https://docs.blender.org/manual/en/latest/editors/uv/index.html
---

## s1.7 ״̬ (2026-06-23)

- **ռλ��Ⱦ**: ���� main.dart ����, �� group (desktop/mobile/tablet/watch) ������״ + ��ɫ
- **GLB ʵ���ļ�**: 1/22 (�� mobile/iphone_14_pro.glb, �� Khronos Duck ռλ)
- **ȱʧ**: 6 desktop + 6 mobile + 5 tablet + 4 watch
- **RTT ����Ⱦ**: �� s2.1 ������ʵ three_d �����չʾ GLB
