// start.mjs — 一键启动 Garnet(6379) + RACER Core(3001) + Go git-service(3002) + Node.js dev server(3000) + Electron 壳子
import { spawn, execSync } from "child_process";
import path from "path";
import fs from "fs";
import net from "net";
import { fileURLToPath } from "url";

// ── 进程树杀死辅助 (Windows) ──────────────────────────────────
// Windows 上 spawn(..., { shell: true }) 会创建 cmd.exe → npx → node 多层子进程。
// process.kill() 只杀顶层 cmd.exe, 子进程变成孤儿继续运行 (持有 rocksdb 锁等资源)。
// 用 taskkill /T /F 杀死整个进程树。
function killProcessTree(proc, label = "process") {
  if (!proc || proc.exitCode !== null) return;
  const pid = proc.pid;
  try {
    if (process.platform === "win32") {
      // /T = 连同子进程一起杀, /F = 强制
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
      console.log(`[start] ${label} 进程树已杀死 (PID ${pid})`);
    } else {
      proc.kill("SIGTERM");
      console.log(`[start] ${label} 已发送 SIGTERM (PID ${pid})`);
    }
  } catch {
    // 进程可能已退出, 忽略错误
    try { proc.kill(); } catch {}
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 0. 启动 Garnet (6379) — RACER Core 依赖 ────────────────────
let garnetProcess = null;
// dev 模式下 Garnet 在打包产物路径中
const garnetExe = path.join(__dirname, "release", "win-unpacked", "resources", "garnet", "GarnetServer.exe");

function startGarnet() {
  if (!fs.existsSync(garnetExe)) {
    console.log("[start] GarnetServer.exe 不存在, 跳过 (假设已外部运行)");
    return;
  }
  console.log("[start] 启动 Garnet (port 6379)...");
  garnetProcess = spawn(garnetExe, ["--port", "6379"], {
    cwd: path.dirname(garnetExe),
    stdio: "pipe",
    shell: false,
    windowsHide: true,
  });
  garnetProcess.stdout?.on("data", (d) => process.stdout.write(`[garnet] ${d}`));
  garnetProcess.stderr?.on("data", (d) => process.stderr.write(`[garnet] ${d}`));
  garnetProcess.on("exit", (code) => {
    if (code !== 0) console.error(`[start] Garnet 异常退出 (code ${code})`);
  });
}

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

// ── 4. 启动 RACER Core (3001) ─────────────────────────────────
let coreProcess = null;
const coreEntry = path.join(__dirname, "resources", "core", "server.mjs");

function startRacerCore() {
  if (!fs.existsSync(coreEntry)) {
    console.warn(`[start] RACER Core 不存在 (${coreEntry}), 跳过 — /api/events/stream 将 502`);
    return;
  }
  console.log("[start] 启动 RACER Core (port 3001)...");
  coreProcess = spawn("node", [coreEntry], {
    cwd: __dirname,
    stdio: "inherit",
    shell: true,
    env: { ...process.env },
  });
  coreProcess.on("exit", (code) => {
    console.log(`[start] RACER Core 已退出 (code ${code})`);
  });
}

// ── 5. 启动 Node.js dev server (3000) ─────────────────────────
let nodeProcess = null;

function startNode() {
  console.log("[start] 启动 Node.js 开发服务器 (port 3000)...");
  nodeProcess = spawn("npx", ["tsx", "server.ts"], {
    cwd: __dirname,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, GIT_SERVICE_URL: "http://localhost:3002", DISABLE_HMR: "true" },
  });

  nodeProcess.on("exit", (code) => {
    console.log(`[start] Node.js 已退出 (code ${code})`);
    cleanup();
  });
}

// ── 6. 等 Node.js 就绪后启动 Electron 壳子 ────────────────────
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

// ── 7. 优雅退出：关闭所有进程 (含子进程树) ───────────────────
// ★ 2026-07-15: 改用 killProcessTree 替代裸 .kill()。
//   原因: Windows 上 spawn(shell:true) 的子进程 (npx→tsx→node) 不会被
//   父进程 .kill() 连带杀死, 变成孤儿继续持有 rocksdb LOCK 文件,
//   导致下次启动时 SurrealDB 初始化超时 30s 后崩溃。
function cleanup() {
  console.log("\n[start] 正在关闭所有服务...");
  killProcessTree(electronProcess, "Electron");
  killProcessTree(nodeProcess, "Node.js dev server");
  killProcessTree(coreProcess, "RACER Core");
  killProcessTree(garnetProcess, "Garnet");
  killProcessTree(gitService, "git-service");
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// ── 启动流程: Garnet + git-service → RACER Core → Node.js → Electron ──
startGarnet();

// 等最多 3 秒让 git-service 启动，然后无论是否 ready 都启动后续服务
let waited = 0;
const check = setInterval(() => {
  waited += 200;
  if (gitReady || waited >= 3000) {
    clearInterval(check);
    startRacerCore();  // RACER Core 依赖 Garnet
    startNode();       // Node.js 依赖 git-service
    startElectron();   // Electron 异步等待 port 3000 就绪后启动
  }
}, 200);
