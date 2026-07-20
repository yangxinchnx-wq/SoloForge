/**
 * ScreenMesh.ts — 3D 模型屏幕区域定位工具
 *
 * ★ 2026-07-20 修复"红色正方形在右侧" bug:
 *
 *   根因: GLB 模型中 "screen" 节点的 mesh 有 3 个 primitives。
 *   three.js GLTFLoader 遇到多 primitive 时创建 Group (名为 "screen") + 子 Mesh (名为 "Cube.004")。
 *   Group 持有 transform (rotation/translation/scale), 子 Mesh 的 local matrix 是 identity。
 *
 *   旧版 findScreenMesh 检查 mesh.isMesh → 跳过 Group, 子 Mesh 名为 "Cube.004" → 找不到屏幕
 *   旧版 computeLocalBoundingBox 用 mesh.matrix (local=identity) → bbox 没有变换 → 坐标错误
 *
 *   修复:
 *   1. findScreenMesh 也检查 parent.name (Group 名为 "screen")
 *   2. 新增 getMatrixFromSceneRoot: 沿 parent chain 累乘 matrix, 得到 mesh → scene 的完整变换
 *   3. computeMeshInfo + computeLocalBoundingBox 用 scene root matrix 而非 mesh.matrix
 */

import * as THREE from 'three';

// ───────────────────────────── 常量 ─────────────────────────────

const SCREEN_WIDTH_RATIO = 0.86;
const SCREEN_HEIGHT_RATIO = 0.87;
const SCREEN_Z_OFFSET = 0.0001;

// ───────────────────────────── 类型 ─────────────────────────────

export interface ScreenInfo {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  size: [number, number];
  /** ★ 屏幕区域的完整 bbox (scene local space), 用于计算灵动岛在纹理上的位置 */
  screenBox?: THREE.Box3;
  /** ★ 屏幕的宽轴和高轴 */
  widthAxis?: 'x' | 'y' | 'z';
  heightAxis?: 'x' | 'y' | 'z';
}

// ───────────────────────────── 核心工具函数 ─────────────────────────────

/**
 * ★ 计算 mesh 相对于 scene root 的变换矩阵
 *
 * 沿 parent chain 从 mesh 向上走到 scene root, 累乘每个节点的 local matrix。
 * 这样即使 mesh 是 Group 的子节点 (local matrix = identity),
 * 也能得到包含 Group transform 的完整变换。
 */
function getMatrixFromSceneRoot(obj: THREE.Object3D, sceneRoot: THREE.Object3D): THREE.Matrix4 {
  const result = new THREE.Matrix4();
  let current: THREE.Object3D | null = obj;
  while (current && current !== sceneRoot) {
    current.updateMatrix();
    result.premultiply(current.matrix);
    current = current.parent;
  }
  return result;
}

/**
 * 从 bbox 尺寸推断屏幕朝向
 *
 * planeGeometry 默认朝 +Z (法线 = (0,0,1))
 * 根据最薄的轴决定旋转:
 *   - 薄轴 = Z → 不旋转 (plane 朝 +Z)
 *   - 薄轴 = Y → 绕 X 轴旋转 -90° (plane 朝 +Y)
 *   - 薄轴 = X → 绕 Y 轴旋转 +90° (plane 朝 +X)
 */
function orientationFromSize(size: THREE.Vector3): {
  quaternion: [number, number, number, number];
  widthAxis: 'x' | 'y' | 'z';
  heightAxis: 'x' | 'y' | 'z';
  thinAxisIndex: number;
} {
  const dims: Array<{ axis: 'x' | 'y' | 'z'; value: number; index: number }> = [
    { axis: 'x', value: size.x, index: 0 },
    { axis: 'y', value: size.y, index: 1 },
    { axis: 'z', value: size.z, index: 2 },
  ];
  dims.sort((a, b) => a.value - b.value);

  const thinAxis = dims[0].axis;
  const widthAxis = dims[1].axis;
  const heightAxis = dims[2].axis;
  const thinAxisIndex = dims[0].index;

  let quaternion: [number, number, number, number] = [0, 0, 0, 1];
  if (thinAxis === 'y') {
    quaternion = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  } else if (thinAxis === 'x') {
    quaternion = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  }

  return { quaternion, widthAxis, heightAxis, thinAxisIndex };
}

// ───────────────────────────── 查找屏幕 mesh ─────────────────────────────

const SCREEN_NAME_KEYWORDS = ['screen', 'display', 'glass_front', '面板'];

