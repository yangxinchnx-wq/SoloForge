/**
 * DslToR3f.tsx — UniversalNode DSL 的 R3F 原生版本渲染器
 *
 * 用途：把 UniversalNode DSL 渲染成 R3F 原生组件（<mesh>/<Text>/<RoundedBox>），
 *       用于 3D 场景下的 RTT (Render To Texture) 贴图。
 *       WebAstPreview 是 React DOM 版本，无法直接用于 RTT，因此这里实现 R3F 原生版本。
 *
 * 布局策略：自实现简单 flex 布局
 *   - container/column : 垂直堆叠（高度 = parentHeight / childrenCount）
 *   - row              : 水平堆叠（宽度 = parentWidth / childrenCount）
 *   - stack            : 全覆盖（所有子节点占满父容器）
 *   - 其余节点         : 按自身 style 渲染
 *
 * 每个 mesh 加 0.01 的 z 偏移以避免 z-fighting。
 *
 * ★ 2026-07-16: 集成 anime.js v4.5.0 — DSL 节点 stagger 入场动画
 *   - 根节点下的直接子节点逐个浮现（scale 0→1 + opacity 0→1）
 *   - 3D Stagger 网格 + center 起始 + 可选 jitter
 */

import * as React from 'react';
import * as THREE from 'three';
import { Text, RoundedBox } from '@react-three/drei';
import { useLoader, useFrame } from '@react-three/fiber';
import type { UniversalNode, UniversalStyle, ChartSeries } from '../services/canvas/UniversalAST';
import { playStaggerEntrance, cancelAllCanvasAnimations } from '../services/canvas/canvasAnimations';

// ───────────────────────────── 颜色 / 尺寸工具 ─────────────────────────────

const DEFAULT_BG = '#ffffff';
const DEFAULT_FG = '#000000';

/** 解析颜色：支持 #RRGGBB / #RGB / 颜色名；失败时返回 fallback */
function parseColor(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  const s = input.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  }
  // 命名色 / rgb() 等交给 three 解析；解析失败则回退
  try {
    // eslint-disable-next-line no-new
    new THREE.Color(s);
    return s;
  } catch {
    return fallback;
  }
}

/** 从 style.width / style.height 取数值（px），否则返回 fallback */
function px(v: number | string | undefined, fallback: number): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const m = v.match(/^([\d.]+)(px)?$/);
    if (m) return parseFloat(m[1]);
  }
  return fallback;
}

/** 解析 padding，返回 [top, right, bottom, left] */
function paddingOf(style: UniversalStyle | undefined): [number, number, number, number] {
  const p = style?.padding;
  if (typeof p === 'number') return [p, p, p, p];
  if (Array.isArray(p)) {
    if (p.length === 2) return [p[0], p[1], p[0], p[1]];
    if (p.length === 4) return [p[0], p[1], p[2], p[3]];
  }
  return [0, 0, 0, 0];
}

// ───────────────────────────── 组件 ─────────────────────────────

export interface DslToR3fProps {
  node: UniversalNode;
  width: number;
  height: number;
}

export default function DslToR3f({ node, width, height }: DslToR3fProps): React.JSX.Element {
  const groupRef = React.useRef<THREE.Group>(null);
  const staggerPlayedRef = React.useRef<string | null>(null);

  // ★ anime.js stagger 入场动画：根节点的直接子节点逐个浮现
  // 每次 node 变化时重新触发（用 node 引用做 key 防止重复触发）
  React.useEffect(() => {
    if (!groupRef.current) return;

    // 用 node 的 JSON 作为指纹，避免同一内容重复动画
    const fingerprint = JSON.stringify(node).slice(0, 64);
    if (staggerPlayedRef.current === fingerprint) return;
    staggerPlayedRef.current = fingerprint;

    const group = groupRef.current;
    // 收集第一层子节点中的 mesh
    const childObjects: THREE.Object3D[] = [];
    const childMaterials: THREE.Material[] = [];

    group.children.forEach((child) => {
      child.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh && mesh.material) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach((m) => {
            childMaterials.push(m);
            childObjects.push(mesh);
          });
        }
      });
    });

    if (childObjects.length > 0) {
      requestAnimationFrame(() => {
        playStaggerEntrance(childObjects, childMaterials, {
          duration: 400,
          staggerDelay: 50,
          from: 'center',
          ease: 'easeOutBack',
          grid: [2, 2, 1],
          jitter: [0, 20],
          seed: 42,
        });
      });
    }

    return () => {
      cancelAllCanvasAnimations();
    };
  }, [node]);

  return (
    <group ref={groupRef}>
      {renderNode(node, width, height, 0, 0, 'root')}
    </group>
  );
}

