// make-icon.mjs — 将源图片处理为正方形 + 圆角图标
// 使用 sharp 进行图像处理，输出 1024x1024 PNG + 多尺寸 ICO
import sharp from "sharp";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOURCE = process.argv[2] || "C:\\Users\\yangx\\Desktop\\新建文件夹 (12)\\lightning_logo_4k.png";
const OUT_DIR = path.resolve(__dirname, "..", "build", "icon");
const ICON_PNG = path.join(OUT_DIR, "icon.png");
const ICON_ICO = path.join(OUT_DIR, "icon.ico");

const SIZE = 1024;               // 最终正方形尺寸
const CORNER_RADIUS = SIZE * 0.22; // 圆角半径 (22% of size)

// ICO 需要的尺寸列表
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`[icon] 源图片: ${SOURCE}`);
  const meta = await sharp(SOURCE).metadata();
  console.log(`[icon] 原始尺寸: ${meta.width}x${meta.height}, 格式: ${meta.format}`);

  // Step 1: 裁剪为正方形 (cover 策略: 保持比例，居中裁剪)
  const minDim = Math.min(meta.width, meta.height);
  const left = Math.round((meta.width - minDim) / 2);
  const top = Math.round((meta.height - minDim) / 2);

  const squareBuf = await sharp(SOURCE)
    .extract({ left, top, width: minDim, height: minDim })
    .resize(SIZE, SIZE, { fit: "cover" })
    .png()
    .toBuffer();

  console.log(`[icon] 正方形裁剪完成: ${SIZE}x${SIZE}`);

  // Step 2: 创建圆角 SVG mask
  const r = CORNER_RADIUS;
  const maskSvg = Buffer.from(`
    <svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="${r}" ry="${r}"
            fill="#ffffff" stroke="none"/>
    </svg>
  `);

  // Step 3: 用 mask 合成圆角效果
  const roundedBuf = await sharp(squareBuf)
    .composite([{
      input: maskSvg,
      blend: "dest-in",  // 保留 mask 白色区域，其余透明
    }])
    .png()
    .toBuffer();

  // Step 4: 保存 1024x1024 PNG
  await sharp(roundedBuf).png().toFile(ICON_PNG);
  console.log(`[icon] PNG 已保存: ${ICON_PNG}`);

  // Step 5: 生成多尺寸 PNG 用于 ICO
  const pngBuffers = [];
  for (const size of ICO_SIZES) {
    const buf = await sharp(roundedBuf)
      .resize(size, size, { fit: "cover" })
      .png()
      .toBuffer();
    pngBuffers.push({ size, buf });
    console.log(`[icon] 生成 ${size}x${size} PNG`);
  }

  // Step 6: 手动构建 ICO 文件 (无需额外依赖)
  // ICO 文件格式: header + directory entries + image data
  const iconDir = Buffer.alloc(6);
  iconDir.writeUInt16LE(0, 0);   // reserved
  iconDir.writeUInt16LE(1, 2);   // type: 1 = icon
  iconDir.writeUInt16LE(ICO_SIZES.length, 4); // count

  const dirEntries = [];
  const imageDatas = [];
  let dataOffset = 6 + ICO_SIZES.length * 16; // header(6) + entries(count*16)

  for (const { size, buf } of pngBuffers) {
    // PNG data 直接嵌入 ICO (Windows Vista+ 支持 PNG 格式)
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);  // width (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1);  // height
    entry.writeUInt8(0, 2);  // color count (0 = no palette)
    entry.writeUInt8(0, 3);  // reserved
    entry.writeUInt16LE(1, 4);   // color planes
    entry.writeUInt16LE(32, 6);  // bits per pixel
    entry.writeUInt32LE(buf.length, 8);  // image size
    entry.writeUInt32LE(dataOffset, 12); // offset to image data

    dirEntries.push(entry);
    imageDatas.push(buf);
    dataOffset += buf.length;
  }

  const icoBuf = Buffer.concat([iconDir, ...dirEntries, ...imageDatas]);
  fs.writeFileSync(ICON_ICO, icoBuf);
  console.log(`[icon] ICO 已保存: ${ICON_ICO} (${(icoBuf.length / 1024).toFixed(0)} KB)`);
  console.log(`[icon] ✅ 图标生成完成！`);
}

main().catch(err => {
  console.error("[icon] ❌ 错误:", err);
  process.exit(1);
});
