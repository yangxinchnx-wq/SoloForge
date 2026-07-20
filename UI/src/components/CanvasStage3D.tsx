/**
 * CanvasStage3D.tsx — 3D 模式的完整场景组件
 *
 * ★ 360° 均匀照明方案:
 *   用 <Environment> + <Lightformer> 在场景内部生成程序化环境贴图——
 *   8 块柔光面板围成一圈环抱模型, 从所有角度均匀照亮。
 *   不依赖外部 HDR 文件, 无需 CDN/本地文件加载, 无 Suspense 等待。
 *
 *   原理: <Environment> 不传 files/preset 时, 会把 children 渲染到
 *   一个 CubeCamera FBO 里生成 envMap。<Lightformer> 是发光平面,
 *   它们被烘焙进 envMap 后, PBR 材质从任意角度都能反射到柔和光源。
 *
 * ★ 程序化贴图生成 (iPhone 15 Pro Max):
 *   模型本身没有贴图 (Blender 程序化生成, 15 个纯色材质, 0 张纹理)。
 *   用 Canvas API 在运行时生成两张程序化贴图:
 *     - 磨砂钛金属贴图: 用于背板, 模拟喷砂工艺的磨砂表面
 *     - 拉丝钛金属贴图: 用于边框, 模拟 CNC 切削的拉丝纹理
 *   并按 node 名字为每个部位 (屏幕/镜头/Apple logo/闪光灯等) 指定真实颜色。
 *
 * 自适应算法:
 *   1. GLB 加载后 clone scene (深拷贝材质, 避免污染 useGLTF 缓存)
 *   2. 调用 processMeshesInitial 处理屏幕 mesh + Z-fighting + 缺失材质兜底
 *      + applyThemeToMeshes 应用主题颜色 (iPhone 15 按部位着色)
 *   3. 用 Box3.setFromObject 计算 boundingBox
 *   4. 归一化缩放到 TARGET_SIZE, 居中到原点
 *   5. 根据 viewport aspect ratio + fov 计算合适的相机 z 距离
 *   6. 留 15% 视口边距 (FIT_RATIO = 0.85)
 */

import * as React from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Environment, Lightformer, useGLTF } from '@react-three/drei';
import { isContainerLike, type UniversalNode } from '../services/canvas/UniversalAST';
import { findScreenMesh, computeMeshInfo, computeAutoScreenPosition, computeNotchRect, type ScreenInfo } from './ScreenMesh';
import { createDslTexture, updateDslTexture, IPHONE_15_PROMAX_SHAPE, type ScreenShape } from './DslCanvasRenderer';
import {
  getDefaultTheme,
  getDefaultFinish,
  getIphone15ThemeColors,
  getFinishParams,
  type ThemeId,
  type MaterialFinish,
  type Iphone15ThemeColors,
} from '../services/canvas/modelThemes';

// ───────────────────────────── 常量 ─────────────────────────────

const FOV = 30;
const FIT_RATIO = 0.85;
const CAMERA_Z_BASE = 5;

// 预加载所有 3D 模型
const ALL_3D_MODEL_URLS = [
  '/canvas/models/3d/mobile/iphone_15_pro_max.glb',
];
ALL_3D_MODEL_URLS.forEach((url) => useGLTF.preload(url));

// ───────────────────────────── 类型 ─────────────────────────────

