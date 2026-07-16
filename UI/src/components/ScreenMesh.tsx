/**
 * ScreenMesh.tsx — RTT (Render To Texture) 贴图核心组件
 *
 * 用途：用 drei 的 <RenderTexture> 把 DslToR3f 渲染的 UI 内容贴到 GLB 模型的屏幕区域上。
 *
 * ★ 2026-07-16: 改进自动屏幕定位算法 —— 无需 Blender 修模
 *   - 3 个 GLB 模型都没有 'screen' 命名的 mesh（整个手机是合并的单一 mesh）
 *   - 改用 boundingBox 自动定位屏幕区域：检测最薄维度作为厚度方向，在正面放置 RTT 平面
 *   - 屏占比按 iPhone 实测值：宽度 86%，高度 87%
 *
 * 工作原理：
 *   1. 用 useGLTF 加载 GLB 模型
 *   2. 尝试查找名为 'screen' 的 mesh；找不到则用自动定位算法
 *   3. 自动定位：算 boundingBox → 找最薄维度（手机厚度方向）→ 在正面放 RTT 平面
 *   4. 用 <RenderTexture> 创建 FBO，把 DslToR3f 渲染到该 FBO
 *   5. RTT 平面略微偏向正面（+0.001）避免 z-fighting
 *
 * GLB 加载失败时：useGLTF 会抛错，由父组件（CanvasStage3D）的 ErrorBoundary 捕获并降级为 Html overlay。
 */

import * as React from 'react';
import * as THREE from 'three';
import { useGLTF, RenderTexture, PerspectiveCamera } from '@react-three/drei';
import type { UniversalNode } from '../services/canvas/UniversalAST';
import DslToR3f from './DslToR3f';

// ───────────────────────────── 常量 ─────────────────────────────

const RTT_WIDTH = 393;
const RTT_HEIGHT = 852;
const RTT_SAMPLES = 4;
const RTT_FRAMES = Infinity;

// iPhone 实测屏占比（屏幕区域 / 手机外框）
const SCREEN_WIDTH_RATIO = 0.86;   // 屏幕宽度占手机宽度 86%
const SCREEN_HEIGHT_RATIO = 0.87;  // 屏幕高度占手机高度 87%
const SCREEN_Z_OFFSET = 0.01;      // RTT 平面相对手机正面的 z 偏移（避免 z-fighting）

// ───────────────────────────── 类型 ─────────────────────────────

export interface ScreenMeshProps {
  modelUrl: string;
  dsl: UniversalNode;
}

interface ScreenInfo {
  /** RTT 平面的位置（相对于 scene 根） */
  position: [number, number, number];
  /** RTT 平面的四元数（控制朝向） */
  quaternion: [number, number, number, number];
  /** RTT 平面的宽高 */
  size: [number, number];
}

// ───────────────────────────── 组件 ─────────────────────────────

export default function ScreenMesh({ modelUrl, dsl }: ScreenMeshProps): React.JSX.Element | null {
  // useGLTF 在加载中会 throw promise（被 Suspense 捕获）；失败时 throw error（被 ErrorBoundary 捕获）
  const gltf = useGLTF(modelUrl);
  const scene = gltf.scene;

  // 计算屏幕位置：优先找 'screen' mesh，找不到用自动定位算法
  const screenInfo = React.useMemo<ScreenInfo | null>(() => {
    // 方案 1：查找名为 'screen' 的 mesh（如果 GLB 有命名）
    const mesh = findScreenMesh(scene);
    if (mesh) {
      const info = computeMeshInfo(mesh);
      if (info) return info;
    }
    // 方案 2：自动定位算法（无需 Blender 修模）
    return computeAutoScreenPosition(scene);
  }, [scene]);

  if (!screenInfo) {
    return null;
  }

  return (
    <group>
      <primitive object={scene} />
      <mesh position={screenInfo.position} quaternion={screenInfo.quaternion}>
        <planeGeometry args={[screenInfo.size[0], screenInfo.size[1]]} />
        <meshBasicMaterial toneMapped={false} transparent={false}>
          <RenderTexture
            width={RTT_WIDTH}
            height={RTT_HEIGHT}
            samples={RTT_SAMPLES}
            frames={RTT_FRAMES}
          >
            <PerspectiveCamera makeDefault position={[0, 0, 5]} fov={30} />
            <ambientLight intensity={0.6} />
            <DslToR3f node={dsl} width={RTT_WIDTH} height={RTT_HEIGHT} />
          </RenderTexture>
        </meshBasicMaterial>
      </mesh>
    </group>
  );
}

// ───────────────────────────── 辅助函数 ─────────────────────────────

/** 在 scene 中查找名为 'screen' 的 mesh（深度优先，大小写不敏感） */
function findScreenMesh(scene: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  scene.traverse((obj) => {
    if (!found && (obj as THREE.Mesh).isMesh && obj.name.toLowerCase() === 'screen') {
      found = obj as THREE.Mesh;
    }
  });
  return found;
}

/** 计算 mesh 的位置 / 四元数 / boundingBox 尺寸 */
function computeMeshInfo(mesh: THREE.Mesh): ScreenInfo | null {
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
 *   - RTT 平面放在 boundingBox 的正面（最薄维度的 max 面）
 *
 * 示例：
 *   - 如果 size = (0.8, 1.7, 0.3)，最薄是 z → 屏幕朝 z 方向，RTT 平面在 z=max
 *   - 如果 size = (0.8, 0.3, 1.7)，最薄是 y → 屏幕朝 y 方向（横置），RTT 平面在 y=max
 */
function computeAutoScreenPosition(scene: THREE.Object3D): ScreenInfo | null {
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

  // RTT 平面位置：在 boundingBox 正面（最薄维度的 max 面）+ 微小偏移
  const position: [number, number, number] = [center.x, center.y, center.z];
  position[thicknessAxis === 'x' ? 0 : thicknessAxis === 'y' ? 1 : 2] +=
    size[thicknessAxis] / 2 + SCREEN_Z_OFFSET;

  // 四元数：根据厚度轴决定平面朝向
  // 默认 planeGeometry 朝 +Z，如果厚度轴是 Z 就不需要旋转
  // 如果厚度轴是 Y（横置手机），需要绕 X 轴旋转 90°
  // 如果厚度轴是 X，需要绕 Y 轴旋转 90°
  let quaternion: [number, number, number, number] = [0, 0, 0, 1]; // identity
  if (thicknessAxis === 'y') {
    // 绕 X 轴旋转 -90°，让 plane 朝 +Y
    quaternion = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  } else if (thicknessAxis === 'x') {
    // 绕 Y 轴旋转 90°，让 plane 朝 +X
    quaternion = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  }

  // 如果宽高轴不是 (x, y)，需要调整平面尺寸顺序
  // planeGeometry 的 args 是 [width, height]，默认 width 沿 X 轴，height 沿 Y 轴
  // 如果 widthAxis 是 'z'，需要旋转平面让它沿 Z 轴展开
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
