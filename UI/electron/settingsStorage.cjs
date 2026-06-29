// ─────────────────────────────────────────────────────────────────
// SoloForge Settings Storage (v2)
// 纯逻辑层, 不依赖 Electron, 可在 Node.js / vitest 中直接 require 测试
//
// 磁盘格式 (v2):
//   {
//     "_v": 2,
//     "stores": {
//       "default":              { ...旧 API 数据, 向后兼容 },
//       "soloforge-app-store":  { ...新 API 数据 },
//       "custom-store":         { ... }
//     }
//   }
//
// v1 → v2 自动迁移: 文件无 "_v" 字段时, 整个 JSON 视为旧扁平 dict,
// 整体包入 stores.default, 不丢数据
// ─────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const LEGACY_DEFAULT_STORE = 'default';
const SETTINGS_FORMAT_VERSION = 2;
const VALID_STORE_NAME = /^[a-zA-Z0-9_\-.]{1,128}$/;

function createSettingsStorage(filePath, options = {}) {
  const writeDelayMs = options.writeDelayMs ?? 300;

  let _root = null;
  let _writeTimer = null;
  let _pending = false;
  let _lastWriteAt = 0;

  function ensureDir(p) {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  function load() {
    if (_root) return _root;
    let raw = null;
    try {
      if (fs.existsSync(filePath)) {
        raw = fs.readFileSync(filePath, 'utf-8');
      }
    } catch (e) {
      console.warn('[settingsStorage] read disk failed:', e.message);
    }

    if (raw === null || raw.trim() === '') {
      _root = { _v: SETTINGS_FORMAT_VERSION, stores: {} };
      return _root;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.warn('[settingsStorage] JSON parse failed, starting fresh:', e.message);
      _root = { _v: SETTINGS_FORMAT_VERSION, stores: {} };
      return _root;
    }

    // 已是 v2 格式
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed._v === SETTINGS_FORMAT_VERSION &&
      parsed.stores &&
      typeof parsed.stores === 'object' &&
      !Array.isArray(parsed.stores)
    ) {
      _root = parsed;
      return _root;
    }

    // v1 迁移
    console.log('[settingsStorage] migrating v1 flat format → v2 (wrapping into stores.default)');
    _root = {
      _v: SETTINGS_FORMAT_VERSION,
      stores: {
        [LEGACY_DEFAULT_STORE]:
          parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {},
      },
    };
    return _root;
  }

  function getStore(storeName) {
    const r = load();
    if (!r.stores[storeName]) r.stores[storeName] = {};
    return r.stores[storeName];
  }

  function sanitizeStoreName(name, fallback) {
    if (typeof name !== 'string' || name.length === 0) return fallback;
    if (!VALID_STORE_NAME.test(name)) {
      console.warn(`[settingsStorage] invalid storeName: ${name}, fallback to ${fallback}`);
      return fallback;
    }
    return name;
  }

  function flushSync() {
    if (_writeTimer) {
      clearTimeout(_writeTimer);
      _writeTimer = null;
    }
    _pending = false;
    const r = load();
    try {
      ensureDir(filePath);
      const tmp = filePath + `.tmp.${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(r, null, 2), 'utf-8');
      fs.renameSync(tmp, filePath);
      _lastWriteAt = Date.now();
    } catch (e) {
      console.warn('[settingsStorage] flush failed:', e.message);
    }
  }

  function scheduleWrite() {
    _pending = true;
    if (_writeTimer) return;
    _writeTimer = setTimeout(() => {
      _writeTimer = null;
      if (!_pending) return;
      flushSync();
    }, writeDelayMs);
  }

  function dispose() {
    if (_writeTimer) {
      clearTimeout(_writeTimer);
      _writeTimer = null;
    }
    _pending = false;
  }

  return {
    load,
    getStore,
    sanitizeStoreName,
    flushSync,
    scheduleWrite,
    dispose,
    // ── 内部状态 (测试用) ──
    _peek: () => _root,
    _isPending: () => _pending,
    _lastWriteAt: () => _lastWriteAt,
  };
}

module.exports = {
  createSettingsStorage,
  LEGACY_DEFAULT_STORE,
  SETTINGS_FORMAT_VERSION,
  VALID_STORE_NAME,
};
