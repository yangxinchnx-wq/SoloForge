// ─────────────────────────────────────────────────────────────────
// settingsStorage.cjs 单元测试
// 覆盖: 多 store 隔离, v1→v2 自动迁移, 原子写入, 防抖, storeName 校验
//
// vitest 2.x 不支持 .cjs 测试文件, 因此:
//   - vitest.config.ts 启用 globals: true
//   - 本文件不 import/require vitest, 直接使用全局 describe/it/expect 等
// ─────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createSettingsStorage,
  LEGACY_DEFAULT_STORE,
  SETTINGS_FORMAT_VERSION,
  VALID_STORE_NAME,
} = require('../settingsStorage.cjs');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'soloforge-settings-test-'));
}

function makeTmpFile() {
  const dir = makeTmpDir();
  return path.join(dir, 'settings-store.json');
}

function rmTmp(filePath) {
  try {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  } catch {}
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

describe('settingsStorage.cjs', () => {
  let tmpFile;
  let storage;

  beforeEach(() => {
    tmpFile = makeTmpFile();
  });

  afterEach(() => {
    if (storage) {
      storage.dispose();
      storage = null;
    }
    rmTmp(tmpFile);
  });

  // ────────────────────────────────────────────
  // 1. 基础读写
  // ────────────────────────────────────────────
  describe('basic read/write', () => {
    it('空文件初始化为 v2 格式', () => {
      storage = createSettingsStorage(tmpFile);
      const store = storage.getStore('soloforge-app-store');
      expect(store).toEqual({});
    });

    it('写入后通过同一 storage 立即可读 (内存优先)', () => {
      storage = createSettingsStorage(tmpFile);
      const store = storage.getStore('soloforge-app-store');
      store['theme'] = 'dark';
      expect(storage.getStore('soloforge-app-store')['theme']).toBe('dark');
    });

    it('未指定 storeName 时回退到 LEGACY_DEFAULT_STORE', () => {
      storage = createSettingsStorage(tmpFile);
      const store = storage.getStore(LEGACY_DEFAULT_STORE);
      store['key1'] = 'value1';
      storage.flushSync();
      const onDisk = readJson(tmpFile);
      expect(onDisk._v).toBe(SETTINGS_FORMAT_VERSION);
      expect(onDisk.stores[LEGACY_DEFAULT_STORE]['key1']).toBe('value1');
    });
  });

  // ────────────────────────────────────────────
  // 2. 多 store 隔离 (核心修复点)
  // ────────────────────────────────────────────
  describe('multi-store isolation', () => {
    it('不同 storeName 互不干扰', () => {
      storage = createSettingsStorage(tmpFile);
      storage.getStore('store-a')['x'] = 1;
      storage.getStore('store-b')['x'] = 2;
      storage.flushSync();

      const onDisk = readJson(tmpFile);
      expect(onDisk.stores['store-a']['x']).toBe(1);
      expect(onDisk.stores['store-b']['x']).toBe(2);
      // 关键: 两个 store 独立, 没有共享 _settingsCache
      expect(onDisk.stores['store-a']).not.toBe(onDisk.stores['store-b']);
    });

    it('5 个 store 并发写入仍隔离', () => {
      storage = createSettingsStorage(tmpFile);
      const stores = ['s1', 's2', 's3', 's4', 's5'];
      stores.forEach((n, i) => {
        const s = storage.getStore(n);
        s['val'] = i;
        s['name'] = n;
      });
      storage.flushSync();

      const onDisk = readJson(tmpFile);
      stores.forEach((n, i) => {
        expect(onDisk.stores[n]['val']).toBe(i);
        expect(onDisk.stores[n]['name']).toBe(n);
      });
    });

    it('新 storage 加载磁盘后保留各 store 隔离', () => {
      storage = createSettingsStorage(tmpFile);
      storage.getStore('alpha')['k'] = 'A';
      storage.getStore('beta')['k'] = 'B';
      storage.flushSync();
      storage.dispose();

      const storage2 = createSettingsStorage(tmpFile);
      expect(storage2.getStore('alpha')['k']).toBe('A');
      expect(storage2.getStore('beta')['k']).toBe('B');
      storage2.dispose();
      storage = null; // 防止 afterEach 再次 dispose
    });

    it('默认 store 与自定义 store 隔离', () => {
      storage = createSettingsStorage(tmpFile);
      storage.getStore(LEGACY_DEFAULT_STORE)['legacyKey'] = 'L';
      storage.getStore('soloforge-app-store')['newKey'] = 'N';
      storage.flushSync();

      const onDisk = readJson(tmpFile);
      expect(onDisk.stores[LEGACY_DEFAULT_STORE]['legacyKey']).toBe('L');
      expect(onDisk.stores[LEGACY_DEFAULT_STORE]['newKey']).toBeUndefined();
      expect(onDisk.stores['soloforge-app-store']['newKey']).toBe('N');
      expect(onDisk.stores['soloforge-app-store']['legacyKey']).toBeUndefined();
    });
  });

  // ────────────────────────────────────────────
  // 3. v1 → v2 自动迁移 (核心修复点)
  // ────────────────────────────────────────────
  describe('v1 → v2 migration', () => {
    it('检测到无 _v 字段时自动包入 stores.default', () => {
      const v1Content = { theme: 'dark', language: 'zh', fontSize: 14 };
      fs.writeFileSync(tmpFile, JSON.stringify(v1Content), 'utf-8');

      storage = createSettingsStorage(tmpFile);
      // v1 数据应整体迁移到 stores.default
      expect(storage.getStore(LEGACY_DEFAULT_STORE)['theme']).toBe('dark');
      expect(storage.getStore(LEGACY_DEFAULT_STORE)['language']).toBe('zh');
      expect(storage.getStore(LEGACY_DEFAULT_STORE)['fontSize']).toBe(14);
    });

    it('v1 迁移后 flushSync 写出 v2 格式', () => {
      const v1Content = { key1: 'val1', key2: 42 };
      fs.writeFileSync(tmpFile, JSON.stringify(v1Content), 'utf-8');

      storage = createSettingsStorage(tmpFile);
      storage.flushSync();

      const onDisk = readJson(tmpFile);
      expect(onDisk._v).toBe(SETTINGS_FORMAT_VERSION);
      expect(onDisk.stores[LEGACY_DEFAULT_STORE]).toEqual(v1Content);
    });

    it('v1 文件含 null value 也能正确迁移', () => {
      fs.writeFileSync(tmpFile, JSON.stringify({ a: null, b: 'x' }), 'utf-8');
      storage = createSettingsStorage(tmpFile);
      expect(storage.getStore(LEGACY_DEFAULT_STORE)['a']).toBeNull();
      expect(storage.getStore(LEGACY_DEFAULT_STORE)['b']).toBe('x');
    });

    it('已是 v2 格式时不再迁移', () => {
      const v2 = {
        _v: SETTINGS_FORMAT_VERSION,
        stores: { 'pre-existing': { foo: 'bar' } },
      };
      fs.writeFileSync(tmpFile, JSON.stringify(v2), 'utf-8');
      storage = createSettingsStorage(tmpFile);
      expect(storage.getStore('pre-existing')['foo']).toBe('bar');
      // 不应在 stores.default 创建空对象
      expect(storage._peek().stores[LEGACY_DEFAULT_STORE]).toBeUndefined();
    });

    it('JSON 损坏时不崩溃, 重置为空 v2', () => {
      fs.writeFileSync(tmpFile, '{ this is not json', 'utf-8');
      storage = createSettingsStorage(tmpFile);
      expect(storage.getStore('any')['k']).toBeUndefined();
      storage.getStore('any')['k'] = 'v';
      expect(storage.getStore('any')['k']).toBe('v');
    });

    it('空文件/缺失文件 → 全新启动', () => {
      storage = createSettingsStorage(tmpFile);
      expect(storage.getStore('any')).toEqual({});
    });
  });

  // ────────────────────────────────────────────
  // 4. 原子写入
  // ────────────────────────────────────────────
  describe('atomic write', () => {
    it('flushSync 不会留下 .tmp.* 临时文件', () => {
      storage = createSettingsStorage(tmpFile);
      storage.getStore('s')['k'] = 'v';
      storage.flushSync();

      const dir = path.dirname(tmpFile);
      const files = fs.readdirSync(dir);
      const tmpLeftover = files.filter((f) => f.includes('.tmp.'));
      expect(tmpLeftover).toEqual([]);
    });

    it('多次连续 flushSync 仍只产生目标文件', () => {
      storage = createSettingsStorage(tmpFile);
      for (let i = 0; i < 10; i++) {
        storage.getStore('s')[`k${i}`] = i;
        storage.flushSync();
      }
      const dir = path.dirname(tmpFile);
      const files = fs.readdirSync(dir);
      expect(files).toContain('settings-store.json');
      const tmpLeftover = files.filter((f) => f.includes('.tmp.'));
      expect(tmpLeftover).toEqual([]);
    });

    it('flushSync 后磁盘文件可被另一 storage 实例读回', () => {
      storage = createSettingsStorage(tmpFile);
      storage.getStore('persist-test')['data'] = { nested: true, count: 7 };
      storage.flushSync();
      storage.dispose();

      const storage2 = createSettingsStorage(tmpFile);
      expect(storage2.getStore('persist-test')['data']).toEqual({
        nested: true,
        count: 7,
      });
      storage2.dispose();
      storage = null;
    });
  });

  // ────────────────────────────────────────────
  // 5. 防抖写入
  // ────────────────────────────────────────────
  describe('debounced write', () => {
    it('多次 scheduleWrite 在防抖期内合并为一次刷盘', async () => {
      storage = createSettingsStorage(tmpFile, { writeDelayMs: 50 });
      const store = storage.getStore('s');
      for (let i = 0; i < 5; i++) {
        store[`k${i}`] = i;
        storage.scheduleWrite();
      }
      // 防抖期内: 磁盘文件还不应存在
      expect(fs.existsSync(tmpFile)).toBe(false);
      // 等待防抖到期
      await new Promise((r) => setTimeout(r, 100));
      expect(fs.existsSync(tmpFile)).toBe(true);
      const onDisk = readJson(tmpFile);
      expect(Object.keys(onDisk.stores['s']).length).toBe(5);
    });

    it('flushSync 取消挂起的防抖任务', async () => {
      storage = createSettingsStorage(tmpFile, { writeDelayMs: 1000 });
      storage.getStore('s')['k'] = 'v';
      storage.scheduleWrite();
      // 立即同步刷盘
      storage.flushSync();
      // 此时防抖 timer 已被清除, 后续不再触发
      const before = storage._lastWriteAt();
      await new Promise((r) => setTimeout(r, 50));
      const after = storage._lastWriteAt();
      expect(before).toBe(after);
    });
  });

  // ────────────────────────────────────────────
  // 6. storeName 校验
  // ────────────────────────────────────────────
  describe('storeName sanitization', () => {
    it('合法 storeName 通过', () => {
      storage = createSettingsStorage(tmpFile);
      expect(storage.sanitizeStoreName('soloforge-app-store', 'fallback')).toBe(
        'soloforge-app-store'
      );
      expect(storage.sanitizeStoreName('store_2', 'fallback')).toBe('store_2');
      expect(storage.sanitizeStoreName('store-2', 'fallback')).toBe('store-2');
      expect(storage.sanitizeStoreName('a.b.c', 'fallback')).toBe('a.b.c');
    });

    it('非字符串回退到 fallback', () => {
      storage = createSettingsStorage(tmpFile);
      expect(storage.sanitizeStoreName(123, 'fb')).toBe('fb');
      expect(storage.sanitizeStoreName(null, 'fb')).toBe('fb');
      expect(storage.sanitizeStoreName(undefined, 'fb')).toBe('fb');
      expect(storage.sanitizeStoreName('', 'fb')).toBe('fb');
    });

    it('含特殊字符的 storeName 回退到 fallback', () => {
      storage = createSettingsStorage(tmpFile);
      expect(storage.sanitizeStoreName('../etc/passwd', 'fb')).toBe('fb');
      expect(storage.sanitizeStoreName('foo/bar', 'fb')).toBe('fb');
      expect(storage.sanitizeStoreName('foo bar', 'fb')).toBe('fb');
      expect(storage.sanitizeStoreName('foo;DROP TABLE', 'fb')).toBe('fb');
    });

    it('超长 (129 字符) storeName 回退到 fallback', () => {
      storage = createSettingsStorage(tmpFile);
      expect(storage.sanitizeStoreName('a'.repeat(129), 'fb')).toBe('fb');
    });
  });

  // ────────────────────────────────────────────
  // 7. 路径格式
  // ────────────────────────────────────────────
  describe('disk file path (Windows)', () => {
    it('打包后 userData 路径 = %APPDATA%/SoloForge/ (来自 build.productName)', () => {
      // Electron app.getPath('userData') 路径在 Windows 上形如:
      //   C:\Users\<user>\AppData\Roaming\<productName>\settings-store.json
      // productName 来自 package.json "build.productName" 字段 (electron-builder 打包时)
      const pkgPath = path.resolve(process.cwd(), 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      // 顶层 productName 字段不存在, electron-builder 用 build.productName
      expect(pkg.productName).toBeUndefined();
      expect(pkg.build.productName).toBe('SoloForge');
      // 验证: 打包后路径 = SoloForge (大写 S, 大写 F)
      const packagedUserData = path.join(os.tmpdir(), pkg.build.productName);
      expect(packagedUserData).toContain('SoloForge');
    });

    it('开发模式 userData 路径 = %APPDATA%/soloforge/ (来自 name 字段)', () => {
      // 未打包时, Electron 用 package.json 顶层 name 字段
      const pkgPath = path.resolve(process.cwd(), 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      expect(pkg.name).toBe('soloforge');
      const devUserData = path.join(os.tmpdir(), pkg.name);
      expect(devUserData).toContain('soloforge');
    });

    it('磁盘文件路径 = <dir>/settings-store.json', () => {
      const dir = makeTmpDir();
      const file = path.join(dir, 'settings-store.json');
      storage = createSettingsStorage(file);
      storage.getStore('s')['k'] = 'v';
      storage.flushSync();
      expect(fs.existsSync(file)).toBe(true);
      const base = path.basename(file);
      expect(base).toBe('settings-store.json');
      rmTmp(file);
    });
  });
});
