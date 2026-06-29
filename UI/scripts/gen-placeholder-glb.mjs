// scripts/gen-placeholder-glb.mjs
//
// 用途:
//   为 device-config.json 里的所有 3D model 生成最小合规的 .glb 占位文件
//   解决 s1.6 校验报的 "GLB not found" 错误
//
// 工作原理:
//   手写 GLB 二进制 = JSON header (12字节) + JSON chunk + BIN chunk
//   几何: 1 个 BoxGeometry (24 顶点, 36 索引) — 标识这个 model 存在
//   文件结构: 24 byte header + 8 byte JSON chunk header + JSON + 8 byte BIN chunk header + BIN
//
// 触发:
//   node scripts/gen-placeholder-glb.mjs
//   node scripts/gen-placeholder-glb.mjs --dry-run
//
// 输出:
//   写到 <root>/resources/canvas/models/<group>/<filename>
//   例如: mobile/iphone_14.glb, tablet/ipad_pro_129.glb
//
// 验证:
//   ls resources/canvas/models/*/*.glb | wc -l  (期望 21)
//   node -e "import('fs').then(fs => { const buf = fs.readFileSync('resources/canvas/models/mobile/iphone_14_pro.glb'); console.log(buf.slice(0, 4).toString()); })"  (期望 "glTF")

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 根目录: UI/scripts -> UI
const ROOT = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(ROOT, 'resources', 'canvas', 'models');
const CONFIG_PATH = path.join(MODELS_DIR, 'device-config.json');

// CLI 参数
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose') || args.includes('-v');

// ─── 手写 GLB ─────────────────────────────────────────────

/**
 * 写一个最小合规 GLB 文件
 * 几何: BoxGeometry (单位 1x1x1, 中心在原点)
 * 顶点: 24 (6 面 × 4 顶点, 各面独立法线)
 * 索引: 36 (12 三角形)
 * 颜色: 顶点白色, 然后材质给 group 颜色
 *
 * @param {string} outPath 绝对路径
 * @param {string} label 写入 JSON 的 _label 字段 (调试用, 不影响渲染)
 * @param {string} group group 名字 (desktop/mobile/tablet/watch)
 * @returns {number} 字节数
 */
