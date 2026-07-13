/**
 * find-browser.mjs — 自动扫描本机 Chromium 内核浏览器路径
 *
 * 用法:
 *   node scripts/find-browser.mjs          # 打印所有找到的浏览器
 *   node scripts/find-browser.mjs --env     # 输出 PUPPETEER_EXECUTABLE_PATH 设置命令
 *
 * 支持扫描: Chrome, Edge, Chromium, Brave, Vivaldi, Opera, Electron, QQBrowser
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

// ── 候选路径模板 ──
// %LOCALAPPDATA% / %PROGRAMFILES% 等环境变量由 process.env 动态展开
const WIN_CANDIDATES = [
  // Chrome
  '{LOCALAPPDATA}/Google/Chrome/Application/chrome.exe',
  '{PROGRAMFILES}/Google/Chrome/Application/chrome.exe',
  '{PROGRAMFILES(X86)}/Google/Chrome/Application/chrome.exe',

  // Edge
  '{PROGRAMFILES(X86)}/Microsoft/Edge/Application/msedge.exe',
  '{PROGRAMFILES}/Microsoft/Edge/Application/msedge.exe',

  // Chromium
  '{LOCALAPPDATA}/Chromium/Application/chrome.exe',
  '{PROGRAMFILES}/Chromium/Application/chrome.exe',

  // Brave
  '{LOCALAPPDATA}/BraveSoftware/Brave-Browser/Application/brave.exe',
  '{PROGRAMFILES}/BraveSoftware/Brave-Browser/Application/brave.exe',
  '{PROGRAMFILES(X86)}/BraveSoftware/Brave-Browser/Application/brave.exe',

  // Vivaldi
  '{LOCALAPPDATA}/Vivaldi/Application/vivaldi.exe',
  '{PROGRAMFILES}/Vivaldi/Application/vivaldi.exe',

  // Opera
  '{LOCALAPPDATA}/Programs/Opera/opera.exe',
  '{PROGRAMFILES}/Opera/opera.exe',

  // QQ Browser
  '{LOCALAPPDATA}/QQBrowser/Application/QQBrowser.exe',

  // Electron (SoloForge 项目内)
  '{CWD}/UI/node_modules/electron/dist/electron.exe',
];

const MAC_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
  '/Applications/Opera.app/Contents/MacOS/Opera',
  `${homedir()}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
];

const LINUX_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/brave-browser',
  '/usr/bin/vivaldi',
  '/usr/bin/opera',
  '/snap/bin/chromium',
];

// ── 扫描逻辑 ──

function expandPath(template) {
  const env = process.env;
  return template
    .replace(/\{LOCALAPPDATA\}/g, env.LOCALAPPDATA || '')
    .replace(/\{PROGRAMFILES\(X86\)\}/g, env['PROGRAMFILES(X86)'] || env.ProgramFiles || '')
    .replace(/\{PROGRAMFILES\}/g, env.ProgramFiles || env.PROGRAMFILES || '')
    .replace(/\{CWD\}/g, process.cwd());
}

function getPlatformCandidates() {
  const platform = process.platform;
  if (platform === 'win32') return WIN_CANDIDATES.map(expandPath);
  if (platform === 'darwin') return MAC_CANDIDATES;
  return LINUX_CANDIDATES;
}

/** 扫描 Windows 注册表路径下的 Chrome/User Data，发现所有安装版本 */
function scanWindowsRegistry() {
  // 常见的 Chrome 安装路径变体 (SxS / Dev / Beta / Canary)
  const env = process.env;
  const localAppData = env.LOCALAPPDATA || '';
  if (!localAppData) return [];

  const chromeBase = join(localAppData, 'Google');
  const results = [];
  try {
    for (const dir of readdirSync(chromeBase, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const exe = join(chromeBase, dir.name, 'Application', 'chrome.exe');
      if (existsSync(exe)) results.push(exe);
    }
  } catch { /* ignore */ }
  return results;
}

function findBrowsers() {
  const seen = new Set();
  const results = [];

  // 静态候选
  for (const path of getPlatformCandidates()) {
    const resolved = resolve(path);
    if (!seen.has(resolved) && existsSync(resolved)) {
      seen.add(resolved);
      results.push({ path: resolved, name: guessName(resolved) });
    }
  }

  // Windows 动态扫描
  if (process.platform === 'win32') {
    for (const path of scanWindowsRegistry()) {
      const resolved = resolve(path);
      if (!seen.has(resolved) && existsSync(resolved)) {
        seen.add(resolved);
        results.push({ path: resolved, name: guessName(resolved) });
      }
    }
  }

  return results;
}

function guessName(path) {
  const lower = path.toLowerCase();
  if (lower.includes('edge')) return 'Microsoft Edge';
  if (lower.includes('brave')) return 'Brave';
  if (lower.includes('vivaldi')) return 'Vivaldi';
  if (lower.includes('opera')) return 'Opera';
  if (lower.includes('chromium') && !lower.includes('chrome')) return 'Chromium';
  if (lower.includes('electron')) return 'Electron';
  if (lower.includes('qqbrowser')) return 'QQ Browser';
  if (lower.includes('chrome')) return 'Google Chrome';
  return 'Unknown Chromium';
}

// ── 主入口 ──

const browsers = findBrowsers();
const wantEnv = process.argv.includes('--env');

if (browsers.length === 0) {
  console.error('未找到任何 Chromium 内核浏览器');
  process.exit(1);
}

if (wantEnv) {
  // 输出第一个（优先 Edge，因为 Windows 自带）
  const preferred = browsers.find(b => b.name === 'Microsoft Edge') || browsers[0];
  console.log(`set PUPPETEER_EXECUTABLE_PATH=${preferred.path}`);
} else {
  console.log(`扫描完成，找到 ${browsers.length} 个浏览器:\n`);
  for (const b of browsers) {
    console.log(`  ${b.name.padEnd(20)} ${b.path}`);
  }
  const preferred = browsers.find(b => b.name === 'Microsoft Edge') || browsers[0];
  console.log(`\n推荐使用: ${preferred.name}`);
  console.log(`\n设置环境变量:  node scripts/find-browser.mjs --env`);
}
