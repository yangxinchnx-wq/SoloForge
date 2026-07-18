const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'resources', 'canvas', 'models', '3d', 'mobile');
const file = 'iphone_15_pro_max.glb';
const p = path.join(dir, file);
const buf = fs.readFileSync(p);

// Parse GLB header
const magic = buf.toString('ascii', 0, 4);
const version = buf.readUInt32LE(4);
const length = buf.readUInt32LE(8);
const chunkLen = buf.readUInt32LE(12);
const chunkType = buf.toString('ascii', 16, 20);
const json = JSON.parse(buf.toString('utf8', 20, 20 + chunkLen));

// Second chunk (BIN data)
const binOffset = 20 + chunkLen;
const binLen = buf.readUInt32LE(binOffset);
const binType = buf.toString('ascii', binOffset + 4, binOffset + 8);
const binData = buf.slice(binOffset + 8, binOffset + 8 + binLen);

console.log(`=== ${file} ===`);
console.log(`magic: ${magic}, version: ${version}, length: ${length}`);
console.log(`JSON chunk: ${chunkLen} bytes, BIN chunk: ${binLen} bytes, type: ${binType}`);

// Accessors
console.log(`\naccessors: ${json.accessors ? json.accessors.length : 0}`);

// Buffers / bufferViews
console.log(`bufferViews: ${json.bufferViews ? json.bufferViews.length : 0}`);

// Nodes
console.log(`nodes: ${json.nodes ? json.nodes.length : 0}`);
if (json.nodes) {
  json.nodes.forEach((n, i) => {
    console.log(`  node[${i}]: name="${n.name || '(unnamed)'}", mesh=${n.mesh !== undefined ? n.mesh : 'none'}, children=${n.children ? n.children.length : 0}, translation=${JSON.stringify(n.translation || 'none')}, rotation=${JSON.stringify(n.rotation || 'none')}, scale=${JSON.stringify(n.scale || 'none')}`);
  });
}

// Helper: read accessor data
function readAccessor(accIdx) {
  const acc = json.accessors[accIdx];
  const bv = json.bufferViews[acc.bufferView];
  const offset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const count = acc.count;
  const type = acc.type;
  const compType = acc.componentType;

  let compSize;
  let reader;
  if (compType === 5126) { // FLOAT
    compSize = 4;
    reader = (off) => binData.readFloatLE(off);
  } else if (compType === 5123) { // UNSIGNED_SHORT
    compSize = 2;
    reader = (off) => binData.readUInt16LE(off);
  } else if (compType === 5121) { // UNSIGNED_BYTE
    compSize = 1;
    reader = (off) => binData.readUInt8(off);
  } else if (compType === 5122) { // SHORT
    compSize = 2;
    reader = (off) => binData.readInt16LE(off);
  } else {
    return null;
  }

  const numComponents = {
    'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4
  }[type] || 1;

  const stride = bv.byteStride || (compSize * numComponents);
  const result = [];
  for (let i = 0; i < count; i++) {
    const baseOff = offset + i * stride;
    const comps = [];
    for (let c = 0; c < numComponents; c++) {
      comps.push(reader(baseOff + c * compSize));
    }
    result.push(comps);
  }
  return { data: result, count, type, numComponents, min: acc.min, max: acc.max };
}

// Meshes - detailed analysis
console.log(`\n=== MESH ANALYSIS ===`);
if (json.meshes) {
  json.meshes.forEach((m, i) => {
    console.log(`\nmesh[${i}]: name="${m.name || '(unnamed)'}", primitives=${m.primitives.length}`);
    m.primitives.forEach((pr, j) => {
      const posAcc = pr.attributes.POSITION;
      const normalAcc = pr.attributes.NORMAL;
      const uv0Acc = pr.attributes.TEXCOORD_0;
      const uv1Acc = pr.attributes.TEXCOORD_1;
      const indicesAcc = pr.indices;
      const matIdx = pr.material;

      console.log(`  prim[${j}]: material=${matIdx !== undefined ? matIdx : 'none'}(${matIdx !== undefined ? (json.materials[matIdx].name || '?') : '?'})`);

      // Position
      if (posAcc !== undefined) {
        const pos = readAccessor(posAcc);
        if (pos) {
          // Compute bounding box
          let minX = Infinity, minY = Infinity, minZ = Infinity;
          let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
          for (const v of pos.data) {
            if (v[0] < minX) minX = v[0];
            if (v[1] < minY) minY = v[1];
            if (v[2] < minZ) minZ = v[2];
            if (v[0] > maxX) maxX = v[0];
            if (v[1] > maxY) maxY = v[1];
            if (v[2] > maxZ) maxZ = v[2];
          }
          const sizeX = maxX - minX;
          const sizeY = maxY - minY;
          const sizeZ = maxZ - minZ;
          const centerX = (minX + maxX) / 2;
          const centerY = (minY + maxY) / 2;
          const centerZ = (minZ + maxZ) / 2;
          console.log(`    POSITION: ${pos.count} verts`);
          console.log(`      bbox: min=[${minX.toFixed(3)}, ${minY.toFixed(3)}, ${minZ.toFixed(3)}] max=[${maxX.toFixed(3)}, ${maxY.toFixed(3)}, ${maxZ.toFixed(3)}]`);
          console.log(`      size:  [${sizeX.toFixed(3)}, ${sizeY.toFixed(3)}, ${sizeZ.toFixed(3)}]`);
          console.log(`      center:[${centerX.toFixed(3)}, ${centerY.toFixed(3)}, ${centerZ.toFixed(3)}]`);
        }
      }

      // UV
      if (uv0Acc !== undefined) {
        const uv = readAccessor(uv0Acc);
        console.log(`    TEXCOORD_0: ${uv ? uv.count : 0} coords (has UV!)`);
        if (uv) {
          let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
          for (const c of uv.data) {
            if (c[0] < minU) minU = c[0];
            if (c[1] < minV) minV = c[1];
            if (c[0] > maxU) maxU = c[0];
            if (c[1] > maxV) maxV = c[1];
          }
          console.log(`      UV range: U=[${minU.toFixed(3)}, ${maxU.toFixed(3)}] V=[${minV.toFixed(3)}, ${maxV.toFixed(3)}]`);
        }
      } else {
        console.log(`    TEXCOORD_0: NONE (no UV)`);
      }

      if (uv1Acc !== undefined) {
        console.log(`    TEXCOORD_1: has (lightmap UV)`);
      }

      // Indices
      if (indicesAcc !== undefined) {
        const idx = readAccessor(indicesAcc);
        console.log(`    indices: ${idx ? idx.count : 0}`);
      }

      // Normal
      if (normalAcc !== undefined) {
        const nrm = readAccessor(normalAcc);
        console.log(`    NORMAL: ${nrm ? nrm.count : 0} normals`);
      }
    });
  });
}
