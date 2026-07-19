/**
 * canvasAnimations.ts — 画布动画引擎（基于 anime.js v4.5.0）
 *
 * 统一管理画布系统中所有 anime.js 动画逻辑：
 *   - 3D 设备入场动画（旋转 + 缩放 + 淡入）
 *   - DSL 节点 3D Stagger 逐个入场
 *   - 灯光呼吸效果
 *   - 2D DOM 元素 FLIP 布局过渡
 *   - 文本 scramble 解码效果
 *   - 设备切换过渡 Timeline
 *
 * anime.js v4.5 的 Three.js 适配器会自动检测 THREE.Object3D，
 * 让 animate(mesh.position, {x: 10}) 直接生效，无需手动 requestAnimationFrame。
 *
 * ★ 2026-07-16: 新建文件，配合 anime.js v4.5.0 Adapters API
 */

import { animate, createTimeline, stagger, type JSAnimation, type Timeline } from 'animejs';
// ★ 关键：导入 Three.js 适配器 — 副作用导入，注册后 anime.js 自动识别 THREE 对象
import 'animejs/adapters/three';
import type * as THREE from 'three';

// ───────────────────────── 类型 ─────────────────────────

export interface EntranceAnimationOptions {
  /** 入场动画持续时间（ms），默认 800 */
  duration?: number;
  /** 缓动函数名，默认 'outCubic'（anime.js v4 去掉了 'ease' 前缀） */
  ease?: string;
  /** 延迟（ms），默认 0 */
  delay?: number;
  /** 是否旋转入场，默认 true */
  rotate?: boolean;
  /** 是否缩放入场，默认 true */
  scale?: boolean;
}

export interface StaggerEntranceOptions {
  /** 每个节点的动画持续时间（ms），默认 500 */
  duration?: number;
  /** stagger 间隔（ms），默认 60 */
  staggerDelay?: number;
  /** stagger 起始位置，默认 'center' */
  from?: number | 'first' | 'center' | 'last' | 'random';
  /** 缓动函数名，默认 'outBack'（anime.js v4 去掉了 'ease' 前缀） */
  ease?: string;
  /** 网格维度（用于 3D Stagger），默认 [3, 3, 1] */
  grid?: number[] | boolean;
  /** 随机抖动范围 [min, max]（ms），默认 undefined（无抖动） */
  jitter?: number | [number, number];
  /** 随机种子，默认 false（Math.random） */
  seed?: boolean | number;
}

// ───────────────────────── 动画实例追踪 ─────────────────────────

/** 当前活跃的动画实例（用于取消旧动画） */
const activeAnimations = new Set<JSAnimation | Timeline>();

/** 取消所有活跃动画 */
export function cancelAllCanvasAnimations(): void {
  activeAnimations.forEach((anim) => {
    try {
      anim.pause();
    } catch { /* ignore */ }
  });
  activeAnimations.clear();
}

/** 注册动画实例，组件卸载时取消 */
function trackAnimation<T extends JSAnimation | Timeline>(anim: T): T {
  activeAnimations.add(anim);
  anim.then(() => {
    activeAnimations.delete(anim);
  });
  return anim;
}

// ───────────────────────── P0: 3D 设备入场动画 ─────────────────────────

/**
 * 3D 设备入场动画
 *
 * 效果：
 *   1. 模型从下方上移 + 旋转半圈 → 就位
 *   2. 屏幕材质从透明 → 不透明
 *   3. 灯光从暗 → 正常亮度
 *
 * 使用 anime.js Three.js 适配器直接动画 Object3D 属性，
 * 无需手动 requestAnimationFrame。
 *
 * @param scene     THREE.Scene 或 group（模型容器）
 * @param materials 需要淡入的材质数组
 * @param lights    需要渐亮的灯光数组
 * @param options   动画选项
 */