/**
 * 递归渲染单个节点。
 *
 * @param node          当前 UniversalNode
 * @param parentWidth   父容器可用宽度
 * @param parentHeight  父容器可用高度
 * @param offsetX       当前节点在父内的 x 偏移（左上角原点）
 * @param offsetY       当前节点在父内的 y 偏移
 * @param key           React key
 */
function renderNode(
  node: UniversalNode,
  parentWidth: number,
  parentHeight: number,
  offsetX: number,
  offsetY: number,
  key: string,
): React.JSX.Element {
  const style = (node as { style?: UniversalStyle }).style;
  const bg = parseColor(style?.background, DEFAULT_BG);
  const fg = parseColor(style?.color, DEFAULT_FG);
  const opacity = style?.opacity ?? 1;
  const radius = style?.radius ?? 0;

  // offsetX/offsetY 是 UI 坐标系（左上原点，向右下）下的偏移；
  // R3F 坐标系原点在父容器中心，y 向上。容器类节点用 group 偏移把子节点放到正确位置。
  void offsetX;
  void offsetY;

  switch (node.type) {
    case 'container':
    case 'column': {
      const children = node.children ?? [];
      const [pt, , , pl] = paddingOf(style);
      const innerW = parentWidth - pl * 2;
      const innerH = parentHeight - pt * 2;
      const gap = style?.gap ?? 0;
      const childH = children.length > 0 ? (innerH - gap * (children.length - 1)) / children.length : innerH;
      return (
        <group key={key} position={[0, 0, 0.01]}>
          {/* 背板 */}
          <mesh position={[0, 0, 0]}>
            <planeGeometry args={[parentWidth, parentHeight]} />
            <meshBasicMaterial color={bg} transparent={opacity < 1} opacity={opacity} />
          </mesh>
          {children.map((child, i) => {
            // 第 i 个子节点在父内（UI 坐标系，左上原点）的顶端 y = pt + i*(childH+gap)
            // R3F 中父中心为原点，y 向上：子中心 y = innerH/2 - pt - i*(childH+gap) - childH/2
            const cy = innerH / 2 - pt - i * (childH + gap) - childH / 2;
            return (
              <group key={`c-${i}`} position={[0, cy, 0]}>
                {renderNode(child, innerW, childH, 0, 0, `${key}-${i}`)}
              </group>
            );
          })}
        </group>
      );
    }

    case 'row': {
      const children = node.children ?? [];
      const [pt, , , pl] = paddingOf(style);
      const innerW = parentWidth - pl * 2;
      const innerH = parentHeight - pt * 2;
      const gap = style?.gap ?? 0;
      const childW = children.length > 0 ? (innerW - gap * (children.length - 1)) / children.length : innerW;
      return (
        <group key={key} position={[0, 0, 0.01]}>
          <mesh position={[0, 0, 0]}>
            <planeGeometry args={[parentWidth, parentHeight]} />
            <meshBasicMaterial color={bg} transparent={opacity < 1} opacity={opacity} />
          </mesh>
          {children.map((child, i) => {
            // R3F 中父中心为原点，x 向右：子中心 x = -innerW/2 + pl + i*(childW+gap) + childW/2
            const cx = -innerW / 2 + pl + i * (childW + gap) + childW / 2;
            return (
              <group key={`r-${i}`} position={[cx, 0, 0]}>
                {renderNode(child, childW, innerH, 0, 0, `${key}-${i}`)}
              </group>
            );
          })}
        </group>
      );
    }

    case 'stack': {
      const children = node.children ?? [];
      return (
        <group key={key} position={[0, 0, 0.01]}>
          <mesh position={[0, 0, 0]}>
            <planeGeometry args={[parentWidth, parentHeight]} />
            <meshBasicMaterial color={bg} transparent={opacity < 1} opacity={opacity} />
          </mesh>
          {children.map((child, i) => (
            <group key={`s-${i}`} position={[0, 0, 0.01 * (i + 1)]}>
              {renderNode(child, parentWidth, parentHeight, 0, 0, `${key}-${i}`)}
            </group>
          ))}
        </group>
      );
    }

    case 'text': {
      const fontSize = style?.fontSize ?? 16;
      const align = style?.textAlign ?? 'left';
      const anchorX: 'left' | 'center' | 'right' = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
      return (
        <group key={key} position={[0, 0, 0.01]}>
          <mesh position={[0, 0, 0]}>
            <planeGeometry args={[parentWidth, parentHeight]} />
            <meshBasicMaterial color={bg} transparent={opacity < 1} opacity={opacity} />
          </mesh>
          <Text
            position={[0, 0, 0.01]}
            fontSize={fontSize}
            color={fg}
            anchorX={anchorX}
            anchorY="middle"
            maxWidth={parentWidth}
          >
            {node.content}
          </Text>
        </group>
      );
    }

    case 'button': {
      const btnH = px(style?.height, 40);
      const btnW = px(style?.width, parentWidth);
      const filled = node.variant !== 'outlined' && node.variant !== 'text';
      const btnBg = filled ? parseColor(style?.background, '#007aff') : bg;
      const btnFg = filled ? parseColor(style?.color, '#ffffff') : fg;
      return (
        <group key={key} position={[0, 0, 0.01]}>
          <RoundedBox args={[btnW, btnH, 0.02]} radius={Math.min(radius || 8, btnH / 2)} smoothness={4} position={[0, 0, 0]}>
            <meshBasicMaterial color={btnBg} transparent={opacity < 1} opacity={opacity} />
          </RoundedBox>
          <Text position={[0, 0, 0.02]} fontSize={style?.fontSize ?? 16} color={btnFg} anchorX="center" anchorY="middle">
            {node.label}
          </Text>
        </group>
      );
    }

    case 'input': {
      const h = px(style?.height, 36);
      const w = px(style?.width, parentWidth);
      return (
        <group key={key} position={[0, 0, 0.01]}>
          <mesh position={[0, 0, 0]}>
            <planeGeometry args={[w, h]} />
            <meshBasicMaterial color={bg} transparent={opacity < 1} opacity={opacity} />
          </mesh>
          <Text
            position={[-w / 2 + 8, 0, 0.01]}
            fontSize={style?.fontSize ?? 14}
            color={parseColor(style?.color, '#999999')}
            anchorX="left"
            anchorY="middle"
            maxWidth={w - 16}
          >
            {node.value || node.placeholder || ''}
          </Text>
        </group>
      );
    }

    case 'image': {
      const w = px(style?.width, parentWidth);
      const h = px(style?.height, parentHeight);
      if (!node.src) {
        return (
          <mesh key={key} position={[0, 0, 0.01]}>
            <planeGeometry args={[w, h]} />
            <meshBasicMaterial color={parseColor(style?.background, '#eeeeee')} transparent={opacity < 1} opacity={opacity} />
          </mesh>
        );
      }
      return <ImagePlane key={key} src={node.src} w={w} h={h} bg={bg} opacity={opacity} />;
    }

    case 'divider': {
      const h = px(style?.height, 1);
      return (
        <mesh key={key} position={[0, 0, 0.01]}>
          <planeGeometry args={[parentWidth, h]} />
          <meshBasicMaterial color={parseColor(style?.background, '#cccccc')} transparent={opacity < 1} opacity={opacity} />
        </mesh>
      );
    }

    case 'spacer': {
      return <group key={key} />;
    }

    case 'icon': {
      const size = node.size ?? 24;
      const iconColor = parseColor(node.color ?? style?.color, fg);
      return (
        <group key={key} position={[0, 0, 0.01]}>
          <mesh position={[0, 0, 0]}>
            <planeGeometry args={[size, size]} />
            <meshBasicMaterial color={iconColor} transparent={opacity < 1} opacity={opacity} />
          </mesh>
        </group>
      );
    }

    case 'progress': {
      const w = px(style?.width, parentWidth);
      const h = px(style?.height, 6);
      const track = parseColor(node.trackColor ?? style?.background, '#e0e0e0');
      const fill = parseColor(node.color ?? style?.color, '#007aff');
      const ratio = Math.max(0, Math.min(100, node.value)) / 100;
      return (
        <group key={key} position={[0, 0, 0.01]}>
          <mesh position={[0, 0, 0]}>
            <planeGeometry args={[w, h]} />
            <meshBasicMaterial color={track} transparent={opacity < 1} opacity={opacity} />
          </mesh>
          <mesh position={[-w / 2 + (w * ratio) / 2, 0, 0.01]}>
            <planeGeometry args={[w * ratio, h]} />
            <meshBasicMaterial color={fill} transparent={opacity < 1} opacity={opacity} />
          </mesh>
        </group>
      );
    }

    case 'chart': {
      // ★ 2026-07-16: 用离屏 Canvas 2D 绘制图表 → CanvasTexture（真实渲染，非色块占位）
      const w = px(style?.width, parentWidth);
      const h = px(style?.height, parentHeight);
      return <ChartPlane key={key} series={node.series} chartType={node.chartType} labels={node.labels} width={w} height={h} opacity={opacity} />;
    }

    case 'video': {
      // ★ 2026-07-16: 用 THREE.VideoTexture 把视频作为纹理（真实播放，非占位）
      const w = px(style?.width, parentWidth);
      const h = px(style?.height, parentHeight);
      return <VideoPlane key={key} src={node.src} poster={node.poster} autoPlay={node.autoPlay} loop={node.loop} width={w} height={h} opacity={opacity} />;
    }

    case 'svg': {
      // 简化：纯色矩形占位（无法直接把 SVG 字符串渲染到 R3F）
      const w = px(style?.width, parentWidth);
      const h = px(style?.height, parentHeight);
      return (
        <mesh key={key} position={[0, 0, 0.01]}>
          <planeGeometry args={[w, h]} />
          <meshBasicMaterial color={bg} transparent={opacity < 1} opacity={opacity} />
        </mesh>
      );
    }

    case 'canvas': {
      // 简化：执行 draw 指令中的 rect/circle（用 mesh 近似）
      const w = px(style?.width, parentWidth);
      const h = px(style?.height, parentHeight);
      return (
        <group key={key} position={[0, 0, 0.01]}>
          <mesh position={[0, 0, 0]}>
            <planeGeometry args={[w, h]} />
            <meshBasicMaterial color={bg} transparent={opacity < 1} opacity={opacity} />
          </mesh>
          {(node.draw ?? []).map((op, i) => {
            if (op.op === 'rect') {
              const rw = op.w ?? 10;
              const rh = op.h ?? 10;
              const rx = (op.x ?? 0) - w / 2 + rw / 2;
              const ry = -((op.y ?? 0) - h / 2 + rh / 2);
              return (
                <mesh key={`d-${i}`} position={[rx, ry, 0.01]}>
                  <planeGeometry args={[rw, rh]} />
                  <meshBasicMaterial color={parseColor(op.fill ?? op.stroke, fg)} />
                </mesh>
              );
            }
            if (op.op === 'circle') {
              const r = op.r ?? 5;
              const cx2 = (op.cx ?? 0) - w / 2;
              const cy2 = -((op.cy ?? 0) - h / 2);
              return (
                <mesh key={`d-${i}`} position={[cx2, cy2, 0.01]}>
                  <circleGeometry args={[r, 24]} />
                  <meshBasicMaterial color={parseColor(op.fill ?? op.stroke, fg)} />
                </mesh>
              );
            }
            return null;
          })}
        </group>
      );
    }

    default: {
      // 兜底：未知节点画透明矩形
      return (
        <mesh key={key} position={[0, 0, 0.01]}>
          <planeGeometry args={[parentWidth, parentHeight]} />
          <meshBasicMaterial color={bg} transparent={opacity < 1} opacity={opacity} />
        </mesh>
      );
    }
  }
}

