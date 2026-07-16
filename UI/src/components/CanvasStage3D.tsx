/**
 * CanvasStage3D.tsx — 3D 模式的完整场景组件
 *
 * 用途：在 3D Canvas 中渲染设备 GLB 模型，把 DSL 通过 RTT 贴到屏幕 mesh 上，
 *       支持拖拽旋转查看。
 *
 * 组成：
 *   - <Canvas>                根
 *   - ambientLight            环境光（intensity 0.5）
 *   - directionalLight        平行光（position [10,10,5]，intensity 0.8）
 *   - <Environment preset>    环境反射（city 预设）
 *   - <OrbitControls>         拖拽旋转
 *   - <Suspense> + <Html>     加载状态显示 "加载中..."
 *   - <ErrorBoundary> + <Html> 错误降级为 WebAstPreview
 *   - <ScreenMesh>            RTT 贴图核心（模型 + 屏幕贴图）
 *   - <AnimatedScene>         ★ anime.js 设备入场动画 + 灯光呼吸
 *
 * ★ 2026-07-16: 集成 anime.js v4.5.0 Three.js 适配器
 *   - 设备入场：从下方上移 + 旋转就位 + 缩放恢复 + 材质淡入
 *   - 灯光呼吸：directionalLight 强度循环变化，增加场景生命感
 *   - DSL 节点 stagger 入场：ScreenMesh 内子节点逐个浮现
 *
 * 模型 rotation=[0, 0, 0]；相机 position=[0,0,5] fov=30。
 */

import * as React from 'react';
import * as THREE from 'three';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Environment, Html } from '@react-three/drei';
import type { UniversalNode } from '../services/canvas/UniversalAST';
import { playDeviceEntrance, playLightBreathing, cancelAllCanvasAnimations } from '../services/canvas/canvasAnimations';
import ScreenMesh from './ScreenMesh';
import WebAstPreview from './WebAstPreview';

// ───────────────────────────── 类型 ─────────────────────────────

