// verify-icon.cjs — 检查 exe 文件中是否嵌入了我们的图标
const fs = require("fs");
const path = require("path");

const releaseDir = path.join(__dirname, "..", "release");
const installerExe = path.join(releaseDir, "SoloForge Setup 1.0.0.exe");
const appExe = path.join(releaseDir, "win-unpacked", "SoloForge.exe");

// PNG signature
const pngSig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function checkExe(label, filePath) {
  if (!fs.existsSync(filePath)) {
    console.log(`[${label}] 文件不存在: ${filePath}`);
    return;
  }
  const buf = fs.readFileSync(filePath);
  const sizeMB = (buf.length / 1024 / 1024).toFixed(1);
  const pngIdx = buf.indexOf(pngSig);
  console.log(`[${label}] 大小: ${sizeMB} MB`);
  console.log(`[${label}] PNG 图标数据: ${pngIdx > -1 ? '找到 (offset=' + pngIdx + ')' : '未找到'}`);
  
  // 也检查 ICO signature (00 00 01 00 at start of icon resource)
  // 在 PE 文件中，资源段包含 RT_ICON 数据
  // ICO header: 00 00 01 00 NN (count)
  const icoHeader = Buffer.from([0x00, 0x00, 0x01, 0x00]);
  let icoCount = 0;
  let searchFrom = 0;
  while (true) {
    const idx = buf.indexOf(icoHeader, searchFrom);
    if (idx === -1 || idx > buf.length - 6) break;
    const count = buf.readUInt16LE(idx + 4);
    if (count > 0 && count <= 20) {
      icoCount++;
      if (icoCount <= 3) {
        console.log(`[${label}] ICO header #${icoCount} at offset ${idx}, count=${count}`);
      }
    }
    searchFrom = idx + 1;
  }
  console.log(`[${label}] ICO headers found: ${icoCount}`);
  console.log("");
}

checkExe("安装包", installerExe);
checkExe("应用EXE", appExe);
console.log("✅ 验证完成");
