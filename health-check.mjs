#!/usr/bin/env node
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === "win32";
const exeExt = isWin ? ".exe" : "";
const ROOT = __dirname;
const BIN = path.join(ROOT, "bin");
const UI = path.join(ROOT, "UI");
const PY = path.join(ROOT, "python");

const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const UI_TSX_CLI = path.join(UI, "node_modules", "tsx", "dist", "cli.mjs");
const ELECTRON_LAUNCH = path.join(UI, "electron", "launch.cjs");

const GARNET_EXE = path.join(BIN, "garnet", "portable", "net10.0", `GarnetServer${exeExt}`);
const GARNET_LOGDIR = path.join(BIN, "garnet", "data", "logs");
const GARNET_CHKPT = path.join(BIN, "garnet", "data", "checkpoint");
const PY_EXE = path.join(BIN, "python-3.13", "python" + (isWin ? ".exe" : ""));
const GIT_EXE = path.join(UI, "git-service", `git-service${exeExt}`);
const SURREAL_EXE = path.join(BIN, `surreal${exeExt}`);
const JAVA_AGENT_DIR = path.join(ROOT, "solo-forge-agent");
const JAVA_AGENT_JAR = path.join(JAVA_AGENT_DIR, "target", "solo-forge-agent-1.0.0.jar");

const SERVICES = [
  { name: "SurrealDB",   port: 8400, host: "127.0.0.1" },
  { name: "Garnet",      port: 6379, host: "127.0.0.1" },
  { name: "git-service", port: 3002, host: "0.0.0.0"   },
  { name: "backend",     port: 3001, host: "0.0.0.0"   },
  { name: "ui-dev",      port: 3000, host: "0.0.0.0"   },
  { name: "marl",        port: 8765, host: "127.0.0.1" },
  { name: "java-agent",  port: 8770, host: "0.0.0.0"   },
];

const ts = () => new Date().toLocaleTimeString();
const log = (tag, msg) => console.log(`[${ts()}] [${tag.padEnd(12)}] ${msg}`);

function portOpen(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    let done = false;
    const finish = (ok) => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(ok); } };
    s.once("connect", () => finish(true));
    s.once("error", () => finish(false));
    s.setTimeout(timeoutMs, () => finish(false));
  });
}

function waitPort(host, port, timeoutMs = 15000) {
  return new Promise(async (resolve) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await portOpen(host, port, 800)) return resolve(true);
      await new Promise(r => setTimeout(r, 500));
    }
    resolve(false);
  });
}

function spawnBg(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    windowsHide: true,
    ...opts,
  });
  log(name, `pid=${child.pid} started`);
  if (child.stdout) child.stdout.on("data", (b) => process.stdout.write(`[${name}·out] ${b}`));
  if (child.stderr) child.stderr.on("data", (b) => process.stdout.write(`[${name}·err] ${b}`));
  child.on("exit", (code, sig) => log(name, `exit code=${code} signal=${sig}`));
  child.on("error", (e) => log(name, `error: ${e.message}`));
  return child;
}

async function startSurrealDB() {
  const dbPath = path.join(ROOT, "data", "soloforge_db").replace(/\\/g, "/");
  return spawnBg("SurrealDB", SURREAL_EXE, [
    "start", "--log", "warn", "--user", "root", "--pass", "root",
    "--bind", "0.0.0.0:8400", `rocksdb://${dbPath}`,
  ], { cwd: ROOT });
}

async function startGarnet() {
  if (!fs.existsSync(GARNET_LOGDIR)) fs.mkdirSync(GARNET_LOGDIR, { recursive: true });
  if (!fs.existsSync(GARNET_CHKPT)) fs.mkdirSync(GARNET_CHKPT, { recursive: true });
  return spawnBg("Garnet", GARNET_EXE, [
    "--port", "6379", "--storage-tier",
    "--logdir", GARNET_LOGDIR, "--checkpointdir", GARNET_CHKPT,
    "--logger-level", "Information",
  ], { cwd: path.dirname(GARNET_EXE) });
}

async function startGitService() {
  return spawnBg("git-service", GIT_EXE, ["--port", "3002", "--repo", ROOT], {
    cwd: path.join(UI, "git-service"),
  });
}

