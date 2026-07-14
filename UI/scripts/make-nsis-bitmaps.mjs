// make-nsis-bitmaps.mjs — 生成 NSIS MUI2 所需的 BMP 位图
// 先用 sharp 生成 PNG，再用 PowerShell .NET 转 BMP
import sharp from "sharp";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "..", "build", "nsis");
const SOURCE = path.resolve(__dirname, "..", "build", "icon", "icon.png");

const HEADER_W = 150;
const HEADER_H = 57;
const SIDEBAR_W = 164;
const SIDEBAR_H = 314;

async function compositePng(bgSvg, logoBuf, left, top, w, h, outName) {
  const buf = await sharp(bgSvg)
    .composite([{ input: logoBuf, left, top }])
    .flatten()
    .resize(w, h)
    .png()
    .toBuffer();
  const pngPath = path.join(OUT_DIR, outName + ".png");
  await sharp(buf).png().toFile(pngPath);
  console.log(`[nsis] ${outName}.png 生成完成 (${w}x${h})`);
  return pngPath;
}

function pngToBmp(pngPath, bmpPath) {
  // 用 PowerShell + .NET System.Drawing 转换 PNG → BMP
  const ps = `Add-Type -AssemblyName System.Drawing; ` +
    `$img = [System.Drawing.Image]::FromFile('${pngPath}'); ` +
    `$bmp = New-Object System.Drawing.Bitmap($img.Width, $img.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb); ` +
    `$g = [System.Drawing.Graphics]::FromImage($bmp); ` +
    `$g.Clear([System.Drawing.Color]::Black); ` +
    `$g.DrawImage($img, 0, 0, $img.Width, $img.Height); ` +
    `$bmp.Save('${bmpPath}', [System.Drawing.Imaging.ImageFormat]::Bmp); ` +
    `$g.Dispose(); $bmp.Dispose(); $img.Dispose();`;
  execSync(ps, { shell: "powershell" });
  console.log(`[nsis] ${path.basename(bmpPath)} 转换完成`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const logo120 = await sharp(SOURCE).resize(120, 120, { fit: "cover" }).png().toBuffer();
  const logo36 = await sharp(SOURCE).resize(36, 36, { fit: "cover" }).png().toBuffer();

  // 安装侧边栏
  const sidebarBg = Buffer.from(`
    <svg width="${SIDEBAR_W}" height="${SIDEBAR_H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0A0E27"/>
          <stop offset="50%" stop-color="#151A3E"/>
          <stop offset="100%" stop-color="#0D1228"/>
        </linearGradient>
      </defs>
      <rect width="${SIDEBAR_W}" height="${SIDEBAR_H}" fill="url(#bg)"/>
    </svg>
  `);
  const sidebarPng = await compositePng(sidebarBg, logo120, 22, 37, SIDEBAR_W, SIDEBAR_H, "sidebar");
  pngToBmp(sidebarPng, path.join(OUT_DIR, "sidebar.bmp"));

  // 安装头部
  const headerBg = Buffer.from(`
    <svg width="${HEADER_W}" height="${HEADER_H}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${HEADER_W}" height="${HEADER_H}" fill="#0A0E27"/>
      <line x1="0" y1="${HEADER_H - 1}" x2="${HEADER_W}" y2="${HEADER_H - 1}" stroke="#3B4D7A" stroke-width="1"/>
    </svg>
  `);
  const headerPng = await compositePng(headerBg, logo36, 10, 10, HEADER_W, HEADER_H, "header");
  pngToBmp(headerPng, path.join(OUT_DIR, "header.bmp"));

  // 卸载侧边栏
  const unSidebarBg = Buffer.from(`
    <svg width="${SIDEBAR_W}" height="${SIDEBAR_H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#1A0508"/>
          <stop offset="50%" stop-color="#2A0F14"/>
          <stop offset="100%" stop-color="#1A0508"/>
        </linearGradient>
      </defs>
      <rect width="${SIDEBAR_W}" height="${SIDEBAR_H}" fill="url(#bg)"/>
    </svg>
  `);
  const unSidebarPng = await compositePng(unSidebarBg, logo120, 22, 37, SIDEBAR_W, SIDEBAR_H, "uninstall-sidebar");
  pngToBmp(unSidebarPng, path.join(OUT_DIR, "uninstall-sidebar.bmp"));

  // 清理临时 PNG
  for (const f of ["sidebar.png", "header.png", "uninstall-sidebar.png"]) {
    fs.rmSync(path.join(OUT_DIR, f), { force: true });
  }

  console.log("[nsis] ✅ 所有 BMP 位图生成完成！");
}

main().catch(err => {
  console.error("[nsis] ❌ 错误:", err);
  process.exit(1);
});