export interface CanvasStage3DProps {
  modelUrl: string;
  dsl: UniversalNode;
  bgColor?: string;
  /** 3D 模型颜色主题 (银/金/蓝/黑/绿等) */
  theme?: ThemeId;
  /** 3D 模型材质工艺 (原色/玻璃/皮革) */
  finish?: MaterialFinish;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

// ───────────────────────────── 主组件 ─────────────────────────────

export default function CanvasStage3D({
  modelUrl,
  dsl,
  bgColor = '#1a1a1a',
  theme = getDefaultTheme(),
  finish = getDefaultFinish(),
}: CanvasStage3DProps): React.JSX.Element {
  return (
    <div style={{ width: '100%', height: '100%', background: bgColor }}>
      <Canvas
        camera={{ position: [0, 0, CAMERA_Z_BASE], fov: FOV }}
        gl={{ alpha: true, antialias: true, preserveDrawingBuffer: false }}
        style={{ width: '100%', height: '100%' }}
      >
        {/*
          ★ 360° 程序化环境贴图

          <Environment> 不传 files/preset → 用 children 生成 envMap。
          8 块 Lightformer 围成环形, + 顶部/底部各 1 块, 共 10 块柔光面板。
          每块面板是一个矩形发光面, 被 CubeCamera 烘焙进 envMap 后,
          PBR 材质从任意旋转角度都能反射到柔和光源。

          resolution={256}: envMap 精度 256×256 (够用且省显存)
          background={false}: 不把 envMap 当背景, 保持用户选择的 bgColor
        */}
        <Environment resolution={256} background={false}>
          {/* 8 块环形柔光面板 — 水平围一圈 */}
          {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
            const rad = (deg * Math.PI) / 180;
            const r = 5;
            return (
              <Lightformer
                key={`ring-${deg}`}
                intensity={1}
                position={[Math.cos(rad) * r, 0, Math.sin(rad) * r]}
                rotation-y={-rad}
                scale={[4, 5, 1]}
                form="rect"
                color="#ffffff"
              />
            );
          })}
          {/* 顶部柔光面板 — 照亮模型上边缘 */}
          <Lightformer
            key="top"
            intensity={1.5}
            position={[0, 5, 0]}
            rotation-x={Math.PI / 2}
            scale={[6, 6, 1]}
            form="rect"
            color="#ffffff"
          />
          {/* 底部柔光面板 — 照亮模型下边缘 (消除底部死黑) */}
          <Lightformer
            key="bottom"
            intensity={0.6}
            position={[0, -5, 0]}
            rotation-x={-Math.PI / 2}
            scale={[6, 6, 1]}
            form="rect"
            color="#ffffff"
          />
        </Environment>

        {/*
          基础补光 — envMap 是主力, 这几盏灯只做高光点缀
          ambientLight 确保非金属表面也有基础亮度
          2 盏 directionalLight 产生锐利高光, 让金属边缘有光泽感
        */}
        <ambientLight intensity={0.4} />
        <directionalLight position={[5, 10, 7]} intensity={0.5} />
        <directionalLight position={[-5, -3, -5]} intensity={0.3} />

        <SuspenseWithFallback modelUrl={modelUrl} dsl={dsl} theme={theme} finish={finish} />

        <OrbitControls makeDefault enableDamping enablePan={false} />
      </Canvas>
    </div>
  );
}

// ───────────────────────────── 自适应模型组件 ─────────────────────────────

function AdaptiveModel({ modelUrl, dsl, theme, finish }: { modelUrl: string; dsl: UniversalNode; theme: ThemeId; finish: MaterialFinish }): React.JSX.Element {
  const gltf = useGLTF(modelUrl);
  const { camera, size, controls } = useThree();

  // clone scene + 深拷贝材质, 避免修改影响 useGLTF 缓存
  // ★★★ 只依赖 [gltf, modelUrl], 不依赖 theme/finish!
  //   主题/材质变化时不重新 clone scene, 只通过下面的 useEffect 更新材质
  //   这样 OrbitControls 的相机位置/旋转不会被重置
  const scene = React.useMemo(() => {
    const cloned = gltf.scene.clone(true);
    cloned.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map((m) => m.clone());
      } else {
        mesh.material = (mesh.material as THREE.Material).clone();
      }
    });
    // 初始处理 (屏幕替换/Z-fighting 修复等) + 首次主题应用 (避免首帧闪烁)
    processMeshesInitial(cloned, modelUrl);
    applyThemeToMeshes(cloned, modelUrl, theme, finish);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return cloned;
  }, [gltf, modelUrl]);

  // ★ 主题/材质变化时只更新材质属性, 不重新 clone scene, 不重置相机位置
  React.useEffect(() => {
    applyThemeToMeshes(scene, modelUrl, theme, finish);
  }, [scene, modelUrl, theme, finish]);

  const groupRef = React.useRef<THREE.Group>(null);

  React.useEffect(() => {
    if (!groupRef.current || size.width === 0 || size.height === 0) return;
    const group = groupRef.current;

    // 重置 group state
    group.position.set(0, 0, 0);
    group.rotation.set(0, 0, 0);
    group.scale.set(1, 1, 1);
    group.updateMatrixWorld(true);

    // 计算原始 boundingBox
    const rawBox = new THREE.Box3().setFromObject(group);
    if (rawBox.isEmpty()) {
      console.error('[AdaptiveModel] boundingBox is EMPTY for', modelUrl);
      return;
    }
    const rawSize = new THREE.Vector3();
    rawBox.getSize(rawSize);

    // 归一化缩放
    const maxDim = Math.max(rawSize.x, rawSize.y, rawSize.z);
    const TARGET_SIZE = 5;
    const scaleFactor = TARGET_SIZE / maxDim;
    group.scale.setScalar(scaleFactor);
    group.updateMatrixWorld(true);

    // 重新计算缩放后的 boundingBox
    const box = new THREE.Box3().setFromObject(group);
    const boxSize = new THREE.Vector3();
    const boxCenter = new THREE.Vector3();
    box.getSize(boxSize);
    box.getCenter(boxCenter);

    // 居中
    group.position.x -= boxCenter.x;
    group.position.y -= boxCenter.y;
    group.position.z -= boxCenter.z;
    group.updateMatrixWorld(true);

    // 计算相机距离
    const aspect = size.width / size.height;
    const fovRad = (FOV * Math.PI) / 180;
    const halfFovTan = Math.tan(fovRad / 2);
    const distanceH = boxSize.y / (2 * halfFovTan * FIT_RATIO);
    const distanceW = boxSize.x / (2 * halfFovTan * aspect * FIT_RATIO);
    const distance = Math.max(distanceH, distanceW);

    camera.position.set(0, 0, distance);
    camera.near = 0.01;
    camera.far = 1000;
    camera.updateProjectionMatrix();

    if (controls) {
      (controls as any).target.set(0, 0, 0);
    }

    console.log('[AdaptiveModel] ready', {
      modelUrl,
      boxSize: `${boxSize.x.toFixed(3)} × ${boxSize.y.toFixed(3)} × ${boxSize.z.toFixed(3)}`,
      distance: distance.toFixed(3),
    });
  }, [scene, camera, size.width, size.height, controls, modelUrl]);

  return (
    <group ref={groupRef}>
      <primitive object={scene} />
      <ScreenOverlay scene={scene} dsl={dsl} modelUrl={modelUrl} />
    </group>
  );
}

