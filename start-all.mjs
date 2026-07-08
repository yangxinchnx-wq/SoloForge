#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────
// SoloForge 一键启动器 (Node, 跨平台, 优先用此文件)
//   用法:
//     node start-all.mjs                  # 全量启动
//     node start-all.mjs --no-electron    # 不拉 Electron 桌面壳
//     node start-all.mjs --check          # 仅做依赖与端口自检
//
// 启动顺序:
//   1. Garnet 缓存 (6379)            bin/garnet/.../GarnetServer.exe
//   2. Go git-service (3002)          UI/git-service/git-service.exe
//   3. 主后端内核 (3001 / 9090)  src/index.ts (tsx)
//       ⚠️ 3001 是后端管理界面: http://localhost:3001/admin
//       依赖 Garnet(6379) + SurrealDB(8400) + MARL(8765)
//   4. UI dev server (3000)          UI/server.ts (tsx)
//   5. MARL Python 服务 (8765 + 8766) python -m marl_service.server_prod
//      8765 = gRPC 推理 (audit B1 修复后接 reputation-outbox-bridge)
//      8766 = HTTP /sync/reputation 接收端 (audit B2 修复后接 outbox worker, M2 幂等键)
//   6. Java Spring AI Agent (8770)   solo-forge-agent/target/solo-forge-agent-1.0.0.jar
//      Spring AI 编排, 接 AI Society SQLite + MARL 训练闭环
//      Node.js 通过 /api/java-agent/* 转发到此端口
//   7. Electron 桌面壳 (可选)
// ─────────────────────────────────────────────────────────────────

import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const NO_ELECTRON = process.argv.includes("--no-electron");
const CHECK_ONLY = process.argv.includes("--check");

// ── ANSI 颜色 ────────────────────────────────────────────────────
const C = (c, s) => process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s;
const OK   = (s) => C(32, s);
const FAIL = (s) => C(31, s);
const WARN = (s) => C(33, s);
const INFO = (s) => C(36, s);
const DIM  = (s) => C(90, s);
const BOLD = (s) => C(1, s);

const isWin = process.platform === "win32";
const exeExt = isWin ? ".exe" : "";

// ── 路径清单 ────────────────────────────────────────────────────
const ROOT = __dirname;
const BIN  = path.join(ROOT, "bin");
const UI   = path.join(ROOT, "UI");
const PY   = path.join(ROOT, "python");

const GARNET_EXE = path.join(BIN, "garnet", "portable", "net10.0", `GarnetServer${exeExt}`);
const GARNET_DATA = path.join(BIN, "garnet", "data");
const GARNET_LOGDIR = path.join(GARNET_DATA, "logs");
const GARNET_CHKPT = path.join(GARNET_DATA, "checkpoint");
const GARNET_PORT = 6379;

const PY_EXE = path.join(BIN, "python-3.13", "python" + (isWin ? ".exe" : ""));
const MARL_MODULE = "marl_service.server_prod";

const GIT_EXE = path.join(UI, "git-service", `git-service${exeExt}`);
const GIT_PORT = 3002;

const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const UI_TSX_CLI = path.join(UI, "node_modules", "tsx", "dist", "cli.mjs");

const ELECTRON_LAUNCH = path.join(UI, "electron", "launch.cjs");

// Java Spring AI Agent 服务 (8770)
const JAVA_AGENT_DIR = path.join(ROOT, "solo-forge-agent");
const JAVA_AGENT_JAR = path.join(JAVA_AGENT_DIR, "target", "solo-forge-agent-1.0.0.jar");
const JAVA_PORT = 8770;

const SURREAL_EXE = path.join(BIN, `surreal${exeExt}`);
const SURREAL_PORT = 8400;

const PORTS = {
  3000: "UI dev server (Vite + Express)",
  3001: "SoloForge API Server (主内核)",
  3002: "Go git-service (go-git)",
  6379: "Garnet 缓存 (Redis 协议)",
  8400: "SurrealDB (standalone, rocksdb backend)",
  8765: "MARL Python gRPC 推理",
  8766: "MARL Python /sync/reputation HTTP (P9 接收端, audit B2 修复)",
  8770: "Java Spring AI Agent 服务 (solo-forge-agent)",
  9090: "Prometheus 指标导出",
};

// ── 工具函数 ────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    let done = false;
    const finish = (ok) => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(ok); } };
    s.once("connect", () => finish(true));
    s.once("error",   () => finish(false));
    s.setTimeout(timeoutMs, () => finish(false));
  });
}

