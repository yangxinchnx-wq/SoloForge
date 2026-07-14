// start.mjs — 一键启动 Go git-service (3002) + Node.js dev server (3000) + Electron 壳子
import { spawn, execSync } from "child_process";
import path from "path";
import fs from "fs";
import net from "net";
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
let nodeProcess = null;

function startNode() {
  console.log("[start] 启动 Node.js 开发服务器 (port 3000)...");
  nodeProcess = spawn("npx", ["tsx", "server.ts"], {
    cwd: __dirname,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, GIT_SERVICE_URL: "http://localhost:3002", ENABLE_HMR: "true" },
  });

  nodeProcess.on("exit", (code) => {
    console.log(`[start] Node.js 已退出 (code ${code})`);
    cleanup();
  });
}

// ── 5. 等 Node.js 就绪后启动 Electron 壳子 ────────────────────
let electronProcess = null;

function waitForPort(port, host = "127.0.0.1", timeoutMs = 30000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tryConnect = () => {
      const socket = new net.Socket();
      socket.setTimeout(1000);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - start >= timeoutMs) {
          resolve(false);
        } else {
          setTimeout(tryConnect, 500);
        }
      });
      socket.once("timeout", () => {
        socket.destroy();
        if (Date.now() - start >= timeoutMs) {
          resolve(false);
        } else {
          setTimeout(tryConnect, 500);
        }
      });
      socket.connect(port, host);
    };
    tryConnect();
  });
}

async function startElectron() {
  console.log("[start] 等待 Node.js (port 3000) 就绪...");
  const ready = await waitForPort(3000, "127.0.0.1", 30000);
  if (ready) {
    console.log("[start] ✅ Node.js 就绪, 启动 Electron 壳子...");
  } else {
    console.error("[start] ✗ Node.js (port 3000) 30s 超时, 强制启动 Electron...");
  }

  // 用 launch.cjs 启动, 它会清除 ELECTRON_RUN_AS_NODE 等环境变量
  electronProcess = spawn("node", ["electron/launch.cjs", "."], {
    cwd: __dirname,
    stdio: "inherit",
    shell: true,
    env: { ...process.env }, // launch.cjs 内部会 delete ELECTRON_RUN_AS_NODE
  });

  electronProcess.on("exit", (code) => {
    console.log(`[start] Electron 已退出 (code ${code})`);
    cleanup();
  });
}

// ── 6. 优雅退出：关闭所有进程 ──────────────────────────────────
function cleanup() {
  console.log("\n[start] 正在关闭所有服务...");
  try { if (electronProcess) electronProcess.kill(); } catch {}
  try { if (nodeProcess) nodeProcess.kill(); } catch {}
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
    startElectron(); // 异步等待 port 3000 就绪后启动
  }
}, 200);
