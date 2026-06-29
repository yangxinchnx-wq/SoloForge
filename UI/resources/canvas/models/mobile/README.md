# 📱 Mobile 设备模型（手机）

本目录存放 7 个手机设备模型。

---

## ⏳ 待下载模型清单

| 模型文件 | 设备 | 推荐来源 | 状态 |
|---------|------|---------|------|
| `iphone_14_pro.glb` | iPhone 14 Pro | Apple AR Quick Look（官方） | ✅ 临时占位（Duck.glb） |
| `iphone_14.glb` | iPhone 14 | Apple AR Quick Look | ⏳ 待下载 |
| `iphone_14_pro_max.glb` | iPhone 14 Pro Max | Apple AR Quick Look | ⏳ 待下载 |
| `iphone_se.glb` | iPhone SE | Apple AR Quick Look | ⏳ 待下载 |
| `galaxy_s23.glb` | Galaxy S23 | Sketchfab CC0 | ⏳ 待下载 |
| `pixel_7.glb` | Pixel 7 | Sketchfab CC0 | ⏳ 待下载 |
| `xiaomi_13.glb` | Xiaomi 13 | Sketchfab CC0 | ⏳ 待下载 |

---

## 📥 推荐下载方式

### Apple 设备（官方 USDZ → GLB）

1. **iPhone 14 Pro**: https://developer.apple.com/augmented-reality/quick-look/
   - 找到 "iPhone 14 Pro" 下载 `.usdz`
2. 转换为 `.glb`:
   ```bash
   pip install usd2gltf
   usd2gltf -i iphone_14_pro.usdz -o iphone_14_pro.glb
   ```

### Android 设备（社区资源）

- Sketchfab 搜索 `设备名 free` 或 `设备名 cc0`
- 下载 `.glb` 格式
- 放入对应文件名

---

## ⚙️ 占位说明

当前 `iphone_14_pro.glb` 是 **Khronos 官方 Duck 模型**（117KB），用作架构验证。
**正式上线前必须替换为真实 iPhone 模型**。

---

## 🔧 UV 标定

下载模型后，需要在 Blender 中：
1. 给"屏幕区域"做 UV 映射
2. 更新 `../device-config.json` 中对应 key 的 `screenUV` 字段
3. 测试 RTT 贴图效果