// ───────────────────────── 屏幕贴图组件 ─────────────────────────

/**
 * ★ 2026-07-20: 用 CanvasTexture + mesh 替换 Html transform
 *
 * 工作原理:
 *   1. 在已处理的 scene 中查找屏幕位置 (优先找 'screen' mesh, 找不到用自动定位)
 *   2. 用 Canvas 2D API 把 DSL 渲染到 canvas → CanvasTexture
 *   3. 创建 planeGeometry mesh, 把纹理贴在 material.map 上
 *   4. mesh 作为 group 的子元素, 随模型一起旋转/缩放
 *
 * ★ 完美贴合的关键:
 *   - 纹理和模型在同一个 WebGL 渲染管线中
 *   - z-buffer 正确处理遮挡: 旋转到侧面/背面时纹理会被模型几何体自然遮挡
 *   - 不会出现 Html transform 的“穿透”问题
 */
const TEX_WIDTH = 393;
const TEX_HEIGHT = 852;

/**
 * ★ 检查 DSL 是否为空 (没有有效内容节点)
 *
 * 空容器 { type: 'container', children: [] } 只会画白色背景
 * 这种情况下不渲染 ScreenOverlay, 让模型屏幕 mesh 的深色玻璃材质 (0x0a0a0a) 显示出来
 */
function isEmptyDsl(node: UniversalNode | null | undefined): boolean {
  if (!node) return true;
  // 非容器节点 (text/button/image 等) 视为有内容
  if (!isContainerLike(node)) return false;
  const children = (node as any).children as UniversalNode[] | undefined;
  if (!children || children.length === 0) return true;
  // 递归检查: 所有子节点都为空才算空
  return children.every(isEmptyDsl);
}

