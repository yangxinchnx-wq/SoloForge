/**
 * ScreenMesh.tsx — 3D 模型屏幕区域定位工具
 *
 * 用途：在 GLB 模型的 scene 中计算屏幕区域的位置/朝向/尺寸，
 *       供 CanvasStage3D 的 <ScreenOverlay> 组件使用。
 *
 * ★ 2026-07-20 修复"完美贴合"三个 bug:
 *   1. findScreenMesh 用宽泛匹配 (和 processMeshesInitial 一致)
 *   2. computeMeshInfo 用 world space boundingBox (考虑 parent scale)
 *   3. computeAutoScreenPosition 排除背面摄像头凸起 mesh
 */

import * as THREE from 'three';

// ───────────────────────────── 常量 ─────────────────────────────

// iPhone 实测屏占比（屏幕区域 / 手机外框）
const SCREEN_WIDTH_RATIO = 0.86;   // 屏幕宽度占手机宽度 86%
const SCREEN_HEIGHT_RATIO = 0.87;  // 屏幕高度占手机高度 87%
const SCREEN_Z_OFFSET = 0.01;      // 屏幕内容相对手机正面的 z 偏移（避免 z-fighting）

// ───────────────────────────── 类型 ─────────────────────────────

export interface ScreenInfo {
  /** 屏幕内容的位置（世界空间，3D 单位） */
  position: [number, number, number];
  /** 屏幕内容的四元数（控制朝向） */
  quaternion: [number, number, number, number];
  /** 屏幕区域的宽高（世界空间，3D 单位） */
  size: [number, number];
}

// ───────────────────────────── 辅助函数 ─────────────────────────────

/**
 * ★ 2026-07-20: 宽泛匹配屏幕 mesh（和 processMeshesInitial 逻辑一致）
 *
 * 匹配规则：mesh 名字包含 screen / display / glass_front / 面板 之一
 * 之前只匹配 name === 'screen'，导致名为 'glass_front' 等的屏幕 mesh 被遗漏
 */
export function findScreenMesh(scene: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  scene.traverse((obj) => {
    if (found) return;
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const name = (mesh.name || '').toLowerCase();
    if (
      name.includes('screen') ||
      name.includes('display') ||
      name.includes('glass_front') ||
      name.includes('面板')
    ) {
      found = mesh;
    }
  });
  return found;
}

/**
 * ★ 2026-07-20: 用 world space boundingBox 计算 mesh 信息
 *
 * 旧版用 geometry.boundingBox (local space)，不考虑 parent scale，
 * 导致 AdaptiveModel 中 group.scale.setScalar(scaleFactor) 后尺寸不对。
 *
 * 新版用 Box3.setFromObject(mesh)，它会遍历 mesh 的所有子对象并应用 world matrix，
 * 返回世界空间的精确 boundingBox。
 */
export function computeMeshInfo(mesh: THREE.Mesh): ScreenInfo | null {
  // ★ 用 world space boundingBox（考虑所有 parent transform）
  const worldBox = new THREE.Box3().setFromObject(mesh);
  if (worldBox.isEmpty()) return null;

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  worldBox.getSize(size);
  worldBox.getCenter(center);

  // 世界空间四元数（屏幕的朝向）
  const worldQuat = new THREE.Quaternion();
  mesh.getWorldQuaternion(worldQuat);

  // ★ 如果 mesh 有旋转，boundingBox 的 size 是 AABB（轴对齐包围盒），
  //   不是 OBB（有向包围盒）。对于屏幕 mesh（通常平行于 XY 平面），AABB ≈ OBB。
  //   但如果屏幕 mesh 有旋转，需要用 geometry 的 local size 配合 world quaternion。
  //   大多数 GLB 模型的屏幕 mesh 没有旋转，直接用 AABB 即可。
  return {
    position: [center.x, center.y, center.z],
    quaternion: [worldQuat.x, worldQuat.y, worldQuat.z, worldQuat.w],
    size: [size.x, size.y],
  };
}