function writePlaceholderGlb(outPath, label, group) {
  // ── 顶点数据 ──
  //   24 顶点, 每顶点 = position(3f) + normal(3f) + uv(2f) = 8 floats = 32 bytes
  //   共 24 * 32 = 768 bytes
  //   索引: 36 个 uint32 = 144 bytes (用 uint32 安全, 不用 uint16)

  // 6 个面的顶点 (每个面 4 顶点, CCW)
  //   -X (左), +X (右), -Y (下), +Y (上), -Z (后), +Z (前)
  //   法线分别指向 6 个方向
  //   UV 映射 [0,1]² (0,0 = bl, 1,1 = tr)
  const faces = [
    // -X 左
    { n: [-1, 0, 0], v: [[-0.5,-0.5,-0.5],[-0.5, 0.5,-0.5],[-0.5, 0.5, 0.5],[-0.5,-0.5, 0.5]] },
    // +X 右
    { n: [ 1, 0, 0], v: [[ 0.5,-0.5, 0.5],[ 0.5, 0.5, 0.5],[ 0.5, 0.5,-0.5],[ 0.5,-0.5,-0.5]] },
    // -Y 下
    { n: [ 0,-1, 0], v: [[-0.5,-0.5, 0.5],[ 0.5,-0.5, 0.5],[ 0.5,-0.5,-0.5],[-0.5,-0.5,-0.5]] },
    // +Y 上
    { n: [ 0, 1, 0], v: [[-0.5, 0.5,-0.5],[ 0.5, 0.5,-0.5],[ 0.5, 0.5, 0.5],[-0.5, 0.5, 0.5]] },
    // -Z 后
    { n: [ 0, 0,-1], v: [[ 0.5,-0.5,-0.5],[-0.5,-0.5,-0.5],[-0.5, 0.5,-0.5],[ 0.5, 0.5,-0.5]] },
    // +Z 前
    { n: [ 0, 0, 1], v: [[-0.5,-0.5, 0.5],[ 0.5,-0.5, 0.5],[ 0.5, 0.5, 0.5],[-0.5, 0.5, 0.5]] },
  ];

  // 组装 vertex buffer
  //   顶点顺序: 位置 → 法线 → UV (interleaved)
  //   UV 映射 (面 4 顶点):
  //     [0]: bl (0,0)
  //     [1]: br (1,0)
  //     [2]: tr (1,1)
  //     [3]: tl (0,1)
  //   三角形索引: (0,1,2) + (0,2,3) — CCW
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  const uvMap = [
    [0, 0], // bl
    [1, 0], // br
    [1, 1], // tr
    [0, 1], // tl
  ];

  for (const face of faces) {
    const baseIdx = positions.length / 3;
    for (let i = 0; i < 4; i++) {
      positions.push(face.v[i][0], face.v[i][1], face.v[i][2]);
      normals.push(face.n[0], face.n[1], face.n[2]);
      uvs.push(uvMap[i][0], uvMap[i][1]);
    }
    indices.push(
      baseIdx + 0, baseIdx + 1, baseIdx + 2,
      baseIdx + 0, baseIdx + 2, baseIdx + 3,
    );
  }

  // 打包 vertex bin (positions + normals + uvs interleaved)
  const vertexStride = (3 + 3 + 2) * 4; // 32 bytes
  const vertexCount = positions.length / 3;
  const vertexBin = Buffer.alloc(vertexCount * vertexStride);
  for (let i = 0; i < vertexCount; i++) {
    vertexBin.writeFloatLE(positions[i * 3 + 0], i * vertexStride + 0);
    vertexBin.writeFloatLE(positions[i * 3 + 1], i * vertexStride + 4);
    vertexBin.writeFloatLE(positions[i * 3 + 2], i * vertexStride + 8);
    vertexBin.writeFloatLE(normals[i * 3 + 0],   i * vertexStride + 12);
    vertexBin.writeFloatLE(normals[i * 3 + 1],   i * vertexStride + 16);
    vertexBin.writeFloatLE(normals[i * 3 + 2],   i * vertexStride + 20);
    vertexBin.writeFloatLE(uvs[i * 2 + 0],       i * vertexStride + 24);
    vertexBin.writeFloatLE(uvs[i * 2 + 1],       i * vertexStride + 28);
  }

  // 打包 index bin (uint32)
  const indexBin = Buffer.alloc(indices.length * 4);
  for (let i = 0; i < indices.length; i++) {
    indexBin.writeUInt32LE(indices[i], i * 4);
  }

  // BIN chunk = vertex + index, padding 到 4 字节边界
  const binBuffer = Buffer.concat([vertexBin, indexBin]);
  const binPaddedLength = Math.ceil(binBuffer.length / 4) * 4;
  const binPadding = binPaddedLength - binBuffer.length;
  const binFinal = Buffer.concat([binBuffer, Buffer.alloc(binPadding, 0)]);

  // ── JSON 描述 ──
  //   accessor 0: vertex (position+normal+uv) — type=VEC3 (interleaved) → 用 VEC3 buffer view
  //   简化: 用 2 个 accessor (positions VEC3, normals VEC3, uvs VEC2) + 1 个 indices SCALAR
  const POSITION_OFFSET = 0;
  const NORMAL_OFFSET = vertexCount * 12; // 3 floats
  const UV_OFFSET = vertexCount * 24;     // 6 floats
  const INDEX_OFFSET = vertexBin.length;

  const json = {
    asset: {
      version: '2.0',
      generator: 'soloforge/gen-placeholder-glb.mjs',
      // 调试字段: 标记这个文件是占位 (s2.1 three_d 加载时可识别)
      copyright: `placeholder for ${label} (group=${group})`,
    },
    scene: 0,
    scenes: [
      { nodes: [0] },
    ],
    nodes: [
      { mesh: 0, name: label },
    ],
    meshes: [
      {
        name: `${group}-${label}`,
        primitives: [
          {
            attributes: {
              POSITION: 0,
              NORMAL: 1,
              TEXCOORD_0: 2,
            },
            indices: 3,
            mode: 4, // TRIANGLES
            material: 0,
          },
        ],
      },
    ],
    materials: [
      {
        name: `${group}-material`,
        pbrMetallicRoughness: {
          baseColorFactor: getGroupColor(group),
          metallicFactor: 0.0,
          roughnessFactor: 0.6,
        },
      },
    ],
    accessors: [
      // 0: POSITION VEC3
      {
        bufferView: 0,
        byteOffset: POSITION_OFFSET,
        componentType: 5126, // FLOAT
        count: vertexCount,
        type: 'VEC3',
        min: [-0.5, -0.5, -0.5],
        max: [0.5, 0.5, 0.5],
      },
      // 1: NORMAL VEC3
      {
        bufferView: 0,
        byteOffset: NORMAL_OFFSET,
        componentType: 5126, // FLOAT
        count: vertexCount,
        type: 'VEC3',
      },
      // 2: TEXCOORD_0 VEC2
      {
        bufferView: 0,
        byteOffset: UV_OFFSET,
        componentType: 5126, // FLOAT
        count: vertexCount,
        type: 'VEC2',
      },
      // 3: indices SCALAR
      {
        bufferView: 1,
        byteOffset: 0,
        componentType: 5125, // UNSIGNED_INT
        count: indices.length,
        type: 'SCALAR',
      },
    ],
    bufferViews: [
      // 0: vertex (positions+normals+uvs interleaved)
      {
        buffer: 0,
        byteOffset: 0,
        byteLength: vertexBin.length,
        byteStride: vertexStride,
        target: 34962, // ARRAY_BUFFER
      },
      // 1: index
      {
        buffer: 0,
        byteOffset: INDEX_OFFSET,
        byteLength: indexBin.length,
        target: 34963, // ELEMENT_ARRAY_BUFFER
      },
    ],
    buffers: [
      {
        byteLength: binFinal.length,
      },
    ],
  };

  // JSON 字符串
  const jsonStr = JSON.stringify(json);
  // padding 到 4 字节边界 (用空格, 不是 0)
  const jsonPaddedLength = Math.ceil(jsonStr.length / 4) * 4;
  const jsonPadding = jsonPaddedLength - jsonStr.length;
  const jsonFinal = jsonStr + ' '.repeat(jsonPadding);

  // ── GLB header ──
  //   12 bytes: magic "glTF" (4) + version uint32 (4) + length uint32 (4)
  //   8 bytes chunk header: length uint32 + type uint32
  //   total = 12 + 8 + jsonFinal.length + 8 + binFinal.length
  const totalLength = 12 + 8 + jsonFinal.length + 8 + binFinal.length;
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 4, 'ascii');
  header.writeUInt32LE(2, 4); // version
  header.writeUInt32LE(totalLength, 8);

  const jsonChunkHeader = Buffer.alloc(8);
  jsonChunkHeader.writeUInt32LE(jsonFinal.length, 0);
  jsonChunkHeader.writeUInt32LE(0x4E4F534A, 4); // "JSON"

  const binChunkHeader = Buffer.alloc(8);
  binChunkHeader.writeUInt32LE(binFinal.length, 0);
  binChunkHeader.writeUInt32LE(0x004E4942, 4); // "BIN\0"

  const glb = Buffer.concat([
    header,
    jsonChunkHeader,
    Buffer.from(jsonFinal, 'ascii'),
    binChunkHeader,
    binFinal,
  ]);

  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, glb);
  }

  return glb.length;
}