export function playDeviceEntrance(
  scene: THREE.Object3D,
  materials: THREE.Material[] = [],
  lights: THREE.Light[] = [],
  options: EntranceAnimationOptions = {},
): Timeline {
  const {
    duration = 800,
    ease = 'outCubic',
    delay = 0,
    rotate = true,
    scale = true,
  } = options;

  // 初始状态
  scene.position.y = -2;
  if (scale) scene.scale.set(0.6, 0.6, 0.6);
  if (rotate) scene.rotation.y = -Math.PI * 0.5;
  materials.forEach((m) => {
    (m as any).opacity = 0;
    m.transparent = true;
  });
  lights.forEach((l) => { l.intensity = 0; });

  const tl = createTimeline({ defaults: { ease, duration } });

  // 阶段 1: 模型上移 + 旋转就位 + 缩放恢复
  tl.add(scene.position, { y: [-2, 0], duration }, delay);

  if (rotate) {
    tl.add(scene.rotation, { y: [-Math.PI * 0.5, 0], duration }, delay);
  }

  if (scale) {
    tl.add(scene.scale, { x: [0.6, 1], y: [0.6, 1], z: [0.6, 1], duration }, delay);
  }

  // 阶段 2: 材质淡入（延迟 40% 开始）
  materials.forEach((m) => {
    tl.add(m, { opacity: [0, 1], duration: duration * 0.6 }, delay + duration * 0.4);
  });

  // 阶段 3: 灯光渐亮（延迟 20% 开始）
  lights.forEach((l) => {
    const targetIntensity = (l as any).userData?.targetIntensity ?? l.intensity ?? 1;
    // 先记录目标强度到 userData（如果还没记录）
    if (!(l as any).userData?.targetIntensity) {
      (l as any).userData = { ...(l as any).userData, targetIntensity };
    }
    tl.add(l, { intensity: [0, targetIntensity], duration: duration * 0.8 }, delay + duration * 0.2);
  });

  return trackAnimation(tl);
}

// ───────────────────────── P0: DSL 节点 Stagger 入场 ─────────────────────────

/**
 * DSL 节点 3D Stagger 逐个入场动画
 *
 * 让 R3F 场景中的 DSL 子节点从 scale=0 + opacity=0 逐个浮现，
 * 配合 3D Stagger 网格 + jitter 实现自然交错效果。
 *
 * @param meshes     需要入场的 mesh/group 数组（3D 场景渲染的子节点）
 * @param materials  对应的材质数组（用于 opacity 动画）
 * @param options    Stagger 选项
 */
export function playStaggerEntrance(
  meshes: THREE.Object3D[],
  materials: THREE.Material[] = [],
  options: StaggerEntranceOptions = {},
): JSAnimation | null {
  if (meshes.length === 0) return null;

  const {
    duration = 500,
    staggerDelay = 60,
    from = 'center',
    ease = 'outBack',
    grid = [3, 3, 1],
    jitter,
    seed,
  } = options;

  // 初始状态：所有节点缩小 + 透明
  meshes.forEach((m, i) => {
    m.scale.set(0.01, 0.01, 0.01);
    const mat = materials[i];
    if (mat) {
      mat.transparent = true;
      (mat as any).opacity = 0;
    }
  });

  const staggerParams: Record<string, any> = {
    start: 0,
    from,
    grid: grid === true ? true : (grid as number[]),
  };
  if (jitter != null) staggerParams.jitter = jitter;
  if (seed != null) staggerParams.seed = seed;

  // 缩放入场
  const scaleAnim = animate(meshes, {
    scale: [0.01, 1],
    duration,
    delay: stagger(staggerDelay, staggerParams),
    ease,
    composition: 'replace',
  });

  // 透明度入场（稍快于缩放）
  if (materials.length > 0) {
    animate(materials, {
      opacity: [0, 1],
      duration: duration * 0.7,
      delay: stagger(staggerDelay, staggerParams),
      ease: 'outQuad',
    });
  }

  trackAnimation(scaleAnim);
  return scaleAnim;
}

// ───────────────────────── P1: 灯光呼吸效果 ─────────────────────────

/**
 * 灯光呼吸效果（持续循环）
 *
 * 让平行光强度在 min-max 之间循环变化，
 * 给 3D 场景增加"活着"的感觉。
 *
 * @param light    要呼吸的光源
 * @param minI     最小强度，默认 0.6
 * @param maxI     最大强度，默认 1.0
 * @param duration 一个周期持续时间（ms），默认 3000
 */
export function playLightBreathing(
  light: THREE.Light,
  minI = 0.6,
  maxI = 1.0,
  duration = 3000,
): JSAnimation {
  // 确保有 userData 记录
  if (!(light as any).userData) (light as any).userData = {};
  (light as any).userData.targetIntensity = maxI;

  const anim = animate(light, {
    intensity: [minI, maxI, minI],
    duration,
    loop: true,
    alternate: false,
    ease: 'inOutSine',
  });

  trackAnimation(anim);
  return anim;
}