function ScreenOverlay({ scene, dsl, modelUrl }: { scene: THREE.Object3D; dsl: UniversalNode; modelUrl: string }): React.JSX.Element | null {
  // ★ 空 DSL 时用白色背景 (模拟亮屏状态)
  const DEFAULT_WHITE: UniversalNode = {
    type: 'container',
    style: { background: '#ffffff' },
    children: [],
  } as UniversalNode;

  const effectiveDsl = isEmptyDsl(dsl) ? DEFAULT_WHITE : dsl;

  // 计算屏幕位置: 优先找 'screen' mesh, 找不到用自动定位算法
  const screenInfo = React.useMemo<ScreenInfo | null>(() => {
    const mesh = findScreenMesh(scene);
    if (mesh) {
      const info = computeMeshInfo(mesh, scene);
      if (info) return info;
    }
    return computeAutoScreenPosition(scene);
  }, [scene]);

  // ★ 动态计算屏幕形状 (圆角 + 灵动岛挖孔)
  //   圆角半径用 IPHONE_15_PROMAX_SHAPE 的值
  //   灵动岛位置和尺寸从屏幕包围盒 + 固定比例计算 (基于 iPhone 15 Pro Max 真机尺寸)
  const screenShape: ScreenShape | undefined = React.useMemo(() => {
    if (!modelUrl.includes('iphone_15')) return undefined;
    if (!screenInfo?.screenBox || !screenInfo.widthAxis || !screenInfo.heightAxis) {
      return IPHONE_15_PROMAX_SHAPE; // 兜底: 用硬编码值
    }

    const notch = computeNotchRect(
      screenInfo.screenBox,
      screenInfo.widthAxis,
      screenInfo.heightAxis,
      TEX_WIDTH,
      TEX_HEIGHT,
    );

    return {
      cornerRadius: IPHONE_15_PROMAX_SHAPE.cornerRadius,
      notch: notch ?? IPHONE_15_PROMAX_SHAPE.notch,
    };
  }, [modelUrl, scene, screenInfo]);

  // ★ 创建/更新 CanvasTexture (传入 screenShape 裁剪圆角 + 灵动岛)
  //   useMemo 创建初始纹理, useEffect 在 DSL 变化时更新纹理 (避免重复创建 CanvasTexture)
  const textureRef = React.useRef<THREE.CanvasTexture | null>(null);

  if (!textureRef.current) {
    try {
      textureRef.current = createDslTexture(effectiveDsl, TEX_WIDTH, TEX_HEIGHT, undefined, screenShape);
    } catch (err) {
      console.error('[ScreenOverlay] createDslTexture failed, using white fallback:', err);
      textureRef.current = createDslTexture(DEFAULT_WHITE, TEX_WIDTH, TEX_HEIGHT, undefined, screenShape);
    }
  }

  React.useEffect(() => {
    if (!textureRef.current) return;
    try {
      updateDslTexture(textureRef.current, effectiveDsl, TEX_WIDTH, TEX_HEIGHT, undefined, screenShape);
    } catch (err) {
      console.error('[ScreenOverlay] updateDslTexture failed:', err);
    }
  }, [effectiveDsl, screenShape]);

  // ★ 组件卸载时释放纹理
  React.useEffect(() => {
    return () => {
      textureRef.current?.dispose();
      textureRef.current = null;
    };
  }, []);

  if (!screenInfo) return null;

  return (
    <mesh position={screenInfo.position} quaternion={screenInfo.quaternion}>
      <planeGeometry args={[screenInfo.size[0], screenInfo.size[1]]} />
      {/* ★ transparent + alphaTest: 透明区域 (圆角外/灵动岛) 不渲染, 显示模型本身 */}
      <meshBasicMaterial
        map={textureRef.current}
        toneMapped={false}
        transparent={true}
        alphaTest={0.5}
        side={THREE.FrontSide}
        polygonOffset
        polygonOffsetFactor={-1}
        polygonOffsetUnits={-1}
      />
    </mesh>
  );
}

// ───────────────────────────── Mesh 处理 ─────────────────────────────

/**
 * 初始 Mesh 处理 (不依赖 theme, 只在模型加载时执行一次):
 *   1. 按名字检测屏幕/灵动岛 mesh → 替换为深色玻璃材质
 *   2. 按名字检测 Apple logo → polygonOffset 修复 Z-fighting
 *   3. 对所有 mesh 调用 fixMaterial 兜底 (修复缺失的 roughness/metalness)
 */
