// ─────────────────────────────────────────────────────────────────
// SoloForge Electron 启动包装
// 作用：清空 ELECTRON_RUN_AS_NODE 等"伪装成 Node"的环境变量后 spawn electron
// 跨 Windows / macOS / Linux 通用
// ─────────────────────────────────────────────────────────────────

// ── 必须在 require('electron') 之前清除环境变量 ──
//   ELECTRON_RUN_AS_NODE 会导致 Electron 以纯 Node.js 模式运行
//   → binding.startupData=null → sandbox 渲染器崩溃
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const { spawn } = require('child_process');
const electronBin = require('electron');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('用法: node launch.cjs [electron args...]');
  process.exit(1);
}

const child = spawn(electronBin, args, {
  stdio: 'inherit',
  env,
  windowsHide: false,
});

child.on('close', (code, signal) => {
  if (signal) {
    console.error(`electron exited with signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
  process.on(sig, () => child.kill(sig));
}