/**
 * ★ 2026-07-20: 改进自动屏幕定位算法 —— 排除背面摄像头凸起
 *
 * 旧版用整个 scene 的 boundingBox，包含背面摄像头凸起 →
 *   - boundingBox 中心偏移（摄像头凸起把中心拉向背面）
 *   - 厚度轴尺寸偏大（凸起增加了厚度）
 *   - 宽高轴尺寸可能偏大（摄像头模组宽于机身）
 *
 * 新版算法：
 *   1. 先用整体 boundingBox 确定厚度轴
 *   2. 遍历所有 mesh，只保留正面半边的 mesh（排除背面摄像头）
 *   3. 用正面 mesh 的并集 boundingBox 计算屏幕区域
 */
export function computeAutoScreenPosition(scene: THREE.Object3D): ScreenInfo | null {
  // ── 第 1 步：用整体 boundingBox 确定厚度轴 ──
  const fullBox = new THREE.Box3().setFromObject(scene);
  if (fullBox.isEmpty()) return null;

  const fullSize = new THREE.Vector3();
  const fullCenter = new THREE.Vector3();
  fullBox.getSize(fullSize);
  fullBox.getCenter(fullCenter);

  // 找到最薄的维度（手机厚度方向）
  const dims: Array<{ axis: 'x' | 'y' | 'z'; value: number }> = [
    { axis: 'x', value: fullSize.x },
    { axis: 'y', value: fullSize.y },
    { axis: 'z', value: fullSize.z },
  ];
  dims.sort((a, b) => a.value - b.value);
  const thicknessAxis = dims[0].axis;  // 最薄维度
  const widthAxis = dims[1].axis;       // 第二薄维度 = 屏幕宽
  const heightAxis = dims[2].axis;      // 最厚维度 = 屏幕高

  // ── 第 2 步：收集正面半边的 mesh（排除背面摄像头凸起） ──
  //   正面 = 厚度轴中心点偏向 max 面的那一半
  const axisIndex = thicknessAxis === 'x' ? 0 : thicknessAxis === 'y' ? 1 : 2;
  const frontMeshes: THREE.Object3D[] = [];

  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;

    // 计算每个 mesh 的世界空间 boundingBox
    const meshBox = new THREE.Box3().setFromObject(mesh);
    if (meshBox.isEmpty()) return;

    const meshCenter = new THREE.Vector3();
    meshBox.getCenter(meshCenter);

    // ★ 只保留中心点在正面半边的 mesh
    //   frontCenter = 整体中心 + 半个厚度（偏向 max 面）
    //   mesh 中心 > frontCenter → 正面 mesh
    //   但用整体中心作为分界线更简单可靠（摄像头凸起通常在背面一半）
    const meshAxisValue = meshCenter.getComponent(axisIndex);
    const sceneCenterValue = fullCenter.getComponent(axisIndex);

    // 正面 mesh：中心点在整体中心点的 max 侧
    if (meshAxisValue >= sceneCenterValue) {
      frontMeshes.push(mesh);
    }
  });

  // ── 第 3 步：用正面 mesh 的并集 boundingBox 计算屏幕区域 ──
  let frontBox: THREE.Box3;
  if (frontMeshes.length > 0) {
    // 用正面 mesh 的并集 boundingBox
    frontBox = new THREE.Box3();
    frontMeshes.forEach((mesh) => {
      const mb = new THREE.Box3().setFromObject(mesh);
      frontBox.union(mb);
    });
  } else {
    // 降级：如果没有正面 mesh（异常情况），用整体 boundingBox
    frontBox = fullBox;
  }

  const frontSize = new THREE.Vector3();
  const frontCenter = new THREE.Vector3();
  frontBox.getSize(frontSize);
  frontBox.getCenter(frontCenter);

  // 屏幕尺寸（按屏占比缩放）
  const fullWidth = frontSize[widthAxis];
  const fullHeight = frontSize[heightAxis];
  const screenW = fullWidth * SCREEN_WIDTH_RATIO;
  const screenH = fullHeight * SCREEN_HEIGHT_RATIO;

  // 屏幕内容位置：在正面 boundingBox 的 max 面 + 微小偏移
  // ★ 用 frontCenter 而不是 fullCenter（排除背面凸起后的中心）
  const position: [number, number, number] = [frontCenter.x, frontCenter.y, frontCenter.z];
  position[axisIndex] += frontSize[thicknessAxis] / 2 + SCREEN_Z_OFFSET;

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

  // 如果宽高轴不是 (x, y)，需要调整平面朝向
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