function processMeshesInitial(scene: THREE.Object3D, modelUrl: string): void {
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;

    // ★ 多 primitive 时 GLTFLoader 创建 Group (node name) + 子 Mesh (mesh name)
    //   所以需要同时检查 mesh.name 和 mesh.parent?.name
    const nodeName = (mesh.name || '').toLowerCase();
    const parentName = (mesh.parent?.name || '').toLowerCase();
    const combinedName = nodeName + ' ' + parentName;

    const isAppleLogo = combinedName.includes('apple') || combinedName.includes('logo');
    const isScreen = combinedName.includes('screen') ||
                     combinedName.includes('display') ||
                     combinedName.includes('面板') ||
                     combinedName.includes('glass_front');
    const isIsland = combinedName.includes('island');

    // 屏幕 mesh → 深色亮面玻璃材质 (模拟息屏状态)
    if (isScreen) {
      mesh.material = new THREE.MeshStandardMaterial({
        color: 0x0a0a0a,
        roughness: 0.08,
        metalness: 0.0,
      });
      return;
    }

    // ★ island 不在 processMeshesInitial 中处理, 由 applyThemeToMeshes 全权负责
    //   (避免创建新材质后 applyThemeToMeshes 修改的是旧引用)

    // ★ 镜头玻璃 (Sphere* + camera glass) → 替换为新的不透明黑色材质
    //   GLB 中这些 mesh 共享 Material.009 (alphaMode:BLEND, 半透明蓝色 baseColor [0.026,0.093,0.363,0.486])
    //   只改 color/transparent 属性不够, three.js 需要重新编译 shader (needsUpdate) 才能生效。
    //   直接创建新材质最干净。
    const isCameraGlass = nodeName.includes('sphere') || (nodeName.includes('cam') && nodeName.includes('glass'));
    if (isCameraGlass) {
      mesh.material = new THREE.MeshStandardMaterial({
        color: 0x111111,
        metalness: 0.6,
        roughness: 0.05,
        transparent: false,
        opacity: 1.0,
        envMapIntensity: 1.5,
      });
      return;
    }

    // Apple logo → polygonOffset 修复 Z-fighting
    if (isAppleLogo) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((mat) => {
        const m = mat as THREE.MeshStandardMaterial;
        if (m && (m as any).isMeshStandardMaterial) {
          m.polygonOffset = true;
          m.polygonOffsetFactor = -1;
          m.polygonOffsetUnits = -1;
        }
      });
    }

    // 所有 mesh 兜底: 修复缺失的材质属性
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((mat) => {
      fixMaterial(mat as THREE.MeshStandardMaterial);
    });
  });
}

/**
 * 主题材质应用 (依赖 theme, 主题切换时执行):
 *   - iPhone 15: 按部位指定真实颜色 + 程序化贴图 + 主题颜色
 *
 * ★ 跳过屏幕/灵动岛 mesh (已在 processMeshesInitial 中替换为固定材质)
 */
function applyThemeToMeshes(scene: THREE.Object3D, modelUrl: string, theme: ThemeId, finish: MaterialFinish): void {
  const isIphone15 = modelUrl.includes('iphone_15');
  // 非目标模型不处理
  if (!isIphone15) return;

  const themeColors = getIphone15ThemeColors(theme);
  const finishParams = getFinishParams(finish);

  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;

    // ★ 多 primitive 时检查 mesh.name + parent.name
    const nodeName = (mesh.name || '').toLowerCase();
    const parentName = (mesh.parent?.name || '').toLowerCase();
    const combinedName = nodeName + ' ' + parentName;

    const isAppleLogo = combinedName.includes('apple') || combinedName.includes('logo');
    const isScreen = combinedName.includes('screen') ||
                     combinedName.includes('display') ||
                     combinedName.includes('面板') ||
                     combinedName.includes('glass_front');
    const isIsland = combinedName.includes('island');

    const isSphere = combinedName.includes('sphere');
    const isCameraGlass = isSphere || (combinedName.includes('cam') && combinedName.includes('glass'));

    // ★ 跳过屏幕 mesh 和镜头玻璃/摄像头盖板 (已在 processMeshesInitial 中替换为固定黑色材质)
    // island 不再跳过: 主题切换时也需要更新 island 颜色
    if (isScreen || isCameraGlass) return;

    // ★ island mesh: 和后盖完全同色同材质 (前面会被屏幕贴图覆盖, 背面从摄像头开孔看到的是后盖色)
    if (isIsland) {
      const islandMats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      islandMats.forEach((mat) => {
        const m = mat as THREE.MeshStandardMaterial;
        if (m && (m as any).isMeshStandardMaterial) {
          m.color.setHex(themeColors.back);
          m.metalness = finishParams.metalness;
          m.roughness = finishParams.roughness;
          m.envMapIntensity = finishParams.envMapIntensity;
          // 和后盖一样应用贴图
          if (finish === 'glass') {
            m.map = null;
          } else if (finish === 'leather') {
            m.map = getLeatherTexture();
          } else {
            m.map = getMatteTitaniumTexture();
          }
        }
      });
      return;
    }

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((mat) => {
      const m = mat as THREE.MeshStandardMaterial;
      if (!m || !(m as any).isMeshStandardMaterial) return;

      // ★ iPhone 15 Pro Max 按部位指定真实颜色和贴图 + 主题颜色 + 材质工艺
      applyIphone15Materials(m, combinedName, isAppleLogo, themeColors, finish, finishParams);
    });
  });
}