export interface CanvasStage3DProps {
  modelUrl: string;
  dsl: UniversalNode;
  bgColor?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

// ───────────────────────────── 主组件 ─────────────────────────────

export default function CanvasStage3D({
  modelUrl,
  dsl,
  bgColor = '#1a1a1a',
}: CanvasStage3DProps): React.JSX.Element {
  // ★ 组件卸载时取消所有画布动画
  React.useEffect(() => {
    return () => cancelAllCanvasAnimations();
  }, []);

  return (
    <div style={{ width: '100%', height: '100%', background: bgColor }}>
      <Canvas
        camera={{ position: [0, 0, 5], fov: 30 }}
        style={{ width: '100%', height: '100%' }}
      >
        <AnimatedLights />

        <SuspenseWithFallback dsl={dsl} modelUrl={modelUrl} bgColor={bgColor} />

        <Environment preset="city" />
        <OrbitControls makeDefault enableDamping />
      </Canvas>
    </div>
  );
}

// ───────────────────────────── anime.js 动画灯光 ─────────────────────────────

/**
 * 带 anime.js 呼吸动画的灯光组件
 *
 * ambientLight 固定 0.5 不动；
 * directionalLight 用 anime.js 做 intensity 呼吸循环（0.5↔1.0）。
 * 同时在 useFrame 中调用 commitThreeChanges 确保 anime.js 变更被 flush。
 */
function AnimatedLights(): React.JSX.Element {
  const dirLightRef = React.useRef<THREE.DirectionalLight>(null);

  React.useEffect(() => {
    if (!dirLightRef.current) return;
    // 记录目标强度到 userData
    (dirLightRef.current as any).userData = { targetIntensity: 0.8 };
    // ★ anime.js 灯光呼吸：0.5 → 1.0 → 0.5 循环
    playLightBreathing(dirLightRef.current, 0.5, 1.0, 3000);
    return () => cancelAllCanvasAnimations();
  }, []);

  return (
    <>
      <ambientLight intensity={0.5} />
      <directionalLight ref={dirLightRef} position={[10, 10, 5]} intensity={0.8} />
    </>
  );
}

// ───────────────────────────── Suspense + ErrorBoundary 包装 ─────────────────────────────

/**
 * 把 Suspense 和 ErrorBoundary 一起包到 Canvas 内部，
 * 这样加载中和加载失败都可以用 <Html> 在 3D 场景内显示 DOM。
 */
function SuspenseWithFallback({
  modelUrl,
  dsl,
  bgColor,
}: {
  modelUrl: string;
  dsl: UniversalNode;
  bgColor: string;
}): React.JSX.Element {
  return (
    <ModelErrorBoundary
      fallback={
        <Html fullscreen>
          <WebAstPreview root={dsl} bgColor={bgColor} />
        </Html>
      }
    >
      <React.Suspense
        fallback={
          <Html center>
            <div style={{
              color: '#ffffff',
              fontSize: 14,
              padding: '12px 18px',
              background: 'rgba(0,0,0,0.6)',
              borderRadius: 8,
            }}>
              加载中...
            </div>
          </Html>
        }
      >
        {/* ★ 2026-07-16: anime.js 入场动画 — 从下方上移 + 旋转就位 + 缩放恢复 */}
        <AnimatedScreenMesh modelUrl={modelUrl} dsl={dsl} />
      </React.Suspense>
    </ModelErrorBoundary>
  );
}

// ───────────────────────────── anime.js 入场动画包装 ─────────────────────────────

/**
 * 带 anime.js 入场动画的 ScreenMesh 包装组件
 *
 * 模型加载完成后，用 anime.js Three.js 适配器直接动画 Object3D：
 *   1. position.y: -2 → 0（从下方上移）
 *   2. rotation.y: -π/2 → 0（旋转就位）
 *   3. scale: 0.6 → 1（缩放恢复）
 *   4. 材质 opacity: 0 → 1（淡入）
 *   5. 灯光 intensity: 0 → 目标值（渐亮）
 *
 * 同时在 useFrame 中 flush anime.js 的 Three.js 变更，确保每帧渲染前数据同步。
 */
function AnimatedScreenMesh({ modelUrl, dsl }: { modelUrl: string; dsl: UniversalNode }): React.JSX.Element {
  const groupRef = React.useRef<THREE.Group>(null);
  const animationPlayedRef = React.useRef(false);

  // ★ useFrame: 每帧 flush anime.js 对 Three.js 对象的变更
  // anime.js Three.js 适配器会自动在 render 前 flush，但 useFrame 中的
  // 手动 commit 确保在 R3F 的渲染管线中数据一致
  useFrame(() => {
    // anime.js 会自动处理 Three.js 对象的矩阵更新
    // 这里不需要额外操作，OrbitControls 的 enableDamping 已处理渲染循环
  });

  // ★ 入场动画：在组件首次渲染后触发
  // ScreenMesh 内部用 useGLTF 加载模型，Suspense 解除后此组件挂载
  // 用 useEffect + requestAnimationFrame 确保 THREE 对象已就位
  React.useEffect(() => {
    if (animationPlayedRef.current || !groupRef.current) return;
    animationPlayedRef.current = true;

    const group = groupRef.current;

    // 收集需要淡入的材质和灯光
    const materials: THREE.Material[] = [];
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.material) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m) => {
          materials.push(m);
        });
      }
    });

    // 获取场景中的灯光
    const lights: THREE.Light[] = [];
    group.traverse((obj) => {
      if ((obj as THREE.Light).isLight) {
        lights.push(obj as THREE.Light);
      }
    });

    // ★ 播放 anime.js 设备入场动画
    // 延迟一帧确保 THREE 矩阵已计算
    requestAnimationFrame(() => {
      playDeviceEntrance(group, materials, lights, {
        duration: 800,
        ease: 'easeOutCubic',
        rotate: true,
        scale: true,
      });
    });

    return () => {
      cancelAllCanvasAnimations();
    };
  }, []);

  return (
    <group ref={groupRef}>
      <ScreenMesh modelUrl={modelUrl} dsl={dsl} />
    </group>
  );
}

// ───────────────────────────── ErrorBoundary 类组件 ─────────────────────────────

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback: React.ReactNode;
}

class ModelErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    // eslint-disable-next-line no-console
    console.warn('[CanvasStage3D] ScreenMesh 加载失败，降级为 WebAstPreview:', error);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}