// ───────────────────────────── 子组件 ─────────────────────────────

/** 带纹理的图片平面（useLoader 加载图片纹理） */
function ImagePlane({
  src,
  w,
  h,
  bg,
  opacity,
}: {
  src: string;
  w: number;
  h: number;
  bg: string;
  opacity: number;
}): React.JSX.Element {
  const texture = useLoader(THREE.TextureLoader, src);
  return (
    <group position={[0, 0, 0.01]}>
      <mesh position={[0, 0, 0]}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial map={texture} color={bg} transparent={opacity < 1} opacity={opacity} />
      </mesh>
    </group>
  );
}

// ───────────────────────────── ChartPlane 子组件 ─────────────────────────────
// 用离屏 Canvas 2D 绘制 bar/line/pie 图表 → CanvasTexture → 贴到 plane 上
// 不依赖 recharts（DOM 库），纯 Canvas 2D API 实现，可在 R3F RTT 中使用

interface ChartPlaneProps {
  series: ChartSeries[];
  chartType: 'bar' | 'line' | 'pie';
  labels?: string[];
  width: number;
  height: number;
  opacity: number;
}

function ChartPlane({ series, chartType, labels, width, height, opacity }: ChartPlaneProps): React.JSX.Element {
  const textureRef = React.useRef<THREE.CanvasTexture | null>(null);

  const texture = React.useMemo(() => {
    const canvas = document.createElement('canvas');
    const dpr = 2; // 高清渲染
    canvas.width = Math.max(64, width * dpr);
    canvas.height = Math.max(64, height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return new THREE.CanvasTexture(canvas);

    ctx.scale(dpr, dpr);
    drawChart(ctx, series, chartType, labels, width, height);

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    textureRef.current = tex;
    return tex;
  }, [series, chartType, labels, width, height]);

  // 组件卸载时释放纹理
  React.useEffect(() => {
    return () => { textureRef.current?.dispose(); };
  }, []);

  return (
    <group position={[0, 0, 0.01]}>
      <mesh position={[0, 0, 0]}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial map={texture} transparent={opacity < 1} opacity={opacity} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** 在 Canvas 2D 上下文中绘制 bar/line/pie 图表 */
function drawChart(
  ctx: CanvasRenderingContext2D,
  series: ChartSeries[],
  chartType: 'bar' | 'line' | 'pie',
  labels: string[] | undefined,
  w: number,
  h: number,
): void {
  // 背景
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  if (!series || series.length === 0 || !series[0].data || series[0].data.length === 0) {
    ctx.fillStyle = '#999';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('无数据', w / 2, h / 2);
    return;
  }

  const padding = { top: 20, right: 16, bottom: 24, left: 32 };
  const chartW = w - padding.left - padding.right;
  const chartH = h - padding.top - padding.bottom;
  const allData = series.flatMap((s) => s.data);
  const maxVal = Math.max(...allData, 1);

  if (chartType === 'bar') {
    // 柱状图
    const data = series[0].data;
    const barCount = data.length;
    const barW = (chartW / barCount) * 0.7;
    const barGap = (chartW / barCount) * 0.3;
    const color = series[0].color || '#3b82f6';

    // Y 轴刻度
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (chartH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();
    }

    // 柱子
    data.forEach((v, i) => {
      const barH = (v / maxVal) * chartH;
      const x = padding.left + i * (barW + barGap) + barGap / 2;
      const y = padding.top + chartH - barH;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, barW, barH);
    });

    // X 轴标签
    ctx.fillStyle = '#666';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    data.forEach((v, i) => {
      const x = padding.left + i * (barW + barGap) + barGap / 2 + barW / 2;
      const label = labels?.[i] || `${i + 1}`;
      ctx.fillText(label, x, h - 6);
    });
  } else if (chartType === 'line') {
    // 折线图
    const padding2 = { top: 20, right: 16, bottom: 24, left: 32 };
    const cw = w - padding2.left - padding2.right;
    const ch = h - padding2.top - padding2.bottom;

    // 网格线
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padding2.top + (ch / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padding2.left, y);
      ctx.lineTo(w - padding2.right, y);
      ctx.stroke();
    }

    series.forEach((s) => {
      const data = s.data;
      const color = s.color || '#3b82f6';
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      data.forEach((v, i) => {
        const x = padding2.left + (cw / (data.length - 1)) * i;
        const y = padding2.top + ch - (v / maxVal) * ch;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // 数据点
      ctx.fillStyle = color;
      data.forEach((v, i) => {
        const x = padding2.left + (cw / (data.length - 1)) * i;
        const y = padding2.top + ch - (v / maxVal) * ch;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      });
    });
  } else if (chartType === 'pie') {
    // 饼图
    const data = series[0].data;
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) / 2 - 10;
    const total = data.reduce((a, b) => a + b, 0) || 1;
    const colors = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];

    let startAngle = -Math.PI / 2;
    data.forEach((v, i) => {
      const sliceAngle = (v / total) * Math.PI * 2;
      ctx.fillStyle = colors[i % colors.length];
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, startAngle, startAngle + sliceAngle);
      ctx.closePath();
      ctx.fill();
      startAngle += sliceAngle;
    });
  }
}