// ───────────────────────────── 程序化贴图生成 ─────────────────────────────

/**
 * 模块级贴图缓存 — 贴图只生成一次, 所有模型实例共享
 * (避免每次 clone scene 时重新生成 CanvasTexture)
 * ★ 主题切换时不重新生成贴图, 只复用缓存, 避免 GPU 重传卡顿
 */
let _matteTitaniumTexture: THREE.CanvasTexture | null = null;
let _brushedTitaniumTexture: THREE.CanvasTexture | null = null;
let _leatherTexture: THREE.CanvasTexture | null = null;

/**
 * 生成磨砂钛金属贴图 (用于背板)
 *
 * ★★★ 2026-07-18 修复: 噪点强度从 20 降到 8, 避免过度噪点
 *   (UV 重复平铺会使噪点被放大, 强度 8 贴图更平滑, 只提供细微的磨砂质感)
 */
function getMatteTitaniumTexture(): THREE.CanvasTexture {
  if (_matteTitaniumTexture) return _matteTitaniumTexture;

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  // 底色: 浅灰 (#E8E8E8) — 钛金属的自然色
  ctx.fillStyle = '#E8E8E8';
  ctx.fillRect(0, 0, 256, 256);

  // 噪点纹理: 模拟喷砂磨砂表面
  //   ★ 强度从 20 降到 8, 避免噪点过重
  const imageData = ctx.getImageData(0, 0, 256, 256);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 8;
    data[i] = Math.max(0, Math.min(255, data[i] + noise));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
  }
  ctx.putImageData(imageData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  _matteTitaniumTexture = texture;
  return texture;
}

/**
 * 生成皮革纹理贴图 (用于背板)
 *
 * 皮革表面有天然的纹理图案: 不规则的颗粒状纹路 + 细微的裂纹。
 * 用 Canvas API 生成模拟皮革质感:
 *   1. 底色填充
 *   2. 多层随机的圆形颗粒模拟皮革毛孔
 *   3. 细微的明暗变化模拟皮革自然变化
 */
function getLeatherTexture(): THREE.CanvasTexture {
  if (_leatherTexture) return _leatherTexture;

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  // 底色: 中灰色 (会被 material.color 乘法叠加为主题色)
  ctx.fillStyle = '#C0C0C0';
  ctx.fillRect(0, 0, 256, 256);

  // 皮革颗粒纹理: 随机分布的深色小圆点模拟皮革毛孔
  for (let i = 0; i < 800; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const radius = 1 + Math.random() * 2;
    const darkness = Math.random() * 30;
    ctx.fillStyle = `rgba(0, 0, 0, ${darkness / 100})`;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  // 皮革高光点: 随机分布的亮色小点模拟皮革反光
  for (let i = 0; i < 400; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const radius = 0.5 + Math.random() * 1.5;
    const lightness = Math.random() * 25;
    ctx.fillStyle = `rgba(255, 255, 255, ${lightness / 100})`;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  // 整体明暗渐变: 模拟皮革表面的自然变化
  const imageData = ctx.getImageData(0, 0, 256, 256);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const variation = (Math.random() - 0.5) * 12;
    data[i] = Math.max(0, Math.min(255, data[i] + variation));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + variation));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + variation));
  }
  ctx.putImageData(imageData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  _leatherTexture = texture;
  return texture;
}

/**
 * 生成拉丝钛金属贴图 (用于边框)
 *
 * iPhone 15 Pro Max 的钛金属边框是 CNC 切削 + 拉丝工艺,
 * 表面有细密的水平方向拉丝纹理。用 Canvas API 逐行绘制
 * 不同灰度的水平线条来模拟这种效果。
 */
function getBrushedTitaniumTexture(): THREE.CanvasTexture {
  if (_brushedTitaniumTexture) return _brushedTitaniumTexture;

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  // 底色: 银色 (#C8C8C8)
  ctx.fillStyle = '#C8C8C8';
  ctx.fillRect(0, 0, 256, 256);

  // 水平拉丝线条: 每行用不同灰度, 模拟金属拉丝纹理
  for (let y = 0; y < 256; y++) {
    const brightness = 190 + Math.random() * 40;
    const b = brightness | 0;
    ctx.strokeStyle = `rgb(${b}, ${b}, ${b})`;
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(256, y + 0.5);
    ctx.stroke();
  }

  // 细密噪点: 增加金属表面的微观颗粒感
  const imageData = ctx.getImageData(0, 0, 256, 256);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 10;
    data[i] = Math.max(0, Math.min(255, data[i] + noise));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
  }
  ctx.putImageData(imageData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  _brushedTitaniumTexture = texture;
  return texture;
}