function getGroupColor(group) {
  // s1.7 占位卡片用色, 这里给 GLB 材质同一调色板 (RGBA 0~1)
  switch (group) {
    case 'desktop': return [0.18, 0.22, 0.32, 1.0]; // 深蓝
    case 'mobile':  return [0.16, 0.34, 0.24, 1.0]; // 深绿
    case 'tablet':  return [0.28, 0.18, 0.36, 1.0]; // 深紫
    case 'watch':   return [0.42, 0.18, 0.18, 1.0]; // 深红
    default:        return [0.30, 0.30, 0.30, 1.0]; // 深灰
  }
}

// ─── 主流程 ──────────────────────────────────────────────

function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`[gen-placeholder-glb] FATAL: device-config.json not found at ${CONFIG_PATH}`);
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  const models = config.models || {};

  // 统计
  let generated = 0;
  let skipped = 0;
  let failed = 0;
  const seen = new Set();

  for (const [key, m] of Object.entries(models)) {
    if (!m.file) {
      if (VERBOSE) console.log(`  [skip] ${key}: no file (type=${m.type || 'unknown'})`);
      skipped++;
      continue;
    }
    if (m.type !== '3d') {
      if (VERBOSE) console.log(`  [skip] ${key}: type=${m.type} (not 3D)`);
      skipped++;
      continue;
    }
    if (seen.has(m.file)) {
      if (VERBOSE) console.log(`  [skip] ${key}: file ${m.file} already processed`);
      skipped++;
      continue;
    }
    seen.add(m.file);

    const outPath = path.join(MODELS_DIR, m.file);
    const exists = fs.existsSync(outPath);
    if (exists) {
      if (VERBOSE) console.log(`  [exists] ${m.file}`);
      skipped++;
      continue;
    }

    try {
      const bytes = writePlaceholderGlb(outPath, key, m.group);
      console.log(`  [${DRY_RUN ? 'would-generate' : 'generated'}] ${m.file} (${bytes} bytes, group=${m.group})`);
      generated++;
    } catch (e) {
      console.error(`  [FAILED] ${m.file}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n[gen-placeholder-glb] summary: generated=${generated}, skipped=${skipped}, failed=${failed}`);
  if (DRY_RUN) {
    console.log('[gen-placeholder-glb] DRY-RUN: no files written');
  }
  if (failed > 0) process.exit(2);
}

main();
