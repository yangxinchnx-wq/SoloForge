/**
 * ScreenMesh.tsx — 3D 模型屏幕区域定位工具
 *
 * ★ 2026-07-19: 从 RTT 组件重构为纯工具函数模块
 *   旧版包含 <ScreenMesh> 默认导出组件 (用 RenderTexture + DslToR3f)，
 *   新版用 drei <Html transform> + WebAstPreview 替代，此文件只保留定位算法。
 *
 * 用途：在 GLB 模型的 scene 中计算屏幕区域的位置/朝向/尺寸，
 *       供 CanvasStage3D 的 <ScreenOverlay> 组件使用。
 *
 * 算法：
 *   1. 优先查找名为 'screen' 的 mesh（如果 GLB 有命名）
 *   2. 找不到则用自动定位算法：算 boundingBox → 找最薄维度（厚度方向）→ 在正面放置
 *   3. 屏占比按 iPhone 实测值：宽度 86%，高度 87%
 */

import * as THREE from 'three';

// ───────────────────────────── 常量 ─────────────────────────────

// iPhone 实测屏占比（屏幕区域 / 手机外框）
const SCREEN_WIDTH_RATIO = 0.86;   // 屏幕宽度占手机宽度 86%
const SCREEN_HEIGHT_RATIO = 0.87;  // 屏幕高度占手机高度 87%
const SCREEN_Z_OFFSET = 0.01;      // 屏幕内容相对手机正面的 z 偏移（避免 z-fighting）

// ───────────────────────────── 类型 ─────────────────────────────

export interface ScreenInfo {
  /** 屏幕内容的位置（相对于 scene 根，3D 空间单位） */
  position: [number, number, number];
  /** 屏幕内容的四元数（控制朝向） */
  quaternion: [number, number, number, number];
  /** 屏幕区域的宽高（3D 空间单位） */
  size: [number, number];
}

// ───────────────────────────── 辅助函数 ─────────────────────────────

/** 在 scene 中查找名为 'screen' 的 mesh（深度优先，大小写不敏感） */
export function findScreenMesh(scene: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  scene.traverse((obj) => {
    if (!found && (obj as THREE.Mesh).isMesh && obj.name.toLowerCase() === 'screen') {
      found = obj as THREE.Mesh;
    }
  });
  return found;
}

/** 计算 mesh 的位置 / 四元数 / boundingBox 尺寸 */
export function computeMeshInfo(mesh: THREE.Mesh): ScreenInfo | null {
  const geometry = mesh.geometry;
  if (!geometry) return null;

  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  if (!bbox) return null;

  const size = new THREE.Vector3();
  bbox.getSize(size);

  const worldPos = new THREE.Vector3();
  const worldQuat = new THREE.Quaternion();
  mesh.getWorldPosition(worldPos);
  mesh.getWorldQuaternion(worldQuat);

  return {
    position: [worldPos.x, worldPos.y, worldPos.z],
    quaternion: [worldQuat.x, worldQuat.y, worldQuat.z, worldQuat.w],
    size: [size.x, size.y],
  };
}

/**
 * ★ 自动屏幕定位算法 —— 无需 Blender 修模
 *
 * 原理：手机模型的 boundingBox 是长方体，最薄的维度是厚度方向（z 或 y）。
 *   - 找到最薄维度 → 那是手机的厚度方向
 *   - 另外两个维度 → 屏幕的宽和高
 *   - 屏幕内容放在 boundingBox 的正面（最薄维度的 max 面）
 *
 * 示例：
 *   - 如果 size = (0.8, 1.7, 0.3)，最薄是 z → 屏幕朝 z 方向，内容在 z=max
 *   - 如果 size = (0.8, 0.3, 1.7)，最薄是 y → 屏幕朝 y 方向（横置），内容在 y=max
 */
export function computeAutoScreenPosition(scene: THREE.Object3D): ScreenInfo | null {
  const box = new THREE.Box3().setFromObject(scene);
  if (box.isEmpty()) return null;

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  // 找到最薄的维度（手机厚度方向）
  const dims: Array<{ axis: 'x' | 'y' | 'z'; value: number }> = [
    { axis: 'x', value: size.x },
    { axis: 'y', value: size.y },
    { axis: 'z', value: size.z },
  ];
  dims.sort((a, b) => a.value - b.value);
  const thicknessAxis = dims[0].axis;  // 最薄维度
  const widthAxis = dims[1].axis;       // 第二薄维度 = 屏幕宽
  const heightAxis = dims[2].axis;      // 最厚维度 = 屏幕高

  const fullWidth = size[widthAxis];
  const fullHeight = size[heightAxis];

  // 屏幕尺寸（按屏占比缩放）
  const screenW = fullWidth * SCREEN_WIDTH_RATIO;
  const screenH = fullHeight * SCREEN_HEIGHT_RATIO;

  // 屏幕内容位置：在 boundingBox 正面（最薄维度的 max 面）+ 微小偏移
  const position: [number, number, number] = [center.x, center.y, center.z];
  position[thicknessAxis === 'x' ? 0 : thicknessAxis === 'y' ? 1 : 2] +=
    size[thicknessAxis] / 2 + SCREEN_Z_OFFSET;

  // 四元数：根据厚度轴决定平面朝向
  // 默认平面朝 +Z，如果厚度轴是 Z 就不需要旋转
  // 如果厚度轴是 Y（横置手机），需要绕 X 轴旋转 90°
  // 如果厚度轴是 X，需要绕 Y 轴旋转 90°
  let quaternion: [number, number, number, number] = [0, 0, 0, 1]; // identity
  if (thicknessAxis === 'y') {
    // 绕 X 轴旋转 -90°，让平面朝 +Y
    quaternion = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  } else if (thicknessAxis === 'x') {
    // 绕 Y 轴旋转 90°，让平面朝 +X
    quaternion = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  }

  // 如果宽高轴不是 (x, y)，需要调整平面尺寸顺序
  let planeSize: [number, number] = [screenW, screenH];
  if (widthAxis === 'z' && heightAxis === 'y') {
    // 屏幕宽沿 Z 轴，高沿 Y 轴 → 绕 Y 轴旋转 90°
    quaternion = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    planeSize = [screenW, screenH];
  } else if (widthAxis === 'x' && heightAxis === 'z') {
    // 屏幕宽沿 X 轴，高沿 Z 轴 → 绕 X 轴旋转 90°
    quaternion = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
    planeSize = [screenW, screenH];
  }

  return {
    position,
    quaternion,
    size: planeSize,
  };
}