/** 检查名字是否匹配屏幕关键词 */
function isScreenName(name: string): boolean {
  const lower = name.toLowerCase();
  return SCREEN_NAME_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * ★ 查找屏幕 mesh
 *
 * 多 primitive 时 GLTFLoader 创建 Group (名为 node name) + 子 Mesh (名为 mesh name)
 * 所以需要同时检查 mesh.name 和 mesh.parent?.name
 */
export function findScreenMesh(scene: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  scene.traverse((obj) => {
    if (found) return;
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;

    // 检查 mesh 自身名字
    if (isScreenName(mesh.name || '')) {
      found = mesh;
      return;
    }
    // ★ 检查 parent 名字 (Group 名为 "screen", 子 Mesh 名为 "Cube.004")
    if (mesh.parent && isScreenName(mesh.parent.name || '')) {
      found = mesh;
      return;
    }
  });
  return found;
}

/**
 * ★ 计算灵动岛在屏幕纹理上的挖孔区域
 *
 * 灵动岛在所有 iPhone 15+ 机型上的位置是固定的:
 *   - 水平居中于屏幕
 *   - 靠近屏幕顶部 (距顶部约 11px / 932px ≈ 1.2%)
 *   - 尺寸: 宽约 125/430 ≈ 29% 屏幕宽度, 高约 37/932 ≈ 4% 屏幕高度
 *
 * 旧方案用 island mesh 的包围盒做挖孔, 但模型中 island mesh 是整个前玻璃面板
 * (36×36mm), 不是灵动岛本身 → 挖孔过大且位置偏移
 *
 * 新方案: 直接从屏幕包围盒 + 固定比例计算, 不依赖 island mesh
 */
export function computeNotchRect(
  screenBox: THREE.Box3,
  widthAxis: 'x' | 'y' | 'z',
  heightAxis: 'x' | 'y' | 'z',
  texWidth: number,
  texHeight: number,
): { x: number; y: number; width: number; height: number; radius: number } | null {
  if (screenBox.isEmpty()) return null;

  const screenSize = new THREE.Vector3();
  screenBox.getSize(screenSize);

  const screenW = screenSize[widthAxis];
  const screenH = screenSize[heightAxis];
  if (screenW <= 0 || screenH <= 0) return null;

  // 灵动岛固定比例 (基于 iPhone 15 Pro Max 真机尺寸 430×932)
  const NOTCH_W_RATIO = 125 / 430; // ≈ 0.2907
  const NOTCH_H_RATIO = 37 / 932;  // ≈ 0.0397
  const NOTCH_TOP_MARGIN_RATIO = 11 / 932; // ≈ 0.0118 (距屏幕顶部 11px)

  const texW = NOTCH_W_RATIO * texWidth;
  const texH = NOTCH_H_RATIO * texHeight;

  // X: 屏幕水平居中
  const texX = (texWidth - texW) / 2;

  // Y: 距屏幕顶部固定比例 (3D Y 朝上, Canvas Y 朝下, 已在比例中隐含翻转)
  const texY = NOTCH_TOP_MARGIN_RATIO * texHeight;

  return {
    x: texX,
    y: texY,
    width: texW,
    height: texH,
    radius: texH / 2, // 灵动岛是药丸形, 圆角半径 = 高度/2
  };
}

/**
 * 计算指定 screen mesh 的屏幕信息
 *
 * ★ 如果 mesh 的 parent 是 screen Group (多 primitive), 收集 Group 下所有子 Mesh 的并集 bbox
 *   这样尺寸更准确, 不会只取一个 primitive 的局部 bbox
 *
 * 1. 收集所有需要计算 bbox 的 mesh (Group 下所有子 Mesh, 或单个 Mesh)
 * 2. 用 getMatrixFromSceneRoot 获取每个 mesh → scene 的完整变换
 * 3. 计算所有 mesh 的 transformed bbox 的并集
 * 4. 从并集 bbox 尺寸推断朝向, 把 plane 放在正面
 */
export function computeMeshInfo(mesh: THREE.Mesh, sceneRoot: THREE.Object3D): ScreenInfo | null {
  // ★ 如果 parent 是 screen Group, 收集所有子 Mesh 的并集 bbox
  const parentGroup = mesh.parent;
  const isParentScreenGroup = parentGroup && isScreenName(parentGroup.name || '');

  const meshesToUnion: THREE.Mesh[] = [];
  if (isParentScreenGroup) {
    // 多 primitive: 收集 Group 下所有子 Mesh
    parentGroup!.children.forEach((child) => {
      if ((child as THREE.Mesh).isMesh && (child as THREE.Mesh).geometry) {
        meshesToUnion.push(child as THREE.Mesh);
      }
    });
  }
  if (meshesToUnion.length === 0) {
    // 单 primitive: 只用传入的 mesh
    if (mesh.geometry) meshesToUnion.push(mesh);
  }

  if (meshesToUnion.length === 0) return null;

  // 计算所有 mesh 的并集 bbox
  const unionBox = new THREE.Box3();
  for (const m of meshesToUnion) {
    if (!m.geometry!.boundingBox) m.geometry!.computeBoundingBox();
    const fullMatrix = getMatrixFromSceneRoot(m, sceneRoot);
    const bbox = m.geometry!.boundingBox!.clone();
    bbox.applyMatrix4(fullMatrix);
    unionBox.union(bbox);
  }

  if (unionBox.isEmpty()) return null;

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  unionBox.getSize(size);
  unionBox.getCenter(center);

  const { quaternion, widthAxis, heightAxis, thinAxisIndex } = orientationFromSize(size);

  const screenW = size[widthAxis];
  const screenH = size[heightAxis];

  // 位置: bbox 中心 + 沿薄轴正向偏移到正面
  const position: [number, number, number] = [center.x, center.y, center.z];
  position[thinAxisIndex] += size.getComponent(thinAxisIndex) / 2 + SCREEN_Z_OFFSET;

  return {
    position,
    quaternion,
    size: [screenW, screenH],
    screenBox: unionBox.clone(),
    widthAxis,
    heightAxis,
  };
}

/**
 * 自动计算屏幕位置 (找不到 screen mesh 时的兜底方案)
 */
export function computeAutoScreenPosition(scene: THREE.Object3D): ScreenInfo | null {
  // ── 第 1 步：用 local boundingBox 确定厚度轴 ──
  const fullBox = computeLocalBoundingBox(scene);
  if (fullBox.isEmpty()) return null;

  const fullSize = new THREE.Vector3();
  const fullCenter = new THREE.Vector3();
  fullBox.getSize(fullSize);
  fullBox.getCenter(fullCenter);

  const { quaternion, widthAxis, heightAxis, thinAxisIndex } = orientationFromSize(fullSize);

  // ── 第 2 步：收集正面半边的 mesh（排除背面摄像头凸起） ──
  const frontMeshes: THREE.Mesh[] = [];

  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;

    // ★ 用 getMatrixFromSceneRoot 获取完整变换
    const fullMatrix = getMatrixFromSceneRoot(mesh, scene);

    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const bbox = mesh.geometry.boundingBox!.clone();
    bbox.applyMatrix4(fullMatrix);

    const meshCenter = new THREE.Vector3();
    bbox.getCenter(meshCenter);

    const meshAxisValue = meshCenter.getComponent(thinAxisIndex);
    const sceneCenterValue = fullCenter.getComponent(thinAxisIndex);

    if (meshAxisValue >= sceneCenterValue) {
      frontMeshes.push(mesh);
    }
  });

  // ── 第 3 步：用正面 mesh 的 boundingBox 计算屏幕区域 ──
  let frontBox: THREE.Box3;
  if (frontMeshes.length > 0) {
    frontBox = new THREE.Box3();
    frontMeshes.forEach((mesh) => {
      const fullMatrix = getMatrixFromSceneRoot(mesh, scene);
      if (!mesh.geometry!.boundingBox) mesh.geometry!.computeBoundingBox();
      const bbox = mesh.geometry!.boundingBox!.clone();
      bbox.applyMatrix4(fullMatrix);
      frontBox.union(bbox);
    });
  } else {
    frontBox = fullBox;
  }

  const frontSize = new THREE.Vector3();
  const frontCenter = new THREE.Vector3();
  frontBox.getSize(frontSize);
  frontBox.getCenter(frontCenter);

  const screenW = frontSize[widthAxis] * SCREEN_WIDTH_RATIO;
  const screenH = frontSize[heightAxis] * SCREEN_HEIGHT_RATIO;

  const position: [number, number, number] = [frontCenter.x, frontCenter.y, frontCenter.z];
  position[thinAxisIndex] += frontSize.getComponent(thinAxisIndex) / 2 + SCREEN_Z_OFFSET;

  return {
    position,
    quaternion,
    size: [screenW, screenH],
  };
}

// ───────────────────────────── 工具函数 ─────────────────────────────

/**
 * ★ 计算 scene 的 boundingBox (用 getMatrixFromSceneRoot 而非 mesh.matrix)
 */
function computeLocalBoundingBox(scene: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const fullMatrix = getMatrixFromSceneRoot(mesh, scene);
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const bbox = mesh.geometry.boundingBox!.clone();
    bbox.applyMatrix4(fullMatrix);
    box.union(bbox);
  });
  return box;
}

// ★ HMR 边界 — 此文件是纯工具函数 (无 JSX), 不会被 Fast Refresh 覆盖。
//   没有这个 accept(), 修改此文件时 Vite 会沿 import 图向上找 accept 边界,
//   找不到就触发 full page reload。加上后, 修改此文件只重新执行本模块,
//   importer 通过 ESM live binding 拿到新函数引用。
if (import.meta.hot) {
  import.meta.hot.accept();
}