async function startBackend() {
  const envFile = path.join(ROOT, ".env");
  const envFromDotenv = {};
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) envFromDotenv[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
  }
  const env = { ...process.env, ...envFromDotenv, SOLOFORGE_REQUIRE_TOKENS: "0" };
  return spawnBg("backend", process.execPath, [TSX_CLI, "src/index.ts"], { cwd: ROOT, env });
}

async function startUiDev() {
  return spawnBg("ui-dev", process.execPath, [UI_TSX_CLI, "server.ts"], {
    cwd: UI,
    env: { ...process.env, GIT_SERVICE_URL: "http://localhost:3002" },
  });
}

async function startMarl() {
  return spawnBg("marl", PY_EXE, ["-m", "marl_service.server_prod"], {
    cwd: PY,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
}

async function startJavaAgent() {
  if (!fs.existsSync(JAVA_AGENT_JAR)) {
    log("java-agent", `JAR not found: ${JAVA_AGENT_JAR}, skipping`);
    return null;
  }
  const miniJdk = path.join(ROOT, "bin", "jdk-23-mini");
  let javaExe = path.join(miniJdk, "bin", isWin ? "java.exe" : "java");
  if (!fs.existsSync(javaExe)) {
    // fallback: JAVA_HOME 或系统 java
    const javaHome = process.env.JAVA_HOME;
    javaExe = javaHome ? path.join(javaHome, "bin", isWin ? "java.exe" : "java") : "java";
  }
  return spawnBg("java-agent", javaExe, [
    "-jar", JAVA_AGENT_JAR, "--server.port=8770",
  ], { cwd: JAVA_AGENT_DIR, env: { ...process.env } });
}

const STARTERS = {
  "SurrealDB":   startSurrealDB,
  "Garnet":      startGarnet,
  "git-service": startGitService,
  "backend":     startBackend,
  "ui-dev":      startUiDev,
  "marl":        startMarl,
  "java-agent":  startJavaAgent,
};

const WAIT_TIMEOUTS = {
  "SurrealDB":   12000,
  "Garnet":       8000,
  "git-service":  8000,
  "backend":     20000,
  "ui-dev":      20000,
  "marl":        15000,
  "java-agent":  25000,
};

const DEPS = {
  "SurrealDB":   [],
  "Garnet":      [],
  "git-service": [],
  "backend":     ["SurrealDB", "Garnet"],
  "ui-dev":      ["git-service"],
  "marl":        [],
  "java-agent":  ["Garnet", "marl"],
};

async function main() {
  console.log(`\n${"═".repeat(55)}`);
  console.log(`  SoloForge Health Check — ${new Date().toLocaleString()}`);
  console.log(`${"═".repeat(55)}\n`);

  const down = [];
  for (const svc of SERVICES) {
    const up = await portOpen(svc.host, svc.port, 1500);
    const status = up ? "✅ UP" : "❌ DOWN";
    log(svc.name, `:${svc.port} ${status}`);
    if (!up) down.push(svc.name);
  }

  if (down.length === 0) {
    log("RESULT", `All ${SERVICES.length} core services healthy. No action needed.`);
    return;
  }

  log("REPAIR", `${down.length} service(s) down: ${down.join(", ")}`);

  const started = new Set();
  async function ensureUp(name) {
    if (started.has(name)) return;
    started.add(name);

    const deps = DEPS[name] || [];
    for (const dep of deps) {
      if (down.includes(dep) || !(await portOpen(
        SERVICES.find(s => s.name === dep)?.host || "127.0.0.1",
        SERVICES.find(s => s.name === dep)?.port,
        500
      ))) {
        await ensureUp(dep);
      }
    }

    const svc = SERVICES.find(s => s.name === name);
    if (!svc) return;

    if (await portOpen(svc.host, svc.port, 500)) {
      log(name, "already came back up, skipping");
      return;
    }

    const starter = STARTERS[name];
    if (!starter) {
      log(name, "no starter function, skipping");
      return;
    }

    log(name, `starting...`);
    await starter();

    const timeout = WAIT_TIMEOUTS[name] || 15000;
    const ok = await waitPort(svc.host, svc.port, timeout);
    log(name, ok ? `✅ restored on :${svc.port}` : `⚠️  still down after ${timeout / 1000}s`);
  }

  for (const name of down) {
    await ensureUp(name);
  }

  console.log(`\n${"═".repeat(55)}`);
  log("RESULT", "Health check complete.");
  console.log(`${"═".repeat(55)}\n`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.stack || e.message}`);
  process.exit(1);
});
