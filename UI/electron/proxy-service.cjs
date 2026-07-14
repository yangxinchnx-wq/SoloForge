// ─────────────────────────────────────────────────────────────────
// SoloForge Proxy Service — 网络代理管理核心
// 基于 Electron session.setProxy() 四模式架构
// 复用项目现有 settingsStorage.cjs（零外部依赖）
//
// 设计文档: proxy-implementation-guide.md §十
// ─────────────────────────────────────────────────────────────────

'use strict';

const { session, net } = require('electron');
const { createSettingsStorage } = require('./settingsStorage.cjs');
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

// ── 配置存储 ──
// settingsStorage API: { load, getStore, flushSync, scheduleWrite, dispose }
// getStore(storeName) 返回该 store 的原始对象引用（自动创建）
const SETTINGS_FILE = path.join(os.homedir(), '.soloforge', 'settings.json');
const storage = createSettingsStorage(SETTINGS_FILE);

const CONFIG_KEY = 'config';
const DEFAULT_CONFIG = { mode: 'system' };

// ── Bypass 列表（与文档 §4.2 保持同步） ──
const BYPASS_DEFAULT = [
  // 通用本地绕过
  'localhost',
  '127.0.0.1',
  '::1',
  '*.local',
  '<local>',           // Chromium 内置: 所有不含 "." 的主机名
  // SoloForge 内部服务完整端口
  'localhost:3000',    // UI Server (Express 前端)
  'localhost:3001',    // RACER Core / Node.js 后端
  'localhost:3002',    // git-service (Go)
  'localhost:6379',    // Garnet (Redis 兼容缓存)
  'localhost:8400',    // SurrealDB (图数据库)
  'localhost:8765',    // MARL (预留: 外部独立进程，非 main.cjs 启动)
  'localhost:8766',    // MARL Reputation HTTP (预留: 外部独立进程)
  'localhost:8770',    // Java Agent (Spring AI)
].join(',');

// ── 测试端点容灾列表（国内可用性排序） ──
const TEST_ENDPOINTS = [
  { url: 'https://httpbin.org/ip',          extract: (d) => d.origin },
  { url: 'https://api.ipify.org?format=json', extract: (d) => d.ip },
  { url: 'https://ipinfo.io/json',           extract: (d) => d.ip },
];

class ProxyService {
  constructor() {
    const store = storage.getStore('proxy-config');
    this.config = store[CONFIG_KEY] ? JSON.parse(JSON.stringify(store[CONFIG_KEY])) : { ...DEFAULT_CONFIG };
  }

  /**
   * 获取当前代理配置（深拷贝，防止外部 mutation）
   * @returns {ProxyConfig}
   */
  getConfig() {
    return JSON.parse(JSON.stringify(this.config));
  }

  /**
   * 应用代理配置 — 同时影响 Chromium 层和 Node.js 层
   * @param {ProxyConfig} config
   * @returns {Promise<{ok: boolean}>}
   */
  async apply(config) {
    this.config = config;

    // 持久化：修改 store 对象后调用 scheduleWrite() 异步落盘
    const store = storage.getStore('proxy-config');
    store[CONFIG_KEY] = JSON.parse(JSON.stringify(config));
    storage.scheduleWrite();

    // 1. 设置 Chromium 层代理（渲染进程 fetch / WebSocket / XMLHttpRequest）
    await this._applyChromiumProxy(config);

    // 2. 同步 Node.js 环境变量（后端 API 请求 / 子进程）
    this._syncNodeEnv(config);

    return { ok: true };
  }

  // ── 私有方法：Chromium 层代理设置 ──

  async _applyChromiumProxy(config) {
    const ses = session.defaultSession;

    switch (config.mode) {
      case 'system':
        await ses.setProxy({ mode: 'system' });
        break;

      case 'direct':
        await ses.setProxy({ mode: 'direct' });
        break;

      case 'manual': {
        const rules = this._buildProxyRules(config);
        const bypass = config.bypassList || BYPASS_DEFAULT;
        await ses.setProxy({
          mode: 'fixed_servers',
          proxyRules: rules,
          proxyBypassList: bypass,
        });
        break;
      }

      case 'pac':
        await ses.setProxy({
          mode: 'pac_script',
          pacScript: config.pacUrl,
        });
        break;

      default:
        console.warn(`[代理服务] 未知代理模式: ${config.mode}，回退到系统代理`);
        await ses.setProxy({ mode: 'system' });
    }
  }

  /**
   * 构建 Chromium proxyRules 字符串
   * 格式参考: https://chromium.googlesource.com/chromium/src/+/main/net/docs/proxy.md
   */
  _buildProxyRules(config) {
    const { protocol, server, port } = config;
    if (!server || !port) {
      console.warn('[代理服务] 手动代理缺少服务器地址/端口，跳过规则构建');
      return '';
    }
    if (protocol === 'socks4' || protocol === 'socks5') {
      return `${protocol}://${server}:${port}`;
    }
    // HTTP/HTTPS 协议：为 http 和 https 分别指定规则
    return `http=${server}:${port};https=${server}:${port}`;
  }

  // ── 私有方法：Node.js 层环境变量同步 ──