async function waitPort(host, port, label, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await portOpen(host, port)) return true;
    await sleep(300);
  }
  return false;
}

function haveFile(p) { try { return fs.existsSync(p); } catch { return false; } }
function haveDir(p)  { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function log(prefix, msg) {
  const tag = prefix.padEnd(16);
  console.log(`${DIM("[" + new Date().toLocaleTimeString() + "]")} ${BOLD(tag)} ${msg}`);
}

function spawnBg(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    windowsHide: true,
    ...opts,
  });
  log(name, `pid=${child.pid} started`);
  if (child.stdout) child.stdout.on("data", (b) => process.stdout.write(`${DIM(`[${name}·out] `)}${b}`));
  if (child.stderr) child.stderr.on("data", (b) => process.stdout.write(`${WARN(`[${name}·err] `)}${b}`));
  child.on("exit", (code, sig) => log(name, `exit code=${code} signal=${sig}`));
  child.on("error", (e) => log(name, `error: ${e.message}`));
  return child;
}

function npmScript(cwd, scriptName) {
  // 用项目自带的 npx.cmd / npm-cli.js(避免系统 npx 缺失, 与我们之前踩过的坑对齐)
  const isWin = process.platform === "win32";
  if (isWin) {
    const npmCmd = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
    return spawn(npmCmd, ["/c", "npm", "run", scriptName], { cwd, stdio: "inherit", windowsHide: true });
  }
  return spawn("npm", ["run", scriptName], { cwd, stdio: "inherit" });
}

// ── 启动器 ──────────────────────────────────────────────────────
async function checkPrereqs() {
  const lines = [];
  function line(name, ok, detail) { lines.push({ name, ok, detail }); }

  line("SurrealDB binary", haveFile(SURREAL_EXE), SURREAL_EXE);
  line("Garnet binary",   haveFile(GARNET_EXE), GARNET_EXE);
  line("Garnet data dir", haveDir(GARNET_DATA) || fs.existsSync(path.dirname(GARNET_DATA)), GARNET_DATA);
  line("Python 3.13",     haveFile(PY_EXE),     PY_EXE);
  line("Rust scheduler",  haveFile(path.join(BIN, `scheduler${exeExt}`)), `bin/scheduler${exeExt}`);
  line("git-service exe", haveFile(GIT_EXE),    GIT_EXE);
  line("git-service src", haveFile(path.join(UI, "git-service", "main.go")), "UI/git-service/main.go (Go source)");
  line("root tsx cli",    haveFile(TSX_CLI),    TSX_CLI);
  line("UI tsx cli",      haveFile(UI_TSX_CLI), UI_TSX_CLI);
  line("Electron launch", haveFile(ELECTRON_LAUNCH), ELECTRON_LAUNCH);
  line("marl module",     haveDir(path.join(PY, "marl_service")), "python/marl_service");
  line("java agent jar",  haveFile(JAVA_AGENT_JAR), JAVA_AGENT_JAR + " (不存在则启动时自动 mvnw 构建)");
  line("java runtime",    (() => {
    try { execSync("java -version", { stdio: "ignore", shell: isWin ? true : undefined }); return true; } catch { return false; }
  })(), "java -version");
  line("browser-use pkg", false, "lazy-spawn, no daemon");

  console.log(BOLD("\n[Self-check] 依赖与二进制体检"));
  let bad = 0;
  for (const l of lines) {
    const tag = l.ok ? OK("✓") : FAIL("✗");
    console.log(`  ${tag} ${l.name.padEnd(18)} ${DIM(l.detail || "")}`);
    if (!l.ok && l.name !== "Garnet data dir" && l.name !== "browser-use pkg"
        && l.name !== "java agent jar" && l.name !== "java runtime") bad++;
  }

  console.log(BOLD("\n[Self-check] 端口占用"));
  for (const [port, label] of Object.entries(PORTS)) {
    const used = await portOpen("127.0.0.1", Number(port), 200);
    const tag = used ? WARN("●USED") : OK("○FREE");
    console.log(`  ${tag} :${port.toString().padEnd(5)} ${label}`);
  }

  if (bad > 0) {
    console.log(FAIL(`\n[Self-check] 缺失 ${bad} 项必要资产,无法继续`));
    process.exit(1);
  }
  console.log(OK("[Self-check] 全部通过\n"));
}

