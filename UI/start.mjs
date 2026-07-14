// start.mjs — 一键同时启动 Go git-service (port 3002) + Node.js dev server (port 3000)
import { spawn, execSync } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 1. 确保 git-service.exe 已编译 ────────────────────────────
const gitExe = path.join(__dirname, "git-service", "git-service.exe");
if (!fs.existsSync(gitExe)) {
  console.log("[start] git-service.exe 不存在，正在编译 Go 服务...");
  try {
    execSync("go build -o git-service.exe .", {
      cwd: path.join(__dirname, "git-service"),
      stdio: "inherit",
    });
    console.log("[start] Go 编译完成");
  } catch (e) {
    console.error("[start] Go 编译失败，请确认已安装 Go: https://go.dev/dl/");
    process.exit(1);
  }
}

// ── 2. 确定项目根目录（git-service 监控的 repo 路径）────────────
const repoRoot = path.resolve(__dirname, "..");
console.log(`[start] Git 仓库根目录: ${repoRoot}`);

// ── 3. 启动 Go git-service ─────────────────────────────────────
const gitService = spawn(gitExe, ["--port", "3002", "--repo", repoRoot], {
  cwd: path.join(__dirname, "git-service"),
  stdio: "pipe",
  shell: false,
});

let gitReady = false;

function onGitOutput(data) {
  const msg = data.toString();
  process.stdout.write(`[git-service] ${msg}`);
  if (msg.includes("Starting git-service") || msg.includes("go-git backend starting")) {
    gitReady = true;
    console.log("[start] ✅ Go git-service 就绪 (port 3002)");
  }
}

gitService.stdout.on("data", onGitOutput);
gitService.stderr.on("data", onGitOutput);

gitService.on("error", (err) => {
  console.error("[start] git-service 启动失败:", err.message);
});

gitService.on("exit", (code) => {
  if (code !== null && code !== 0) {
    console.error(`[start] git-service 异常退出 (code ${code})`);
  }
});

// ── 4. 等 git-service 就绪后启动 Node.js ──────────────────────
function startNode() {
  console.log("[start] 启动 Node.js 开发服务器 (port 3000)...");
  const node = spawn("npx", ["tsx", "server.ts"], {
    cwd: __dirname,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, GIT_SERVICE_URL: "http://localhost:3002", ENABLE_HMR: "true" },
  });

  node.on("exit", (code) => {
    console.log(`[start] Node.js 已退出 (code ${code})`);
    cleanup();
  });
}

// ── 5. 优雅退出：关闭两个进程 ──────────────────────────────────
function cleanup() {
  console.log("\n[start] 正在关闭所有服务...");
  try { gitService.kill(); } catch {}
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// 等最多 3 秒让 git-service 启动，然后无论是否 ready 都启动 Node
let waited = 0;
const check = setInterval(() => {
  waited += 200;
  if (gitReady || waited >= 3000) {
    clearInterval(check);
    startNode();
  }
}, 200);