// ───────────────────────── P1: 设备切换过渡 ─────────────────────────

/**
 * 设备切换过渡 Timeline
 *
 * 旧设备旋转退场 → 新设备旋转入场。
 * 配合 CanvasStage 的 2D/3D 切换使用。
 *
 * @param oldScene  旧模型场景（退场）
 * @param newScene  新模型场景（入场）
 * @param duration  过渡总时长（ms），默认 600
 */
export function playDeviceSwitch(
  oldScene: THREE.Object3D | null,
  newScene: THREE.Object3D,
  duration = 600,
): Timeline {
  const tl = createTimeline({ defaults: { ease: 'inOutQuad' } });

  // 旧模型退场
  if (oldScene) {
    tl.add(oldScene.rotation, { y: [0, Math.PI * 0.5] }, 0)
      .add(oldScene.position, { y: [0, -1] }, 0)
      .add(oldScene.scale, { x: [1, 0.3], y: [1, 0.3], z: [1, 0.3] }, 0);
  }

  // 新模型入场
  newScene.position.y = oldScene ? -1 : -2;
  newScene.rotation.y = oldScene ? -Math.PI * 0.5 : -Math.PI * 0.5;
  newScene.scale.set(0.3, 0.3, 0.3);

  const offset = oldScene ? duration * 0.4 : 0;
  tl.add(newScene.position, { y: 0 }, offset)
    .add(newScene.rotation, { y: 0 }, offset)
    .add(newScene.scale, { x: 1, y: 1, z: 1 }, offset);

  return trackAnimation(tl);
}

// ───────────────────────── P1: 2D FLIP 布局过渡 ─────────────────────────

/**
 * 2D DOM 元素 FLIP 过渡
 *
 * 在 DSL 更新前后对 DOM 元素做 FLIP (First-Last-Invert-Play) 过渡，
 * 让 2D 模式下 DSL 更新从"闪烁刷新"变成"平滑变形"。
 *
 * 使用 anime.js v4.5 的 createLayout API。
 *
 * @param rootEl DSL 渲染根元素
 */
export function play2DLayoutTransition(rootEl: HTMLElement): void {
  // anime.js v4.5 createLayout: 记录当前布局 → DOM 更新后调 .reposition()
  try {
    const { createLayout } = require('animejs');
    const layout = createLayout(rootEl);
    // 在下一次 DOM 更新后自动 reposition
    requestAnimationFrame(() => {
      layout.reposition({
        duration: 400,
        ease: 'outElastic(1, 0.6)',
      });
    });
  } catch {
    // createLayout 可能需要特定 DOM 结构，降级为简单淡入
    rootEl.style.opacity = '0';
    animate(rootEl, {
      opacity: [0, 1],
      duration: 300,
      ease: 'outQuad',
    });
  }
}

// ───────────────────────── P2: scrambleText 流式文本解码 ─────────────────────────

/**
 * 文本 scramble 解码效果
 *
 * 在 LLM 流式生成文本时，用乱码→揭示效果替代直接文本更新，
 * 增强科技感。
 *
 * @param element  目标 DOM 元素
 * @param finalText 最终文本
 * @param duration 持续时间（ms），默认 600
 */
export function playScrambleText(
  element: HTMLElement,
  finalText: string,
  duration = 600,
): void {
  try {
    const { scrambleText } = require('animejs');
    scrambleText(element, {
      text: finalText,
      duration,
      chars: '01░▒▓█',
      reveal: 3,
    });
  } catch {
    // 降级：直接设置文本
    element.textContent = finalText;
  }
}

// ───────────────────────── 工具函数 ─────────────────────────

/**
 * 在 R3F useFrame 中提交 anime.js Three.js 变更
 *
 * anime.js 的 Three.js 适配器会自动在每帧 render 前 flush，
 * 但如果需要在 useFrame 中手动读取矩阵数据，需要先调用此函数。
 *
 * @param mesh InstancedMesh 或 BatchedMesh
 */
export function commitThreeChanges(mesh: THREE.Object3D): void {
  try {
    const { commitChanges } = require('animejs/adapters/three');
    commitChanges(mesh);
  } catch { /* ignore for non-instanced meshes */ }
}