async function startGarnet() {
  if (await portOpen("127.0.0.1", GARNET_PORT, 200)) {
    log("Garnet", WARN(`6379 已占用,假定已在运行`));
    return null;
  }
  ensureDir(GARNET_LOGDIR);
  ensureDir(GARNET_CHKPT);
  // 1.1.10 正确参数:必须 --storage-tier 才能配 --logdir
  // 旧版 --logger-folder 1.1.10 已不再识别
  const args = [
    "--port", String(GARNET_PORT),
    "--storage-tier",
    "--logdir", GARNET_LOGDIR,
    "--checkpointdir", GARNET_CHKPT,
    "--logger-level", "Information",
  ];
  return spawnBg("Garnet", GARNET_EXE, args, { cwd: path.dirname(GARNET_EXE) });
}

async function startSurrealDB() {
  if (await portOpen("127.0.0.1", SURREAL_PORT, 200)) {
    log("SurrealDB", WARN(`${SURREAL_PORT} \u5df2\u5360\u7528,\u5047\u5b9a\u5df2\u5728\u8fd0\u884c`));
    return null;
  }
  if (!haveFile(SURREAL_EXE)) {
    log("SurrealDB", FAIL(`\u627e\u4e0d\u5230 ${SURREAL_EXE};\u8df3\u8fc7`));
    return null;
  }
  const dbPath = path.join(ROOT, "data", "soloforge_db").replace(/\\/g, "/");
  return spawnBg("SurrealDB", SURREAL_EXE, [
    "start",
    "--log", "warn",
    "--user", "root",
    "--pass", "root",
    "--bind", `0.0.0.0:${SURREAL_PORT}`,
    `rocksdb://${dbPath}`,
  ], { cwd: ROOT });
}

async function startGitService() {
  if (await portOpen("127.0.0.1", GIT_PORT, 200)) {
    log("git-service", WARN(`3002 已占用,假定已在运行`));
    return null;
  }
  if (!haveFile(GIT_EXE)) {
    log("git-service", WARN("git-service.exe 不存在,尝试用 Go 编译..."));
    if (!haveFile(path.join(UI, "git-service", "main.go"))) {
      log("git-service", FAIL("找不到 UI/git-service/main.go,跳过(Go 未安装或源缺失)"));
      return null;
    }
    try {
      execSync("go build -o git-service.exe .", {
        cwd: path.join(UI, "git-service"),
        stdio: "inherit",
      });
    } catch (e) {
      log("git-service", FAIL(`编译失败: ${e.message}; 跳过(未装 Go?)`));
      return null;
    }
  }
  return spawnBg("git-service", GIT_EXE, ["--port", String(GIT_PORT), "--repo", ROOT], {
    cwd: path.join(UI, "git-service"),
  });
}

async function startBackend() {
  if (await portOpen("127.0.0.1", 3001, 200)) {
    log("backend", WARN(`3001 已占用,假定已在运行`));
    return null;
  }
  // Read .env file and inject into backend process environment
  const envFile = path.join(ROOT, ".env");
  const envFromDotenv = {};
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        envFromDotenv[key] = val;
      }
    }
    log("backend", `已读取 .env (${Object.keys(envFromDotenv).length} 个变量)`);
  }
  // dev mode: auto-issue tokens to avoid 3001 startup failure
  const env = { ...process.env, ...envFromDotenv, SOLOFORGE_REQUIRE_TOKENS: "0" };
  return spawnBg("backend", process.execPath, [TSX_CLI, "src/index.ts"], { cwd: ROOT, env });
}

async function startUiDev() {
  if (await portOpen("127.0.0.1", 3000, 200)) {
    log("ui-dev", WARN(`3000 已占用,假定已在运行`));
    return null;
  }
  const child = spawnBg("ui-dev", process.execPath, [UI_TSX_CLI, "server.ts"], {
    cwd: UI,
    env: { ...process.env, GIT_SERVICE_URL: `http://localhost:${GIT_PORT}` },
  });
  return child;
}