// ───────────────────────────── iPhone 15 按部位着色 ─────────────────────────────

/**
 * iPhone 15 Pro Max 按部位指定真实颜色和贴图
 *
 * 模型有 19 个 node, 每个有明确的部位名:
 *   back → 背板    screen → 屏幕    island → 灵动岛
 *   phone case → 边框    Apple logo → logo
 *   Sphere* → 镜头玻璃    camera glass → 摄像头玻璃
 *   Cylinder* → 摄像头金属环/内部组件
 *   flash mtl/flash glass → 闪光灯
 *   sound box/scroo → 扬声器/螺丝
 *   back camera/front camra1 → 摄像头组件
 *
 * 按部位匹配的优先级 (从具体到通用):
 *   1. apple/logo   → 银色金属 (logo)
 *   2. flash        → 闪光灯 (区分 glass/metal)
 *   3. cam + glass  → 摄像头玻璃
 *   4. sphere       → 镜头玻璃 (深蓝黑, 有反射)
 *   5. cam          → 摄像头组件
 *   6. cylinder     → 金属环/内部组件 (按原始 metalness 区分)
 *   7. sound/scroo  → 扬声器/螺丝
 *   8. case         → 边框 (拉丝钛金属贴图)
 *   9. back         → 背板 (磨砂钛金属贴图)
 *   其他 → 保持原始材质
 */
function applyIphone15Materials(
  m: THREE.MeshStandardMaterial,
  nodeName: string,
  isAppleLogo: boolean,
  tc: Iphone15ThemeColors,
  finish: MaterialFinish,
  fp: ReturnType<typeof getFinishParams>,
): void {
  if (!m || !(m as any).isMeshStandardMaterial) return;

  if (isAppleLogo) {
    // Apple logo: 主题 logo 色, 高反射
    m.color.setHex(tc.logo);
    m.metalness = 0.9;
    m.roughness = 0.15;
    m.envMapIntensity = 1.8;
  } else if (nodeName.includes('flash')) {
    // 闪光灯
    if (nodeName.includes('glass')) {
      // 闪光灯玻璃: 暖白色透明感
      m.color.setHex(0xFFF8E0);
      m.metalness = 0.0;
      m.roughness = 0.05;
    } else {
      // 闪光灯金属底座
      m.color.setHex(tc.flashMetal);
      m.metalness = 0.3;
      m.roughness = 0.3;
    }
  } else if (nodeName.includes('cam') && nodeName.includes('glass')) {
    // 摄像头玻璃盖板: 和主题背板同色
    m.color.setHex(tc.back);
    m.metalness = 0.0;
    m.roughness = 0.05;
    m.envMapIntensity = 1.0;
  } else if (nodeName.includes('sphere')) {
    // 镜头玻璃: 黑色, 有强反射 (镜头的标志性外观)
    m.color.setHex(0x111111);
    m.metalness = 0.6;
    m.roughness = 0.05;
    m.transparent = false;
    m.opacity = 1.0;
    m.envMapIntensity = 1.5;
  } else if (nodeName.includes('cam')) {
    // 摄像头组件
    if (nodeName.includes('back')) {
      // 后摄底座: 和边框同色 (iPhone 15 Pro 的摄像头模块底座是钛金属材质, 和边框一体)
      m.color.setHex(tc.frame);
      m.metalness = 0.85;
      m.roughness = 0.35;
      m.envMapIntensity = 1.2;
    } else {
      // 前摄: 深色 (藏在屏幕下方)
      m.color.setHex(0x2a2a2a);
      m.metalness = 0.5;
      m.roughness = 0.4;
    }
  } else if (nodeName.includes('cylinder')) {
    // 圆柱体: 根据原始材质区分金属环和内部组件
    //   metal (metalness > 0.7) → 主题色金属环 (外圈装饰)
    //   其他 → 深色内部组件
    if (m.name === 'metal' || m.metalness > 0.7) {
      m.color.setHex(tc.cameraRing);
      m.metalness = 0.9;
      m.roughness = 0.2;
      m.envMapIntensity = 1.3;
    } else {
      // 内部组件: 主题色
      m.color.setHex(tc.back);
      m.metalness = 0.5;
      m.roughness = 0.3;
    }
  } else if (nodeName.includes('sound') || nodeName.includes('scroo')) {
    // 扬声器/螺丝: 主题色
    m.color.setHex(tc.back);
    m.metalness = 0.4;
    m.roughness = 0.5;
  } else if (nodeName.includes('case')) {
    // phone case 有 3 种材质, 必须按原始材质区分, 否则按钮会被边框颜色覆盖:
    //   material "metal" (metalness=0.88)  → 主题色边框 + 拉丝贴图
    //   material "Material.010" (metalness=0, 深色) → 按钮/开口, 保持深色
    //   material "Material.001" (metalness=0.9, 金色) → 天线带
    if (m.name === 'metal' || m.metalness > 0.7) {
      // 边框: 拉丝钛金属贴图 + 主题边框色
      m.color.setHex(tc.frame);
      m.metalness = 0.85;
      m.roughness = 0.35;
      if (!m.map) m.map = getBrushedTitaniumTexture();
      m.envMapIntensity = 1.2;
    } else if (m.metalness < 0.1) {
      // 按钮/开口: 主题色
      m.color.setHex(tc.frame);
      m.metalness = 0.3;
      m.roughness = 0.4;
      m.envMapIntensity = 0.8;
    } else {
      // 天线带: 主题色
      m.color.setHex(tc.frame);
      m.metalness = 0.6;
      m.roughness = 0.5;
      m.envMapIntensity = 1.0;
    }
  } else if (nodeName.includes('back')) {
    // 背板: 颜色由主题决定, 材质工艺由 finish 决定
    //   注意: "back camera" 包含 "back" 和 "cam",
    //   但 "cam" 的分支在上面已经处理了, 不会到达这里
    m.color.setHex(tc.back);
    m.metalness = fp.metalness;
    m.roughness = fp.roughness;
    m.envMapIntensity = fp.envMapIntensity;
    m.transparent = fp.transparent;
    m.opacity = fp.opacity;

    if (finish === 'glass') {
      // 玻璃后盖: 无贴图
      m.map = null;
    } else if (finish === 'leather') {
      // 皮革后盖: 皮革纹理贴图
      m.map = getLeatherTexture();
    } else {
      // 磨砂钛金属 (默认): 磨砂纹理贴图
      m.map = getMatteTitaniumTexture();
    }
  }
  // 其他未识别的部位保持原始材质
}