  /**
   * 同步 process.env 中的代理环境变量
   *
   * ⚠️ 时效性警告：
   *   process.env.HTTP_PROXY 变更仅对变更后新 spawn 的子进程生效。
   *   已运行的子进程持有启动时的环境变量副本，不会感知后续变更。
   *   应对策略：运行中切换代理时 UI 应提示"已运行的服务需重启才能生效"
   */
  _syncNodeEnv(config) {
    // 清除旧值（大小写都要清，不同库读取不同的 key）
    for (const key of [
      'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
      'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    ]) {
      delete process.env[key];
    }

    if (config.mode === 'direct') {
      // 直连模式：不设置任何代理变量
      return;
    }

    if (config.mode === 'system') {
      // 系统代理模式：不覆盖环境变量（让系统已有的环境变量继续生效）
      return;
    }

    if (config.mode === 'manual') {
      const url = this._buildProxyUrl(config);
      process.env.HTTP_PROXY = url;
      process.env.HTTPS_PROXY = url;
      process.env.ALL_PROXY = url;
      process.env.NO_PROXY = config.bypassList || BYPASS_DEFAULT;
      // 同步小写版本（部分 Node.js 库读小写 key）
      process.env.http_proxy = url;
      process.env.https_proxy = url;
      process.env.all_proxy = url;
      process.env.no_proxy = config.bypassList || BYPASS_DEFAULT;
      return;
    }

    // PAC 模式下 Node.js 层不支持 PAC 解析（仅 Chromium 原生支持 PAC 脚本）
    // 降级策略：不注入代理变量，Node.js 请求直连
    // 如需 PAC 路由，应在 UI 中提示用户："Node.js 后端请求将直连，不经过 PAC 路由"
    if (config.mode === 'pac') {
      console.warn(
        '[代理服务] PAC 模式: Node.js 请求绕过 PAC（仅 Chromium 支持）。\n' +
        '  后端 API 调用（LLM 调度等）将使用直连。'
      );
      return;
    }
  }

  /**
   * 从手动配置构建代理 URL
   */
  _buildProxyUrl(config) {
    const { protocol = 'http', server, port } = config;
    if (protocol === 'socks5') return `socks5://${server}:${port}`;
    if (protocol === 'socks4') return `socks4://${server}:${port}`;
    return `${protocol}://${server}:${port}`;
  }

  // ── 公开方法：系统代理信息检测 ──

  /**
   * 检测操作系统当前系统代理配置
   *
   * 平台兼容说明：
   *   Windows: 通过注册表查询 Internet Settings ✅
   *   macOS:   需通过 `scutil --proxy` 或 Objective-C bridge（TODO）
   *   Linux:   需通过 `gsettings get org.gnome.system.proxy`（TODO）
   */
  getSystemProxyInfo() {
    // 非Windows平台：返回未实现标记
    if (process.platform !== 'win32') {
      console.warn(`[代理服务] ${process.platform} 平台暂未实现系统代理检测`);
      return { enabled: false, platform: process.platform };
    }

    try {
      const enableResult = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
        { encoding: 'utf8' }
      );
      const enabled = enableResult.includes('0x1');

      if (!enabled) return { enabled: false };

      const serverResult = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
        { encoding: 'utf8' }
      );
      const proxyServer = serverResult.match(/ProxyServer\s+REG_SZ\s+(.+)/)?.[1]?.trim();

      // 检查 PAC URL（AutoConfigURL）
      let pacUrl = null;
      try {
        const pacResult = execSync(
          'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v AutoConfigURL',
          { encoding: 'utf8' }
        );
        pacUrl = pacResult.match(/AutoConfigURL\s+REG_SZ\s+(.+)/)?.[1]?.trim();
      } catch {
        // AutoConfigURL 不存在，忽略
      }

      return { enabled: true, server: proxyServer, pacUrl };
    } catch (err) {
      console.warn('[代理服务] 读取系统代理失败:', err.message);
      return { enabled: false };
    }
  }

  // ── 公开方法：连通性测试 ──

  /**
   * 测试当前代理配置的连通性
   * 多端点容灾（httpbin → ipify → ipinfo），每个端点 8s 超时
   * @returns {Promise<{ok: boolean, ip?: string, latency?: number, error?: string}>}
   */
  async testConnection() {
    for (const endpoint of TEST_ENDPOINTS) {
      const result = await this._probeEndpoint(endpoint);
      if (result.ok) return result;
    }
    return { ok: false, error: '所有测试端点均不可达', latency: 0 };
  }

  /**
   * 探测单个端点
   * @private
   */
  _probeEndpoint(endpoint) {
    return new Promise((resolve) => {
      const start = Date.now();
      try {
        const request = net.request(endpoint.url);
        request.on('response', (response) => {
          let body = '';
          response.on('data', (chunk) => { body += chunk; });
          response.on('end', () => {
            try {
              const data = JSON.parse(body);
              resolve({
                ok: true,
                ip: endpoint.extract(data),
                latency: Date.now() - start,
              });
            } catch {
              resolve({
                ok: true,
                ip: '未知',
                latency: Date.now() - start,
              });
            }
          });
        });
        request.on('error', () => {
          resolve({
            ok: false,
            error: '连接失败',
            latency: Date.now() - start,
          });
        });
        // 8 秒超时
        setTimeout(() => {
          try { request.abort(); } catch { /* 已取消 */ }
          resolve({
            ok: false,
            error: '超时',
            latency: Date.now() - start,
          });
        }, 8000);
        request.end();
      } catch (err) {
        resolve({
          ok: false,
          error: err.message,
          latency: Date.now() - start,
        });
      }
    });
  }
}

module.exports = { ProxyService };
