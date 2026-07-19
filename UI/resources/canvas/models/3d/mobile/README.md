# 📱 Mobile 设备模型（手机）

本目录存放手机设备的 3D GLB 模型文件，用于 3D 渲染模式下的 R3F 场景渲染。

---

## ✅ 已有模型

| 模型文件 | 设备 | 来源 | 状态 |
|---------|------|------|------|
| `iphone_15_pro_max.glb` | iPhone 15 Pro Max | — | ✅ 已下载 |

---

## ⏳ 待下载模型清单

| 模型文件 | 设备 | 推荐来源 |
|---------|------|---------|
| `iphone_16_pro_max.glb` | iPhone 16 Pro Max | Apple AR Quick Look（官方） |
| `iphone_16_pro.glb` | iPhone 16 Pro | Apple AR Quick Look |
| `iphone_16.glb` | iPhone 16 | Apple AR Quick Look |
| `galaxy_s23.glb` | Galaxy S23 | Sketchfab CC0 |
| `pixel_7.glb` | Pixel 7 | Sketchfab CC0 |
| `xiaomi_13.glb` | Xiaomi 13 | Sketchfab CC0 |

> **注意**: 下载新模型后，需在 `PreviewPanel.tsx` 的 `DEVICES_3D` 数组中注册对应条目才能在 UI 中选择。

---

## 📥 推荐下载方式

### Apple 设备（官方 USDZ → GLB）

1. **iPhone 15 Pro Max**: https://developer.apple.com/augmented-reality/quick-look/
   - 找到对应设备下载 `.usdz`
2. 转换为 `.glb`:
   ```bash
   pip install usd2gltf
   usd2gltf -i iphone_15_pro_max.usdz -o iphone_15_pro_max.glb
   ```

### Android 设备（社区资源）

- Sketchfab 搜索 `设备名 free` 或 `设备名 cc0`
- 下载 `.glb` 格式
- 放入本目录，文件名与 `DEVICES_3D` 中 `glbFile` 字段对应

---

## 🔧 UV 标定

下载模型后，需要在 Blender 中：
1. 给"屏幕区域"做 UV 映射
2. 更新 `../device-config.json` 中对应 key 的 `screenUV` 字段
3. 测试 RTT 贴图效果（3D 模式下 DSL 内容应正确映射到屏幕区域）