async function startMarl() {
  if (await portOpen("127.0.0.1", 8765, 200)) {
    log("marl", WARN(`8765 已占用,假定已在运行`));
    return null;
  }
  if (!haveFile(PY_EXE)) {
    log("marl", FAIL(`找不到 ${PY_EXE}; 跳过`));
    return null;
  }
  return spawnBg("marl", PY_EXE, ["-m", MARL_MODULE], {
    cwd: PY,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
}

/**
 * 尝试构建 Java Agent JAR
 * 优先用 mvnw, 失败则 fallback 到系统 mvn
 */
function tryMavenBuild() {
  const mvw = path.join(JAVA_AGENT_DIR, isWin ? "mvnw.cmd" : "mvnw");
  // 1. 尝试 mvnw
  if (haveFile(mvw)) {
    try {
      log("java-agent", "尝试 mvnw 构建...");
      execSync(`${mvw} -q -DskipTests package`, {
        cwd: JAVA_AGENT_DIR, stdio: "inherit", env: process.env, shell: isWin,
      });
      return true;
    } catch (e) {
      log("java-agent", WARN(`mvnw 构建失败 (${e.message}), 尝试系统 mvn...`));
    }
  }
  // 2. Fallback: 系统 mvn
  try {
    log("java-agent", "尝试系统 mvn 构建...");
    execSync("mvn -q -DskipTests package", {
      cwd: JAVA_AGENT_DIR, stdio: "inherit", env: process.env, shell: isWin,
    });
    return true;
  } catch (e) {
    log("java-agent", FAIL(`mvn 构建也失败: ${e.message}; 跳过`));
    return false;
  }
}

async function startJavaAgent() {
  if (await portOpen("127.0.0.1", JAVA_PORT, 200)) {
    log("java-agent", WARN(`${JAVA_PORT} 已占用,假定已在运行`));
    return null;
  }
  // 优先用已构建的 fat jar; 不存在则尝试构建
  let jarPath = JAVA_AGENT_JAR;
  if (!haveFile(jarPath)) {
    log("java-agent", WARN(`未找到 ${jarPath},尝试构建...`));
    const buildOk = tryMavenBuild();
    if (!buildOk) return null;
    if (!haveFile(jarPath)) {
      log("java-agent", FAIL(`构建完成但仍找不到 ${jarPath}; 跳过`));
      return null;
    }
  }
  // 校验 java 可执行
  let javaExe = "java";
  if (isWin) {
    const javaHome = process.env.JAVA_HOME;
    if (javaHome) javaExe = path.join(javaHome, "bin", "java.exe");
  }
  return spawnBg("java-agent", javaExe, [
    "-jar", jarPath,
    `--server.port=${JAVA_PORT}`,
  ], {
    cwd: JAVA_AGENT_DIR,
    env: { ...process.env },
  });
}

async function startElectron() {
  if (!haveFile(ELECTRON_LAUNCH)) {
    log("electron", FAIL(`找不到 ${ELECTRON_LAUNCH}; 跳过`));
    return null;
  }
  // 自检 main.cjs 是否还有 TypeScript 类型残留(.cjs 必须是纯 JS)
  const mainCjs = path.join(UI, "electron", "main.cjs");
  if (haveFile(mainCjs)) {
    const txt = fs.readFileSync(mainCjs, "utf8");
    const bad = txt.match(/(_event:\s*unknown|channel:\s*string|payload:\s*unknown|payload as \{)/);
    if (bad) {
      log("electron", FAIL(`main.cjs 存在 TS 类型残留 (${bad[0]}); 修复后重试`));
      return null;
    }
  }
  return spawnBg("electron", process.execPath, [ELECTRON_LAUNCH, "."], {
    cwd: UI,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: "http://localhost:3000",
      SOLOFORGE_BACKEND_URL: "http://localhost:3001",
    },
  });
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  console.log(BOLD("═══════════════════════════════════════════════════════════"));
  console.log(BOLD("  SoloForge 一键启动器"));
  console.log(BOLD("═══════════════════════════════════════════════════════════\n"));
  console.log(`  Root:  ${ROOT}`);
  console.log(`  Python: ${PY_EXE}`);
  console.log(`  Electron: ${NO_ELECTRON ? "跳过(--no-electron)" : "拉起"}`);
  console.log("");

  await checkPrereqs();
  if (CHECK_ONLY) return;

  const procs = [];
  procs.push({ name: "SurrealDB",  p: await startSurrealDB() });
  procs.push({ name: "Garnet",     p: await startGarnet()    });
  procs.push({ name: "git-service",p: await startGitService()});

  // Wait for SurrealDB first (backend depends on it)
  log("WAIT", "Waiting for SurrealDB on 8400 (max 10s)...");
  const surrealReady = await waitPort("127.0.0.1", SURREAL_PORT, "SurrealDB", 10000);
  log("WAIT", `SurrealDB=${surrealReady ? "OK" : "TIMEOUT"}`);


  log("WAIT", "等 Garnet 与 git-service 就绪(最多 8s)...");
  const a = waitPort("127.0.0.1", GARNET_PORT, "Garnet",  8000);
  const b = waitPort("127.0.0.1", GIT_PORT,    "git-svc", 8000);
  const [ga, gb] = await Promise.all([a, b]);
  log("WAIT", `Garnet=${ga ? "OK" : "TIMEOUT"} | git-service=${gb ? "OK" : "TIMEOUT"}`);

  procs.push({ name: "backend",    p: await startBackend()   });
  procs.push({ name: "ui-dev",     p: await startUiDev()     });

  log("WAIT", "等后端 3001 与 UI 3000 就绪(最多 25s)...");
  const c = waitPort("127.0.0.1", 3001, "backend", 25000);
  const d = waitPort("127.0.0.1", 3000, "ui",      25000);
  const [gc, gd] = await Promise.all([c, d]);
  log("WAIT", `backend=${gc ? "OK" : "TIMEOUT"} | ui-dev=${gd ? "OK" : "TIMEOUT"}`);

  procs.push({ name: "marl",       p: await startMarl()      });

  log("WAIT", "等 MARL 8765 就绪(最多 15s)...");
  const ge = await waitPort("127.0.0.1", 8765, "marl", 15000);
  log("WAIT", `marl=${ge ? "OK" : "TIMEOUT"}`);

  log("WAIT", "等 MARL 8766 /sync/reputation HTTP 接收端就绪(最多 10s)...");
  const gr = await waitPort("127.0.0.1", 8766, "marl-http", 10000);
  log("WAIT", `marl-http=${gr ? "OK" : "TIMEOUT"} (audit B2 修复)`);

  // Java Spring AI Agent 服务 (8770) — 依赖 SQLite(AI Society) + MARL(8765) + Garnet(6379)
  procs.push({ name: "java-agent", p: await startJavaAgent() });
  log("WAIT", "等 Java Agent 8770 就绪(最多 25s)...");
  const gj = await waitPort("127.0.0.1", JAVA_PORT, "java-agent", 25000);
  log("WAIT", `java-agent=${gj ? "OK" : "TIMEOUT"}`);

  if (!NO_ELECTRON) {
    procs.push({ name: "electron", p: await startElectron() });
  }

  console.log("");
  console.log(BOLD("═══════════════════════════════════════════════════════════"));
  console.log(BOLD(OK("  全部就绪,以下是访问入口")));
  console.log(BOLD("═══════════════════════════════════════════════════════════"));
  console.log(`  ${BOLD("UI 前端")}       ${INFO("http://localhost:3000")}  (Vite + Express dev)`);
  console.log(`  ${BOLD("主内核 API")}   ${INFO("http://localhost:3001")}  Admin: ${INFO("http://localhost:3001/admin")}`);
  console.log(`  ${BOLD("Git 服务")}     ${INFO(`http://localhost:${GIT_PORT}`)}`);
  console.log(`  ${BOLD("MARL 推理")}    ${INFO("http://localhost:8765")}`);
  console.log(`  ${BOLD("MARL Reputation Sync")} ${INFO("http://localhost:8766/sync/reputation")}`);
  console.log(`  ${BOLD("Java Agent")}    ${INFO(`http://localhost:${JAVA_PORT}`)}  (fallback, Spring AI 编排, /api/chat/send)`);
    console.log(`  ${BOLD("SurrealDB")}    ${INFO(`http://localhost:${SURREAL_PORT}`)}  (standalone, rocksdb)`);
  console.log(`  ${BOLD("Garnet 缓存")}  ${INFO(`127.0.0.1:${GARNET_PORT}`)}`);
  console.log(`  ${BOLD("Prometheus")}   ${INFO("http://localhost:9090/metrics")}`);
  console.log(`  ${BOLD("SSE 事件流")}  ${INFO("http://localhost:3001/api/events/stream")}`);
  if (!NO_ELECTRON) console.log(`  ${BOLD("Electron")}     ${OK("桌面窗口已拉起")}`);
  console.log(BOLD("═══════════════════════════════════════════════════════════\n"));

  // 优雅退出
  const shutdown = (sig) => {
    console.log(`\n[BOSS] 收到 ${sig},正在关闭子进程...`);
    for (const { name, p } of procs) {
      if (p && !p.killed) {
        try { p.kill(); log("KILL", name); } catch {}
      }
    }
    setTimeout(() => process.exit(0), 1000);
  };
  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP",  () => shutdown("SIGHUP"));
  // 父进程不退出(否则子进程会跟着挂)
  setInterval(() => {}, 1 << 30);
}

main().catch((e) => {
  console.error(FAIL(`[FATAL] ${e.stack || e.message}`));
  process.exit(1);
});