/**
 * 材质兜底修复:
 *   只修复 GLB 中缺失或无效的材质属性, 不覆盖 GLB 已指定的值
 *   (有了 envMap, 原始材质值能正确工作, 不需要 hack)
 */
function fixMaterial(mat: THREE.MeshStandardMaterial): void {
  if (!mat || !(mat as any).isMeshStandardMaterial) return;

  // roughness 缺失或无效 → 默认 0.5
  if (mat.roughness === undefined || (mat.roughness !== mat.roughness)) {
    mat.roughness = 0.5;
  }

  // metalness 缺失或无效 → 默认 0.5
  if (mat.metalness === undefined || (mat.metalness !== mat.metalness)) {
    mat.metalness = 0.5;
  }
}

// ───────────────────────────── Suspense + ErrorBoundary 包装 ─────────────────────────────

function SuspenseWithFallback({
  modelUrl,
  dsl,
  theme,
  finish,
}: {
  modelUrl: string;
  dsl: UniversalNode;
  theme: ThemeId;
  finish: MaterialFinish;
}): React.JSX.Element {
  return (
    <ModelErrorBoundary
      modelUrl={modelUrl}
      fallback={
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#ff0000" wireframe />
        </mesh>
      }
    >
      <React.Suspense fallback={null}>
        <AdaptiveModel modelUrl={modelUrl} dsl={dsl} theme={theme} finish={finish} />
      </React.Suspense>
    </ModelErrorBoundary>
  );
}

// ───────────────────────────── ErrorBoundary 类组件 ─────────────────────────────

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback: React.ReactNode;
  modelUrl?: string;
}

class ModelErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  // ★ 修复 2026-07-19: modelUrl 变化时重置错误状态
  //   场景: 持久化的设备被删除 (如 iphone_11_pro_max), 加载失败后
  //   PreviewPanel 的 useEffect 自动回退到有效设备, modelUrl 变化
  //   此时 ErrorBoundary 需要重置, 让 AdaptiveModel 重新加载新模型
  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (prevProps.modelUrl !== this.props.modelUrl && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  componentDidCatch(error: unknown): void {
    console.error('[CanvasStage3D] 模型加载失败!', {
      modelUrl: this.props.modelUrl,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}