// ───────────────────────────── VideoPlane 子组件 ─────────────────────────────
// 用 THREE.VideoTexture 把视频元素作为纹理贴到 plane 上

interface VideoPlaneProps {
  src: string;
  poster?: string;
  autoPlay?: boolean;
  loop?: boolean;
  width: number;
  height: number;
  opacity: number;
}

function VideoPlane({ src, poster, autoPlay, loop, width, height, opacity }: VideoPlaneProps): React.JSX.Element {
  const textureRef = React.useRef<THREE.VideoTexture | null>(null);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);

  const texture = React.useMemo(() => {
    const video = document.createElement('video');
    video.src = src;
    video.crossOrigin = 'anonymous';
    video.muted = true; // 自动播放需要静音
    video.loop = loop ?? false;
    video.playsInline = true;
    if (poster) video.poster = poster;
    videoRef.current = video;

    const tex = new THREE.VideoTexture(video);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    textureRef.current = tex;

    if (autoPlay) {
      video.play().catch(() => { /* 自动播放可能被浏览器阻止，忽略 */ });
    }

    return tex;
  }, [src, poster, autoPlay, loop]);

  // 组件卸载时释放视频和纹理
  React.useEffect(() => {
    return () => {
      const video = videoRef.current;
      if (video) {
        video.pause();
        video.src = '';
      }
      textureRef.current?.dispose();
    };
  }, []);

  return (
    <group position={[0, 0, 0.01]}>
      <mesh position={[0, 0, 0]}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial map={texture} transparent={opacity < 1} opacity={opacity} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}
